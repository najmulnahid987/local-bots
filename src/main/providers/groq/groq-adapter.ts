import { createGroq } from '@ai-sdk/groq'
import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { mapToolsToAiSdk, mapToolCalls } from '../../agents/ai-sdk-tool-mapper'
import { ProviderAdapterError, sanitizeGroqError } from './errors'
import { buildGroqModelDescriptorFromApi, isNonChatGroqModel } from './model-metadata'
import {
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  GROQ_DEFAULT_TEST_MODEL,
  GROQ_OFFICIAL_BASE_URL,
  type GroqAdapterOptions,
  type GroqApiModelEntry,
  type GroqModelsListResponse
} from './types'
import type {
  ConnectionTestResult,
  GenerateTextOptions,
  GenerateTextResult,
  ModelDescriptor,
  ProviderAdapter,
  StreamTextChunk,
  TokenUsage
} from '../types'

const GROQ_UNSUPPORTED_OPENAI_BODY_KEYS = [
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'store',
  'metadata',
  'n'
] as const

function resolveVerifiedGroqBaseUrl(rawBaseUrl?: string): string {
  const candidate = (rawBaseUrl ?? GROQ_OFFICIAL_BASE_URL).trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Invalid Groq API base URL configuration.',
      retryable: false
    })
  }

  if (parsed.protocol !== 'https:') {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Groq API base URL must use HTTPS.',
      retryable: false
    })
  }

  return parsed.toString().replace(/\/+$/, '')
}

function sanitizeOutgoingGroqChatBody(bodyText: string): string {
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return bodyText
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return bodyText
  }

  const record = payload as Record<string, unknown>

  for (const key of GROQ_UNSUPPORTED_OPENAI_BODY_KEYS) {
    if (key in record) {
      delete record[key]
    }
  }

  if (Array.isArray(record.messages)) {
    record.messages = record.messages.map((msg) => {
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'name' in msg) {
        const clone = { ...(msg as Record<string, unknown>) }
        delete clone.name
        return clone
      }
      return msg
    })
  }

  const hasTools = Array.isArray(record.tools) && record.tools.length > 0
  const hasJsonFormat = record.response_format !== undefined
  if (record.reasoning_format === 'raw' && (hasTools || hasJsonFormat)) {
    record.reasoning_format = 'parsed'
  }

  if (typeof record.temperature === 'number' && Number.isFinite(record.temperature)) {
    record.temperature = Math.min(2, Math.max(0, record.temperature))
  }

  return JSON.stringify(record)
}

function createGroqWireSafeFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (
      init &&
      typeof init.body === 'string' &&
      urlStr.toLowerCase().includes('/chat/completions')
    ) {
      const sanitizedBody = sanitizeOutgoingGroqChatBody(init.body)
      if (sanitizedBody !== init.body) {
        const nextHeaders = new Headers(init.headers)
        nextHeaders.delete('content-length')
        return baseFetch(input, {
          ...init,
          headers: nextHeaders,
          body: sanitizedBody
        })
      }
    }
    return baseFetch(input, init)
  }
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
      new DOMException(`Groq request timed out after ${timeoutMs}ms.`, 'TimeoutError')
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

/**
 * Production Groq provider adapter using direct HTTPS (`https://api.groq.com/openai/v1`)
 * and `@ai-sdk/groq`. Supports BYOK authentication, zero-token model discovery,
 * parameter sanitization, text generation, streaming, and tool calling.
 */
export class GroqAdapter implements ProviderAdapter {
  public readonly providerId = 'groq' as const

  private readonly baseURL: string
  private readonly rawFetchFn: typeof fetch
  private readonly safeFetchFn: typeof fetch
  private readonly connectionTestTimeoutMs: number
  private readonly generationTimeoutMs: number

  constructor(options: GroqAdapterOptions = {}) {
    this.baseURL = resolveVerifiedGroqBaseUrl(options.baseURL)
    this.rawFetchFn = options.fetchFn ?? globalThis.fetch
    this.safeFetchFn = createGroqWireSafeFetch(this.rawFetchFn)
    this.connectionTestTimeoutMs =
      options.connectionTestTimeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS
    this.generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
  }

  /**
   * Creates a wire-safe AI SDK LanguageModel instance for Groq.
   * Reused by both chat generation and bounded Agent step execution.
   */
  public createLanguageModel(apiKey: string, modelId: string): LanguageModel {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Groq API key is required.',
        retryable: false
      })
    }

    const trimmedModelId = modelId.trim()
    if (!trimmedModelId) {
      throw new ProviderAdapterError({
        code: 'INVALID_REQUEST',
        message: 'Groq model ID cannot be blank.',
        retryable: false
      })
    }

    const groqProvider = createGroq({
      apiKey: trimmedKey,
      baseURL: this.baseURL,
      fetch: this.safeFetchFn
    })

    return groqProvider.languageModel(trimmedModelId) as unknown as LanguageModel
  }

  /**
   * Verifies the Groq API key via `GET /openai/v1/models` (zero paid completion tokens)
   * and returns discovered active chat models with metadata.
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
        testedModelId: trimmedModelId || GROQ_DEFAULT_TEST_MODEL,
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Groq API key is missing or blank.',
          retryable: false
        }
      }
    }

    try {
      const { allEntries, chatDescriptors } = await this.fetchModelsFromApi(apiKey.trim(), signal)
      const availableModels = chatDescriptors.map((m) => m.id)

      if (trimmedModelId) {
        const matchedRaw = allEntries.find((entry) => entry.id === trimmedModelId)
        if (!matchedRaw || matchedRaw.active === false) {
          return {
            success: false,
            latencyMs: Date.now() - startedAt,
            testedModelId: trimmedModelId,
            error: {
              code: 'MODEL_NOT_FOUND',
              message: `Requested Groq model '${trimmedModelId}' is unavailable or inactive for this key.`,
              statusCode: 404,
              retryable: false
            }
          }
        }
      }

      const chosenModelId =
        trimmedModelId ||
        (availableModels.includes(GROQ_DEFAULT_TEST_MODEL)
          ? GROQ_DEFAULT_TEST_MODEL
          : (availableModels[0] ?? GROQ_DEFAULT_TEST_MODEL))

      return {
        success: true,
        latencyMs: Date.now() - startedAt,
        testedModelId: chosenModelId,
        availableModels,
        discoveredModels: chatDescriptors
      }
    } catch (err) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        testedModelId: trimmedModelId || GROQ_DEFAULT_TEST_MODEL,
        error: sanitizeGroqError(err)
      }
    }
  }

  /**
   * Lists active chat model IDs accessible with the provided Groq API key.
   */
  public async discoverAvailableModels(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const descriptors = await this.discoverModelMetadata(apiKey, signal)
    return descriptors.map((d) => d.id)
  }

  /**
   * Lists active Groq chat models along with verified/conservative ModelDescriptors.
   */
  public async discoverModelMetadata(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>> {
    try {
      const { chatDescriptors } = await this.fetchModelsFromApi(apiKey, signal)
      return chatDescriptors
    } catch (err) {
      throw new ProviderAdapterError(sanitizeGroqError(err))
    }
  }

  /**
   * Executes a non-streaming text generation request against Groq.
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
      throw new ProviderAdapterError(sanitizeGroqError(err))
    } finally {
      cleanup()
    }
  }

  /**
   * Executes a streaming text generation request against Groq, yielding normalized chunks.
   */
  public async *streamText(
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    if (options.abortSignal?.aborted) {
      yield {
        type: 'error',
        error: sanitizeGroqError(
          options.abortSignal.reason ??
            new DOMException('Groq request was cancelled.', 'AbortError')
        )
      }
      return
    }

    const { languageModel, system, messages, aiTools, temperature, signal, cleanup } =
      this.prepareGenerationRequest(apiKey, options)

    let terminatedWithTerminalChunk = false

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
        } else if (part.type === 'abort') {
          terminatedWithTerminalChunk = true
          yield {
            type: 'error',
            error: sanitizeGroqError(
              signal.reason ?? new DOMException('Groq stream was aborted.', 'AbortError')
            )
          }
          return
        } else if (part.type === 'error') {
          terminatedWithTerminalChunk = true
          yield { type: 'error', error: sanitizeGroqError(part.error) }
          return
        } else if (part.type === 'finish') {
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
        }
      }

      if (!terminatedWithTerminalChunk && signal.aborted) {
        yield {
          type: 'error',
          error: sanitizeGroqError(
            signal.reason ?? new DOMException('Groq stream was cancelled.', 'AbortError')
          )
        }
      }
    } catch (err) {
      yield { type: 'error', error: sanitizeGroqError(err) }
    } finally {
      cleanup()
    }
  }

  private async fetchModelsFromApi(
    apiKey: string,
    callerSignal?: AbortSignal
  ): Promise<{
    allEntries: readonly GroqApiModelEntry[]
    chatDescriptors: readonly ModelDescriptor[]
  }> {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      throw new ProviderAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Groq API key is missing or blank.',
        retryable: false
      })
    }

    const { signal, cleanup } = composeTimeoutAbortSignal(
      this.connectionTestTimeoutMs,
      callerSignal
    )

    try {
      const response = await this.rawFetchFn(`${this.baseURL}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          Accept: 'application/json'
        },
        signal
      })

      if (!response.ok) {
        let responseBody = ''
        try {
          responseBody = await response.text()
        } catch {
          responseBody = ''
        }
        throw {
          statusCode: response.status,
          message: `Groq models discovery failed with HTTP ${response.status}.`,
          responseBody
        }
      }

      const payload = (await response.json()) as GroqModelsListResponse
      const rawEntries = Array.isArray(payload?.data) ? payload.data : []

      const seen = new Set<string>()
      const chatDescriptors: ModelDescriptor[] = []

      for (const entry of rawEntries) {
        if (!entry || typeof entry.id !== 'string') continue
        const cleanId = entry.id.trim()
        if (!cleanId || seen.has(cleanId)) continue
        seen.add(cleanId)

        if (entry.active === false) continue
        if (isNonChatGroqModel(cleanId)) continue

        chatDescriptors.push(buildGroqModelDescriptorFromApi({ ...entry, id: cleanId }))
      }

      return {
        allEntries: rawEntries,
        chatDescriptors
      }
    } finally {
      cleanup()
    }
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
        message: 'Structured jsonSchema mode is not enabled on this endpoint.',
        retryable: false
      })
    }

    const languageModel = this.createLanguageModel(apiKey, options.modelId)
    const { system, messages } = this.convertMessages(options)
    const aiTools =
      options.tools && options.tools.length > 0 ? mapToolsToAiSdk(options.tools) : undefined

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

  /**
   * Normalizes unified ChatMessage history into Groq OpenAI-compatible AI SDK ModelMessages.
   * Deliberately omits `messages[].name` (not supported on Groq).
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
    switch (reason) {
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
