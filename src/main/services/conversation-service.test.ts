import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import type { CredentialRef } from '../database/repositories/types'
import { ProviderRegistry } from '../providers/provider-registry'
import { INITIAL_PROVIDERS, INITIAL_MODELS } from '../providers/model-catalog'
import type { ModelDescriptor } from '../providers/types'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { BotRagService, BotRagServiceError } from './bot-rag-service'
import { ConversationService, type PrepareTurnRequest } from './conversation-service'

describe('ConversationService (Phase 7 Step 7.6A)', () => {
  let tempDir: string
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let conversationRepo: ConversationRepository
  let messageRepo: MessageRepository
  let providerConnRepo: ProviderConnectionRepository
  let sourceRepo: KnowledgeSourceRepository
  let activeContext: ActiveWorkspaceContext
  let ragService: BotRagService
  let conversationService: ConversationService

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string
  let convAId: string
  let convBId: string
  let defaultConnId: string
  const sessionA = 'session-window-1'
  const sessionB = 'session-window-2'

  const createDocChunk = (
    kbId: string,
    title: string,
    content: string
  ): { sourceId: string; chunkId: string } => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: `${title}.txt`,
      original_file_name: `${title}.txt`,
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1024,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })

    const chunkId = randomUUID()
    sourceRepo.insertChunks([
      {
        id: chunkId,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content,
        page_number: null,
        token_count: Math.ceil(content.length / 4),
        metadata_json: JSON.stringify({ section: 'Introduction' })
      }
    ])

    return { sourceId, chunkId }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-service-test-'))
    const dbPath = path.join(tempDir, 'test-conv.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    conversationRepo = new ConversationRepository(db)
    messageRepo = new MessageRepository(db)
    providerConnRepo = new ProviderConnectionRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)

    activeContext = new ActiveWorkspaceContext({ kbRepo })
    ragService = new BotRagService({
      db,
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      knowledgeSourceRepository: sourceRepo
    })

    conversationService = new ConversationService({
      activeWorkspaceContext: activeContext,
      botRepo,
      conversationRepo,
      messageRepo,
      providerConnectionRepo: providerConnRepo,
      registry: new ProviderRegistry(INITIAL_PROVIDERS, INITIAL_MODELS),
      botRagService: ragService
    })

    // Setup active provider connection (OpenAI)
    const conn = providerConnRepo.create({
      providerId: 'openai',
      label: 'Default OpenAI Conn',
      credentialRef: `cred_${randomUUID()}` as CredentialRef,
      status: 'active'
    })
    defaultConnId = conn.id

    // Setup two Knowledge Bases
    const kbA = kbRepo.create({ name: 'Knowledge Base Alpha', description: 'Alpha documents' })
    const kbB = kbRepo.create({ name: 'Knowledge Base Beta', description: 'Beta documents' })
    kbAId = kbA.id
    kbBId = kbB.id

    // Activate sessionA for kbA and sessionB for kbB
    activeContext.activateWorkspace(sessionA, kbAId)
    activeContext.activateWorkspace(sessionB, kbBId)

    // Setup Bot in KB A
    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Alpha Bot',
      description: 'Assistant for Alpha KB',
      systemPrompt: 'You are Alpha Bot. Assist the user with Alpha data.',
      modelId: 'gpt-6-luna',
      providerConnectionId: defaultConnId,
      toolPermissions: ['search_knowledge_base', 'read_knowledge_base_document']
    })
    botAId = botA.id

    // Setup Bot in KB B
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Beta Bot',
      description: 'Assistant for Beta KB',
      systemPrompt: 'You are Beta Bot.',
      modelId: 'gpt-6-luna',
      providerConnectionId: defaultConnId,
      toolPermissions: ['search_knowledge_base']
    })
    botBId = botB.id

    // Setup Conversations
    const convA = conversationRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Conversation Alpha'
    })
    convAId = convA.id

    const convB = conversationRepo.create({
      botId: botBId,
      knowledgeBaseId: kbBId,
      title: 'Conversation Beta'
    })
    convBId = convB.id
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
  // Session and ownership
  // ==========================================================================

  describe('Session and ownership', () => {
    it('1. Preparation succeeds for an active KB session', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'What is Alpha?'
      })

      expect(turn).toBeDefined()
      expect(turn.botId).toBe(botAId)
      expect(turn.conversationId).toBe(convAId)
      expect(turn.providerConnectionId).toBe(defaultConnId)
      expect(turn.providerId).toBe('openai')
      expect(turn.modelId).toBe('gpt-6-luna')
      expect(turn.systemInstruction).toContain('You are Alpha Bot.')
      expect(turn.messages.length).toBeGreaterThanOrEqual(1)
      expect(turn.conversationMessages.length).toBe(1)
      expect(turn.conversationMessages[0].role).toBe('user')
      expect(turn.conversationMessages[0].content).toContain('What is Alpha?')
    })

    it('2. No active workspace is rejected', () => {
      expect(() => {
        conversationService.prepareTurn('unregistered-session-999', {
          botId: botAId,
          conversationId: convAId,
          question: 'Hello?'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'NO_ACTIVE_WORKSPACE'
        })
      )
    })

    it('3. Bot from another KB is rejected', () => {
      // Bot B belongs to KB B, but sessionA is active on KB A
      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botBId,
          conversationId: convAId,
          question: 'Access Beta Bot from Alpha session'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'BOT_NOT_FOUND'
        })
      )
    })

    it('4. Archived Bot is rejected', () => {
      botRepo.update(botAId, kbAId, { status: 'archived' })

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Talk to archived bot'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'BOT_ARCHIVED'
        })
      )
    })

    it('5. Conversation belonging to another Bot is rejected', () => {
      // Create a second bot in KB A
      const botA2 = botRepo.create({
        knowledgeBaseId: kbAId,
        name: 'Alpha Bot 2',
        systemPrompt: 'Second bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: defaultConnId,
        toolPermissions: []
      })

      // convAId belongs to botAId, not botA2.id
      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botA2.id,
          conversationId: convAId,
          question: 'Access conv of bot 1 from bot 2'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONVERSATION_NOT_FOUND'
        })
      )
    })

    it('6. Conversation belonging to another KB is rejected', () => {
      // convBId belongs to KB B, sessionA is active on KB A
      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convBId,
          question: 'Cross-KB conversation access'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONVERSATION_NOT_FOUND'
        })
      )
    })

    it('7. Archived conversation is rejected', () => {
      db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), convAId)

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Talk to archived conversation'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONVERSATION_ARCHIVED'
        })
      )
    })
  })

  // ==========================================================================
  // Provider configuration
  // ==========================================================================

  describe('Provider configuration', () => {
    it('8. Correct provider connection resolves', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Test provider connection'
      })

      expect(turn.providerConnectionId).toBe(defaultConnId)
      expect(turn.providerId).toBe('openai')
    })

    it('9. Correct model resolves from the catalog', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Test model'
      })

      expect(turn.modelId).toBe('gpt-6-luna')
      expect(turn.contextWindowLimits.inputTokens).toBe(128000)
      expect(turn.contextWindowLimits.outputTokens).toBe(16384)
    })

    it('10. Missing connection rejected', () => {
      const nonExistentConnId = randomUUID()
      db.pragma('foreign_keys = OFF')
      db.prepare('UPDATE bots SET provider_connection_id = ? WHERE id = ?').run(
        nonExistentConnId,
        botAId
      )
      db.pragma('foreign_keys = ON')

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Missing connection'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONNECTION_NOT_FOUND'
        })
      )
    })

    it('11. Unavailable connection rejected', () => {
      providerConnRepo.updateStatus(defaultConnId, 'error')

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Unavailable connection'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONNECTION_UNAVAILABLE'
        })
      )
    })

    it('12. Unsupported model rejected', () => {
      // Bot has an unknown modelId in SQLite
      db.prepare("UPDATE bots SET model_id = 'unsupported-mystery-model' WHERE id = ?").run(botAId)

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Unsupported model'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'MODEL_NOT_FOUND'
        })
      )
    })

    it('13. Cross-provider mismatch rejected', () => {
      // Connection is openai, but model is Anthropic claude-sonnet-5-5
      db.prepare("UPDATE bots SET model_id = 'claude-sonnet-5-5' WHERE id = ?").run(botAId)

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Cross provider mismatch'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CROSS_PROVIDER_MODEL_MISMATCH'
        })
      )
    })

    it('14. No credential decryption occurs during preparation', () => {
      const getByIdSpy = vi.spyOn(providerConnRepo, 'getById')

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'No credential decryption'
      })

      expect(getByIdSpy).toHaveBeenCalledWith(defaultConnId)
      // Prepared result must NOT have credentialRef or any plaintext/ciphertext secret
      expect((turn as unknown as Record<string, unknown>).credentialRef).toBeUndefined()
      expect((turn as unknown as Record<string, unknown>).apiKey).toBeUndefined()
    })
  })

  // ==========================================================================
  // History and retrieval
  // ==========================================================================

  describe('History and retrieval', () => {
    it('15. History is loaded in chronological order', () => {
      const insertStmt = db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, content_format, content, created_at
        ) VALUES (?, ?, ?, 'markdown', ?, ?)
      `)

      insertStmt.run(randomUUID(), convAId, 'user', 'First question', 1000)
      insertStmt.run(randomUUID(), convAId, 'assistant', 'First answer', 2000)
      insertStmt.run(randomUUID(), convAId, 'user', 'Second question', 3000)
      insertStmt.run(randomUUID(), convAId, 'assistant', 'Second answer', 4000)

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Third question'
      })

      expect(turn.conversationMessages).toHaveLength(5)
      expect(turn.conversationMessages[0]).toEqual({ role: 'user', content: 'First question' })
      expect(turn.conversationMessages[1]).toEqual({ role: 'assistant', content: 'First answer' })
      expect(turn.conversationMessages[2]).toEqual({ role: 'user', content: 'Second question' })
      expect(turn.conversationMessages[3]).toEqual({ role: 'assistant', content: 'Second answer' })
      expect(turn.conversationMessages[4].role).toBe('user')
      expect(turn.conversationMessages[4].content).toContain('Third question')
      expect(turn.includedMessageCount).toBe(4)
      expect(turn.excludedMessageCount).toBe(0)
    })

    it('16. Current question is not duplicated', () => {
      messageRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Existing user message'
      })

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'New question'
      })

      // The new question appears only once as the final message
      const matchingMessages = turn.conversationMessages.filter((m) =>
        m.content.includes('New question')
      )
      expect(matchingMessages).toHaveLength(1)
    })

    it('17. BotRagService receives botId and query without knowledgeBaseId', () => {
      const retrieveSpy = vi.spyOn(ragService, 'retrieve')

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Alpha knowledge query'
      })

      expect(retrieveSpy).toHaveBeenCalledTimes(1)
      const callArg = retrieveSpy.mock.calls[0][0]
      expect(callArg.botId).toBe(botAId)
      expect(callArg.query).toBe('Alpha knowledge query')
      expect((callArg as unknown as Record<string, unknown>).knowledgeBaseId).toBeUndefined()
    })

    it('18. Retrieval success is included in the prompt', () => {
      createDocChunk(kbAId, 'AlphaGuide', 'Quantum architecture protocol 42 is active.')

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Quantum architecture protocol'
      })

      expect(turn.retrievalStatus).toBe('SUCCESS')
      expect(turn.citationCandidates.length).toBeGreaterThan(0)
      expect(turn.citationMap.size).toBeGreaterThan(0)
      const lastUserMsg = turn.conversationMessages[turn.conversationMessages.length - 1]
      expect(lastUserMsg.content).toContain('<retrieved_context>')
      expect(lastUserMsg.content).toContain('Quantum architecture protocol 42')
    })

    it('19. NO_RESULTS is handled correctly', () => {
      // Search for something non-existent in documents
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'NonExistentZebraXylophone999'
      })

      expect(turn.retrievalStatus).toBe('NO_RESULTS')
      expect(turn.citationCandidates).toHaveLength(0)
      expect(turn.citationMap.size).toBe(0)
      const lastUserMsg = turn.conversationMessages[turn.conversationMessages.length - 1]
      expect(lastUserMsg.content).not.toContain('<retrieved_context>')
      expect(lastUserMsg.content).toBe('NonExistentZebraXylophone999')
    })

    it('20. RETRIEVAL_DISABLED is handled correctly', () => {
      // Create Bot without search_knowledge_base permission
      const botNoSearch = botRepo.create({
        knowledgeBaseId: kbAId,
        name: 'No Search Bot',
        systemPrompt: 'No search',
        modelId: 'gpt-6-luna',
        providerConnectionId: defaultConnId,
        toolPermissions: []
      })
      const convNoSearch = conversationRepo.create({
        botId: botNoSearch.id,
        knowledgeBaseId: kbAId,
        title: 'No search conv'
      })

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botNoSearch.id,
        conversationId: convNoSearch.id,
        question: 'Any documents here?'
      })

      expect(turn.retrievalStatus).toBe('RETRIEVAL_DISABLED')
      expect(turn.citationCandidates).toHaveLength(0)
      const lastUserMsg = turn.conversationMessages[turn.conversationMessages.length - 1]
      expect(lastUserMsg.content).toBe('Any documents here?')
    })

    it('21. Retrieval errors are not converted into NO_RESULTS', () => {
      vi.spyOn(ragService, 'retrieve').mockImplementationOnce(() => {
        throw new BotRagServiceError('Simulated SQLite disk corruption', 'DATABASE_ERROR')
      })

      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Fail retrieval'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'RETRIEVAL_ERROR'
        })
      )
    })
  })

  // ==========================================================================
  // Prompt and context
  // ==========================================================================

  describe('Prompt and context', () => {
    it('22. RagPromptBuilder is used', () => {
      createDocChunk(kbAId, 'DesignDoc', 'System design specifications.')

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'System design specifications'
      })

      // Verified via structured output and system instruction containing citations policy
      expect(turn.systemInstruction).toContain('Citation Requirements')
      expect(turn.systemInstruction).toContain('Alpha Bot')
    })

    it('23. ConversationContextManager is used', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Context manager check'
      })

      expect(turn.tokenEstimates).toBeDefined()
      expect(turn.tokenEstimates.totalEstimatedTokens).toBeGreaterThan(0)
      expect(turn.includedMessageCount).toBe(0)
      expect(turn.excludedMessageCount).toBe(0)
      expect(turn.historyTrimmingOccurred).toBe(false)
    })

    it('24. Context overflow is safely rejected', () => {
      // Modify gpt-6-luna with an input limit where availableInputTokens > 0 (1200 - 20 - 1000 = 180)
      // but mandatory prompt (~426 tokens) cannot fit within 180 tokens
      const tinyModels: ModelDescriptor[] = INITIAL_MODELS.map((m) =>
        m.id === 'gpt-6-luna'
          ? {
              ...m,
              contextWindow: { inputTokens: 1200, outputTokens: 20 }
            }
          : m
      )
      const tinyRegistry = new ProviderRegistry(INITIAL_PROVIDERS, tinyModels)

      const serviceWithTiny = new ConversationService({
        activeWorkspaceContext: activeContext,
        botRepo,
        conversationRepo,
        messageRepo,
        providerConnectionRepo: providerConnRepo,
        registry: tinyRegistry,
        botRagService: ragService
      })

      expect(() => {
        serviceWithTiny.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'This question easily exceeds the tiny remaining token budget.'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONTEXT_LENGTH_EXCEEDED'
        })
      )
    })

    it('25. Model input limit is respected', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Check input limit'
      })

      expect(turn.contextWindowLimits.inputTokens).toBe(128000)
      expect(turn.tokenEstimates.totalEstimatedTokens).toBeLessThan(
        turn.contextWindowLimits.inputTokens
      )
    })

    it('26. Output reservation cannot exceed model output capacity', () => {
      // Model gpt-6-luna has outputTokens = 16384. Requesting 20000 exceeds it.
      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Check output reservation',
          reservedOutputTokens: 20000
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'INVALID_INPUT'
        })
      )
    })

    it('27. Missing model context metadata rejected', () => {
      const badModels: ModelDescriptor[] = INITIAL_MODELS.map((m) =>
        m.id === 'gpt-6-luna'
          ? {
              ...m,
              contextWindow: undefined
            }
          : m
      )
      const badRegistry = new ProviderRegistry(INITIAL_PROVIDERS, badModels)

      const badService = new ConversationService({
        activeWorkspaceContext: activeContext,
        botRepo,
        conversationRepo,
        messageRepo,
        providerConnectionRepo: providerConnRepo,
        registry: badRegistry,
        botRagService: ragService
      })

      expect(() => {
        badService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convAId,
          question: 'Hello'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'MODEL_CONTEXT_METADATA_UNAVAILABLE'
        })
      )
    })

    it('28. Citation candidates preserve authentic source/chunk IDs internally', () => {
      const { sourceId, chunkId } = createDocChunk(
        kbAId,
        'KernelDoc',
        'Kernel microcode revision 8.9 initialized.'
      )

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Kernel microcode revision'
      })

      expect(turn.citationCandidates.length).toBeGreaterThan(0)
      const candidate = turn.citationCandidates[0]
      expect(candidate.sourceId).toBe(sourceId)
      expect(candidate.chunkId).toBe(chunkId)
      expect(candidate.citationNumber).toBe(1)
    })

    it('29. Citation map remains Main-process-only', () => {
      createDocChunk(kbAId, 'DocMap', 'Unique content for citation map verification.')

      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Unique content for citation map'
      })

      expect(turn.citationMap).toBeDefined()
      expect(typeof turn.citationMap.get).toBe('function')
      const entry = turn.citationMap.get(1)
      expect(entry).toBeDefined()
      expect(entry?.citationNumber).toBe(1)
    })
  })

  // ==========================================================================
  // Side-effect prevention
  // ==========================================================================

  describe('Side-effect prevention', () => {
    it('30. No user message is inserted', () => {
      const messagesBefore = messageRepo.listByConversation(convAId, botAId, kbAId)

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Does this persist a user message?'
      })

      const messagesAfter = messageRepo.listByConversation(convAId, botAId, kbAId)
      expect(messagesAfter.length).toBe(messagesBefore.length)
    })

    it('31. No assistant message is inserted', () => {
      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Does this persist an assistant message?'
      })

      const allMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as {
        count: number
      }
      expect(allMessages.count).toBe(0)
    })

    it('32. Conversation timestamps remain unchanged', () => {
      const convBefore = conversationRepo.getById(convAId, botAId, kbAId)!

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Does this touch conversation updatedAt?'
      })

      const convAfter = conversationRepo.getById(convAId, botAId, kbAId)!
      expect(convAfter.updatedAt).toBe(convBefore.updatedAt)
    })

    it('33. No provider call occurs', () => {
      // Mock global fetch to verify no HTTP calls happen
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Does this call the provider?'
      })

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('34. No network request occurs', () => {
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Network verification'
      })

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('35. No filesystem write occurs', () => {
      const filesBefore = fs.readdirSync(tempDir)

      conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'File system check'
      })

      const filesAfter = fs.readdirSync(tempDir)
      expect(filesAfter).toEqual(filesBefore)
    })
  })

  // ==========================================================================
  // Security
  // ==========================================================================

  describe('Security', () => {
    it('36. A renderer-like forged knowledgeBaseId cannot change active KB scope', () => {
      createDocChunk(kbBId, 'SecretBetaDoc', 'Top secret beta document.')

      // Attacker attempts to pass forged knowledgeBaseId pointing to KB B
      const maliciousRequest = {
        botId: botAId,
        conversationId: convAId,
        question: 'Top secret beta document',
        knowledgeBaseId: kbBId
      } as unknown as PrepareTurnRequest

      const turn = conversationService.prepareTurn(sessionA, maliciousRequest)

      // Bot A and session A are in KB A. Retrieval must NOT find documents in KB B.
      expect(turn.retrievalStatus).toBe('NO_RESULTS')
      expect(turn.citationCandidates).toHaveLength(0)
    })

    it('37. A fabricated citation cannot enter the prepared result', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Question without citations'
      })

      // Citations must come exclusively from authentic database retrieval
      expect(turn.citationCandidates).toHaveLength(0)
      expect(turn.citationMap.size).toBe(0)
    })

    it('38. No credential references or filesystem paths appear in errors/results', () => {
      const turn = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Check sanitization'
      })

      const turnSerialized = JSON.stringify(turn)
      expect(turnSerialized).not.toContain('cred_')
      expect(turnSerialized).not.toContain(tempDir)
      expect(turnSerialized).not.toContain('.db')

      try {
        conversationService.prepareTurn('invalid-session', {
          botId: botAId,
          conversationId: convAId,
          question: 'Hello'
        })
      } catch (err: unknown) {
        const error = err as Error
        expect(error.message).not.toContain(tempDir)
        expect(error.message).not.toContain('cred_')
      }
    })

    it('39. Same Bot can prepare different independent conversations', () => {
      const convA2 = conversationRepo.create({
        botId: botAId,
        knowledgeBaseId: kbAId,
        title: 'Conversation Alpha 2'
      })

      messageRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Conversation 1 history message'
      })

      messageRepo.create({
        conversationId: convA2.id,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Conversation 2 history message'
      })

      const turn1 = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convAId,
        question: 'Question 1'
      })

      const turn2 = conversationService.prepareTurn(sessionA, {
        botId: botAId,
        conversationId: convA2.id,
        question: 'Question 2'
      })

      expect(turn1.conversationId).toBe(convAId)
      expect(turn2.conversationId).toBe(convA2.id)
      expect(turn1.conversationMessages[0].content).toBe('Conversation 1 history message')
      expect(turn2.conversationMessages[0].content).toBe('Conversation 2 history message')
    })

    it('40. Different Bots remain isolated', () => {
      // Bot A cannot prepare convBId (belongs to Bot B)
      expect(() => {
        conversationService.prepareTurn(sessionA, {
          botId: botAId,
          conversationId: convBId,
          question: 'Cross bot access'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONVERSATION_NOT_FOUND'
        })
      )

      // Bot B cannot prepare convAId (belongs to Bot A)
      expect(() => {
        conversationService.prepareTurn(sessionB, {
          botId: botBId,
          conversationId: convAId,
          question: 'Cross bot access'
        })
      }).toThrowError(
        expect.objectContaining({
          code: 'CONVERSATION_NOT_FOUND'
        })
      )
    })
  })
})
