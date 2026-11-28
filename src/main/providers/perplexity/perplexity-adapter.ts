import { createPerplexity } from '@ai-sdk/perplexity'
import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { isSafeHttpUrl } from '../../../shared/conversations'
import { mapToolsToAiSdk, mapToolCalls } from '../../agents/ai-sdk-tool-mapper'
import { ProviderAdapterError, sanitizePerplexityError } from './errors'
import { getPerplexityCuratedCatalogModels } from './model-metadata'
import {
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  PERPLEXITY_DEFAULT_TEST_MODEL,
  PERPLEXITY_OFFICIAL_BASE_URL,
  type PerplexityAdapterOptions
} from './types'
import type {
  ConnectionTestResult,
  GenerateTextOptions,
  GenerateTextResult,
  ModelDescriptor,
  ProviderAdapter,
  ProviderCostMetadata,
  ProviderWebSource,
  StreamTextChunk,
  TokenUsage
} from '../types'

function resolveVerifiedPerplexityBaseUrl(rawBaseUrl?: string): string {
  const candidate = (rawBaseUrl ?? PERPLEXITY_OFFICIAL_BASE_URL).trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Invalid Perplexity API base URL configuration.',
      retryable: false
    })
  }

  if (parsed.protocol !== 'https:') {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Perplexity API base URL must use HTTPS.',
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
      new DOMException(`Perplexity request timed out after ${timeoutMs}ms.`, 'TimeoutError')
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

function deriveSafeTitleFromUrl(rawUrl: string, rawTitle?: unknown): string {
  if (typeof rawTitle === 'string' && rawTitle.trim().length > 0) {
    return rawTitle.trim().slice(0, 500)
  }
  try {
    const parsed = new URL(rawUrl)
    return parsed.hostname || rawUrl.slice(0, 500)
  } catch {
    return rawUrl.slice(0, 500)
  }
}

function normalizeSdkSource(rawSource: unknown): ProviderWebSource | null {
  if (!rawSource || typeof rawSource !== 'object') {
    return null
  }
  const src = rawSource as Record<string, unknown>
  if (src.sourceType !== undefined && src.sourceType !== 'url') {
    return null
  }
  if (typeof src.url !== 'string') {
    return null
  }
  const trimmedUrl = src.url.trim()
  if (!isSafeHttpUrl(trimmedUrl)) {
    return null
  }

  const perplexityMeta =
    src.providerMetadata &&
    typeof src.providerMetadata === 'object' &&
    'perplexity' in src.providerMetadata &&
    typeof (src.providerMetadata as { perplexity?: unknown }).perplexity === 'object'
      ? ((src.providerMetadata as { perplexity: Record<string, unknown> }).perplexity ?? {})
      : {}

  const id =
    typeof src.id === 'string' && src.id.trim().length > 0
      ? src.id.trim().slice(0, 200)
      : trimmedUrl.slice(0, 200)
  const snippet =
    typeof perplexityMeta.snippet === 'string' && perplexityMeta.snippet.trim().length > 0
      ? perplexityMeta.snippet.trim().slice(0, 4000)
      : undefined
  const publishedDate =
    typeof perplexityMeta.date === 'string' && perplexityMeta.date.trim().length > 0
      ? perplexityMeta.date.trim().slice(0, 100)
      : undefined
  const lastUpdated =
    typeof perplexityMeta.lastUpdated === 'string' && perplexityMeta.lastUpdated.trim().length > 0
      ? perplexityMeta.lastUpdated.trim().slice(0, 100)
      : undefined

  return {
    id,
    title: deriveSafeTitleFromUrl(trimmedUrl, src.title),
    url: trimmedUrl,
    ...(snippet ? { snippet } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(lastUpdated ? { lastUpdated } : {}),
    sourceType: perplexityMeta.resultId != null ? 'search' : 'web',
    originLabel: 'Perplexity Web Search'
  }
}

function extractPerplexityCostMetadata(
  rawProviderMetadata: unknown
): ProviderCostMetadata | undefined {
  if (!rawProviderMetadata || typeof rawProviderMetadata !== 'object') {
    return undefined
  }
  const pplx = (rawProviderMetadata as { perplexity?: unknown }).perplexity
  if (!pplx || typeof pplx !== 'object') {
    return undefined
  }
  const cost = (pplx as { cost?: unknown }).cost
  if (!cost || typeof cost !== 'object') {
    return undefined
  }
  const c = cost as Record<string, unknown>
  const normalizeNum = (val: unknown): number | null | undefined => {
    if (val === null) return null
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : undefined
  }
  const inputTokensCost = normalizeNum(c.inputTokensCost)
  const outputTokensCost = normalizeNum(c.outputTokensCost)
  const totalCost = normalizeNum(c.totalCost)
  const toolCallsCost = normalizeNum(c.toolCallsCost)
  const currency =
    typeof c.currency === 'string' && c.currency.trim().length > 0
      ? c.currency.trim().slice(0, 16)
      : c.currency === null
        ? null
        : undefined

  if (
    inputTokensCost === undefined &&
    outputTokensCost === undefined &&
    totalCost === undefined &&
    toolCallsCost === undefined &&
    currency === undefined
  ) {
    return undefined
  }

  return {
    ...(inputTokensCost !== undefined ? { inputTokensCost } : {}),
    ...(outputTokensCost !== undefined ? { outputTokensCost } : {}),
    ...(totalCost !== undefined ? { totalCost } : {}),
    ...(toolCallsCost !== undefined ? { toolCallsCost } : {}),
    ...(currency !== undefined ? { currency } : {})
  }
}

/**
 * Production Perplexity Agent API adapter communicating directly over HTTPS (`https://api.perplexity.ai/v1/agent`)
 * via `@ai-sdk/perplexity`.
 *
 * Security & Grounding Invariants:
 * 1. Direct HTTPS connection to `api.perplexity.ai` only; zero AI Gateway or remote proxy.
 * 2. Requires explicit BYOK API key; never reads plaintext environment variables silently.
 * 3. Only approved `web_search` native tool may run in Chat mode; never enables `fetch_url`,
 *    `finance_search`, `people_search`, `sandbox`, `mcp`, or `connector`.
 * 4. Agent mode preserves local `ToolRegistry` isolation (disables Perplexity native server tools).
 * 5. External web results are mapped to isolated `webSources` DTOs, never KB `citations`.
 */
export class PerplexityAdapter implements ProviderAdapter {
  public readonly providerId = 'perplexity' as const

  private readonly baseURL: string
  private readonly fetchFn?: typeof fetch
  private readonly testTimeoutMs: number
  private readonly generationTimeoutMs: number
  private readonly enableNativeWebSearchInChat: boolean

  constructor(options: PerplexityAdapterOptions = {}) {
    this.baseURL = resolveVerifiedPerplexityBaseUrl(options.baseURL)
    this.fetchFn = options.fetch
    this.testTimeoutMs = options.testTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
    this.enableNativeWebSearchInChat = options.enableNativeWebSearchInChat ?? true
  }

  /**
   * Instantiates an AI SDK LanguageModel backed directly by `@ai-sdk/perplexity`.
   */
  public createLanguageModel(apiKey: string, modelId: string): LanguageModel {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Perplexity API key is required.',
        retryable: false
      })
    }

    const trimmedModelId = modelId.trim()
    if (!trimmedModelId) {
      throw new ProviderAdapterError({
        code: 'INVALID_REQUEST',
        message: 'Perplexity model or preset ID cannot be blank.',
        retryable: false
      })
    }

    const client = createPerplexity({
      apiKey: trimmedKey,
      baseURL: this.baseURL,
      ...(this.fetchFn ? { fetch: this.fetchFn } : {})
    })

    return client(trimmedModelId) as unknown as LanguageModel
  }

  /**
   * Executes a minimal, bounded Agent API check against `https://api.perplexity.ai/v1/agent`
   * with all native Perplexity tools disabled (`max_tool_calls: 0`) and minimal output tokens.
   */
  public async testConnection(
    apiKey: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    const testedModelId = modelId?.trim() || PERPLEXITY_DEFAULT_TEST_MODEL

    if (!apiKey || apiKey.trim().length === 0) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        testedModelId,
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Perplexity API key is missing or blank.',
          retryable: false
        }
      }
    }

    const { signal: combinedSignal, cleanup } = composeTimeoutAbortSignal(
      this.testTimeoutMs,
      signal
    )

    try {
      const languageModel = this.createLanguageModel(apiKey, testedModelId)
      await generateText({
        model: languageModel,
        prompt: 'Reply with OK.',
        maxOutputTokens: 16,
        abortSignal: combinedSignal,
        providerOptions: {
          perplexity: {
            store: false,
            max_tool_calls: 0
          }
        }
      })

      const catalogModels = getPerplexityCuratedCatalogModels()
      return {
        success: true,
        latencyMs: Date.now() - startedAt,
        testedModelId,
        availableModels: catalogModels.map((m) => m.id),
        discoveredModels: catalogModels
      }
    } catch (err) {
      const error = combinedSignal.aborted
        ? sanitizePerplexityError(combinedSignal.reason ?? err)
        : sanitizePerplexityError(err)

      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        testedModelId,
        error
      }
    } finally {
      cleanup()
    }
  }

  /**
   * Returns curated official Perplexity Agent API models and presets.
   * Perplexity's Agent API has no live account-filtered `/models` listing endpoint,
   * so entries are explicitly flagged as `metadataSource: 'catalog'`.
   */
  public async discoverAvailableModels(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const models = await this.discoverModelMetadata(apiKey, signal)
    return models.map((m) => m.id)
  }

  public async discoverModelMetadata(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>> {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Perplexity API key is missing or blank.',
        retryable: false
      })
    }
    if (signal?.aborted) {
      throw new ProviderAdapterError(sanitizePerplexityError(signal.reason))
    }
    return getPerplexityCuratedCatalogModels()
  }

  /**
   * Executes a non-streaming Perplexity Agent API request.
   */
  public async generateText(
    apiKey: string,
    options: GenerateTextOptions
  ): Promise<GenerateTextResult> {
    const {
      languageModel,
      system,
      messages,
      aiTools,
      temperature,
      perplexityProviderOptions,
      signal,
      cleanup
    } = this.prepareGenerationRequest(apiKey, options)

    try {
      const result = await generateText({
        model: languageModel,
        system,
        messages,
        tools: aiTools,
        temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: signal,
        providerOptions: perplexityProviderOptions
      })

      const usage: TokenUsage = {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens:
          result.usage.totalTokens ??
          (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
      }

      const toolCalls = mapToolCalls(result.toolCalls)
      const webSources = this.deduplicateSources(result.sources)
      const providerCost = extractPerplexityCostMetadata(result.providerMetadata)

      return {
        text: result.text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: this.mapFinishReason(result.finishReason),
        usage,
        ...(webSources.length > 0 ? { webSources } : {}),
        ...(providerCost ? { providerCost } : {})
      }
    } catch (err) {
      const normalized = signal.aborted
        ? sanitizePerplexityError(signal.reason ?? err)
        : sanitizePerplexityError(err)
      throw new ProviderAdapterError(normalized)
    } finally {
      cleanup()
    }
  }

  /**
   * Executes a streaming Perplexity Agent API generation turn.
   * Captures validated external HTTP/HTTPS URLs cleanly without mixing into KB citations,
   * and converts mid-stream `response.failed` / SSE errors into sanitized error chunks.
   */
  public async *streamText(
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    if (options.abortSignal?.aborted) {
      yield {
        type: 'error',
        error: sanitizePerplexityError(
          options.abortSignal.reason ??
            new DOMException('Perplexity request was cancelled.', 'AbortError')
        )
      }
      return
    }

    const {
      languageModel,
      system,
      messages,
      aiTools,
      temperature,
      perplexityProviderOptions,
      signal,
      cleanup
    } = this.prepareGenerationRequest(apiKey, options)

    let terminatedWithTerminalChunk = false
    let requestId: string | undefined
    const webSourcesByUrl = new Map<string, ProviderWebSource>()

    try {
      const result = streamText({
        model: languageModel,
        system,
        messages,
        tools: aiTools,
        temperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: signal,
        providerOptions: perplexityProviderOptions
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
        } else if (part.type === 'source') {
          const normalized = normalizeSdkSource(part)
          if (normalized && !webSourcesByUrl.has(normalized.url)) {
            webSourcesByUrl.set(normalized.url, normalized)
            yield { type: 'source', source: normalized }
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
            error: sanitizePerplexityError(
              signal.reason ?? new DOMException('Perplexity stream was aborted.', 'AbortError'),
              undefined,
              requestId
            )
          }
          return
        } else if (part.type === 'error') {
          terminatedWithTerminalChunk = true
          yield {
            type: 'error',
            error: sanitizePerplexityError(part.error, undefined, requestId)
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
              error: sanitizePerplexityError(
                new Error('Perplexity Agent API terminated stream with error.'),
                502,
                requestId
              )
            }
            return
          }

          let providerCost: ProviderCostMetadata | undefined
          try {
            const resolvedMeta =
              (part as { totalProviderMetadata?: unknown }).totalProviderMetadata ??
              (await result.providerMetadata)
            providerCost = extractPerplexityCostMetadata(resolvedMeta)
          } catch {
            // Cost metadata is optional
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

          const collectedSources = Array.from(webSourcesByUrl.values())
          yield {
            type: 'finish',
            finishReason: this.mapFinishReason(part.finishReason),
            usage,
            ...(collectedSources.length > 0 ? { webSources: collectedSources } : {}),
            ...(providerCost ? { providerCost } : {})
          }
          return
        }
      }

      if (!terminatedWithTerminalChunk) {
        if (signal.aborted) {
          yield {
            type: 'error',
            error: sanitizePerplexityError(signal.reason, undefined, requestId)
          }
        } else {
          const collectedSources = Array.from(webSourcesByUrl.values())
          yield {
            type: 'finish',
            finishReason: 'stop',
            ...(collectedSources.length > 0 ? { webSources: collectedSources } : {})
          }
        }
      }
    } catch (err) {
      if (!terminatedWithTerminalChunk) {
        const normalized = signal.aborted
          ? sanitizePerplexityError(signal.reason ?? err, undefined, requestId)
          : sanitizePerplexityError(err, undefined, requestId)
        yield {
          type: 'error',
          error: normalized
        }
      }
    } finally {
      cleanup()
    }
  }

  private deduplicateSources(rawSources: unknown): ProviderWebSource[] {
    if (!Array.isArray(rawSources)) {
      return []
    }
    const byUrl = new Map<string, ProviderWebSource>()
    for (const candidate of rawSources) {
      const normalized = normalizeSdkSource(candidate)
      if (normalized && !byUrl.has(normalized.url)) {
        byUrl.set(normalized.url, normalized)
      }
    }
    return Array.from(byUrl.values())
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
    perplexityProviderOptions: {
      perplexity: {
        store: boolean
        tools?: Array<{ type: 'web_search' }>
      }
    }
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

    const hasLocalAgentTools = Boolean(options.tools && options.tools.length > 0)
    const languageModel = this.createLanguageModel(apiKey, options.modelId)
    const { system, messages } = this.convertMessages(options)
    const aiTools = hasLocalAgentTools && options.tools ? mapToolsToAiSdk(options.tools) : undefined

    const temperature =
      typeof options.temperature === 'number' && Number.isFinite(options.temperature)
        ? Math.min(2, Math.max(0, options.temperature))
        : undefined

    // Enable ONLY approved `web_search` in Chat mode; keep Agent mode restricted to Local Bots ToolRegistry.
    const perplexityProviderOptions: {
      perplexity: {
        store: boolean
        tools?: Array<{ type: 'web_search' }>
      }
    } = {
      perplexity: {
        store: false,
        ...(!hasLocalAgentTools && this.enableNativeWebSearchInChat
          ? { tools: [{ type: 'web_search' }] }
          : {})
      }
    }

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
      perplexityProviderOptions,
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
