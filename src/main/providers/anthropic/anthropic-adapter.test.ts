import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from './anthropic-adapter'
import { ProviderAdapterError } from './errors'
import { ANTHROPIC_OFFICIAL_BASE_URL, ANTHROPIC_DEFAULT_VERSION } from './types'
import { type GenerateTextOptions } from '../types'

describe('AnthropicAdapter (Phase 3 Step 3.5)', () => {
  const dummyApiKey = 'sk-ant-api03-test-dummy-key-12345'
  const originalEnv = process.env.ANTHROPIC_BASE_URL

  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalEnv
    } else {
      delete process.env.ANTHROPIC_BASE_URL
    }
    vi.restoreAllMocks()
  })

  // Helper creating a mocked Anthropic Messages API response
  const makeAnthropicMessageResponse = (
    text = 'Hello from Claude',
    usage = { input_tokens: 12, output_tokens: 8 },
    stopReason = 'end_turn'
  ): Response => {
    return new Response(
      JSON.stringify({
        id: 'msg_test_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: 'claude-sonnet-5-5',
        stop_reason: stopReason,
        stop_sequence: null,
        usage
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  // Helper creating a mocked Anthropic SSE stream
  const makeAnthropicStreamResponse = (
    deltas = ['Hello ', 'from ', 'Claude stream!'],
    usage = { input_tokens: 10, output_tokens: 15 }
  ): Response => {
    const lines: string[] = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${usage.input_tokens},"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
    ]

    for (const delta of deltas) {
      lines.push(
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(delta)}}}\n\n`
      )
    }

    lines.push(
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${usage.output_tokens}}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`
    )

    return new Response(lines.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  // 1. Adapter identifies as Anthropic
  it('1. identifies correctly as provider anthropic', () => {
    const adapter = new AnthropicAdapter()
    expect(adapter.providerId).toBe('anthropic')
  })

  // 2. Only registered Anthropic models are accepted
  it('2. accepts registered Anthropic models like claude-sonnet-5-5, claude-haiku-5-5, and claude-opus-5-5', async () => {
    let requestedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      requestedUrl = url.toString()
      return new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'claude-sonnet-5-5')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('claude-sonnet-5-5')
    expect(requestedUrl).toBe(`${ANTHROPIC_OFFICIAL_BASE_URL}/models/claude-sonnet-5-5`)
  })

  // 3. Unknown models are rejected
  it('3. rejects unknown model IDs during connection testing and text generation', async () => {
    const adapter = new AnthropicAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'non-existent-claude-99')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'non-existent-claude-99',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 4. Another provider's model is rejected
  it('4. rejects models belonging to another provider (e.g. OpenAI gpt-6-luna or Google gemini-3.1-pro)', async () => {
    const adapter = new AnthropicAdapter()

    const testRes = await adapter.testConnection(dummyApiKey, 'gpt-6-luna')
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('MODEL_NOT_FOUND')

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    ).rejects.toThrow(ProviderAdapterError)
  })

  // 5. Connection test sends an authenticated GET to expected official endpoint without generation tokens
  it('5. sends an authenticated GET to the official models endpoint without generation tokens', async () => {
    let capturedMethod = ''
    let capturedKeyHeader = ''
    let capturedVersionHeader = ''
    let capturedUrl = ''

    const customFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedMethod = init?.method ?? ''
      const headers = (init?.headers ?? {}) as Record<string, string>
      capturedKeyHeader = headers['x-api-key'] ?? ''
      capturedVersionHeader = headers['anthropic-version'] ?? ''
      return new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'claude-sonnet-5-5')

    expect(result.success).toBe(true)
    expect(capturedUrl).toBe(`${ANTHROPIC_OFFICIAL_BASE_URL}/models/claude-sonnet-5-5`)
    expect(capturedMethod).toBe('GET')
    expect(capturedKeyHeader).toBe(dummyApiKey)
    expect(capturedVersionHeader).toBe(ANTHROPIC_DEFAULT_VERSION)
    expect(typeof result.latencyMs).toBe('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  // 6. Supports custom model selection during connection test
  it('6. supports custom model selection during connection test', async () => {
    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ id: 'claude-opus-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, 'claude-opus-5-5')

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('claude-opus-5-5')
    expect(capturedUrl).toBe(`${ANTHROPIC_OFFICIAL_BASE_URL}/models/claude-opus-5-5`)
  })

  // 7. Falls back to default Anthropic model if none provided
  it('7. falls back to default Anthropic model if none provided in testConnection', async () => {
    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe('claude-sonnet-5-5')
    expect(capturedUrl).toBe(`${ANTHROPIC_OFFICIAL_BASE_URL}/models/claude-sonnet-5-5`)
  })

  // 8. Sends required Anthropic headers: x-api-key and anthropic-version: 2023-06-01
  it('8. sends required Anthropic headers: x-api-key and anthropic-version: 2023-06-01', async () => {
    let capturedHeaders: Record<string, string> = {}
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey)

    expect(capturedHeaders['x-api-key']).toBe(dummyApiKey)
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01')
    expect(capturedHeaders['Accept']).toBe('application/json')
    expect(capturedHeaders['User-Agent']).toContain('Electron; Main')
    expect(capturedHeaders['Authorization']).toBeUndefined()
  })

  // 9. Rejects empty or whitespace-only API keys without network calls
  it('9. rejects empty or whitespace-only API keys without network calls', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch
    const adapter = new AnthropicAdapter({ customFetch })

    const emptyRes = await adapter.testConnection('')
    expect(emptyRes.success).toBe(false)
    expect(emptyRes.error?.code).toBe('AUTHENTICATION_FAILED')

    const whitespaceRes = await adapter.testConnection('   \t\n  ')
    expect(whitespaceRes.success).toBe(false)
    expect(whitespaceRes.error?.code).toBe('AUTHENTICATION_FAILED')

    expect(customFetch).not.toHaveBeenCalled()
  })

  // 10. Maps HTTP 401 to AUTHENTICATION_FAILED
  it('10. maps HTTP 401 to AUTHENTICATION_FAILED with user-friendly message', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain('Anthropic authentication failed')
  })

  // 11. Maps HTTP 403 to PERMISSION_DENIED
  it('11. maps HTTP 403 to PERMISSION_DENIED', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'permission_error', message: 'Forbidden' }
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(result.error?.retryable).toBe(false)
  })

  // 12. Maps HTTP 404 to MODEL_NOT_FOUND
  it('12. maps HTTP 404 to MODEL_NOT_FOUND', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'model not found' }
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('MODEL_NOT_FOUND')
    expect(result.error?.retryable).toBe(false)
  })

  // 13. Maps HTTP 413 to CONTEXT_LENGTH_EXCEEDED
  it('13. maps HTTP 413 to CONTEXT_LENGTH_EXCEEDED', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Prompt exceeds maximum context length' }
        }),
        { status: 413, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('CONTEXT_LENGTH_EXCEEDED')
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain('context length exceeds')
  })

  // 14. Maps HTTP 429 rate limit to RATE_LIMITED (retryable: true)
  it('14. maps HTTP 429 rate limit to RATE_LIMITED (retryable: true)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Too many requests' }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('RATE_LIMITED')
    expect(result.error?.retryable).toBe(true)
  })

  // 15. Maps HTTP 429 credit exhaustion to QUOTA_EXCEEDED (retryable: false)
  it('15. maps HTTP 429 credit exhaustion to QUOTA_EXCEEDED (retryable: false)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Your credit balance is too low to access the Anthropic API.'
          }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('QUOTA_EXCEEDED')
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain('quota or credit balance exhausted')
  })

  // 16. Maps HTTP 529 overloaded to SERVER_ERROR (retryable: true)
  it('16. maps HTTP 529 overloaded to SERVER_ERROR (retryable: true)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' }
        }),
        { status: 529, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('SERVER_ERROR')
    expect(result.error?.retryable).toBe(true)
    expect(result.error?.message).toContain('overloaded')
  })

  // 17. Maps HTTP 500/503 to SERVER_ERROR (retryable: true)
  it('17. maps HTTP 500/503 to SERVER_ERROR (retryable: true)', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' }
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('SERVER_ERROR')
    expect(result.error?.retryable).toBe(true)
  })

  // 18. Maps unexpected HTTP status codes (e.g. 418) to UNKNOWN_ERROR
  it('18. maps unexpected HTTP status codes (e.g. 418) to UNKNOWN_ERROR', async () => {
    const customFetch = vi.fn(async () => {
      return new Response("I'm a teapot", { status: 418 })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_ERROR')
    expect(result.error?.statusCode).toBe(418)
    expect(result.error?.retryable).toBe(false)
  })

  // 19. Times out connection test if endpoint fails to respond within threshold
  it('19. times out connection test if endpoint fails to respond within threshold', async () => {
    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Connection test timed out.'))
        })
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({
      customFetch,
      connectionTestTimeoutMs: 25
    })

    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
    expect(result.error?.retryable).toBe(true)
  })

  // 20. Respects pre-aborted AbortSignal on connection test without network calls
  it('20. respects pre-aborted AbortSignal on connection test without network calls', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch
    const adapter = new AnthropicAdapter({ customFetch })

    const controller = new AbortController()
    controller.abort(new Error('Manual cancellation before start'))

    const result = await adapter.testConnection(dummyApiKey, undefined, controller.signal)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OPERATION_ABORTED')
    expect(customFetch).not.toHaveBeenCalled()
  })

  // 21. Respects mid-flight AbortSignal cancellation on connection test
  it('21. respects mid-flight AbortSignal cancellation on connection test', async () => {
    const controller = new AbortController()

    const customFetch = vi.fn(async () => {
      controller.abort()
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(dummyApiKey, undefined, controller.signal)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OPERATION_ABORTED')
  })

  // 22. Generates single text completion with normalized usage and finish reason
  it('22. generates single text completion with normalized usage and finish reason', async () => {
    const customFetch = vi.fn(async () => {
      return makeAnthropicMessageResponse(
        'Anthropic response text here.',
        { input_tokens: 15, output_tokens: 25 },
        'end_turn'
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const options: GenerateTextOptions = {
      modelId: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'What is the speed of light?' }]
    }

    const result = await adapter.generateText(dummyApiKey, options)

    expect(result.text).toBe('Anthropic response text here.')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      promptTokens: 15,
      completionTokens: 25,
      totalTokens: 40
    })
  })

  // 23. Properly separates systemPrompt into system parameter for Anthropic Messages API
  it('23. properly separates systemPrompt into system parameter for Anthropic Messages API', async () => {
    let capturedBody: Record<string, unknown> = {}

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>
      }
      return makeAnthropicMessageResponse('System instructions observed.')
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const options: GenerateTextOptions = {
      modelId: 'claude-sonnet-5-5',
      systemPrompt: 'You are an expert security reviewer.',
      messages: [
        { role: 'system', content: 'Always inspect memory allocations.' },
        { role: 'user', content: 'Review this C function.' }
      ]
    }

    await adapter.generateText(dummyApiKey, options)

    expect(capturedBody.system).toEqual([
      {
        type: 'text',
        text: 'You are an expert security reviewer.\n\nAlways inspect memory allocations.'
      }
    ])
    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('user')
  })

  // 24. Preserves multi-turn conversational history in messages payload
  it('24. preserves multi-turn conversational history in messages payload', async () => {
    let capturedBody: Record<string, unknown> = {}

    const customFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>
      }
      return makeAnthropicMessageResponse('Understood, continuing multi-turn dialogue.')
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const options: GenerateTextOptions = {
      modelId: 'claude-sonnet-5-5',
      messages: [
        { role: 'user', content: 'First message.' },
        { role: 'assistant', content: 'First response.' },
        { role: 'user', content: 'Second message.' }
      ]
    }

    await adapter.generateText(dummyApiKey, options)

    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>
    expect(messages.length).toBe(3)
    expect(messages[0].role).toBe('user')
    expect(messages[1].role).toBe('assistant')
    expect(messages[2].role).toBe('user')
  })

  // 25. Maps finish reasons appropriately (end_turn -> stop, max_tokens -> length)
  it('25. maps finish reasons appropriately (end_turn -> stop, max_tokens -> length)', async () => {
    let currentStopReason = 'end_turn'
    const customFetch = vi.fn(async () => {
      return makeAnthropicMessageResponse('Partial or full response.', undefined, currentStopReason)
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })

    currentStopReason = 'end_turn'
    const res1 = await adapter.generateText(dummyApiKey, {
      modelId: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Hi' }]
    })
    expect(res1.finishReason).toBe('stop')

    currentStopReason = 'max_tokens'
    const res2 = await adapter.generateText(dummyApiKey, {
      modelId: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Hi' }]
    })
    expect(res2.finishReason).toBe('length')
  })

  // 26. Streams text response yielding deltas, finish event, and usage
  it('26. streams text response yielding deltas, finish event, and usage', async () => {
    const customFetch = vi.fn(async () => {
      return makeAnthropicStreamResponse(['First chunk ', 'second chunk ', 'final chunk.'], {
        input_tokens: 8,
        output_tokens: 12
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const chunks: string[] = []
    let finishReason = ''
    let totalTokens = 0

    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Stream test' }]
    })

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.textDelta)
      } else if (chunk.type === 'finish') {
        finishReason = chunk.finishReason
        totalTokens = chunk.usage?.totalTokens ?? 0
      }
    }

    expect(chunks.join('')).toBe('First chunk second chunk final chunk.')
    expect(finishReason).toBe('stop')
    expect(totalTokens).toBe(20)
  })

  // 27. Propagates streaming error chunks safely sanitized
  it('27. propagates streaming error chunks safely sanitized', async () => {
    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'claude-sonnet-5-5',
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

  // 28. Handles mid-stream abort signal cancellation gracefully
  it('28. handles mid-stream abort signal cancellation gracefully', async () => {
    const controller = new AbortController()

    const customFetch = vi.fn(async () => {
      return makeAnthropicStreamResponse(['Alpha ', 'Beta '])
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const stream = adapter.streamText(dummyApiKey, {
      modelId: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Abort test' }],
      abortSignal: controller.signal
    })

    const chunks: string[] = []
    let receivedAbort = false

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.textDelta)
        controller.abort(new Error('User clicked Stop Generation'))
      } else if (chunk.type === 'error' && chunk.error.code === 'OPERATION_ABORTED') {
        receivedAbort = true
      }
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(receivedAbort).toBe(true)
  })

  // 29. Rejects unsupported tool calling with UNSUPPORTED_CAPABILITY
  it('29. rejects unsupported tool calling with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new AnthropicAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Call this tool' }],
        tools: [
          {
            name: 'read_file',
            description: 'Reads a file',
            parameters: {}
          }
        ]
      })
    ).rejects.toMatchObject({
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('Tool calling is not supported')
      }
    })
  })

  // 30. Rejects unsupported structured output schema with UNSUPPORTED_CAPABILITY
  it('30. rejects unsupported structured output schema with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new AnthropicAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Generate JSON' }],
        jsonSchema: {
          type: 'object',
          properties: { key: { type: 'string' } }
        }
      })
    ).rejects.toMatchObject({
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('Structured output schema is not supported')
      }
    })
  })

  // 31. Rejects multimodal image inputs with UNSUPPORTED_CAPABILITY
  it('31. rejects multimodal image inputs with UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new AnthropicAdapter()

    await expect(
      adapter.generateText(dummyApiKey, {
        modelId: 'claude-sonnet-5-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this image' },
              { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }
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

  // 32. Enforces official fixed base URL and ignores environment variable overrides
  it('32. enforces official fixed base URL and ignores environment variable overrides', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://malicious-proxy.attacker.com/v1'

    let capturedUrl = ''
    const customFetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    await adapter.testConnection(dummyApiKey, 'claude-sonnet-5-5')

    expect(capturedUrl.startsWith(ANTHROPIC_OFFICIAL_BASE_URL)).toBe(true)
    expect(capturedUrl).not.toContain('malicious-proxy.attacker.com')
  })

  // 33. Never leaks API keys in error objects or error messages
  it('33. never leaks API keys in error objects or error messages', async () => {
    const sensitiveKey = 'sk-ant-api03-SECRET-KEY-VERY-CONFIDENTIAL-99999'

    const customFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: `Key '${sensitiveKey}' is invalid or expired.`
          }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const adapter = new AnthropicAdapter({ customFetch })
    const result = await adapter.testConnection(sensitiveKey)

    expect(result.success).toBe(false)
    expect(result.error?.message).not.toContain(sensitiveKey)
    expect(JSON.stringify(result.error)).not.toContain(sensitiveKey)
  })
})
