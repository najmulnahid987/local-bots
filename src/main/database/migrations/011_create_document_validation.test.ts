import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 011: Knowledge Document Preservation Validation Persistence', () => {
  let db: Database.Database
  const v10Migrations = migrations.slice(0, 10)
  const v11Migrations = migrations.slice(0, 11)

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
  // 1. Fresh Database Bootstrap to v11
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Bootstrap to v11', () => {
    it('applies migrations 001 through 011 in sequence on a fresh database', () => {
      const result = runMigrations(db, v11Migrations)

      expect(result.appliedCount).toBe(11)
      expect(result.currentVersion).toBe(11)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

      const status = getMigrationStatus(db, v11Migrations)
      expect(status.currentVersion).toBe(11)
      expect(status.pendingCount).toBe(0)

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('creates knowledge_document_validation table with exact columns and constraints', () => {
      runMigrations(db, v11Migrations)

      const columns = db
        .prepare('PRAGMA table_info(knowledge_document_validation)')
        .all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>

      const colMap = new Map(columns.map((c) => [c.name, c]))
      expect(colMap.get('source_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 })
      expect(colMap.get('schema_version')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('status')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('extraction_status')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('chunk_coverage_status')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('report_json')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('report_hash')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
    })

    it('creates indexes on status and created_at', () => {
      runMigrations(db, v11Migrations)

      const indexes = db
        .prepare('PRAGMA index_list(knowledge_document_validation)')
        .all() as Array<{ name: string; unique: number }>

      const indexNames = indexes.map((i) => i.name)
      expect(indexNames).toContain('idx_knowledge_document_validation_status')
      expect(indexNames).toContain('idx_knowledge_document_validation_created')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Incremental Upgrade from v10 to v11
  // -------------------------------------------------------------------------
  describe('2. Incremental Upgrade from v10 to v11', () => {
    it('upgrades an existing v10 database to v11 cleanly', () => {
      // Step A: Run migrations 1 through 10
      const v10Result = runMigrations(db, v10Migrations)
      expect(v10Result.appliedCount).toBe(10)
      expect(v10Result.currentVersion).toBe(10)

      // Seed data into v10
      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'b2c3d4e5-0000-4000-8000-000000000002'
      const now = Date.now()

      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'test-path', ?, ?)
      `
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'test.txt', 'test.txt', 'test.txt',
          'txt', 'text/plain', 100, '${'b'.repeat(64)}', 'completed',
          ?, ?
        )
      `
      ).run(sourceId, kbId, now, now)

      // Step B: Run migration 11
      const v11Result = runMigrations(db, v11Migrations)
      expect(v11Result.appliedCount).toBe(1)
      expect(v11Result.currentVersion).toBe(11)
      expect(v11Result.appliedVersions).toEqual([11])

      // Verify existing data preserved
      const source = db.prepare('SELECT id FROM knowledge_sources WHERE id = ?').get(sourceId)
      expect(source).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // 3. Foreign Key Cascades & Constraints
  // -------------------------------------------------------------------------
  describe('3. Foreign Key Cascades & Constraints', () => {
    const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
    const sourceId = 'b2c3d4e5-0000-4000-8000-000000000002'
    const validHash = 'a'.repeat(64)
    const validReportJson = JSON.stringify({ status: 'complete', test: true })

    beforeEach(() => {
      runMigrations(db, v11Migrations)
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'test-path', ?, ?)
      `
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'test.txt', 'test.txt', 'test.txt',
          'txt', 'text/plain', 100, '${'b'.repeat(64)}', 'completed',
          ?, ?
        )
      `
      ).run(sourceId, kbId, now, now)
    })

    it('inserts a valid document validation record', () => {
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_document_validation (
          source_id, schema_version, status, extraction_status, chunk_coverage_status,
          report_json, report_hash, created_at, updated_at
        ) VALUES (
          ?, '1.0.0', 'complete', 'complete', 'complete',
          ?, ?, ?, ?
        )
      `
      ).run(sourceId, validReportJson, validHash, now, now)

      const row = db
        .prepare('SELECT * FROM knowledge_document_validation WHERE source_id = ?')
        .get(sourceId) as Record<string, unknown>

      expect(row).toBeDefined()
      expect(row.status).toBe('complete')
      expect(row.extraction_status).toBe('complete')
      expect(row.chunk_coverage_status).toBe('complete')
      expect(row.report_hash).toBe(validHash)
    })

    it('enforces status check constraint', () => {
      const now = Date.now()
      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_document_validation (
            source_id, schema_version, status, extraction_status, chunk_coverage_status,
            report_json, report_hash, created_at, updated_at
          ) VALUES (
            ?, '1.0.0', 'invalid_status', 'complete', 'complete',
            ?, ?, ?, ?
          )
        `
        ).run(sourceId, validReportJson, validHash, now, now)
      }).toThrow(/CHECK constraint failed/)
    })

    it('enforces report_json JSON validity constraint', () => {
      const now = Date.now()
      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_document_validation (
            source_id, schema_version, status, extraction_status, chunk_coverage_status,
            report_json, report_hash, created_at, updated_at
          ) VALUES (
            ?, '1.0.0', 'complete', 'complete', 'complete',
            'not a json', ?, ?, ?
          )
        `
        ).run(sourceId, validHash, now, now)
      }).toThrow(/CHECK constraint failed/)
    })

    it('enforces report_hash 64-character length constraint', () => {
      const now = Date.now()
      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_document_validation (
            source_id, schema_version, status, extraction_status, chunk_coverage_status,
            report_json, report_hash, created_at, updated_at
          ) VALUES (
            ?, '1.0.0', 'complete', 'complete', 'complete',
            ?, 'tooshort', ?, ?
          )
        `
        ).run(sourceId, validReportJson, now, now)
      }).toThrow(/CHECK constraint failed/)
    })

    it('cascades deletion when parent knowledge_source is deleted', () => {
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_document_validation (
          source_id, schema_version, status, extraction_status, chunk_coverage_status,
          report_json, report_hash, created_at, updated_at
        ) VALUES (
          ?, '1.0.0', 'complete', 'complete', 'complete',
          ?, ?, ?, ?
        )
      `
      ).run(sourceId, validReportJson, validHash, now, now)

      expect(
        db.prepare('SELECT count(*) as count FROM knowledge_document_validation').get()
      ).toEqual({ count: 1 })

      // Delete parent source
      db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)

      expect(
        db.prepare('SELECT count(*) as count FROM knowledge_document_validation').get()
      ).toEqual({ count: 0 })
    })

    it('cascades deletion when parent knowledge_base is deleted', () => {
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_document_validation (
          source_id, schema_version, status, extraction_status, chunk_coverage_status,
          report_json, report_hash, created_at, updated_at
        ) VALUES (
          ?, '1.0.0', 'complete', 'complete', 'complete',
          ?, ?, ?, ?
        )
      `
      ).run(sourceId, validReportJson, validHash, now, now)

      // Delete parent KB
      db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kbId)

      expect(
        db.prepare('SELECT count(*) as count FROM knowledge_document_validation').get()
      ).toEqual({ count: 0 })
    })
  })
})
