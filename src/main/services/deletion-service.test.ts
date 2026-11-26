import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { DeletionRecoveryRepository } from '../database/repositories/deletion-recovery-repository'
import { DeletionService, DeletionServiceError } from './deletion-service'
import type { KnowledgeBaseManager } from './knowledge-base-manager'
import type { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import type { ConversationManagerService } from './conversation-manager'
import type { BotManagerService } from './bot-manager'
import type { ConversationTurnService } from './conversation-turn-service'
import { DocumentStorageManager } from '../documents/document-storage-manager'

describe('DeletionService (Step 9.8)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let sourceRepo: KnowledgeSourceRepository
  let conversationRepo: ConversationRepository
  let messageRepo: MessageRepository
  let botMemoryRepo: BotMemoryRepository
  let deletionJournalRepo: DeletionRecoveryRepository
  let tempBaseDir: string
  let storageManager: DocumentStorageManager

  let mockTurnService: Partial<ConversationTurnService>
  let mockDocLifecycleService: Partial<DocumentLifecycleService>
  let mockKbManager: Partial<KnowledgeBaseManager>
  let mockBotManager: Partial<BotManagerService>
  let mockConversationManager: Partial<ConversationManagerService>

  let deletionService: DeletionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyaro-deletion-test-'))
    const docsDir = path.join(tempBaseDir, 'documents')
    fs.mkdirSync(docsDir, { recursive: true })

    storageManager = new DocumentStorageManager({
      documentsDir: docsDir
    })

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    conversationRepo = new ConversationRepository(db)
    messageRepo = new MessageRepository(db)
    botMemoryRepo = new BotMemoryRepository(db)
    deletionJournalRepo = new DeletionRecoveryRepository(db)

    const activeTurns = new Set<string>()
    const deletingConvs = new Set<string>()

    mockTurnService = {
      isGenerating: vi.fn((id: string) => activeTurns.has(id)),
      isDeleting: vi.fn((id: string) => deletingConvs.has(id)),
      acquireDeletionLock: vi.fn((id: string) => {
        if (activeTurns.has(id)) {
          throw new Error('Cannot delete conversation while generation is in progress.')
        }
        deletingConvs.add(id)
      }),
      releaseDeletionLock: vi.fn((id: string) => {
        deletingConvs.delete(id)
      })
    }

    mockDocLifecycleService = {
      delete: vi.fn(
        async ({ knowledgeBaseId, sourceId }: { knowledgeBaseId: string; sourceId: string }) => {
          db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)
          return {
            success: true,
            sourceId,
            knowledgeBaseId,
            fileCleaned: true,
            cleanupPending: false
          }
        }
      )
    }

    mockKbManager = {
      getDocumentsDirectory: vi.fn(() => docsDir),
      delete: vi.fn(async (id: string) => {
        db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
        const kbDir = path.join(docsDir, id)
        fs.rmSync(kbDir, { recursive: true, force: true })
        return { success: true, id, directoryCleaned: true, cleanupPending: false }
      })
    }

    mockBotManager = {
      deleteBot: vi.fn((_session: string, id: string) => {
        db.prepare('DELETE FROM bots WHERE id = ?').run(id)
        return { success: true, id, botId: id }
      })
    }

    mockConversationManager = {
      deleteConversation: vi.fn((_session: string, id: string) => {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
        return { success: true, id, conversationId: id }
      })
    }

    deletionService = new DeletionService({
      db,
      kbRepo,
      botRepo,
      sourceRepo,
      conversationRepo,
      messageRepo,
      botMemoryRepo,
      kbManager: mockKbManager as KnowledgeBaseManager,
      docLifecycleService: mockDocLifecycleService as DocumentLifecycleService,
      conversationManager: mockConversationManager as ConversationManagerService,
      botManager: mockBotManager as BotManagerService,
      turnService: mockTurnService as ConversationTurnService,
      deletionJournalRepo,
      storageManager
    })
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore close errors in tests
    }
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  interface FullFixture {
    kb1: ReturnType<KnowledgeBaseRepository['create']>
    kb2: ReturnType<KnowledgeBaseRepository['create']>
    bot1: ReturnType<BotRepository['create']>
    bot2: ReturnType<BotRepository['create']>
    botBeta: ReturnType<BotRepository['create']>
    conv1: ReturnType<ConversationRepository['create']>
    conv2: ReturnType<ConversationRepository['create']>
    msg1: ReturnType<MessageRepository['create']>
    msg2: ReturnType<MessageRepository['create']>
    runId: string
    source1: ReturnType<KnowledgeSourceRepository['create']>
    chunkId: string
  }

  // Helper to create full test fixtures
  function createFullFixture(): FullFixture {
    const kb1 = kbRepo.create({ name: 'Alpha Knowledge Base', description: 'Primary KB' })
    const kb2 = kbRepo.create({ name: 'Beta Knowledge Base', description: 'Secondary KB' })

    const bot1 = botRepo.create({
      knowledgeBaseId: kb1.id,
      name: 'Alpha Researcher',
      modelId: 'test-model'
    })
    const bot2 = botRepo.create({
      knowledgeBaseId: kb1.id,
      name: 'Alpha Sibling Bot',
      modelId: 'test-model'
    })
    const botBeta = botRepo.create({
      knowledgeBaseId: kb2.id,
      name: 'Beta Bot',
      modelId: 'test-model'
    })

    const conv1 = conversationRepo.create({
      knowledgeBaseId: kb1.id,
      botId: bot1.id,
      title: 'Conversation One'
    })
    const conv2 = conversationRepo.create({
      knowledgeBaseId: kb1.id,
      botId: bot2.id,
      title: 'Conversation Two'
    })

    const msg1 = messageRepo.create({
      knowledgeBaseId: kb1.id,
      conversationId: conv1.id,
      botId: bot1.id,
      role: 'user',
      content: 'Hello'
    })
    const msg2 = messageRepo.create({
      knowledgeBaseId: kb1.id,
      conversationId: conv1.id,
      botId: bot1.id,
      role: 'assistant',
      content: 'World'
    })

    // Seed agent run & tool event
    const now = Date.now()
    const runId = '11111111-2222-4333-8444-555555555555'
    db.prepare(
      `
      INSERT INTO agent_runs (id, conversation_id, bot_id, knowledge_base_id, status, selected_model, started_at)
      VALUES (?, ?, ?, ?, 'completed', 'test-model', ?)
    `
    ).run(runId, conv1.id, bot1.id, kb1.id, now)

    db.prepare(
      `
      INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, arguments_summary, status, started_at)
      VALUES ('22222222-2222-4333-8444-555555555555', ?, 1, 'test_tool', '{}', 'completed', ?)
    `
    ).run(runId, now)

    // Seed Bot memory
    botMemoryRepo.create({
      botId: bot1.id,
      knowledgeBaseId: kb1.id,
      memoryType: 'pinned_instruction',
      content: 'Always reply concisely.'
    })

    // Seed Knowledge Source
    const source1Id = '55555555-2222-4333-8444-555555555555'
    const source1 = sourceRepo.create({
      id: source1Id,
      knowledge_base_id: kb1.id,
      file_name: 'doc1.txt',
      original_file_name: 'doc1.txt',
      relative_file_path: 'doc1.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })

    // Create file on disk
    const kb1Dir = path.join(tempBaseDir, 'documents', kb1.id)
    fs.mkdirSync(kb1Dir, { recursive: true })
    fs.writeFileSync(path.join(kb1Dir, 'doc1.txt'), 'Sample text content')

    // Seed Chunk & FTS5 record via insertChunks
    const chunkId = '33333333-2222-4333-8444-555555555555'
    sourceRepo.insertChunks([
      {
        id: chunkId,
        knowledge_base_id: kb1.id,
        source_id: source1.id,
        chunk_index: 0,
        content: 'Sample chunk content for search',
        page_number: null,
        token_count: 6,
        metadata_json: '{}',
        created_at: now
      }
    ])

    return {
      kb1,
      kb2,
      bot1,
      bot2,
      botBeta,
      conv1,
      conv2,
      msg1,
      msg2,
      runId,
      source1,
      chunkId
    }
  }

  describe('1. Conversation Deletion & Preview', () => {
    it('generates accurate deletion preview with dependent counts', async () => {
      const f = createFullFixture()
      const preview = await deletionService.getPreview('conversation', f.conv1.id)

      expect(preview.entityType).toBe('conversation')
      expect(preview.entityId).toBe(f.conv1.id)
      expect(preview.displayName).toBe('Conversation One')
      expect(preview.parentId).toBe(f.bot1.id)
      expect(preview.parentName).toBe('Alpha Researcher')
      expect(preview.dependentCounts.messages).toBe(2)
      expect(preview.dependentCounts.agentRuns).toBe(1)
      expect(preview.dependentCounts.toolEvents).toBe(1)
      expect(preview.isBlocked).toBe(false)
      expect(preview.backupReversible).toBe(true)
    })

    it('blocks preview and deletion when turnService is currently generating', async () => {
      const f = createFullFixture()
      vi.mocked(mockTurnService.isGenerating!).mockReturnValue(true)

      const preview = await deletionService.getPreview('conversation', f.conv1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('generation is currently in progress')

      await expect(
        deletionService.deleteEntity({
          entityType: 'conversation',
          entityId: f.conv1.id
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('successfully deletes conversation and cascades to child messages and agent runs', async () => {
      const f = createFullFixture()

      const result = await deletionService.deleteEntity({
        entityType: 'conversation',
        entityId: f.conv1.id
      })

      expect(result.success).toBe(true)
      expect(result.entityId).toBe(f.conv1.id)

      // Conversation must be gone
      const convCheck = db.prepare('SELECT id FROM conversations WHERE id = ?').get(f.conv1.id)
      expect(convCheck).toBeUndefined()

      // Messages must be cascaded away
      const msgCheck = db
        .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
        .get(f.conv1.id) as { c: number }
      expect(msgCheck.c).toBe(0)

      // Agent run must be cascaded away
      const runCheck = db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(f.runId)
      expect(runCheck).toBeUndefined()

      // Tool events must be cascaded away
      const eventCheck = db
        .prepare('SELECT COUNT(*) as c FROM tool_events WHERE agent_run_id = ?')
        .get(f.runId) as { c: number }
      expect(eventCheck.c).toBe(0)

      // Preserved assets: Parent Bot, sibling conversation conv2, and KB must remain intact
      const botCheck = db.prepare('SELECT id FROM bots WHERE id = ?').get(f.bot1.id)
      expect(botCheck).toBeDefined()

      const siblingConv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(f.conv2.id)
      expect(siblingConv).toBeDefined()

      const kbCheck = db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(f.kb1.id)
      expect(kbCheck).toBeDefined()
    })
  })

  describe('2. Bot Deletion & Preview', () => {
    it('generates accurate bot deletion preview with aggregated counts', async () => {
      const f = createFullFixture()
      const preview = await deletionService.getPreview('bot', f.bot1.id)

      expect(preview.entityType).toBe('bot')
      expect(preview.entityId).toBe(f.bot1.id)
      expect(preview.displayName).toBe('Alpha Researcher')
      expect(preview.parentId).toBe(f.kb1.id)
      expect(preview.parentName).toBe('Alpha Knowledge Base')
      expect(preview.dependentCounts.conversations).toBe(1)
      expect(preview.dependentCounts.messages).toBe(2)
      expect(preview.dependentCounts.agentRuns).toBe(1)
      expect(preview.dependentCounts.memories).toBe(1)
      expect(preview.isBlocked).toBe(false)
    })

    it('blocks bot deletion if any child conversation is generating', async () => {
      const f = createFullFixture()
      vi.mocked(mockTurnService.isGenerating!).mockImplementation((id) => id === f.conv1.id)

      const preview = await deletionService.getPreview('bot', f.bot1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('conversation turn is currently active')

      await expect(
        deletionService.deleteEntity({
          entityType: 'bot',
          entityId: f.bot1.id,
          confirmName: 'Alpha Researcher'
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('blocks bot deletion if an agent run is active (running / awaiting_approval / pending)', async () => {
      const f = createFullFixture()
      db.prepare(`UPDATE agent_runs SET status = 'running' WHERE id = ?`).run(f.runId)

      const preview = await deletionService.getPreview('bot', f.bot1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('currently active for this Bot')

      await expect(
        deletionService.deleteEntity({
          entityType: 'bot',
          entityId: f.bot1.id,
          confirmName: 'Alpha Researcher'
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('enforces exact-name confirmation', async () => {
      const f = createFullFixture()

      await expect(
        deletionService.deleteEntity({
          entityType: 'bot',
          entityId: f.bot1.id,
          confirmName: 'Wrong Name'
        })
      ).rejects.toThrow(/Confirmation name mismatch/)
    })

    it('successfully deletes bot and cascades to conversations, messages, memories, and runs', async () => {
      const f = createFullFixture()

      const result = await deletionService.deleteEntity({
        entityType: 'bot',
        entityId: f.bot1.id,
        confirmName: 'Alpha Researcher'
      })

      expect(result.success).toBe(true)
      expect(result.entityId).toBe(f.bot1.id)

      // Bot must be gone
      expect(db.prepare('SELECT id FROM bots WHERE id = ?').get(f.bot1.id)).toBeUndefined()

      // Conversations under bot1 must be cascaded away
      const convCount = db
        .prepare('SELECT COUNT(*) as c FROM conversations WHERE bot_id = ?')
        .get(f.bot1.id) as { c: number }
      expect(convCount.c).toBe(0)

      // Memories under bot1 must be cascaded away
      const memCount = db
        .prepare('SELECT COUNT(*) as c FROM bot_memories WHERE bot_id = ?')
        .get(f.bot1.id) as { c: number }
      expect(memCount.c).toBe(0)

      // Preserved assets: Sibling bot in same KB, parent KB, shared document source must remain!
      expect(db.prepare('SELECT id FROM bots WHERE id = ?').get(f.bot2.id)).toBeDefined()
      expect(db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(f.kb1.id)).toBeDefined()
      expect(
        db.prepare('SELECT id FROM knowledge_sources WHERE id = ?').get(f.source1.id)
      ).toBeDefined()
    })
  })

  describe('3. Knowledge Source Deletion & Preview', () => {
    it('generates accurate knowledge source deletion preview', async () => {
      const f = createFullFixture()
      const preview = await deletionService.getPreview('knowledge_source', f.source1.id)

      expect(preview.entityType).toBe('knowledge_source')
      expect(preview.entityId).toBe(f.source1.id)
      expect(preview.displayName).toBe('doc1.txt')
      expect(preview.parentId).toBe(f.kb1.id)
      expect(preview.parentName).toBe('Alpha Knowledge Base')
      expect(preview.dependentCounts.chunks).toBe(1)
      expect(preview.isBlocked).toBe(false)
      expect(
        preview.warnings.some((w) =>
          w.includes(
            'citations referencing this document will no longer be able to open the source preview'
          )
        )
      ).toBe(true)
    })

    it('blocks source deletion when status is queued or processing', async () => {
      const f = createFullFixture()
      db.prepare(`UPDATE knowledge_sources SET indexing_status = 'processing' WHERE id = ?`).run(
        f.source1.id
      )

      const preview = await deletionService.getPreview('knowledge_source', f.source1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('parsed or indexed')

      await expect(
        deletionService.deleteEntity({
          entityType: 'knowledge_source',
          entityId: f.source1.id
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('successfully deletes source and cascades to chunks, triggers FTS5 cleanup, and removes quarantined file', async () => {
      const f = createFullFixture()

      // Verify FTS5 entry exists before deletion
      const ftsBefore = db
        .prepare(`SELECT COUNT(*) as c FROM knowledge_fts WHERE chunk_id = ?`)
        .get(f.chunkId) as { c: number }
      expect(ftsBefore.c).toBe(1)

      const result = await deletionService.deleteEntity({
        entityType: 'knowledge_source',
        entityId: f.source1.id
      })

      expect(result.success).toBe(true)
      expect(result.entityId).toBe(f.source1.id)

      // Source must be deleted from DB
      expect(
        db.prepare('SELECT id FROM knowledge_sources WHERE id = ?').get(f.source1.id)
      ).toBeUndefined()

      // Chunks must be deleted from DB
      expect(
        db.prepare('SELECT id FROM knowledge_chunks WHERE id = ?').get(f.chunkId)
      ).toBeUndefined()

      // FTS5 index must be cleaned up via SQLite trigger trg_knowledge_chunks_ad
      const ftsAfter = db
        .prepare(`SELECT COUNT(*) as c FROM knowledge_fts WHERE chunk_id = ?`)
        .get(f.chunkId) as { c: number }
      expect(ftsAfter.c).toBe(0)

      // DocumentLifecycleService.delete method must be invoked
      expect(mockDocLifecycleService.delete).toHaveBeenCalled()

      // Journal entry must be marked completed
      const journals = deletionJournalRepo.listActive()
      expect(journals.length).toBe(0)
    })
  })

  describe('4. Knowledge Base Deletion & Preview', () => {
    it('generates accurate KB deletion preview with full hierarchy counts', async () => {
      const f = createFullFixture()
      const preview = await deletionService.getPreview('knowledge_base', f.kb1.id)

      expect(preview.entityType).toBe('knowledge_base')
      expect(preview.entityId).toBe(f.kb1.id)
      expect(preview.displayName).toBe('Alpha Knowledge Base')
      expect(preview.dependentCounts.bots).toBe(2)
      expect(preview.dependentCounts.sources).toBe(1)
      expect(preview.dependentCounts.chunks).toBe(1)
      expect(preview.dependentCounts.conversations).toBe(2)
      expect(preview.dependentCounts.messages).toBe(2)
      expect(preview.dependentCounts.memories).toBe(1)
      expect(preview.isBlocked).toBe(false)
      expect(preview.backupReversible).toBe(true)
    })

    it('blocks KB deletion if any child conversation is actively generating', async () => {
      const f = createFullFixture()
      vi.mocked(mockTurnService.isGenerating!).mockImplementation((id) => id === f.conv1.id)

      const preview = await deletionService.getPreview('knowledge_base', f.kb1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('chat generation is currently running')

      await expect(
        deletionService.deleteEntity({
          entityType: 'knowledge_base',
          entityId: f.kb1.id,
          confirmName: 'Alpha Knowledge Base'
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('blocks KB deletion if any child source is indexing', async () => {
      const f = createFullFixture()
      db.prepare(`UPDATE knowledge_sources SET indexing_status = 'queued' WHERE id = ?`).run(
        f.source1.id
      )

      const preview = await deletionService.getPreview('knowledge_base', f.kb1.id)
      expect(preview.isBlocked).toBe(true)
      expect(preview.blockReason).toContain('currently being indexed')

      await expect(
        deletionService.deleteEntity({
          entityType: 'knowledge_base',
          entityId: f.kb1.id,
          confirmName: 'Alpha Knowledge Base'
        })
      ).rejects.toThrow(DeletionServiceError)
    })

    it('enforces exact-name confirmation for KB deletion', async () => {
      const f = createFullFixture()

      await expect(
        deletionService.deleteEntity({
          entityType: 'knowledge_base',
          entityId: f.kb1.id,
          confirmName: 'Incorrect Name'
        })
      ).rejects.toThrow(/Confirmation name mismatch/)
    })

    it('successfully deletes entire KB, quarantines and removes files, while leaving sibling KB and provider untouched', async () => {
      const f = createFullFixture()

      // Seed a provider connection and assign it to botBeta to verify ON DELETE RESTRICT safety
      const connId = '44444444-2222-4333-8444-555555555555'
      db.prepare(
        `
        INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at)
        VALUES (?, 'openai', 'OpenAI Pro', 'cred_11111111-2222-4333-8444-555555555555', 'active', 1, 1)
      `
      ).run(connId)
      db.prepare(`UPDATE bots SET provider_connection_id = ? WHERE id = ?`).run(
        connId,
        f.botBeta.id
      )

      const result = await deletionService.deleteEntity({
        entityType: 'knowledge_base',
        entityId: f.kb1.id,
        confirmName: 'Alpha Knowledge Base'
      })

      expect(result.success).toBe(true)
      expect(result.entityId).toBe(f.kb1.id)

      // KB1 and all its child records must be deleted from DB
      expect(
        db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(f.kb1.id)
      ).toBeUndefined()
      expect(
        db.prepare('SELECT COUNT(*) as c FROM bots WHERE knowledge_base_id = ?').get(f.kb1.id)
      ).toEqual({ c: 0 })
      expect(
        db
          .prepare('SELECT COUNT(*) as c FROM knowledge_sources WHERE knowledge_base_id = ?')
          .get(f.kb1.id)
      ).toEqual({ c: 0 })
      expect(
        db
          .prepare('SELECT COUNT(*) as c FROM conversations WHERE knowledge_base_id = ?')
          .get(f.kb1.id)
      ).toEqual({ c: 0 })

      // Preserved assets: Sibling KB2, BotBeta, and Provider Connection must be completely intact!
      expect(db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(f.kb2.id)).toBeDefined()
      expect(db.prepare('SELECT id FROM bots WHERE id = ?').get(f.botBeta.id)).toBeDefined()
      expect(
        db.prepare('SELECT id FROM provider_connections WHERE id = ?').get(connId)
      ).toBeDefined()

      // Managed KB folder on disk must be removed
      const kb1Folder = path.join(tempBaseDir, 'documents', f.kb1.id)
      expect(fs.existsSync(kb1Folder)).toBe(false)
    })
  })

  describe('5. Error Handling & Validation', () => {
    it('throws ENTITY_NOT_FOUND when previewing non-existent entity', async () => {
      const nonExistent = '99999999-9999-4999-8999-999999999999'

      await expect(deletionService.getPreview('conversation', nonExistent)).rejects.toThrow(
        /does not exist/
      )
      await expect(deletionService.getPreview('bot', nonExistent)).rejects.toThrow(/does not exist/)
      await expect(deletionService.getPreview('knowledge_source', nonExistent)).rejects.toThrow(
        /does not exist/
      )
      await expect(deletionService.getPreview('knowledge_base', nonExistent)).rejects.toThrow(
        /does not exist/
      )
    })
  })
})
