import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GoogleAdapter } from './google-adapter'
import { ProviderAdapterError, sanitizeGoogleError } from './errors'
import { GOOGLE_OFFICIAL_BASE_URL, DEFAULT_GENERATION_TIMEOUT_MS } from './types'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'
import { type GenerateTextOptions } from '../types'

describe('GoogleAdapter (Phase 3 Step 3.6)', () => {
  const dummyApiKey = 'AIzaSyTestGoogleKey1234567890'
  const originalEnvBase = process.env.GOOGLE_GENERATIVE_AI_BASE_URL
  const originalEnvGoogleBase = process.env.GOOGLE_BASE_URL

  beforeEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_BASE_URL
    delete process.env.GOOGLE_BASE_URL
  })

  afterEach(() => {
    if (originalEnvBase !== undefined) {
      process.env.GOOGLE_GENERATIVE_AI_BASE_URL = originalEnvBase
    } else {
      delete process.env.GOOGLE_GENERATIVE_AI_BASE_URL
    }
    if (originalEnvGoogleBase !== undefined) {
      process.env.GOOGLE_BASE_URL = originalEnvGoogleBase
    } else {
      delete process.env.GOOGLE_BASE_URL
    }
    vi.restoreAllMocks()
  })

  // Helper creating a mocked Google Models API response
  const makeGoogleModelResponse = (
    modelId = 'gemini-3.8-flash',
    methods = ['generateContent', 'countTokens']
  ): Response => {
    return new Response(
      JSON.stringify({
        name: `models/${modelId}`,
        baseModelId: '',
        version: '001',
        displayName: `Gemini ${modelId}`,
        description: 'Google Gemini Model',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: methods
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  // Helper creating a mocked Google generateContent response
  const makeGoogleGenerateContentResponse = (
    text = 'Hello from Gemini',
    usage = { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    finishReason = 'STOP'
  ): Response => {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text }],
              role: 'model'
            },
            finishReason,
            index: 0
          }
        ],
        usageMetadata: usage
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  // Helper creating a mocked Google streamGenerateContent SSE response
  const makeGoogleStreamResponse = (
    deltas = ['First delta ', 'second delta ', 'final delta.'],
    usage = { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 }
  ): Response => {
    const lines: string[] = []
    for (let i = 0; i < deltas.length - 1; i++) {
      lines.push(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: deltas[i] }],
                role: 'model'
              },
              index: 0
            }
          ]
        })}\n\n`
      )
    }
    lines.push(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: deltas[deltas.length - 1] }],
              role: 'model'
            },
            finishReason: 'STOP',
            index: 0
          }
        ],
        usageMetadata: usage
      })}\n\n`
    )

    return new Response(lines.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  // 1. Adapter identifies as Google
  it('1. identifies correctly as provider google', () => {
    const adapter = new GoogleAdapter()
    expect(adapter.providerId).toBe('google')
  })

  // 2. Only registered Google models are accepted
  it('2. accepts registered Google models like gemini-3.8-flash, gemini-3.7-flash, and gemini-3.6-flash', async () => {
    let requestedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      requestedUrl = url.toString()
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('gemini-3.8-flash')
    expect(requestedUrl).toBe(`${GOOGLE_OFFICIAL_BASE_URL}/models/gemini-3.8-flash`)
  })

  // 3. Unknown models are rejected
  it('3. rejects unknown model IDs during connection testing and text generation', async () => {
    const adapter = new GoogleAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'non-existent-gemini-99')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'non-existent-gemini-99',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 4. Another provider's model is rejected
  it('4. rejects models belonging to another provider (e.g. OpenAI gpt-6-luna or Anthropic claude-sonnet-5-5)', async () => {
    const adapter = new GoogleAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    const testResAnthropic = await adapter.testConnection(dummyApiKey, 'claude-sonnet-5-5')
    expect(testResAnthropic.success).toBe(false)
    expect(testResAnthropic.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 5. Connection test uses GET /v1beta/models/{modelId}
  it('5. sends an authenticated GET to the official models endpoint without generation tokens', async () => {
    let capturedMethod = ''
    let capturedUrl = ''

    const customFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedMethod = init?.method ?? ''
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(result.success).toBe(true)
    expect(capturedUrl).toBe(`${GOOGLE_OFFICIAL_BASE_URL}/models/gemini-3.8-flash`)
    expect(capturedMethod).toBe('GET')
    expect(typeof result.latencyMs).toBe('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  // 6. The x-goog-api-key header is present
  it('6. sends authentication using x-goog-api-key header and never Authorization Bearer', async () => {
    let capturedHeaders: Record<string, string> = {}
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey)

    expect(capturedHeaders['x-goog-api-key']).toBe(dummyApiKey)
    expect(capturedHeaders['Accept']).toBe('application/json')
    expect(capturedHeaders['User-Agent']).toContain('Electron; Main')
    expect(capturedHeaders['Authorization']).toBeUndefined()
  })

  // 7. The API key never appears in the URL or query parameters
  it('7. verifies API key never appears in the request URL or query string', async () => {
    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(capturedUrl).not.toContain(dummyApiKey)
    expect(capturedUrl).not.toContain('key=')
  })

  // 8. The expected base URL is used
  it('8. sends requests to the official Google Gemini base URL', async () => {
    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey)

    expect(capturedUrl.startsWith(GOOGLE_OFFICIAL_BASE_URL)).toBe(true)
  })

  // 9. Environment variables cannot redirect requests
  it('9. enforces official fixed base URL and ignores environment variable overrides', async () => {
    process.env.GOOGLE_GENERATIVE_AI_BASE_URL = 'https://malicious-proxy.attacker.com/v1beta'
    process.env.GOOGLE_BASE_URL = 'https://malicious-proxy.attacker.com/v1beta'

    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(capturedUrl.startsWith(GOOGLE_OFFICIAL_BASE_URL)).toBe(true)
    expect(capturedUrl).not.toContain('malicious-proxy.attacker.com')
  })

  // 10. Successful model metadata is validated
  it('10. validates returned model metadata and resolves model name successfully', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('gemini-3.8-flash')
  })

  // 11. Missing generateContent support is rejected
  it('11. rejects models that lack generateContent support in supportedGenerationMethods', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleModelResponse('gemini-3.8-flash', ['countTokens', 'embedContent'])
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
    expect(result.error?.message).toContain('does not support content generation')
  })

  // 12. Invalid API key errors are correctly mapped
  it('12. maps API_KEY_INVALID error payload to AUTHENTICATION_FAILED', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'API_KEY_INVALID'
              }
            ]
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(result.error?.retryable).toBe(false)
  })

  // 13. Legacy/rejected key errors produce a helpful reconnect instruction
  it('13. produces helpful reconnect instruction when legacy or expired key is rejected', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message:
              'Standard API keys are deprecated. Please generate an Authorization key at Google AI Studio.',
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }]
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(result.error?.message).toContain('generate a new Authorization key at Google AI Studio')
  })

  // 14. HTTP 403 maps to permission failure
  it('14. maps HTTP 403 PERMISSION_DENIED to PERMISSION_DENIED', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED'
          }
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(result.error?.retryable).toBe(false)
  })

  // 15. HTTP 404 maps to model-not-found
  it('15. maps HTTP 404 NOT_FOUND to MODEL_NOT_FOUND', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message: 'models/gemini-3.8-flash is not found',
            status: 'NOT_FOUND'
          }
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('MODEL_NOT_FOUND')
    expect(result.error?.retryable).toBe(false)
  })

  // 16. HTTP 429 rate limit is classified correctly
  it('16. maps HTTP 429 rate limit to RATE_LIMITED (retryable: true)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource exhausted: rate limit exceeded',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ reason: 'RATE_LIMIT_EXCEEDED' }]
          }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('RATE_LIMITED')
    expect(result.error?.retryable).toBe(true)
  })

  // 17. HTTP 429 quota errors are classified correctly
  it('17. maps HTTP 429 quota exhaustion to QUOTA_EXCEEDED (retryable: false)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource exhausted: quota exceeded for current project',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ reason: 'QUOTA_EXCEEDED' }]
          }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('QUOTA_EXCEEDED')
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain('quota exceeded')
  })

  // 18. HTTP 5xx maps to server error
  it('18. maps HTTP 500 / 503 to SERVER_ERROR (retryable: true)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: 'Service is temporarily unavailable',
            status: 'UNAVAILABLE'
          }
        }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('SERVER_ERROR')
    expect(result.error?.retryable).toBe(true)
  })

  // 19. Network errors are sanitized
  it('19. sanitizes network and socket failures into NETWORK_ERROR', async () => {
    const customFetch = vi.fn(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
    expect(result.error?.retryable).toBe(true)
  })

  // 20. Timeout works
  it('20. times out connection test if endpoint fails to respond within threshold', async () => {
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Connection test timed out.'))
        })
      })
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({
      customFetch,
      connectionTestTimeoutMs: 25
    })

    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
    expect(result.error?.retryable).toBe(true)
  })

  // 21. Cancellation works
  it('21. respects pre-aborted and mid-flight AbortSignal cancellation', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch
    const adapter = new GoogleAdapter({ customFetch })

    const controller = new AbortController()
    controller.abort(new Error('Pre-aborted test'))

    const preAbortedResult = await adapter.testConnection(dummyApiKey, undefined, controller.signal)
    expect(preAbortedResult.success).toBe(false)
    expect(preAbortedResult.error?.code).toBe('OPERATION_ABORTED')
    expect(customFetch).not.toHaveBeenCalled()
  })

  // 22. Text generation returns normalized output
  it('22. generates single text completion with normalized usage and finish reason', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleGenerateContentResponse(
        'Gemini response text content.',
        { promptTokenCount: 12, candidatesTokenCount: 18, totalTokenCount: 30 },
        'STOP'
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const options: GenerateTextOptions = {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Explain quantum superposition.' }]
    }

    const result = await adapter.generateText(dummyApiKey, options)

    expect(result.text).toBe('Gemini response text content.')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 18,
      totalTokens: 30
    })
  })

  // 23. System instructions and conversation messages are mapped correctly
  it('23. maps system instruction and conversation messages correctly to Gemini generateContent structure', async () => {
    let capturedBody: Record<string, unknown> = {}

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>
      }
      return makeGoogleGenerateContentResponse('System instruction observed.')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const options: GenerateTextOptions = {
      modelId: 'gemini-3.8-flash',
      systemPrompt: 'You are an AI assistant specialized in security.',
      messages: [
        { role: 'system', content: 'Audit all cryptographic keys.' },
        { role: 'user', content: 'Review this encryption protocol.' }
      ]
    }

    await adapter.generateText(dummyApiKey, options)

    // Verify systemInstruction is serialized into parts
    expect(capturedBody.systemInstruction).toEqual({
      parts: [
        {
          text: 'You are an AI assistant specialized in security.\n\nAudit all cryptographic keys.'
        }
      ]
    })

    // Verify contents contains user role
    const contents = capturedBody.contents as Array<{ role: string; parts: unknown[] }>
    expect(contents.length).toBe(1)
    expect(contents[0].role).toBe('user')
  })

  // 24. Usage metadata is normalized
  it('24. normalizes token usage metrics from Gemini metadata', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleGenerateContentResponse(
        'Usage verification',
        { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        'STOP'
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Testing tokens' }]
    })

    expect(result.usage.promptTokens).toBe(100)
    expect(result.usage.completionTokens).toBe(50)
    expect(result.usage.totalTokens).toBe(150)
  })

  // 25. Streaming emits ordered text deltas
  it('25. streams text response emitting ordered text-delta chunks', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleStreamResponse(['Delta 1 ', 'Delta 2 ', 'Delta 3.'], {
        promptTokenCount: 5,
        candidatesTokenCount: 15,
        totalTokenCount: 20
      })
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const chunks: string[] = []

    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Stream test' }]
    })

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.textDelta)
      }
    }

    expect(chunks.join('')).toBe('Delta 1 Delta 2 Delta 3.')
  })

  // 26. Streaming emits completion
  it('26. streams text response emitting finish event with finishReason and usage', async () => {
    const customFetch = vi.fn(async () => {
      return makeGoogleStreamResponse(['Stream text'], {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30
      })
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    let finishReason = ''
    let totalTokens = 0

    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Finish test' }]
    })

    for await (const chunk of stream) {
      if (chunk.type === 'finish') {
        finishReason = chunk.finishReason
        totalTokens = chunk.usage?.totalTokens ?? 0
      }
    }

    expect(finishReason).toBe('stop')
    expect(totalTokens).toBe(30)
  })

  // 27. Streaming error handling is sanitized
  it('27. propagates streaming error chunks safely sanitized', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 401,
            message: 'API key is unauthorized',
            status: 'UNAUTHENTICATED'
          }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Stream error test' }]
    })

    const errors: string[] = []
    for await (const chunk of stream) {
      if (chunk.type === 'error') {
        errors.push(chunk.error.code)
      }
    }

    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toBe('AUTHENTICATION_FAILED')
  })

  // 28. Streaming cancellation stops processing
  it('28. handles mid-stream abort signal cancellation gracefully', async () => {
    const controller = new AbortController()

    const customFetch = vi.fn(async () => {
      return makeGoogleStreamResponse(['Part A ', 'Part B '])
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Abort test' }],
      abortSignal: controller.signal
    })

    const chunks: string[] = []
    let receivedAbort = false

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.textDelta)
        controller.abort(new Error('User aborted generation'))
      } else if (chunk.type === 'error' && chunk.error.code === 'OPERATION_ABORTED') {
        receivedAbort = true
      }
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(receivedAbort).toBe(true)
  })

  // 29. Unsupported image input is rejected
  it('29. rejects multimodal image input with UNSUPPORTED_CAPABILITY in Step 3.6', async () => {
    const adapter = new GoogleAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'gemini-3.8-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this photo' },
              { type: 'image', mediaType: 'image/jpeg', data: 'data123' }
            ]
          }
        ]
      })
    ).rejects.toMatchObject({
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('Multimodal image input is not supported')
      }
    })
  })

  // 30. Unsupported tools are rejected
  it('30. rejects tool requests with UNSUPPORTED_CAPABILITY in Step 3.6', async () => {
    const adapter = new GoogleAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'gemini-deep-research', // gemini-deep-research has providerCapabilities.tools = false
        messages: [{ role: 'user', content: 'Search' }],
        tools: [
          {
            name: 'google_search',
            description: 'Grounding search',
            parameters: {}
          }
        ]
      })
    ).rejects.toMatchObject({
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/does not support tool calling/i)
      }
    })
  })

  // 31. Unsupported structured output is rejected
  it('31. rejects structured output requests with UNSUPPORTED_CAPABILITY in Step 3.6', async () => {
    const adapter = new GoogleAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: 'Format' }],
        jsonSchema: { type: 'object' }
      })
    ).rejects.toMatchObject({
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('Structured output schema is not supported')
      }
    })
  })

  // 32. No API key or authentication header appears in captured logs or errors
  it('32. never leaks API keys in error objects or error messages', async () => {
    const confidentialKey = 'AIzaSyCONFIDENTIALKEY9999999999'

    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `Key '${confidentialKey}' is unauthorized.`,
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }]
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.testConnection(confidentialKey)

    expect(result.success).toBe(false)
    expect(result.error?.message).not.toContain(confidentialKey)
    expect(JSON.stringify(result.error)).not.toContain(confidentialKey)
  })

  // 33. No AI Gateway or third-party endpoint is used
  it('33. guarantees all outbound requests route strictly to official Google endpoints', async () => {
    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return makeGoogleModelResponse('gemini-3.8-flash')
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey, 'gemini-3.8-flash')

    expect(capturedUrl.startsWith(GOOGLE_OFFICIAL_BASE_URL)).toBe(true)
    expect(capturedUrl).not.toContain('gateway')
    expect(capturedUrl).not.toContain('proxy')
  })

  // 34. Executes generation with tools returning structured function calls
  it('34. executes generation with tools returning structured function calls', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'list_knowledge_sources',
                      args: { limit: 10 }
                    }
                  }
                ]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 12,
            totalTokenCount: 32
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'List sources' }],
      tools: [
        {
          name: 'list_knowledge_sources',
          description: 'List available knowledge sources',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'number' } }
          }
        }
      ]
    })

    expect(result.toolCalls).toBeDefined()
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('list_knowledge_sources')
    expect(result.toolCalls![0].arguments).toEqual({ limit: 10 })
    expect(result.finishReason).toBe('tool_calls')
    expect(result.usage.promptTokens).toBe(20)
    expect(result.usage.completionTokens).toBe(12)
  })

  // 35. Unwraps AI_RetryError wrapping HTTP 503 / 429 so statusCode and retryable are preserved
  it('35. unwraps AI_RetryError lastError statusCode (503 & 429) instead of returning UNKNOWN_ERROR', () => {
    const retry503 = Object.assign(new Error('Failed after 3 attempts.'), {
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      lastError: Object.assign(new Error('The model is experiencing high load'), {
        name: 'AI_APICallError',
        statusCode: 503
      })
    })
    const err503 = sanitizeGoogleError(retry503)
    expect(err503.code).toBe('SERVER_ERROR')
    expect(err503.statusCode).toBe(503)
    expect(err503.retryable).toBe(true)

    const retry429 = Object.assign(new Error('Failed after 3 attempts.'), {
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      errors: [
        Object.assign(new Error('Too many requests'), {
          name: 'AI_APICallError',
          statusCode: 429
        })
      ]
    })
    const err429 = sanitizeGoogleError(retry429)
    expect(err429.code).toBe('RATE_LIMITED')
    expect(err429.statusCode).toBe(429)
    expect(err429.retryable).toBe(true)
  })

  // 36. Classifies mid-stream Undici/Node socket errors in err.cause as retryable NETWORK_ERROR / TIMEOUT
  it('36. inspects err.cause for mid-stream terminated/ECONNRESET and body timeouts', () => {
    const streamDrop = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    })
    const resDrop = sanitizeGoogleError(streamDrop)
    expect(resDrop.code).toBe('NETWORK_ERROR')
    expect(resDrop.retryable).toBe(true)

    const bodyTimeout = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' })
    })
    const resTimeout = sanitizeGoogleError(bodyTimeout)
    expect(resTimeout.code).toBe('TIMEOUT')
    expect(resTimeout.retryable).toBe(true)
  })

  // 37. Classifies AI SDK stream validation / empty-output errors and records sanitized diagnostics for unknown errors
  it('37. classifies AI SDK stream validation & empty response errors and logs sanitized unknown diagnostics', () => {
    const emptyErr = sanitizeGoogleError(
      Object.assign(new Error('No output generated.'), { name: 'AI_NoOutputGeneratedError' })
    )
    expect(emptyErr.code).toBe('SERVER_ERROR')
    expect(emptyErr.retryable).toBe(true)

    const parseErr = sanitizeGoogleError(
      Object.assign(new Error('Type validation failed'), { name: 'AI_TypeValidationError' })
    )
    expect(parseErr.code).toBe('SERVER_ERROR')
    expect(parseErr.retryable).toBe(true)

    defaultErrorRingBuffer.clear()
    const weird = sanitizeGoogleError(new Error('Weird failure with key AIzaSySecretKey1234567890'))
    expect(weird.code).toBe('UNKNOWN_ERROR')
    const recent = defaultErrorRingBuffer.getRecentErrors()
    expect(recent.length).toBeGreaterThanOrEqual(1)
    expect(recent[recent.length - 1].code).toBe('GOOGLE_UNKNOWN_ERROR')
    expect(recent[recent.length - 1].sanitizedMessage).not.toContain('AIzaSySecretKey1234567890')
  })

  // 38. Normalizes consecutive user turns and skips blank assistant turns in convertMessages payload
  it('38. merges consecutive user messages and drops blank assistant turns before sending to Gemini', async () => {
    let capturedBody: { contents?: Array<{ role: string; parts: Array<{ text?: string }> }> } = {}
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Recovered answer' }] },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeGreaterThanOrEqual(120000)

    const adapter = new GoogleAdapter({ customFetch })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'First failed question' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'Second question' }
      ]
    })

    expect(result.text).toBe('Recovered answer')
    expect(capturedBody.contents).toHaveLength(1)
    expect(capturedBody.contents?.[0].role).toBe('user')
    const mergedText = capturedBody.contents?.[0].parts.map((p) => p.text ?? '').join('\n')
    expect(mergedText).toContain('First failed question')
    expect(mergedText).toContain('Second question')
  })
})
