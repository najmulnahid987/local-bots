import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 007: XLSX Persistence Enablement', () => {
  let db: Database.Database
  const v7Migrations = migrations.slice(0, 7)

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
  // 1. Fresh Database Migration to v7
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Migration to v7', () => {
    it('applies migrations 001 through 007 in sequence on a fresh database', () => {
      const result = runMigrations(db, v7Migrations)

      expect(result.appliedCount).toBe(7)
      expect(result.currentVersion).toBe(7)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7])

      const status = getMigrationStatus(db, v7Migrations)
      expect(status.currentVersion).toBe(7)
      expect(status.pendingCount).toBe(0)

      // foreign_keys must be active and have zero violations
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies knowledge_sources table CHECK constraint permits xlsx', () => {
      runMigrations(db, v7Migrations)

      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'kb-path-1', ?, ?)
      `
      ).run(kbId, now, now)

      // Inserting 'xlsx' should succeed
      const insertStmt = db.prepare(`
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?
        )
      `)

      const xlsxId = 'b1b2c3d4-0000-4000-8000-000000000002'
      expect(() => {
        insertStmt.run(
          xlsxId,
          kbId,
          'financial_model.xlsx',
          'financial_model.xlsx',
          'originals/financial_model.xlsx',
          'xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          54321,
          'a'.repeat(64),
          now,
          now
        )
      }).not.toThrow()

      const row = db
        .prepare('SELECT file_type FROM knowledge_sources WHERE id = ?')
        .get(xlsxId) as { file_type: string }
      expect(row.file_type).toBe('xlsx')
    })

    it('still accepts txt, md, pdf, and docx and rejects invalid formats like pptx and exe', () => {
      runMigrations(db, v7Migrations)

      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Format Test KB', 'kb-path-2', ?, ?)
      `
      ).run(kbId, now, now)

      const insertStmt = db.prepare(`
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?
        )
      `)

      // Valid types
      for (const [id, ext, mime] of [
        ['c1b2c3d4-0000-4000-8000-000000000003', 'txt', 'text/plain'],
        ['c1b2c3d4-0000-4000-8000-000000000004', 'md', 'text/markdown'],
        ['c1b2c3d4-0000-4000-8000-000000000005', 'pdf', 'application/pdf'],
        [
          'c1b2c3d4-0000-4000-8000-000000000006',
          'docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ],
        [
          'c1b2c3d4-0000-4000-8000-000000000007',
          'xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ]
      ]) {
        expect(() => {
          insertStmt.run(
            id,
            kbId,
            `f.${ext}`,
            `f.${ext}`,
            `p/${ext}`,
            ext,
            mime,
            100,
            'b'.repeat(64),
            now,
            now
          )
        }).not.toThrow()
      }

      // Invalid types (e.g. pptx, exe, csv) must fail CHECK constraint
      for (const badType of ['pptx', 'exe', 'csv', 'xls', 'json']) {
        expect(() => {
          insertStmt.run(
            'c1b2c3d4-0000-4000-8000-000000000099',
            kbId,
            `bad.${badType}`,
            `bad.${badType}`,
            `p/${badType}`,
            badType,
            'application/octet-stream',
            100,
            'c'.repeat(64),
            now,
            now
          )
        }).toThrow(/CHECK constraint failed/)
      }
    })
  })

  // -------------------------------------------------------------------------
  // 2. Upgrading Database From Version 6 to Version 7
  // -------------------------------------------------------------------------
  describe('2. Upgrading Database From Version 6 to Version 7', () => {
    it('migrates an existing v6 database with DOCX and PDF sources preserving all data and relationships', () => {
      // 1. Initialize to v6
      const v6Migrations = migrations.slice(0, 6)
      runMigrations(db, v6Migrations)

      const kbId = 'd1b2c3d4-0000-4000-8000-000000000001'
      const docxSourceId = 'd1b2c3d4-0000-4000-8000-000000000002'
      const pdfSourceId = 'd1b2c3d4-0000-4000-8000-000000000003'
      const chunkId = 'd1b2c3d4-0000-4000-8000-000000000004'
      const now = Date.now()

      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Existing KB', 'kb-path-3', ?, ?)
      `
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'spec.docx', 'spec.docx', 'originals/spec.docx',
          'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 65432, ?, 'completed',
          ?, ?
        )
      `
      ).run(docxSourceId, kbId, 'd'.repeat(64), now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'manual.pdf', 'manual.pdf', 'originals/manual.pdf',
          'pdf', 'application/pdf', 12345, ?, 'completed',
          ?, ?
        )
      `
      ).run(pdfSourceId, kbId, 'e'.repeat(64), now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 0, 'Existing confidential spreadsheet forecasting analysis.', 15, '{"heading":"Section 1"}', ?
        )
      `
      ).run(chunkId, kbId, docxSourceId, now)

      // Verify v6 state
      expect(getMigrationStatus(db, v6Migrations).currentVersion).toBe(6)

      // 2. Run Migration 007
      const result = runMigrations(db, v7Migrations)
      expect(result.appliedCount).toBe(1)
      expect(result.currentVersion).toBe(7)
      expect(result.appliedVersions).toEqual([7])

      // 3. Verify data preservation
      const docxRow = db
        .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
        .get(docxSourceId) as
        | {
            original_file_name: string
            file_type: string
            file_size: number
            content_hash: string
            indexing_status: string
          }
        | undefined
      expect(docxRow).toBeDefined()
      expect(docxRow?.original_file_name).toBe('spec.docx')
      expect(docxRow?.file_type).toBe('docx')
      expect(docxRow?.file_size).toBe(65432)
      expect(docxRow?.content_hash).toBe('d'.repeat(64))
      expect(docxRow?.indexing_status).toBe('completed')

      const pdfRow = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(pdfSourceId) as
        | {
            original_file_name: string
            file_type: string
            file_size: number
          }
        | undefined
      expect(pdfRow).toBeDefined()
      expect(pdfRow?.original_file_name).toBe('manual.pdf')
      expect(pdfRow?.file_type).toBe('pdf')
      expect(pdfRow?.file_size).toBe(12345)

      // 4. Verify chunk relationships and FTS
      const chunkRow = db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?').get(chunkId) as
        | {
            source_id: string
            content: string
          }
        | undefined
      expect(chunkRow).toBeDefined()
      expect(chunkRow?.source_id).toBe(docxSourceId)
      expect(chunkRow?.content).toContain('forecasting analysis')

      const ftsMatches = db
        .prepare(
          `
        SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'forecasting'
      `
        )
        .all()
      expect(ftsMatches.length).toBe(1)

      // 5. Verify zero FK violations
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])

      // 6. Verify indexes are present
      const indexNames = (
        db
          .prepare(
            `
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge_sources'
      `
          )
          .all() as { name: string }[]
      ).map((r) => r.name)

      expect(indexNames).toContain('idx_knowledge_sources_kb')
      expect(indexNames).toContain('idx_knowledge_sources_status')
      expect(indexNames).toContain('idx_knowledge_sources_hash')
    })

    it('idempotently does nothing when migration 007 is already applied', () => {
      runMigrations(db, v7Migrations)
      const secondRun = runMigrations(db, v7Migrations)

      expect(secondRun.appliedCount).toBe(0)
      expect(secondRun.currentVersion).toBe(7)
      expect(secondRun.appliedVersions).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity
  // -------------------------------------------------------------------------
  describe('3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity', () => {
    it('verifies foreign keys are enabled before migration and restored after commit', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      const result = runMigrations(db, v7Migrations)
      expect(result.currentVersion).toBe(7)

      // Post-migration: foreign keys must remain enabled and valid
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies foreign keys are restored to active status even when migration rolls back', () => {
      // Apply migrations 1 through 6
      runMigrations(db, migrations.slice(0, 6))
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Create a faulty migration with disableForeignKeysForTableRebuild that throws inside transaction
      const failingMigration = {
        version: 7,
        name: 'failing_table_rebuild',
        sql: `
          CREATE TABLE faulty_sources (id TEXT PRIMARY KEY);
          RAISE ERROR VIA INVALID SYNTAX !!!;
        `,
        disableForeignKeysForTableRebuild: true
      }

      expect(() => {
        runMigrations(db, [...migrations.slice(0, 6), failingMigration])
      }).toThrow()

      // Foreign keys MUST be restored even after catastrophic migration rollback
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Database remains at version 6
      const status = getMigrationStatus(db, migrations.slice(0, 6))
      expect(status.currentVersion).toBe(6)
    })

    it('aborts and rolls back if foreign_key_check detects orphaned rows during rebuild', () => {
      // 1. Setup at version 6 with valid KB, source, and chunk
      runMigrations(db, migrations.slice(0, 6))
      const kbId = 'e1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'e1b2c3d4-0000-4000-8000-000000000002'
      const chunkId = 'e1b2c3d4-0000-4000-8000-000000000003'
      const now = Date.now()

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'FK Check KB', 'p', ?, ?)`
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'doc.docx', 'doc.docx', 'p/doc.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10, '${'f'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'Chunk content.', 5, '{}', ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      // 2. Migration that rebuilds table but drops existing sources, leaving chunk orphaned
      const orphanCreatingMigration = {
        version: 7,
        name: 'orphan_creating_rebuild',
        sql: `
          CREATE TABLE new_knowledge_sources (
            id TEXT PRIMARY KEY NOT NULL,
            knowledge_base_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            original_file_name TEXT NOT NULL,
            relative_file_path TEXT NOT NULL,
            file_type TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (id, knowledge_base_id)
          );
          -- Purposely omit copying rows, leaving chunks orphaned
          DROP TABLE knowledge_sources;
          ALTER TABLE new_knowledge_sources RENAME TO knowledge_sources;
        `,
        disableForeignKeysForTableRebuild: true
      }

      // Must throw foreign key check error
      expect(() => {
        runMigrations(db, [...migrations.slice(0, 6), orphanCreatingMigration])
      }).toThrow(/Foreign key integrity check failed after migration 7/)

      // Foreign keys re-enabled and intact
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Verified: rollback restored original knowledge_sources table and data
      const sourceCount = db.prepare('SELECT count(*) as c FROM knowledge_sources').get() as {
        c: number
      }
      expect(sourceCount.c).toBe(1)
    })

    it('verifies parent-child CASCADE deletion works on rebuilt knowledge_sources table with xlsx source', () => {
      runMigrations(db, v7Migrations)
      const kbId = 'f1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'f1b2c3d4-0000-4000-8000-000000000002'
      const chunkId = 'f1b2c3d4-0000-4000-8000-000000000003'
      const now = Date.now()

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'Cascade KB', 'p', ?, ?)`
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'budget.xlsx', 'budget.xlsx', 'originals/budget.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, '${'e'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'XLSX sheet chunk content.', 5, '{"sheetName":"Q1"}', ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      // 1. Child chunk exists
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_chunks WHERE id = ?').get(chunkId)
      ).toEqual({ c: 1 })

      // 2. Reject inserting child chunk with invalid source_id
      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_chunks (
            id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
          ) VALUES (?, ?, 'invalid-source-id', 1, 'Bad chunk.', 5, '{}', ?)
        `
        ).run('invalid-chunk-id', kbId, now)
      }).toThrow(/FOREIGN KEY constraint failed/)

      // 3. Deleting parent knowledge_sources row cascades and deletes child chunk
      db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_chunks WHERE id = ?').get(chunkId)
      ).toEqual({ c: 0 })

      // 4. Zero FK violations after cascade
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies FTS5 triggers remain active and synchronize on knowledge_chunks after migration', () => {
      runMigrations(db, v7Migrations)
      const kbId = 'g1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'g1b2c3d4-0000-4000-8000-000000000002'
      const chunkId = 'g1b2c3d4-0000-4000-8000-000000000003'
      const now = Date.now()

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'Trigger KB', 'p', ?, ?)`
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'inventory.xlsx', 'inventory.xlsx', 'p/inventory.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 50, '${'7'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      // Insert chunk triggers trg_knowledge_chunks_ai
      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'Synchronized superconduction spreadsheet inventory.', 5, '{"sheetName":"Stock"}', ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      let fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'superconduction'`)
        .all()
      expect(fts.length).toBe(1)

      // Update chunk triggers trg_knowledge_chunks_au
      db.prepare(
        `UPDATE knowledge_chunks SET content = 'Mutated semiconductor spreadsheet inventory.' WHERE id = ?`
      ).run(chunkId)
      fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'superconduction'`)
        .all()
      expect(fts.length).toBe(0)
      fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'semiconductor'`)
        .all()
      expect(fts.length).toBe(1)

      // Delete chunk triggers trg_knowledge_chunks_ad
      db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkId)
      fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'semiconductor'`)
        .all()
      expect(fts.length).toBe(0)
    })
  })
})
