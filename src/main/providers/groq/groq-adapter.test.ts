import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GroqAdapter } from './groq-adapter'
import { ProviderAdapterError, sanitizeGroqError, redactGroqSecrets } from './errors'
import { GROQ_OFFICIAL_BASE_URL, GROQ_DEFAULT_TEST_MODEL } from './types'
import { GROQ_CURATED_MODEL_PROFILES, isNonChatGroqModel } from './model-metadata'
import { sanitizeErrorMessage } from '../provider-manager/errors'
import { DiagnosticSanitizer } from '../../services/diagnostic-sanitizer'
import { SecretScanner, defaultSecretScanner } from '../../services/secret-scanner'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'
import type { StreamTextChunk } from '../types'

describe('GroqAdapter & Groq Provider Safety (Phase 13 Step 13.2)', () => {
  const dummyApiKey = 'gsk_test_groq_secret_key_abcdefghijklmnopqrstuvwxyz123456'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const makeModelsResponse = (
    models: Array<{
      id: string
      active?: boolean
      owned_by?: string
      context_window?: number
      max_completion_tokens?: number
    }> = [
      {
        id: 'llama-3.3-70b-versatile',
        active: true,
        owned_by: 'Meta',
        context_window: 131072,
        max_completion_tokens: 32768
      },
      {
        id: 'llama-3.1-8b-instant',
        active: true,
        owned_by: 'Meta',
        context_window: 131072,
        max_completion_tokens: 131072
      },
      {
        id: 'whisper-large-v3',
        active: true,
        owned_by: 'OpenAI',
        context_window: 448,
        max_completion_tokens: 448
      },
      {
        id: 'whisper-large-v3-turbo',
        active: true,
        owned_by: 'OpenAI',
        context_window: 448,
        max_completion_tokens: 448
      },
      {
        id: 'playai-tts',
        active: true,
        owned_by: 'PlayAI',
        context_window: 8192,
        max_completion_tokens: 8192
      },
      {
        id: 'meta-llama/llama-guard-4-12b',
        active: true,
        owned_by: 'Meta',
        context_window: 131072,
        max_completion_tokens: 1024
      },
      {
        id: 'groq/future-unverified-chat-model',
        active: true,
        owned_by: 'Groq',
        context_window: 65536,
        max_completion_tokens: 16384
      },
      {
        id: 'legacy-decommissioned-model',
        active: false,
        owned_by: 'Meta',
        context_window: 8192,
        max_completion_tokens: 4096
      }
    ]
  ): Response => {
    return new Response(
      JSON.stringify({
        object: 'list',
        data: models.map((m) => ({ object: 'model', created: 1730000000, ...m }))
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const makeChatCompletionResponse = (
    text = 'Hello from Groq LPU',
    finishReason = 'stop',
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
  ): Response => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-groq-test-1',
        object: 'chat.completion',
        created: 1730000000,
        model: 'llama-3.3-70b-versatile',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: toolCalls ? null : text,
              ...(toolCalls
                ? {
                    tool_calls: toolCalls.map((tc) => ({
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: tc.arguments }
                    }))
                  }
                : {})
            },
            finish_reason: finishReason
          }
        ],
        usage: {
          prompt_tokens: 24,
          completion_tokens: 12,
          total_tokens: 36
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const makeStreamResponse = (deltas: string[], finishReason = 'stop'): Response => {
    const encoder = new TextEncoder()
    const chunks = [
      ...deltas.map(
        (delta) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream-1',
            object: 'chat.completion.chunk',
            created: 1730000000,
            model: 'llama-3.3-70b-versatile',
            choices: [
              { index: 0, delta: { role: 'assistant', content: delta }, finish_reason: null }
            ]
          })}\n\n`
      ),
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: 1730000000,
        model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        x_groq: {
          usage: {
            prompt_tokens: 15,
            completion_tokens: 9,
            total_tokens: 24
          }
        },
        usage: {
          prompt_tokens: 15,
          completion_tokens: 9,
          total_tokens: 24
        }
      })}\n\n`,
      'data: [DONE]\n\n'
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    })

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  it('1. enforces official Groq HTTPS base URL and rejects insecure base URLs', () => {
    const adapter = new GroqAdapter()
    expect(adapter.providerId).toBe('groq')
    expect(GROQ_OFFICIAL_BASE_URL).toBe('https://api.groq.com/openai/v1')

    expect(() => new GroqAdapter({ baseURL: 'http://api.groq.com/openai/v1' })).toThrow(
      ProviderAdapterError
    )
    expect(() => new GroqAdapter({ baseURL: 'not-a-valid-url' })).toThrow(ProviderAdapterError)
  })

  it('2. testConnection authenticates with zero paid tokens via GET /models and filters non-chat/inactive models', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeModelsResponse())
    const adapter = new GroqAdapter({ fetchFn: fetchMock })

    const result = await adapter.testConnection(dummyApiKey)

    expect(result.success).toBe(true)
    expect(result.testedModelId).toBe(GROQ_DEFAULT_TEST_MODEL)
    expect(result.availableModels).toEqual([
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'groq/future-unverified-chat-model'
    ])
    expect(result.discoveredModels).toHaveLength(3)

    // Non-chat audio/TTS/guard models and inactive models are excluded
    expect(result.availableModels).not.toContain('whisper-large-v3')
    expect(result.availableModels).not.toContain('whisper-large-v3-turbo')
    expect(result.availableModels).not.toContain('playai-tts')
    expect(result.availableModels).not.toContain('meta-llama/llama-guard-4-12b')
    expect(result.availableModels).not.toContain('legacy-decommissioned-model')

    // Zero paid completion requests sent during testConnection
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/models')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${dummyApiKey}`
    })
  })

  it('3. testConnection fails with MODEL_NOT_FOUND if explicitly requested model is absent or inactive', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeModelsResponse())
    const adapter = new GroqAdapter({ fetchFn: fetchMock })

    const missingResult = await adapter.testConnection(dummyApiKey, 'nonexistent-model')
    expect(missingResult.success).toBe(false)
    expect(missingResult.error?.code).toBe('MODEL_NOT_FOUND')

    const inactiveResult = await adapter.testConnection(dummyApiKey, 'legacy-decommissioned-model')
    expect(inactiveResult.success).toBe(false)
    expect(inactiveResult.error?.code).toBe('MODEL_NOT_FOUND')
  })

  it('4. testConnection fails gracefully with AUTHENTICATION_FAILED on empty key or HTTP 401 without leaking API key', async () => {
    const adapterBlank = new GroqAdapter({ fetchFn: vi.fn() })
    const blankRes = await adapterBlank.testConnection('   ')
    expect(blankRes.success).toBe(false)
    expect(blankRes.error?.code).toBe('AUTHENTICATION_FAILED')

    const fetch401 = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: `Invalid API Key: ${dummyApiKey}`,
            type: 'invalid_request_error',
            code: 'invalid_api_key'
          }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    )
    const adapter401 = new GroqAdapter({ fetchFn: fetch401 })
    const res401 = await adapter401.testConnection(dummyApiKey)
    expect(res401.success).toBe(false)
    expect(res401.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(res401.error?.message).not.toContain(dummyApiKey)
    expect(res401.error?.details ?? '').not.toContain(dummyApiKey)
  })

  it('5. assigns curated verified capabilities vs conservative defaults for unknown discovered models', async () => {
    expect(isNonChatGroqModel('whisper-large-v3')).toBe(true)
    expect(isNonChatGroqModel('whisper-large-v3-turbo')).toBe(true)
    expect(isNonChatGroqModel('playai-tts')).toBe(true)
    expect(isNonChatGroqModel('llama-3.3-70b-versatile')).toBe(false)

    expect(GROQ_CURATED_MODEL_PROFILES['groq/compound'].providerCapabilities.tools).toBe(false)
    expect(GROQ_CURATED_MODEL_PROFILES['llama-3.3-70b-versatile'].providerCapabilities.tools).toBe(
      true
    )

    const fetchMock = vi.fn().mockResolvedValueOnce(makeModelsResponse())
    const adapter = new GroqAdapter({ fetchFn: fetchMock })
    const descriptors = await adapter.discoverModelMetadata(dummyApiKey)

    const llama70b = descriptors.find((m) => m.id === 'llama-3.3-70b-versatile')
    expect(llama70b?.providerCapabilities?.tools).toBe(true)
    expect(llama70b?.contextWindow).toEqual({ inputTokens: 131072, outputTokens: 32768 })

    const futureUnknown = descriptors.find((m) => m.id === 'groq/future-unverified-chat-model')
    expect(futureUnknown).toBeDefined()
    expect(futureUnknown?.contextWindow).toEqual({ inputTokens: 65536, outputTokens: 16384 })
    expect(futureUnknown?.providerCapabilities?.tools).toBe(false)
    expect(futureUnknown?.providerCapabilities?.imageInput).toBe(false)
    expect(futureUnknown?.providerCapabilities?.structuredOutput).toBe(false)
    expect(futureUnknown?.providerCapabilities?.streaming).toBe(true)
  })

  it('6. generateText executes non-streaming requests cleanly and omits unsupported wire parameters', async () => {
    let capturedBody: Record<string, unknown> | undefined

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (init && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>
      }
      return makeChatCompletionResponse('Verified Groq answer.', 'stop')
    })

    const adapter = new GroqAdapter({ fetchFn: fetchMock })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'llama-3.3-70b-versatile',
      systemPrompt: 'Be concise.',
      temperature: 0,
      maxTokens: 512,
      messages: [{ role: 'user', name: 'AliceUser', content: 'Explain Groq LPU architecture.' }]
    })

    expect(result.text).toBe('Verified Groq answer.')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 24, completionTokens: 12, totalTokens: 36 })

    // Verify wire parameter sanitization
    expect(capturedBody).toBeDefined()
    expect(capturedBody?.logprobs).toBeUndefined()
    expect(capturedBody?.top_logprobs).toBeUndefined()
    expect(capturedBody?.logit_bias).toBeUndefined()
    expect(capturedBody?.store).toBeUndefined()
    expect(capturedBody?.metadata).toBeUndefined()
    expect(capturedBody?.n).toBeUndefined()
    expect(capturedBody?.temperature).toBe(0)
    const sentMessages = capturedBody?.messages as Array<Record<string, unknown>>
    expect(sentMessages.every((m) => !('name' in m))).toBe(true)
  })

  it('7. generateText handles native tool calling and normalizes toolCalls & finishReason', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeChatCompletionResponse('', 'tool_calls', [
        {
          id: 'call_groq_123',
          name: 'search_knowledge_base',
          arguments: '{"query":"Q3 budget"}'
        }
      ])
    )

    const adapter = new GroqAdapter({ fetchFn: fetchMock })
    const result = await adapter.generateText(dummyApiKey, {
      modelId: 'llama-3.3-70b-versatile',
      systemPrompt: 'Use tools when needed.',
      messages: [
        { role: 'user', content: 'Find the Q3 budget notes.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_prev', name: 'list_workspace_files', arguments: {} }]
        },
        {
          role: 'tool',
          toolCallId: 'call_prev',
          name: 'list_workspace_files',
          content: '["q3.md"]'
        }
      ],
      tools: [
        {
          name: 'search_knowledge_base',
          description: 'Search indexed documents',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ]
    })

    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      {
        id: 'call_groq_123',
        name: 'search_knowledge_base',
        arguments: { query: 'Q3 budget' }
      }
    ])
  })

  it('8. streamText emits text-delta chunks, final usage, and supports AbortSignal cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeStreamResponse(['Hello ', 'world', '!']))
    const adapter = new GroqAdapter({ fetchFn: fetchMock })

    const chunks: StreamTextChunk[] = []
    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Hi!' }]
    })) {
      chunks.push(chunk)
    }

    const combinedText = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.textDelta)
      .join('')
    expect(combinedText).toBe('Hello world!')
    expect(chunks.some((c) => c.type === 'finish' && c.finishReason === 'stop')).toBe(true)

    // Verify AbortSignal cancellation yields sanitized OPERATION_ABORTED error chunk
    const abortCtrl = new AbortController()
    abortCtrl.abort(new DOMException('Cancelled by user', 'AbortError'))
    const abortAdapter = new GroqAdapter({ fetchFn: vi.fn() })
    const abortChunks: StreamTextChunk[] = []
    for await (const chunk of abortAdapter.streamText(dummyApiKey, {
      modelId: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Stop me' }],
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

  it('9. streamText catches HTTP/stream errors and emits sanitized error chunks without raw keys', async () => {
    const fetchError = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: `Unauthorized key Bearer ${dummyApiKey}`,
            type: 'authentication_error'
          }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    )
    const adapter = new GroqAdapter({ fetchFn: fetchError })
    const chunks: StreamTextChunk[] = []
    for await (const chunk of adapter.streamText(dummyApiKey, {
      modelId: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Test stream auth failure' }]
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('error')
    if (chunks[0].type === 'error') {
      expect(chunks[0].error.code).toBe('AUTHENTICATION_FAILED')
      expect(chunks[0].error.message).not.toContain(dummyApiKey)
      expect(chunks[0].error.details ?? '').not.toContain(dummyApiKey)
    }
  })

  it('10. classifies all Groq error categories accurately and redacts gsk_ secrets across every sanitizer', () => {
    expect(sanitizeGroqError({ statusCode: 401, message: `bad ${dummyApiKey}` }).code).toBe(
      'AUTHENTICATION_FAILED'
    )
    expect(sanitizeGroqError({ statusCode: 403, message: 'organization_restricted' }).code).toBe(
      'PERMISSION_DENIED'
    )
    expect(
      sanitizeGroqError({ statusCode: 404, message: 'model_decommissioned: llama3-70b' }).code
    ).toBe('MODEL_NOT_FOUND')
    expect(
      sanitizeGroqError({ statusCode: 413, message: 'request too large / reduce the length' }).code
    ).toBe('CONTEXT_LENGTH_EXCEEDED')

    const rateLimitErr = sanitizeGroqError({
      statusCode: 429,
      message: 'Rate limit reached for tokens per minute (TPM)'
    })
    expect(rateLimitErr.code).toBe('RATE_LIMITED')
    expect(rateLimitErr.retryable).toBe(true)

    const quotaErr = sanitizeGroqError({
      statusCode: 429,
      message: 'insufficient_quota: billing spend limit reached'
    })
    expect(quotaErr.code).toBe('QUOTA_EXCEEDED')
    expect(quotaErr.retryable).toBe(false)

    const toolUseErr = sanitizeGroqError({
      statusCode: 400,
      message: 'tool_use_failed: invalid arguments'
    })
    expect(toolUseErr.code).toBe('INVALID_REQUEST')

    const serverErr = sanitizeGroqError({ statusCode: 503, message: 'Service unavailable' })
    expect(serverErr.code).toBe('SERVER_ERROR')
    expect(serverErr.retryable).toBe(true)

    const networkErr = sanitizeGroqError({ code: 'ECONNRESET', message: 'socket hang up' })
    expect(networkErr.code).toBe('NETWORK_ERROR')
    expect(networkErr.retryable).toBe(true)

    // Verify gsk_ secret redaction across all pipeline sanitizers + ring buffer
    const leakyText = `Failed with key ${dummyApiKey} and Authorization: Bearer ${dummyApiKey}`
    expect(redactGroqSecrets(leakyText)).not.toContain(dummyApiKey)
    expect(sanitizeErrorMessage(leakyText)).not.toContain(dummyApiKey)
    expect(DiagnosticSanitizer.sanitize(leakyText)).not.toContain(dummyApiKey)

    const scanResult = defaultSecretScanner.scanText(leakyText)
    expect(scanResult.hasSecret).toBe(true)
    expect(scanResult.patternName).toBe('Groq API Key')
    expect(new SecretScanner().scanText(`key=${dummyApiKey}`).hasSecret).toBe(true)

    const recentErrors = defaultErrorRingBuffer.getRecentErrors()
    for (const entry of recentErrors) {
      expect(entry.sanitizedMessage).not.toContain(dummyApiKey)
    }
  })
})
