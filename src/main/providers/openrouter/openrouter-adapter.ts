import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { mapToolsToAiSdk, mapToolCalls } from '../../agents/ai-sdk-tool-mapper'
import { ProviderAdapterError, sanitizeOpenRouterError } from './errors'
import { parseOpenRouterModelsResponse } from './model-metadata'
import {
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  OPENROUTER_DEFAULT_TEST_MODEL,
  OPENROUTER_OFFICIAL_BASE_URL,
  openRouterAuthKeyResponseSchema,
  openRouterRoutingSchema,
  type OpenRouterAdapterOptions
} from './types'
import type {
  ConnectionTestResult,
  GenerateTextOptions,
  GenerateTextResult,
  ModelDescriptor,
  OpenRouterRoutingPreferences,
  ProviderAdapter,
  StreamTextChunk,
  TokenUsage
} from '../types'

function resolveVerifiedOpenRouterBaseUrl(rawBaseUrl?: string): string {
  const candidate = (rawBaseUrl ?? OPENROUTER_OFFICIAL_BASE_URL).trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Invalid OpenRouter API base URL configuration.',
      retryable: false
    })
  }

  if (parsed.protocol !== 'https:') {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'OpenRouter API base URL must use HTTPS.',
      retryable: false
    })
  }

  return parsed.toString().replace(/\/+$/, '')
}

function composeTimeoutAbortSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const onCallerAbort = (): void => {
    controller.abort(
      callerSignal?.reason ?? new DOMException('Request aborted by caller.', 'AbortError')
    )
  }

  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort()
      return { signal: controller.signal, cleanup: () => {} }
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }

  timer = setTimeout(() => {
    controller.abort(
      new DOMException(`OpenRouter request timed out after ${timeoutMs}ms.`, 'TimeoutError')
    )
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort)
      }
    }
  }
}

export interface ValidatedOpenRouterProviderRouting {
  readonly sort?: 'price' | 'latency' | 'throughput'
  readonly allow_fallbacks?: boolean
  readonly zdr?: boolean
}

/**
 * Validates and builds OpenRouter `provider` routing settings.
 * Returns undefined when routing is omitted or set to `'default'` so OpenRouter's native
 * routing behavior is preserved without unnecessary overrides.
 */
export function buildValidatedOpenRouterRouting(
  routing?: OpenRouterRoutingPreferences
): ValidatedOpenRouterProviderRouting | undefined {
  if (!routing) {
    return undefined
  }

  const parsed = openRouterRoutingSchema.safeParse(routing)
  if (!parsed.success) {
    const issue = parsed.error.issues.map((i) => i.message).join('; ')
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: `Invalid OpenRouter routing preferences: ${issue}`,
      retryable: false
    })
  }

  const validated = parsed.data
  const providerObj: {
    sort?: 'price' | 'latency' | 'throughput'
    allow_fallbacks?: boolean
    zdr?: boolean
  } = {}

  if (validated.sort && validated.sort !== 'default') {
    providerObj.sort = validated.sort
  }
  if (typeof validated.allowFallbacks === 'boolean') {
    providerObj.allow_fallbacks = validated.allowFallbacks
  }
  if (validated.zdr === true) {
    providerObj.zdr = true
  }

  return Object.keys(providerObj).length > 0 ? providerObj : undefined
}

/**
 * Production OpenRouter adapter communicating over direct HTTPS (`https://openrouter.ai/api/v1`)
 * via `@openrouter/ai-sdk-provider`. Preserves BYOK security, user-filtered discovery,
 * conservative capability validation, routing defaults, and mid-stream SSE error surfacing.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  public readonly providerId = 'openrouter' as const

  private readonly baseURL: string
  private readonly fetchFn: typeof fetch
  private readonly connectionTestTimeoutMs: number
  private readonly discoveryTimeoutMs: number
  private readonly generationTimeoutMs: number

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.baseURL = resolveVerifiedOpenRouterBaseUrl(options.baseURL)
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.connectionTestTimeoutMs =
      options.connectionTestTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    this.generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
  }

  /**
   * Builds an AI SDK LanguageModel using `@openrouter/ai-sdk-provider` in `'strict'` mode.
   * Never sends machine-identifying headers (`HTTP-Referer`, hostname, etc.).
   */
  public createLanguageModel(
    apiKey: string,
    modelId: string,
    options?: {
      routing?: OpenRouterRoutingPreferences
      hasTools?: boolean
    }
  ): LanguageModel {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'OpenRouter API key is required.',
        retryable: false
      })
    }

    const trimmedModelId = modelId.trim()
    if (!trimmedModelId) {
      throw new ProviderAdapterError({
        code: 'INVALID_REQUEST',
        message: 'OpenRouter model ID cannot be blank.',
        retryable: false
      })
    }

    const providerRouting = buildValidatedOpenRouterRouting(options?.routing)

    const client = createOpenRouter({
      apiKey: trimmedKey,
      baseURL: this.baseURL,
      compatibility: 'strict',
      fetch: this.fetchFn
    })

    const chatSettings = {
      ...(providerRouting ? { provider: providerRouting } : {}),
      ...(options?.hasTools ? { parallelToolCalls: false } : {})
    }

    return client.chat(
      trimmedModelId,
      Object.keys(chatSettings).length > 0 ? chatSettings : undefined
    ) as unknown as LanguageModel
  }

  /**
   * Tests OpenRouter BYOK credentials via `GET /auth/key` and fetches the user's
   * account-filtered model list via `GET /models/user` with zero token spend.
   */
  public async testConnection(
    apiKey: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    const trimmedModelId = modelId?.trim()

    if (!apiKey || apiKey.trim().length === 0) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        testedModelId: trimmedModelId || OPENROUTER_DEFAULT_TEST_MODEL,
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'OpenRouter API key is missing or blank.',
          retryable: false
        }
      }
    }

    const { signal: combinedSignal, cleanup } = composeTimeoutAbortSignal(
      this.connectionTestTimeoutMs,
      signal
    )

    try {
      const trimmedKey = apiKey.trim()
      // 1. Validate API key via authenticated /auth/key endpoint
      const authRes = await this.fetchFn(`${this.baseURL}/auth/key`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          Accept: 'application/json'
        },
        signal: combinedSignal
      })

      if (!authRes.ok) {
        const bodyText = await authRes.text().catch(() => '')
        throw {
          statusCode: authRes.status,
          responseHeaders: authRes.headers,
          message: `OpenRouter key verification failed (HTTP ${authRes.status}).`,
          responseBody: bodyText
        }
      }

      const authPayload = (await authRes.json()) as unknown
      const authParsed = openRouterAuthKeyResponseSchema.safeParse(authPayload)
      if (!authParsed.success) {
        throw new ProviderAdapterError({
          code: 'INVALID_REQUEST',
          message: 'Malformed response from OpenRouter key verification endpoint.',
          retryable: false
        })
      }

      // 2. Query user-filtered accessible models via /models/user (no silent fallback on 401/403)
      const discoveredModels = await this.fetchUserModelsInternal(trimmedKey, combinedSignal)
      const availableModels = discoveredModels.map((m) => m.id)

      if (trimmedModelId && trimmedModelId !== OPENROUTER_DEFAULT_TEST_MODEL) {
        if (!availableModels.includes(trimmedModelId)) {
          return {
            success: false,
            latencyMs: Date.now() - startedAt,
            testedModelId: trimmedModelId,
            error: {
              code: 'MODEL_NOT_FOUND',
              message: `Requested OpenRouter model '${trimmedModelId}' is not available under this key's account/privacy settings.`,
              statusCode: 404,
              retryable: false
            }
          }
        }
      }

      const chosenModelId = trimmedModelId || availableModels[0] || OPENROUTER_DEFAULT_TEST_MODEL

      return {
        success: true,
        latencyMs: Date.now() - startedAt,
        testedModelId: chosenModelId,
        availableModels,
        discoveredModels
      }
    } catch (err) {
      const normalized = combinedSignal.aborted
        ? sanitizeOpenRouterError(combinedSignal.reason ?? err)
        : sanitizeOpenRouterError(err)
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        testedModelId: trimmedModelId || OPENROUTER_DEFAULT_TEST_MODEL,
        error: normalized
      }
    } finally {
      cleanup()
    }
  }

  /**
   * Lists active text-capable OpenRouter model IDs permitted for the authenticated user key.
   */
  public async discoverAvailableModels(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const models = await this.discoverModelMetadata(apiKey, signal)
    return models.map((m) => m.id)
  }

  /**
   * Queries `GET /api/v1/models/user` with strict Bearer authentication and validates returned metadata.
   * Never silently falls back to the broader public `/models` catalog on auth/policy failure.
   */
  public async discoverModelMetadata(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>> {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'OpenRouter API key is missing or blank.',
        retryable: false
      })
    }

    const { signal: combinedSignal, cleanup } = composeTimeoutAbortSignal(
      this.discoveryTimeoutMs,
      signal
    )

    try {
      return await this.fetchUserModelsInternal(trimmedKey, combinedSignal)
    } catch (err) {
      const normalized = combinedSignal.aborted
        ? sanitizeOpenRouterError(combinedSignal.reason ?? err)
        : sanitizeOpenRouterError(err)
      throw new ProviderAdapterError(normalized)
    } finally {
      cleanup()
    }
  }

  /**
   * Explicitly fetches the broad public OpenRouter `/api/v1/models?output_modalities=text` catalog.
   * Returned entries are marked `metadataSource: 'public_catalog'` and must never be misrepresented
   * as guaranteed usable by every account without `/models/user` confirmation.
   */
  public async fetchPublicCatalogModels(
    signal?: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>> {
    const { signal: combinedSignal, cleanup } = composeTimeoutAbortSignal(
      this.discoveryTimeoutMs,
      signal
    )

    try {
      const response = await this.fetchFn(`${this.baseURL}/models?output_modalities=text`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: combinedSignal
      })
      if (!response.ok) {
        const responseBody = await response.text().catch(() => '')
        throw {
          statusCode: response.status,
          responseHeaders: response.headers,
          message: `OpenRouter public models fetch failed (HTTP ${response.status}).`,
          responseBody
        }
      }
      const payload = (await response.json()) as unknown
      return parseOpenRouterModelsResponse(payload, 'public_catalog')
    } catch (err) {
      const normalized = combinedSignal.aborted
        ? sanitizeOpenRouterError(combinedSignal.reason ?? err)
        : sanitizeOpenRouterError(err)
      throw new ProviderAdapterError(normalized)
    } finally {
      cleanup()
    }
  }

  /**
   * Executes a non-streaming text generation call via `@openrouter/ai-sdk-provider`.
   */
  public async generateText(
    apiKey: string,
    options: GenerateTextOptions
  ): Promise<GenerateTextResult> {
    const { languageModel, system, messages, aiTools, temperature, signal, cleanup } =
      this.prepareGenerationRequest(apiKey, options)

    try {
      const result = await generateText({
        model: languageModel,
        system,
        messages,
        tools: aiTools,
        temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: signal
      })

      const usage: TokenUsage = {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens:
          result.usage.totalTokens ??
          (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
      }

      const toolCalls = mapToolCalls(result.toolCalls)

      return {
        text: result.text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: this.mapFinishReason(result.finishReason),
        usage
      }
    } catch (err) {
      const normalized = signal.aborted
        ? sanitizeOpenRouterError(signal.reason ?? err)
        : sanitizeOpenRouterError(err)
      throw new ProviderAdapterError(normalized)
    } finally {
      cleanup()
    }
  }

  /**
   * Executes a streaming generation call against OpenRouter.
   * Surfaces HTTP 200 mid-stream SSE error events as sanitized `error` chunks and suppresses
   * any subsequent false successful `finish` event.
   */
  public async *streamText(
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    if (options.abortSignal?.aborted) {
      yield {
        type: 'error',
        error: sanitizeOpenRouterError(
          options.abortSignal.reason ??
            new DOMException('OpenRouter request was cancelled.', 'AbortError')
        )
      }
      return
    }

    const { languageModel, system, messages, aiTools, temperature, signal, cleanup } =
      this.prepareGenerationRequest(apiKey, options)

    let terminatedWithTerminalChunk = false
    let requestId: string | undefined

    try {
      const result = streamText({
        model: languageModel,
        system,
        messages,
        tools: aiTools,
        temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: signal
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          const textDelta =
            typeof part.text === 'string'
              ? part.text
              : typeof (part as unknown as { textDelta?: unknown }).textDelta === 'string'
                ? (part as unknown as { textDelta: string }).textDelta
                : ''
          if (textDelta.length > 0) {
            yield { type: 'text-delta', textDelta }
          }
        } else if (part.type === 'tool-input-delta') {
          const deltaPart = part as { id?: string; toolName?: string; delta?: string }
          if (deltaPart.id) {
            yield {
              type: 'tool-call-delta',
              toolCallId: deltaPart.id,
              toolName: deltaPart.toolName,
              argsDelta: deltaPart.delta ?? ''
            }
          }
        } else if (part.type === 'tool-call') {
          const mapped = mapToolCalls([part])[0]
          if (mapped) {
            yield { type: 'tool-call', toolCall: mapped }
          }
        } else if (part.type === 'finish-step') {
          const id = (part as { response?: { id?: unknown } }).response?.id
          if (typeof id === 'string' && id.trim().length > 0) {
            requestId = id.trim()
          }
        } else if (part.type === 'abort') {
          terminatedWithTerminalChunk = true
          yield {
            type: 'error',
            error: sanitizeOpenRouterError(
              signal.reason ?? new DOMException('OpenRouter stream was aborted.', 'AbortError'),
              undefined,
              requestId
            )
          }
          return
        } else if (part.type === 'error') {
          terminatedWithTerminalChunk = true
          yield {
            type: 'error',
            error: sanitizeOpenRouterError(part.error, undefined, requestId)
          }
          return
        } else if (part.type === 'finish') {
          const rawUnifiedFinish =
            typeof part.finishReason === 'string'
              ? part.finishReason
              : (part.finishReason as unknown as { unified?: unknown })?.unified

          if (rawUnifiedFinish === 'error') {
            terminatedWithTerminalChunk = true
            yield {
              type: 'error',
              error: sanitizeOpenRouterError(
                new Error('OpenRouter upstream provider terminated stream with error.'),
                502,
                requestId
              )
            }
            return
          }

          terminatedWithTerminalChunk = true
          const totalUsage = part.totalUsage
          const usage: TokenUsage | undefined = totalUsage
            ? {
                promptTokens: totalUsage.inputTokens ?? 0,
                completionTokens: totalUsage.outputTokens ?? 0,
                totalTokens:
                  totalUsage.totalTokens ??
                  (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
              }
            : undefined
          yield {
            type: 'finish',
            finishReason: this.mapFinishReason(part.finishReason),
            usage
          }
          return
        }
      }

      if (!terminatedWithTerminalChunk && signal.aborted) {
        yield {
          type: 'error',
          error: sanitizeOpenRouterError(
            signal.reason ?? new DOMException('OpenRouter stream was cancelled.', 'AbortError'),
            undefined,
            requestId
          )
        }
      } else if (!terminatedWithTerminalChunk) {
        yield {
          type: 'error',
          error: sanitizeOpenRouterError(
            new Error('OpenRouter stream ended unexpectedly without completion.'),
            502,
            requestId
          )
        }
      }
    } catch (err) {
      const normalized = signal.aborted
        ? sanitizeOpenRouterError(signal.reason ?? err, undefined, requestId)
        : sanitizeOpenRouterError(err, undefined, requestId)
      yield { type: 'error', error: normalized }
    } finally {
      cleanup()
    }
  }

  /**
   * Backwards-compatible alias matching explicit executeStream naming.
   */
  public executeStream(
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    return this.streamText(apiKey, options)
  }

  private async fetchUserModelsInternal(
    apiKey: string,
    signal: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>> {
    const response = await this.fetchFn(`${this.baseURL}/models/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal
    })

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      throw {
        statusCode: response.status,
        responseHeaders: response.headers,
        message: `OpenRouter user models discovery failed (HTTP ${response.status}).`,
        responseBody
      }
    }

    const payload = (await response.json()) as unknown
    return parseOpenRouterModelsResponse(payload, 'user_models')
  }

  private prepareGenerationRequest(
    apiKey: string,
    options: GenerateTextOptions
  ): {
    languageModel: LanguageModel
    system?: string
    messages: ModelMessage[]
    aiTools: ReturnType<typeof mapToolsToAiSdk> | undefined
    temperature?: number
    signal: AbortSignal
    cleanup: () => void
  } {
    if (options.jsonSchema !== undefined) {
      throw new ProviderAdapterError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Structured jsonSchema mode is not enabled on this adapter endpoint.',
        retryable: false
      })
    }

    const hasTools = Boolean(options.tools && options.tools.length > 0)
    const languageModel = this.createLanguageModel(apiKey, options.modelId, {
      routing: options.openrouterRouting,
      hasTools
    })
    const { system, messages } = this.convertMessages(options)
    const aiTools = hasTools && options.tools ? mapToolsToAiSdk(options.tools) : undefined

    const temperature =
      typeof options.temperature === 'number' && Number.isFinite(options.temperature)
        ? Math.min(2, Math.max(0, options.temperature))
        : undefined

    const { signal, cleanup } = composeTimeoutAbortSignal(
      this.generationTimeoutMs,
      options.abortSignal
    )

    return {
      languageModel,
      system,
      messages,
      aiTools,
      temperature,
      signal,
      cleanup
    }
  }

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
        const text =
          typeof msg.content === 'string' ? msg.content : this.extractTextFromParts(msg.content)
        if (text.trim().length > 0) {
          systemParts.push(text.trim())
        }
        continue
      }

      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content })
        } else {
          const parts: Array<
            { type: 'text'; text: string } | { type: 'image'; image: string; mediaType?: string }
          > = []
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ type: 'text', text: part.text })
            } else if (part.type === 'image') {
              parts.push({ type: 'image', image: part.data, mediaType: part.mediaType })
            }
          }
          messages.push({ role: 'user', content: parts } as ModelMessage)
        }
        continue
      }

      if (msg.role === 'assistant') {
        const text =
          typeof msg.content === 'string' ? msg.content : this.extractTextFromParts(msg.content)
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
        } else {
          messages.push({ role: 'assistant', content: text })
        }
        continue
      }

      if (msg.role === 'tool') {
        const text =
          typeof msg.content === 'string' ? msg.content : this.extractTextFromParts(msg.content)
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
        } as ModelMessage)
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      messages
    }
  }

  private extractTextFromParts(parts: GenerateTextOptions['messages'][number]['content']): string {
    if (typeof parts === 'string') return parts
    return parts
      .filter((p): p is { readonly type: 'text'; readonly text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }

  private mapFinishReason(reason: unknown): GenerateTextResult['finishReason'] {
    const normalized =
      typeof reason === 'string'
        ? reason
        : reason && typeof reason === 'object' && 'unified' in reason
          ? (reason as { unified?: unknown }).unified
          : undefined

    switch (normalized) {
      case 'stop':
        return 'stop'
      case 'length':
        return 'length'
      case 'tool-calls':
      case 'tool_calls':
        return 'tool_calls'
      case 'content-filter':
      case 'content_filter':
        return 'content_filter'
      default:
        return 'other'
    }
  }
}
