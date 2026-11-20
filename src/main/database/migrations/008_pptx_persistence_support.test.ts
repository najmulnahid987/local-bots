import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 008: PPTX Persistence Enablement', () => {
  let db: Database.Database
  const v8Migrations = migrations.slice(0, 8)

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
  // 1. Fresh Database Migration to v8
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Migration to v8', () => {
    it('applies migrations 001 through 008 in sequence on a fresh database', () => {
      const result = runMigrations(db, v8Migrations)

      expect(result.appliedCount).toBe(8)
      expect(result.currentVersion).toBe(8)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

      const status = getMigrationStatus(db, v8Migrations)
      expect(status.currentVersion).toBe(8)
      expect(status.pendingCount).toBe(0)

      // foreign_keys must be active and have zero violations
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies knowledge_sources table CHECK constraint permits pptx', () => {
      runMigrations(db, v8Migrations)

      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'kb-path-1', ?, ?)
      `
      ).run(kbId, now, now)

      // Inserting 'pptx' should succeed
      const insertStmt = db.prepare(`
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?
        )
      `)

      const pptxId = 'b1b2c3d4-0000-4000-8000-000000000002'
      expect(() => {
        insertStmt.run(
          pptxId,
          kbId,
          'quarterly_deck.pptx',
          'quarterly_deck.pptx',
          'originals/quarterly_deck.pptx',
          'pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          98765,
          'a'.repeat(64),
          now,
          now
        )
      }).not.toThrow()

      const row = db
        .prepare('SELECT file_type FROM knowledge_sources WHERE id = ?')
        .get(pptxId) as { file_type: string }
      expect(row.file_type).toBe('pptx')
    })

    it('still accepts txt, md, pdf, docx, and xlsx and rejects invalid formats like exe and csv', () => {
      runMigrations(db, v8Migrations)

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
        ],
        [
          'c1b2c3d4-0000-4000-8000-000000000008',
          'pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
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

      // Invalid types (e.g. exe, csv, ppt, pptm) must fail CHECK constraint
      for (const badType of ['exe', 'csv', 'ppt', 'pptm', 'json']) {
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
  // 2. Upgrading Database From Version 7 to Version 8
  // -------------------------------------------------------------------------
  describe('2. Upgrading Database From Version 7 to Version 8', () => {
    it('migrates an existing v7 database with DOCX, XLSX, and PDF sources preserving all data and relationships', () => {
      // 1. Initialize to v7
      const v7Migrations = migrations.slice(0, 7)
      runMigrations(db, v7Migrations)

      const kbId = 'd1b2c3d4-0000-4000-8000-000000000001'
      const docxSourceId = 'd1b2c3d4-0000-4000-8000-000000000002'
      const xlsxSourceId = 'd1b2c3d4-0000-4000-8000-000000000003'
      const pdfSourceId = 'd1b2c3d4-0000-4000-8000-000000000004'
      const chunkId = 'd1b2c3d4-0000-4000-8000-000000000005'
      const now = Date.now()

      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Upgrade Test KB', 'kb-path-upgrade', ?, ?)
      `
      ).run(kbId, now, now)

      // Insert pre-migration sources
      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'spec.docx', 'spec.docx', 'originals/spec.docx',
          'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          65432, '${'d'.repeat(64)}', 'completed', ?, ?
        )
      `
      ).run(docxSourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'metrics.xlsx', 'metrics.xlsx', 'originals/metrics.xlsx',
          'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          12345, '${'e'.repeat(64)}', 'completed', ?, ?
        )
      `
      ).run(xlsxSourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'paper.pdf', 'paper.pdf', 'originals/paper.pdf',
          'pdf', 'application/pdf',
          2048, '${'f'.repeat(64)}', 'completed', ?, ?
        )
      `
      ).run(pdfSourceId, kbId, now, now)

      // Insert child chunk
      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 0, 'Pre-migration XLSX chunk content.', 5, '{"sheet":"Summary"}', ?
        )
      `
      ).run(chunkId, kbId, xlsxSourceId, now)

      // Verify v7 state
      expect(getMigrationStatus(db, v7Migrations).currentVersion).toBe(7)

      // 2. Run Migration 008
      const result = runMigrations(db, v8Migrations)
      expect(result.appliedCount).toBe(1)
      expect(result.currentVersion).toBe(8)
      expect(result.appliedVersions).toEqual([8])

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

      const xlsxRow = db
        .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
        .get(xlsxSourceId) as
        | {
            original_file_name: string
            file_type: string
            file_size: number
            content_hash: string
            indexing_status: string
          }
        | undefined
      expect(xlsxRow).toBeDefined()
      expect(xlsxRow?.original_file_name).toBe('metrics.xlsx')
      expect(xlsxRow?.file_type).toBe('xlsx')
      expect(xlsxRow?.file_size).toBe(12345)

      const pdfRow = db
        .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
        .get(pdfSourceId) as Record<string, unknown>
      expect(pdfRow).toBeDefined()
      expect(pdfRow.file_type).toBe('pdf')
      expect(pdfRow.file_name).toBe('paper.pdf')

      // 4. Verify child chunk references remain intact and linked
      const chunkRow = db
        .prepare('SELECT * FROM knowledge_chunks WHERE id = ?')
        .get(chunkId) as Record<string, unknown>
      expect(chunkRow).toBeDefined()
      expect(chunkRow.source_id).toBe(xlsxSourceId)
      expect(chunkRow.content).toBe('Pre-migration XLSX chunk content.')

      // 5. Verify zero foreign key violations after migration
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('recreates all required indexes on the rebuilt knowledge_sources table', () => {
      runMigrations(db, v8Migrations)

      const indexes = db.prepare('PRAGMA index_list(knowledge_sources)').all() as Array<{
        name: string
      }>
      const indexNames = indexes.map((idx) => idx.name)

      expect(indexNames).toContain('idx_knowledge_sources_kb')
      expect(indexNames).toContain('idx_knowledge_sources_status')
      expect(indexNames).toContain('idx_knowledge_sources_hash')
    })

    it('idempotently does nothing when migration 008 is already applied', () => {
      runMigrations(db, v8Migrations)
      const secondRun = runMigrations(db, v8Migrations)

      expect(secondRun.appliedCount).toBe(0)
      expect(secondRun.currentVersion).toBe(8)
      expect(secondRun.appliedVersions).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity
  // -------------------------------------------------------------------------
  describe('3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity', () => {
    it('verifies foreign keys are enabled before migration and restored after commit', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      const result = runMigrations(db, v8Migrations)
      expect(result.currentVersion).toBe(8)

      // Post-migration: foreign keys must remain enabled and valid
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('rolls back completely if a statement in migration 008 fails', () => {
      // Apply migrations 1 through 7
      runMigrations(db, migrations.slice(0, 7))
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      const kbId = 'e1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'Rollback KB', 'p', ?, ?)`
      ).run(kbId, now, now)

      // Insert pre-existing row
      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (
          'e1b2c3d4-0000-4000-8000-000000000002', ?, 'existing.xlsx', 'existing.xlsx', 'p/xlsx',
          'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 50, '${'c'.repeat(64)}', 'completed', ?, ?
        )
      `
      ).run(kbId, now, now)

      // Construct failing migration
      const failingMigration = {
        version: 8,
        name: 'failing_migration',
        sql: `
          CREATE TABLE knowledge_sources_new AS SELECT * FROM knowledge_sources;
          INSERT INTO non_existent_table VALUES (1);
        `,
        disableForeignKeysForTableRebuild: true
      }

      expect(() => {
        runMigrations(db, [...migrations.slice(0, 7), failingMigration])
      }).toThrow()

      // FK pragma restored
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Version remains 7
      const status = getMigrationStatus(db, migrations.slice(0, 7))
      expect(status.currentVersion).toBe(7)
    })

    it('verifies parent-child CASCADE deletion works on rebuilt knowledge_sources table with pptx source', () => {
      runMigrations(db, v8Migrations)
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
        ) VALUES (?, ?, 'deck.pptx', 'deck.pptx', 'originals/deck.pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 100, '${'e'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'PPTX slide chunk content.', 5, '{"slideNumber":1,"slideTitle":"Agenda"}', ?)
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
      runMigrations(db, v8Migrations)
      const kbId = 'g1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'g1b2c3d4-0000-4000-8000-000000000002'
      const chunkId = 'g1b2c3d4-0000-4000-8000-000000000003'
      const now = Date.now()

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'FTS KB', 'p', ?, ?)`
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'strategy.pptx', 'strategy.pptx', 'originals/strategy.pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 100, '${'f'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      // Insert chunk - trigger should populate knowledge_fts
      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'Antigravity presentation slide highlighting quantum propulsion.', 8, '{"slideNumber":2}', ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      // Query FTS5
      const searchResults = db
        .prepare(
          `
        SELECT c.id, c.content
        FROM knowledge_chunks c
        JOIN knowledge_fts fts ON fts.rowid = c.rowid
        WHERE knowledge_fts MATCH 'propulsion'
      `
        )
        .all() as { id: string; content: string }[]

      expect(searchResults.length).toBe(1)
      expect(searchResults[0].id).toBe(chunkId)
      expect(searchResults[0].content).toContain('quantum propulsion')

      // Deleting chunk cascades to FTS
      db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkId)
      const emptyResults = db
        .prepare(
          `
        SELECT c.id
        FROM knowledge_chunks c
        JOIN knowledge_fts fts ON fts.rowid = c.rowid
        WHERE knowledge_fts MATCH 'propulsion'
      `
        )
        .all()

      expect(emptyResults.length).toBe(0)
    })
  })
})
