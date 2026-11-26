import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { BotRepository } from './bot-repository'
import { ConversationRepository } from './conversation-repository'
import { ValidationError, RepositoryError } from './types'

describe('ConversationRepository (Phase 7 Step 7.2)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    convRepo = new ConversationRepository(db)

    const kbA = kbRepo.create({ name: 'Knowledge Base A' })
    const kbB = kbRepo.create({ name: 'Knowledge Base B' })
    kbAId = kbA.id
    kbBId = kbB.id

    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot Alpha',
      modelId: 'gpt-6-luna'
    })
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot Beta',
      modelId: 'claude-sonnet-5-5'
    })
    botAId = botA.id
    botBId = botB.id
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // ==========================================================================
  // Creation Tests
  // ==========================================================================

  it('1. creates a conversation for a valid Bot inside its Knowledge Base', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Q3 Analysis'
    })

    expect(conv).toBeDefined()
    expect(conv.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(conv.botId).toBe(botAId)
    expect(conv.knowledgeBaseId).toBe(kbAId)
    expect(conv.title).toBe('Q3 Analysis')
    expect(conv.createdAt).toBeGreaterThan(0)
    expect(conv.updatedAt).toBe(conv.createdAt)
    expect(conv.archivedAt).toBeNull()
  })

  it('2. assigns default conversation title when not specified', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId
    })

    expect(conv.title).toBe('New Conversation')
  })

  it('3. accepts a custom conversation title', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Deep Research Thread'
    })

    expect(conv.title).toBe('Deep Research Thread')
  })

  it('4. rejects creation with invalid Bot UUID', () => {
    expect(() =>
      convRepo.create({
        botId: 'not-a-uuid',
        knowledgeBaseId: kbAId
      })
    ).toThrow(ValidationError)
  })

  it('5. rejects creation with invalid Knowledge Base UUID', () => {
    expect(() =>
      convRepo.create({
        botId: botAId,
        knowledgeBaseId: 'not-a-uuid'
      })
    ).toThrow(ValidationError)
  })

  it('6. rejects creation when Bot does not belong to the supplied Knowledge Base', () => {
    // botA belongs to kbA, attempt creation claiming kbB
    expect(() =>
      convRepo.create({
        botId: botAId,
        knowledgeBaseId: kbBId,
        title: 'Cross-KB Attempt'
      })
    ).toThrow(ValidationError)
  })

  // ==========================================================================
  // Retrieval & Ownership Tests
  // ==========================================================================

  it('7. retrieves conversation by full ownership tuple (id, botId, knowledgeBaseId)', () => {
    const created = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Target Conversation'
    })

    const retrieved = convRepo.getById(created.id, botAId, kbAId)
    expect(retrieved).toEqual(created)
  })

  it('8. rejects retrieval using a different Bot ID', () => {
    const created = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Bot A Conversation'
    })

    // Sibling bot in same KB or bot from another KB
    const retrieved = convRepo.getById(created.id, botBId, kbAId)
    expect(retrieved).toBeNull()
  })

  it('9. rejects retrieval using a different Knowledge Base ID', () => {
    const created = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Bot A Conversation'
    })

    const retrieved = convRepo.getById(created.id, botAId, kbBId)
    expect(retrieved).toBeNull()
  })

  it('9b. retrieves conversation strictly by conversationId via getByIdOnly', () => {
    const created = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Direct By ID'
    })

    const retrieved = convRepo.getByIdOnly(created.id)
    expect(retrieved).toEqual(created)
    expect(retrieved?.botId).toBe(botAId)
    expect(retrieved?.knowledgeBaseId).toBe(kbAId)
  })

  it('9c. returns null from getByIdOnly for non-existent conversation ID', () => {
    const nonExistent = '00000000-0000-4000-8000-000000000099'
    expect(convRepo.getByIdOnly(nonExistent)).toBeNull()
  })

  it('9d. rejects non-UUID in getByIdOnly with ValidationError', () => {
    expect(() => convRepo.getByIdOnly('not-a-uuid')).toThrow(ValidationError)
  })

  // ==========================================================================
  // Listing, Single-Bot Invariant & Segment Tests
  // ==========================================================================

  it('10. enforces exactly one conversation per Bot and rejects creating a second conversation', () => {
    const conv1 = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Conv 1' })

    // Attempting to create a second conversation for the same bot must throw RepositoryError
    expect(() => {
      convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Conv 2' })
    }).toThrow(RepositoryError)

    const list = convRepo.listByBot(botAId, kbAId)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(conv1.id)
    expect(list[0].title).toBe('Conv 1')
  })

  it('11. excludes archived conversations by default', () => {
    const conv1 = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Active Conv' })

    // Soft-archive conv1 in SQLite
    db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), conv1.id)

    const list = convRepo.listByBot(botAId, kbAId)
    expect(list.length).toBe(0)
  })

  it('12. includes archived conversations when requested', () => {
    const conv1 = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Active Conv' })

    db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), conv1.id)

    const list = convRepo.listByBot(botAId, kbAId, { includeArchived: true })
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(conv1.id)
  })

  it('13. getByBotId retrieves conversation and getOrCreate is idempotent', () => {
    const conv1 = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Canonical' })

    const found = convRepo.getByBotId(botAId, kbAId)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(conv1.id)

    // getOrCreate returns the existing conversation without throwing
    const idempotent = convRepo.getOrCreate({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'New Title'
    })
    expect(idempotent.id).toBe(conv1.id)
    expect(idempotent.title).toBe('Canonical')
  })

  it('14. creates initial segment on conversation creation and retrieves segments via getSegments', () => {
    const conv = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Thread 1' })

    const segments = convRepo.getSegments(conv.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].conversationId).toBe(conv.id)
    expect(segments[0].title).toBe('Thread 1')
    expect(segments[0].segmentOrder).toBe(0)
    expect(segments[0].messageCount).toBe(0)
  })

  // ==========================================================================
  // Renaming Tests
  // ==========================================================================

  it('15. renames conversation and advances updated_at monotonically', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Original Title'
    })

    const renamed = convRepo.rename(conv.id, botAId, kbAId, 'Updated Title')
    expect(renamed).toBeDefined()
    expect(renamed?.title).toBe('Updated Title')
    expect(renamed?.updatedAt).toBeGreaterThanOrEqual(conv.updatedAt)
  })

  it('16. rejects blank or whitespace-only titles during rename', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Valid Title'
    })

    expect(() => convRepo.rename(conv.id, botAId, kbAId, '')).toThrow(ValidationError)
    expect(() => convRepo.rename(conv.id, botAId, kbAId, '   ')).toThrow(ValidationError)
  })

  it('17. preserves immutable ownership fields during rename and returns null for wrong bot/KB', () => {
    const conv = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Protected Conv'
    })

    // Mismatched bot
    const result1 = convRepo.rename(conv.id, botBId, kbAId, 'New Title')
    expect(result1).toBeNull()

    // Mismatched KB
    const result2 = convRepo.rename(conv.id, botAId, kbBId, 'New Title')
    expect(result2).toBeNull()

    // Title was NOT modified
    const current = convRepo.getById(conv.id, botAId, kbAId)
    expect(current?.title).toBe('Protected Conv')
  })

  // ==========================================================================
  // Deletion and Cascade Tests
  // ==========================================================================

  it('18. deletes only the specified conversation matching the full ownership tuple', () => {
    const conv1 = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'To Delete' })
    const conv2 = convRepo.create({ botId: botBId, knowledgeBaseId: kbBId, title: 'To Keep' })

    const deleted = convRepo.delete(conv1.id, botAId, kbAId)
    expect(deleted).toBe(true)

    expect(convRepo.getById(conv1.id, botAId, kbAId)).toBeNull()
    expect(convRepo.getById(conv2.id, botBId, kbBId)).not.toBeNull()
  })

  it('19. deleting a conversation cascades to its child messages and agent runs', () => {
    const conv = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Cascade Conv' })

    // Directly insert message and agent_run under conv
    const msgId = 'msg-1111-1111-1111-111111111111'
    db.prepare(
      `
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, 'user', 'Hello Bot', ?)
    `
    ).run(msgId, conv.id, Date.now())

    const runId = 'run-1111-1111-1111-111111111111'
    db.prepare(
      `
      INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
      VALUES (?, ?, ?, ?, 'gpt-6-luna', ?)
    `
    ).run(runId, botAId, conv.id, kbAId, Date.now())

    expect(db.prepare('SELECT count(*) as c FROM messages WHERE id = ?').get(msgId)).toEqual({
      c: 1
    })
    expect(db.prepare('SELECT count(*) as c FROM agent_runs WHERE id = ?').get(runId)).toEqual({
      c: 1
    })

    // Delete conversation
    convRepo.delete(conv.id, botAId, kbAId)

    // Cascaded to 0
    expect(db.prepare('SELECT count(*) as c FROM messages WHERE id = ?').get(msgId)).toEqual({
      c: 0
    })
    expect(db.prepare('SELECT count(*) as c FROM agent_runs WHERE id = ?').get(runId)).toEqual({
      c: 0
    })
  })

  it('20. deleting a conversation preserves unrelated conversations and sibling Bots', () => {
    const siblingBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Sibling Bot',
      modelId: 'gemini-3.8-flash'
    })

    const convTarget = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Target' })
    const convSibling = convRepo.create({
      botId: siblingBot.id,
      knowledgeBaseId: kbAId,
      title: 'Sibling Conv'
    })

    convRepo.delete(convTarget.id, botAId, kbAId)

    expect(convRepo.getById(convTarget.id, botAId, kbAId)).toBeNull()
    expect(convRepo.getById(convSibling.id, siblingBot.id, kbAId)).not.toBeNull()
    expect(botRepo.getById(botAId, kbAId)).not.toBeNull()
    expect(botRepo.getById(siblingBot.id, kbAId)).not.toBeNull()
  })

  // ==========================================================================
  // Cross-KB Isolation Tests
  // ==========================================================================

  describe('Cross-Knowledge-Base Isolation Invariants', () => {
    it('verifies complete cross-KB conversation isolation between Bot A (KB A) and Bot B (KB B)', () => {
      const convA = convRepo.create({
        botId: botAId,
        knowledgeBaseId: kbAId,
        title: 'Bot A Thread'
      })
      const convB = convRepo.create({
        botId: botBId,
        knowledgeBaseId: kbBId,
        title: 'Bot B Thread'
      })

      // 1. Bot A cannot retrieve Bot B's conversation
      expect(convRepo.getById(convB.id, botAId, kbAId)).toBeNull()

      // 2. Bot B cannot retrieve Bot A's conversation
      expect(convRepo.getById(convA.id, botBId, kbBId)).toBeNull()

      // 3. Bot A list does not contain Bot B's conversation
      const listA = convRepo.listByBot(botAId, kbAId)
      expect(listA.map((c) => c.id)).toContain(convA.id)
      expect(listA.map((c) => c.id)).not.toContain(convB.id)

      // 4. Fabricated Bot/KB combinations cannot delete Bot B's conversation
      const deleteAttempt = convRepo.delete(convB.id, botAId, kbAId)
      expect(deleteAttempt).toBe(false)
      expect(convRepo.getById(convB.id, botBId, kbBId)).not.toBeNull()
    })
  })

  // ==========================================================================
  // Step 12.2: Clear Conversation & Preview Stats
  // ==========================================================================

  describe('Step 12.2: Clear Conversation & Audit Preservation', () => {
    it('returns accurate clear preview stats scoped to the conversation', () => {
      const conv = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Preview Conv' })
      const now = Date.now()
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'M1', ?)`
      ).run('msg-prev-1', conv.id, now)
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'M2', ?)`
      ).run('msg-prev-2', conv.id, now + 1)
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, status, started_at)
         VALUES (?, ?, ?, ?, 'gpt-6-luna', 'completed', ?)`
      ).run('run-prev-1', botAId, conv.id, kbAId, now)

      const preview = convRepo.getClearPreviewStats(conv.id, botAId, kbAId)
      expect(preview).toMatchObject({
        messageCount: 2,
        segmentCount: 1,
        agentRunCount: 1,
        toolEventCount: 0,
        activeAgentRunCount: 0
      })
      expect(preview?.conversation.id).toBe(conv.id)
    })

    it('clears messages atomically, resets segments to empty segment 0, preserves conversation ID and detached agent_runs', () => {
      const conv = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Clear Target' })
      const now = Date.now()
      db.prepare(
        `INSERT INTO conversation_segments (id, conversation_id, original_conversation_id, title, segment_order, created_at)
         VALUES (?, ?, ?, 'Second Segment', 1, ?)`
      ).run('seg-extra-1', conv.id, conv.id, now + 5)

      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'Hello', ?)`
      ).run('msg-clear-1', conv.id, now + 10)
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, status, started_at)
         VALUES (?, ?, ?, ?, 'gpt-6-luna', 'completed', ?)`
      ).run('run-clear-1', botAId, conv.id, kbAId, now + 12)

      const result = convRepo.clearConversation(conv.id, botAId, kbAId)
      expect(result).not.toBeNull()
      expect(result?.conversation.id).toBe(conv.id)
      expect(result?.deletedMessagesCount).toBe(1)
      expect(result?.preservedAgentRunsCount).toBe(1)
      expect(result?.activeSegment.segmentOrder).toBe(0)
      expect(result?.activeSegment.title).toBe(conv.title)
      expect(result?.activeSegment.messageCount).toBe(0)

      // Canonical conversation row preserved with same ID and monotonic updated_at
      const reloaded = convRepo.getById(conv.id, botAId, kbAId)
      expect(reloaded).not.toBeNull()
      expect(reloaded?.id).toBe(conv.id)
      expect(reloaded?.updatedAt).toBeGreaterThanOrEqual(conv.updatedAt)

      // Messages cleared; single fresh segment at order 0
      const remainingMessages = db
        .prepare('SELECT count(*) as c FROM messages WHERE conversation_id = ?')
        .get(conv.id) as { c: number }
      expect(remainingMessages.c).toBe(0)

      const segments = convRepo.getSegments(conv.id)
      expect(segments).toHaveLength(1)
      expect(segments[0].id).toBe(result?.activeSegment.id)
      expect(segments[0].segmentOrder).toBe(0)

      // Historical agent_run is retained with conversation_id detached (NULL)
      const retainedRun = db
        .prepare('SELECT id, conversation_id, bot_id FROM agent_runs WHERE id = ?')
        .get('run-clear-1') as
        { id: string; conversation_id: string | null; bot_id: string } | undefined
      expect(retainedRun).toEqual({
        id: 'run-clear-1',
        conversation_id: null,
        bot_id: botAId
      })
    })

    it('rejects clearConversation while an agent run is running', () => {
      const conv = convRepo.create({ botId: botAId, knowledgeBaseId: kbAId, title: 'Busy Conv' })
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, status, started_at)
         VALUES (?, ?, ?, ?, 'gpt-6-luna', 'running', ?)`
      ).run('run-active-1', botAId, conv.id, kbAId, Date.now())

      expect(() => convRepo.clearConversation(conv.id, botAId, kbAId)).toThrow(/active/i)
      expect(convRepo.getClearPreviewStats(conv.id, botAId, kbAId)?.activeAgentRunCount).toBe(1)
    })

    it('enforces cross-KB ownership when clearing conversation', () => {
      const convB = convRepo.create({ botId: botBId, knowledgeBaseId: kbBId, title: 'KB B Conv' })
      expect(convRepo.clearConversation(convB.id, botAId, kbAId)).toBeNull()
      expect(convRepo.getById(convB.id, botBId, kbBId)).not.toBeNull()
    })
  })
})
