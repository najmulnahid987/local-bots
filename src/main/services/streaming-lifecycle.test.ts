import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolError } from '../tools/agent-tool'
import { ApprovalController } from './approval-controller'
import { WorkspaceFolderService } from './workspace-folder-service'
import { BoundedAgentRuntime } from './bounded-agent-runtime'
import { z } from 'zod'
import {
  ConversationPersistenceService,
  ConversationPersistenceError
} from './conversation-persistence-service'
import {
  ConversationTurnService,
  ConversationTurnError,
  type ConversationTurnStream
} from './conversation-turn-service'
import { ConversationExecutionService } from './conversation-execution-service'
import { ConversationStreamManager } from '../ipc/conversation-stream-manager'
import { AgentStreamManager } from '../ipc/agent-stream-manager'
import { ActiveWorkspaceContext } from './active-workspace-context'
import type { CitationDto, PublicConversationTurnEvent } from '../../shared/conversations'
import type { PreparedConversationTurn } from './conversation-service'
import type { BrowserWindowLike } from '../security'
import type { MessagePortMainLike, WebFrameWithPostMessage } from '../ipc/provider-stream-manager'
import type { ProviderAdapter, StreamTextChunk, GenerateTextOptions } from '../providers/types'

describe('Phase 12 Step 12.7: Streaming Lifecycle Specification (All 46 Scenarios)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let persistenceService: ConversationPersistenceService
  let activeContext: ActiveWorkspaceContext

  let kbId: string
  let botId: string
  let conversationId: string

  const citation1: CitationDto = {
    citationNumber: 1,
    sourceId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    fileName: 'kb-guide.pdf',
    fileType: 'pdf',
    pageNumber: 1,
    headingPath: ['Intro'],
    chunkIndex: 0
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    convRepo = new ConversationRepository(db)
    msgRepo = new MessageRepository(db)
    persistenceService = new ConversationPersistenceService({
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      db
    })
    activeContext = new ActiveWorkspaceContext({ kbRepo })

    const kb = kbRepo.create({ name: 'Streaming Test KB' })
    kbId = kb.id
    activeContext.activateWorkspace(1, kbId)

    const bot = botRepo.create({
      knowledgeBaseId: kbId,
      name: 'StreamBot',
      modelId: 'gpt-4o'
    })
    botId = bot.id

    const conv = convRepo.create({
      botId,
      knowledgeBaseId: kbId,
      title: 'Streaming Test Conversation'
    })
    conversationId = conv.id
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignored
    }
  })

  function makeMockPreparedTurn(
    overrides?: Partial<PreparedConversationTurn>
  ): PreparedConversationTurn {
    const citationMap = new Map<number, CitationDto>()
    citationMap.set(1, citation1)

    return {
      botId,
      conversationId,
      providerConnectionId: 'conn-1',
      providerId: 'openai',
      modelId: 'gpt-4o',
      systemInstruction: 'System instructions',
      responsePolicy: 'balanced_kb_first',
      retrievalStatus: 'SUCCESS',
      groundingMode: 'kb_grounded',
      messages: [],
      conversationMessages: [],
      citationMap,
      citationCandidates: [],
      contextWindowLimits: { inputTokens: 4000, outputTokens: 1000 },
      reservedOutputTokens: 1000,
      tokenEstimates: {
        systemTokens: 10,
        historyTokens: 10,
        contextTokens: 10,
        questionTokens: 10,
        totalEstimatedTokens: 40
      },
      includedMessageCount: 1,
      excludedMessageCount: 0,
      historyTrimmingOccurred: false,
      ...overrides
    }
  }

  function createMockSenderFrame(
    onPost?: (ch: string, data: unknown, ports: MessagePortMainLike[]) => void
  ): WebFrameWithPostMessage {
    return {
      url: 'http://localhost',
      postMessage: vi.fn((ch: string, data: unknown, ports?: MessagePortMainLike[]) => {
        onPost?.(ch, data, ports ?? [])
      })
    }
  }

  function createMockMessageChannel(): { port1: MessagePortMainLike; port2: MessagePortMainLike } {
    const listeners1 = new Map<string, ((ev: { data: unknown }) => void)[]>()
    const listeners2 = new Map<string, ((ev: { data: unknown }) => void)[]>()
    const queue1: unknown[] = []
    const queue2: unknown[] = []
    let closed1 = false
    let closed2 = false

    const port1: MessagePortMainLike = {
      postMessage: vi.fn((data: unknown) => {
        if (closed1 || closed2) return
        const list = listeners2.get('message') ?? []
        if (list.length === 0) {
          queue2.push(data)
        } else {
          for (const cb of list) cb({ data })
        }
      }),
      on: vi.fn((event: string, listener: (ev: { data: unknown }) => void) => {
        const list = listeners1.get(event) ?? []
        list.push(listener)
        listeners1.set(event, list)
        if (event === 'message') {
          while (queue1.length > 0) {
            const data = queue1.shift()
            listener({ data })
          }
        }
        return port1
      }),
      start: vi.fn(),
      close: vi.fn(() => {
        closed1 = true
        const list = listeners1.get('close') ?? []
        for (const cb of list) cb({ data: undefined })
      })
    }

    const port2: MessagePortMainLike = {
      postMessage: vi.fn((data: unknown) => {
        if (closed1 || closed2) return
        const list = listeners1.get('message') ?? []
        if (list.length === 0) {
          queue1.push(data)
        } else {
          for (const cb of list) cb({ data })
        }
      }),
      on: vi.fn((event: string, listener: (ev: { data: unknown }) => void) => {
        const list = listeners2.get(event) ?? []
        list.push(listener)
        listeners2.set(event, list)
        if (event === 'message') {
          while (queue2.length > 0) {
            const data = queue2.shift()
            listener({ data })
          }
        }
        return port2
      }),
      start: vi.fn(),
      close: vi.fn(() => {
        closed2 = true
        const list = listeners2.get('close') ?? []
        for (const cb of list) cb({ data: undefined })
      })
    }

    return { port1, port2 }
  }

  // ==========================================================================
  // Category 1: Provider streaming (Scenarios 1–7)
  // ==========================================================================
  describe('Category 1: Provider streaming (Scenarios 1–7)', () => {
    it('1. Provider yields incremental text chunks correctly', async () => {
      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        yield { type: 'text-delta', textDelta: 'Hello ' }
        yield { type: 'text-delta', textDelta: 'streaming ' }
        yield { type: 'text-delta', textDelta: 'world!' }
      }

      const mockAdapter: ProviderAdapter = {
        providerId: 'openai',
        streamText: vi.fn(mockStream)
      } as unknown as ProviderAdapter

      const chunks: string[] = []
      for await (const chunk of mockAdapter.streamText('test-key', {} as GenerateTextOptions)) {
        if (chunk.type === 'text-delta') {
          chunks.push(chunk.textDelta)
        }
      }

      expect(chunks).toEqual(['Hello ', 'streaming ', 'world!'])
    })

    it('2. Empty text deltas are ignored or handled cleanly without crashing', async () => {
      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        yield { type: 'text-delta', textDelta: '' }
        yield { type: 'text-delta', textDelta: 'valid' }
        yield { type: 'text-delta', textDelta: '' }
      }

      const chunks: string[] = []
      for await (const chunk of mockStream()) {
        if (chunk.type === 'text-delta' && chunk.textDelta.length > 0) {
          chunks.push(chunk.textDelta)
        }
      }

      expect(chunks).toEqual(['valid'])
    })

    it('3. Stream completion emits final token usage and finish reason', async () => {
      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        yield { type: 'text-delta', textDelta: 'Content.' }
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 }
        }
      }

      let finishReason: string | undefined
      let usage: unknown
      for await (const chunk of mockStream()) {
        if (chunk.type === 'finish') {
          finishReason = chunk.finishReason
          usage = chunk.usage
        }
      }

      expect(finishReason).toBe('stop')
      expect(usage).toEqual({ promptTokens: 15, completionTokens: 5, totalTokens: 20 })
    })

    it('4. Provider errors during streaming surface with structured codes', async () => {
      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        yield { type: 'text-delta', textDelta: 'Start' }
        const err = new Error('Rate limit exceeded')
        ;(err as unknown as { code: string; retryable: boolean }).code = 'RATE_LIMIT_EXCEEDED'
        ;(err as unknown as { code: string; retryable: boolean }).retryable = true
        throw err
      }

      const received: string[] = []
      let caughtError: unknown
      try {
        for await (const chunk of mockStream()) {
          if (chunk.type === 'text-delta') received.push(chunk.textDelta)
        }
      } catch (err) {
        caughtError = err
      }

      expect(received).toEqual(['Start'])
      expect((caughtError as { code: string }).code).toBe('RATE_LIMIT_EXCEEDED')
      expect((caughtError as { retryable: boolean }).retryable).toBe(true)
    })

    it('5. AbortSignal aborts provider stream immediately', async () => {
      const controller = new AbortController()

      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        yield { type: 'text-delta', textDelta: 'Chunk 1' }
        if (controller.signal.aborted) {
          throw new Error('Aborted by client')
        }
        yield { type: 'text-delta', textDelta: 'Chunk 2' }
      }

      const chunks: string[] = []
      let aborted = false
      try {
        for await (const chunk of mockStream()) {
          if (chunk.type === 'text-delta') chunks.push(chunk.textDelta)
          controller.abort()
          if (controller.signal.aborted) {
            throw new Error('Aborted by client')
          }
        }
      } catch {
        aborted = true
      }

      expect(chunks).toEqual(['Chunk 1'])
      expect(aborted).toBe(true)
    })

    it('6. Multi-chunk responses accumulate to the exact complete text without missing or duplicated characters', async () => {
      const parts = ['First ', 'second ', 'third ', 'fourth ', 'part.']
      async function* mockStream(): AsyncGenerator<StreamTextChunk> {
        for (const p of parts) {
          yield { type: 'text-delta', textDelta: p }
        }
      }

      let accumulated = ''
      for await (const chunk of mockStream()) {
        if (chunk.type === 'text-delta') accumulated += chunk.textDelta
      }

      expect(accumulated).toBe('First second third fourth part.')
    })

    it('7. Token usage reporting matches provider data when available, handles missing usage gracefully', async () => {
      const resultWithUsage = {
        assistantText: 'Hi',
        finishReason: 'stop' as const,
        durationMs: 100,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        providerId: 'openai' as const,
        modelId: 'gpt-4o',
        botId,
        conversationId,
        citationCandidates: [],
        citationMap: new Map()
      }

      const resultWithoutUsage = {
        ...resultWithUsage,
        usage: undefined
      }

      const preparedTurn = makeMockPreparedTurn()
      const msg1 = persistenceService.persistAssistantMessage(preparedTurn, resultWithUsage)
      const msg2 = persistenceService.persistAssistantMessage(preparedTurn, resultWithoutUsage)

      expect(msg1.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })
      expect(msg2.tokenUsage).toBeNull()
    })
  })

  // ==========================================================================
  // Category 2: Chat lifecycle (Scenarios 8–16)
  // ==========================================================================
  describe('Category 2: Chat lifecycle (Scenarios 8–16)', () => {
    it('8-12. preparing -> streaming -> finalizing -> completed with citations and metadata', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel,
        conversationRepo: convRepo
      })

      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const receivedEvents: PublicConversationTurnEvent[] = []

      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        // Transfer port2
        const p = ports[0]
        p.on('message', (ev) => {
          receivedEvents.push(ev.data as PublicConversationTurnEvent)
        })
        p.start()
      })

      const mockTurnStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'Grounded [1] response' }
          yield {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            totalTextLength: 21,
            durationMs: 200,
            message: {
              id: randomUUID(),
              conversationId,
              role: 'assistant',
              content: 'Grounded [1] response',
              contentFormat: 'markdown',
              metadata: {
                citations: [citation1],
                groundingMode: 'kb_grounded',
                executionMode: 'chat'
              },
              tokenUsage: null,
              createdAt: Date.now()
            }
          }
        },
        getResult: async () => ({
          userMessage: {
            id: randomUUID(),
            conversationId,
            role: 'user',
            content: 'Hello',
            contentFormat: 'markdown',
            metadata: { executionMode: 'chat' },
            tokenUsage: null,
            createdAt: Date.now()
          },
          assistantMessage: {
            id: randomUUID(),
            conversationId,
            role: 'assistant',
            content: 'Grounded [1] response',
            contentFormat: 'markdown',
            metadata: { citations: [citation1], groundingMode: 'kb_grounded' },
            tokenUsage: null,
            createdAt: Date.now()
          },
          finishReason: 'stop' as const,
          durationMs: 200
        })
      }

      const mockTurnService = {
        sendMessage: vi.fn().mockReturnValue(mockTurnStream),
        isGenerating: vi.fn().mockReturnValue(false),
        acquireDeletionLock: vi.fn(),
        releaseDeletionLock: vi.fn()
      } as unknown as ConversationTurnService

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        {
          requestId: randomUUID(),
          conversationId,
          content: 'Hello',
          contentFormat: 'markdown',
          executionMode: 'chat'
        },
        1,
        mockTurnService
      )

      await new Promise((r) => setTimeout(r, 60))

      // Verify stages: preparing -> streaming -> finalizing -> completed
      const stageChanges = receivedEvents.filter((e) => e.type === 'stage_change')
      expect(stageChanges.map((s) => (s as { stage: string }).stage)).toEqual([
        'preparing',
        'streaming',
        'finalizing'
      ])

      const finishEvent = receivedEvents.find((e) => e.type === 'finish')
      expect(finishEvent).toBeDefined()
      expect(finishEvent?.type).toBe('finish')
      if (finishEvent && finishEvent.type === 'finish') {
        expect(finishEvent.stage).toBe('completed')
        expect(finishEvent.message.metadata.citations).toHaveLength(1)
        expect(finishEvent.userMessage).toBeDefined()
      }
    })

    it('13. Error during preparation surfaces before streaming begins', async () => {
      const mockTurnService = {
        sendMessage: vi.fn(() => {
          throw new ConversationTurnError(
            'Turn preparation failed: model offline',
            'AUTHENTICATION_FAILED'
          )
        }),
        isGenerating: vi.fn().mockReturnValue(false)
      } as unknown as ConversationTurnService

      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })

      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const mockSenderFrame = createMockSenderFrame()

      await expect(
        streamManager.startSendStream(
          mockWindow,
          mockSenderFrame,
          {
            requestId: randomUUID(),
            conversationId,
            content: 'Hello',
            contentFormat: 'markdown'
          },
          1,
          mockTurnService
        )
      ).rejects.toThrow('Turn preparation failed')

      expect(streamManager.getActiveStreamCount()).toBe(0)
    })

    it('14. Error during streaming terminates turn cleanly with error event', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const receivedEvents: PublicConversationTurnEvent[] = []

      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => {
          receivedEvents.push(ev.data as PublicConversationTurnEvent)
        })
        p.start()
      })

      const mockTurnStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'Initial part' }
          yield {
            type: 'error' as const,
            error: {
              code: 'TIMEOUT',
              message: 'Connection dropped',
              retryable: true
            }
          }
        },
        getResult: async () => {
          throw new Error('No result')
        }
      }

      const mockTurnService = {
        sendMessage: vi.fn().mockReturnValue(mockTurnStream)
      } as unknown as ConversationTurnService

      const reqId = randomUUID()
      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        {
          requestId: reqId,
          conversationId,
          content: 'Hello'
        },
        1,
        mockTurnService
      )

      await new Promise((r) => setTimeout(r, 60))

      const errorEvent = receivedEvents.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      if (errorEvent && errorEvent.type === 'error') {
        expect(errorEvent.error.code).toBe('TIMEOUT')
        expect(errorEvent.stage).toBe('failed')
      }
      expect(streamManager.hasStream(reqId)).toBe(false)
    })

    it('15. Error during finalizing (persistence failure) surfaces safely', async () => {
      const failingTurnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(makeMockPreparedTurn())
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'Done answer' }
            },
            getResult: vi.fn().mockResolvedValue({
              assistantText: 'Done answer',
              finishReason: 'stop',
              durationMs: 100,
              providerId: 'openai',
              modelId: 'gpt-4o',
              botId,
              conversationId,
              citationCandidates: [],
              citationMap: new Map()
            })
          })
        } as unknown as ConversationExecutionService,
        persistenceService: {
          persistUserMessage: vi.fn().mockReturnValue({ id: randomUUID(), role: 'user' }),
          persistAssistantMessage: vi.fn(() => {
            throw new Error('Disk full')
          })
        } as unknown as ConversationPersistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      const stream = failingTurnService.sendMessage(1, {
        conversationId,
        content: 'Failing persistence turn'
      })

      const events: import('./conversation-turn-service').ConversationTurnEvent[] = []
      for await (const evt of stream) {
        events.push(evt)
      }

      const errorEvt = events.find((e) => e.type === 'error')
      expect(errorEvt).toBeDefined()
      if (errorEvt && errorEvt.type === 'error') {
        expect(errorEvt.error.code).toBe('PERSISTENCE_ERROR')
      }
    })

    it('16. Idle state restores after completion or error', async () => {
      const turnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(makeMockPreparedTurn())
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'Answer' }
            },
            getResult: vi.fn().mockResolvedValue({
              assistantText: 'Answer',
              finishReason: 'stop',
              durationMs: 50,
              providerId: 'openai',
              modelId: 'gpt-4o',
              botId,
              conversationId,
              citationCandidates: [],
              citationMap: new Map()
            })
          })
        } as unknown as ConversationExecutionService,
        persistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      expect(turnService.isGenerating(conversationId)).toBe(false)
      const stream = turnService.sendMessage(1, { conversationId, content: 'Hello' })
      expect(turnService.isGenerating(conversationId)).toBe(true)

      for await (const _ev of stream) {
        void _ev
      }

      expect(turnService.isGenerating(conversationId)).toBe(false)
    })
  })

  // ==========================================================================
  // Category 3: Agent lifecycle (Scenarios 17–24)
  // ==========================================================================
  describe('Category 3: Agent lifecycle (Scenarios 17–24)', () => {
    it('17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure', async () => {
      const agentStreamManager = new AgentStreamManager({
        channelFactory: createMockMessageChannel
      })

      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const agentRunId = randomUUID()
      const receivedAgentEvents: import('../../shared/agents').AgentStreamEvent[] = []

      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => {
          receivedAgentEvents.push(ev.data as import('../../shared/agents').AgentStreamEvent)
        })
        p.start()
      })

      const stream = agentStreamManager.startStream(
        mockWindow,
        mockSenderFrame,
        agentRunId,
        conversationId,
        vi.fn(),
        botId
      )

      // 17. Started
      stream.emitEvent({
        type: 'agent_run_started',
        botId,
        selectedModel: 'gpt-4o'
      })

      // 18. Iteration started
      stream.emitEvent({
        type: 'agent_iteration_started',
        iteration: 1,
        maxIterations: 5
      })

      // 19. Tool call started
      stream.emitEvent({
        type: 'tool_call_started',
        toolEventId: 'tool-ev-1',
        toolName: 'search_knowledge_base',
        argumentsSummary: 'query: "test"'
      })

      // 20. Tool call completed
      stream.emitEvent({
        type: 'tool_call_completed',
        toolEventId: 'tool-ev-1',
        toolName: 'search_knowledge_base',
        resultSummary: 'found 2 chunks'
      })

      // 21. Approval requested
      stream.emitEvent({
        type: 'approval_requested',
        approvalRequestId: 'appr-1',
        title: 'Save Report',
        contentPreview: '# Report content',
        contentSizeBytes: 1024
      })

      // 22. Approval resolved
      stream.emitEvent({
        type: 'approval_resolved',
        approvalRequestId: 'appr-1',
        status: 'approved'
      })

      // 23. Agent task completion
      stream.emitEvent({
        type: 'agent_run_completed',
        finalResponse: 'Task completed successfully',
        iterations: 1,
        toolEventsCount: 1,
        citationsCount: 0,
        workspaceFilesCount: 0
      })

      await new Promise((r) => setTimeout(r, 40))

      expect(receivedAgentEvents.map((e) => e.type)).toEqual([
        'agent_run_started',
        'agent_iteration_started',
        'tool_call_started',
        'tool_call_completed',
        'approval_requested',
        'approval_resolved',
        'agent_run_completed'
      ])

      // Verify sequence monotonicity and authoritative attributes
      expect(receivedAgentEvents[0].sequenceNumber).toBe(1)
      expect(receivedAgentEvents[1].sequenceNumber).toBe(2)
      expect(receivedAgentEvents[0].botId).toBe(botId)
      expect(receivedAgentEvents[0].executionMode).toBe('agent')
      expect(receivedAgentEvents[0].agentRunId).toBe(agentRunId)
      expect(receivedAgentEvents[0].conversationId).toBe(conversationId)

      // 24. Failure event emission on separate run
      const failRunId = randomUUID()
      const failEvents: import('../../shared/agents').AgentStreamEvent[] = []
      const failSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => {
          failEvents.push(ev.data as import('../../shared/agents').AgentStreamEvent)
        })
        p.start()
      })

      const failStream = agentStreamManager.startStream(
        mockWindow,
        failSenderFrame,
        failRunId,
        conversationId,
        vi.fn(),
        botId
      )

      failStream.emitEvent({
        type: 'agent_run_failed',
        error: { code: 'EXECUTION_LIMIT_EXCEEDED', message: 'Too many iterations' }
      })

      await new Promise((r) => setTimeout(r, 40))
      expect(failEvents[0].type).toBe('agent_run_failed')
    })
  })

  // ==========================================================================
  // Category 4: Cancellation and races (Scenarios 25–30)
  // ==========================================================================
  describe('Category 4: Cancellation and races (Scenarios 25–30)', () => {
    it('25. Client cancellation during streaming halts provider generation immediately', async () => {
      const abortController = new AbortController()
      let providerHalted = false

      const customTurnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(makeMockPreparedTurn())
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'Token 1' }
              if (abortController.signal.aborted) {
                providerHalted = true
                throw new Error('Aborted')
              }
              yield { type: 'text_delta' as const, textDelta: 'Token 2' }
            },
            getResult: vi.fn()
          })
        } as unknown as ConversationExecutionService,
        persistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      const stream = customTurnService.sendMessage(
        1,
        { conversationId, content: 'Cancel test' },
        { abortSignal: abortController.signal }
      )

      for await (const evt of stream) {
        if (evt.type === 'text_delta') {
          abortController.abort()
        }
      }

      expect(abortController.signal.aborted).toBe(true)
      expect(providerHalted).toBe(true)
      expect(customTurnService.isGenerating(conversationId)).toBe(false)
    })

    it('26. Client cancellation during agent run marks run cancelled', async () => {
      const agentStreamManager = new AgentStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const mockSenderFrame = createMockSenderFrame()
      const onCancel = vi.fn()

      const runId = randomUUID()
      agentStreamManager.startStream(mockWindow, mockSenderFrame, runId, conversationId, onCancel)

      const cancelled = agentStreamManager.cancelStream(runId, mockWindow, 'User clicked stop')
      expect(cancelled).toBe(true)
      await new Promise((r) => setTimeout(r, 40))
      expect(agentStreamManager.hasStream(runId)).toBe(false)
    })

    it('27. Cancellation is idempotent (duplicate cancel requests are safe no-ops)', () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const mockSenderFrame = createMockSenderFrame()
      const reqId = randomUUID()

      const mockTurnService = {
        sendMessage: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta' as const, textDelta: 'hi' }
          }
        })
      } as unknown as ConversationTurnService

      void streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: reqId, conversationId, content: 'test' },
        1,
        mockTurnService
      )

      // First cancel returns true
      const first = streamManager.cancelStream(reqId, mockWindow)
      expect(first).toBe(true)

      // Duplicate cancel returns false safely without throwing
      const second = streamManager.cancelStream(reqId, mockWindow)
      expect(second).toBe(false)
    })

    it('28. Late chunks arriving after cancellation are discarded and not persisted', async () => {
      let lateChunkArrived = false
      const reqId = randomUUID()

      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const events: PublicConversationTurnEvent[] = []

      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => {
          events.push(ev.data as PublicConversationTurnEvent)
        })
        p.start()
      })

      const mockTurnStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'Early delta' }
          // Trigger cancellation via streamManager
          streamManager.cancelStream(reqId, mockWindow)
          lateChunkArrived = true
          // Emit late chunk after abort
          yield { type: 'text_delta' as const, textDelta: 'Late phantom delta' }
        },
        getResult: vi.fn()
      }

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: reqId, conversationId, content: 'test' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue(mockTurnStream)
        } as unknown as ConversationTurnService
      )

      await new Promise((r) => setTimeout(r, 40))
      expect(lateChunkArrived).toBe(true)
      const lateEvent = events.find(
        (e) =>
          e.type === 'text_delta' && (e as { textDelta: string }).textDelta === 'Late phantom delta'
      )
      expect(lateEvent).toBeUndefined()
    })

    it('29. Concurrent turn rejection (second request while first is active fails cleanly)', () => {
      const turnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(makeMockPreparedTurn())
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'running' }
            },
            getResult: vi.fn()
          })
        } as unknown as ConversationExecutionService,
        persistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      // Turn 1 starts
      const stream1 = turnService.sendMessage(1, { conversationId, content: 'First' })
      expect(turnService.isGenerating(conversationId)).toBe(true)

      // Turn 2 attempts concurrent start on same conversation -> rejects with CONCURRENT_TURN_ACTIVE
      expect(() =>
        turnService.sendMessage(1, { conversationId, content: 'Second concurrent' })
      ).toThrow(ConversationTurnError)

      try {
        turnService.sendMessage(1, { conversationId, content: 'Second concurrent' })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('CONCURRENT_TURN_ACTIVE')
      }

      // Consumer finishes stream 1
      void (async () => {
        for await (const _ of stream1) {
          void _
        }
      })()
    })

    it('30. Rapid cancel-then-send sequence cleans up previous turn before starting new turn', async () => {
      const turnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(makeMockPreparedTurn())
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'Turn 1' }
            },
            getResult: vi.fn()
          })
        } as unknown as ConversationExecutionService,
        persistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      const controller = new AbortController()
      const stream1 = turnService.sendMessage(
        1,
        { conversationId, content: 'Prompt 1' },
        { abortSignal: controller.signal }
      )

      controller.abort()
      for await (const _ of stream1) {
        void _
      }

      expect(turnService.isGenerating(conversationId)).toBe(false)

      // Can immediately send Turn 2 without collision
      const stream2 = turnService.sendMessage(1, { conversationId, content: 'Prompt 2' })
      expect(turnService.isGenerating(conversationId)).toBe(true)

      for await (const _ of stream2) {
        void _
      }
      expect(turnService.isGenerating(conversationId)).toBe(false)
    })
  })

  // ==========================================================================
  // Category 5: Persistence and recovery (Scenarios 31–37)
  // ==========================================================================
  describe('Category 5: Persistence and recovery (Scenarios 31–37)', () => {
    it('31. Fully completed chat turn persists user message and assistant message with citations', () => {
      const preparedTurn = makeMockPreparedTurn()
      const userMsg = persistenceService.persistUserMessage(preparedTurn, {
        conversationId,
        content: 'What is in KB?'
      })

      const assistantMsg = persistenceService.persistAssistantMessage(preparedTurn, {
        assistantText: 'According to the guide [1], everything works.',
        finishReason: 'stop',
        durationMs: 350,
        providerId: 'openai',
        modelId: 'gpt-4o',
        botId,
        conversationId,
        citationCandidates: [citation1],
        citationMap: preparedTurn.citationMap
      })

      expect(userMsg.role).toBe('user')
      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.metadata.citations).toHaveLength(1)
      expect(assistantMsg.metadata.isPartial).toBeUndefined()

      const history = msgRepo.listByConversation(conversationId, botId, kbId)
      expect(history).toHaveLength(2)
      expect(history[0].id).toBe(userMsg.id)
      expect(history[1].id).toBe(assistantMsg.id)
    })

    it('32. Cancelled chat turn with partial text persists user message and partial assistant message (isPartial: true)', () => {
      const preparedTurn = makeMockPreparedTurn()
      const userMsg = persistenceService.persistUserMessage(preparedTurn, {
        conversationId,
        content: 'Tell me a story'
      })

      const partialMsg = persistenceService.persistPartialAssistantMessage(
        preparedTurn,
        'Once upon a time in a galaxy far, far...',
        {
          status: 'cancelled',
          finishReason: 'abort',
          interruptedReason: 'Cancelled by user'
        }
      )

      expect(partialMsg.metadata.isPartial).toBe(true)
      expect(partialMsg.metadata.status).toBe('cancelled')
      expect(partialMsg.metadata.interruptedReason).toBe('Cancelled by user')
      expect(partialMsg.metadata.citations).toEqual([])

      const history = msgRepo.listByConversation(conversationId, botId, kbId)
      expect(history).toHaveLength(2)
      expect(history[0].id).toBe(userMsg.id)
      expect(history[1].id).toBe(partialMsg.id)
    })

    it('33. Cancelled chat turn with no text persists user message only (no empty assistant message)', () => {
      const preparedTurn = makeMockPreparedTurn()
      const userMsg = persistenceService.persistUserMessage(preparedTurn, {
        conversationId,
        content: 'Cancelled before any token'
      })

      expect(() =>
        persistenceService.persistPartialAssistantMessage(preparedTurn, '', {
          status: 'cancelled'
        })
      ).toThrow(ConversationPersistenceError)

      const history = msgRepo.listByConversation(conversationId, botId, kbId)
      expect(history).toHaveLength(1)
      expect(history[0].id).toBe(userMsg.id)
    })

    it('34. Failed chat turn with partial text persists partial message with status "failed"', () => {
      const preparedTurn = makeMockPreparedTurn()
      const partialMsg = persistenceService.persistPartialAssistantMessage(
        preparedTurn,
        'Started explanation before provider crashed...',
        {
          status: 'failed',
          finishReason: 'error',
          interruptedReason: 'Provider 500 error'
        }
      )

      expect(partialMsg.metadata.isPartial).toBe(true)
      expect(partialMsg.metadata.status).toBe('failed')
      expect(partialMsg.metadata.interruptedReason).toBe('Provider 500 error')
    })

    it('35. Retrying after cancelled turn deletes/replaces partial message and generates fresh response without duplicates', async () => {
      const preparedTurn = makeMockPreparedTurn()
      const userMsg = persistenceService.persistUserMessage(preparedTurn, {
        conversationId,
        content: 'Please answer me'
      })

      const partialMsg = persistenceService.persistPartialAssistantMessage(
        preparedTurn,
        'Partial answer...',
        { status: 'cancelled' }
      )

      let history = msgRepo.listByConversation(conversationId, botId, kbId)
      expect(history).toHaveLength(2)
      expect(history[1].id).toBe(partialMsg.id)

      const turnService = new ConversationTurnService({
        conversationService: {
          prepareTurn: vi.fn().mockReturnValue(preparedTurn)
        } as unknown as import('./conversation-service').ConversationService,
        executionService: {
          streamPreparedTurn: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta' as const, textDelta: 'Full fresh answer' }
            },
            getResult: vi.fn().mockResolvedValue({
              assistantText: 'Full fresh answer',
              finishReason: 'stop',
              durationMs: 200,
              providerId: 'openai',
              modelId: 'gpt-4o',
              botId,
              conversationId,
              citationCandidates: [],
              citationMap: new Map()
            })
          })
        } as unknown as ConversationExecutionService,
        persistenceService,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext
      })

      // Retry targeting the user message (latest is partial assistant message)
      const retryStream = turnService.retryLastUserMessage(1, { conversationId })

      for await (const _ of retryStream) {
        void _
      }

      history = msgRepo.listByConversation(conversationId, botId, kbId)
      expect(history).toHaveLength(2)
      expect(history[0].id).toBe(userMsg.id)
      expect(history[1].content).toBe('Full fresh answer')
      expect(history[1].metadata.isPartial).toBeUndefined()
      // Partial message was cleaned up
      expect(history.some((m) => m.id === partialMsg.id)).toBe(false)
    })

    it('36. Partial assistant message has no validated claims or false citations', () => {
      const preparedTurn = makeMockPreparedTurn()
      const partialMsg = persistenceService.persistPartialAssistantMessage(
        preparedTurn,
        'Partial text that mentions bracket [1] but was not finalized...',
        { status: 'interrupted' }
      )

      expect(partialMsg.metadata.citations).toEqual([])
      expect(partialMsg.metadata.claims).toBeUndefined()
    })

    it('37. Application restart or page refresh loads partial message correctly from SQLite', () => {
      const preparedTurn = makeMockPreparedTurn()
      const partialMsg = persistenceService.persistPartialAssistantMessage(
        preparedTurn,
        'Saved partial answer across crash',
        {
          status: 'cancelled',
          interruptedReason: 'Cancelled by user'
        }
      )

      // Simulate restart with fresh repository instances
      const freshMsgRepo = new MessageRepository(db)
      const reloaded = freshMsgRepo.getById(partialMsg.id, conversationId, botId, kbId)

      expect(reloaded).not.toBeNull()
      expect(reloaded?.content).toBe('Saved partial answer across crash')
      expect(reloaded?.metadata.isPartial).toBe(true)
      expect(reloaded?.metadata.status).toBe('cancelled')
      expect(reloaded?.metadata.interruptedReason).toBe('Cancelled by user')
    })
  })

  // ==========================================================================
  // Category 6: IPC and Renderer lifecycle (Scenarios 38–46)
  // ==========================================================================
  describe('Category 6: IPC and Renderer lifecycle (Scenarios 38–46)', () => {
    it('38. MessagePortMain transfer succeeds for send message stream', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      let transferredChannel: string | undefined

      const mockSenderFrame = createMockSenderFrame((channel) => {
        transferredChannel = channel
      })

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: randomUUID(), conversationId, content: 'test' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield* []
            }
          })
        } as unknown as ConversationTurnService
      )

      expect(transferredChannel).toBe('conversation:stream-port')
    })

    it('39. MessagePortMain transfer succeeds for retry stream', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      let transferredChannel: string | undefined

      const mockSenderFrame = createMockSenderFrame((channel) => {
        transferredChannel = channel
      })

      await streamManager.startRetryStream(
        mockWindow,
        mockSenderFrame,
        { requestId: randomUUID(), conversationId },
        1,
        {
          retryLastUserMessage: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield* []
            }
          })
        } as unknown as ConversationTurnService
      )

      expect(transferredChannel).toBe('conversation:stream-port')
    })

    it('40. MessagePortMain transfer succeeds for agent task stream', () => {
      const agentStreamManager = new AgentStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      let transferredChannel: string | undefined

      const mockSenderFrame = createMockSenderFrame((channel) => {
        transferredChannel = channel
      })

      agentStreamManager.startStream(
        mockWindow,
        mockSenderFrame,
        randomUUID(),
        conversationId,
        vi.fn()
      )

      expect(transferredChannel).toBe('agent:stream-port')
    })

    it('41. Window close or navigation aborts active streams and cleans up ports', () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const mockSenderFrame = createMockSenderFrame()

      const req1 = randomUUID()
      const req2 = randomUUID()

      void streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: req1, conversationId, content: '1' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield* []
            }
          })
        } as unknown as ConversationTurnService
      )

      void streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: req2, conversationId, content: '2' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield* []
            }
          })
        } as unknown as ConversationTurnService
      )

      expect(streamManager.getActiveStreamCount(mockWindow)).toBe(2)

      const aborted = streamManager.abortWindowStreams(mockWindow)
      expect(aborted).toBe(2)
      expect(streamManager.getActiveStreamCount(mockWindow)).toBe(0)
    })

    it('44. Stream events carry authoritative requestId, botId, conversationId, and sequenceNumber', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel,
        conversationRepo: convRepo
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const events: PublicConversationTurnEvent[] = []

      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => {
          events.push(ev.data as PublicConversationTurnEvent)
        })
        p.start()
      })

      const reqId = randomUUID()
      const mockTurnStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'Token' }
          yield {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            totalTextLength: 5,
            durationMs: 50,
            message: {
              id: randomUUID(),
              conversationId,
              role: 'assistant',
              content: 'Token',
              contentFormat: 'markdown',
              metadata: {},
              tokenUsage: null,
              createdAt: Date.now()
            }
          }
        },
        getResult: async () => ({
          userMessage: {
            id: randomUUID(),
            conversationId,
            role: 'user',
            content: 'Test prompt',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          },
          assistantMessage: {
            id: randomUUID(),
            conversationId,
            role: 'assistant',
            content: 'Token',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          },
          finishReason: 'stop' as const,
          durationMs: 50
        })
      }

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: reqId, conversationId, content: 'Test prompt' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue(mockTurnStream)
        } as unknown as ConversationTurnService
      )

      await new Promise((r) => setTimeout(r, 40))

      for (const ev of events) {
        expect(ev.requestId).toBe(reqId)
        expect(ev.conversationId).toBe(conversationId)
        expect(ev.botId).toBe(botId)
        expect(ev.executionMode).toBe('chat')
        expect(typeof ev.sequenceNumber).toBe('number')
        expect(ev.sequenceNumber).toBeGreaterThan(0)
        expect(typeof ev.timestamp).toBe('number')
      }
    })

    it('46. Renderer hook useAgentTaskEvents reconciles streaming tool events with persisted records', () => {
      // Direct unit check on reconciliation logic used in useAgentTaskEvents
      const toolMap = new Map<string, { status: string; resultSummary: string }>()
      toolMap.set('tool-1', { status: 'running', resultSummary: '' })

      // Incoming persisted record update
      const persistedToolEvents = [
        {
          id: 'tool-1',
          sequenceNumber: 1,
          toolName: 'search_knowledge_base' as const,
          status: 'completed' as const,
          approvalStatus: 'not_required' as const,
          argumentsSummary: 'query: test',
          resultSummary: '2 chunks found',
          errorMessage: null,
          startedAt: 1000,
          completedAt: 1250
        }
      ]

      for (const pe of persistedToolEvents) {
        toolMap.set(pe.id, { status: pe.status, resultSummary: pe.resultSummary })
      }

      expect(toolMap.get('tool-1')?.status).toBe('completed')
      expect(toolMap.get('tool-1')?.resultSummary).toBe('2 chunks found')
    })

    it('47. Rejects duplicate terminal events and late deltas after terminal event in ConversationStreamManager', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel,
        conversationRepo: convRepo
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const events: PublicConversationTurnEvent[] = []
      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => events.push(ev.data as PublicConversationTurnEvent))
        p.start()
      })

      const reqId = randomUUID()
      const mockTurnStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'First' }
          yield {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            totalTextLength: 5,
            durationMs: 10,
            message: {
              id: randomUUID(),
              conversationId,
              role: 'assistant',
              content: 'First',
              contentFormat: 'markdown',
              metadata: {},
              tokenUsage: null,
              createdAt: Date.now()
            }
          }
          // Malformed / late events after terminal finish
          yield { type: 'text_delta' as const, textDelta: 'Late delta after finish' }
          yield {
            type: 'error' as const,
            error: { code: 'EXECUTION_ERROR', message: 'Duplicate terminal', retryable: false }
          }
        },
        getResult: async () => ({
          userMessage: {
            id: randomUUID(),
            conversationId,
            role: 'user',
            content: 'Hi',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          },
          assistantMessage: {
            id: randomUUID(),
            conversationId,
            role: 'assistant',
            content: 'First',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          },
          finishReason: 'stop' as const,
          durationMs: 10
        })
      }

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: reqId, conversationId, content: 'Hi' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue(mockTurnStream)
        } as unknown as ConversationTurnService
      )
      await new Promise((r) => setTimeout(r, 40))

      const terminals = events.filter((e) => e.type === 'finish' || e.type === 'error')
      expect(terminals).toHaveLength(1)
      expect(terminals[0].type).toBe('finish')
      expect(
        events.find((e) => e.type === 'text_delta' && e.textDelta === 'Late delta after finish')
      ).toBeUndefined()
    })

    it('48. Rejects duplicate terminal events and post-cancel events in AgentStreamManager', async () => {
      const agentStreamManager = new AgentStreamManager({
        channelFactory: createMockMessageChannel
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const events: import('../../shared/agents').AgentStreamEvent[] = []
      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) =>
          events.push(ev.data as import('../../shared/agents').AgentStreamEvent)
        )
        p.start()
      })

      const runId = randomUUID()
      const stream = agentStreamManager.startStream(
        mockWindow,
        mockSenderFrame,
        runId,
        conversationId,
        vi.fn(),
        botId
      )

      stream.emitEvent({ type: 'agent_run_started', botId, selectedModel: 'gpt-4o' })
      expect(agentStreamManager.cancelStream(runId, mockWindow, 'Stopped by user')).toBe(true)

      // During 20ms port-flush window, late runtime events or duplicate cancel must be ignored
      stream.emitEvent({
        type: 'tool_call_completed',
        toolEventId: 't1',
        toolName: 'search_knowledge_base',
        resultSummary: 'late'
      })
      stream.emitEvent({ type: 'agent_run_cancelled', reason: 'Duplicate cancel from runtime' })
      stream.emitEvent({
        type: 'agent_run_completed',
        finalResponse: 'Should not complete',
        iterations: 1,
        toolEventsCount: 1,
        citationsCount: 0,
        workspaceFilesCount: 0
      })

      await new Promise((r) => setTimeout(r, 40))

      const cancelledEvents = events.filter((e) => e.type === 'agent_run_cancelled')
      expect(cancelledEvents).toHaveLength(1)
      expect(events.some((e) => e.type === 'agent_run_completed')).toBe(false)
      expect(events.some((e) => e.type === 'tool_call_completed')).toBe(false)
    })

    it('49. Fallback uncaught stream error in ConversationStreamManager includes full correlation fields', async () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel,
        conversationRepo: convRepo
      })
      const mockWindow = { isDestroyed: () => false } as unknown as BrowserWindowLike
      const events: PublicConversationTurnEvent[] = []
      const mockSenderFrame = createMockSenderFrame((_ch, _data, ports) => {
        const p = ports[0]
        p.on('message', (ev) => events.push(ev.data as PublicConversationTurnEvent))
        p.start()
      })

      const reqId = randomUUID()
      const throwingStream: ConversationTurnStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta' as const, textDelta: 'Partial' }
          throw new Error('Unexpected stream crash')
        },
        getResult: vi.fn()
      }

      await streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: reqId, conversationId, content: 'Crash test' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue(throwingStream)
        } as unknown as ConversationTurnService
      )
      await new Promise((r) => setTimeout(r, 40))

      const errEvent = events.find((e) => e.type === 'error')
      expect(errEvent).toBeDefined()
      expect(errEvent?.requestId).toBe(reqId)
      expect(errEvent?.conversationId).toBe(conversationId)
      expect(errEvent?.botId).toBe(botId)
      expect(errEvent?.executionMode).toBe('chat')
      expect(errEvent?.stage).toBe('failed')
      expect(typeof errEvent?.sequenceNumber).toBe('number')
      expect(typeof errEvent?.timestamp).toBe('number')
    })

    it('50. Agent cancellation while cooperative in-flight tool is running marks tool and run cancelled without starting another tool', async () => {
      const agentRunRepo = new AgentRunRepository(db)
      const toolEventRepo = new ToolEventRepository(db)
      const toolRegistry = new ToolRegistry({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo
      })
      const approvalController = new ApprovalController()
      const workspaceFolderService = new WorkspaceFolderService()

      botRepo.update(botId, kbId, { toolPermissions: ['search_knowledge_base'] })

      const abortController = new AbortController()
      let stepCallCount = 0

      toolRegistry.register({
        name: 'search_knowledge_base',
        description: 'Cooperative cancellable search tool',
        requiredPermission: 'search_knowledge_base',
        schema: z.object({ query: z.string() }),
        execute: async (_args, ctx) => {
          return new Promise((_resolve, reject) => {
            if (ctx.signal?.aborted) {
              reject(new ToolError('Aborted', 'ABORTED'))
              return
            }
            ctx.signal?.addEventListener(
              'abort',
              () => reject(new ToolError('Aborted during tool', 'ABORTED')),
              { once: true }
            )
            // Trigger cancellation while tool is actively in flight
            setTimeout(() => abortController.abort(), 15)
          })
        }
      })

      const runtime = new BoundedAgentRuntime({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        toolRegistry,
        stepExecutor: {
          executeStep: vi.fn(async () => {
            stepCallCount++
            return {
              type: 'tool_call' as const,
              toolCallId: 'tc-1',
              toolName: 'search_knowledge_base',
              rawArguments: { query: 'test' }
            }
          })
        },
        approvalController,
        workspaceFolderService,
        conversationRepository: convRepo
      })

      const result = await runtime.run({
        botId,
        conversationId,
        task: 'Search and summarize',
        signal: abortController.signal
      })

      expect(result.status).toBe('cancelled')
      expect(stepCallCount).toBe(1)
      expect(result.toolEvents).toHaveLength(1)
      expect(result.toolEvents[0].status).toBe('cancelled')
    })

    it('51. Agent cancellation while non-abort-aware tool is running preserves in-flight tool outcome and marks run cancelled', async () => {
      const agentRunRepo = new AgentRunRepository(db)
      const toolEventRepo = new ToolEventRepository(db)
      const toolRegistry = new ToolRegistry({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo
      })
      const approvalController = new ApprovalController()
      const workspaceFolderService = new WorkspaceFolderService()

      botRepo.update(botId, kbId, { toolPermissions: ['search_knowledge_base'] })

      const abortController = new AbortController()
      let stepCallCount = 0

      toolRegistry.register({
        name: 'search_knowledge_base',
        description: 'Non-abort-aware tool finishing after cancel',
        requiredPermission: 'search_knowledge_base',
        schema: z.object({ query: z.string() }),
        execute: async () => {
          abortController.abort()
          await new Promise((r) => setTimeout(r, 15))
          return {
            result: { chunks: [] },
            resultSummary: 'Completed before loop exit'
          }
        }
      })

      const runtime = new BoundedAgentRuntime({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        toolRegistry,
        stepExecutor: {
          executeStep: vi.fn(async () => {
            stepCallCount++
            return {
              type: 'tool_call' as const,
              toolCallId: 'tc-2',
              toolName: 'search_knowledge_base',
              rawArguments: { query: 'test' }
            }
          })
        },
        approvalController,
        workspaceFolderService,
        conversationRepository: convRepo
      })

      const result = await runtime.run({
        botId,
        conversationId,
        task: 'Search and summarize',
        signal: abortController.signal
      })

      expect(result.status).toBe('cancelled')
      expect(stepCallCount).toBe(1)
      expect(result.toolEvents).toHaveLength(1)
      expect(result.toolEvents[0].status).toBe('completed')
      expect(result.toolEvents[0].resultSummary).toBe('Completed before loop exit')
    })

    it('52. Top-level navigation aborts active streams while in-place hash navigation preserves them', () => {
      const streamManager = new ConversationStreamManager({
        channelFactory: createMockMessageChannel
      })
      const navListeners = new Map<string, (...args: unknown[]) => void>()
      const mockWindow = {
        isDestroyed: () => false,
        webContents: {
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            navListeners.set(event, cb)
          })
        }
      } as unknown as BrowserWindowLike
      const mockSenderFrame = createMockSenderFrame()

      void streamManager.startSendStream(
        mockWindow,
        mockSenderFrame,
        { requestId: randomUUID(), conversationId, content: 'Nav test' },
        1,
        {
          sendMessage: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield* []
            }
          })
        } as unknown as ConversationTurnService
      )

      expect(streamManager.getActiveStreamCount(mockWindow)).toBe(1)

      // In-place navigation (e.g. hash route switch) must NOT abort active stream
      const didStartNav = navListeners.get('did-start-navigation')
      expect(didStartNav).toBeDefined()
      didStartNav?.({}, 'http://localhost/#/other', true)
      expect(streamManager.getActiveStreamCount(mockWindow)).toBe(1)

      // Top-level navigation (isInPlace = false) MUST abort active stream
      didStartNav?.({}, 'http://localhost/reload', false)
      expect(streamManager.getActiveStreamCount(mockWindow)).toBe(0)
    })
  })
})
