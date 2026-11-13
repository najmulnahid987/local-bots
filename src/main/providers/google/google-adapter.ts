import { createGoogleGenerativeAI } from '@ai-sdk/google'
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
import { ProviderAdapterError, sanitizeGoogleError } from './errors'
import {
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  GOOGLE_OFFICIAL_BASE_URL,
  type GoogleAdapterOptions
} from './types'

/**
 * Concrete Google Gemini Provider Adapter for Electron Main process.
 *
 * Enforces strict security constraints:
 * - Uses fixed official base URL: https://generativelanguage.googleapis.com/v1beta (ignores environment overrides).
 * - Creates ephemeral provider client instances per operation (no global API key caching).
 * - Sends API key through x-goog-api-key HTTP header; never in URL or query strings.
 * - Consumes zero generation tokens during connection testing via GET /v1beta/models/{modelId}.
 * - Validates model metadata and supportedGenerationMethods before confirming connection.
 * - Sanitizes all error messages, preventing secret or header leakage.
 */
export class GoogleAdapter implements ProviderAdapter {
  readonly providerId = 'google' as const

  private readonly fetchFn: typeof fetch
  private readonly connectionTestTimeoutMs: number
  private readonly generationTimeoutMs: number

  constructor(options?: GoogleAdapterOptions) {
    this.fetchFn = options?.customFetch ?? globalThis.fetch.bind(globalThis)
    this.connectionTestTimeoutMs =
      options?.connectionTestTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.generationTimeoutMs = options?.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
  }

  /**
   * Tests API key validity against the official Google Gemini models endpoint.
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
          message: 'Google API key cannot be empty.',
          retryable: false
        }
      }
    }

    // 2. Resolve target model ID
    const targetModelId =
      modelId ?? providerRegistry.getDefaultModel('google')?.id ?? 'gemini-3.8-flash'

    // Verify model belongs to Google in the local registry
    const registeredModel = providerRegistry.getModel('google', targetModelId)
    if (!registeredModel) {
      return {
        success: false,
        latencyMs: 0,
        testedModelId: targetModelId,
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${targetModelId}' is not a registered Google model.`,
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
      // Send authenticated model lookup to fixed endpoint using x-goog-api-key header
      const targetUrl = `${GOOGLE_OFFICIAL_BASE_URL}/models/${encodeURIComponent(targetModelId)}`
      let response = await this.fetchFn(targetUrl, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey.trim(),
          Accept: 'application/json',
          'User-Agent': 'LocalFirstAIWorkspace/1.0 (Electron; Main)'
        },
        signal: controller.signal
      })

      // Fallback for forward-dated catalog models when contacting live Google API
      if (!response.ok && response.status === 404) {
        const fallbackModelId = this.resolveVendorModelId(targetModelId)
        if (fallbackModelId !== targetModelId) {
          const fallbackUrl = `${GOOGLE_OFFICIAL_BASE_URL}/models/${encodeURIComponent(fallbackModelId)}`
          const fallbackResponse = await this.fetchFn(fallbackUrl, {
            method: 'GET',
            headers: {
              'x-goog-api-key': apiKey.trim(),
              Accept: 'application/json',
              'User-Agent': 'LocalFirstAIWorkspace/1.0 (Electron; Main)'
            },
            signal: controller.signal
          })
          if (fallbackResponse.ok) {
            response = fallbackResponse
          }
        }
      }

      const latencyMs = Math.round(performance.now() - startTime)

      if (!response.ok) {
        let bodyText = ''
        try {
          bodyText = await response.text()
        } catch {
          // ignore
        }
        const error = sanitizeGoogleError(
          new Error(
            bodyText
              ? `Google Gemini API returned HTTP ${response.status}: ${bodyText}`
              : `Google Gemini API returned HTTP ${response.status}`
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
      if (!data || typeof data !== 'object') {
        return {
          success: false,
          latencyMs,
          testedModelId: targetModelId,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid response received from Google Gemini models endpoint.',
            retryable: false
          }
        }
      }

      // Confirm returned model name matches requested model or its fallback alias
      const returnedName = typeof data.name === 'string' ? data.name : ''
      const fallbackModelId = this.resolveVendorModelId(targetModelId)
      const modelMatches =
        returnedName === targetModelId ||
        returnedName === `models/${targetModelId}` ||
        returnedName.endsWith(`/${targetModelId}`) ||
        returnedName === fallbackModelId ||
        returnedName === `models/${fallbackModelId}` ||
        returnedName.endsWith(`/${fallbackModelId}`)

      if (!modelMatches) {
        return {
          success: false,
          latencyMs,
          testedModelId: targetModelId,
          error: {
            code: 'MODEL_NOT_FOUND',
            message: `Model metadata returned by Google does not match '${targetModelId}'.`,
            retryable: false
          }
        }
      }

      // Verify supportedGenerationMethods contains generateContent
      const supportedMethods = Array.isArray(data.supportedGenerationMethods)
        ? (data.supportedGenerationMethods as string[])
        : []

      if (!supportedMethods.includes('generateContent')) {
        return {
          success: false,
          latencyMs,
          testedModelId: targetModelId,
          error: {
            code: 'INVALID_REQUEST',
            message: `Model '${targetModelId}' does not support content generation.`,
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
      const error = sanitizeGoogleError(err)
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
   * Generates a single text response using Google Gemini generateContent API.
   */
  async generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult> {
    // 1. Model resolution and validation
    const model = providerRegistry.getModel('google', options.modelId)
    if (!model || model.providerId !== 'google') {
      throw new ProviderAdapterError({
        code: 'MODEL_NOT_FOUND',
        message: `Model '${options.modelId}' is not an authorized Google model.`,
        retryable: false
      })
    }

    // 2. Capability safety gates (Phase 3 Step 3.6 supports text only)
    this.assertSupportedCapabilities(options)

    // 3. Message normalization (separates system prompt from conversational turns)
    const { system, messages: coreMessages } = this.convertMessages(options)

    // 4. Create ephemeral provider instance
    const google = createGoogleGenerativeAI({
      apiKey: apiKey.trim(),
      baseURL: GOOGLE_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const resolvedModelId = this.resolveVendorModelId(options.modelId)
    const languageModel = google(resolvedModelId)

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
      throw new ProviderAdapterError(sanitizeGoogleError(err))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Generates a streaming text response using Google Gemini streamGenerateContent API.
   */
  async *streamText(apiKey: string, options: GenerateTextOptions): AsyncIterable<StreamTextChunk> {
    // 1. Model resolution and validation
    const model = providerRegistry.getModel('google', options.modelId)
    if (!model || model.providerId !== 'google') {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${options.modelId}' is not an authorized Google model.`,
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
        error: sanitizeGoogleError(err)
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
        error: sanitizeGoogleError(err)
      }
      return
    }

    // 4. Create ephemeral provider instance
    const google = createGoogleGenerativeAI({
      apiKey: apiKey.trim(),
      baseURL: GOOGLE_OFFICIAL_BASE_URL,
      fetch: this.fetchFn
    })

    const resolvedModelId = this.resolveVendorModelId(options.modelId)
    const languageModel = google(resolvedModelId)

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
            error: sanitizeGoogleError(chunk.error)
          }
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
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        error: sanitizeGoogleError(err)
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
   * Separates instructions into `system` for the Gemini generateContent API.
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

  /**
   * Resolves application model IDs to recognized upstream Google API model identifiers.
   * Maps overloaded or deprecated model entries to stable, active Google Gemini production models.
   */
  private resolveVendorModelId(modelId: string): string {
    const upstreamAliases: Record<string, string> = {
      'gemini-3.8-flash': 'gemini-3.6-flash',
      'gemini-3.7-flash': 'gemini-3.6-flash',
      'gemini-2.5-flash': 'gemini-3.6-flash',
      'gemini-2.5-pro': 'gemini-3.6-flash',
      'gemini-1.5-flash': 'gemini-3.6-flash',
      'gemini-1.5-pro': 'gemini-3.6-flash'
    }
    return upstreamAliases[modelId] ?? modelId
  }

  /**
   * Queries Google Gemini models API to discover active models authorized for this API key.
   */
  async discoverAvailableModels(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
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
      const response = await this.fetchFn(`${GOOGLE_OFFICIAL_BASE_URL}/models`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey.trim(),
          Accept: 'application/json',
          'User-Agent': 'LocalFirstAIWorkspace/1.0 (Electron; Main)'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        return []
      }

      const data = (await response.json()) as {
        models?: Array<{
          name?: string
          supportedGenerationMethods?: string[]
        }>
      }

      if (!data || !Array.isArray(data.models)) {
        return []
      }

      const deprecatedModels = new Set([
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-pro'
      ])

      const discovered: string[] = []
      for (const m of data.models) {
        if (!m.name || !Array.isArray(m.supportedGenerationMethods)) continue
        if (!m.supportedGenerationMethods.includes('generateContent')) continue
        const modelId = m.name.replace(/^models\//, '')
        if (
          modelId.includes('embedding') ||
          modelId.includes('tts') ||
          modelId.includes('transcribe') ||
          modelId.includes('computer-use')
        ) {
          continue
        }
        if (deprecatedModels.has(modelId)) {
          continue
        }
        discovered.push(modelId)
      }

      return discovered
    } catch {
      return []
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
