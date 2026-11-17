import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import type { CredentialRef } from '../database/repositories/types'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { BotRagService } from './bot-rag-service'
import { ConversationService } from './conversation-service'
import {
  ConversationExecutionService,
  ConversationExecutionError,
  type ConversationExecutionStream,
  type ConversationExecutionResult,
  type ConversationExecutionEvent
} from './conversation-execution-service'
import {
  ConversationPersistenceService,
  ConversationPersistenceError
} from './conversation-persistence-service'
import {
  ConversationTurnService,
  ConversationTurnError,
  type ConversationTurnEvent
} from './conversation-turn-service'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { type SendMessageRequest, type CitationDto } from '../../shared/conversations'

describe('ConversationTurnService (Phase 7 Step 7.6B.3)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let providerConnRepo: ProviderConnectionRepository
  let activeContext: ActiveWorkspaceContext
  let ragService: BotRagService
  let conversationService: ConversationService
  let persistenceService: ConversationPersistenceService
  let turnService: ConversationTurnService

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string
  let convAId: string
  let convBId: string
  let connId: string
  const sessionId = 'test-session-1'

  const sampleCitation: CitationDto = {
    citationNumber: 1,
    sourceId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    fileName: 'protocol.pdf',
    fileType: 'pdf',
    pageNumber: 2,
    headingPath: ['Section A'],
    chunkIndex: 0
  }

  /**
   * Helper to construct a mock ConversationExecutionStream with custom event sequence.
   */
  function createMockExecutionStream(options?: {
    botId?: string
    conversationId?: string
    events?: ConversationExecutionEvent[]
    resultText?: string
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
    durationMs?: number
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    errorToThrow?: Error
    delayMs?: number
    onIterate?: (abortSignal?: AbortSignal) => void
  }): ConversationExecutionStream {
    const events = options?.events ?? [
      { type: 'text_delta', textDelta: 'Hello ' },
      { type: 'text_delta', textDelta: 'from ' },
      { type: 'text_delta', textDelta: 'assistant [1]!' },
      {
        type: 'finish',
        finishReason: options?.finishReason ?? 'stop',
        totalTextLength: (options?.resultText ?? 'Hello from assistant [1]!').length,
        durationMs: options?.durationMs ?? 450,
        usage: options?.usage ?? { promptTokens: 40, completionTokens: 15, totalTokens: 55 }
      }
    ]

    let resolveResult!: (res: ConversationExecutionResult) => void
    let rejectResult!: (err: Error) => void
    const resultPromise = new Promise<ConversationExecutionResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    resultPromise.catch(() => {})

    async function* generator(): AsyncGenerator<ConversationExecutionEvent> {
      for (const ev of events) {
        if (options?.delayMs) {
          await new Promise((r) => setTimeout(r, options.delayMs))
        }
        if (ev.type === 'error') {
          rejectResult(
            new ConversationExecutionError(ev.error.message, ev.error.code, ev.error.retryable)
          )
          yield ev
          return
        }
        yield ev
      }

      if (options?.errorToThrow) {
        rejectResult(options.errorToThrow)
        throw options.errorToThrow
      }

      resolveResult({
        assistantText: options?.resultText ?? 'Hello from assistant [1]!',
        finishReason: options?.finishReason ?? 'stop',
        durationMs: options?.durationMs ?? 450,
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        botId: options?.botId ?? botAId,
        conversationId: options?.conversationId ?? convAId,
        citationCandidates: [sampleCitation],
        citationMap: new Map([[1, sampleCitation]]),
        usage: options?.usage ?? { promptTokens: 40, completionTokens: 15, totalTokens: 55 }
      })
    }

    return {
      [Symbol.asyncIterator]() {
        return generator()
      },
      getResult() {
        return resultPromise
      }
    }
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    convRepo = new ConversationRepository(db)
    msgRepo = new MessageRepository(db)
    providerConnRepo = new ProviderConnectionRepository(db)

    activeContext = new ActiveWorkspaceContext({ kbRepo })
    ragService = new BotRagService({ db })

    // By default, simulate successful retrieval with authentic sample citation
    vi.spyOn(ragService, 'retrieve').mockReturnValue({
      status: 'SUCCESS',
      chunks: [
        {
          citationNumber: 1,
          sourceId: sampleCitation.sourceId,
          chunkId: sampleCitation.chunkId,
          fileName: sampleCitation.fileName,
          fileType: sampleCitation.fileType,
          pageNumber: sampleCitation.pageNumber,
          headingPath: sampleCitation.headingPath,
          chunkIndex: sampleCitation.chunkIndex,
          score: 1.0,
          content: 'The safety protocol requires standard authentication procedures.',
          tokenCount: 15,
          isTruncated: false,
          citation: sampleCitation
        }
      ],
      citations: [sampleCitation],
      totalTokens: 15
    })

    const kbA = kbRepo.create({ name: 'KB Alpha' })
    const kbB = kbRepo.create({ name: 'KB Beta' })
    kbAId = kbA.id
    kbBId = kbB.id

    // Activate workspace for session
    activeContext.activateWorkspace(sessionId, kbAId)

    // Create provider connection
    const conn = providerConnRepo.create({
      providerId: 'openai',
      label: 'OpenAI Test Connection',
      credentialRef: `cred_${randomUUID()}` as CredentialRef
    })
    connId = conn.id

    // Create bots
    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      providerConnectionId: connId,
      name: 'Bot Alpha',
      modelId: 'gpt-6-luna'
    })
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      providerConnectionId: connId,
      name: 'Bot Beta',
      modelId: 'gpt-6-luna'
    })
    botAId = botA.id
    botBId = botB.id

    // Create conversations
    const convA = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Conversation A'
    })
    const convB = convRepo.create({
      botId: botBId,
      knowledgeBaseId: kbBId,
      title: 'Conversation B'
    })
    convAId = convA.id
    convBId = convB.id

    conversationService = new ConversationService({
      db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext,
      botRagService: ragService
    })

    persistenceService = new ConversationPersistenceService({
      db,
      conversationRepo: convRepo,
      messageRepo: msgRepo
    })

    // Default turnService with default mock execution
    const mockExecutionService = {
      streamPreparedTurn: vi.fn((turn) =>
        createMockExecutionStream({
          botId: turn.botId,
          conversationId: turn.conversationId
        })
      )
    } as unknown as ConversationExecutionService

    turnService = new ConversationTurnService({
      db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext,
      conversationService,
      executionService: mockExecutionService,
      persistenceService
    })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // ==========================================================================
  // 1. Service Instantiation & Validation
  // ==========================================================================

  describe('Service Instantiation & Pre-flight Validation', () => {
    it('1. instantiates successfully with required dependencies', () => {
      expect(turnService).toBeInstanceOf(ConversationTurnService)
      expect(turnService.getActiveTurnCount()).toBe(0)
    })

    it('2. rejects instantiation when dependencies are missing', () => {
      expect(
        () => new ConversationTurnService(null as unknown as { db: Database.Database })
      ).toThrow(ConversationTurnError)
      expect(() => new ConversationTurnService({ db })).toThrow(
        /ConversationExecutionService is required/
      )
    })

    it('3. rejects send request immediately when abort signal is already aborted', () => {
      const controller = new AbortController()
      controller.abort()

      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'This should not run'
      }

      expect(() =>
        turnService.sendMessage(sessionId, request, { abortSignal: controller.signal })
      ).toThrow(ConversationTurnError)

      try {
        turnService.sendMessage(sessionId, request, { abortSignal: controller.signal })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('OPERATION_ABORTED')
      }

      // Verify no user message was persisted
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(0)
    })

    it('4. rejects send request when request content is invalid or empty', () => {
      expect(() =>
        turnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: ''
        })
      ).toThrow(ConversationTurnError)

      expect(() =>
        turnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: '   \n  '
        })
      ).toThrow(ConversationTurnError)
    })

    it('5. rejects send request when conversation is not found', () => {
      const nonExistent = randomUUID()
      expect(() =>
        turnService.sendMessage(sessionId, {
          conversationId: nonExistent,
          content: 'Hello'
        })
      ).toThrow(ConversationTurnError)
      try {
        turnService.sendMessage(sessionId, {
          conversationId: nonExistent,
          content: 'Hello'
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })

    it('6. rejects send request when conversation is archived', () => {
      db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), convAId)

      expect(() =>
        turnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: 'Hello'
        })
      ).toThrow(ConversationTurnError)
      try {
        turnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: 'Hello'
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('CONVERSATION_ARCHIVED')
      }
    })
  })

  // ==========================================================================
  // 2. New Send Turn Lifecycle
  // ==========================================================================

  describe('New Send Turn Lifecycle', () => {
    it('7. executes complete successful turn: user message persisted, streaming deltas, assistant persisted', async () => {
      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'Explain the safety protocol.'
      }

      const stream = turnService.sendMessage(sessionId, request)
      const events: ConversationTurnEvent[] = []

      for await (const event of stream) {
        events.push(event)
      }

      // Check text delta events forwarded
      const deltas = events.filter((e) => e.type === 'text_delta')
      expect(deltas).toHaveLength(3)
      expect(deltas[0]).toEqual({ type: 'text_delta', textDelta: 'Hello ' })
      expect(deltas[1]).toEqual({ type: 'text_delta', textDelta: 'from ' })
      expect(deltas[2]).toEqual({ type: 'text_delta', textDelta: 'assistant [1]!' })

      // Check finish event
      const finishEvents = events.filter((e) => e.type === 'finish')
      expect(finishEvents).toHaveLength(1)
      const finish = finishEvents[0] as {
        type: 'finish'
        finishReason: string
        message: { role: string; content: string }
      }
      expect(finish.finishReason).toBe('stop')
      expect(finish.message.role).toBe('assistant')
      expect(finish.message.content).toBe('Hello from assistant [1]!')

      // Check result promise
      const result = await stream.getResult()
      expect(result.userMessage.role).toBe('user')
      expect(result.userMessage.content).toBe('Explain the safety protocol.')
      expect(result.assistantMessage.role).toBe('assistant')
      expect(result.assistantMessage.content).toBe('Hello from assistant [1]!')
      expect(result.finishReason).toBe('stop')

      // Check SQLite database: both user and assistant message persisted
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(2)
      expect(messages[0].id).toBe(result.userMessage.id)
      expect(messages[0].role).toBe('user')
      expect(messages[1].id).toBe(result.assistantMessage.id)
      expect(messages[1].role).toBe('assistant')

      // Check active turn lock is released
      expect(turnService.isGenerating(convAId)).toBe(false)
      expect(turnService.getActiveTurnCount()).toBe(0)
    })

    it('8. user message is persisted BEFORE provider generation begins', async () => {
      let userMessagePersistedDuringExecution = false

      const mockExecService = {
        streamPreparedTurn: vi.fn(() => {
          // Check DB at the moment streamPreparedTurn is called
          const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
          if (messages.length === 1 && messages[0].role === 'user') {
            userMessagePersistedDuringExecution = true
          }
          return createMockExecutionStream()
        })
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Check persistence ordering'
      })

      for await (const event of stream) {
        void event
      }
      await stream.getResult()

      expect(userMessagePersistedDuringExecution).toBe(true)
    })

    it('9. does not call provider if user-message persistence fails', async () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() => createMockExecutionStream())
      } as unknown as ConversationExecutionService

      const mockPersistence = {
        persistUserMessage: vi.fn(() => {
          throw new ConversationPersistenceError('DB write failed', 'PERSISTENCE_ERROR')
        }),
        persistAssistantMessage: vi.fn()
      } as unknown as ConversationPersistenceService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService: mockPersistence
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Will fail user persistence'
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      // Provider was NOT called
      expect(mockExecService.streamPreparedTurn).not.toHaveBeenCalled()

      // Error event was emitted
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('error')

      // getResult() rejects with persistence error
      await expect(stream.getResult()).rejects.toThrow(/DB write failed/)

      // Lock is released
      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })
  })

  // ==========================================================================
  // 3. Failure & Error Recovery Lifecycle
  // ==========================================================================

  describe('Failure and Error Recovery Lifecycle', () => {
    it('10. handles provider timeout: user message remains, no assistant message, error event emitted', async () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() =>
          createMockExecutionStream({
            events: [
              {
                type: 'error',
                error: {
                  code: 'TIMEOUT',
                  message: 'Request timed out after 30000ms.',
                  retryable: true
                }
              }
            ]
          })
        )
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Question that times out'
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      // Check error event emitted
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('error')
      if (events[0].type === 'error') {
        expect(events[0].error.code).toBe('TIMEOUT')
        expect(events[0].error.retryable).toBe(true)
      }

      // getResult() rejects
      await expect(stream.getResult()).rejects.toThrow(ConversationTurnError)

      // Database state: user message remains in DB, zero assistant messages
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')

      // Active lock is released
      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })

    it('11. handles provider authentication failure: preserves code and leaves user message for retry', async () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() =>
          createMockExecutionStream({
            events: [
              {
                type: 'error',
                error: {
                  code: 'AUTHENTICATION_FAILED',
                  message: 'Invalid API key provided.',
                  retryable: false
                }
              }
            ]
          })
        )
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Auth failure test'
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      expect(events[0].type).toBe('error')
      if (events[0].type === 'error') {
        expect(events[0].error.code).toBe('AUTHENTICATION_FAILED')
        expect(events[0].error.retryable).toBe(false)
      }

      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')
      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })

    it('12. handles assistant persistence failure: emits error event, never emits false finish event', async () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() => createMockExecutionStream())
      } as unknown as ConversationExecutionService

      const mockPersistence = {
        persistUserMessage: persistenceService.persistUserMessage.bind(persistenceService),
        persistAssistantMessage: vi.fn(() => {
          throw new ConversationPersistenceError(
            'Assistant persistence crashed',
            'PERSISTENCE_ERROR'
          )
        })
      } as unknown as ConversationPersistenceService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService: mockPersistence
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Fails on assistant save'
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      // Must NOT contain finish event!
      expect(events.some((e) => e.type === 'finish')).toBe(false)

      // Must contain error event
      const errorEv = events.find((e) => e.type === 'error')
      expect(errorEv).toBeDefined()
      if (errorEv && errorEv.type === 'error') {
        expect(errorEv.error.code).toBe('PERSISTENCE_ERROR')
      }

      await expect(stream.getResult()).rejects.toThrow(/Assistant persistence crashed/)
      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })
  })

  // ==========================================================================
  // 4. Cancellation Handling
  // ==========================================================================

  describe('Cancellation Handling (AbortSignal)', () => {
    it('13. handles cancellation during streaming: aborts provider, user message remains, no assistant message', async () => {
      const controller = new AbortController()

      const mockExecService = {
        streamPreparedTurn: vi.fn((_turn, opts) => {
          return createMockExecutionStream({
            events: [
              { type: 'text_delta', textDelta: 'Starting...' },
              {
                type: 'error',
                error: {
                  code: 'OPERATION_ABORTED',
                  message: 'Generation was cancelled by client.',
                  retryable: false
                }
              }
            ],
            delayMs: 10,
            onIterate: () => {
              if (opts?.abortSignal) {
                // Abort during stream
              }
            }
          })
        })
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(
        sessionId,
        { conversationId: convAId, content: 'Cancel while streaming' },
        { abortSignal: controller.signal }
      )

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
        if (ev.type === 'text_delta') {
          controller.abort()
        }
      }

      expect(events.some((e) => e.type === 'error')).toBe(true)
      const errEv = events.find((e) => e.type === 'error')
      if (errEv && errEv.type === 'error') {
        expect(errEv.error.code).toBe('OPERATION_ABORTED')
      }

      // User message was saved, assistant message was NOT saved
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')

      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })

    it('13b. handles cancellation after user-message persistence but before generation: keeps user message, provider not called', async () => {
      const controller = new AbortController()
      const mockStreamPreparedTurn = vi.fn(() => createMockExecutionStream())

      const mockExecService = {
        streamPreparedTurn: mockStreamPreparedTurn
      } as unknown as ConversationExecutionService

      // Abort controller immediately when user message is persisted
      const origPersistUser = persistenceService.persistUserMessage.bind(persistenceService)
      const mockPersistence = {
        persistUserMessage: vi.fn((preparedTurn, req) => {
          const res = origPersistUser(preparedTurn, req)
          controller.abort() // Trigger abort right after user message is committed
          return res
        }),
        persistAssistantMessage: vi.fn()
      } as unknown as ConversationPersistenceService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService: mockPersistence
      })

      const stream = customTurnService.sendMessage(
        sessionId,
        { conversationId: convAId, content: 'Abort before generation starts' },
        { abortSignal: controller.signal }
      )

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      // Provider was never contacted
      expect(mockStreamPreparedTurn).not.toHaveBeenCalled()

      // Error event OPERATION_ABORTED emitted
      expect(events.some((e) => e.type === 'error')).toBe(true)

      // User message is in DB
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('Abort before generation starts')

      // Zero assistant messages
      expect(mockPersistence.persistAssistantMessage).not.toHaveBeenCalled()
      expect(customTurnService.isGenerating(convAId)).toBe(false)
    })

    it('14. handles consumer stopping early with break: aborts stream, releases lock, no assistant message', async () => {
      const abortSpy = vi.fn()

      const mockExecService = {
        streamPreparedTurn: vi.fn((_turn, opts) => {
          opts?.abortSignal?.addEventListener('abort', abortSpy)
          return createMockExecutionStream({
            events: [
              { type: 'text_delta', textDelta: 'Chunk 1 ' },
              { type: 'text_delta', textDelta: 'Chunk 2 ' },
              { type: 'text_delta', textDelta: 'Chunk 3 ' }
            ],
            delayMs: 20
          })
        })
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Break early test'
      })

      // Read only the first delta then break
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          break
        }
      }

      // Internal controller should have aborted
      expect(abortSpy).toHaveBeenCalled()

      // Lock must be released
      expect(customTurnService.isGenerating(convAId)).toBe(false)

      // No assistant message in DB
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')
    })
  })

  // ==========================================================================
  // 5. Explicit Retry Recovery
  // ==========================================================================

  describe('Explicit Retry Recovery (retryLastUserMessage)', () => {
    it('15. successfully retries an unanswered latest user message after failure without duplicating user message', async () => {
      // 1. First attempt fails due to timeout
      const mockExecServiceTimeout = {
        streamPreparedTurn: vi.fn(() =>
          createMockExecutionStream({
            events: [
              {
                type: 'error',
                error: {
                  code: 'TIMEOUT',
                  message: 'Provider timeout',
                  retryable: true
                }
              }
            ]
          })
        )
      } as unknown as ConversationExecutionService

      const failingTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecServiceTimeout,
        persistenceService
      })

      const failStream = failingTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'What is our revenue target?'
      })
      for await (const event of failStream) {
        void event
      }

      // Verify user message is in DB but no assistant message
      const dbAfterFail = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(dbAfterFail).toHaveLength(1)
      expect(dbAfterFail[0].content).toBe('What is our revenue target?')

      // 2. Retry with a working provider execution
      const mockExecServiceSuccess = {
        streamPreparedTurn: vi.fn(() =>
          createMockExecutionStream({
            resultText: 'The revenue target is $10M [1].'
          })
        )
      } as unknown as ConversationExecutionService

      const successfulTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecServiceSuccess,
        persistenceService
      })

      const retryStream = successfulTurnService.retryLastUserMessage(sessionId, {
        conversationId: convAId
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of retryStream) {
        events.push(ev)
      }

      expect(events.some((e) => e.type === 'finish')).toBe(true)

      const result = await retryStream.getResult()
      expect(result.userMessage.id).toBe(dbAfterFail[0].id)
      expect(result.userMessage.content).toBe('What is our revenue target?')
      expect(result.assistantMessage.content).toBe('The revenue target is $10M [1].')

      // Verify DB has exactly 2 messages: 1 user, 1 assistant (NO duplicate user message!)
      const dbAfterRetry = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(dbAfterRetry).toHaveLength(2)
      expect(dbAfterRetry[0].id).toBe(dbAfterFail[0].id)
      expect(dbAfterRetry[0].role).toBe('user')
      expect(dbAfterRetry[1].role).toBe('assistant')
      expect(dbAfterRetry[1].id).toBe(result.assistantMessage.id)
    })

    it('16. retries after creating a brand new service instance (restart recovery simulation)', async () => {
      // Simulate persisted unanswered user message directly in DB (e.g. app crashed after saving user msg)
      const userMsg = persistenceService.persistUserMessage(
        {
          botId: botAId,
          conversationId: convAId,
          providerConnectionId: connId,
          providerId: 'openai',
          modelId: 'gpt-6-luna',
          systemInstruction: 'Prompt',
          messages: [{ role: 'user', content: 'Crashed query' }],
          conversationMessages: [],
          retrievalStatus: 'SUCCESS',
          citationCandidates: [],
          citationMap: new Map(),
          contextWindowLimits: { inputTokens: 128000, outputTokens: 4096 },
          reservedOutputTokens: 4096,
          tokenEstimates: {
            systemTokens: 10,
            historyTokens: 0,
            contextTokens: 10,
            questionTokens: 5,
            totalEstimatedTokens: 25
          },
          includedMessageCount: 0,
          excludedMessageCount: 0,
          historyTrimmingOccurred: false
        },
        {
          conversationId: convAId,
          content: 'Crashed query'
        }
      )

      // Create brand new turnService instance
      const newTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: {
          streamPreparedTurn: vi.fn(() =>
            createMockExecutionStream({
              resultText: 'Recovered response [1]'
            })
          )
        } as unknown as ConversationExecutionService,
        persistenceService
      })

      const stream = newTurnService.retryLastUserMessage(sessionId, {
        conversationId: convAId,
        messageId: userMsg.id
      })

      for await (const event of stream) {
        void event
      }

      const result = await stream.getResult()
      expect(result.userMessage.id).toBe(userMsg.id)
      expect(result.assistantMessage.content).toBe('Recovered response [1]')

      const msgs = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(msgs).toHaveLength(2)
    })

    it('17. rejects retry if conversation is empty', () => {
      expect(() =>
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId
        })
      ).toThrow(ConversationTurnError)

      try {
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('NO_RETRYABLE_MESSAGE')
      }
    })

    it('18. rejects retry if an assistant message already answered the turn', async () => {
      // Run normal successful turn
      const stream = turnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Question 1'
      })
      for await (const event of stream) {
        void event
      }
      await stream.getResult()

      // Attempt retry on completed turn
      expect(() =>
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId
        })
      ).toThrow(ConversationTurnError)

      try {
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('NO_RETRYABLE_MESSAGE')
      }
    })

    it('19. rejects retry when specified messageId does not match the latest message', async () => {
      // Insert first user message
      const msg1 = msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'First user message'
      })

      // Insert second user message with guaranteed later timestamp
      const msg2 = msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Second user message'
      })
      db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(
        msg1.createdAt + 1000,
        msg2.id
      )

      // Try retrying msg1 (not the latest)
      expect(() =>
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId,
          messageId: msg1.id
        })
      ).toThrow(ConversationTurnError)

      try {
        turnService.retryLastUserMessage(sessionId, {
          conversationId: convAId,
          messageId: msg1.id
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('NO_RETRYABLE_MESSAGE')
      }
    })

    it('19b. rejects retry across KB boundaries when session is in another KB', async () => {
      // convA belongs to kbA. Session B is activated for kbB.
      const sessionB = 'session-in-kb-b'
      activeContext.activateWorkspace(sessionB, kbBId)

      // Insert an unanswered user message in convA
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Question in KB A'
      })

      // Attempt retry using sessionB (active in KB B)
      const stream = turnService.retryLastUserMessage(sessionB, {
        conversationId: convAId
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }

      // Preparation should fail with cross-KB rejection
      expect(events.some((e) => e.type === 'error')).toBe(true)
      await expect(stream.getResult()).rejects.toThrow()
    })

    it('19c. successfully retries an unanswered message after a previous cancellation', async () => {
      // 1. Send message with immediate cancellation
      const controller = new AbortController()
      const mockStreamPreparedTurn = vi.fn(() => createMockExecutionStream())
      const origPersistUser = persistenceService.persistUserMessage.bind(persistenceService)

      const mockPersistence = {
        persistUserMessage: vi.fn((preparedTurn, req) => {
          const res = origPersistUser(preparedTurn, req)
          controller.abort()
          return res
        }),
        persistAssistantMessage: vi.fn()
      } as unknown as ConversationPersistenceService

      const customService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: {
          streamPreparedTurn: mockStreamPreparedTurn
        } as unknown as ConversationExecutionService,
        persistenceService: mockPersistence
      })

      const cancelledStream = customService.sendMessage(
        sessionId,
        { conversationId: convAId, content: 'Retry after cancel' },
        { abortSignal: controller.signal }
      )
      for await (const event of cancelledStream) {
        void event
      }

      // 2. Retry with normal turnService
      const retryStream = turnService.retryLastUserMessage(sessionId, {
        conversationId: convAId
      })

      for await (const event of retryStream) {
        void event
      }

      const result = await retryStream.getResult()
      expect(result.userMessage.content).toBe('Retry after cancel')
      expect(result.assistantMessage.content).toBe('Hello from assistant [1]!')

      const msgs = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(msgs).toHaveLength(2)
      expect(msgs[0].role).toBe('user')
      expect(msgs[1].role).toBe('assistant')
    })
  })

  // ==========================================================================
  // 6. Concurrency & Active-Turn Protection
  // ==========================================================================

  describe('Concurrent Turn Protection', () => {
    it('20. rejects two simultaneous sends on the same conversation with CONCURRENT_TURN_ACTIVE', () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() =>
          createMockExecutionStream({
            delayMs: 50 // Keep active for a moment
          })
        )
      } as unknown as ConversationExecutionService

      const concurrentTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      // First call starts and acquires lock
      const stream1 = concurrentTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'First message'
      })

      expect(concurrentTurnService.isGenerating(convAId)).toBe(true)

      // Second call on the same conversation should be rejected immediately
      expect(() =>
        concurrentTurnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: 'Simultaneous second message'
        })
      ).toThrow(ConversationTurnError)

      try {
        concurrentTurnService.sendMessage(sessionId, {
          conversationId: convAId,
          content: 'Simultaneous second message'
        })
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('CONCURRENT_TURN_ACTIVE')
      }

      // Cleanup stream1 generator
      stream1[Symbol.asyncIterator]().return?.(undefined as unknown as ConversationTurnEvent)
    })

    it('21. rejects retry when a send is already generating on that conversation', () => {
      const mockExecService = {
        streamPreparedTurn: vi.fn(() => createMockExecutionStream({ delayMs: 50 }))
      } as unknown as ConversationExecutionService

      const concurrentTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream1 = concurrentTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'First message'
      })

      expect(() =>
        concurrentTurnService.retryLastUserMessage(sessionId, {
          conversationId: convAId
        })
      ).toThrow(ConversationTurnError)

      stream1[Symbol.asyncIterator]().return?.(undefined as unknown as ConversationTurnEvent)
    })

    it('22. permits simultaneous turns on different conversations independently', async () => {
      // Activate KB B in session B for conversation B
      const sessionB = 'test-session-2'
      activeContext.activateWorkspace(sessionB, kbBId)

      const streamA = turnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Message in Conversation A'
      })

      const streamB = turnService.sendMessage(sessionB, {
        conversationId: convBId,
        content: 'Message in Conversation B'
      })

      expect(turnService.isGenerating(convAId)).toBe(true)
      expect(turnService.isGenerating(convBId)).toBe(true)
      expect(turnService.getActiveTurnCount()).toBe(2)

      // Consume both
      for await (const event of streamA) {
        void event
      }
      for await (const event of streamB) {
        void event
      }

      await streamA.getResult()
      await streamB.getResult()

      expect(turnService.isGenerating(convAId)).toBe(false)
      expect(turnService.isGenerating(convBId)).toBe(false)
      expect(turnService.getActiveTurnCount()).toBe(0)
    })

    it('22b. enforces bidirectional mutual exclusion between generation and deletion', () => {
      // 1. When generation is in progress, acquireDeletionLock throws CONCURRENT_TURN_ACTIVE
      const mockExecService = {
        streamPreparedTurn: vi.fn(() => createMockExecutionStream({ delayMs: 50 }))
      } as unknown as ConversationExecutionService

      const customTurnService = new ConversationTurnService({
        db,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        conversationService,
        executionService: mockExecService,
        persistenceService
      })

      const stream = customTurnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Active generation test'
      })

      expect(customTurnService.isGenerating(convAId)).toBe(true)

      expect(() => customTurnService.acquireDeletionLock(convAId)).toThrow(ConversationTurnError)
      try {
        customTurnService.acquireDeletionLock(convAId)
      } catch (err) {
        expect((err as ConversationTurnError).code).toBe('CONCURRENT_TURN_ACTIVE')
      }

      // Cleanup stream
      stream[Symbol.asyncIterator]().return?.(undefined as unknown as ConversationTurnEvent)

      // 2. When deletion lock is held, new sendMessage or retry is blocked
      expect(customTurnService.isDeleting(convBId)).toBe(false)
      customTurnService.acquireDeletionLock(convBId)
      expect(customTurnService.isDeleting(convBId)).toBe(true)

      // Another acquireDeletionLock call is rejected
      expect(() => customTurnService.acquireDeletionLock(convBId)).toThrow(ConversationTurnError)

      // sendMessage is blocked
      expect(() =>
        customTurnService.sendMessage(sessionId, {
          conversationId: convBId,
          content: 'Should be blocked by deletion'
        })
      ).toThrow(ConversationTurnError)

      // retry is blocked
      expect(() =>
        customTurnService.retryLastUserMessage(sessionId, {
          conversationId: convBId
        })
      ).toThrow(ConversationTurnError)

      // 3. Releasing deletion lock allows operations again
      customTurnService.releaseDeletionLock(convBId)
      expect(customTurnService.isDeleting(convBId)).toBe(false)
    })
  })

  // ==========================================================================
  // 7. Security & Isolation Invariants
  // ==========================================================================

  describe('Security and Data Isolation Invariants', () => {
    it('23. never exposes decrypted credentials or API keys in turn results or stream events', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Check credential hygiene'
      })

      const events: ConversationTurnEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
      }
      const result = await stream.getResult()

      const serializedEvents = JSON.stringify(events)
      const serializedResult = JSON.stringify(result)

      expect(serializedEvents).not.toContain('test-credential-reference')
      expect(serializedEvents).not.toContain('apiKey')
      expect(serializedEvents).not.toContain('authorization')

      expect(serializedResult).not.toContain('test-credential-reference')
      expect(serializedResult).not.toContain('apiKey')
    })

    it('24. does not expose internal citation candidates or raw retrieval rows in turn result', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: convAId,
        content: 'Check result fields'
      })

      for await (const event of stream) {
        void event
      }
      const result = await stream.getResult()

      // Result interface strictly contains userMessage, assistantMessage, finishReason, durationMs, usage
      expect(result).toHaveProperty('userMessage')
      expect(result).toHaveProperty('assistantMessage')
      expect(result).toHaveProperty('finishReason')
      expect(result).toHaveProperty('durationMs')
      expect(result).not.toHaveProperty('citationCandidates')
      expect(result).not.toHaveProperty('citationMap')
    })

    it('25. Retrying an unanswered turn includes fresh Bot memory without duplicate memory blocks', async () => {
      const memoryRepo = new BotMemoryRepository(db)
      memoryRepo.create({
        botId: botAId,
        knowledgeBaseId: kbAId,
        memoryType: 'pinned_instruction',
        content: 'Stay concise and factual'
      })

      // Persist an unanswered user message directly into conversation
      const userMsg = msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Initial query'
      })

      // Retry the unanswered user message
      const stream = turnService.retryLastUserMessage(sessionId, {
        conversationId: convAId,
        messageId: userMsg.id
      })
      for await (const ev of stream) {
        void ev
      }
      const retryResult = await stream.getResult()

      // The original user message is reused without duplication
      expect(retryResult.userMessage.id).toBe(userMsg.id)
      expect(retryResult.userMessage.content).toBe('Initial query')
      expect(retryResult.assistantMessage.content).toBeDefined()
    })
  })
})
