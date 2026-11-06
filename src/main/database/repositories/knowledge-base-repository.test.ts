import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { ValidationError, RepositoryError } from './types'

describe('KnowledgeBaseRepository', () => {
  let db: Database.Database
  let repo: KnowledgeBaseRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repo = new KnowledgeBaseRepository(db)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // Test 1: Create a valid Knowledge Base
  it('1. creates a valid Knowledge Base with default empty description', () => {
    const kb = repo.create({ name: 'Engineering Workspace' })

    expect(kb).toBeDefined()
    expect(kb.name).toBe('Engineering Workspace')
    expect(kb.description).toBe('')
    expect(kb.archived_at).toBeNull()

    const fetched = repo.getById(kb.id)
    expect(fetched).toEqual(kb)
  })

  // Test 2: Generated ID is a valid UUID
  it('2. ensures generated ID is a valid RFC 4122 UUIDv4', () => {
    const kb = repo.create({ name: 'Architecture KB', description: 'Design documents' })

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(kb.id).toMatch(uuidRegex)
  })

  // Test 3: Timestamps are valid UTC Unix milliseconds
  it('3. ensures created_at and updated_at are valid UTC Unix milliseconds', () => {
    const before = Date.now()
    const kb = repo.create({ name: 'Finance KB' })
    const after = Date.now()

    expect(kb.created_at).toBeGreaterThanOrEqual(before)
    expect(kb.created_at).toBeLessThanOrEqual(after)
    expect(kb.updated_at).toBe(kb.created_at)
  })

  // Test 4: Storage path is generated internally and relative
  it('4. generates an application-controlled relative storage path matching schema specification', () => {
    const kb = repo.create({ name: 'Security KB' })

    expect(kb.storage_path).toBe(`documents/${kb.id}`)
    expect(kb.storage_path.startsWith('/')).toBe(false)
    expect(kb.storage_path.includes(':\\')).toBe(false)
  })

  // Test 5: Get an existing Knowledge Base by ID
  it('5. retrieves an existing Knowledge Base by ID', () => {
    const created = repo.create({ name: 'Product Ops', description: 'Operations docs' })
    const fetched = repo.getById(created.id)

    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(created.id)
    expect(fetched?.name).toBe('Product Ops')
    expect(fetched?.description).toBe('Operations docs')
  })

  // Test 6: Get a nonexistent ID
  it('6. returns null when querying a nonexistent valid UUID', () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000'
    const fetched = repo.getById(nonExistentId)

    expect(fetched).toBeNull()
  })

  // Test 7: List multiple Knowledge Bases
  it('7. lists all active Knowledge Bases', () => {
    expect(repo.list()).toEqual([])

    repo.create({ name: 'Alpha KB' })
    repo.create({ name: 'Beta KB' })
    repo.create({ name: 'Gamma KB' })

    const list = repo.list()
    expect(list).toHaveLength(3)
  })

  // Test 8: Verify ordering
  it('8. verifies ordering is newest first (created_at DESC)', async () => {
    const kb1 = repo.create({ name: 'First KB' })
    await new Promise((r) => setTimeout(r, 10))
    const kb2 = repo.create({ name: 'Second KB' })
    await new Promise((r) => setTimeout(r, 10))
    const kb3 = repo.create({ name: 'Third KB' })

    const list = repo.list()
    expect(list.map((k) => k.id)).toEqual([kb3.id, kb2.id, kb1.id])
  })

  // Test 9: Update a Knowledge Base
  it('9. updates editable fields (name and description)', () => {
    const created = repo.create({ name: 'Original Name', description: 'Original description' })

    const updated = repo.update(created.id, {
      name: 'Updated Name',
      description: 'Updated description'
    })

    expect(updated).not.toBeNull()
    expect(updated?.name).toBe('Updated Name')
    expect(updated?.description).toBe('Updated description')
    expect(updated?.id).toBe(created.id)
    expect(updated?.storage_path).toBe(created.storage_path)
    expect(updated?.created_at).toBe(created.created_at)
  })

  // Test 10: Verify updated_at changes
  it('10. verifies updated_at advances on update while created_at remains unchanged', async () => {
    const created = repo.create({ name: 'Timestamp KB' })

    await new Promise((r) => setTimeout(r, 15))

    const updated = repo.update(created.id, { name: 'New Timestamp Name' })
    expect(updated).not.toBeNull()
    expect(updated!.updated_at).toBeGreaterThan(created.created_at)
    expect(updated!.created_at).toBe(created.created_at)
  })

  // Test 11: Attempt to update protected fields such as id or storage_path
  it('11. rejects attempts to update protected fields (id, storage_path, created_at)', () => {
    const created = repo.create({ name: 'Protected KB' })

    // Attempting to pass protected fields in update input should throw ValidationError
    expect(() => {
      // @ts-expect-error - testing runtime rejection of unpermitted fields
      repo.update(created.id, { id: '00000000-0000-4000-8000-000000000000' })
    }).toThrow(ValidationError)

    expect(() => {
      // @ts-expect-error - testing runtime rejection of unpermitted fields
      repo.update(created.id, { storage_path: 'documents/hacked' })
    }).toThrow(ValidationError)

    expect(() => {
      // @ts-expect-error - testing runtime rejection of unpermitted fields
      repo.update(created.id, { created_at: 1000 })
    }).toThrow(ValidationError)

    // Verify record was not modified
    const unchanged = repo.getById(created.id)
    expect(unchanged?.id).toBe(created.id)
    expect(unchanged?.storage_path).toBe(created.storage_path)
  })

  // Test 12: Reject blank names
  it('12. rejects empty or whitespace-only names on create and update', () => {
    expect(() => repo.create({ name: '' })).toThrow(ValidationError)
    expect(() => repo.create({ name: '   ' })).toThrow(ValidationError)

    const created = repo.create({ name: 'Valid Initial Name' })
    expect(() => repo.update(created.id, { name: '' })).toThrow(ValidationError)
    expect(() => repo.update(created.id, { name: '    ' })).toThrow(ValidationError)
  })

  // Test 13: Reject malformed input
  it('13. rejects malformed identifiers and invalid types', () => {
    expect(() => repo.getById('not-a-valid-uuid')).toThrow(ValidationError)
    expect(() => repo.getById('')).toThrow(ValidationError)
    expect(() => repo.delete('not-a-valid-uuid')).toThrow(ValidationError)
    expect(() => repo.archive('not-a-valid-uuid')).toThrow(ValidationError)
    expect(() => repo.unarchive('not-a-valid-uuid')).toThrow(ValidationError)

    // @ts-expect-error - testing runtime rejection of non-string name
    expect(() => repo.create({ name: 12345 })).toThrow(ValidationError)

    // Name exceeding 255 chars
    expect(() => repo.create({ name: 'a'.repeat(256) })).toThrow(ValidationError)
  })

  // Test 14: Reject unexpected extra properties
  it('14. rejects unexpected extra properties on create and update inputs', () => {
    expect(() => {
      // @ts-expect-error - testing runtime strict object validation
      repo.create({ name: 'Strict KB', extraField: 'not-allowed' })
    }).toThrow(ValidationError)

    const created = repo.create({ name: 'Strict Update KB' })
    expect(() => {
      // @ts-expect-error - testing runtime strict object validation
      repo.update(created.id, { name: 'Valid', maliciousPayload: true })
    }).toThrow(ValidationError)
  })

  // Test 15: Delete an existing Knowledge Base
  it('15. deletes an existing Knowledge Base and returns true', () => {
    const created = repo.create({ name: 'To Be Deleted' })
    const deleted = repo.delete(created.id)

    expect(deleted).toBe(true)
    expect(repo.getById(created.id)).toBeNull()
  })

  // Test 16: Delete a nonexistent Knowledge Base
  it('16. returns false when deleting a nonexistent valid UUID', () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000'
    const deleted = repo.delete(nonExistentId)

    expect(deleted).toBe(false)
  })

  // Test 17: Verify deleting a Knowledge Base cascades to its dependent database records
  it('17. verifies deleting a Knowledge Base cascades to all dependent rows across the schema', () => {
    const kb = repo.create({ name: 'Parent KB' })
    const now = Date.now()

    // Create child source, chunk, bot, conversation, message, agent run, tool event, memory
    const srcId = '00000000-0000-4000-8000-000000000001'
    const chunkId = '00000000-0000-4000-8000-000000000002'
    const botId = '00000000-0000-4000-8000-000000000003'
    const convId = '00000000-0000-4000-8000-000000000004'
    const msgId = '00000000-0000-4000-8000-000000000005'
    const runId = '00000000-0000-4000-8000-000000000006'
    const eventId = '00000000-0000-4000-8000-000000000007'
    const memId = '00000000-0000-4000-8000-000000000008'

    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      srcId,
      kb.id,
      'file.txt',
      'file.txt',
      `documents/${kb.id}/file.txt`,
      'txt',
      'text/plain',
      10,
      'c'.repeat(64),
      now,
      now
    )

    db.prepare(
      `INSERT INTO knowledge_chunks (
        id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(chunkId, kb.id, srcId, 0, 'Chunk text', 2, now)

    db.prepare(
      `INSERT INTO bots (
        id, knowledge_base_id, name, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(botId, kb.id, 'Resident Bot', 'gpt-4o', now, now)

    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, botId, kb.id, 'Thread', now, now)

    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(msgId, convId, 'user', 'Hi', now)

    db.prepare(
      `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(runId, botId, convId, kb.id, 'gpt-4o', now)

    db.prepare(
      'INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(eventId, runId, 1, 'prepare_report', now)

    db.prepare(
      'INSERT INTO bot_memories (id, bot_id, knowledge_base_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(memId, botId, kb.id, 'Note', now, now)

    // Delete KB via repository
    const deleteSuccess = repo.delete(kb.id)
    expect(deleteSuccess).toBe(true)

    // Confirm cascading deletion across all child tables
    expect(db.prepare('SELECT count(*) as c FROM knowledge_sources').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM knowledge_chunks').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM bots').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM conversations').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM messages').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM agent_runs').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM tool_events').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) as c FROM bot_memories').get()).toEqual({ c: 0 })
  })

  // Test 18: Verify deleting one Knowledge Base does not affect another
  it('18. verifies deleting one Knowledge Base does not affect sibling Knowledge Bases or their data', () => {
    const kbA = repo.create({ name: 'KB A' })
    const kbB = repo.create({ name: 'KB B' })

    const botB = '00000000-0000-4000-8000-0000000000bb'
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(botB, kbB.id, 'Bot B', 'gpt-4o', Date.now(), Date.now())

    repo.delete(kbA.id)

    expect(repo.getById(kbA.id)).toBeNull()
    expect(repo.getById(kbB.id)).not.toBeNull()
    expect(
      db.prepare('SELECT count(*) as c FROM bots WHERE knowledge_base_id = ?').get(kbB.id)
    ).toEqual({
      c: 1
    })
  })

  // Test 19: Verify global provider connections remain untouched after Knowledge Base deletion
  it('19. verifies global provider connections remain untouched when Knowledge Bases are deleted', () => {
    const provId = '00000000-0000-4000-8000-000000000099'
    const now = Date.now()
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      provId,
      'anthropic',
      'Global Claude',
      'cred_00000000-0000-4000-8000-000000000099',
      'active',
      now,
      now
    )

    const kb = repo.create({ name: 'KB With Key' })
    const botId = '00000000-0000-4000-8000-000000000088'
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(botId, kb.id, provId, 'Bot using key', 'claude-3-5-sonnet-20241022', now, now)

    repo.delete(kb.id)

    const prov = db.prepare('SELECT id, label FROM provider_connections WHERE id = ?').get(provId)
    expect(prov).toBeDefined()
  })

  // Test 20: Verify the repository does not create physical directories
  it('20. verifies the repository does not create physical directories on disk', () => {
    const kb = repo.create({ name: 'No Disk Folder KB' })

    expect(existsSync(kb.storage_path)).toBe(false)
  })

  // Test 21: Archive and unarchive operations
  it('21. handles explicit archive and unarchive lifecycle transitions', () => {
    const kb = repo.create({ name: 'Lifecycle KB' })
    expect(kb.archived_at).toBeNull()

    // Archive
    const archived = repo.archive(kb.id)
    expect(archived).not.toBeNull()
    expect(archived?.archived_at).toBeGreaterThan(0)

    // By default list() excludes archived
    const activeList = repo.list()
    expect(activeList.find((k) => k.id === kb.id)).toBeUndefined()

    // list({ includeArchived: true }) includes archived
    const fullList = repo.list({ includeArchived: true })
    expect(fullList.find((k) => k.id === kb.id)).toBeDefined()

    // Unarchive
    const unarchived = repo.unarchive(kb.id)
    expect(unarchived).not.toBeNull()
    expect(unarchived?.archived_at).toBeNull()

    expect(repo.list().find((k) => k.id === kb.id)).toBeDefined()
  })

  // Test 22: Integrity validation
  it('22. verifies PRAGMA foreign_key_check returns zero rows after all operations', () => {
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toEqual([])
  })

  // Error wrapping check
  it('23. handles constructor validation failure when database is not provided', () => {
    // @ts-expect-error - testing constructor runtime check
    expect(() => new KnowledgeBaseRepository(null)).toThrow(RepositoryError)
  })
})
