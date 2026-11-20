import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 006: DOCX Persistence Enablement', () => {
  let db: Database.Database
  const v6Migrations = migrations.slice(0, 6)

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
  // 1. Fresh Database Migration to v6
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Migration to v6', () => {
    it('applies migrations 001 through 006 in sequence on a fresh database', () => {
      const result = runMigrations(db, v6Migrations)

      expect(result.appliedCount).toBe(6)
      expect(result.currentVersion).toBe(6)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6])

      const status = getMigrationStatus(db, v6Migrations)
      expect(status.currentVersion).toBe(6)
      expect(status.pendingCount).toBe(0)

      // foreign_keys must be active and have zero violations
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies knowledge_sources table CHECK constraint permits docx', () => {
      runMigrations(db, v6Migrations)

      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'kb-path-1', ?, ?)
      `
      ).run(kbId, now, now)

      // Inserting 'docx' should succeed
      const insertStmt = db.prepare(`
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?
        )
      `)

      const docxId = 'b1b2c3d4-0000-4000-8000-000000000002'
      expect(() => {
        insertStmt.run(
          docxId,
          kbId,
          'manual.docx',
          'manual.docx',
          'originals/manual.docx',
          'docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          12345,
          'a'.repeat(64),
          now,
          now
        )
      }).not.toThrow()

      const row = db
        .prepare('SELECT file_type FROM knowledge_sources WHERE id = ?')
        .get(docxId) as { file_type: string }
      expect(row.file_type).toBe('docx')
    })

    it('still accepts txt, md, and pdf and rejects invalid formats like xlsx', () => {
      runMigrations(db, v6Migrations)

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
        ['c1b2c3d4-0000-4000-8000-000000000005', 'pdf', 'application/pdf']
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

      // Invalid types (e.g. xlsx, pptx, doc) must fail CHECK constraint
      expect(() => {
        insertStmt.run(
          'c1b2c3d4-0000-4000-8000-000000000006',
          kbId,
          'sheet.xlsx',
          'sheet.xlsx',
          'p/xlsx',
          'xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          100,
          'c'.repeat(64),
          now,
          now
        )
      }).toThrow(/CHECK constraint failed/)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Upgrading Database From Version 5 to Version 6
  // -------------------------------------------------------------------------
  describe('2. Upgrading Database From Version 5 to Version 6', () => {
    it('migrates an existing v5 database with sources and chunks preserving all data and relationships', () => {
      // 1. Initialize to v5
      const v5Migrations = migrations.slice(0, 5)
      runMigrations(db, v5Migrations)

      const kbId = 'd1b2c3d4-0000-4000-8000-000000000001'
      const sourceId = 'd1b2c3d4-0000-4000-8000-000000000002'
      const chunkId = 'd1b2c3d4-0000-4000-8000-000000000003'
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
          ?, ?, 'policy.pdf', 'policy.pdf', 'originals/policy.pdf',
          'pdf', 'application/pdf', 54321, ?, 'completed',
          ?, ?
        )
      `
      ).run(sourceId, kbId, 'd'.repeat(64), now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 0, 'Existing confidential policy text content.', 15, '{"heading":"Section 1"}', ?
        )
      `
      ).run(chunkId, kbId, sourceId, now)

      // Verify v5 state
      expect(getMigrationStatus(db, v5Migrations).currentVersion).toBe(5)

      // 2. Run Migration 006
      const result = runMigrations(db, v6Migrations)
      expect(result.appliedCount).toBe(1)
      expect(result.currentVersion).toBe(6)
      expect(result.appliedVersions).toEqual([6])

      // 3. Verify data preservation
      const sourceRow = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(sourceId) as
        | {
            original_file_name: string
            file_type: string
            file_size: number
            content_hash: string
            indexing_status: string
          }
        | undefined
      expect(sourceRow).toBeDefined()
      expect(sourceRow?.original_file_name).toBe('policy.pdf')
      expect(sourceRow?.file_type).toBe('pdf')
      expect(sourceRow?.file_size).toBe(54321)
      expect(sourceRow?.content_hash).toBe('d'.repeat(64))
      expect(sourceRow?.indexing_status).toBe('completed')

      // 4. Verify chunk relationships and FTS
      const chunkRow = db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?').get(chunkId) as
        | {
            source_id: string
            content: string
          }
        | undefined
      expect(chunkRow).toBeDefined()
      expect(chunkRow?.source_id).toBe(sourceId)
      expect(chunkRow?.content).toContain('confidential policy text content')

      const ftsMatches = db
        .prepare(
          `
        SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'confidential'
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

    it('idempotently does nothing when migration 006 is already applied', () => {
      runMigrations(db, v6Migrations)
      const secondRun = runMigrations(db, v6Migrations)

      expect(secondRun.appliedCount).toBe(0)
      expect(secondRun.currentVersion).toBe(6)
      expect(secondRun.appliedVersions).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity
  // -------------------------------------------------------------------------
  describe('3. Foreign-Key Execution Ordering, Rollback, and Cascade Integrity', () => {
    it('verifies foreign keys are enabled before migration and restored after commit', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      const result = runMigrations(db, v6Migrations)
      expect(result.currentVersion).toBe(6)

      // Post-migration: foreign keys must remain enabled and valid
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies foreign keys are restored to active status even when migration rolls back', () => {
      // Apply migrations 1 through 5
      runMigrations(db, migrations.slice(0, 5))
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Create a faulty migration with disableForeignKeysForTableRebuild that throws inside transaction
      const failingMigration = {
        version: 6,
        name: 'failing_table_rebuild',
        sql: `
          CREATE TABLE faulty_sources (id TEXT PRIMARY KEY);
          RAISE ERROR VIA INVALID SYNTAX !!!;
        `,
        disableForeignKeysForTableRebuild: true
      }

      expect(() => {
        runMigrations(db, [...migrations.slice(0, 5), failingMigration])
      }).toThrow()

      // Foreign keys MUST be restored even after catastrophic migration rollback
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Database remains at version 5
      const status = getMigrationStatus(db, migrations.slice(0, 5))
      expect(status.currentVersion).toBe(5)
    })

    it('aborts and rolls back if foreign_key_check detects orphaned rows during rebuild', () => {
      // 1. Setup at version 5 with valid KB, source, and chunk
      runMigrations(db, migrations.slice(0, 5))
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
        ) VALUES (?, ?, 'doc.pdf', 'doc.pdf', 'p/doc.pdf', 'pdf', 'application/pdf', 10, '${'f'.repeat(64)}', 'completed', ?, ?)
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
        version: 6,
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
        runMigrations(db, [...migrations.slice(0, 5), orphanCreatingMigration])
      }).toThrow(/Foreign key integrity check failed after migration 6/)

      // Foreign keys re-enabled and intact
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Verified: rollback restored original knowledge_sources table and data
      const sourceCount = db.prepare('SELECT count(*) as c FROM knowledge_sources').get() as {
        c: number
      }
      expect(sourceCount.c).toBe(1)
    })

    it('verifies parent-child CASCADE deletion works on rebuilt knowledge_sources table', () => {
      runMigrations(db, v6Migrations)
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
        ) VALUES (?, ?, 'spec.docx', 'spec.docx', 'originals/spec.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 100, '${'e'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'DOCX chunk content.', 5, '{}', ?)
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
      runMigrations(db, v6Migrations)
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
        ) VALUES (?, ?, 'doc.docx', 'doc.docx', 'p/doc.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 50, '${'7'.repeat(64)}', 'completed', ?, ?)
      `
      ).run(sourceId, kbId, now, now)

      // Insert chunk triggers trg_knowledge_chunks_ai
      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, 0, 'Synchronized quantum teleportation protocol.', 5, '{}', ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      let fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'teleportation'`)
        .all()
      expect(fts.length).toBe(1)

      // Update chunk triggers trg_knowledge_chunks_au
      db.prepare(
        `UPDATE knowledge_chunks SET content = 'Mutated entanglement protocol.' WHERE id = ?`
      ).run(chunkId)
      fts = db
        .prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'teleportation'`)
        .all()
      expect(fts.length).toBe(0)
      fts = db.prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'entanglement'`).all()
      expect(fts.length).toBe(1)

      // Delete chunk triggers trg_knowledge_chunks_ad
      db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkId)
      fts = db.prepare(`SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'entanglement'`).all()
      expect(fts.length).toBe(0)
    })
  })
})
