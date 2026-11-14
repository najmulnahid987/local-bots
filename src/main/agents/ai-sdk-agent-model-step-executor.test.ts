import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  AiSdkAgentModelStepExecutor,
  UnsupportedParallelToolCallsError
} from './ai-sdk-agent-model-step-executor'
import { BoundedAgentRuntime, BoundedAgentRuntimeError } from '../services/bounded-agent-runtime'
import { ToolRegistry } from '../tools/tool-registry'
import { ApprovalController } from '../services/approval-controller'
import { WorkspaceFolderService } from '../services/workspace-folder-service'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import type { CredentialVault } from '../security/credential-vault'
import type { CredentialRef } from '../database/repositories/types'
import type {
  ProviderAdapter,
  GenerateTextOptions,
  GenerateTextResult,
  ConnectionTestResult,
  StreamTextChunk
} from '../providers/types'
import type { AgentModelStepRequest } from './agent-model-step-executor'
import type { AgentTool } from '../tools/agent-tool'

// ============================================================================
// Mock Credential Vault
// ============================================================================

class MockCredentialVault {
  private readonly storeMap = new Map<string, string>()

  public set(ref: string, key: string): void {
    this.storeMap.set(ref, key)
  }

  async store(secret: string): Promise<CredentialRef> {
    const ref = `cred_${randomUUID()}` as CredentialRef
    this.storeMap.set(ref, secret)
    return ref
  }

  async retrieve(ref: string): Promise<string> {
    const val = this.storeMap.get(ref)
    if (!val) {
      throw new Error(`Credential '${ref}' not found in vault.`)
    }
    return val
  }

  async delete(ref: string): Promise<void> {
    this.storeMap.delete(ref)
  }

  async listStoredCredentialRefs(): Promise<CredentialRef[]> {
    return Array.from(this.storeMap.keys()) as CredentialRef[]
  }

  async cleanStaleTempFiles(): Promise<number> {
    return 0
  }
}

// ============================================================================
// Mock Provider Adapter
// ============================================================================

class DeterministicMockAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const
  public generateTextCalls: GenerateTextOptions[] = []
  private queuedResults: GenerateTextResult[] = []

  public enqueueResult(res: GenerateTextResult): void {
    this.queuedResults.push(res)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, latencyMs: 5, testedModelId: 'test-model' }
  }

  async generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult> {
    void apiKey
    this.generateTextCalls.push(options)

    if (options.abortSignal?.aborted) {
      throw new Error('Operation was aborted.')
    }

    if (this.queuedResults.length > 0) {
      return this.queuedResults.shift()!
    }

    return {
      text: 'Default mock response',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    }
  }

  async *streamText(): AsyncIterable<StreamTextChunk> {
    yield { type: 'text-delta', textDelta: 'mock' }
    yield { type: 'finish', finishReason: 'stop' }
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('AiSdkAgentModelStepExecutor (Phase 8 Step 8.7)', () => {
  let ctx: MigratedTestDatabaseContext
  let botRepo: BotRepository
  let kbRepo: KnowledgeBaseRepository
  let connRepo: ProviderConnectionRepository
  let agentRunRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let convRepo: ConversationRepository
  let vault: MockCredentialVault
  let mockAdapter: DeterministicMockAdapter

  let kbId: string
  let openaiConnId: string
  let anthropicConnId: string
  let googleConnId: string
  let openaiBotId: string

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    botRepo = ctx.botRepo
    kbRepo = ctx.kbRepo
    connRepo = new ProviderConnectionRepository(ctx.db)
    agentRunRepo = new AgentRunRepository(ctx.db)
    toolEventRepo = new ToolEventRepository(ctx.db)
    convRepo = new ConversationRepository(ctx.db)
    vault = new MockCredentialVault()
    mockAdapter = new DeterministicMockAdapter()

    const kb = kbRepo.create({ name: 'Engineering Knowledge Base' })
    kbId = kb.id

    const refOpenAi = `cred_${randomUUID()}` as CredentialRef
    const refAnthropic = `cred_${randomUUID()}` as CredentialRef
    const refGoogle = `cred_${randomUUID()}` as CredentialRef

    vault.set(refOpenAi, 'sk-openai-test-key-12345')
    vault.set(refAnthropic, 'sk-ant-test-key-67890')
    vault.set(refGoogle, 'AIzaSyGoogleKey-99999')

    const openAiConn = connRepo.create({
      providerId: 'openai',
      label: 'OpenAI Production',
      credentialRef: refOpenAi
    })
    openaiConnId = openAiConn.id

    const anthropicConn = connRepo.create({
      providerId: 'anthropic',
      label: 'Anthropic Production',
      credentialRef: refAnthropic
    })
    anthropicConnId = anthropicConn.id

    const googleConn = connRepo.create({
      providerId: 'google',
      label: 'Google Production',
      credentialRef: refGoogle
    })
    googleConnId = googleConn.id

    const bot = botRepo.create({
      knowledgeBaseId: kbId,
      name: 'Luna Search Bot',
      modelId: 'gpt-6-luna',
      providerConnectionId: openaiConnId,
      systemPrompt: 'You search internal knowledge.',
      toolPermissions: ['search_knowledge_base', 'read_knowledge_source']
    })
    openaiBotId = bot.id
  })

  afterEach(() => {
    try {
      ctx.cleanup()
    } catch {
      // ignore
    }
  })

  describe('Pre-flight & Security Validations', () => {
    it('rejects step execution if Bot does not exist', async () => {
      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: randomUUID(),
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'BOT_NOT_FOUND'
      })
    })

    it('rejects step execution if Bot has no provider connection', async () => {
      const unconfiguredBot = botRepo.create({
        knowledgeBaseId: kbId,
        name: 'No Conn Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: null
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: unconfiguredBot.id,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'STEP_EXECUTOR_FAILED',
        message: expect.stringMatching(/no configured AI provider connection/i)
      })
    })

    it('rejects step execution if provider connection has been revoked', async () => {
      connRepo.updateStatus(openaiConnId, 'revoked')

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'STEP_EXECUTOR_FAILED',
        message: expect.stringMatching(/has been revoked/i)
      })
    })

    it('rejects step execution if model does not support tool calling', async () => {
      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      // gpt-6.1-terra has providerCapabilities.tools = false
      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6.1-terra',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'STEP_EXECUTOR_FAILED',
        message: expect.stringMatching(/does not support tool calling/i)
      })
    })

    it('rejects step execution if model does not belong to connection provider', async () => {
      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      // claude-sonnet-5-5 belongs to anthropic, but bot uses openai connection
      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'claude-sonnet-5-5',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'MODEL_NOT_FOUND',
        message: expect.stringMatching(/not an authorized model for provider 'openai'/i)
      })
    })

    it('rejects step immediately if caller signal is already aborted', async () => {
      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const controller = new AbortController()
      controller.abort()

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'hello' }],
        tools: [],
        signal: controller.signal
      }

      await expect(executor.executeStep(req)).rejects.toMatchObject({
        code: 'RUN_CANCELLED'
      })
    })
  })

  describe('Decision Execution & Tool Mapping', () => {
    it('returns a final response decision when adapter returns prose with no tool calls', async () => {
      mockAdapter.enqueueResult({
        text: 'The speed of light is approximately 299,792 km/s.',
        finishReason: 'stop',
        usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 }
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'What is the speed of light?' }],
        tools: []
      }

      const decision = await executor.executeStep(req)
      expect(decision.type).toBe('final')
      if (decision.type === 'final') {
        expect(decision.content).toBe('The speed of light is approximately 299,792 km/s.')
        expect(decision.modelMetadata?.finishReason).toBe('stop')
        expect(decision.modelMetadata?.promptTokens).toBe(25)
        expect(decision.modelMetadata?.completionTokens).toBe(15)
      }
    })

    it('returns a tool_call decision when adapter requests a single tool', async () => {
      mockAdapter.enqueueResult({
        text: '',
        toolCalls: [
          {
            id: 'call_kb_1',
            name: 'search_knowledge_base',
            arguments: { query: 'quantum physics', limit: 3 }
          }
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 }
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'Search quantum physics' }],
        tools: [
          {
            name: 'search_knowledge_base',
            description: 'Search KB',
            parameters: z.object({ query: z.string(), limit: z.number().optional() })
          }
        ]
      }

      const decision = await executor.executeStep(req)
      expect(decision.type).toBe('tool_call')
      if (decision.type === 'tool_call') {
        expect(decision.toolCallId).toBe('call_kb_1')
        expect(decision.toolName).toBe('search_knowledge_base')
        expect(decision.rawArguments).toEqual({ query: 'quantum physics', limit: 3 })
      }
    })

    it('strictly rejects parallel tool calls (>1) with UnsupportedParallelToolCallsError', async () => {
      mockAdapter.enqueueResult({
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'search_knowledge_base',
            arguments: { query: 'part 1' }
          },
          {
            id: 'call_2',
            name: 'search_knowledge_base',
            arguments: { query: 'part 2' }
          }
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 35, completionTokens: 20, totalTokens: 55 }
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_1',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'Search parts 1 and 2' }],
        tools: [
          {
            name: 'search_knowledge_base',
            description: 'Search KB'
          }
        ]
      }

      await expect(executor.executeStep(req)).rejects.toThrow(UnsupportedParallelToolCallsError)

      try {
        await executor.executeStep(req)
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UnsupportedParallelToolCallsError)
        const typedErr = err as UnsupportedParallelToolCallsError
        expect(typedErr.code).toBe('UNSUPPORTED_PARALLEL_TOOL_CALLS')
        expect(typedErr.toolCallCount).toBe(2)
        expect(typedErr.toolNames).toEqual(['search_knowledge_base', 'search_knowledge_base'])
      }
    })

    it('works across Anthropic models and adapter dispatch', async () => {
      const anthropicBot = botRepo.create({
        knowledgeBaseId: kbId,
        name: 'Sonnet Bot',
        modelId: 'claude-sonnet-5-5',
        providerConnectionId: anthropicConnId
      })

      const anthropicMock = new DeterministicMockAdapter()
      anthropicMock.enqueueResult({
        text: 'Anthropic reasoning concluded.',
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: (pId) => {
          if (pId === 'anthropic') return anthropicMock
          return mockAdapter
        }
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_ant',
        botId: anthropicBot.id,
        knowledgeBaseId: kbId,
        selectedModel: 'claude-sonnet-5-5',
        history: [{ role: 'user', content: 'Summarize' }],
        tools: []
      }

      const decision = await executor.executeStep(req)
      expect(decision.type).toBe('final')
      if (decision.type === 'final') {
        expect(decision.content).toBe('Anthropic reasoning concluded.')
      }
      expect(anthropicMock.generateTextCalls).toHaveLength(1)
      expect(anthropicMock.generateTextCalls[0].modelId).toBe('claude-sonnet-5-5')
    })

    it('works across Google Gemini models and adapter dispatch', async () => {
      const googleBot = botRepo.create({
        knowledgeBaseId: kbId,
        name: 'Flash Bot',
        modelId: 'gemini-3.8-flash',
        providerConnectionId: googleConnId
      })

      const googleMock = new DeterministicMockAdapter()
      googleMock.enqueueResult({
        text: '',
        toolCalls: [
          {
            id: 'call_goog_1',
            name: 'read_knowledge_source',
            arguments: { sourceId: 'src_100' }
          }
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 }
      })

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: (pId) => {
          if (pId === 'google') return googleMock
          return mockAdapter
        }
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_goog',
        botId: googleBot.id,
        knowledgeBaseId: kbId,
        selectedModel: 'gemini-3.8-flash',
        history: [{ role: 'user', content: 'Read source 100' }],
        tools: [
          {
            name: 'read_knowledge_source',
            description: 'Read source'
          }
        ]
      }

      const decision = await executor.executeStep(req)
      expect(decision.type).toBe('tool_call')
      if (decision.type === 'tool_call') {
        expect(decision.toolCallId).toBe('call_goog_1')
        expect(decision.toolName).toBe('read_knowledge_source')
        expect(decision.rawArguments).toEqual({ sourceId: 'src_100' })
      }
    })

    it('sanitizes errors and ensures API keys are never exposed in failure messages', async () => {
      const failingAdapter: ProviderAdapter = {
        providerId: 'openai',
        async testConnection(): Promise<ConnectionTestResult> {
          return { success: false, latencyMs: 0, testedModelId: 'm' }
        },
        async generateText() {
          throw new Error('API failure with secret key Bearer sk-openai-test-key-12345 in header')
        },
        async *streamText(): AsyncIterable<StreamTextChunk> {
          yield { type: 'finish', finishReason: 'stop' }
        }
      }

      const executor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => failingAdapter
      })

      const req: AgentModelStepRequest = {
        agentRunId: 'run_fail',
        botId: openaiBotId,
        knowledgeBaseId: kbId,
        selectedModel: 'gpt-6-luna',
        history: [{ role: 'user', content: 'hello' }],
        tools: []
      }

      await expect(executor.executeStep(req)).rejects.toThrow(BoundedAgentRuntimeError)
    })
  })

  describe('Integration with BoundedAgentRuntime', () => {
    it('executes a complete multi-step tool run using AiSdkAgentModelStepExecutor and ToolRegistry', async () => {
      const toolRegistry = new ToolRegistry({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo
      })

      // Register mock search tool
      const mockSearchTool: AgentTool = {
        name: 'search_knowledge_base',
        description: 'Search KB',
        schema: z.object({ query: z.string() }),
        requiredPermission: 'search_knowledge_base',
        execute: async (args: { query: string }) => {
          return {
            result: {
              citations: [
                {
                  citationNumber: 1,
                  sourceId: 'src_alpha',
                  chunkId: 'chunk_1',
                  fileName: 'Architecture Guide.md',
                  fileType: 'md' as const,
                  pageNumber: 1,
                  snippet: `Found information regarding ${args.query}: System components are strictly decoupled.`
                }
              ]
            },
            resultSummary: `Found 1 document chunk for query "${args.query}".`
          }
        }
      }
      toolRegistry.register(mockSearchTool)

      // Step 1: Model requests tool call
      mockAdapter.enqueueResult({
        text: 'Searching architecture documents...',
        toolCalls: [
          {
            id: 'call_search_1',
            name: 'search_knowledge_base',
            arguments: { query: 'decoupling' }
          }
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 }
      })

      // Step 2: Model uses the tool result to conclude
      mockAdapter.enqueueResult({
        text: 'According to [1], system components are strictly decoupled.',
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }
      })

      const stepExecutor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter
      })

      const approvalController = new ApprovalController()
      const workspaceFolderService = new WorkspaceFolderService()

      const runtime = new BoundedAgentRuntime({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        toolRegistry,
        stepExecutor,
        approvalController,
        workspaceFolderService,
        conversationRepository: convRepo
      })

      const result = await runtime.run({
        botId: openaiBotId,
        task: 'How are system components architected?'
      })

      expect(result.status).toBe('completed')
      expect(result.iterationCount).toBe(2)
      expect(result.toolEvents).toHaveLength(1)
      expect(result.toolEvents[0].toolName).toBe('search_knowledge_base')
      expect(result.toolEvents[0].status).toBe('completed')
      expect(result.finalResponse).toBe(
        'According to [1], system components are strictly decoupled.'
      )
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0].fileName).toBe('Architecture Guide.md')

      // Verify persistence in SQLite
      const persistedRun = agentRunRepo.getById(result.agentRunId)
      expect(persistedRun).toBeDefined()
      expect(persistedRun?.status).toBe('completed')
      expect(persistedRun?.iterationCount).toBe(2)

      const persistedEvents = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(persistedEvents).toHaveLength(1)
      expect(persistedEvents[0].toolName).toBe('search_knowledge_base')
      expect(persistedEvents[0].status).toBe('completed')
    })
  })
})
