import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 012: Single Conversation per Bot & Conversation Segments', () => {
  let db: Database.Database
  const v11Migrations = migrations.slice(0, 11)
  const v12Migrations = migrations.slice(0, 12)

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // -------------------------------------------------------------------------
  // 1. Fresh Database Bootstrap to v12
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Bootstrap to v12', () => {
    it('applies migrations 001 through 012 in sequence on a fresh database', () => {
      const result = runMigrations(db, v12Migrations)

      expect(result.appliedCount).toBe(12)
      expect(result.currentVersion).toBe(12)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

      const status = getMigrationStatus(db, v12Migrations)
      expect(status.currentVersion).toBe(12)
      expect(status.pendingCount).toBe(0)

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('creates conversation_segments table with exact schema and constraints', () => {
      runMigrations(db, v12Migrations)

      const columns = db.prepare('PRAGMA table_info(conversation_segments)').all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>

      const colMap = new Map(columns.map((c) => [c.name, c]))
      expect(colMap.get('id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 })
      expect(colMap.get('conversation_id')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('original_conversation_id')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('title')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('segment_order')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('first_message_created_at')).toMatchObject({ type: 'INTEGER', notnull: 0 })
      expect(colMap.get('last_message_created_at')).toMatchObject({ type: 'INTEGER', notnull: 0 })
      expect(colMap.get('message_count')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('archived_at')).toMatchObject({ type: 'INTEGER', notnull: 0 })
    })

    it('creates messages table with segment_id column and foreign key', () => {
      runMigrations(db, v12Migrations)

      const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>

      const colMap = new Map(columns.map((c) => [c.name, c]))
      expect(colMap.get('segment_id')).toMatchObject({ type: 'TEXT', notnull: 0 })
    })

    it('enforces UNIQUE(bot_id) on conversations table', () => {
      runMigrations(db, v12Migrations)

      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', now, now)

      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-1', 'bot-1', 'kb-1', 'First Conversation', now, now)

      // Attempting to insert a 2nd conversation for the same bot must fail
      expect(() => {
        db.prepare(
          'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('conv-2', 'bot-1', 'kb-1', 'Duplicate Conversation', now, now)
      }).toThrow(/UNIQUE constraint failed: conversations\.bot_id/i)
    })

    it('creates all expected indexes on conversations, segments, and messages', () => {
      runMigrations(db, v12Migrations)

      const convIndexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations'"
          )
          .all() as Array<{ name: string }>
      ).map((i) => i.name)

      expect(convIndexes).toContain('idx_conversations_bot')
      expect(convIndexes).toContain('idx_conversations_kb')
      expect(convIndexes).toContain('idx_conversations_updated')

      const segIndexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversation_segments'"
          )
          .all() as Array<{ name: string }>
      ).map((i) => i.name)

      expect(segIndexes).toContain('idx_conversation_segments_conv')
      expect(segIndexes).toContain('idx_conversation_segments_orig')

      const msgIndexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
          .all() as Array<{ name: string }>
      ).map((i) => i.name)

      expect(msgIndexes).toContain('idx_messages_conversation')
      expect(msgIndexes).toContain('idx_messages_segment')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Migration from v11 to v12 with Consolidation
  // -------------------------------------------------------------------------
  describe('2. Migration from v11 to v12 with Consolidation', () => {
    it('consolidates multiple conversations into canonical conversation and preserves all data', () => {
      // 1. Setup v11 database
      runMigrations(db, v11Migrations)

      const t0 = 1000000
      const t1 = 2000000
      const t2 = 3000000
      const t3 = 4000000

      // Create Knowledge Base KB-1 and KB-2
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-1', 'KB 1', 'documents/kb-1', t0, t0)
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-2', 'KB 2', 'documents/kb-2', t0, t0)

      // Bot 1 in KB-1 has 3 conversations
      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', t0, t0)
      // Bot 2 in KB-1 has 1 conversation
      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-2', 'kb-1', 'Bot 2', 'gpt-4o', t0, t0)
      // Bot 3 in KB-1 has 0 conversations
      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-3', 'kb-1', 'Bot 3', 'gpt-4o', t0, t0)

      // Conversations for Bot 1:
      // conv-1a: earliest (canonical)
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-1a', 'bot-1', 'kb-1', 'First Chat', t1, t1 + 500)
      // conv-1b: middle
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-1b', 'bot-1', 'kb-1', 'Second Chat', t2, t2 + 500)
      // conv-1c: newest
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-1c', 'bot-1', 'kb-1', 'Third Chat', t3, t3 + 500)

      // Conversation for Bot 2:
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-2a', 'bot-2', 'kb-1', 'Solo Chat', t1, t1 + 100)

      // Messages in conv-1a
      db.prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(
        'msg-1',
        'conv-1a',
        'user',
        'Hello Bot 1 from 1a',
        JSON.stringify({ citations: [{ sourceId: 'src-1' }] }),
        t1 + 10
      )
      db.prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('msg-2', 'conv-1a', 'assistant', 'Response in 1a', '{}', t1 + 20)

      // Messages in conv-1b
      db.prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('msg-3', 'conv-1b', 'user', 'Hello Bot 1 from 1b', '{}', t2 + 10)

      // Messages in conv-2a
      db.prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('msg-4', 'conv-2a', 'user', 'Hello Bot 2', '{}', t1 + 10)

      // Agent run associated with conv-1b (to test relinking)
      db.prepare(
        `
        INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('run-1', 'bot-1', 'conv-1b', 'kb-1', 'gpt-4o', t2 + 15)

      // Tool event associated with run-1
      db.prepare(
        `
        INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, started_at)
        VALUES (?, ?, ?, ?, ?)
      `
      ).run('tool-1', 'run-1', 1, 'search_knowledge_base', t2 + 16)

      // Autonomous agent run with NULL conversation_id
      db.prepare(
        `
        INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('run-auto', 'bot-1', null, 'kb-1', 'gpt-4o', t2 + 20)

      // 2. Run Migration 012!
      const migResult = runMigrations(db, v12Migrations)
      expect(migResult.appliedVersions).toContain(12)
      expect(migResult.currentVersion).toBe(12)

      // 3. Verify Foreign Keys and Integrity
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])

      // 4. Verify Bot 1 has exactly 1 canonical conversation: conv-1a
      const bot1Convs = db
        .prepare('SELECT * FROM conversations WHERE bot_id = ?')
        .all('bot-1') as Array<{
        id: string
        title: string
        created_at: number
        updated_at: number
      }>
      expect(bot1Convs).toHaveLength(1)
      expect(bot1Convs[0].id).toBe('conv-1a')
      expect(bot1Convs[0].title).toBe('First Chat')
      expect(bot1Convs[0].created_at).toBe(t1)
      expect(bot1Convs[0].updated_at).toBe(t3 + 500) // aggregated max updated_at

      // 5. Verify conversation_segments for Bot 1
      const bot1Segments = db
        .prepare(
          'SELECT * FROM conversation_segments WHERE conversation_id = ? ORDER BY segment_order ASC'
        )
        .all('conv-1a') as Array<{
        id: string
        original_conversation_id: string
        title: string
        segment_order: number
        message_count: number
        first_message_created_at: number | null
        last_message_created_at: number | null
      }>

      expect(bot1Segments).toHaveLength(3)
      expect(bot1Segments[0]).toMatchObject({
        id: 'conv-1a',
        original_conversation_id: 'conv-1a',
        title: 'First Chat',
        segment_order: 0,
        message_count: 2,
        first_message_created_at: t1 + 10,
        last_message_created_at: t1 + 20
      })
      expect(bot1Segments[1]).toMatchObject({
        id: 'conv-1b',
        original_conversation_id: 'conv-1b',
        title: 'Second Chat',
        segment_order: 1,
        message_count: 1,
        first_message_created_at: t2 + 10,
        last_message_created_at: t2 + 10
      })
      expect(bot1Segments[2]).toMatchObject({
        id: 'conv-1c',
        original_conversation_id: 'conv-1c',
        title: 'Third Chat',
        segment_order: 2,
        message_count: 0,
        first_message_created_at: null,
        last_message_created_at: null
      })

      // 6. Verify messages preservation and segment linking
      const bot1Msgs = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all('conv-1a') as Array<{
        id: string
        conversation_id: string
        segment_id: string
        role: string
        content: string
        metadata_json: string
        created_at: number
      }>

      expect(bot1Msgs).toHaveLength(3)
      // msg-1: from conv-1a
      expect(bot1Msgs[0]).toMatchObject({
        id: 'msg-1',
        conversation_id: 'conv-1a',
        segment_id: 'conv-1a',
        role: 'user',
        content: 'Hello Bot 1 from 1a',
        created_at: t1 + 10
      })
      expect(JSON.parse(bot1Msgs[0].metadata_json)).toEqual({ citations: [{ sourceId: 'src-1' }] })

      // msg-2: from conv-1a
      expect(bot1Msgs[1]).toMatchObject({
        id: 'msg-2',
        conversation_id: 'conv-1a',
        segment_id: 'conv-1a',
        role: 'assistant',
        content: 'Response in 1a',
        created_at: t1 + 20
      })

      // msg-3: moved from conv-1b into conv-1a with segment_id = 'conv-1b'
      expect(bot1Msgs[2]).toMatchObject({
        id: 'msg-3',
        conversation_id: 'conv-1a',
        segment_id: 'conv-1b',
        role: 'user',
        content: 'Hello Bot 1 from 1b',
        created_at: t2 + 10
      })

      // 7. Verify Bot 2 conversation and messages
      const bot2Convs = db
        .prepare('SELECT * FROM conversations WHERE bot_id = ?')
        .all('bot-2') as Array<{ id: string }>
      expect(bot2Convs).toHaveLength(1)
      expect(bot2Convs[0].id).toBe('conv-2a')

      const bot2Msgs = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ?')
        .all('conv-2a') as Array<{ id: string; segment_id: string }>
      expect(bot2Msgs).toHaveLength(1)
      expect(bot2Msgs[0].id).toBe('msg-4')
      expect(bot2Msgs[0].segment_id).toBe('conv-2a')

      // 8. Verify Bot 3 (which had 0 conversations) was automatically provisioned with 1 conversation
      const bot3Convs = db
        .prepare('SELECT * FROM conversations WHERE bot_id = ?')
        .all('bot-3') as Array<{
        id: string
        bot_id: string
        knowledge_base_id: string
        title: string
      }>
      expect(bot3Convs).toHaveLength(1)
      expect(bot3Convs[0].bot_id).toBe('bot-3')
      expect(bot3Convs[0].knowledge_base_id).toBe('kb-1')
      expect(bot3Convs[0].title).toBe('Bot 3 Conversation')

      // 9. Verify Agent Runs relinked to canonical conversation
      const run1 = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get('run-1') as {
        id: string
        conversation_id: string
        bot_id: string
      }
      expect(run1.conversation_id).toBe('conv-1a')
      expect(run1.bot_id).toBe('bot-1')

      // Tool event intact
      const tool1 = db.prepare('SELECT * FROM tool_events WHERE id = ?').get('tool-1') as {
        id: string
        agent_run_id: string
      }
      expect(tool1.agent_run_id).toBe('run-1')

      // Autonomous run still NULL
      const runAuto = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get('run-auto') as {
        id: string
        conversation_id: string | null
      }
      expect(runAuto.conversation_id).toBeNull()
    })

    it('cascades deletion from bot to canonical conversation, segments, messages, and agent runs', () => {
      runMigrations(db, v12Migrations)

      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-del', 'KB Del', 'documents/kb-del', now, now)
      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-del', 'kb-del', 'Bot Del', 'gpt-4o', now, now)
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-del', 'bot-del', 'kb-del', 'Chat', now, now)
      db.prepare(
        `
        INSERT INTO conversation_segments (id, conversation_id, original_conversation_id, title, segment_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('seg-del', 'conv-del', 'conv-del', 'Segment', 0, now)
      db.prepare(
        `
        INSERT INTO messages (id, conversation_id, segment_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('msg-del', 'conv-del', 'seg-del', 'user', 'Hi', now)
      db.prepare(
        `
        INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run('run-del', 'bot-del', 'conv-del', 'kb-del', 'gpt-4o', now)
      db.prepare(
        `
        INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, started_at)
        VALUES (?, ?, ?, ?, ?)
      `
      ).run('tool-del', 'run-del', 1, 'search_knowledge_base', now)

      // Delete the bot
      db.prepare('DELETE FROM bots WHERE id = ?').run('bot-del')

      // Confirm cascading deletion across all linked tables
      expect(
        db.prepare('SELECT count(*) as c FROM conversations WHERE id = ?').get('conv-del')
      ).toEqual({ c: 0 })
      expect(
        db.prepare('SELECT count(*) as c FROM conversation_segments WHERE id = ?').get('seg-del')
      ).toEqual({ c: 0 })
      expect(db.prepare('SELECT count(*) as c FROM messages WHERE id = ?').get('msg-del')).toEqual({
        c: 0
      })
      expect(
        db.prepare('SELECT count(*) as c FROM agent_runs WHERE id = ?').get('run-del')
      ).toEqual({ c: 0 })
      expect(
        db.prepare('SELECT count(*) as c FROM tool_events WHERE id = ?').get('tool-del')
      ).toEqual({ c: 0 })
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  })
})
