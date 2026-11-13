import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import {
  ConversationPersistenceService,
  ConversationPersistenceError,
  parseAndLinkCitations
} from './conversation-persistence-service'
import type { PreparedConversationTurn } from './conversation-service'
import type { ConversationExecutionResult } from './conversation-execution-service'
import {
  type CitationDto,
  type SendMessageRequest,
  MAX_MESSAGE_CONTENT_LENGTH
} from '../../shared/conversations'

describe('ConversationPersistenceService (Phase 7 Step 7.6B.2)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let persistenceService: ConversationPersistenceService

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string
  let convAId: string
  let convBId: string

  const citation1: CitationDto = {
    citationNumber: 1,
    sourceId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    fileName: 'guidelines.pdf',
    fileType: 'pdf',
    pageNumber: 3,
    headingPath: ['Introduction', 'Compliance'],
    chunkIndex: 0
  }

  const citation2: CitationDto = {
    citationNumber: 2,
    sourceId: '33333333-3333-4333-8333-333333333333',
    chunkId: '44444444-4444-4444-8444-444444444444',
    fileName: 'notes.md',
    fileType: 'md',
    pageNumber: null,
    headingPath: ['Architecture', 'Overview'],
    chunkIndex: 1
  }

  const citation3: CitationDto = {
    citationNumber: 3,
    sourceId: '55555555-5555-4555-8555-555555555555',
    chunkId: '66666666-6666-4666-8666-666666666666',
    fileName: 'faq.txt',
    fileType: 'txt',
    pageNumber: null,
    headingPath: null,
    chunkIndex: 0
  }

  function createMockPreparedTurn(
    overrides?: Partial<PreparedConversationTurn>
  ): PreparedConversationTurn {
    const citationMap = new Map<number, CitationDto>([
      [1, citation1],
      [2, citation2],
      [3, citation3]
    ])

    return {
      botId: botAId,
      conversationId: convAId,
      providerConnectionId: '99999999-9999-4999-8999-999999999999',
      providerId: 'openai',
      modelId: 'gpt-4o',
      systemInstruction: 'You are Bot Alpha.',
      messages: [{ role: 'user', content: 'What are the compliance rules?' }],
      conversationMessages: [],
      retrievalStatus: 'SUCCESS',
      citationCandidates: [citation1, citation2, citation3],
      citationMap,
      contextWindowLimits: { inputTokens: 128000, outputTokens: 4096 },
      reservedOutputTokens: 4096,
      tokenEstimates: {
        systemTokens: 15,
        contextTokens: 120,
        historyTokens: 0,
        questionTokens: 8,
        totalEstimatedTokens: 143
      },
      includedMessageCount: 0,
      excludedMessageCount: 0,
      historyTrimmingOccurred: false,
      ...overrides
    }
  }

  function createMockExecutionResult(
    overrides?: Partial<ConversationExecutionResult>
  ): ConversationExecutionResult {
    return {
      assistantText: 'According to [1], compliance requires following standard protocols.',
      finishReason: 'stop',
      durationMs: 850,
      providerId: 'openai',
      modelId: 'gpt-4o',
      botId: botAId,
      conversationId: convAId,
      citationCandidates: [citation1, citation2, citation3],
      citationMap: new Map<number, CitationDto>([
        [1, citation1],
        [2, citation2],
        [3, citation3]
      ]),
      usage: {
        promptTokens: 145,
        completionTokens: 35,
        totalTokens: 180
      },
      ...overrides
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

    const kbA = kbRepo.create({ name: 'Knowledge Base Alpha' })
    const kbB = kbRepo.create({ name: 'Knowledge Base Beta' })
    kbAId = kbA.id
    kbBId = kbB.id

    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot Alpha',
      modelId: 'gpt-4o'
    })
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot Beta',
      modelId: 'claude-3-5-sonnet'
    })
    botAId = botA.id
    botBId = botB.id

    const convA = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Conversation Alpha'
    })
    const convB = convRepo.create({
      botId: botBId,
      knowledgeBaseId: kbBId,
      title: 'Conversation Beta'
    })
    convAId = convA.id
    convBId = convB.id

    persistenceService = new ConversationPersistenceService({ db })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // ==========================================================================
  // 1. Service Construction & Dependency Injection
  // ==========================================================================

  describe('Service Construction & Dependencies', () => {
    it('1. instantiates successfully using Database instance', () => {
      const service = new ConversationPersistenceService({ db })
      expect(service).toBeInstanceOf(ConversationPersistenceService)
    })

    it('2. instantiates successfully using explicit repositories', () => {
      const service = new ConversationPersistenceService({
        conversationRepo: convRepo,
        messageRepo: msgRepo
      })
      expect(service).toBeInstanceOf(ConversationPersistenceService)
    })

    it('3. rejects instantiation when dependencies object is missing or null', () => {
      expect(
        () => new ConversationPersistenceService(null as unknown as { db: Database.Database })
      ).toThrow(ConversationPersistenceError)
      expect(
        () => new ConversationPersistenceService(null as unknown as { db: Database.Database })
      ).toThrow(/Dependencies object is required/)
    })

    it('4. rejects instantiation when db is omitted and repositories are missing', () => {
      expect(() => new ConversationPersistenceService({})).toThrow(ConversationPersistenceError)
      expect(() => new ConversationPersistenceService({ conversationRepo: convRepo })).toThrow(
        /MessageRepository is required/
      )
      expect(() => new ConversationPersistenceService({ messageRepo: msgRepo })).toThrow(
        /ConversationRepository is required/
      )
    })
  })

  // ==========================================================================
  // 2. User Message Persistence
  // ==========================================================================

  describe('User Message Persistence (persistUserMessage)', () => {
    it('5. persists valid user message with role "user" and default markdown format', () => {
      const preparedTurn = createMockPreparedTurn()
      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'How do we calculate EBITDA?'
      }

      const message = persistenceService.persistUserMessage(preparedTurn, request)

      expect(message.id).toBeDefined()
      expect(message.conversationId).toBe(convAId)
      expect(message.role).toBe('user')
      expect(message.content).toBe('How do we calculate EBITDA?')
      expect(message.contentFormat).toBe('markdown')
      expect(message.metadata).toEqual({})
      expect(message.tokenUsage).toBeNull()
      expect(message.createdAt).toBeGreaterThan(0)

      // Verify in DB via MessageRepository
      const list = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(message.id)
      expect(list[0].content).toBe('How do we calculate EBITDA?')
    })

    it('6. respects explicit content format ("text", "json", "markdown")', () => {
      const preparedTurn = createMockPreparedTurn()

      const reqText: SendMessageRequest = {
        conversationId: convAId,
        content: 'Simple plain text',
        contentFormat: 'text'
      }
      const msgText = persistenceService.persistUserMessage(preparedTurn, reqText)
      expect(msgText.contentFormat).toBe('text')

      const reqJson: SendMessageRequest = {
        conversationId: convAId,
        content: '{"key": "value"}',
        contentFormat: 'json'
      }
      const msgJson = persistenceService.persistUserMessage(preparedTurn, reqJson)
      expect(msgJson.contentFormat).toBe('json')
    })

    it('7. monotonically updates parent conversation updated_at', () => {
      const beforeConv = convRepo.getById(convAId, botAId, kbAId)!
      const preparedTurn = createMockPreparedTurn()
      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'Checking timestamps'
      }

      persistenceService.persistUserMessage(preparedTurn, request)

      const afterConv = convRepo.getById(convAId, botAId, kbAId)!
      expect(afterConv.updatedAt).toBeGreaterThanOrEqual(beforeConv.updatedAt)
    })

    it('8. rejects when request conversationId does not match prepared turn conversationId', () => {
      const preparedTurn = createMockPreparedTurn({ conversationId: convAId })
      const request: SendMessageRequest = {
        conversationId: convBId,
        content: 'Mismatched thread'
      }

      expect(() => persistenceService.persistUserMessage(preparedTurn, request)).toThrow(
        ConversationPersistenceError
      )
      try {
        persistenceService.persistUserMessage(preparedTurn, request)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_MISMATCH')
      }
    })

    it('9. rejects when conversation does not exist in the database', () => {
      const nonExistentConvId = '00000000-0000-4000-8000-000000000099'
      const preparedTurn = createMockPreparedTurn({ conversationId: nonExistentConvId })
      const request: SendMessageRequest = {
        conversationId: nonExistentConvId,
        content: 'Lost thread'
      }

      expect(() => persistenceService.persistUserMessage(preparedTurn, request)).toThrow(
        ConversationPersistenceError
      )
      try {
        persistenceService.persistUserMessage(preparedTurn, request)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })

    it('10. rejects when prepared turn botId does not match conversation parent bot', () => {
      // convA belongs to botA; prepare turn claiming botB owns convA
      const preparedTurn = createMockPreparedTurn({
        botId: botBId,
        conversationId: convAId
      })
      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'Cross-bot spoof attempt'
      }

      expect(() => persistenceService.persistUserMessage(preparedTurn, request)).toThrow(
        ConversationPersistenceError
      )
      try {
        persistenceService.persistUserMessage(preparedTurn, request)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('BOT_MISMATCH')
      }
    })

    it('11. rejects when conversation is archived', () => {
      // Archive convA
      db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), convAId)

      const preparedTurn = createMockPreparedTurn()
      const request: SendMessageRequest = {
        conversationId: convAId,
        content: 'Message into archived conversation'
      }

      expect(() => persistenceService.persistUserMessage(preparedTurn, request)).toThrow(
        ConversationPersistenceError
      )
      try {
        persistenceService.persistUserMessage(preparedTurn, request)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_ARCHIVED')
      }
    })

    it('12. rejects empty or blank user message content', () => {
      const preparedTurn = createMockPreparedTurn()

      expect(() =>
        persistenceService.persistUserMessage(preparedTurn, {
          conversationId: convAId,
          content: ''
        })
      ).toThrow(ConversationPersistenceError)

      expect(() =>
        persistenceService.persistUserMessage(preparedTurn, {
          conversationId: convAId,
          content: '   \n\t  '
        })
      ).toThrow(ConversationPersistenceError)
    })

    it('13. rejects message content exceeding MAX_MESSAGE_CONTENT_LENGTH', () => {
      const preparedTurn = createMockPreparedTurn()
      const hugeContent = 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)

      expect(() =>
        persistenceService.persistUserMessage(preparedTurn, {
          conversationId: convAId,
          content: hugeContent
        })
      ).toThrow(ConversationPersistenceError)
    })

    it('14. rejects request containing unauthorized injected keys (strict validation)', () => {
      const preparedTurn = createMockPreparedTurn()
      const maliciousRequest = {
        conversationId: convAId,
        content: 'Valid content',
        knowledgeBaseId: kbBId // Attempt to inject knowledgeBaseId
      } as unknown as SendMessageRequest

      expect(() => persistenceService.persistUserMessage(preparedTurn, maliciousRequest)).toThrow(
        ConversationPersistenceError
      )
    })

    it('15. rejects missing or null input arguments', () => {
      const preparedTurn = createMockPreparedTurn()
      const request: SendMessageRequest = { conversationId: convAId, content: 'Hello' }

      expect(() =>
        persistenceService.persistUserMessage(null as unknown as PreparedConversationTurn, request)
      ).toThrow(ConversationPersistenceError)

      expect(() =>
        persistenceService.persistUserMessage(preparedTurn, null as unknown as SendMessageRequest)
      ).toThrow(ConversationPersistenceError)
    })
  })

  // ==========================================================================
  // 3. Assistant Message Persistence
  // ==========================================================================

  describe('Assistant Message Persistence (persistAssistantMessage)', () => {
    it('16. persists valid assistant response with accumulated text, role "assistant", and markdown format', () => {
      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult({
        assistantText: 'Here is the summary of compliance guidelines.'
      })

      const message = persistenceService.persistAssistantMessage(preparedTurn, executionResult)

      expect(message.id).toBeDefined()
      expect(message.conversationId).toBe(convAId)
      expect(message.role).toBe('assistant')
      expect(message.content).toBe('Here is the summary of compliance guidelines.')
      expect(message.contentFormat).toBe('markdown')
      expect(message.metadata.providerId).toBe('openai')
      expect(message.metadata.modelId).toBe('gpt-4o')
      expect(message.metadata.generation?.finishReason).toBe('stop')
      expect(message.metadata.generation?.durationMs).toBe(850)
      expect(message.tokenUsage).toEqual({
        promptTokens: 145,
        completionTokens: 35,
        totalTokens: 180
      })
    })

    it('17. persists authentic provider token usage when present', () => {
      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult({
        usage: {
          promptTokens: 200,
          completionTokens: 80,
          totalTokens: 280
        }
      })

      const message = persistenceService.persistAssistantMessage(preparedTurn, executionResult)

      expect(message.tokenUsage).toEqual({
        promptTokens: 200,
        completionTokens: 80,
        totalTokens: 280
      })
    })

    it('18. persists null tokenUsage when provider usage is missing without substituting estimates', () => {
      const preparedTurn = createMockPreparedTurn({
        tokenEstimates: {
          systemTokens: 15,
          contextTokens: 120,
          historyTokens: 0,
          questionTokens: 8,
          totalEstimatedTokens: 143
        }
      })
      const executionResult = createMockExecutionResult({
        usage: undefined
      })

      const message = persistenceService.persistAssistantMessage(preparedTurn, executionResult)

      expect(message.tokenUsage).toBeNull()
      // Verify tokenUsage was not fabricated from tokenEstimates (143)
      expect(message.tokenUsage).not.toEqual(expect.objectContaining({ totalTokens: 143 }))
    })

    it('19. records generation metadata including finishReason and durationMs', () => {
      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult({
        finishReason: 'length',
        durationMs: 3450
      })

      const message = persistenceService.persistAssistantMessage(preparedTurn, executionResult)

      expect(message.metadata.generation).toEqual({
        finishReason: 'length',
        durationMs: 3450
      })
    })

    it('20. rejects persistence for aborted or cancelled execution (finishReason: "abort")', () => {
      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult({
        finishReason: 'abort',
        assistantText: 'Partial response before cancel'
      })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('EXECUTION_FAILED')
      }

      // Verify nothing was written to messages table
      const list = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(list).toHaveLength(0)
    })

    it('21. rejects persistence when executionResult botId does not match prepared turn', () => {
      const preparedTurn = createMockPreparedTurn({ botId: botAId })
      const executionResult = createMockExecutionResult({ botId: botBId })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('BOT_MISMATCH')
      }
    })

    it('22. rejects persistence when executionResult conversationId does not match prepared turn', () => {
      const preparedTurn = createMockPreparedTurn({ conversationId: convAId })
      const executionResult = createMockExecutionResult({ conversationId: convBId })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_MISMATCH')
      }
    })

    it('23. rejects persistence when executionResult providerId does not match prepared turn', () => {
      const preparedTurn = createMockPreparedTurn({ providerId: 'openai' })
      const executionResult = createMockExecutionResult({ providerId: 'anthropic' })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('PROVIDER_MISMATCH')
      }
    })

    it('24. rejects persistence when executionResult modelId does not match prepared turn', () => {
      const preparedTurn = createMockPreparedTurn({ modelId: 'gpt-4o' })
      const executionResult = createMockExecutionResult({ modelId: 'gpt-4o-mini' })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('MODEL_MISMATCH')
      }
    })

    it('25. rejects persistence when conversation is archived', () => {
      db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), convAId)

      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult()

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_ARCHIVED')
      }
    })

    it('26. rejects persistence when conversation does not exist', () => {
      const nonExistentConvId = '00000000-0000-4000-8000-000000000088'
      const preparedTurn = createMockPreparedTurn({ conversationId: nonExistentConvId })
      const executionResult = createMockExecutionResult({ conversationId: nonExistentConvId })

      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      ).toThrow(ConversationPersistenceError)

      try {
        persistenceService.persistAssistantMessage(preparedTurn, executionResult)
      } catch (err) {
        expect((err as ConversationPersistenceError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })

    it('27. rejects null or malformed inputs for assistant persistence', () => {
      const preparedTurn = createMockPreparedTurn()
      const executionResult = createMockExecutionResult()

      expect(() =>
        persistenceService.persistAssistantMessage(
          null as unknown as PreparedConversationTurn,
          executionResult
        )
      ).toThrow(ConversationPersistenceError)

      expect(() =>
        persistenceService.persistAssistantMessage(
          preparedTurn,
          null as unknown as ConversationExecutionResult
        )
      ).toThrow(ConversationPersistenceError)

      expect(() =>
        persistenceService.persistAssistantMessage(
          preparedTurn,
          createMockExecutionResult({ assistantText: null as unknown as string })
        )
      ).toThrow(ConversationPersistenceError)
    })
  })

  // ==========================================================================
  // 4. Citation Parsing, Linking & Authenticity
  // ==========================================================================

  describe('Citation Parsing & Linking (parseAndLinkCitations)', () => {
    const citationMap = new Map<number, CitationDto>([
      [1, citation1],
      [2, citation2],
      [3, citation3]
    ])

    it('28. resolves a single valid citation marker [1]', () => {
      const text = 'Under the compliance charter [1], all records must be signed.'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(1)
      expect(citations[0]).toEqual(citation1)
    })

    it('29. resolves multiple distinct citations [1] and [2]', () => {
      const text = 'First fact is from [1]. Second fact is in [2].'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(2)
      expect(citations[0]).toEqual(citation1)
      expect(citations[1]).toEqual(citation2)
    })

    it('30. resolves comma-separated bracketed citations [1, 2]', () => {
      const text = 'Both sources agree on this point [1, 2].'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(2)
      expect(citations[0]).toEqual(citation1)
      expect(citations[1]).toEqual(citation2)
    })

    it('31. resolves adjacent bracketed citations [1][2]', () => {
      const text = 'Multiple distinct references [1][2] were used.'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(2)
      expect(citations[0]).toEqual(citation1)
      expect(citations[1]).toEqual(citation2)
    })

    it('32. deduplicates repeated citations while strictly preserving first-appearance order', () => {
      const text = 'Claim A [2], followed by Claim B [1], and repeated [2], and repeated [1].'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(2)
      expect(citations[0]).toEqual(citation2) // first seen is [2]
      expect(citations[1]).toEqual(citation1) // next seen is [1]
    })

    it('33. ignores out-of-range or unknown citation numbers [99]', () => {
      const text = 'Claim with hallucinated citation [99] and valid citation [1].'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(1)
      expect(citations[0]).toEqual(citation1)
    })

    it('34. ignores zero, negative, and decimal citation numbers ([0], [-1], [1.5])', () => {
      const text = 'Invalid markers [0], [-1], [1.5], and valid [3].'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(1)
      expect(citations[0]).toEqual(citation3)
    })

    it('35. returns empty array when citation map is empty or undefined', () => {
      const text = 'Some text referencing [1] and [2].'
      expect(parseAndLinkCitations(text, new Map())).toEqual([])
      expect(parseAndLinkCitations(text, undefined)).toEqual([])
      expect(parseAndLinkCitations(text, null)).toEqual([])
    })

    it('36. does not match ordinary Markdown numbered lists', () => {
      const text = '1. First item\n2. Second item\n3. Third item'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toEqual([])
    })

    it('37. does not match ordinary Markdown links [link title](https://example.com)', () => {
      const text = 'Check out [our website](https://example.com) for more details.'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toEqual([])
    })

    it('37b. does not match numeric Markdown links [1](https://example.com)', () => {
      const text = 'See the documentation at [1](https://example.com) for details.'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toEqual([])
    })

    it('37c. does not match Markdown link reference definitions [1]: https://example.com', () => {
      const text = '[1]: https://example.com "Reference definition"'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toEqual([])
    })

    it('37d. does not match citation markers inside inline code spans', () => {
      const text = 'Use array index `[1]` or `items[2]` in your code, but see real source [3].'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toHaveLength(1)
      expect(citations[0]).toEqual(citation3)
    })

    it('37e. does not match citation markers inside fenced code blocks', () => {
      const text = `
Here is a code example:
\`\`\`typescript
const arr = [1, 2];
console.log(arr[1]);
\`\`\`
Based on our verified source [1], this is correct.
      `
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toHaveLength(1)
      expect(citations[0]).toEqual(citation1)
    })

    it('38. returns empty array when assistant text has no citation markers', () => {
      const text = 'The capital of France is Paris. No external citations needed.'
      const citations = parseAndLinkCitations(text, citationMap)
      expect(citations).toEqual([])
    })

    it('39. returns empty array for empty or whitespace assistant text', () => {
      expect(parseAndLinkCitations('', citationMap)).toEqual([])
      expect(parseAndLinkCitations('    ', citationMap)).toEqual([])
    })

    it('40. preserves complete authentic CitationDto without trusting model strings', () => {
      const text = 'Model text says: Source file is /etc/secret.txt on page 999 [1]'
      const citations = parseAndLinkCitations(text, citationMap)

      expect(citations).toHaveLength(1)
      const cit = citations[0]
      // Authentic database fields preserved
      expect(cit.sourceId).toBe('11111111-1111-4111-8111-111111111111')
      expect(cit.chunkId).toBe('22222222-2222-4222-8222-222222222222')
      expect(cit.fileName).toBe('guidelines.pdf') // NOT /etc/secret.txt
      expect(cit.pageNumber).toBe(3) // NOT 999
      expect(cit.headingPath).toEqual(['Introduction', 'Compliance'])
      expect(cit.fileType).toBe('pdf')
    })
  })

  // ==========================================================================
  // 5. End-to-End Persistence with Citations & Metadata
  // ==========================================================================

  describe('End-to-End Message Turn Persistence with Citations', () => {
    it('41. persists user turn followed by assistant turn with linked citations', () => {
      const preparedTurn = createMockPreparedTurn()

      // Step 1: User message persisted before provider call
      const userRequest: SendMessageRequest = {
        conversationId: convAId,
        content: 'Explain the compliance rules from our documents.'
      }
      const userMsg = persistenceService.persistUserMessage(preparedTurn, userRequest)
      expect(userMsg.role).toBe('user')

      // Step 2: Assistant message persisted after provider call
      const execResult = createMockExecutionResult({
        assistantText:
          'Based on [1], all compliance records are audited annually. Furthermore, [2] outlines the architecture overview.',
        finishReason: 'stop',
        durationMs: 1100,
        usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 }
      })
      const assistantMsg = persistenceService.persistAssistantMessage(preparedTurn, execResult)

      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.metadata.citations).toHaveLength(2)
      expect(assistantMsg.metadata.citations![0].citationNumber).toBe(1)
      expect(assistantMsg.metadata.citations![1].citationNumber).toBe(2)
      expect(assistantMsg.metadata.generation?.finishReason).toBe('stop')
      expect(assistantMsg.tokenUsage?.totalTokens).toBe(165)

      // Step 3: Verify complete thread in SQLite
      const thread = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(thread).toHaveLength(2)
      expect(thread[0].id).toBe(userMsg.id)
      expect(thread[0].role).toBe('user')
      expect(thread[1].id).toBe(assistantMsg.id)
      expect(thread[1].role).toBe('assistant')
      expect(thread[1].metadata.citations).toHaveLength(2)
    })

    it('42. persists assistant response with empty citation list when no citations are referenced', () => {
      const preparedTurn = createMockPreparedTurn()
      const execResult = createMockExecutionResult({
        assistantText: 'I can answer that directly without referencing retrieved docs.'
      })

      const assistantMsg = persistenceService.persistAssistantMessage(preparedTurn, execResult)
      expect(assistantMsg.metadata.citations).toEqual([])
    })

    it('43. persists assistant response with only valid citations when model invents non-existent citations', () => {
      const preparedTurn = createMockPreparedTurn()
      const execResult = createMockExecutionResult({
        assistantText: 'Here is fact [1], and invented fact [88], and valid fact [3].'
      })

      const assistantMsg = persistenceService.persistAssistantMessage(preparedTurn, execResult)
      expect(assistantMsg.metadata.citations).toHaveLength(2)
      expect(assistantMsg.metadata.citations![0].citationNumber).toBe(1)
      expect(assistantMsg.metadata.citations![1].citationNumber).toBe(3)
    })
  })

  // ==========================================================================
  // 6. Security, Isolation, and Privacy Invariants
  // ==========================================================================

  describe('Security and Data Isolation Invariants', () => {
    it('44. enforces cross-bot isolation: conversation for Bot A cannot receive Bot B messages', () => {
      // User message
      const preparedTurnForBotB = createMockPreparedTurn({
        botId: botBId,
        conversationId: convAId // Attacker tries to inject Bot B into Conv A
      })
      const userRequest: SendMessageRequest = {
        conversationId: convAId,
        content: 'Malicious injection'
      }

      expect(() => persistenceService.persistUserMessage(preparedTurnForBotB, userRequest)).toThrow(
        ConversationPersistenceError
      )

      // Assistant message
      const execResultForBotB = createMockExecutionResult({
        botId: botBId,
        conversationId: convAId
      })
      expect(() =>
        persistenceService.persistAssistantMessage(preparedTurnForBotB, execResultForBotB)
      ).toThrow(ConversationPersistenceError)
    })

    it('45. resolves authoritative knowledgeBaseId from conversation table, ignoring external parameters', () => {
      const preparedTurn = createMockPreparedTurn()
      const userRequest: SendMessageRequest = {
        conversationId: convAId,
        content: 'Check knowledgeBaseId resolution'
      }

      const userMsg = persistenceService.persistUserMessage(preparedTurn, userRequest)
      const assistantMsg = persistenceService.persistAssistantMessage(
        preparedTurn,
        createMockExecutionResult()
      )
      expect(userMsg.id).toBeDefined()
      expect(assistantMsg.id).toBeDefined()

      // Verify messages exist in kbAId in the DB
      const messagesInKbA = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messagesInKbA).toHaveLength(2)

      // Verify querying with kbBId rejects with ValidationError due to DB ownership constraint
      expect(() => msgRepo.listByConversation(convAId, botAId, kbBId)).toThrow()

      // Verify direct SQL query with kbBId returns 0 rows
      const rowsInKbB = db
        .prepare(
          `SELECT m.id FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           WHERE c.id = ? AND c.knowledge_base_id = ?`
        )
        .all(convAId, kbBId)
      expect(rowsInKbB).toHaveLength(0)
    })

    it('46. never leaks credentials, providerConnectionId, or filesystem paths into metadata', () => {
      const preparedTurn = createMockPreparedTurn({
        providerConnectionId: 'super-secret-connection-id-12345'
      })
      const execResult = createMockExecutionResult()

      const assistantMsg = persistenceService.persistAssistantMessage(preparedTurn, execResult)

      // Inspect serialized metadata in DB directly
      const row = db
        .prepare('SELECT metadata_json FROM messages WHERE id = ?')
        .get(assistantMsg.id) as { metadata_json: string }

      expect(row.metadata_json).not.toContain('super-secret-connection-id-12345')
      expect(row.metadata_json).not.toContain('apiKey')
      expect(row.metadata_json).not.toContain('authorization')
      expect(row.metadata_json).not.toContain('password')
    })
  })
})
