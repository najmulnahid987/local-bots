import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 004: Import Recovery Journal', () => {
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

  it('applies migrations 001, 002, 003, and 004 in sequence on a fresh database', () => {
    const result = runMigrations(db, migrations.slice(0, 4))

    expect(result.appliedCount).toBe(4)
    expect(result.currentVersion).toBe(4)
    expect(result.appliedVersions).toEqual([1, 2, 3, 4])

    const status = getMigrationStatus(db, migrations.slice(0, 4))
    expect(status.currentVersion).toBe(4)
    expect(status.pendingCount).toBe(0)

    const fkPragma = db.pragma('foreign_keys', { simple: true })
    expect(fkPragma).toBe(1)

    const fkCheck = db.pragma('foreign_key_check') as unknown[]
    expect(fkCheck).toEqual([])
  })

  it('creates import_recovery_journal table with expected columns and constraints', () => {
    runMigrations(db, migrations)

    const columns = db.prepare('PRAGMA table_info(import_recovery_journal)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    const colMap = new Map(columns.map((c) => [c.name, c]))
    expect(colMap.get('id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 })
    expect(colMap.get('strategy')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('target_knowledge_base_id')).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(colMap.get('target_knowledge_base_name')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('archive_sha256')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('archive_name')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('state')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('staging_dir_name')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('quarantine_dir_name')).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(colMap.get('promoted_files_json')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'[]'"
    })
    expect(colMap.get('remapping_json')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'{}'"
    })
    expect(colMap.get('counts_json')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'{}'"
    })
    expect(colMap.get('error_message')).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(colMap.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
    expect(colMap.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
  })

  it('creates explicit indexes on import_recovery_journal', () => {
    runMigrations(db, migrations)

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_recovery_journal' ORDER BY name ASC"
      )
      .all() as Array<{ name: string }>

    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_import_recovery_journal_created_at')
    expect(indexNames).toContain('idx_import_recovery_journal_state')
    expect(indexNames).toContain('idx_import_recovery_journal_target_kb')
  })

  it('enforces CHECK constraint on strategy', () => {
    runMigrations(db, migrations)

    const insertStmt = db.prepare(`
      INSERT INTO import_recovery_journal (
        id, strategy, target_knowledge_base_name, archive_sha256, archive_name,
        state, staging_dir_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    // Valid strategy
    insertStmt.run(
      'op-1',
      'replace',
      'Test KB',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'test.zip',
      'quarantining',
      'import-staging-1',
      1000,
      1000
    )

    // Invalid strategy throws CHECK failure
    expect(() => {
      insertStmt.run(
        'op-2',
        'invalid_strategy',
        'Test KB',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'test.zip',
        'quarantining',
        'import-staging-2',
        1000,
        1000
      )
    }).toThrow(/CHECK constraint failed/)
  })

  it('enforces CHECK constraint on state', () => {
    runMigrations(db, migrations)

    const insertStmt = db.prepare(`
      INSERT INTO import_recovery_journal (
        id, strategy, target_knowledge_base_name, archive_sha256, archive_name,
        state, staging_dir_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    // Invalid state throws CHECK failure
    expect(() => {
      insertStmt.run(
        'op-3',
        'new',
        'Test KB',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'test.zip',
        'non_existent_state',
        'import-staging-3',
        1000,
        1000
      )
    }).toThrow(/CHECK constraint failed/)
  })

  it('enforces JSON validity on JSON fields', () => {
    runMigrations(db, migrations)

    const insertStmt = db.prepare(`
      INSERT INTO import_recovery_journal (
        id, strategy, target_knowledge_base_name, archive_sha256, archive_name,
        state, staging_dir_name, promoted_files_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    expect(() => {
      insertStmt.run(
        'op-4',
        'new',
        'Test KB',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'test.zip',
        'staging',
        'import-staging-4',
        '{ invalid json',
        1000,
        1000
      )
    }).toThrow(/CHECK constraint failed/)
  })
})
