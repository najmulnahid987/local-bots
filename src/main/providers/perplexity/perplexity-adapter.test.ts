import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PerplexityAdapter,
  PERPLEXITY_OFFICIAL_BASE_URL,
  PERPLEXITY_CURATED_MODEL_PROFILES,
  getPerplexityCuratedCatalogModels,
  sanitizePerplexityError,
  redactPerplexitySecrets
} from './index'

function buildAgentResponseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_pplx_test_1',
    created_at: 1760000000,
    object: 'response',
    status: 'completed',
    model: 'perplexity/sonar',
    output: [
      {
        type: 'search_results',
        queries: ['perplexity agent api'],
        results: [
          {
            id: 1,
            title: 'Perplexity Agent API Docs',
            url: 'https://docs.perplexity.ai/docs/agent-api/quickstart',
            snippet: 'Official Agent API endpoint docs.',
            date: '2026-10-01'
          },
          {
            id: 2,
            title: 'Unsafe Script Source',
            url: 'javascript:alert(1)',
            snippet: 'Must be dropped'
          }
        ]
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Agent API verified response.',
            annotations: [
              {
                type: 'url_citation',
                title: 'Perplexity Agent API Docs',
                url: 'https://docs.perplexity.ai/docs/agent-api/quickstart',
                start_index: 0,
                end_index: 10
              }
            ]
          }
        ]
      }
    ],
    usage: {
      input_tokens: 24,
      output_tokens: 12,
      total_tokens: 36,
      tool_calls_details: {
        web_search: { invocation: 1 }
      },
      cost: {
        input_cost: 0.0001,
        output_cost: 0.0002,
        total_cost: 0.0003,
        tool_calls_cost: 0.001,
        currency: 'USD'
      }
    },
    ...overrides
  }
}

function createSseStream(
  events: Array<{ event: string; data: unknown }>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        const chunk = `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
}

describe('PerplexityAdapter — Agent API Integration & Security', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('1. targets official Perplexity Agent API endpoint (/v1/agent) over HTTPS and never Chat Completions or proxy', async () => {
    const requestedUrls: string[] = []
    let capturedBody: Record<string, unknown> | undefined
    let capturedAuth: string | null = null

    const mockFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
      capturedAuth = new Headers(init?.headers).get('authorization')
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined
      return new Response(JSON.stringify(buildAgentResponseJson()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const adapter = new PerplexityAdapter({ fetch: mockFetch })
    const result = await adapter.generateText('pplx-test-secret-1234567890abcdef', {
      modelId: 'perplexity/sonar',
      systemPrompt: 'Follow KB hierarchy.',
      messages: [{ role: 'user', content: 'Summarize recent updates.' }]
    })

    expect(requestedUrls).toEqual([`${PERPLEXITY_OFFICIAL_BASE_URL}/v1/agent`])
    expect(requestedUrls[0]).not.toContain('/chat/completions')
    expect(requestedUrls[0]).not.toContain('gateway')
    expect(capturedAuth).toBe('Bearer pplx-test-secret-1234567890abcdef')
    expect(capturedBody?.model).toBe('perplexity/sonar')
    expect(capturedBody?.store).toBe(false)
    expect(capturedBody?.tools).toEqual([{ type: 'web_search' }])
    expect(result.text).toBe('Agent API verified response.')
    expect(result.usage).toEqual({
      promptTokens: 24,
      completionTokens: 12,
      totalTokens: 36
    })
    expect(result.providerCost).toEqual({
      inputTokensCost: 0.0001,
      outputTokensCost: 0.0002,
      totalCost: 0.0003,
      toolCallsCost: 0.001,
      currency: 'USD'
    })
    // Filters unsafe javascript: URL cleanly
    expect(result.webSources).toHaveLength(1)
    expect(result.webSources?.[0]?.url).toBe('https://docs.perplexity.ai/docs/agent-api/quickstart')
  })

  it('2. testConnection uses bounded minimal Agent API request with native tools disabled', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined
      return new Response(
        JSON.stringify(
          buildAgentResponseJson({
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'OK' }]
              }
            ]
          })
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    }

    const adapter = new PerplexityAdapter({ fetch: mockFetch })
    const res = await adapter.testConnection('pplx-test-secret-1234567890abcdef', 'fast')

    expect(res.success).toBe(true)
    expect(res.testedModelId).toBe('fast')
    expect(capturedBody?.preset).toBe('fast')
    expect(capturedBody?.max_output_tokens).toBe(16)
    expect(capturedBody?.max_tool_calls).toBe(0)
    expect(capturedBody?.store).toBe(false)
    expect(capturedBody?.tools).toBeUndefined()
    expect(res.discoveredModels?.length).toBeGreaterThanOrEqual(5)
    expect(res.discoveredModels?.every((m) => m.metadataSource === 'catalog')).toBe(true)
  })

  it('3. rejects non-HTTPS base URL configuration and blank API keys', async () => {
    expect(() => new PerplexityAdapter({ baseURL: 'http://api.perplexity.ai' })).toThrow(/HTTPS/i)

    const adapter = new PerplexityAdapter()
    const blankRes = await adapter.testConnection('   ')
    expect(blankRes.success).toBe(false)
    expect(blankRes.error?.code).toBe('AUTHENTICATION_FAILED')
  })

  it('4. supports Agent API presets and third-party routed model identifiers while disabling native tools when local ToolRegistry tools are supplied', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify(
          buildAgentResponseJson({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_kb_1',
                name: 'search_knowledge_base',
                arguments: JSON.stringify({ query: 'budget' })
              }
            ]
          })
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const adapter = new PerplexityAdapter({ fetch: mockFetch })
    const result = await adapter.generateText('pplx-agent-key-1234567890abcdef', {
      modelId: 'anthropic/claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Check KB budget' }],
      tools: [
        {
          name: 'search_knowledge_base',
          description: 'Search local KB',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ]
    })

    expect(capturedBodies[0]?.model).toBe('anthropic/claude-sonnet-4-5')
    expect(capturedBodies[0]?.store).toBe(false)
    // Native web_search / fetch_url / sandbox / mcp / connector MUST NOT be sent alongside local Agent tools
    const sentTools = (capturedBodies[0]?.tools as Array<Record<string, unknown>>) ?? []
    expect(sentTools).toHaveLength(1)
    expect(sentTools[0]?.type).toBe('function')
    expect(sentTools[0]?.name).toBe('search_knowledge_base')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls?.[0]?.name).toBe('search_knowledge_base')
  })

  it('5. streams SSE deltas, deduplicates HTTP/HTTPS webSources cleanly, and handles mid-stream response.failed errors', async () => {
    const successStream = createSseStream([
      {
        event: 'response.created',
        data: {
          type: 'response.created',
          sequence_number: 0,
          response: {
            id: 'resp_stream_1',
            created_at: 1760000000,
            object: 'response',
            status: 'in_progress',
            model: 'fast',
            output: []
          }
        }
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 1,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'Hello '
        }
      },
      {
        event: 'response.reasoning.search_results',
        data: {
          type: 'response.reasoning.search_results',
          sequence_number: 2,
          results: [
            {
              id: 1,
              title: 'Safe Source',
              url: 'https://example.com/research',
              snippet: 'Verified external link'
            },
            {
              id: 2,
              title: 'XSS Blocked',
              url: 'data:text/html,<script>alert(1)</script>',
              snippet: 'Rejected'
            }
          ]
        }
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 3,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'world.'
        }
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 4,
          response: {
            id: 'resp_stream_1',
            created_at: 1760000000,
            object: 'response',
            status: 'completed',
            model: 'fast',
            output: [],
            usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 }
          }
        }
      }
    ])

    const adapter = new PerplexityAdapter({
      fetch: async () =>
        new Response(successStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const ch of adapter.streamText('pplx-stream-secret-1234567890abcd', {
      modelId: 'fast',
      messages: [{ role: 'user', content: 'Stream check' }]
    })) {
      chunks.push(ch as { type: string; [k: string]: unknown })
    }

    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.textDelta)
    expect(deltas.join('')).toBe('Hello world.')
    const finishChunk = chunks.find((c) => c.type === 'finish')
    expect(finishChunk).toBeDefined()
    expect(finishChunk?.webSources).toHaveLength(1)
    expect((finishChunk?.webSources as Array<{ url: string }>)[0].url).toBe(
      'https://example.com/research'
    )

    // Mid-stream failure test
    const failStream = createSseStream([
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 0,
          item_id: 'msg_2',
          output_index: 0,
          content_index: 0,
          delta: 'Partial '
        }
      },
      {
        event: 'response.failed',
        data: {
          type: 'response.failed',
          sequence_number: 1,
          error: { message: 'Upstream failure with pplx-leak99999999999999999999' }
        }
      }
    ])

    const failAdapter = new PerplexityAdapter({
      fetch: async () =>
        new Response(failStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
    })
    const failChunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const ch of failAdapter.streamText('pplx-stream-secret-1234567890abcd', {
      modelId: 'fast',
      messages: [{ role: 'user', content: 'Fail stream' }]
    })) {
      failChunks.push(ch as { type: string; [k: string]: unknown })
    }
    expect(failChunks.some((c) => c.type === 'finish')).toBe(false)
    const errChunk = failChunks.find((c) => c.type === 'error')
    expect(errChunk).toBeDefined()
    expect(JSON.stringify(errChunk)).not.toContain('pplx-leak')
  })

  it('6. classifies Perplexity HTTP errors accurately and redacts pplx- secrets', () => {
    const rawKey = 'pplx-1234567890abcdefghijklmnopqrstuvwxyzABCD'
    const redacted = redactPerplexitySecrets(
      `Auth failed for key ${rawKey} Bearer pplx-abcdef1234567890`
    )
    expect(redacted).not.toContain(rawKey)
    expect(redacted).toContain('[REDACTED_KEY]')

    expect(sanitizePerplexityError({ statusCode: 401, message: rawKey }).code).toBe(
      'AUTHENTICATION_FAILED'
    )
    expect(sanitizePerplexityError({ statusCode: 403, message: 'insufficient credits' }).code).toBe(
      'PERMISSION_DENIED'
    )
    expect(sanitizePerplexityError({ statusCode: 429, message: 'rate limit' }).retryable).toBe(true)
    expect(sanitizePerplexityError({ statusCode: 503, message: 'down' }).code).toBe('SERVER_ERROR')
    expect(sanitizePerplexityError(new DOMException('timed out', 'TimeoutError')).code).toBe(
      'TIMEOUT'
    )
  })

  it('7. curated catalog marks metadataSource as catalog and distinguishes presets vs direct models', async () => {
    const models = getPerplexityCuratedCatalogModels()
    expect(models.length).toBeGreaterThanOrEqual(7)
    expect(PERPLEXITY_CURATED_MODEL_PROFILES['perplexity/sonar'].kind).toBe('direct_model')
    expect(PERPLEXITY_CURATED_MODEL_PROFILES['fast'].kind).toBe('agent_preset')
    expect(PERPLEXITY_CURATED_MODEL_PROFILES['openai/gpt-4o'].kind).toBe('third_party_routed')
    expect(models.every((m) => m.metadataSource === 'catalog')).toBe(true)

    // discoverModelMetadata never touches network or undocumented /models endpoints
    const fetchSpy = vi.fn()
    const adapter = new PerplexityAdapter({ fetch: fetchSpy as unknown as typeof fetch })
    const discovered = await adapter.discoverModelMetadata('pplx-1234567890abcdef123456')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(discovered.length).toBe(models.length)
  })
})
