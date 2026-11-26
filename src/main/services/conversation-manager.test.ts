import { describe, it, expect, beforeEach } from 'vitest'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { ConversationManagerService, ConversationManagerError } from './conversation-manager'

describe('ConversationManagerService', () => {
  let dbContext: MigratedTestDatabaseContext
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let botRepo: BotRepository
  let kbRepo: KnowledgeBaseRepository
  let activeContext: ActiveWorkspaceContext
  let manager: ConversationManagerService

  const sessionId = 'session_test_1'
  let kb1Id: string
  let kb2Id: string
  let activeBotId: string
  let archivedBotId: string
  let kb2BotId: string

  beforeEach(() => {
    dbContext = createMigratedTestDatabase()
    convRepo = new ConversationRepository(dbContext.db)
    msgRepo = new MessageRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    activeContext = new ActiveWorkspaceContext({ kbRepo })

    manager = new ConversationManagerService({
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      botRepo,
      activeContext,
      db: dbContext.db
    })

    // Setup two independent Knowledge Bases
    const kb1 = kbRepo.create({ name: 'KB Alpha', description: 'Primary KB' })
    const kb2 = kbRepo.create({ name: 'KB Beta', description: 'Secondary KB' })
    kb1Id = kb1.id
    kb2Id = kb2.id

    // Setup Provider Connection fixture
    const now = Date.now()
    const connId = '00000000-0000-4000-8000-000000000001'
    dbContext.db
      .prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(connId, 'openai', 'OpenAI Work', 'cred_test_12345678', 'active', now, now)

    // Setup Bots
    const bot1 = botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Alpha Bot',
      description: 'Active bot in KB1',
      systemPrompt: 'You are a helpful assistant.',
      providerConnectionId: connId,
      modelId: 'gpt-4o'
    })
    activeBotId = bot1.id

    const bot2 = botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Archived Bot',
      description: 'Archived bot in KB1',
      systemPrompt: 'You are an archived assistant.',
      providerConnectionId: connId,
      modelId: 'gpt-4o'
    })
    botRepo.update(bot2.id, kb1Id, { status: 'archived' })
    archivedBotId = bot2.id

    const bot3 = botRepo.create({
      knowledgeBaseId: kb2Id,
      name: 'Beta Bot',
      description: 'Active bot in KB2',
      systemPrompt: 'You are beta assistant.',
      providerConnectionId: connId,
      modelId: 'gpt-4o'
    })
    kb2BotId = bot3.id

    // Activate KB1 for test session
    activeContext.activateWorkspace(sessionId, kb1Id)
  })

  describe('Active Workspace Validation', () => {
    it('throws NO_ACTIVE_WORKSPACE when session has no active workspace', () => {
      expect(() => {
        manager.createConversation('unregistered_session', { botId: activeBotId })
      }).toThrowError(ConversationManagerError)

      try {
        manager.createConversation('unregistered_session', { botId: activeBotId })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('NO_ACTIVE_WORKSPACE')
      }
    })
  })

  describe('createConversation', () => {
    it('creates a conversation for an active Bot in the active workspace', () => {
      const conv = manager.createConversation(sessionId, {
        botId: activeBotId,
        title: 'Project Roadmap'
      })

      expect(conv.id).toBeDefined()
      expect(conv.botId).toBe(activeBotId)
      expect(conv.knowledgeBaseId).toBe(kb1Id)
      expect(conv.title).toBe('Project Roadmap')
      expect(conv.archivedAt).toBeNull()
    })

    it('rejects Bot belonging to another Knowledge Base with BOT_MISMATCH', () => {
      expect(() => {
        manager.createConversation(sessionId, {
          botId: kb2BotId,
          title: 'Cross-KB Attempt'
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.createConversation(sessionId, {
          botId: kb2BotId,
          title: 'Cross-KB Attempt'
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('BOT_MISMATCH')
      }
    })

    it('rejects an archived Bot with BOT_ARCHIVED', () => {
      expect(() => {
        manager.createConversation(sessionId, {
          botId: archivedBotId,
          title: 'Archived Bot Conv'
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.createConversation(sessionId, {
          botId: archivedBotId,
          title: 'Archived Bot Conv'
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('BOT_ARCHIVED')
      }
    })

    it('rejects invalid title with INVALID_INPUT', () => {
      expect(() => {
        manager.createConversation(sessionId, {
          botId: activeBotId,
          title: '   '
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.createConversation(sessionId, {
          botId: activeBotId,
          title: '   '
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('INVALID_INPUT')
      }
    })
  })

  describe('listConversations', () => {
    it('lists conversations belonging to the requested Bot in active workspace and enforces single conversation', () => {
      const conv1 = manager.createConversation(sessionId, { botId: activeBotId, title: 'Conv 1' })
      const conv2 = manager.createConversation(sessionId, { botId: activeBotId, title: 'Conv 2' })

      // Single conversation invariant: repeated create returns existing canonical conversation
      expect(conv2.id).toBe(conv1.id)

      const list = manager.listConversations(sessionId, { botId: activeBotId })
      expect(list.length).toBe(1)
      expect(list[0].id).toBe(conv1.id)
      expect(list[0].title).toBe('Conv 1')
    })

    it('rejects if botId is missing or belongs to another KB', () => {
      expect(() => {
        manager.listConversations(sessionId, {})
      }).toThrowError(ConversationManagerError)

      expect(() => {
        manager.listConversations(sessionId, { botId: kb2BotId })
      }).toThrowError(ConversationManagerError)

      try {
        manager.listConversations(sessionId, { botId: kb2BotId })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('BOT_MISMATCH')
      }
    })
  })

  describe('getConversation and getMessages', () => {
    it('retrieves conversation and loaded messages in chronological order', () => {
      const conv = manager.createConversation(sessionId, {
        botId: activeBotId,
        title: 'History Test'
      })

      msgRepo.create({
        conversationId: conv.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Question 1',
        contentFormat: 'text'
      })

      msgRepo.create({
        conversationId: conv.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'assistant',
        content: 'Answer 1',
        contentFormat: 'text'
      })

      const fetchedConv = manager.getConversation(sessionId, conv.id)
      expect(fetchedConv.id).toBe(conv.id)
      expect(fetchedConv.title).toBe('History Test')

      const messages = manager.getMessages(sessionId, conv.id)
      expect(messages.length).toBe(2)
      expect(messages[0].content).toBe('Question 1')
      expect(messages[0].role).toBe('user')
      expect(messages[1].content).toBe('Answer 1')
      expect(messages[1].role).toBe('assistant')
    })

    it('rejects retrieving messages for a conversation belonging to another KB', () => {
      // Create conversation in KB2
      activeContext.activateWorkspace(sessionId, kb2Id)
      const conv2 = manager.createConversation(sessionId, { botId: kb2BotId, title: 'KB2 Thread' })

      // Switch back to KB1
      activeContext.activateWorkspace(sessionId, kb1Id)

      expect(() => {
        manager.getMessages(sessionId, conv2.id)
      }).toThrowError(ConversationManagerError)

      try {
        manager.getMessages(sessionId, conv2.id)
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })
  })

  describe('renameConversation', () => {
    it('renames an active conversation in active workspace', () => {
      const conv = manager.createConversation(sessionId, { botId: activeBotId, title: 'Old Title' })
      const updated = manager.renameConversation(sessionId, conv.id, 'New Title')

      expect(updated.title).toBe('New Title')
      expect(updated.id).toBe(conv.id)
    })

    it('rejects renaming an archived conversation with CONVERSATION_ARCHIVED', () => {
      const conv = manager.createConversation(sessionId, {
        botId: activeBotId,
        title: 'Will Archive'
      })

      // Archive conversation directly in DB
      dbContext.db
        .prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
        .run(Date.now(), conv.id)

      expect(() => {
        manager.renameConversation(sessionId, conv.id, 'Renamed Archived')
      }).toThrowError(ConversationManagerError)

      try {
        manager.renameConversation(sessionId, conv.id, 'Renamed Archived')
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CONVERSATION_ARCHIVED')
      }
    })
  })

  describe('deleteConversation', () => {
    it('deletes conversation and cascades deletion to linked messages', () => {
      const conv = manager.createConversation(sessionId, { botId: activeBotId, title: 'To Delete' })

      msgRepo.create({
        conversationId: conv.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Question to be deleted',
        contentFormat: 'text'
      })

      const res = manager.deleteConversation(sessionId, conv.id)
      expect(res.success).toBe(true)
      expect(res.conversationId).toBe(conv.id)

      // Verify conversation record is deleted
      const checkConv = dbContext.db
        .prepare('SELECT 1 FROM conversations WHERE id = ?')
        .get(conv.id)
      expect(checkConv).toBeUndefined()

      // Verify messages are cascaded
      const checkMsgs = dbContext.db
        .prepare('SELECT 1 FROM messages WHERE conversation_id = ?')
        .get(conv.id)
      expect(checkMsgs).toBeUndefined()
    })

    it('rejects deleting conversation belonging to another KB', () => {
      activeContext.activateWorkspace(sessionId, kb2Id)
      const conv2 = manager.createConversation(sessionId, { botId: kb2BotId, title: 'KB2 Thread' })

      activeContext.activateWorkspace(sessionId, kb1Id)

      expect(() => {
        manager.deleteConversation(sessionId, conv2.id)
      }).toThrowError(ConversationManagerError)

      try {
        manager.deleteConversation(sessionId, conv2.id)
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })
  })

  describe('resolveCitation (Phase 7 Step 7.10)', () => {
    let source1Id: string
    let chunk1Id: string
    let conv1Id: string
    let messageWithCitationId: string

    beforeEach(() => {
      // Create a Knowledge Source in KB1
      const now = Date.now()
      source1Id = '00000000-0000-4000-8000-000000000010'
      dbContext.db
        .prepare(
          `
          INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          source1Id,
          kb1Id,
          'architecture_guide.pdf',
          'architecture_guide.pdf',
          'sources/architecture_guide.pdf',
          'pdf',
          'application/pdf',
          1024,
          'a'.repeat(64),
          'completed',
          now,
          now
        )

      // Create a chunk belonging to source1 in KB1
      chunk1Id = '00000000-0000-4000-8000-000000000020'
      dbContext.db
        .prepare(
          `
          INSERT INTO knowledge_chunks (
            id, knowledge_base_id, source_id, chunk_index, content,
            page_number, token_count, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          chunk1Id,
          kb1Id,
          source1Id,
          0,
          'Architecture chunk content',
          3,
          50,
          JSON.stringify({ headingPath: ['Overview', 'Architecture'] }),
          now
        )

      // Create a conversation in KB1
      const conv = manager.createConversation(sessionId, {
        botId: activeBotId,
        title: 'Citation Test Conversation'
      })
      conv1Id = conv.id

      // Persist assistant message with authentic citation metadata
      const msg = msgRepo.create({
        conversationId: conv1Id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'assistant',
        content: 'According to the architecture guide [1], the system is offline-first.',
        contentFormat: 'markdown',
        metadata: {
          citations: [
            {
              citationNumber: 1,
              sourceId: source1Id,
              chunkId: chunk1Id,
              fileName: 'architecture_guide.pdf',
              fileType: 'pdf',
              pageNumber: 3,
              headingPath: ['Overview', 'Architecture'],
              chunkIndex: 0
            }
          ]
        }
      })
      messageWithCitationId = msg.id
    })

    it('23. resolves a valid citation to the authoritative preview target', () => {
      const target = manager.resolveCitation(sessionId, {
        conversationId: conv1Id,
        messageId: messageWithCitationId,
        citationNumber: 1
      })

      expect(target).toBeDefined()
      expect(target.citationNumber).toBe(1)
      expect(target.sourceId).toBe(source1Id)
      expect(target.chunkId).toBe(chunk1Id)
      expect(target.knowledgeBaseId).toBe(kb1Id)
      expect(target.fileName).toBe('architecture_guide.pdf')
      expect(target.fileType).toBe('pdf')
      expect(target.pageNumber).toBe(3)
      expect(target.headingPath).toEqual(['Overview', 'Architecture'])
      expect(target.chunkIndex).toBe(0)
    })

    it('24. rejects citation request when message belongs to another conversation', () => {
      const otherBot = botRepo.create({
        knowledgeBaseId: kb1Id,
        name: 'Other Bot For Citation Test',
        modelId: 'gpt-4o'
      })
      const otherConv = manager.createConversation(sessionId, {
        botId: otherBot.id,
        title: 'Other Conversation'
      })

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: otherConv.id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: otherConv.id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('MESSAGE_NOT_FOUND')
      }
    })

    it('25. rejects citation request when conversation belongs to another Knowledge Base', () => {
      activeContext.activateWorkspace(sessionId, kb2Id)
      const convKb2 = manager.createConversation(sessionId, {
        botId: kb2BotId,
        title: 'KB2 Thread'
      })

      // Switch back to KB1 session
      activeContext.activateWorkspace(sessionId, kb1Id)

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: convKb2.id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: convKb2.id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CONVERSATION_NOT_FOUND')
      }
    })

    it('26. rejects citationNumber that is absent from message persisted metadata', () => {
      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 99
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 99
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CITATION_NOT_FOUND')
      }
    })

    it('27. rejects citation when source belongs to another Knowledge Base', () => {
      // Move source to KB2 in database to simulate cross-KB tampering
      dbContext.db
        .prepare('UPDATE knowledge_sources SET knowledge_base_id = ? WHERE id = ?')
        .run(kb2Id, source1Id)

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CITATION_SOURCE_UNAVAILABLE')
      }
    })

    it('28. rejects citation when chunk does not belong to cited source', () => {
      // Create another valid source in KB1
      const source2Id = '00000000-0000-4000-8000-000000000099'
      const now = Date.now()
      dbContext.db
        .prepare(
          `
          INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          source2Id,
          kb1Id,
          'other_doc.pdf',
          'other_doc.pdf',
          'sources/other_doc.pdf',
          'pdf',
          'application/pdf',
          2048,
          'b'.repeat(64),
          'completed',
          now,
          now
        )

      // Reassign chunk to source2Id so it does not match cited source1Id
      dbContext.db
        .prepare('UPDATE knowledge_chunks SET source_id = ? WHERE id = ?')
        .run(source2Id, chunk1Id)

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CITATION_CHUNK_UNAVAILABLE')
      }
    })

    it('29. returns safe unavailable error when cited source has been deleted', () => {
      // Delete source
      dbContext.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(source1Id)

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)

      try {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('CITATION_SOURCE_UNAVAILABLE')
      }
    })

    it('30. prevents caller from choosing an arbitrary Knowledge Base or supplying arbitrary source paths', () => {
      // Attempting to resolve citation with invalid non-positive citationNumber or invalid UUIDs
      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: conv1Id,
          messageId: messageWithCitationId,
          citationNumber: 0
        })
      }).toThrowError(ConversationManagerError)

      expect(() => {
        manager.resolveCitation(sessionId, {
          conversationId: 'not-a-uuid',
          messageId: messageWithCitationId,
          citationNumber: 1
        })
      }).toThrowError(ConversationManagerError)
    })
  })

  // ==========================================================================
  // Step 12.2: Unified Canonical Conversation Open & Clear Conversation
  // ==========================================================================

  describe('Step 12.2: openBotConversation, getClearPreview, and clearConversation', () => {
    it('31. opens existing canonical conversation, segments, and >100 messages reliably across reopens', () => {
      const canonical = convRepo.create({
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        title: 'Canonical Workspace'
      })
      const baseTs = 1700000000000
      for (let i = 0; i < 105; i++) {
        const created = msgRepo.create({
          conversationId: canonical.id,
          botId: activeBotId,
          knowledgeBaseId: kb1Id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Turn ${i}`
        })
        dbContext.db
          .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
          .run(baseTs + i, created.id)
      }

      const firstOpen = manager.openBotConversation(sessionId, activeBotId)
      const secondOpen = manager.openBotConversation(sessionId, activeBotId)

      expect(firstOpen.conversation.id).toBe(canonical.id)
      expect(secondOpen.conversation.id).toBe(canonical.id)
      expect(firstOpen.segments).toHaveLength(1)
      expect(firstOpen.messages).toHaveLength(105)
      expect(firstOpen.messages[104].content).toBe('Turn 104')
    })

    it('32. recovers canonical conversation cleanly for an active Bot missing one without duplicating on reopen', () => {
      // Simulate legacy/missing conversation state for activeBotId (created via botRepo directly)
      expect(convRepo.getByBotId(activeBotId, kb1Id)).toBeNull()

      const opened = manager.openBotConversation(sessionId, activeBotId)
      expect(opened.conversation.botId).toBe(activeBotId)
      expect(opened.conversation.knowledgeBaseId).toBe(kb1Id)
      expect(opened.segments).toHaveLength(1)
      expect(opened.segments[0].segmentOrder).toBe(0)
      expect(opened.messages).toEqual([])

      const reopened = manager.openBotConversation(sessionId, activeBotId)
      expect(reopened.conversation.id).toBe(opened.conversation.id)
    })

    it('33. opens archived Bot canonical conversation read-only if it exists, and fails safely if missing', () => {
      // Archived bot missing a canonical conversation must NOT silently create one
      expect(convRepo.getByBotId(archivedBotId, kb1Id)).toBeNull()
      expect(() => manager.openBotConversation(sessionId, archivedBotId)).toThrowError(
        ConversationManagerError
      )
      expect(convRepo.getByBotId(archivedBotId, kb1Id)).toBeNull()

      // When canonical conversation exists, archived Bot opens read-only
      const archivedConv = convRepo.create({
        botId: archivedBotId,
        knowledgeBaseId: kb1Id,
        title: 'Archived Canonical'
      })
      msgRepo.create({
        conversationId: archivedConv.id,
        botId: archivedBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Historical question'
      })

      const workspace = manager.openBotConversation(sessionId, archivedBotId)
      expect(workspace.conversation.id).toBe(archivedConv.id)
      expect(workspace.messages).toHaveLength(1)
    })

    it('34. rejects opening conversation for cross-KB or nonexistent Bot', () => {
      expect(() => manager.openBotConversation(sessionId, kb2BotId)).toThrowError(
        ConversationManagerError
      )
      try {
        manager.openBotConversation(sessionId, kb2BotId)
      } catch (err) {
        expect((err as ConversationManagerError).code).toBe('BOT_NOT_FOUND')
      }

      expect(() =>
        manager.openBotConversation(sessionId, '00000000-0000-4000-8000-000000009999')
      ).toThrowError(ConversationManagerError)
    })

    it('35. getClearPreview reports counts and blocks active operations without mutating state', () => {
      const opened = manager.openBotConversation(sessionId, activeBotId)
      msgRepo.create({
        conversationId: opened.conversation.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Msg 1'
      })
      dbContext.db
        .prepare(
          `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, status, started_at)
           VALUES (?, ?, ?, ?, 'gpt-4o', 'completed', ?)`
        )
        .run('run-preview-1', activeBotId, opened.conversation.id, kb1Id, Date.now())

      const preview = manager.getClearPreview(sessionId, opened.conversation.id)
      expect(preview).toEqual({
        conversationId: opened.conversation.id,
        conversationTitle: opened.conversation.title,
        botId: activeBotId,
        botName: 'Alpha Bot',
        messageCount: 1,
        segmentCount: 1,
        agentRunCount: 1,
        toolEventCount: 0,
        isBlocked: false
      })

      const blockedPreview = manager.getClearPreview(sessionId, opened.conversation.id, {
        isGenerating: true
      })
      expect(blockedPreview.isBlocked).toBe(true)
      expect(blockedPreview.blockReason).toBeTruthy()
    })

    it('36. clearConversation empties history, preserves canonical ID & agent_run audit, and keeps Bot usable', () => {
      const opened = manager.openBotConversation(sessionId, activeBotId)
      msgRepo.create({
        conversationId: opened.conversation.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Before clear'
      })
      dbContext.db
        .prepare(
          `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, status, started_at)
           VALUES (?, ?, ?, ?, 'gpt-4o', 'completed', ?)`
        )
        .run('run-retain-1', activeBotId, opened.conversation.id, kb1Id, Date.now())

      const result = manager.clearConversation(sessionId, opened.conversation.id)
      expect(result.conversation.id).toBe(opened.conversation.id)
      expect(result.deletedMessagesCount).toBe(1)
      expect(result.preservedAgentRunsCount).toBe(1)
      expect(result.activeSegment.segmentOrder).toBe(0)

      // Reopen preserves canonical ID and starts empty
      const afterClear = manager.openBotConversation(sessionId, activeBotId)
      expect(afterClear.conversation.id).toBe(opened.conversation.id)
      expect(afterClear.messages).toEqual([])
      expect(afterClear.segments).toHaveLength(1)

      // Writing a fresh message afterward works cleanly
      const nextMsg = msgRepo.create({
        conversationId: opened.conversation.id,
        botId: activeBotId,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'After clear'
      })
      const afterNextMsg = manager.openBotConversation(sessionId, activeBotId)
      expect(afterNextMsg.messages.map((m) => m.id)).toEqual([nextMsg.id])

      // Cross-KB clear rejected
      const kb2Session = 'session_kb2'
      activeContext.activateWorkspace(kb2Session, kb2Id)
      const kb2Opened = manager.openBotConversation(kb2Session, kb2BotId)
      expect(() => manager.clearConversation(sessionId, kb2Opened.conversation.id)).toThrowError(
        ConversationManagerError
      )
    })
  })
})
