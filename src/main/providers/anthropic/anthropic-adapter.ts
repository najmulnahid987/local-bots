import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, streamText, type ModelMessage } from 'ai'
import { providerRegistry } from '../provider-registry'
import {
  type ConnectionTestResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type ProviderAdapter,
  type StreamTextChunk,
  type TokenUsage
} from '../types'
import { ProviderAdapterError, sanitizeAnthropicError } from './errors'
import {
  ANTHROPIC_DEFAULT_VERSION,
  ANTHROPIC_OFFICIAL_BASE_URL,
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  type AnthropicAdapterOptions
} from './types'

/**
 * Concrete Anthropic Claude Provider Adapter for Electron Main process.
 *
 * Enforces strict security constraints:
 * - Uses fixed official base URL: https://api.anthropic.com/v1 (ignores environment overrides).
 * - Creates ephemeral provider client instances per operation (no global API key caching).
 * - Sends official anthropic-version header (2023-06-01).
 * - Consumes zero generation tokens during connection testing via GET /v1/models/{model_id}.
 * - Sanitizes all error messages, preventing secret or header leakage.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic' as const

  private readonly fetchFn: typeof fetch
  private readonly connectionTestTimeoutMs: number
  private readonly generationTimeoutMs: number

  constructor(options?: AnthropicAdapterOptions) {
    this.fetchFn = options?.customFetch ?? globalThis.fetch.bind(globalThis)
    this.connectionTestTimeoutMs =
      options?.connectionTestTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.generationTimeoutMs = options?.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
  }

  /**
   * Tests API key validity against the official Anthropic models endpoint.
   * Consumes zero text generation tokens by executing an authenticated model metadata lookup.
   */
  async testConnection(
    apiKey: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<ConnectionTestResult> {
    const startTime = performance.now()

    // 1. Validate API key input
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return {
        success: false,
        latencyMs: 0,
        testedModelId: modelId ?? 'default',
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Anthropic API key cannot be empty.',
          retryable: false
        }
      }
    }

    // 2. Resolve target model ID
    const targetModelId =
      modelId ?? providerRegistry.getDefaultModel('anthropic')?.id ?? 'claude-sonnet-5-5'

    // Verify model belongs to Anthropic in the local registry
    const registeredModel = providerRegistry.getModel('anthropic', targetModelId)
    if (!registeredModel) {
      return {
        success: false,
        latencyMs: 0,
        testedModelId: targetModelId,
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${targetModelId}' is not a registered Anthropic model.`,
          retryable: false
        }
      }
    }

    // 3. Prepare timeout and abort controller
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('Connection test timed out.'))
    }, this.connectionTestTimeoutMs)

    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason)
      } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
    }

    if (controller.signal.aborted) {
      clearTimeout(timeoutId)
      return {
        success: false,
        latencyMs: 0,
        testedModelId: targetModelId,
        error: {
          code: 'OPERATION_ABORTED',
          message: 'The operation was aborted by the client.',
          retryable: false
        }
      }
    }

    try {
      // Send authenticated model lookup to fixed endpoint
      const targetUrl = `${ANTHROPIC_OFFICIAL_BASE_URL}/models/${encodeURIComponent(targetModelId)}`
      const response = await this.fetchFn(targetUrl, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey.trim(),
          'anthropic-version': ANTHROPIC_DEFAULT_VERSION,
          Accept: 'application/json',
          'User-Agent': 'LocalFirstAIWorkspace/1.0 (Electron; Main)'
        },
        signal: controller.signal
      })

      const latencyMs = Math.round(performance.now() - startTime)

      if (!response.ok) {
        let bodyText = ''
        try {
          bodyText = await response.text()
        } catch {
          // ignore
        }
        const error = sanitizeAnthropicError(
          new Error(
            bodyText
              ? `Anthropic API returned HTTP ${response.status}: ${bodyText}`
              : `Anthropic API returned HTTP ${response.status}`
          ),
          response.status
        )
        return {
          success: false,
          latencyMs,
          testedModelId: targetModelId,
          error
        }
      }

      // Verify response body contains valid model metadata
      const data = (await response.json()) as Record<string, unknown>
      if (!data || typeof data.id !== 'string') {
        return {
          success: false,
          latencyMs,
          testedModelId: targetModelId,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid response received from Anthropic models endpoint.',
            retryable: false
          }
        }
      }

      return {
        success: true,
        latencyMs,
        testedModelId: targetModelId
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime)
      const error = sanitizeAnthropicError(err)
      return {
        success: false,
        latencyMs,
        testedModelId: targetModelId,
        error
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Generates a single text response using Anthropic Messages API.
   */
  async generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult> {
    // 1. Model resolution and validation
    const model = providerRegistry.getModel('anthropic', options.modelId)
    if (!model || model.providerId !== 'anthropic') {
      throw new ProviderAdapterError({
        code: 'MODEL_NOT_FOUND',
        message: `Model '${options.modelId}' is not an authorized Anthropic model.`,
        retryable: false
      })
    }

    // 2. Capability safety gates (Phase 3 Step 3.5 supports text only)
    this.assertSupportedCapabilities(options)

    // 3. Message normalization (separates system prompt from conversational turns)
    const { system, messages: coreMessages } = this.convertMessages(options)

    // 4. Create ephemeral provider instance
    const anthropic = createAnthropic({
      apiKey: apiKey.trim(),
      baseURL: ANTHROPIC_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const languageModel = anthropic.messages(options.modelId)

    // 5. Setup abort signal with generation timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('Generation request timed out.'))
    }, this.generationTimeoutMs)

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        controller.abort(options.abortSignal.reason)
      } else {
        options.abortSignal.addEventListener(
          'abort',
          () => controller.abort(options.abortSignal!.reason),
          { once: true }
        )
      }
    }

    try {
      const result = await generateText({
        model: languageModel,
        system,
        messages: coreMessages,
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: controller.signal
      })

      const usage: TokenUsage = {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0
      }

      return {
        text: result.text,
        finishReason: this.mapFinishReason(result.finishReason),
        usage
      }
    } catch (err) {
      throw new ProviderAdapterError(sanitizeAnthropicError(err))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Generates a streaming text response using Anthropic Messages API.
   */
  async *streamText(apiKey: string, options: GenerateTextOptions): AsyncIterable<StreamTextChunk> {
    // 1. Model resolution and validation
    const model = providerRegistry.getModel('anthropic', options.modelId)
    if (!model || model.providerId !== 'anthropic') {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${options.modelId}' is not an authorized Anthropic model.`,
          retryable: false
        }
      }
      return
    }

    // 2. Capability safety gates
    try {
      this.assertSupportedCapabilities(options)
    } catch (err) {
      yield {
        type: 'error',
        error: sanitizeAnthropicError(err)
      }
      return
    }

    // 3. Message normalization
    let systemInstruction: string | undefined
    let coreMessages: ModelMessage[]
    try {
      const converted = this.convertMessages(options)
      systemInstruction = converted.system
      coreMessages = converted.messages
    } catch (err) {
      yield {
        type: 'error',
        error: sanitizeAnthropicError(err)
      }
      return
    }

    // 4. Create ephemeral provider instance
    const anthropic = createAnthropic({
      apiKey: apiKey.trim(),
      baseURL: ANTHROPIC_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const languageModel = anthropic.messages(options.modelId)

    // 5. Setup abort signal with generation timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('Streaming generation request timed out.'))
    }, this.generationTimeoutMs)

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        controller.abort(options.abortSignal.reason)
      } else {
        options.abortSignal.addEventListener(
          'abort',
          () => controller.abort(options.abortSignal!.reason),
          { once: true }
        )
      }
    }

    try {
      const result = streamText({
        model: languageModel,
        system: systemInstruction,
        messages: coreMessages,
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: controller.signal
      })

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          yield {
            type: 'text-delta',
            textDelta: chunk.text
          }
        } else if (chunk.type === 'finish') {
          const usage: TokenUsage = {
            promptTokens: chunk.totalUsage.inputTokens ?? 0,
            completionTokens: chunk.totalUsage.outputTokens ?? 0,
            totalTokens: chunk.totalUsage.totalTokens ?? 0
          }
          yield {
            type: 'finish',
            finishReason: this.mapFinishReason(chunk.finishReason),
            usage
          }
        } else if (chunk.type === 'error') {
          yield {
            type: 'error',
            error: sanitizeAnthropicError(chunk.error)
          }
        } else if (chunk.type === 'abort') {
          yield {
            type: 'error',
            error: {
              code: 'OPERATION_ABORTED',
              message: 'Streaming generation aborted by client.',
              retryable: false
            }
          }
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        error: sanitizeAnthropicError(err)
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Asserts that requested features do not exceed supported capabilities for this phase.
   */
  private assertSupportedCapabilities(options: GenerateTextOptions): void {
    if (options.tools && options.tools.length > 0) {
      throw new ProviderAdapterError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Tool calling is not supported in this adapter step.',
        retryable: false
      })
    }

    if (options.jsonSchema) {
      throw new ProviderAdapterError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Structured output schema is not supported in this adapter step.',
        retryable: false
      })
    }

    for (const msg of options.messages) {
      if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((p) => p.type === 'image')
        if (hasImage) {
          throw new ProviderAdapterError({
            code: 'UNSUPPORTED_CAPABILITY',
            message: 'Multimodal image input is not supported in this adapter step.',
            retryable: false
          })
        }
      }
    }
  }

  /**
   * Converts application ChatMessage structures to AI SDK ModelMessage structures.
   * Separates instructions into `system` for the Anthropic Messages API.
   */
  private convertMessages(options: GenerateTextOptions): {
    system?: string
    messages: ModelMessage[]
  } {
    const systemParts: string[] = []

    if (options.systemPrompt && options.systemPrompt.trim().length > 0) {
      systemParts.push(options.systemPrompt.trim())
    }

    const messages: ModelMessage[] = []

    for (const msg of options.messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        if (text.trim().length > 0) {
          systemParts.push(text.trim())
        }
      } else if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        messages.push({ role: 'user', content: text })
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        messages.push({ role: 'assistant', content: text })
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      messages
    }
  }

  private extractText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
    return parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('\n')
  }

  private mapFinishReason(
    rawReason: string | undefined
  ): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other' {
    switch (rawReason) {
      case 'stop':
        return 'stop'
      case 'length':
        return 'length'
      case 'content-filter':
        return 'content_filter'
      case 'tool-calls':
        return 'tool_calls'
      default:
        return 'other'
    }
  }
}
