import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText, type ModelMessage } from 'ai'
import { mapToolsToAiSdk, mapToolCalls } from '../../agents/ai-sdk-tool-mapper'
import { providerRegistry } from '../provider-registry'
import {
  type ConnectionTestResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type ProviderAdapter,
  type StreamTextChunk,
  type TokenUsage
} from '../types'
import { ProviderAdapterError, sanitizeOpenAIError } from './errors'
import {
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  OPENAI_OFFICIAL_BASE_URL,
  type OpenAIAdapterOptions
} from './types'

/**
 * Concrete OpenAI Provider Adapter for Electron Main process.
 *
 * Enforces strict security constraints:
 * - Uses fixed official base URL: https://api.openai.com/v1 (ignores environment overrides).
 * - Creates ephemeral provider client instances per operation (no global API key caching).
 * - Enforces store: false for data privacy on OpenAI Responses API.
 * - Sanitizes all error messages, preventing secret or header leakage.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const

  private readonly fetchFn: typeof fetch
  private readonly connectionTestTimeoutMs: number
  private readonly generationTimeoutMs: number

  constructor(options?: OpenAIAdapterOptions) {
    this.fetchFn = options?.customFetch ?? globalThis.fetch.bind(globalThis)
    this.connectionTestTimeoutMs =
      options?.connectionTestTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.generationTimeoutMs = options?.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
  }

  /**
   * Tests API key validity against the official OpenAI models endpoint.
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
          message: 'OpenAI API key cannot be empty.',
          retryable: false
        }
      }
    }

    // 2. Resolve target model ID
    const targetModelId = modelId ?? providerRegistry.getDefaultModel('openai')?.id ?? 'gpt-6-luna'

    // Verify model belongs to OpenAI in the local registry
    const registeredModel = providerRegistry.getModel('openai', targetModelId)
    if (!registeredModel) {
      return {
        success: false,
        latencyMs: 0,
        testedModelId: targetModelId,
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${targetModelId}' is not a registered OpenAI model.`,
          retryable: false
        }
      }
    }

    // 3. Prepare timeout and abort controller
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('Connection test timed out.'))
    }, this.connectionTestTimeoutMs)

    let onAbort: (() => void) | undefined
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason)
      } else {
        onAbort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    if (controller.signal.aborted) {
      clearTimeout(timeoutId)
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
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
      const targetUrl = `${OPENAI_OFFICIAL_BASE_URL}/models/${encodeURIComponent(targetModelId)}`
      const response = await this.fetchFn(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
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
        const error = sanitizeOpenAIError(
          new Error(
            bodyText
              ? `OpenAI API returned HTTP ${response.status}: ${bodyText}`
              : `OpenAI API returned HTTP ${response.status}`
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
            message: 'Invalid response received from OpenAI models endpoint.',
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
      const error = sanitizeOpenAIError(err)
      return {
        success: false,
        latencyMs,
        testedModelId: targetModelId,
        error
      }
    } finally {
      clearTimeout(timeoutId)
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }

  /**
   * Generates a single text response using OpenAI Responses API.
   */
  async generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult> {
    // 1. Model resolution and validation (supports connection-scoped discovered models)
    const model = providerRegistry.getModel('openai', options.modelId, options.connectionId)
    if (!model || model.providerId !== 'openai') {
      throw new ProviderAdapterError({
        code: 'MODEL_NOT_FOUND',
        message: `Model '${options.modelId}' is not an authorized OpenAI model.`,
        retryable: false
      })
    }

    // 2. Capability safety gates (Phase 3 Step 3.4 supports text only)
    this.assertSupportedCapabilities(options)

    // 3. Message normalization
    const { system, messages: coreMessages } = this.convertMessages(options)

    // 4. Create ephemeral provider instance
    const openai = createOpenAI({
      apiKey: apiKey.trim(),
      baseURL: OPENAI_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const languageModel = openai.responses(options.modelId)
    const aiTools =
      options.tools && options.tools.length > 0 ? mapToolsToAiSdk(options.tools) : undefined

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
        tools: aiTools,
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: controller.signal,
        providerOptions: {
          openai: {
            store: false,
            parallelToolCalls: false
          }
        }
      })

      const usage: TokenUsage = {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0
      }

      const toolCalls = mapToolCalls(result.toolCalls)

      return {
        text: result.text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: this.mapFinishReason(result.finishReason),
        usage
      }
    } catch (err) {
      const effectiveError =
        controller.signal.aborted &&
        !options.abortSignal?.aborted &&
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : err
      throw new ProviderAdapterError(sanitizeOpenAIError(effectiveError))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Generates a streaming text response using OpenAI Responses API.
   */
  async *streamText(apiKey: string, options: GenerateTextOptions): AsyncIterable<StreamTextChunk> {
    // 1. Model resolution and validation (supports connection-scoped discovered models)
    const model = providerRegistry.getModel('openai', options.modelId, options.connectionId)
    if (!model || model.providerId !== 'openai') {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${options.modelId}' is not an authorized OpenAI model.`,
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
        error: sanitizeOpenAIError(err)
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
        error: sanitizeOpenAIError(err)
      }
      return
    }

    // 4. Create ephemeral provider instance
    const openai = createOpenAI({
      apiKey: apiKey.trim(),
      baseURL: OPENAI_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const languageModel = openai.responses(options.modelId)
    const aiTools =
      options.tools && options.tools.length > 0 ? mapToolsToAiSdk(options.tools) : undefined

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

    let hasYieldedText = false
    try {
      const result = streamText({
        model: languageModel,
        system: systemInstruction,
        messages: coreMessages,
        tools: aiTools,
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: controller.signal,
        providerOptions: {
          openai: {
            store: false,
            parallelToolCalls: false
          }
        }
      })

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          if (chunk.text.length > 0) {
            hasYieldedText = true
          }
          yield {
            type: 'text-delta',
            textDelta: chunk.text
          }
        } else if (chunk.type === 'tool-call') {
          const mapped = mapToolCalls([chunk])
          if (mapped.length > 0) {
            yield {
              type: 'tool-call',
              toolCall: mapped[0]
            }
          }
        } else if (chunk.type === 'finish') {
          if (chunk.finishReason === 'content-filter' && !hasYieldedText) {
            yield {
              type: 'error',
              error: {
                code: 'INVALID_REQUEST',
                message: 'OpenAI blocked this response due to content safety filters.',
                retryable: false
              }
            }
            return
          }
          if (chunk.finishReason === 'error' && !hasYieldedText) {
            yield {
              type: 'error',
              error: {
                code: 'SERVER_ERROR',
                message:
                  'OpenAI encountered a generation error before completing the response. Please retry.',
                retryable: true
              }
            }
            return
          }
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
          return
        } else if (chunk.type === 'error') {
          yield {
            type: 'error',
            error: sanitizeOpenAIError(chunk.error)
          }
          return
        } else if (chunk.type === 'abort') {
          const rawReason =
            (chunk as { reason?: unknown }).reason ??
            controller.signal.reason ??
            options.abortSignal?.reason
          const reasonStr =
            rawReason instanceof Error
              ? rawReason.message
              : typeof rawReason === 'string'
                ? rawReason
                : ''
          const isTimeout =
            reasonStr.toLowerCase().includes('time') ||
            (controller.signal.reason instanceof Error &&
              controller.signal.reason.message.toLowerCase().includes('time'))

          yield {
            type: 'error',
            error: {
              code: isTimeout ? 'TIMEOUT' : 'OPERATION_ABORTED',
              message: isTimeout
                ? 'Streaming generation request timed out.'
                : reasonStr
                  ? reasonStr.replace(/^Error:\s*/, '')
                  : 'Streaming generation aborted by client.',
              retryable: isTimeout
            }
          }
          return
        }
      }
    } catch (err) {
      const effectiveError =
        controller.signal.aborted &&
        !options.abortSignal?.aborted &&
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : err
      yield {
        type: 'error',
        error: sanitizeOpenAIError(effectiveError)
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
      const model = providerRegistry.getModel('openai', options.modelId, options.connectionId)
      if (!model?.providerCapabilities?.tools) {
        throw new ProviderAdapterError({
          code: 'UNSUPPORTED_CAPABILITY',
          message: `Model '${options.modelId}' does not support tool calling.`,
          retryable: false
        })
      }
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
   * Separates instructions into `system` for the OpenAI Responses API.
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

    const pushMergedTextMessage = (role: 'user' | 'assistant', text: string): void => {
      const last = messages[messages.length - 1]
      if (last && last.role === role && typeof last.content === 'string') {
        last.content = `${last.content}\n\n${text}`
        return
      }
      messages.push({ role, content: text })
    }

    for (const msg of options.messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        if (text.trim().length > 0) {
          systemParts.push(text.trim())
        }
      } else if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        if (text.trim().length > 0) {
          pushMergedTextMessage('user', text)
        }
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const parts: Array<
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          > = []
          if (text.trim().length > 0) {
            parts.push({ type: 'text', text })
          }
          for (const tc of msg.toolCalls) {
            parts.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments
            })
          }
          messages.push({ role: 'assistant', content: parts } as ModelMessage)
        } else if (text.trim().length > 0) {
          pushMergedTextMessage('assistant', text)
        }
      } else if (msg.role === 'tool') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content)
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.toolCallId || 'call_0',
              toolName: msg.name || 'tool',
              output: { type: 'text', value: text }
            }
          ]
        })
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

  /**
   * Queries OpenAI models API to discover active models authorized for this API key.
   */
  async discoverAvailableModels(apiKey: string, signal?: AbortSignal): Promise<readonly string[]> {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return []
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason)
      } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
    }

    try {
      const response = await this.fetchFn(`${OPENAI_OFFICIAL_BASE_URL}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: 'application/json',
          'User-Agent': 'LocalFirstAIWorkspace/1.0 (Electron; Main)'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        return []
      }

      const data = (await response.json()) as { data?: Array<{ id?: string }> }
      if (!data || !Array.isArray(data.data)) {
        return []
      }

      const chatPrefixes = ['gpt-', 'o1-', 'o3-', 'o4-', 'chatgpt-']
      return data.data
        .filter((m) => {
          if (!m.id) return false
          const lower = m.id.toLowerCase()
          return chatPrefixes.some((prefix) => lower.startsWith(prefix))
        })
        .map((m) => m.id!)
    } catch {
      return []
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
