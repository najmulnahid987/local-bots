// ============================================================================
// AI SDK Provider Tool-Calling Integration
// Phase 8 Step 8.7
// ============================================================================

import type { BotRepository } from '../database/repositories/bot-repository'
import type { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import type { CredentialVault } from '../security/credential-vault'
import { providerRegistry, type ProviderRegistry } from '../providers/provider-registry'
import { OpenAIAdapter } from '../providers/openai/openai-adapter'
import { AnthropicAdapter } from '../providers/anthropic/anthropic-adapter'
import { GoogleAdapter } from '../providers/google/google-adapter'
import { GroqAdapter } from '../providers/groq/groq-adapter'
import { OpenRouterAdapter } from '../providers/openrouter/openrouter-adapter'
import { PerplexityAdapter } from '../providers/perplexity/perplexity-adapter'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'
import type { ProviderAdapter, ProviderId, ToolDefinition } from '../providers/types'
import {
  type AgentModelStepExecutor,
  type AgentModelStepRequest,
  type AgentModelStepResult
} from './agent-model-step-executor'
import { mapAgentMessagesToChatMessages } from './ai-sdk-tool-mapper'
import { BoundedAgentRuntimeError } from '../services/bounded-agent-runtime'

// ============================================================================
// Typed Errors
// ============================================================================

/**
 * Thrown when an AI provider returns multiple tool calls within a single decision step.
 * Phase 8 MVP strictly enforces a single decision bound per iteration for determinism.
 */
export class UnsupportedParallelToolCallsError extends Error {
  public readonly code = 'UNSUPPORTED_PARALLEL_TOOL_CALLS' as const
  public readonly toolCallCount: number
  public readonly toolNames: readonly string[]

  constructor(toolCallCount: number, toolNames: readonly string[]) {
    super(
      `Unsupported parallel tool calls: received ${toolCallCount} calls (${toolNames.join(', ')}). Only a single tool call per decision round is supported in Phase 8 MVP.`
    )
    this.name = 'UnsupportedParallelToolCallsError'
    this.toolCallCount = toolCallCount
    this.toolNames = Object.freeze([...toolNames])
    Object.setPrototypeOf(this, UnsupportedParallelToolCallsError.prototype)
  }
}

// ============================================================================
// Dependencies & Options
// ============================================================================

export interface AiSdkAgentModelStepExecutorDependencies {
  readonly botRepository: BotRepository
  readonly connectionRepository: ProviderConnectionRepository
  readonly credentialVault: CredentialVault
  readonly registry?: ProviderRegistry
  readonly openAiAdapter?: OpenAIAdapter
  readonly anthropicAdapter?: AnthropicAdapter
  readonly googleAdapter?: GoogleAdapter
  readonly groqAdapter?: GroqAdapter
  readonly openRouterAdapter?: OpenRouterAdapter
  readonly perplexityAdapter?: PerplexityAdapter
  readonly adapterResolver?: (providerId: ProviderId) => ProviderAdapter
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Concrete AgentModelStepExecutor that binds registered AI providers (OpenAI, Anthropic, Google, Groq, OpenRouter)
 * to the provider-independent BoundedAgentRuntime.
 *
 * Enforces strict security boundaries:
 * 1. AI models are untrusted and can only request structured tool calls.
 * 2. Provider adapters never execute local tools; BoundedAgentRuntime remains the sole orchestrator.
 * 3. Enforces single tool call per iteration (rejects parallel tool calls).
 * 4. Verifies native tool capability before execution.
 * 5. Credentials are decrypted just-in-time and never logged or exposed.
 */
export class AiSdkAgentModelStepExecutor implements AgentModelStepExecutor {
  private readonly botRepo: BotRepository
  private readonly connectionRepo: ProviderConnectionRepository
  private readonly vault: CredentialVault
  private readonly registry: ProviderRegistry
  private readonly adapters: Record<ProviderId, ProviderAdapter>
  private readonly customResolver?: (providerId: ProviderId) => ProviderAdapter

  constructor(deps: AiSdkAgentModelStepExecutorDependencies) {
    if (!deps.botRepository || !deps.connectionRepository || !deps.credentialVault) {
      throw new Error(
        'BotRepository, ProviderConnectionRepository, and CredentialVault are required for AiSdkAgentModelStepExecutor.'
      )
    }

    this.botRepo = deps.botRepository
    this.connectionRepo = deps.connectionRepository
    this.vault = deps.credentialVault
    this.registry = deps.registry ?? providerRegistry
    this.adapters = {
      openai: deps.openAiAdapter ?? new OpenAIAdapter(),
      anthropic: deps.anthropicAdapter ?? new AnthropicAdapter(),
      google: deps.googleAdapter ?? new GoogleAdapter(),
      groq: deps.groqAdapter ?? new GroqAdapter(),
      openrouter: deps.openRouterAdapter ?? new OpenRouterAdapter(),
      perplexity: deps.perplexityAdapter ?? new PerplexityAdapter()
    }
    this.customResolver = deps.adapterResolver
  }

  /**
   * Executes a single model decision round using the Bot's configured provider connection.
   */
  public async executeStep(request: AgentModelStepRequest): Promise<AgentModelStepResult> {
    // 1. Check early cancellation
    if (request.signal?.aborted) {
      throw new BoundedAgentRuntimeError(
        'Model step execution was cancelled before start.',
        'RUN_CANCELLED',
        request.agentRunId
      )
    }

    // 2. Authoritative Bot lookup
    const bot = this.botRepo.getById(request.botId, request.knowledgeBaseId)
    if (!bot) {
      throw new BoundedAgentRuntimeError(
        `Bot '${request.botId}' not found in Knowledge Base '${request.knowledgeBaseId}'.`,
        'BOT_NOT_FOUND',
        request.agentRunId
      )
    }

    if (!bot.providerConnectionId) {
      throw new BoundedAgentRuntimeError(
        `Bot '${request.botId}' has no configured AI provider connection.`,
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    // 3. Authoritative Connection lookup
    const connection = this.connectionRepo.getById(bot.providerConnectionId)
    if (!connection) {
      throw new BoundedAgentRuntimeError(
        `Provider connection '${bot.providerConnectionId}' not found.`,
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    if (connection.status === 'revoked') {
      throw new BoundedAgentRuntimeError(
        'Provider connection has been revoked and cannot execute requests.',
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    const providerId = connection.providerId as ProviderId
    const targetModelId = (request.selectedModel || bot.modelId || '').trim()

    if (!targetModelId) {
      throw new BoundedAgentRuntimeError(
        'No valid model identifier specified for agent step.',
        'MODEL_NOT_FOUND',
        request.agentRunId
      )
    }

    // 4. Validate Model & Native Tool Capability
    const modelDescriptor = this.registry.getModel(providerId, targetModelId, connection.id)
    if (!modelDescriptor || modelDescriptor.providerId !== providerId) {
      throw new BoundedAgentRuntimeError(
        `Model '${targetModelId}' is not an authorized model for provider '${providerId}'.`,
        'MODEL_NOT_FOUND',
        request.agentRunId
      )
    }

    if (!modelDescriptor.providerCapabilities?.tools) {
      throw new BoundedAgentRuntimeError(
        `Model '${targetModelId}' from provider '${providerId}' does not support tool calling.`,
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    // 5. Ephemerally decrypt API Key in Main process memory
    let apiKey: string
    try {
      apiKey = await this.vault.retrieve(connection.credentialRef)
    } catch {
      throw new BoundedAgentRuntimeError(
        'Failed to retrieve API credential for agent step execution.',
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    // 6. Select provider adapter
    const adapter = this.resolveAdapter(providerId)

    // 7. Prepare messages and tools for provider adapter
    const { systemPrompt, messages } = mapAgentMessagesToChatMessages(request.history)

    const toolDefinitions: ToolDefinition[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.parameters ?? {}) as Record<string, unknown>
    }))

    // 8. Execute generation through adapter
    let generationResult
    try {
      generationResult = await adapter.generateText(apiKey, {
        modelId: targetModelId,
        connectionId: connection.id,
        systemPrompt,
        messages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        abortSignal: request.signal
      })
    } catch (err: unknown) {
      if (request.signal?.aborted) {
        throw new BoundedAgentRuntimeError(
          'Model step execution was cancelled.',
          'RUN_CANCELLED',
          request.agentRunId
        )
      }

      if (
        err instanceof BoundedAgentRuntimeError ||
        err instanceof UnsupportedParallelToolCallsError
      ) {
        throw err
      }

      const rawMsg = err instanceof Error ? err.message : String(err)
      // Strip potential key fragments or multi-line stack traces
      const sanitizedMsg = sanitizeErrorMessage(rawMsg.split(/\r?\n/)[0].trim())
      throw new BoundedAgentRuntimeError(
        `Provider generation failed: ${sanitizedMsg}`,
        'STEP_EXECUTOR_FAILED',
        request.agentRunId
      )
    }

    // 9. Inspect tool calls & enforce Phase 8 single-call bound
    const toolCalls = generationResult.toolCalls ?? []

    if (toolCalls.length > 1) {
      throw new UnsupportedParallelToolCallsError(
        toolCalls.length,
        toolCalls.map((tc) => tc.name)
      )
    }

    if (toolCalls.length === 1) {
      const call = toolCalls[0]
      return {
        type: 'tool_call',
        toolCallId: call.id,
        toolName: call.name,
        rawArguments: call.arguments
      }
    }

    // 10. Conclude with final response
    return {
      type: 'final',
      content: generationResult.text ?? '',
      modelMetadata: {
        finishReason: generationResult.finishReason,
        promptTokens: generationResult.usage?.promptTokens,
        completionTokens: generationResult.usage?.completionTokens
      }
    }
  }

  private resolveAdapter(providerId: ProviderId): ProviderAdapter {
    if (this.customResolver) {
      return this.customResolver(providerId)
    }

    const adapter = this.adapters[providerId]
    if (!adapter) {
      throw new Error(`Unsupported provider ID '${providerId}'.`)
    }
    return adapter
  }
}
