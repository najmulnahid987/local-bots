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
import { BotNotFoundError } from './bot-errors'

describe('Phase 6 Step 6.6: Multi-KB Bot Isolation and Persistence Verification', () => {
  let testCtx: MigratedTestDatabaseContext
  let connectionRepo: ProviderConnectionRepository
  let registry: ProviderRegistry
  let activeContext: ActiveWorkspaceContext
  let botManager: BotManagerService

  let openAiConnId: string
  let anthropicConnId: string

  const sessionA = 'session-workspace-a'
  const sessionB = 'session-workspace-b'

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

    const openAiConn = createProviderConnectionFixture(testCtx.db, {
      providerId: 'openai',
      label: 'Shared OpenAI Connection'
    })
    openAiConnId = openAiConn.id

    const anthropicConn = createProviderConnectionFixture(testCtx.db, {
      providerId: 'anthropic',
      label: 'Shared Anthropic Connection'
    })
    anthropicConnId = anthropicConn.id
  })

  afterEach(() => {
    activeContext.clearAll()
    testCtx.cleanup()
  })

  describe('Task 5 — Preserve independent Knowledge Base grouping', () => {
    it('enforces multi-KB Bot isolation, independent configurations, and cross-KB access barriers', () => {
      // 1. Create Knowledge Base A and Knowledge Base B
      const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Knowledge Base A' })
      const kbB = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Knowledge Base B' })

      // Activate sessions
      botManager.activateWorkspace(sessionA, kbA.id)
      botManager.activateWorkspace(sessionB, kbB.id)

      // 2. Create 4 Bots in Knowledge Base A
      const developer = botManager.createBot(sessionA, {
        name: 'Developer',
        description: 'Code search and analysis assistant',
        systemPrompt: 'You analyze codebase architecture.',
        providerConnectionId: openAiConnId,
        modelId: 'gpt-6-luna',
        enabledTools: ['search_project_files', 'read_project_file']
      })

      const researcher = botManager.createBot(sessionA, {
        name: 'Researcher',
        description: 'Deep technical paper analyzer',
        systemPrompt: 'You research technical literature.',
        providerConnectionId: openAiConnId,
        modelId: 'gpt-6.1-sol',
        enabledTools: ['search_knowledge_base', 'read_knowledge_base_document']
      })

      const contentWriter = botManager.createBot(sessionA, {
        name: 'Content Writer',
        description: 'Documentation and report specialist',
        systemPrompt: 'You produce polished documentation.',
        providerConnectionId: anthropicConnId,
        modelId: 'claude-sonnet-5-5',
        enabledTools: ['prepare_report']
      })

      const projectManager = botManager.createBot(sessionA, {
        name: 'Project Manager',
        description: 'Coordinates tasks and roadmap items',
        systemPrompt: 'You monitor project status and milestones.',
        providerConnectionId: anthropicConnId,
        modelId: 'claude-sonnet-5-5',
        enabledTools: ['list_knowledge_base_documents']
      })

      // 3. Create a separate Bot in Knowledge Base B
      const separateBot = botManager.createBot(sessionB, {
        name: 'Separate Bot',
        description: 'Single assistant isolated in KB B',
        systemPrompt: 'You are isolated in KB B.',
        providerConnectionId: null, // Draft / unassigned
        modelId: 'gemini-3.8-flash',
        enabledTools: ['search_knowledge_base']
      })

      // 4. Verify KB A lists exactly its four Bots
      const listA = botManager.listBots(sessionA)
      expect(listA).toHaveLength(4)
      const namesA = listA.map((b) => b.name)
      expect(namesA).toContain('Developer')
      expect(namesA).toContain('Researcher')
      expect(namesA).toContain('Content Writer')
      expect(namesA).toContain('Project Manager')
      expect(namesA).not.toContain('Separate Bot')
      expect(listA.map((b) => b.id)).toEqual(
        expect.arrayContaining([developer.id, researcher.id, contentWriter.id, projectManager.id])
      )

      // 5. Verify KB B lists exactly its separate Bot
      const listB = botManager.listBots(sessionB)
      expect(listB).toHaveLength(1)
      expect(listB[0].name).toBe('Separate Bot')
      expect(listB[0].id).toBe(separateBot.id)

      // 6. Direct database inspection: Every Bot row contains the correct knowledge_base_id
      const rawRows = testCtx.db
        .prepare('SELECT id, name, knowledge_base_id FROM bots')
        .all() as Array<{
        id: string
        name: string
        knowledge_base_id: string
      }>
      expect(rawRows).toHaveLength(5)
      for (const row of rawRows) {
        if (row.name === 'Separate Bot') {
          expect(row.knowledge_base_id).toBe(kbB.id)
        } else {
          expect(row.knowledge_base_id).toBe(kbA.id)
        }
      }

      // 7. Verify opening KB B cannot display, retrieve, or edit Bots belonging to KB A
      expect(botManager.getBot(sessionB, developer.id)).toBeNull()
      expect(botManager.getBot(sessionB, researcher.id)).toBeNull()
      expect(() => botManager.getBotOrThrow(sessionB, developer.id)).toThrow(BotNotFoundError)
      expect(() => botManager.getBotOrThrow(sessionB, researcher.id)).toThrow(BotNotFoundError)
      expect(() =>
        botManager.updateBot(sessionB, developer.id, { name: 'Compromised Name' })
      ).toThrow(BotNotFoundError)

      // 8. Verify the same provider connection is safely shared across multiple Bots
      expect(developer.providerConnectionId).toBe(openAiConnId)
      expect(researcher.providerConnectionId).toBe(openAiConnId)

      // 9. Verify each Bot retains independent model_id, system_prompt, and enabled tools
      expect(developer.modelId).toBe('gpt-6-luna')
      expect(developer.systemPrompt).toBe('You analyze codebase architecture.')
      expect(developer.enabledTools).toEqual(['search_project_files', 'read_project_file'])

      expect(researcher.modelId).toBe('gpt-6.1-sol')
      expect(researcher.systemPrompt).toBe('You research technical literature.')
      expect(researcher.enabledTools).toEqual([
        'search_knowledge_base',
        'read_knowledge_base_document'
      ])

      expect(contentWriter.modelId).toBe('claude-sonnet-5-5')
      expect(contentWriter.enabledTools).toEqual(['prepare_report'])

      // 10. Verify no duplicate document or knowledge-source records are created for Bots
      const sourceCount = (
        testCtx.db.prepare('SELECT COUNT(*) as count FROM knowledge_sources').get() as {
          count: number
        }
      ).count
      expect(sourceCount).toBe(0)
    })
  })

  describe('Task 6 — Verify configuration and conversation persistence & Cascade behavior', () => {
    it('persists configuration updates, preserves conversation history, and executes ON DELETE CASCADE', () => {
      const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Persistence KB' })
      botManager.activateWorkspace(sessionA, kb.id)

      // 1. Create a Bot
      const created = botManager.createBot(sessionA, {
        name: 'Initial Bot',
        description: 'Original description',
        systemPrompt: 'Original instructions',
        providerConnectionId: openAiConnId,
        modelId: 'gpt-6-luna',
        enabledTools: ['search_knowledge_base']
      })

      // Insert conversation history for this Bot into SQLite
      const conversationId = 'conv-1111-1111-1111-111111111111'
      testCtx.db
        .prepare(
          `INSERT INTO conversations (id, knowledge_base_id, bot_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(conversationId, kb.id, created.id, 'Research Chat', Date.now(), Date.now())

      // Insert messages
      testCtx.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('msg-1', conversationId, 'user', 'Analyze this report', Date.now())

      testCtx.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('msg-2', conversationId, 'assistant', 'Here is the summary', Date.now())

      // Insert agent run and tool event
      const runId = 'run-1111-1111-1111-111111111111'
      testCtx.db
        .prepare(
          `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, status, selected_model, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, created.id, conversationId, kb.id, 'completed', 'gpt-6-luna', Date.now())

      testCtx.db
        .prepare(
          `INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, status, approval_status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('tool-1', runId, 1, 'search_knowledge_base', 'completed', 'auto_approved', Date.now())

      // Insert bot memory
      testCtx.db
        .prepare(
          `INSERT INTO bot_memories (id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'mem-1',
          created.id,
          kb.id,
          'user_note',
          'User prefers concise summaries',
          Date.now(),
          Date.now()
        )

      // Insert a document source for the parent KB
      const sourceId = 'src-1111-1111-1111-111111111111'
      testCtx.db
        .prepare(
          `INSERT INTO knowledge_sources (
             id, knowledge_base_id, file_name, original_file_name, relative_file_path,
             file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sourceId,
          kb.id,
          'spec.md',
          'spec.md',
          'spec.md',
          'md',
          'text/markdown',
          2048,
          'a'.repeat(64),
          'completed',
          Date.now(),
          Date.now()
        )

      // Create a sibling bot in the same KB
      const siblingBot = botManager.createBot(sessionA, {
        name: 'Sibling Bot',
        modelId: 'gpt-6-luna'
      })

      // 2. Modify Bot configuration: name, model, system instructions, enabled tools
      botManager.updateBot(sessionA, created.id, {
        name: 'Updated Bot Master',
        description: 'New evolved description',
        modelId: 'claude-sonnet-5-5',
        providerConnectionId: anthropicConnId,
        systemPrompt: 'New evolved instructions.',
        enabledTools: ['search_knowledge_base', 'prepare_report']
      })

      // 3. Retrieve the Bot again and verify persistence
      const retrieved = botManager.getBotOrThrow(sessionA, created.id)
      expect(retrieved.name).toBe('Updated Bot Master')
      expect(retrieved.description).toBe('New evolved description')
      expect(retrieved.modelId).toBe('claude-sonnet-5-5')
      expect(retrieved.providerConnectionId).toBe(anthropicConnId)
      expect(retrieved.systemPrompt).toBe('New evolved instructions.')
      expect(retrieved.enabledTools).toEqual(['search_knowledge_base', 'prepare_report'])

      // Invariants: ID and parent Knowledge Base ID remain immutable
      expect(retrieved.id).toBe(created.id)
      expect(retrieved.knowledgeBaseId).toBe(kb.id)

      // 4. Verify conversation history remains completely intact after editing
      const convCountAfterEdit = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM conversations WHERE bot_id = ?')
          .get(created.id) as { count: number }
      ).count
      expect(convCountAfterEdit).toBe(1)

      const msgCountAfterEdit = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?')
          .get(conversationId) as { count: number }
      ).count
      expect(msgCountAfterEdit).toBe(2)

      // 5. Verify archiving and unarchiving preserve conversation history
      botManager.archiveBot(sessionA, created.id)
      const archived = botManager.getBotOrThrow(sessionA, created.id)
      expect(archived.status).toBe('archived')

      const convCountAfterArchive = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM conversations WHERE bot_id = ?')
          .get(created.id) as { count: number }
      ).count
      expect(convCountAfterArchive).toBe(1)

      botManager.unarchiveBot(sessionA, created.id)
      const unarchived = botManager.getBotOrThrow(sessionA, created.id)
      expect(unarchived.status).toBe('active')

      // 6. Execute permanent deletion
      const deleteResult = botManager.deleteBot(sessionA, created.id)
      expect(deleteResult.success).toBe(true)
      expect(deleteResult.botId).toBe(created.id)

      // 7. Verify SQLite ON DELETE CASCADE: Bot-owned records are permanently erased
      const botCount = (
        testCtx.db.prepare('SELECT COUNT(*) as count FROM bots WHERE id = ?').get(created.id) as {
          count: number
        }
      ).count
      expect(botCount).toBe(0)

      const convCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM conversations WHERE bot_id = ?')
          .get(created.id) as { count: number }
      ).count
      expect(convCount).toBe(0)

      const msgCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?')
          .get(conversationId) as { count: number }
      ).count
      expect(msgCount).toBe(0)

      const runCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM agent_runs WHERE bot_id = ?')
          .get(created.id) as { count: number }
      ).count
      expect(runCount).toBe(0)

      const toolEventCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM tool_events WHERE agent_run_id = ?')
          .get(runId) as { count: number }
      ).count
      expect(toolEventCount).toBe(0)

      const memoryCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM bot_memories WHERE bot_id = ?')
          .get(created.id) as { count: number }
      ).count
      expect(memoryCount).toBe(0)

      // 8. Verify preservation: Parent KB, documents, sibling bots, and provider connections remain intact
      const kbCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM knowledge_bases WHERE id = ?')
          .get(kb.id) as {
          count: number
        }
      ).count
      expect(kbCount).toBe(1)

      const siblingCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM bots WHERE id = ?')
          .get(siblingBot.id) as { count: number }
      ).count
      expect(siblingCount).toBe(1)

      const docSourceCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM knowledge_sources WHERE id = ?')
          .get(sourceId) as { count: number }
      ).count
      expect(docSourceCount).toBe(1)

      const providerConnCount = (
        testCtx.db
          .prepare('SELECT COUNT(*) as count FROM provider_connections WHERE id = ?')
          .get(anthropicConnId) as { count: number }
      ).count
      expect(providerConnCount).toBe(1)
    })
  })
})
