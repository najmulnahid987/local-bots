import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenRouterAdapter, buildValidatedOpenRouterRouting } from './openrouter-adapter'
import { ProviderAdapterError, sanitizeOpenRouterError, redactOpenRouterSecrets } from './errors'
import { OPENROUTER_OFFICIAL_BASE_URL, OPENROUTER_DEFAULT_TEST_MODEL } from './types'
import {
  formatOpenRouterPerMillionUsd,
  parseOpenRouterModelEntry,
  parseOpenRouterModelsResponse
} from './model-metadata'
import { sanitizeErrorMessage } from '../provider-manager/errors'
import { DiagnosticSanitizer } from '../../services/diagnostic-sanitizer'
import { defaultSecretScanner } from '../../services/secret-scanner'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'
import type { StreamTextChunk } from '../types'

describe('OpenRouterAdapter & Metadata Safety (Phase 13 Step 13.3)', () => {
  const dummyApiKey = 'sk-or-v1-test_openrouter_secret_key_1234567890abcdefghijklmnop'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const makeAuthKeyResponse = (): Response =>
    new Response(
      JSON.stringify({
        data: {
          label: 'Local Bots Key',
          usage: 0.12,
          limit: 10,
          is_free_tier: false
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )

  const makeUserModelsResponse = (): Response =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'anthropic/claude-3.7-sonnet:thinking',
            canonical_slug: 'anthropic/claude-3.7-sonnet',
            name: 'Anthropic: Claude 3.7 Sonnet (thinking)',
            description: 'Flagship Claude reasoning model routed via OpenRouter.',
            context_length: 200000,
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text']
            },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015'
            },
            top_provider: {
              context_length: 200000,
              max_completion_tokens: 64000
            },
            supported_parameters: ['tools', 'structured_outputs', 'reasoning']
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct:free',
            name: 'Meta: Llama 3.3 70B Instruct (free)',
            context_length: 131072,
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            top_provider: {
              context_length: 131072,
              max_completion_tokens: null
            },
            // Intentionally omits 'tools' to prove tools capability is NEVER inferred from name
            supported_parameters: ['temperature', 'max_tokens']
          },
          {
            id: 'black-forest-labs/flux-1.1-pro',
            name: 'FLUX 1.1 Pro (Image Gen)',
            context_length: 4096,
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['image']
            }
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )

  it('1. enforces official HTTPS base URL and rejects non-HTTPS or invalid URLs', () => {
    const adapter = new OpenRouterAdapter()
    expect(adapter.providerId).toBe('openrouter')
    expect(OPENROUTER_OFFICIAL_BASE_URL).toBe('https://openrouter.ai/api/v1')

    expect(() => new OpenRouterAdapter({ baseURL: 'http://openrouter.ai/api/v1' })).toThrow(
      ProviderAdapterError
    )
    expect(() => new OpenRouterAdapter({ baseURL: 'invalid-url' })).toThrow(ProviderAdapterError)
  })

  it('2. testConnection authenticates with zero token spend via /auth/key + /models/user and preserves exact model IDs', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/auth/key')) return makeAuthKeyResponse()
      if (target.endsWith('/models/user')) return makeUserModelsResponse()
      throw new Error(`Unexpected request to ${target}`)
    })

    const adapter = new OpenRouterAdapter({ fetchFn: fetchMock })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(true)
    expect(result.availableModels).toEqual([
      'anthropic/claude-3.7-sonnet:thinking',
      'meta-llama/llama-3.3-70b-instruct:free'
    ])
    // Non-text image generation models are excluded cleanly
    expect(result.availableModels).not.toContain('black-forest-labs/flux-1.1-pro')
    expect(result.discoveredModels).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('3. handles 401 auth failure, 402 payment/credits failure, 403 without public fallback, and malformed payloads safely', async () => {
    // Blank key
    const blankRes = await new OpenRouterAdapter({ fetchFn: vi.fn() }).testConnection('  ')
    expect(blankRes.success).toBe(false)
    expect(blankRes.error?.code).toBe('AUTHENTICATION_FAILED')

    // 402 Insufficient Credits
    const fetch402 = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 402,
            message: 'Insufficient credits. This account never purchased credits.'
          }
        }),
        { status: 402, headers: { 'content-type': 'application/json' } }
      )
    )
    const res402 = await new OpenRouterAdapter({ fetchFn: fetch402 }).testConnection(dummyApiKey)
    expect(res402.success).toBe(false)
    expect(res402.error?.code).toBe('QUOTA_EXCEEDED')
    expect(res402.error?.statusCode).toBe(402)

    // 403 on /models/user must NEVER fall back silently to public /models
    const fetch403User = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/auth/key')) return makeAuthKeyResponse()
      if (target.endsWith('/models/user')) {
        return new Response(
          JSON.stringify({ error: { code: 403, message: 'Guardrail policy restriction' } }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`Must not fall back to ${target}`)
    })
    const res403 = await new OpenRouterAdapter({ fetchFn: fetch403User }).testConnection(
      dummyApiKey
    )
    expect(res403.success).toBe(false)
    expect(res403.error?.code).toBe('PERMISSION_DENIED')

    // Malformed /models response rejected
    expect(() => parseOpenRouterModelsResponse({ invalid: true }, 'user_models')).toThrow(
      ProviderAdapterError
    )
    expect(() => parseOpenRouterModelEntry({ id: '../evil/path?x=1' }, 'user_models')).toThrow(
      ProviderAdapterError
    )
  })

  it('4. maps supported_parameters, modalities, context windows, and exact pricing without guessing tools from name', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeUserModelsResponse())
    const adapter = new OpenRouterAdapter({ fetchFn: fetchMock })
    const models = await adapter.discoverModelMetadata(dummyApiKey)

    const claude = models.find((m) => m.id === 'anthropic/claude-3.7-sonnet:thinking')
    expect(claude).toBeDefined()
    expect(claude?.providerCapabilities).toEqual({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    })
    expect(claude?.contextWindow).toEqual({ inputTokens: 200000, outputTokens: 64000 })
    expect(claude?.pricing).toEqual({
      promptPerTokenUsd: '0.000003',
      completionPerTokenUsd: '0.000015',
      isFree: false
    })
    expect(claude?.metadataSource).toBe('user_models')

    // Model without 'tools' in supported_parameters keeps tools: false regardless of model name
    const llamaFree = models.find((m) => m.id === 'meta-llama/llama-3.3-70b-instruct:free')
    expect(llamaFree?.providerCapabilities?.tools).toBe(false)
    expect(llamaFree?.providerCapabilities?.imageInput).toBe(false)
    expect(llamaFree?.providerCapabilities?.structuredOutput).toBe(false)
    expect(llamaFree?.pricing?.isFree).toBe(true)
    expect(llamaFree?.contextWindow).toEqual({ inputTokens: 131072, outputTokens: 16384 })

    // Precision-safe decimal pricing formatting (no float drift)
    expect(formatOpenRouterPerMillionUsd('0')).toBe('Free')
    expect(formatOpenRouterPerMillionUsd('0.0000003')).toBe('$0.30/1M'.replace('/1M', ' / 1M'))
    expect(formatOpenRouterPerMillionUsd('0.0000025')).toBe('$2.50 / 1M')
    expect(formatOpenRouterPerMillionUsd('-1')).toBe('Variable')
    expect(formatOpenRouterPerMillionUsd(undefined)).toBe('Unknown')

    // Public catalog fetch marks public_catalog explicitly
    const publicAdapter = new OpenRouterAdapter({
      fetchFn: vi.fn().mockImplementation(async () => makeUserModelsResponse())
    })
    const publicModels = await publicAdapter.fetchPublicCatalogModels()
    expect(publicModels[0].metadataSource).toBe('public_catalog')
  })

  it('5. preserves default routing when unconfigured, serializes validated sort options, and rejects invalid routing', async () => {
    expect(buildValidatedOpenRouterRouting(undefined)).toBeUndefined()
    expect(buildValidatedOpenRouterRouting({ sort: 'default' })).toBeUndefined()
    expect(buildValidatedOpenRouterRouting({ sort: 'price' })).toEqual({ sort: 'price' })
    expect(buildValidatedOpenRouterRouting({ sort: 'latency' })).toEqual({ sort: 'latency' })
    expect(buildValidatedOpenRouterRouting({ sort: 'throughput' })).toEqual({ sort: 'throughput' })

    expect(() =>
      buildValidatedOpenRouterRouting({ sort: 'fastest_hack' as unknown as 'price' })
    ).toThrow(ProviderAdapterError)
    expect(() =>
      buildValidatedOpenRouterRouting({ only: ['evil-provider'] } as unknown as { sort: 'price' })
    ).toThrow(ProviderAdapterError)

    let capturedBody: Record<string, unknown> | undefined
    const capturedHeaders: Record<string, string> = {}

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>
      }
      if (init?.headers) {
        const h = new Headers(init.headers)
        h.forEach((v, k) => {
          capturedHeaders[k.toLowerCase()] = v
        })
      }
      return new Response(
        JSON.stringify({
          id: 'gen-openrouter-1',
          model: 'anthropic/claude-3.7-sonnet:thinking',
          provider: 'Anthropic',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Multiline 🌍\nUnicode answer.' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const adapter = new OpenRouterAdapter({ fetchFn: fetchMock })
    const res = await adapter.generateText(dummyApiKey, {
      modelId: 'anthropic/claude-3.7-sonnet:thinking',
      systemPrompt: 'Follow instructions.',
      openrouterRouting: { sort: 'latency' },
      messages: [{ role: 'user', content: 'Hi 🌍' }]
    })

    expect(res.text).toBe('Multiline 🌍\nUnicode answer.')
    expect(res.finishReason).toBe('stop')
    expect(res.usage).toEqual({ promptTokens: 18, completionTokens: 9, totalTokens: 27 })
    expect(capturedBody?.provider).toEqual({ sort: 'latency' })
    expect(capturedHeaders['http-referer']).toBeUndefined()
  })

  it('6. surfaces HTTP 200 mid-stream SSE error events as failures and suppresses false finish events', async () => {
    const encoder = new TextEncoder()
    const midStreamErrorSse =
      `data: ${JSON.stringify({
        id: 'gen-stream-err-99',
        model: 'openai/gpt-4o',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Partial start ' }, finish_reason: null }
        ]
      })}\n\n` +
      `data: ${JSON.stringify({
        id: 'gen-stream-err-99',
        error: {
          code: 502,
          message: 'Provider returned error',
          metadata: { provider_name: 'DeepInfra', raw: `Bearer ${dummyApiKey}` }
        }
      })}\n\n` +
      'data: [DONE]\n\n'

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(midStreamErrorSse))
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )

    const adapter = new OpenRouterAdapter({ fetchFn: fetchMock })
    const chunks: StreamTextChunk[] = []
    for await (const chunk of adapter.executeStream(dummyApiKey, {
      modelId: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Stream until mid-stream error' }]
    })) {
      chunks.push(chunk)
    }

    expect(chunks.some((c) => c.type === 'text-delta' && c.textDelta === 'Partial start ')).toBe(
      true
    )
    expect(chunks.some((c) => c.type === 'finish')).toBe(false)
    const errChunk = chunks.find((c) => c.type === 'error')
    expect(errChunk).toBeDefined()
    if (errChunk?.type === 'error') {
      expect(errChunk.error.code).toBe('SERVER_ERROR')
      expect(errChunk.error.message).not.toContain(dummyApiKey)
      expect(errChunk.error.details ?? '').not.toContain(dummyApiKey)
    }
  })

  it('7. supports progressive streaming, AbortSignal cancellation, and rejects incomplete streams without completion', async () => {
    const encoder = new TextEncoder()
    const validSse =
      `data: ${JSON.stringify({
        id: 'gen-ok-1',
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Chunk 1 ' }, finish_reason: null }
        ]
      })}\n\n` +
      `data: ${JSON.stringify({
        id: 'gen-ok-1',
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        choices: [{ index: 0, delta: { content: 'Chunk 2' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 }
      })}\n\n` +
      'data: [DONE]\n\n'

    const okAdapter = new OpenRouterAdapter({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(validSse))
              c.close()
            }
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    })

    const chunks: StreamTextChunk[] = []
    for await (const chunk of okAdapter.streamText(dummyApiKey, {
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
      messages: [{ role: 'user', content: 'Hi' }]
    })) {
      chunks.push(chunk)
    }
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.textDelta)
        .join('')
    ).toBe('Chunk 1 Chunk 2')
    expect(chunks.some((c) => c.type === 'finish' && c.finishReason === 'stop')).toBe(true)

    // Pre-aborted signal yields OPERATION_ABORTED cleanly
    const abortCtrl = new AbortController()
    abortCtrl.abort(new DOMException('Stopped by user', 'AbortError'))
    const abortChunks: StreamTextChunk[] = []
    for await (const chunk of new OpenRouterAdapter({ fetchFn: vi.fn() }).streamText(dummyApiKey, {
      modelId: OPENROUTER_DEFAULT_TEST_MODEL,
      messages: [{ role: 'user', content: 'Abort' }],
      abortSignal: abortCtrl.signal
    })) {
      abortChunks.push(chunk)
    }
    expect(abortChunks).toHaveLength(1)
    expect(abortChunks[0]).toMatchObject({
      type: 'error',
      error: { code: 'OPERATION_ABORTED', retryable: false }
    })
  })

  it('8. classifies OpenRouter errors with Retry-After support and redacts sk-or-v1 keys across every sanitizer', () => {
    expect(
      sanitizeOpenRouterError({ statusCode: 401, message: 'No auth credentials found' }).code
    ).toBe('AUTHENTICATION_FAILED')
    expect(sanitizeOpenRouterError({ statusCode: 402, message: 'Insufficient credits' }).code).toBe(
      'QUOTA_EXCEEDED'
    )
    expect(
      sanitizeOpenRouterError({ statusCode: 404, message: 'No endpoints found for missing/model' })
        .code
    ).toBe('MODEL_NOT_FOUND')
    expect(
      sanitizeOpenRouterError({ statusCode: 413, message: 'context_length_exceeded' }).code
    ).toBe('CONTEXT_LENGTH_EXCEEDED')

    const rateErr = sanitizeOpenRouterError({
      statusCode: 429,
      message: 'Too many requests',
      headers: { 'retry-after': '12' }
    })
    expect(rateErr.code).toBe('RATE_LIMITED')
    expect(rateErr.retryable).toBe(true)
    expect(rateErr.message).toContain('12s')

    expect(
      sanitizeOpenRouterError({ statusCode: 503, message: 'No available provider' }).code
    ).toBe('SERVER_ERROR')

    const leaky = `OpenRouter error with Bearer ${dummyApiKey} and request gen-xyz-1`
    expect(redactOpenRouterSecrets(leaky)).not.toContain(dummyApiKey)
    expect(sanitizeErrorMessage(leaky)).not.toContain(dummyApiKey)
    expect(DiagnosticSanitizer.sanitize(leaky)).not.toContain(dummyApiKey)
    expect(defaultSecretScanner.scanText(leaky)).toEqual({
      hasSecret: true,
      patternName: 'OpenRouter API Key'
    })

    for (const entry of defaultErrorRingBuffer.getRecentErrors()) {
      expect(entry.sanitizedMessage).not.toContain(dummyApiKey)
    }
  })
})
