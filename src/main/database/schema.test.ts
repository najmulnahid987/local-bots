import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runMigrations } from './migrations/runner'
import { migrations } from './migrations'
import { DatabaseManager } from './connection'

describe('Core SQLite Schema Migration (001_initial_schema)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // Test A — Migration execution on clean database
  it('Test A: applies migration on a clean database and records metadata in schema_migrations', () => {
    const result = runMigrations(db, migrations)

    expect(result.appliedCount).toBe(migrations.length)
    expect(result.appliedVersions).toEqual(migrations.map((m) => m.version))
    expect(result.currentVersion).toBe(migrations.length)

    const migrationRow = db
      .prepare(
        'SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = 1'
      )
      .get() as {
      version: number
      name: string
      checksum: string
      applied_at: number
    }

    expect(migrationRow).toBeDefined()
    expect(migrationRow.version).toBe(1)
    expect(migrationRow.name).toBe('initial_schema')
    expect(typeof migrationRow.checksum).toBe('string')
    expect(migrationRow.checksum.length).toBe(64) // SHA-256 hex string
    expect(migrationRow.applied_at).toBeGreaterThan(0)
  })

  // Test B — Verify all 14 core tables exist
  it('Test B: creates all 14 core application relational tables', () => {
    runMigrations(db, migrations)

    const expectedTables = [
      'agent_runs',
      'app_settings',
      'bot_memories',
      'bots',
      'conversations',
      'deletion_recovery_journal',
      'import_recovery_journal',
      'knowledge_bases',
      'knowledge_chunks',
      'knowledge_extracted_documents',
      'knowledge_sources',
      'messages',
      'provider_connections',
      'tool_events'
    ]

    const actualTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' AND name NOT LIKE 'knowledge_fts%' ORDER BY name ASC"
        )
        .all() as { name: string }[]
    ).map((row) => row.name)

    expect(actualTables).toEqual(expectedTables)
  })

  // Test C — Verify all 27 indexes exist
  it('Test C: creates all 27 explicit performance indexes', () => {
    runMigrations(db, migrations)

    const expectedIndexes = [
      'idx_agent_runs_bot',
      'idx_agent_runs_conversation',
      'idx_agent_runs_status',
      'idx_bot_memories_bot',
      'idx_bot_memories_kb',
      'idx_bots_kb',
      'idx_bots_provider',
      'idx_conversations_bot',
      'idx_conversations_kb',
      'idx_conversations_updated',
      'idx_deletion_recovery_journal_created_at',
      'idx_deletion_recovery_journal_entity',
      'idx_deletion_recovery_journal_state',
      'idx_import_recovery_journal_created_at',
      'idx_import_recovery_journal_state',
      'idx_import_recovery_journal_target_kb',
      'idx_knowledge_bases_created_at',
      'idx_knowledge_chunks_kb',
      'idx_knowledge_chunks_source',
      'idx_knowledge_extracted_documents_created',
      'idx_knowledge_sources_hash',
      'idx_knowledge_sources_kb',
      'idx_knowledge_sources_status',
      'idx_messages_conversation',
      'idx_provider_connections_provider',
      'idx_provider_connections_ref',
      'idx_tool_events_run'
    ]

    const actualIndexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
        )
        .all() as { name: string }[]
    ).map((row) => row.name)

    expect(actualIndexes).toEqual(expectedIndexes)
  })

  // Test D — Idempotency on second run
  it('Test D: ensures migration execution is strictly idempotent on subsequent runs', () => {
    const firstRun = runMigrations(db, migrations)
    expect(firstRun.appliedCount).toBe(migrations.length)
    expect(firstRun.currentVersion).toBe(migrations.length)

    const secondRun = runMigrations(db, migrations)
    expect(secondRun.appliedCount).toBe(0)
    expect(secondRun.appliedVersions).toEqual([])
    expect(secondRun.currentVersion).toBe(migrations.length)
  })

  // Test E — Full valid entity insertion and relationships
  it('Test E: permits valid insertions and relational traversal across all 11 tables', () => {
    runMigrations(db, migrations)

    const now = Date.now()
    const kbId = 'kb-uuid-001'
    const providerId = 'provider-uuid-001'
    const sourceId = 'src-uuid-001'
    const chunkId = 'chunk-uuid-001'
    const botId = 'bot-uuid-001'
    const convId = 'conv-uuid-001'
    const msgId = 'msg-uuid-001'
    const runId = 'run-uuid-001'
    const eventId = 'event-uuid-001'
    const memoryId = 'mem-uuid-001'

    // 1. knowledge_bases
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(kbId, 'Engineering Docs', 'Core engineering KB', `documents/${kbId}`, now, now)

    // 2. provider_connections
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      providerId,
      'anthropic',
      'Work Claude API',
      'cred_00000000-0000-4000-8000-000000000002',
      'active',
      now,
      now
    )

    // 3. app_settings
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'theme',
      'dark',
      now
    )

    // 4. knowledge_sources
    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceId,
      kbId,
      'architecture.pdf',
      'Architecture Guide.pdf',
      `documents/${kbId}/architecture.pdf`,
      'pdf',
      'application/pdf',
      1024,
      'a'.repeat(64),
      'completed',
      now,
      now
    )

    // 5. knowledge_chunks
    db.prepare(
      `INSERT INTO knowledge_chunks (
        id, knowledge_base_id, source_id, chunk_index, content,
        page_number, token_count, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chunkId,
      kbId,
      sourceId,
      0,
      'Section 1: Architecture Overview and System Boundaries',
      1,
      12,
      JSON.stringify({ header: 'Architecture' }),
      now
    )

    // 6. bots
    db.prepare(
      `INSERT INTO bots (
        id, knowledge_base_id, provider_connection_id, name, description,
        system_prompt, model_id, status, tool_permissions_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      botId,
      kbId,
      providerId,
      'Architect Bot',
      'Specialized in system architecture analysis',
      'You are a software architect assistant.',
      'claude-3-5-sonnet-20241022',
      'active',
      JSON.stringify(['read_knowledge_base_document', 'search_project_files']),
      now,
      now
    )

    // 7. conversations
    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, botId, kbId, 'Initial Architecture Discussion', now, now)

    // 8. messages
    db.prepare(
      `INSERT INTO messages (
        id, conversation_id, role, content, content_format,
        metadata_json, token_usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msgId,
      convId,
      'user',
      'What are the core system boundaries?',
      'markdown',
      '{}',
      '{}',
      now
    )

    // 9. agent_runs
    db.prepare(
      `INSERT INTO agent_runs (
        id, bot_id, conversation_id, knowledge_base_id, status,
        selected_model, iteration_count, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, botId, convId, kbId, 'running', 'claude-3-5-sonnet-20241022', 1, now)

    // 10. tool_events
    db.prepare(
      `INSERT INTO tool_events (
        id, agent_run_id, sequence_number, tool_name, status,
        approval_status, arguments_summary, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      runId,
      1,
      'read_knowledge_base_document',
      'completed',
      'auto_approved',
      JSON.stringify({ documentId: sourceId }),
      now
    )

    // 11. bot_memories
    db.prepare(
      `INSERT INTO bot_memories (
        id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(memoryId, botId, kbId, 'user_note', 'User prefers concise summaries.', now, now)

    // Verify all rows inserted successfully
    for (const table of [
      'knowledge_bases',
      'provider_connections',
      'app_settings',
      'knowledge_sources',
      'knowledge_chunks',
      'bots',
      'conversations',
      'messages',
      'agent_runs',
      'tool_events',
      'bot_memories'
    ]) {
      const count = db.prepare(`SELECT count(*) as c FROM ${table}`).get() as { c: number }
      expect(count.c).toBe(1)
    }
  })

  // Test F — Composite FK: Knowledge Chunks to Knowledge Sources
  it('Test F: composite foreign key prevents assigning a chunk to a source in a different Knowledge Base', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-2', 'KB 2', 'documents/kb-2', now, now)

    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'src-1',
      'kb-1',
      'doc.txt',
      'doc.txt',
      'documents/kb-1/doc.txt',
      'txt',
      'text/plain',
      10,
      'b'.repeat(64),
      now,
      now
    )

    // Cross-KB insertion attempt: chunk claims to belong to kb-2, but source is in kb-1
    expect(() => {
      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('chunk-mismatch', 'kb-2', 'src-1', 0, 'Cross KB chunk', 5, now)
    }).toThrow(/FOREIGN KEY constraint failed/i)
  })

  // Test G — Composite FK: Conversations to Bots
  it('Test G: composite foreign key prevents assigning a conversation to a Bot in a different Knowledge Base', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-2', 'KB 2', 'documents/kb-2', now, now)

    db.prepare(
      `INSERT INTO bots (
        id, knowledge_base_id, name, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', now, now)

    // Cross-KB insertion attempt: conversation claims kb-2, but bot-1 is in kb-1
    expect(() => {
      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('conv-mismatch', 'bot-1', 'kb-2', 'Cross-KB Thread', now, now)
    }).toThrow(/FOREIGN KEY constraint failed/i)
  })

  // Test H — Composite FK: Agent Runs to Bots & Conversations
  it('Test H: composite foreign keys in agent_runs enforce Bot, conversation, and KB consistency, while allowing null conversation_id', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-2', 'KB 2', 'documents/kb-2', now, now)

    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', now, now)
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('bot-2', 'kb-1', 'Bot 2', 'gpt-4o', now, now)

    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('conv-1', 'bot-1', 'kb-1', 'Thread 1', now, now)
    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('conv-2', 'bot-2', 'kb-1', 'Thread 2', now, now)

    // 1. Cross-KB bot attempt: run claims kb-2, but bot is in kb-1
    expect(() => {
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('run-cross-kb', 'bot-1', null, 'kb-2', 'gpt-4o', now)
    }).toThrow(/FOREIGN KEY constraint failed/i)

    // 2. Cross-bot conversation attempt: run is for bot-1, but conversation conv-2 belongs to bot-2
    expect(() => {
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('run-cross-bot', 'bot-1', 'conv-2', 'kb-1', 'gpt-4o', now)
    }).toThrow(/FOREIGN KEY constraint failed/i)

    // 3. Autonomous run with NULL conversation_id succeeds
    db.prepare(
      `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('run-autonomous', 'bot-1', null, 'kb-1', 'gpt-4o', now)

    const autonomousRun = db
      .prepare('SELECT id, bot_id, conversation_id FROM agent_runs WHERE id = ?')
      .get('run-autonomous') as { id: string; bot_id: string; conversation_id: string | null }
    expect(autonomousRun).toBeDefined()
    expect(autonomousRun.conversation_id).toBeNull()

    // 4. Valid conversational run with matching bot and conversation succeeds
    db.prepare(
      `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('run-matched', 'bot-1', 'conv-1', 'kb-1', 'gpt-4o', now)

    const matchedRun = db
      .prepare('SELECT id, bot_id, conversation_id FROM agent_runs WHERE id = ?')
      .get('run-matched') as { id: string; bot_id: string; conversation_id: string | null }
    expect(matchedRun.conversation_id).toBe('conv-1')
  })

  // Test I — Composite FK: Bot Memories to Bots
  it('Test I: composite foreign key prevents assigning memory to a Bot in a different Knowledge Base', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-2', 'KB 2', 'documents/kb-2', now, now)

    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', now, now)

    // Cross-KB insertion attempt: memory claims kb-2, but bot-1 is in kb-1
    expect(() => {
      db.prepare(
        'INSERT INTO bot_memories (id, bot_id, knowledge_base_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('mem-cross', 'bot-1', 'kb-2', 'Cross-KB memory note', now, now)
    }).toThrow(/FOREIGN KEY constraint failed/i)
  })

  // Test J — Provider Connection BLOB and ON DELETE RESTRICT
  it('Test J: preserves binary BLOB credentials and enforces ON DELETE RESTRICT when referenced by active Bots', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    // 1. Insert provider connection with opaque credential reference
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'prov-1',
      'openai',
      'My OpenAI',
      'cred_00000000-0000-4000-8000-000000000001',
      'active',
      now,
      now
    )

    const storedProv = db
      .prepare(
        'SELECT id, provider_id, label, credential_ref FROM provider_connections WHERE id = ?'
      )
      .get('prov-1') as { id: string; provider_id: string; label: string; credential_ref: string }
    expect(storedProv.credential_ref).toBe('cred_00000000-0000-4000-8000-000000000001')

    // 2. Link a bot to this provider connection
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'prov-1', 'Active Bot', 'gpt-4o', now, now)

    // 3. Attempt to delete referenced provider connection -> MUST throw RESTRICT violation
    expect(() => {
      db.prepare('DELETE FROM provider_connections WHERE id = ?').run('prov-1')
    }).toThrow(/FOREIGN KEY constraint failed/i)

    // 4. If bot is deleted or reassigned, connection can then be deleted
    db.prepare('DELETE FROM bots WHERE id = ?').run('bot-1')
    const deleteResult = db.prepare('DELETE FROM provider_connections WHERE id = ?').run('prov-1')
    expect(deleteResult.changes).toBe(1)
  })

  // Test K — Bot Tool Permissions JSON Array CHECK Constraint
  it('Test K: validates tool_permissions_json strictly as a JSON array', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

    const insertBotWithPerms = (botId: string, perms: string): void => {
      db.prepare(
        `INSERT INTO bots (
          id, knowledge_base_id, name, model_id, tool_permissions_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(botId, 'kb-1', `Bot ${botId}`, 'gpt-4o', perms, now, now)
    }

    // Valid JSON arrays
    expect(() => insertBotWithPerms('bot-empty-array', '[]')).not.toThrow()
    expect(() =>
      insertBotWithPerms('bot-valid-array', '["read_knowledge_base_document", "prepare_report"]')
    ).not.toThrow()

    // Invalid values
    expect(() => insertBotWithPerms('bot-object', '{"tool": "read"}')).toThrow(
      /CHECK constraint failed/i
    )
    expect(() => insertBotWithPerms('bot-invalid-json', 'not-json')).toThrow(
      /CHECK constraint failed/i
    )
    expect(() => insertBotWithPerms('bot-null', 'null')).toThrow(/CHECK constraint failed/i)
    expect(() => insertBotWithPerms('bot-number', '123')).toThrow(/CHECK constraint failed/i)
    expect(() => insertBotWithPerms('bot-string', '"just-a-string"')).toThrow(
      /CHECK constraint failed/i
    )
  })

  // Test L — CHECK constraints
  it('Test L: enforces all field-level CHECK constraints across tables', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

    // 1. Empty or whitespace KB name
    expect(() => {
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-empty-name', '   ', 'documents/kb-empty', now, now)
    }).toThrow(/CHECK constraint failed/i)

    // 2. updated_at < created_at
    expect(() => {
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-bad-ts', 'Bad TS', 'documents/kb-bad-ts', now, now - 1000)
    }).toThrow(/CHECK constraint failed/i)

    // 3. Invalid content_hash length in knowledge_sources
    expect(() => {
      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'src-bad-hash',
        'kb-1',
        'file.txt',
        'file.txt',
        'documents/kb-1/file.txt',
        'txt',
        'text/plain',
        10,
        'short-hash',
        now,
        now
      )
    }).toThrow(/CHECK constraint failed/i)

    // 4. Invalid message role
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'Bot 1', 'gpt-4o', now, now)
    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('conv-1', 'bot-1', 'kb-1', 'Thread', now, now)

    expect(() => {
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('msg-bad-role', 'conv-1', 'superadmin', 'Hello', now)
    }).toThrow(/CHECK constraint failed/i)

    // 5. Negative or > 5 iteration count in agent_runs
    expect(() => {
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, knowledge_base_id, selected_model, iteration_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('run-neg-iter', 'bot-1', 'kb-1', 'gpt-4o', -1, now)
    }).toThrow(/CHECK constraint failed/i)

    expect(() => {
      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, knowledge_base_id, selected_model, iteration_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('run-excess-iter', 'bot-1', 'kb-1', 'gpt-4o', 6, now)
    }).toThrow(/CHECK constraint failed/i)
  })

  // Test M — Knowledge Base Cascading Deletion
  it('Test M: cascading deletion of a Knowledge Base purges all child records while leaving sibling KBs and provider connections intact', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    // 1. Shared provider connection
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'shared-prov',
      'openai',
      'Company Key',
      'cred_00000000-0000-4000-8000-000000000099',
      'active',
      now,
      now
    )

    // 2. Knowledge Base A & B
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-a', 'KB Alpha', 'documents/kb-a', now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-b', 'KB Beta', 'documents/kb-b', now, now)

    // 3. Child entities for both KBs
    for (const kb of ['a', 'b']) {
      const kbId = `kb-${kb}`
      const srcId = `src-${kb}`
      const chunkId = `chunk-${kb}`
      const botId = `bot-${kb}`
      const convId = `conv-${kb}`
      const msgId = `msg-${kb}`
      const runId = `run-${kb}`
      const eventId = `event-${kb}`
      const memId = `mem-${kb}`

      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        srcId,
        kbId,
        'file.txt',
        'file.txt',
        `documents/${kbId}/file.txt`,
        'txt',
        'text/plain',
        10,
        `${kb}`.repeat(64),
        now,
        now
      )

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, srcId, 0, `Chunk for ${kb}`, 5, now)

      db.prepare(
        `INSERT INTO bots (
          id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(botId, kbId, 'shared-prov', `Bot ${kb}`, 'gpt-4o', now, now)

      db.prepare(
        'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(convId, botId, kbId, `Conv ${kb}`, now, now)

      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(msgId, convId, 'user', `Message ${kb}`, now)

      db.prepare(
        `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(runId, botId, convId, kbId, 'gpt-4o', now)

      db.prepare(
        `INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, started_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(eventId, runId, 1, 'prepare_report', now)

      db.prepare(
        `INSERT INTO bot_memories (id, bot_id, knowledge_base_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(memId, botId, kbId, `Memory ${kb}`, now, now)
    }

    // 4. Delete Knowledge Base A
    const delResult = db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run('kb-a')
    expect(delResult.changes).toBe(1)

    // 5. Verify all KB-A dependent tables are completely purged
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM knowledge_sources WHERE knowledge_base_id = 'kb-a'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM knowledge_chunks WHERE knowledge_base_id = 'kb-a'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM bots WHERE knowledge_base_id = 'kb-a'").get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM conversations WHERE knowledge_base_id = 'kb-a'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM messages WHERE id = 'msg-a'").get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM agent_runs WHERE knowledge_base_id = 'kb-a'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM tool_events WHERE id = 'event-a'").get() as {
          c: number
        }
      ).c
    ).toBe(0)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM bot_memories WHERE knowledge_base_id = 'kb-a'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(0)

    // 6. Verify KB-B and all its child records remain intact
    expect(
      (
        db.prepare("SELECT count(*) as c FROM knowledge_bases WHERE id = 'kb-b'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM knowledge_sources WHERE knowledge_base_id = 'kb-b'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM knowledge_chunks WHERE knowledge_base_id = 'kb-b'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM bots WHERE knowledge_base_id = 'kb-b'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM conversations WHERE knowledge_base_id = 'kb-b'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM messages WHERE id = 'msg-b'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM agent_runs WHERE knowledge_base_id = 'kb-b'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db.prepare("SELECT count(*) as c FROM tool_events WHERE id = 'event-b'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM bot_memories WHERE knowledge_base_id = 'kb-b'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)

    // 7. Verify shared provider connection remains
    expect(
      (
        db
          .prepare("SELECT count(*) as c FROM provider_connections WHERE id = 'shared-prov'")
          .get() as {
          c: number
        }
      ).c
    ).toBe(1)
  })

  // Test N — Full foreign-key integrity check
  it('Test N: PRAGMA foreign_key_check returns zero integrity violations on fully populated database', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'prov-1',
      'google',
      'Gemini Pro',
      'cred_00000000-0000-4000-8000-000000000088',
      'active',
      now,
      now
    )
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'prov-1', 'Research Bot', 'gemini-1.5-pro', now, now)
    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('conv-1', 'bot-1', 'kb-1', 'Research Session', now, now)
    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('msg-1', 'conv-1', 'user', 'Analyze data', now)

    const fkViolations = db.pragma('foreign_key_check') as unknown[]
    expect(fkViolations).toEqual([])
  })

  // Test O — Restart and persistence via DatabaseManager
  it('Test O: persists schema and data across connection restarts via DatabaseManager', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-db-mgr-'))
    const manager = new DatabaseManager()

    try {
      // 1. First initialization: apply migration and insert data
      const init1 = manager.initialize(tempDir)
      expect(init1.foreignKeys).toBe(true)

      const db1 = manager.getDatabase()
      runMigrations(db1, migrations)

      const now = Date.now()
      db1
        .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('workspace_name', 'My Persistent Workspace', now)

      // Close connection
      manager.close()
      expect(manager.isOpen()).toBe(false)

      // 2. Second initialization: reopen database
      const init2 = manager.initialize(tempDir)
      expect(init2.foreignKeys).toBe(true)

      const db2 = manager.getDatabase()

      // Verify migration idempotency on reopen
      const rerunResult = runMigrations(db2, migrations)
      expect(rerunResult.appliedCount).toBe(0)
      expect(rerunResult.currentVersion).toBe(migrations.length)

      // Verify data persisted
      const setting = db2
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get('workspace_name') as { value: string }
      expect(setting).toBeDefined()
      expect(setting.value).toBe('My Persistent Workspace')

      // Verify all 14 tables still exist
      const tableCount = db2
        .prepare(
          "SELECT count(*) as c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' AND name NOT LIKE 'knowledge_fts%'"
        )
        .get() as { c: number }
      expect(tableCount.c).toBe(14)

      manager.close()
    } finally {
      manager.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
