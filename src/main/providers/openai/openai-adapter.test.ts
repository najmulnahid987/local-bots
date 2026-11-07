import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIAdapter } from './openai-adapter'
import { ProviderAdapterError } from './errors'
import { OPENAI_OFFICIAL_BASE_URL } from './types'
import { type GenerateTextOptions } from '../types'

describe('OpenAIAdapter (Phase 3 Step 3.4)', () => {
  const dummyApiKey = 'sk-test-dummy-key-12345'
  const originalEnv = process.env.OPENAI_BASE_URL

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_BASE_URL = originalEnv
    } else {
      delete process.env.OPENAI_BASE_URL
    }
    vi.restoreAllMocks()
  })

  // Helper creating a mocked Responses API response
  const makeResponsesApiResponse = (
    text = 'Hello from OpenAI',
    usage = { total_tokens: 10, input_tokens: 4, output_tokens: 6 }
  ): Response => {
    return new Response(
      JSON.stringify({
        id: 'resp-test-1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg-test-1',
            content: [
              {
                type: 'output_text',
                text,
                annotations: []
              }
            ]
          }
        ],
        usage
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  // Helper creating a mocked Responses API SSE stream
  const makeResponsesApiStream = (deltas = ['Hello ', 'from ', 'OpenAI stream!']): Response => {
    const lines: string[] = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg-1","type":"message"}}\n\n'
    ]

    for (const delta of deltas) {
      lines.push(
        `data: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"delta":${JSON.stringify(delta)}}\n\n`
      )
    }

    lines.push(
      'data: {"type":"response.completed","response":{"usage":{"total_tokens":15,"input_tokens":5,"output_tokens":10}}}\n\n'
    )

    return new Response(lines.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  // 1. Adapter identifies as OpenAI
  it('1. identifies correctly as provider openai', () => {
    const adapter = new OpenAIAdapter()
    expect(adapter.providerId).toBe('openai')
  })

  // 2. Only registered OpenAI models are accepted
  it('2. accepts registered OpenAI models like gpt-6-luna and gpt-6.1-sol', async () => {
    let requestedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      requestedUrl = url.toString()
      return new Response(JSON.stringify({ id: 'gpt-6-luna', object: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('gpt-6-luna')
    expect(requestedUrl).toBe(`${OPENAI_OFFICIAL_BASE_URL}/models/gpt-6-luna`)
  })

  // 3. Unknown models are rejected
  it('3. rejects unknown model IDs during connection testing and text generation', async () => {
    const adapter = new OpenAIAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'non-existent-gpt-99')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'non-existent-gpt-99',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 4. Another provider's model is rejected
  it('4. rejects models belonging to another provider (e.g. Anthropic claude-3-5-sonnet)', async () => {
    const adapter = new OpenAIAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'claude-3-5-sonnet-20241022')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 5. Connection test sends an authenticated GET to expected official endpoint
  it('5. sends an authenticated GET to the official models endpoint without generation tokens', async () => {
    let capturedMethod = ''
    let capturedAuthHeader = ''
    let capturedUrl = ''

    const customFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedMethod = init?.method ?? ''
      const headers = (init?.headers ?? {}) as Record<string, string>
      capturedAuthHeader = headers['Authorization'] ?? ''
      return new Response(JSON.stringify({ id: 'gpt-6-luna', object: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(true)
    expect(capturedUrl).toBe(`${OPENAI_OFFICIAL_BASE_URL}/models/gpt-6-luna`)
    expect(capturedMethod).toBe('GET')
    expect(capturedAuthHeader).toBe(`Bearer ${dummyApiKey}`)
  })

  // 6. Successful model lookup returns success
  it('6. returns success and latency on valid model lookup response', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 'gpt-6.1-sol', object: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6.1-sol')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('gpt-6.1-sol')
    expect(typeof result.latencyMs).toBe('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  // 7. HTTP 401 maps to authentication failure
  it('7. maps HTTP 401 response to AUTHENTICATION_FAILED with sanitized message', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection('sk-invalid-key', 'gpt-6-luna')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(result.error?.statusCode).toBe(401)
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toMatch(/authentication failed/i)
  })

  // 8. HTTP 404 maps to model-not-found
  it('8. maps HTTP 404 response to MODEL_NOT_FOUND', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'The model does not exist' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('MODEL_NOT_FOUND')
    expect(result.error?.statusCode).toBe(404)
    expect(result.error?.retryable).toBe(false)
  })

  // 9. HTTP 429 maps to rate-limit/quota errors appropriately
  it('9. maps HTTP 429 to RATE_LIMITED or QUOTA_EXCEEDED based on details', async () => {
    // 9a: Rate limit
    const rateLimitFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit reached for requests' } }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapterA = new OpenAIAdapter({ customFetch: rateLimitFetch })
    const resA = await adapterA.testConnection(dummyApiKey, 'gpt-6-luna')
    expect(resA.error?.code).toBe('RATE_LIMITED')
    expect(resA.error?.retryable).toBe(true)

    // 9b: Insufficient quota
    const quotaFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { message: 'You exceeded your current quota, please check your plan' }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapterB = new OpenAIAdapter({ customFetch: quotaFetch })
    const resB = await adapterB.testConnection(dummyApiKey, 'gpt-6-luna')
    expect(resB.error?.code).toBe('QUOTA_EXCEEDED')
    expect(resB.error?.retryable).toBe(false)
  })

  // 10. HTTP 5xx maps to server error
  it('10. maps HTTP 500/503 to SERVER_ERROR with retryable flag true', async () => {
    const customFetch = vi.fn(async () => {
      return new Response('Internal Server Error', { status: 503 })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('SERVER_ERROR')
    expect(result.error?.statusCode).toBe(503)
    expect(result.error?.retryable).toBe(true)
  })

  // 11. Network failures are sanitized
  it('11. sanitizes network errors without leaking stack traces or host info', async () => {
    const customFetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:443')
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
    expect(result.error?.retryable).toBe(true)
    expect(result.error?.message).toBe('Network connection failure while contacting OpenAI.')
  })

  // 12. Test request cancellation works
  it('12. respects AbortSignal for connection testing and cancels immediately', async () => {
    const controller = new AbortController()

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    controller.abort()

    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna', controller.signal)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OPERATION_ABORTED')
  })

  // 13. Test timeout works
  it('13. enforces timeout on slow connection test requests', async () => {
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Connection test timed out.'))
        })
      })
    }) as unknown as typeof fetch

    // Configure ultra-short 10ms timeout for test
    const adapter = new OpenAIAdapter({ customFetch, connectionTestTimeoutMs: 10 })
    const result = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
    expect(result.error?.retryable).toBe(true)
  })

  // 14. Text generation produces normalized output
  it('14. executes text generation and returns normalized text, finish reason, and usage', async () => {
    const customFetch = vi.fn(async () => {
      return makeResponsesApiResponse('Answer to your question', {
        total_tokens: 30,
        input_tokens: 10,
        output_tokens: 20
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'What is the capital of France?' }]
    })

    expect(result.text).toBe('Answer to your question')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.promptTokens).toBe(10)
    expect(result.usage.completionTokens).toBe(20)
    expect(result.usage.totalTokens).toBe(30)
  })

  // 15. Message conversion preserves ordering and roles
  it('15. converts and preserves system, user, and assistant message ordering', async () => {
    let capturedBody = ''

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      return makeResponsesApiResponse('I understand your constraints.')
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    await adapter.generateText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      systemPrompt: 'Global system instruction',
      messages: [
        { role: 'user', content: 'First user message' },
        { role: 'assistant', content: 'First assistant reply' },
        { role: 'user', content: 'Second user message' }
      ]
    })

    const parsed = JSON.parse(capturedBody) as { input: Array<{ role: string; content: unknown }> }
    expect(parsed.input.length).toBe(4)
    expect(parsed.input[0].role).toBe('developer')
    expect(parsed.input[1].role).toBe('user')
    expect(parsed.input[2].role).toBe('assistant')
    expect(parsed.input[3].role).toBe('user')
  })

  // 16. Streaming emits ordered text delta events
  it('16. streams responses emitting ordered text delta chunks', async () => {
    const customFetch = vi.fn(async () => {
      return makeResponsesApiStream(['Alpha ', 'Beta ', 'Gamma'])
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const deltas: string[] = []

    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Count' }]
    })) {
      if (chunk.type === 'text-delta') {
        deltas.push(chunk.textDelta)
      }
    }

    expect(deltas).toEqual(['Alpha ', 'Beta ', 'Gamma'])
  })

  // 17. Streaming emits completion
  it('17. streams final completion chunk containing finishReason and token usage', async () => {
    const customFetch = vi.fn(async () => {
      return makeResponsesApiStream(['One chunk'])
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    let finishChunk: unknown

    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Hello' }]
    })) {
      if (chunk.type === 'finish') {
        finishChunk = chunk
      }
    }

    expect(finishChunk).toBeDefined()
    const finish = finishChunk as {
      type: string
      finishReason: string
      usage?: { totalTokens: number }
    }
    expect(finish.type).toBe('finish')
    expect(finish.finishReason).toBe('stop')
    expect(finish.usage?.totalTokens).toBe(15)
  })

  // 18. Streaming errors are sanitized
  it('18. emits sanitized error chunk when streaming fails mid-flight', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const chunks: unknown[] = []

    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Hello' }]
    })) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBe(1)
    const errChunk = chunks[0] as { type: string; error: { code: string; statusCode: number } }
    expect(errChunk.type).toBe('error')
    expect(errChunk.error.code).toBe('AUTHENTICATION_FAILED')
    expect(errChunk.error.statusCode).toBe(401)
  })

  // 19. Streaming cancellation stops processing
  it('19. stops stream processing cleanly when AbortSignal triggers', async () => {
    const controller = new AbortController()

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Stream aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    controller.abort()

    const chunks: unknown[] = []
    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Hello' }],
      abortSignal: controller.signal
    })) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBe(1)
    const chunk = chunks[0] as { type: string; error: { code: string } }
    expect(chunk.type).toBe('error')
    expect(chunk.error.code).toBe('OPERATION_ABORTED')
  })

  // 20. Unsupported tool requests are rejected at this stage
  it('20. rejects tool calling options with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new OpenAIAdapter()
    const options: GenerateTextOptions = {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Search' }],
      tools: [
        {
          name: 'read_file',
          description: 'Reads a project file',
          parameters: { type: 'object' }
        }
      ]
    }

    await expect(adapter.generateText(dummyApiKey, options)).rejects.toThrow(ProviderAdapterError)

    try {
      await adapter.generateText(dummyApiKey, options)
    } catch (e) {
      const err = e as ProviderAdapterError
      expect(err.error.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(err.error.message).toMatch(/tool calling is not supported/i)
    }
  })

  // 21. Unsupported image input is rejected at this stage
  it('21. rejects multimodal image input with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new OpenAIAdapter()
    const options: GenerateTextOptions = {
      modelId: 'gpt-6-luna',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this image:' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo...' }
          ]
        }
      ]
    }

    await expect(adapter.generateText(dummyApiKey, options)).rejects.toThrow(ProviderAdapterError)

    try {
      await adapter.generateText(dummyApiKey, options)
    } catch (e) {
      const err = e as ProviderAdapterError
      expect(err.error.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(err.error.message).toMatch(/multimodal image input is not supported/i)
    }
  })

  // 22. Unsupported structured output is rejected at this stage
  it('22. rejects structured output jsonSchema with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new OpenAIAdapter()
    const options: GenerateTextOptions = {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Extract entities' }],
      jsonSchema: { type: 'object', properties: { name: { type: 'string' } } }
    }

    await expect(adapter.generateText(dummyApiKey, options)).rejects.toThrow(ProviderAdapterError)

    try {
      await adapter.generateText(dummyApiKey, options)
    } catch (e) {
      const err = e as ProviderAdapterError
      expect(err.error.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(err.error.message).toMatch(/structured output/i)
    }
  })

  // 23. store: false is passed to OpenAI generation requests
  it('23. explicitly sets store: false in OpenAI generation requests for data privacy', async () => {
    let capturedBody = ''

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      return makeResponsesApiResponse('Privacy protected response')
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    await adapter.generateText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Confidential user query' }]
    })

    const parsed = JSON.parse(capturedBody) as { store: unknown }
    expect(parsed.store).toBe(false)
  })

  // 24. Fixed official base URL is used even if an OPENAI_BASE_URL environment variable is present
  it('24. uses fixed official base URL even when OPENAI_BASE_URL environment variable is set', async () => {
    // Set a rogue environment variable
    process.env.OPENAI_BASE_URL = 'https://rogue-proxy.untrusted.com/v1'

    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return makeResponsesApiResponse('Direct safe response')
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    await adapter.generateText(dummyApiKey, {
      modelId: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Test base url' }]
    })

    // URL must strictly target api.openai.com, completely ignoring rogue environment variable
    expect(capturedUrl.startsWith(OPENAI_OFFICIAL_BASE_URL)).toBe(true)
    expect(capturedUrl).not.toContain('rogue-proxy')
  })

  // 25. No API key or Authorization header appears in captured logs or returned errors
  it('25. guarantees no API key or Authorization header appears in returned errors or sanitized messages', async () => {
    const sensitiveKey = 'sk-proj-ultra-secret-key-999888777'

    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: `Invalid key ${sensitiveKey} for organization org-1234`
          }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new OpenAIAdapter({ customFetch })
    const result = await adapter.testConnection(sensitiveKey, 'gpt-6-luna')

    expect(result.success).toBe(false)
    const serializedError = JSON.stringify(result.error)

    expect(serializedError).not.toContain(sensitiveKey)
    expect(serializedError).not.toContain('Bearer')
    expect(serializedError).not.toContain('org-1234')
    expect(result.error?.message).toBe('OpenAI authentication failed. Please verify your API key.')
  })
})
