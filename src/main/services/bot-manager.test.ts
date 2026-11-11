import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import {
  createKnowledgeBaseFixture,
  createProviderConnectionFixture
} from '../database/testing/fixtures'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { ProviderRegistry } from '../providers/provider-registry'
import { BotManagerService } from './bot-manager'
import { ActiveWorkspaceContext } from './active-workspace-context'
import {
  NoActiveWorkspaceError,
  BotNotFoundError,
  BotValidationError,
  BotManagerError
} from './bot-errors'
import type { CreateBotRequest, UpdateBotRequest } from '../../shared/bots'

describe('BotManagerService (Step 6.2)', () => {
  let testCtx: MigratedTestDatabaseContext
  let connectionRepo: ProviderConnectionRepository
  let registry: ProviderRegistry
  let activeContext: ActiveWorkspaceContext
  let botManager: BotManagerService

  let openAiConnId: string
  let anthropicConnId: string

  const sessionA = 'session-window-a'
  const sessionB = 'session-window-b'

  beforeEach(() => {
    testCtx = createMigratedTestDatabase()
    connectionRepo = new ProviderConnectionRepository(testCtx.db)
    registry = new ProviderRegistry()
    activeContext = new ActiveWorkspaceContext({ kbRepo: testCtx.kbRepo })

    botManager = new BotManagerService({
      botRepo: testCtx.botRepo,
      kbRepo: testCtx.kbRepo,
      connectionRepo,
      registry,
      activeContext
    })

    // Create synthetic provider connections in SQLite
    const openAiConn = createProviderConnectionFixture(testCtx.db, {
      providerId: 'openai',
      label: 'Main OpenAI'
    })
    openAiConnId = openAiConn.id

    const anthropicConn = createProviderConnectionFixture(testCtx.db, {
      providerId: 'anthropic',
      label: 'Main Anthropic'
    })
    anthropicConnId = anthropicConn.id
  })

  afterEach(() => {
    activeContext.clearAll()
    testCtx.cleanup()
  })

  // ==========================================================================
  // 1. Creation Tests
  // ==========================================================================

  describe('1. Bot Creation & Context Binding', () => {
    it('1.1 creates a Bot in active KB A with authoritative ownership', () => {
      const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Engineering KB' })
      botManager.activateWorkspace(sessionA, kbA.id)

      const request: CreateBotRequest = {
        name: 'Architecture Reviewer',
        modelId: 'gpt-6-luna',
        description: 'Analyzes system trade-offs',
        systemPrompt: 'Be thorough and pragmatic.',
        providerConnectionId: openAiConnId,
        enabledTools: ['search_knowledge_base', 'read_project_file']
      }

      const bot = botManager.createBot(sessionA, request)

      expect(bot.id).toBeDefined()
      expect(bot.knowledgeBaseId).toBe(kbA.id)
      expect(bot.name).toBe('Architecture Reviewer')
      expect(bot.modelId).toBe('gpt-6-luna')
      expect(bot.providerConnectionId).toBe(openAiConnId)
      expect(bot.enabledTools).toEqual(['search_knowledge_base', 'read_project_file'])
      expect(bot.status).toBe('active')

      // Verify row in SQLite DB
      const dbRow = testCtx.botRepo.getById(bot.id, kbA.id)
      expect(dbRow).not.toBeNull()
      expect(dbRow?.knowledgeBaseId).toBe(kbA.id)
    })

    it('1.2 creates multiple Bots in the same Knowledge Base', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Multi-Bot KB' })
      botManager.activateWorkspace(sessionA, kb.id)

      const bot1 = botManager.createBot(sessionA, {
        name: 'Bot 1',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      const bot2 = botManager.createBot(sessionA, {
        name: 'Bot 2',
        modelId: 'claude-sonnet-5-5',
        providerConnectionId: anthropicConnId
      })

      const list = botManager.listBots(sessionA)
      expect(list).toHaveLength(2)
      expect(list.map((b) => b.id)).toContain(bot1.id)
      expect(list.map((b) => b.id)).toContain(bot2.id)
    })

    it('1.3 creating without an active KB fails with NoActiveWorkspaceError', () => {
      expect(() =>
        botManager.createBot('unregistered-session', {
          name: 'Orphan Bot',
          modelId: 'gpt-6-luna',
          providerConnectionId: openAiConnId
        })
      ).toThrow(NoActiveWorkspaceError)
    })

    it('1.4 creating under an archived KB fails with ARCHIVED_WORKSPACE', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Old KB' })
      botManager.activateWorkspace(sessionA, kb.id)

      // Archive the KB
      testCtx.kbRepo.archive(kb.id)

      try {
        botManager.createBot(sessionA, {
          name: 'Forbidden Bot',
          modelId: 'gpt-6-luna',
          providerConnectionId: openAiConnId
        })
        expect.fail('Should have thrown BotManagerError')
      } catch (err) {
        expect((err as BotManagerError).code).toBe('ARCHIVED_WORKSPACE')
      }
    })

    it('1.5 strict schema rejects attempts to inject knowledgeBaseId in CreateBotRequest', () => {
      const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Legitimate KB' })
      const fakeKbId = '99999999-9999-4999-8999-999999999999'
      botManager.activateWorkspace(sessionA, kbA.id)

      const maliciousPayload = {
        name: 'Injected Bot',
        modelId: 'gpt-6-luna',
        knowledgeBaseId: fakeKbId
      }

      expect(() =>
        botManager.createBot(sessionA, maliciousPayload as unknown as CreateBotRequest)
      ).toThrow(BotValidationError)
    })

    it('1.6 rejects creation when model belongs to another provider (mismatch rejected before insertion)', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      // Pair OpenAI connection with Anthropic model claude-sonnet-5-5
      expect(() =>
        botManager.createBot(sessionA, {
          name: 'Mismatched Bot',
          modelId: 'claude-sonnet-5-5',
          providerConnectionId: openAiConnId
        })
      ).toThrow(BotManagerError)

      try {
        botManager.createBot(sessionA, {
          name: 'Mismatched Bot',
          modelId: 'claude-sonnet-5-5',
          providerConnectionId: openAiConnId
        })
      } catch (err) {
        expect((err as BotManagerError).code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      }

      // Verify zero rows were inserted
      expect(botManager.listBots(sessionA)).toHaveLength(0)
    })

    it('1.7 supports creating a draft Bot without a provider connection', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const draftBot = botManager.createBot(sessionA, {
        name: 'Draft Assistant',
        modelId: 'gpt-6-luna',
        providerConnectionId: null
      })

      expect(draftBot.id).toBeDefined()
      expect(draftBot.providerConnectionId).toBeNull()
      expect(draftBot.modelId).toBe('gpt-6-luna')
    })
  })

  // ==========================================================================
  // 2. Ownership & Isolation Tests
  // ==========================================================================

  describe('2. Knowledge Base Ownership Enforcement', () => {
    it('2.1 verifies strict cross-KB isolation between Session A and Session B', () => {
      const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Alpha Container' })
      const kbB = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Beta Container' })

      botManager.activateWorkspace(sessionA, kbA.id)
      botManager.activateWorkspace(sessionB, kbB.id)

      const botA = botManager.createBot(sessionA, {
        name: 'Bot in Alpha',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      const botB = botManager.createBot(sessionB, {
        name: 'Bot in Beta',
        modelId: 'claude-sonnet-5-5',
        providerConnectionId: anthropicConnId
      })

      // 1. Session A can list Bot A, but not Bot B
      const listA = botManager.listBots(sessionA)
      expect(listA.map((b) => b.id)).toContain(botA.id)
      expect(listA.map((b) => b.id)).not.toContain(botB.id)

      // 2. Session A cannot retrieve Bot B (returns null via getBot, throws via getBotOrThrow)
      expect(botManager.getBot(sessionA, botB.id)).toBeNull()
      expect(() => botManager.getBotOrThrow(sessionA, botB.id)).toThrow(BotNotFoundError)

      // 3. Session A cannot update Bot B
      expect(() => botManager.updateBot(sessionA, botB.id, { name: 'Hacked Name' })).toThrow(
        BotNotFoundError
      )

      // 4. Session A cannot archive or unarchive Bot B
      expect(() => botManager.archiveBot(sessionA, botB.id)).toThrow(BotNotFoundError)
      expect(() => botManager.unarchiveBot(sessionA, botB.id)).toThrow(BotNotFoundError)

      // 5. Session A cannot delete Bot B
      expect(() => botManager.deleteBot(sessionA, botB.id)).toThrow(BotNotFoundError)

      // 6. Session B can access Bot B
      const retrievedB = botManager.getBot(sessionB, botB.id)
      expect(retrievedB).not.toBeNull()
      expect(retrievedB?.name).toBe('Bot in Beta')

      // 7. Verify Bot B remained completely unmodified
      expect(retrievedB?.name).toBe('Bot in Beta')
      expect(retrievedB?.status).toBe('active')
    })
  })

  // ==========================================================================
  // 3. Update Tests & Effective Pair Validation
  // ==========================================================================

  describe('3. Bot Updates & Effective Configuration Validation', () => {
    it('3.1 updates name, description, system prompt, and tool permissions', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const bot = botManager.createBot(sessionA, {
        name: 'Initial Name',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      const updateInput: UpdateBotRequest = {
        name: 'Updated Bot Name',
        description: 'New Description',
        systemPrompt: 'Updated instructions.',
        enabledTools: ['prepare_report', 'list_knowledge_base_documents']
      }

      const updated = botManager.updateBot(sessionA, bot.id, updateInput)

      expect(updated.id).toBe(bot.id)
      expect(updated.knowledgeBaseId).toBe(kb.id)
      expect(updated.name).toBe('Updated Bot Name')
      expect(updated.description).toBe('New Description')
      expect(updated.systemPrompt).toBe('Updated instructions.')
      expect(updated.enabledTools).toEqual(['prepare_report', 'list_knowledge_base_documents'])
      expect(updated.updatedAt).toBeGreaterThanOrEqual(bot.updatedAt)
    })

    it('3.2 updates model and provider connection together to a compatible pair', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const bot = botManager.createBot(sessionA, {
        name: 'Swappable Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Switch to Anthropic with claude-sonnet-5-5
      const updated = botManager.updateBot(sessionA, bot.id, {
        providerConnectionId: anthropicConnId,
        modelId: 'claude-sonnet-5-5'
      })

      expect(updated.providerConnectionId).toBe(anthropicConnId)
      expect(updated.modelId).toBe('claude-sonnet-5-5')
    })

    it('3.3 validates changing ONLY the provider connection against existing saved model', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      // Existing bot has OpenAI connection with gpt-6-luna
      const bot = botManager.createBot(sessionA, {
        name: 'OpenAI Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Attempt to change ONLY the connection to Anthropic without changing model (gpt-6-luna)
      // Must calculate effective pair (Anthropic + gpt-6-luna) and reject!
      expect(() =>
        botManager.updateBot(sessionA, bot.id, {
          providerConnectionId: anthropicConnId
        })
      ).toThrow(BotManagerError)

      try {
        botManager.updateBot(sessionA, bot.id, {
          providerConnectionId: anthropicConnId
        })
      } catch (err) {
        expect((err as BotManagerError).code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      }

      // Existing bot remains unchanged
      const current = botManager.getBotOrThrow(sessionA, bot.id)
      expect(current.providerConnectionId).toBe(openAiConnId)
    })

    it('3.4 validates changing ONLY the model against existing saved provider connection', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      // Existing bot has OpenAI connection with gpt-6-luna
      const bot = botManager.createBot(sessionA, {
        name: 'OpenAI Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Attempt to change ONLY the model to Anthropic model without changing connection
      // Must calculate effective pair (OpenAI + claude-sonnet-5-5) and reject!
      expect(() =>
        botManager.updateBot(sessionA, bot.id, {
          modelId: 'claude-sonnet-5-5'
        })
      ).toThrow(BotManagerError)

      try {
        botManager.updateBot(sessionA, bot.id, {
          modelId: 'claude-sonnet-5-5'
        })
      } catch (err) {
        expect((err as BotManagerError).code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      }

      // Existing bot remains unchanged
      const current = botManager.getBotOrThrow(sessionA, bot.id)
      expect(current.modelId).toBe('gpt-6-luna')
    })

    it('3.5 preserves conversation history and immutable keys when updating Bot', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const bot = botManager.createBot(sessionA, {
        name: 'Chat Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Insert conversation and message rows into SQLite for this bot
      const convId = '44444444-4444-4444-8444-444444444444'
      const msgId = '55555555-5555-4555-8555-555555555555'
      const now = Date.now()

      testCtx.db
        .prepare(
          'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(convId, bot.id, kb.id, 'Initial Thread', now, now)

      testCtx.db
        .prepare(
          'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(msgId, convId, 'user', 'Hello Bot', now)

      // Update bot name and switch model to gpt-6.1-sol (within same provider)
      const updated = botManager.updateBot(sessionA, bot.id, {
        name: 'Renamed Chat Bot',
        modelId: 'gpt-6.1-sol'
      })

      expect(updated.id).toBe(bot.id)
      expect(updated.knowledgeBaseId).toBe(kb.id)
      expect(updated.createdAt).toBe(bot.createdAt)

      // Verify conversation and message remain 100% intact
      const convRow = testCtx.db
        .prepare('SELECT id, title, bot_id FROM conversations WHERE id = ?')
        .get(convId) as { id: string; title: string; bot_id: string }

      expect(convRow).toBeDefined()
      expect(convRow.bot_id).toBe(bot.id)
      expect(convRow.title).toBe('Initial Thread')

      const msgRow = testCtx.db
        .prepare('SELECT id, content FROM messages WHERE id = ?')
        .get(msgId) as { id: string; content: string }

      expect(msgRow).toBeDefined()
      expect(msgRow.content).toBe('Hello Bot')
    })
  })

  // ==========================================================================
  // 4. Lifecycle & Deletion Tests
  // ==========================================================================

  describe('4. Bot Lifecycle (Archive, Unarchive, Deletion)', () => {
    it('4.1 archives a Bot, preserves in SQLite, and unarchive restores active status', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const bot = botManager.createBot(sessionA, {
        name: 'Archivable Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Archive bot
      const archived = botManager.archiveBot(sessionA, bot.id)
      expect(archived.status).toBe('archived')

      // Query database directly
      const dbRow = testCtx.botRepo.getById(bot.id, kb.id)
      expect(dbRow?.status).toBe('archived')

      // Listing active bots excludes archived
      const activeList = botManager.listBots(sessionA, { status: 'active' })
      expect(activeList.map((b) => b.id)).not.toContain(bot.id)

      // Listing archived bots includes it
      const archivedList = botManager.listBots(sessionA, { status: 'archived' })
      expect(archivedList.map((b) => b.id)).toContain(bot.id)

      // Unarchive bot
      const restored = botManager.unarchiveBot(sessionA, bot.id)
      expect(restored.status).toBe('active')

      const restoredDbRow = testCtx.botRepo.getById(bot.id, kb.id)
      expect(restoredDbRow?.status).toBe('active')
    })

    it('4.2 deletes a Bot, cascade-cleans conversations, and leaves parent KB and docs intact', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
      botManager.activateWorkspace(sessionA, kb.id)

      const bot1 = botManager.createBot(sessionA, {
        name: 'Bot To Delete',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      const bot2 = botManager.createBot(sessionA, {
        name: 'Sibling Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: openAiConnId
      })

      // Add conversation for bot1
      const convId = '66666666-6666-4666-8666-666666666666'
      const now = Date.now()
      testCtx.db
        .prepare(
          'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(convId, bot1.id, kb.id, 'Ephemeral Thread', now, now)

      // Add synthetic document in KB
      const docId = '77777777-7777-4777-8777-777777777777'
      testCtx.db
        .prepare(
          `INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          docId,
          kb.id,
          'notes.md',
          'notes.md',
          'notes.md',
          'md',
          'text/markdown',
          120,
          'a'.repeat(64),
          'completed',
          now,
          now
        )

      // Delete bot1
      const delResult = botManager.deleteBot(sessionA, bot1.id)
      expect(delResult.success).toBe(true)
      expect(delResult.botId).toBe(bot1.id)

      // Bot 1 is deleted from DB
      expect(botManager.getBot(sessionA, bot1.id)).toBeNull()

      // Bot 1's conversation was cascade-deleted
      const convCount = testCtx.db
        .prepare('SELECT count(*) as c FROM conversations WHERE id = ?')
        .get(convId) as { c: number }
      expect(convCount.c).toBe(0)

      // Sibling Bot 2 remains intact
      expect(botManager.getBot(sessionA, bot2.id)).not.toBeNull()

      // Parent Knowledge Base remains intact
      const kbRecord = testCtx.kbRepo.getById(kb.id)
      expect(kbRecord).not.toBeNull()

      // Knowledge Base documents remain intact
      const docCount = testCtx.db
        .prepare('SELECT count(*) as c FROM knowledge_sources WHERE id = ?')
        .get(docId) as { c: number }
      expect(docCount.c).toBe(1)
    })
  })
})
