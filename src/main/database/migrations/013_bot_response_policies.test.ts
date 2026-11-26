import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 013: Configurable Bot Response Policies', () => {
  let db: Database.Database
  const v12Migrations = migrations.slice(0, 12)
  const v13Migrations = migrations.slice(0, 13)

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. migrates existing v12 database and assigns all existing Bots to balanced_kb_first', () => {
    runMigrations(db, v12Migrations)

    const kbId = randomUUID()
    const connId = randomUUID()
    const bot1Id = randomUUID()
    const bot2Id = randomUUID()
    const conv1Id = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Engineering KB', 'Docs', '/tmp/eng-kb', ?, ?)
      `
    ).run(kbId, now, now)

    db.prepare(
      `
      INSERT INTO provider_connections (
        id, provider_id, label, credential_ref, status, created_at, updated_at
      ) VALUES (?, 'openai', 'Primary Key', 'cred_test_primary_key', 'active', ?, ?)
      `
    ).run(connId, now, now)

    db.prepare(
      `
      INSERT INTO bots (
        id, knowledge_base_id, provider_connection_id, name, description,
        system_prompt, model_id, status, tool_permissions_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'Alpha Bot', 'Alpha', 'Be clear.', 'gpt-4o', 'active', '["search_knowledge_base"]', ?, ?)
      `
    ).run(bot1Id, kbId, connId, now, now)

    db.prepare(
      `
      INSERT INTO bots (
        id, knowledge_base_id, provider_connection_id, name, description,
        system_prompt, model_id, status, tool_permissions_json, created_at, updated_at
      ) VALUES (?, ?, NULL, 'Archived Legacy Bot', '', '', 'claude-sonnet-5-5', 'archived', '[]', ?, ?)
      `
    ).run(bot2Id, kbId, now, now)

    db.prepare(
      `
      INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at)
      VALUES (?, ?, ?, 'Alpha Conversation', ?, ?)
      `
    ).run(conv1Id, bot1Id, kbId, now, now)

    db.prepare(
      `
      INSERT INTO bot_memories (id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at)
      VALUES (?, ?, ?, 'pinned_instruction', 'Remember formatting.', ?, ?)
      `
    ).run(randomUUID(), bot1Id, kbId, now, now)

    db.prepare(
      `
      INSERT INTO agent_runs (
        id, bot_id, conversation_id, knowledge_base_id, status, selected_model, iteration_count, started_at
      ) VALUES (?, ?, ?, ?, 'completed', 'gpt-4o', 1, ?)
      `
    ).run(randomUUID(), bot1Id, conv1Id, kbId, now)

    const result = runMigrations(db, v13Migrations)
    expect(result.appliedCount).toBe(1)
    expect(result.currentVersion).toBe(13)
    expect(result.appliedVersions).toEqual([13])

    const rows = db
      .prepare('SELECT id, name, response_policy, tool_permissions_json FROM bots ORDER BY id')
      .all() as Array<{
      id: string
      name: string
      response_policy: string
      tool_permissions_json: string
    }>

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.response_policy).toBe('balanced_kb_first')
    }

    const alphaRow = rows.find((r) => r.id === bot1Id)!
    expect(alphaRow.tool_permissions_json).toBe('["search_knowledge_base"]')

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('2. fresh database bootstrap sets NOT NULL and balanced_kb_first default on response_policy', () => {
    const result = runMigrations(db, v13Migrations)
    expect(result.appliedCount).toBe(13)
    expect(result.currentVersion).toBe(13)

    const columns = db.prepare('PRAGMA table_info(bots)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const policyCol = columns.find((col) => col.name === 'response_policy')
    expect(policyCol).toBeDefined()
    expect(policyCol?.type).toBe('TEXT')
    expect(policyCol?.notnull).toBe(1)
    expect(policyCol?.dflt_value).toBe("'balanced_kb_first'")

    const kbId = randomUUID()
    const botId = randomUUID()
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Fresh KB', '', '/tmp/fresh-kb', ?, ?)
      `
    ).run(kbId, now, now)

    db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at)
      VALUES (?, ?, 'Default Policy Bot', 'gpt-4o', ?, ?)
      `
    ).run(botId, kbId, now, now)

    const row = db.prepare('SELECT response_policy FROM bots WHERE id = ?').get(botId) as {
      response_policy: string
    }
    expect(row.response_policy).toBe('balanced_kb_first')
  })

  it('3. preserves explicitly configured valid policy values across reloads and repeated runs', () => {
    runMigrations(db, v13Migrations)

    const kbId = randomUUID()
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Multi Policy KB', '', '/tmp/multi-kb', ?, ?)
      `
    ).run(kbId, now, now)

    const strictId = randomUUID()
    const balancedId = randomUUID()
    const generalId = randomUUID()

    const insertStmt = db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, response_policy, created_at, updated_at)
      VALUES (?, ?, ?, 'gpt-4o', ?, ?, ?)
      `
    )
    insertStmt.run(strictId, kbId, 'Strict Bot', 'strict_kb_only', now, now)
    insertStmt.run(balancedId, kbId, 'Balanced Bot', 'balanced_kb_first', now, now)
    insertStmt.run(generalId, kbId, 'General Bot', 'general_ai_chat', now, now)

    const rerun1 = runMigrations(db, v13Migrations)
    const rerun2 = runMigrations(db, v13Migrations)
    expect(rerun1.appliedCount).toBe(0)
    expect(rerun2.appliedCount).toBe(0)

    const status = getMigrationStatus(db, v13Migrations)
    expect(status.currentVersion).toBe(13)
    expect(status.pendingCount).toBe(0)

    const readPolicy = (id: string): string =>
      (
        db.prepare('SELECT response_policy FROM bots WHERE id = ?').get(id) as {
          response_policy: string
        }
      ).response_policy

    expect(readPolicy(strictId)).toBe('strict_kb_only')
    expect(readPolicy(balancedId)).toBe('balanced_kb_first')
    expect(readPolicy(generalId)).toBe('general_ai_chat')
  })

  it('4. rejects invalid or NULL response_policy values via database constraints', () => {
    runMigrations(db, v13Migrations)

    const kbId = randomUUID()
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Constraint KB', '', '/tmp/constraint-kb', ?, ?)
      `
    ).run(kbId, now, now)

    const invalidInsertStmt = db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, response_policy, created_at, updated_at)
      VALUES (?, ?, 'Bad Bot', 'gpt-4o', ?, ?, ?)
      `
    )

    expect(() => invalidInsertStmt.run(randomUUID(), kbId, 'hybrid_mode', now, now)).toThrow(
      /CHECK constraint failed/
    )
    expect(() => invalidInsertStmt.run(randomUUID(), kbId, null, now, now)).toThrow(
      /NOT NULL constraint failed/
    )

    const validBotId = randomUUID()
    invalidInsertStmt.run(validBotId, kbId, 'strict_kb_only', now, now)
    expect(() =>
      db
        .prepare('UPDATE bots SET response_policy = ? WHERE id = ?')
        .run('unrestricted_everything', validBotId)
    ).toThrow(/CHECK constraint failed/)
  })

  it('5. rolls back cleanly if migration 13 fails, preserving v12 schema and prior Bot rows', () => {
    runMigrations(db, v12Migrations)

    const kbId = randomUUID()
    const botId = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Rollback KB', '', '/tmp/rollback-kb', ?, ?)
      `
    ).run(kbId, now, now)

    db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at)
      VALUES (?, ?, 'Surviving Bot', 'gpt-4o', ?, ?)
      `
    ).run(botId, kbId, now, now)

    const failingMigrations = [
      ...v12Migrations,
      {
        version: 13,
        name: 'bot_response_policies_failing_test',
        sql: `
          ALTER TABLE bots
            ADD COLUMN response_policy TEXT NOT NULL DEFAULT 'balanced_kb_first'
            CHECK (response_policy IN ('strict_kb_only', 'balanced_kb_first', 'general_ai_chat'));
          INSERT INTO non_existent_table_trigger_rollback (x) VALUES (1);
        `
      }
    ]

    expect(() => runMigrations(db, failingMigrations)).toThrow(
      /no such table: non_existent_table_trigger_rollback/
    )

    const status = getMigrationStatus(db, v13Migrations)
    expect(status.currentVersion).toBe(12)
    expect(status.pendingCount).toBe(1)

    const columns = db.prepare('PRAGMA table_info(bots)').all() as Array<{ name: string }>
    expect(columns.some((c) => c.name === 'response_policy')).toBe(false)

    const survivingBot = db.prepare('SELECT id, name FROM bots WHERE id = ?').get(botId) as {
      id: string
      name: string
    }
    expect(survivingBot).toEqual({ id: botId, name: 'Surviving Bot' })

    // Applying valid v13 afterwards succeeds cleanly
    const recovery = runMigrations(db, v13Migrations)
    expect(recovery.currentVersion).toBe(13)
    const recoveredBot = db.prepare('SELECT response_policy FROM bots WHERE id = ?').get(botId) as {
      response_policy: string
    }
    expect(recoveredBot.response_policy).toBe('balanced_kb_first')
  })
})
