import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 005: Deletion Recovery Journal', () => {
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

  it('applies migrations 001 through 005 in sequence on a fresh database', () => {
    const migrations005 = migrations.slice(0, 5)
    const result = runMigrations(db, migrations005)

    expect(result.appliedCount).toBe(5)
    expect(result.currentVersion).toBe(5)
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5])

    const status = getMigrationStatus(db, migrations005)
    expect(status.currentVersion).toBe(5)
    expect(status.pendingCount).toBe(0)

    const fkPragma = db.pragma('foreign_keys', { simple: true })
    expect(fkPragma).toBe(1)

    const fkCheck = db.pragma('foreign_key_check') as unknown[]
    expect(fkCheck).toEqual([])
  })

  it('creates deletion_recovery_journal table with expected columns and constraints', () => {
    runMigrations(db, migrations)

    const columns = db.prepare('PRAGMA table_info(deletion_recovery_journal)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    const colMap = new Map(columns.map((c) => [c.name, c]))
    expect(colMap.get('id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 })
    expect(colMap.get('entity_type')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('entity_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('knowledge_base_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('entity_name')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('quarantine_path_name')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('original_rel_path')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 })
    expect(colMap.get('state')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 })
    expect(colMap.get('error_message')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 })
    expect(colMap.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 })
    expect(colMap.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 })
  })

  it('enforces entity_type CHECK constraint', () => {
    runMigrations(db, migrations)

    const stmt = db.prepare(`
      INSERT INTO deletion_recovery_journal (
        id, entity_type, entity_id, knowledge_base_id, entity_name,
        quarantine_path_name, original_rel_path, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    expect(() =>
      stmt.run(
        'op-1',
        'invalid_entity',
        'ent-1',
        'kb-1',
        'KB 1',
        '.quarantine_kb_1',
        'kb-1',
        'preparing',
        1000,
        1000
      )
    ).toThrow(/CHECK constraint failed/)

    expect(() =>
      stmt.run(
        'op-1',
        'knowledge_base',
        'ent-1',
        'kb-1',
        'KB 1',
        '.quarantine_kb_1',
        'kb-1',
        'preparing',
        1000,
        1000
      )
    ).not.toThrow()
  })

  it('enforces state CHECK constraint with permitted lifecycle states', () => {
    runMigrations(db, migrations)

    const validStates = [
      'preparing',
      'quarantining',
      'database_deleting',
      'database_deleted',
      'filesystem_finalizing',
      'completed',
      'rolling_back',
      'recovery_required',
      'failed'
    ]

    const insertStmt = db.prepare(`
      INSERT INTO deletion_recovery_journal (
        id, entity_type, entity_id, knowledge_base_id, entity_name,
        quarantine_path_name, original_rel_path, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const [idx, state] of validStates.entries()) {
      expect(() =>
        insertStmt.run(
          `op-${idx}`,
          'knowledge_source',
          `source-${idx}`,
          'kb-1',
          `file-${idx}.pdf`,
          `.quarantine_source_${idx}`,
          `originals/source-${idx}.pdf`,
          state,
          1000 + idx,
          1000 + idx
        )
      ).not.toThrow()
    }

    expect(() =>
      insertStmt.run(
        'op-bad',
        'knowledge_source',
        'source-bad',
        'kb-1',
        'file.pdf',
        '.quarantine_source_bad',
        'originals/source-bad.pdf',
        'bogus_state',
        2000,
        2000
      )
    ).toThrow(/CHECK constraint failed/)
  })
})
