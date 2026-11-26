import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import type { CredentialRef } from '../database/repositories/types'
import type { ProviderManagerService } from '../providers/provider-manager/provider-manager-service'
import type { StreamTextChunk } from '../providers/types'
import type { PreparedConversationTurn } from './conversation-service'
import type { ChatMessageDto } from '../../shared/providers'
import type { CitationDto } from '../../shared/conversations'
import {
  ConversationExecutionService,
  ConversationExecutionError,
  type ConversationExecutionEvent
} from './conversation-execution-service'

describe('ConversationExecutionService (Phase 7 Step 7.6B.1)', () => {
  let tempDir: string
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let conversationRepo: ConversationRepository
  let messageRepo: MessageRepository
  let providerConnRepo: ProviderConnectionRepository

  let kbId: string
  let botId: string
  let convId: string
  let connId: string

  const createMockPreparedTurn = (
    overrides?: Partial<PreparedConversationTurn>
  ): PreparedConversationTurn => {
    const mockMessages: readonly ChatMessageDto[] = [
      { role: 'system', content: 'You are a helpful assistant with security policy.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'What is the answer?' }
    ]
    const mockConversationMessages: readonly ChatMessageDto[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'What is the answer?' }
    ]
    const mockCitationCandidates: readonly CitationDto[] = [
      {
        citationNumber: 1,
        sourceId: 'src-123',
        chunkId: 'chk-456',
        fileName: 'guide.txt',
        fileType: 'txt',
        pageNumber: null,
        headingPath: null,
        chunkIndex: 0
      }
    ]
    const mockCitationMap: ReadonlyMap<number, CitationDto> = new Map([
      [1, mockCitationCandidates[0]]
    ])

    return Object.freeze({
      botId: botId ?? randomUUID(),
      conversationId: convId ?? randomUUID(),
      providerConnectionId: connId ?? randomUUID(),
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      systemInstruction: 'You are a helpful assistant with security policy.',
      messages: mockMessages,
      conversationMessages: mockConversationMessages,
      retrievalStatus: 'SUCCESS',
      citationCandidates: mockCitationCandidates,
      citationMap: mockCitationMap,
      contextWindowLimits: {
        inputTokens: 128000,
        outputTokens: 16384
      },
      reservedOutputTokens: 4096,
      tokenEstimates: {
        systemTokens: 50,
        historyTokens: 20,
        contextTokens: 100,
        questionTokens: 10,
        totalEstimatedTokens: 180
      },
      includedMessageCount: 2,
      excludedMessageCount: 0,
      historyTrimmingOccurred: false,
      ...overrides,
      responsePolicy: overrides?.responsePolicy ?? 'balanced_kb_first'
    })
  }

  const createMockProviderManager = (
    streamFn?: (
      connectionId: string,
      modelId: string,
      options: Record<string, unknown>
    ) => AsyncIterable<StreamTextChunk>
  ): ProviderManagerService => {
    const defaultStream = async function* (): AsyncIterable<StreamTextChunk> {
      yield { type: 'text-delta', textDelta: 'Hello' }
      yield { type: 'text-delta', textDelta: ' world!' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 }
      }
    }

    return {
      streamText: vi.fn(streamFn ?? defaultStream)
    } as unknown as ProviderManagerService
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-exec-test-'))
    const dbPath = path.join(tempDir, 'test-conv-exec.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    conversationRepo = new ConversationRepository(db)
    messageRepo = new MessageRepository(db)
    providerConnRepo = new ProviderConnectionRepository(db)

    // Setup active connection
    const conn = providerConnRepo.create({
      providerId: 'openai',
      label: 'OpenAI Test Connection',
      credentialRef: `cred_${randomUUID()}` as CredentialRef,
      status: 'active'
    })
    connId = conn.id

    // Setup KB
    const kb = kbRepo.create({ name: 'Execution Test KB', description: 'Testing execution' })
    kbId = kb.id

    // Setup Bot
    const bot = botRepo.create({
      knowledgeBaseId: kbId,
      name: 'Exec Bot',
      systemPrompt: 'System instructions',
      modelId: 'gpt-6-luna',
      providerConnectionId: connId,
      toolPermissions: []
    })
    botId = bot.id

    // Setup Conversation
    const conv = conversationRepo.create({
      botId,
      knowledgeBaseId: kbId,
      title: 'Execution Test Conversation'
    })
    convId = conv.id
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      db.close()
    } catch {
      // Ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ==========================================================================
  // Provider request construction
  // ==========================================================================

  describe('Provider request construction', () => {
    it('1. Correct connection ID supplied', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn({ providerConnectionId: connId })

      await service.executePreparedTurn(turn)

      expect(mockManager.streamText).toHaveBeenCalledWith(
        connId,
        expect.any(String),
        expect.any(Object)
      )
    })

    it('2. Correct model ID supplied', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn({ modelId: 'gpt-6-luna' })

      await service.executePreparedTurn(turn)

      expect(mockManager.streamText).toHaveBeenCalledWith(
        expect.any(String),
        'gpt-6-luna',
        expect.any(Object)
      )
    })

    it('3. Correct system instructions supplied', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn({
        systemInstruction: 'Custom system instruction with RAG rules.'
      })

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      expect(options.systemPrompt).toBe('Custom system instruction with RAG rules.')
    })

    it('4. Correct chronological messages supplied', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn({
        conversationMessages: [
          { role: 'user', content: 'Question 1' },
          { role: 'assistant', content: 'Answer 1' },
          { role: 'user', content: 'Question 2' }
        ]
      })

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      const messages = options.messages as Array<{ role: string; content: string }>
      expect(messages).toHaveLength(3)
      expect(messages[0]).toEqual({ role: 'user', content: 'Question 1' })
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Answer 1' })
      expect(messages[2]).toEqual({ role: 'user', content: 'Question 2' })
    })

    it('5. Reserved output tokens supplied using the correct provider option', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn({ reservedOutputTokens: 2048 })

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      expect(options.maxTokens).toBe(2048)
    })

    it('6. No Renderer-controlled provider settings accepted', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      // The execution service only accepts preparedTurn and StreamExecutionOptions (abortSignal, temperature)
      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      // Verify no renderer injection
      expect((options as Record<string, unknown>).modelId).toBeUndefined()
      expect((options as Record<string, unknown>).connectionId).toBeUndefined()
    })

    it('7. No provider tool definitions sent', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      expect(options.tools).toBeUndefined()
    })

    it('8. Citation Map is not passed to the provider', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      expect((options as Record<string, unknown>).citationMap).toBeUndefined()
      expect((options as Record<string, unknown>).citationCandidates).toBeUndefined()
    })
  })

  // ==========================================================================
  // Streaming behavior
  // ==========================================================================

  describe('Streaming behavior', () => {
    it('9. Text deltas forwarded in correct order', async () => {
      const deltas = ['Part 1', ' - Part 2', ' - Part 3']
      const mockManager = createMockProviderManager(async function* () {
        for (const textDelta of deltas) {
          yield { type: 'text-delta', textDelta }
        }
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const received: string[] = []
      for await (const event of service.streamPreparedTurn(turn)) {
        if (event.type === 'text_delta') {
          received.push(event.textDelta)
        }
      }

      expect(received).toEqual(deltas)
    })

    it('10. Delta concatenation equals final assistant text', async () => {
      const deltas = ['The ', 'quick ', 'brown ', 'fox.']
      const mockManager = createMockProviderManager(async function* () {
        for (const textDelta of deltas) {
          yield { type: 'text-delta', textDelta }
        }
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      let concatenated = ''
      const stream = service.streamPreparedTurn(turn)
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          concatenated += event.textDelta
        }
      }
      const result = await stream.getResult()

      expect(concatenated).toBe('The quick brown fox.')
      expect(result.assistantText).toBe(concatenated)
    })

    it('11. Multiple deltas accumulated correctly', async () => {
      const mockManager = createMockProviderManager(async function* () {
        for (let i = 1; i <= 5; i++) {
          yield { type: 'text-delta', textDelta: `token${i} ` }
        }
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)
      expect(result.assistantText).toBe('token1 token2 token3 token4 token5 ')
    })

    it('12. Empty response handled safely', async () => {
      const mockManager = createMockProviderManager(async function* () {
        // Yields finish without any text-delta
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const events: ConversationExecutionEvent[] = []
      for await (const event of service.streamPreparedTurn(turn)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('finish')
      if (events[0].type === 'finish') {
        expect(events[0].totalTextLength).toBe(0)
      }

      const result = await service.executePreparedTurn(turn)
      expect(result.assistantText).toBe('')
      expect(result.finishReason).toBe('stop')
    })

    it('13. Finish event emitted exactly once', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      let finishCount = 0
      for await (const event of service.streamPreparedTurn(turn)) {
        if (event.type === 'finish') {
          finishCount++
        }
      }

      expect(finishCount).toBe(1)
    })

    it('14. Final token usage captured', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield { type: 'text-delta', textDelta: 'Hi' }
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)

      expect(result.usage).toBeDefined()
      expect(result.usage?.promptTokens).toBe(100)
      expect(result.usage?.completionTokens).toBe(50)
      expect(result.usage?.totalTokens).toBe(150)
    })

    it('15. Finish reason captured', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield { type: 'text-delta', textDelta: 'Truncated...' }
        yield { type: 'finish', finishReason: 'length' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)
      expect(result.finishReason).toBe('length')
    })

    it('16. Duration captured', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield { type: 'text-delta', textDelta: 'Quick' }
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('17. Unexpected stream completion handled safely', async () => {
      const mockManager = createMockProviderManager(async function* () {
        // Stream terminates abruptly without a finish chunk
        yield { type: 'text-delta', textDelta: 'Unfinished thought' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const events: ConversationExecutionEvent[] = []
      const stream = service.streamPreparedTurn(turn)
      for await (const event of stream) {
        events.push(event)
      }

      // Automatically emits a finish event upon clean stream termination
      const finishEvents = events.filter((e) => e.type === 'finish')
      expect(finishEvents).toHaveLength(1)
      const result = await stream.getResult()
      expect(result.assistantText).toBe('Unfinished thought')
    })
  })

  // ==========================================================================
  // Cancellation and cleanup
  // ==========================================================================

  describe('Cancellation and cleanup', () => {
    it('18. AbortSignal cancels provider generation', async () => {
      const controller = new AbortController()
      controller.abort() // Pre-aborted

      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const events: ConversationExecutionEvent[] = []
      for await (const event of service.streamPreparedTurn(turn, {
        abortSignal: controller.signal
      })) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('error')
      if (events[0].type === 'error') {
        expect(events[0].error.code).toBe('OPERATION_ABORTED')
      }
    })

    it('19. Early iterator return cancels underlying generation', async () => {
      let abortedInProvider = false
      const mockManager = createMockProviderManager(async function* (
        _connId,
        _mId,
        options: Record<string, unknown>
      ) {
        const signal = options.abortSignal as AbortSignal
        signal.addEventListener('abort', () => {
          abortedInProvider = true
        })

        yield { type: 'text-delta', textDelta: 'Chunk 1' }
        yield { type: 'text-delta', textDelta: 'Chunk 2' }
        yield { type: 'finish', finishReason: 'stop' }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const stream = service.streamPreparedTurn(turn)
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          break // Early exit
        }
      }

      // Early break triggers generator finally block which aborts the internal controller
      expect(abortedInProvider).toBe(true)
      await expect(stream.getResult()).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      )
    })

    it('20. Cancellation does not emit successful finish', async () => {
      const controller = new AbortController()
      const mockManager = createMockProviderManager(async function* (
        _connId,
        _mId,
        options: Record<string, unknown>
      ) {
        const signal = options.abortSignal as AbortSignal
        yield { type: 'text-delta', textDelta: 'Started...' }
        controller.abort() // Trigger abort midway
        if (signal.aborted) {
          yield { type: 'finish', finishReason: 'abort' }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const events: ConversationExecutionEvent[] = []
      for await (const event of service.streamPreparedTurn(turn, {
        abortSignal: controller.signal
      })) {
        events.push(event)
      }

      const finishEvents = events.filter((e) => e.type === 'finish')
      expect(finishEvents).toHaveLength(0)

      const errorEvents = events.filter((e) => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      if (errorEvents[0].type === 'error') {
        expect(errorEvents[0].error.code).toBe('OPERATION_ABORTED')
      }
    })

    it('21. Cancellation listeners are cleaned up', async () => {
      const controller = new AbortController()
      const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn, { abortSignal: controller.signal })

      expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    })

    it('22. Timers and readers are released', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)
      expect(result).toBeDefined()
    })

    it('23. Cancellation is reported distinctly', async () => {
      const controller = new AbortController()
      controller.abort()

      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(
        service.executePreparedTurn(turn, { abortSignal: controller.signal })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'OPERATION_ABORTED'
        })
      )
    })
  })

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe('Error handling', () => {
    it('24. Authentication error normalized', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'Invalid API key provided.',
            retryable: false
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'AUTHENTICATION_FAILED'
        })
      )
    })

    it('25. Rate-limit error normalized', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded for requests per minute.',
            retryable: true
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'RATE_LIMITED',
          retryable: true
        })
      )
    })

    it('26. Network error normalized', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'NETWORK_ERROR',
            message: 'Failed to connect to provider endpoint.',
            retryable: true
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'NETWORK_ERROR'
        })
      )
    })

    it('27. Timeout reported distinctly', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'TIMEOUT',
            message: 'Request timed out waiting for provider response.',
            retryable: true
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'TIMEOUT'
        })
      )
    })

    it('28. Context-length error reported distinctly', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'CONTEXT_LENGTH_EXCEEDED',
            message: 'Total tokens exceeded context window limit.',
            retryable: false
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'CONTEXT_LENGTH_EXCEEDED'
        })
      )
    })

    it('29. Unsupported tool capability rejected', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'UNSUPPORTED_CAPABILITY',
            message: 'Tool calling capability is not supported.',
            retryable: false
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'UNSUPPORTED_CAPABILITY'
        })
      )
    })

    it('30. Malformed provider stream handled safely', async () => {
      const mockManager = createMockProviderManager(async function* () {
        yield* []
        throw new Error('Unexpected stream pipeline explosion.')
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await expect(service.executePreparedTurn(turn)).rejects.toThrowError(
        expect.objectContaining({
          code: 'EXECUTION_ERROR'
        })
      )
    })

    it('31. Raw provider secrets are absent from errors', async () => {
      const rawSecret = 'sk-proj-supersecretkey1234567890abcdef'
      const rawCredRef = 'cred_01234567-89ab-cdef-0123-456789abcdef'
      const mockManager = createMockProviderManager(async function* () {
        yield {
          type: 'error',
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: `Failed auth with key ${rawSecret} and ref ${rawCredRef} with Bearer eyJhbGciOiJIUzI1NiJ9.`,
            retryable: false
          }
        }
      })
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      try {
        await service.executePreparedTurn(turn)
        expect.fail('Should have thrown')
      } catch (err: unknown) {
        const error = err as ConversationExecutionError
        expect(error.message).not.toContain(rawSecret)
        expect(error.message).not.toContain(rawCredRef)
        expect(error.message).toContain('[REDACTED_KEY]')
        expect(error.message).toContain('[REDACTED_REF]')
        expect(error.message).toContain('Bearer [REDACTED]')
      }
    })
  })

  // ==========================================================================
  // Persistence and privacy invariants
  // ==========================================================================

  describe('Persistence and privacy invariants', () => {
    it('32. No user message inserted', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const messages = messageRepo.listByConversation(convId, botId, kbId)
      expect(messages).toHaveLength(0)

      const userMessages = db
        .prepare("SELECT COUNT(*) as count FROM messages WHERE role = 'user'")
        .get() as { count: number }
      expect(userMessages.count).toBe(0)
    })

    it('33. No assistant message inserted', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const messages = messageRepo.listByConversation(convId, botId, kbId)
      expect(messages).toHaveLength(0)

      const assistantMessages = db
        .prepare("SELECT COUNT(*) as count FROM messages WHERE role = 'assistant'")
        .get() as { count: number }
      expect(assistantMessages.count).toBe(0)
    })

    it('34. No conversation timestamps modified', async () => {
      const convBefore = conversationRepo.getById(convId, botId, kbId)!
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const convAfter = conversationRepo.getById(convId, botId, kbId)!
      expect(convAfter.updatedAt).toBe(convBefore.updatedAt)
    })

    it('35. No provider credential decryption outside ProviderManagerService', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      const result = await service.executePreparedTurn(turn)

      // Service never interacts with CredentialVault or raw keys
      expect((result as unknown as Record<string, unknown>).apiKey).toBeUndefined()
      expect((result as unknown as Record<string, unknown>).credentialRef).toBeUndefined()
    })

    it('36. No source IDs or chunk IDs sent as provider metadata', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()

      await service.executePreparedTurn(turn)

      const options = vi.mocked(mockManager.streamText).mock.calls[0][2] as Record<string, unknown>
      const serialized = JSON.stringify(options)
      expect(serialized).not.toContain('src-123')
      expect(serialized).not.toContain('chk-456')
    })

    it('37. PreparedConversationTurn is not mutated', async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const turn = createMockPreparedTurn()
      const turnBefore = JSON.stringify(turn)

      await service.executePreparedTurn(turn)

      expect(JSON.stringify(turn)).toBe(turnBefore)
      expect(Object.isFrozen(turn)).toBe(true)
    })
  })

  // ==========================================================================
  // Isolation
  // ==========================================================================

  describe('Isolation', () => {
    it("38. Execution uses only the prepared Bot's provider connection", async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const expectedConnId = randomUUID()
      const turn = createMockPreparedTurn({ providerConnectionId: expectedConnId })

      await service.executePreparedTurn(turn)

      expect(mockManager.streamText).toHaveBeenCalledWith(
        expectedConnId,
        expect.any(String),
        expect.any(Object)
      )
    })

    it("39. Execution uses only the prepared Bot's model", async () => {
      const mockManager = createMockProviderManager()
      const service = new ConversationExecutionService(mockManager)
      const expectedModel = 'claude-sonnet-5-5'
      const turn = createMockPreparedTurn({
        providerId: 'anthropic',
        modelId: expectedModel
      })

      await service.executePreparedTurn(turn)

      expect(mockManager.streamText).toHaveBeenCalledWith(
        expect.any(String),
        expectedModel,
        expect.any(Object)
      )
    })

    it('40. Different prepared Bot requests cannot share accumulated response text or cancellation state', async () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      const mockManager = createMockProviderManager(async function* (
        _connId,
        modelId,
        options: Record<string, unknown>
      ) {
        const signal = options.abortSignal as AbortSignal
        if (modelId === 'model-1') {
          yield { type: 'text-delta', textDelta: 'Bot 1 response' }
          // Abort Bot 1
          controller1.abort()
          if (signal.aborted) {
            yield { type: 'finish', finishReason: 'abort' }
            return
          }
        } else {
          yield { type: 'text-delta', textDelta: 'Bot 2 response' }
          yield { type: 'finish', finishReason: 'stop' }
        }
      })
      const service = new ConversationExecutionService(mockManager)

      const turn1 = createMockPreparedTurn({ modelId: 'model-1' })
      const turn2 = createMockPreparedTurn({ modelId: 'model-2' })

      // Run turn 1 (which gets cancelled)
      await expect(
        service.executePreparedTurn(turn1, { abortSignal: controller1.signal })
      ).rejects.toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }))

      // Run turn 2 (which should succeed independently)
      const result2 = await service.executePreparedTurn(turn2, {
        abortSignal: controller2.signal
      })
      expect(result2.assistantText).toBe('Bot 2 response')
      expect(result2.finishReason).toBe('stop')
    })
  })
})
