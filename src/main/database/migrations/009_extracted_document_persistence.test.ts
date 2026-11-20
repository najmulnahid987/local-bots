import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 009: Extracted Document Content Persistence', () => {
  let db: Database.Database
  const v8Migrations = migrations.slice(0, 8)
  const v9Migrations = migrations.slice(0, 9)

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
  // 1. Fresh Database Bootstrap to v9
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Bootstrap to v9', () => {
    it('applies migrations 001 through 009 in sequence on a fresh database', () => {
      const result = runMigrations(db, v9Migrations)

      expect(result.appliedCount).toBe(9)
      expect(result.currentVersion).toBe(9)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])

      const status = getMigrationStatus(db, v9Migrations)
      expect(status.currentVersion).toBe(9)
      expect(status.pendingCount).toBe(0)

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('creates knowledge_extracted_documents table with exact columns and constraints', () => {
      runMigrations(db, v9Migrations)

      const columns = db
        .prepare('PRAGMA table_info(knowledge_extracted_documents)')
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
      expect(colMap.get('schema_version')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('document_json')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('document_hash')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(colMap.get('document_size_bytes')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('block_count')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
      expect(colMap.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })
    })

    it('creates idx_knowledge_extracted_documents_created index', () => {
      runMigrations(db, v9Migrations)

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge_extracted_documents'"
        )
        .all() as Array<{ name: string }>

      const indexNames = indexes.map((i) => i.name)
      expect(indexNames).toContain('idx_knowledge_extracted_documents_created')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Incremental Upgrade from v8 to v9
  // -------------------------------------------------------------------------
  describe('2. Incremental Upgrade from v8 to v9', () => {
    it('migrates an existing v8 database to v9 while preserving existing data', () => {
      // 1. Setup v8 database
      runMigrations(db, v8Migrations)

      const now = Date.now()
      const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const sourceId = 'b1b2c3d4-2222-4000-8000-000000000002'
      const chunkId = 'c1b2c3d4-3333-4000-8000-000000000003'

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'Existing KB', 'kb-path', now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'report.docx', 'report.docx', 'originals/report.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1024, ?, 'completed', ?, ?)
      `
      ).run(sourceId, kbId, 'a'.repeat(64), now, now)

      db.prepare(
        `
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at
        ) VALUES (?, ?, ?, 0, 'Existing chunk text content for FTS search.', 12, ?)
      `
      ).run(chunkId, kbId, sourceId, now)

      // Verify FTS trigger synced existing chunk
      const ftsMatchesBefore = db
        .prepare('SELECT count(*) as c FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .get('chunk') as { c: number }
      expect(ftsMatchesBefore.c).toBe(1)

      // 2. Apply Migration 009
      const upgradeResult = runMigrations(db, v9Migrations)
      expect(upgradeResult.appliedCount).toBe(1)
      expect(upgradeResult.currentVersion).toBe(9)

      // 3. Verify existing data preserved intact
      const sourceRow = db
        .prepare('SELECT id, file_name FROM knowledge_sources WHERE id = ?')
        .get(sourceId) as {
        id: string
        file_name: string
      }
      expect(sourceRow).toBeDefined()
      expect(sourceRow.file_name).toBe('report.docx')

      const chunkRow = db
        .prepare('SELECT id, content FROM knowledge_chunks WHERE id = ?')
        .get(chunkId) as {
        id: string
        content: string
      }
      expect(chunkRow).toBeDefined()
      expect(chunkRow.content).toContain('Existing chunk text')

      // FTS entries still intact
      const ftsMatchesAfter = db
        .prepare('SELECT count(*) as c FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .get('chunk') as { c: number }
      expect(ftsMatchesAfter.c).toBe(1)

      // Foreign keys and integrity remain valid
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Constraints & Cascading Referential Integrity
  // -------------------------------------------------------------------------
  describe('3. Constraints & Cascading Referential Integrity', () => {
    it('enforces foreign key constraint: rejects insertion for non-existent source', () => {
      runMigrations(db, v9Migrations)
      const now = Date.now()

      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_extracted_documents (
            source_id, schema_version, document_json, document_hash,
            document_size_bytes, block_count, created_at, updated_at
          ) VALUES (?, 1, '{"text":"sample"}', ?, 17, 1, ?, ?)
        `
        ).run('00000000-0000-4000-8000-000000000000', 'b'.repeat(64), now, now)
      }).toThrow(/FOREIGN KEY constraint failed/)
    })

    it('enforces JSON validity constraint on document_json', () => {
      runMigrations(db, v9Migrations)
      const now = Date.now()
      const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const sourceId = 'b1b2c3d4-2222-4000-8000-000000000002'

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'KB 1', 'kb-path', now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'file.txt', 'file.txt', 'originals/file.txt', 'txt', 'text/plain', 10, ?, 'completed', ?, ?)
      `
      ).run(sourceId, kbId, 'c'.repeat(64), now, now)

      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_extracted_documents (
            source_id, schema_version, document_json, document_hash,
            document_size_bytes, block_count, created_at, updated_at
          ) VALUES (?, 1, 'not a valid json string {', ?, 25, 1, ?, ?)
        `
        ).run(sourceId, 'd'.repeat(64), now, now)
      }).toThrow(/CHECK constraint failed/)
    })

    it('enforces 64-character hex length constraint on document_hash', () => {
      runMigrations(db, v9Migrations)
      const now = Date.now()
      const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const sourceId = 'b1b2c3d4-2222-4000-8000-000000000002'

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'KB 1', 'kb-path', now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'file.txt', 'file.txt', 'originals/file.txt', 'txt', 'text/plain', 10, ?, 'completed', ?, ?)
      `
      ).run(sourceId, kbId, 'c'.repeat(64), now, now)

      expect(() => {
        db.prepare(
          `
          INSERT INTO knowledge_extracted_documents (
            source_id, schema_version, document_json, document_hash,
            document_size_bytes, block_count, created_at, updated_at
          ) VALUES (?, 1, '{"blocks":[]}', 'too-short', 13, 0, ?, ?)
        `
        ).run(sourceId, now, now)
      }).toThrow(/CHECK constraint failed/)
    })

    it('cascades deletion: deleting a source automatically deletes its extracted document', () => {
      runMigrations(db, v9Migrations)
      const now = Date.now()
      const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const sourceId = 'b1b2c3d4-2222-4000-8000-000000000002'

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'KB 1', 'kb-path', now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'file.txt', 'file.txt', 'originals/file.txt', 'txt', 'text/plain', 10, ?, 'completed', ?, ?)
      `
      ).run(sourceId, kbId, 'c'.repeat(64), now, now)

      db.prepare(
        `
        INSERT INTO knowledge_extracted_documents (
          source_id, schema_version, document_json, document_hash,
          document_size_bytes, block_count, created_at, updated_at
        ) VALUES (?, 1, '{"text":"preserved content"}', ?, 28, 1, ?, ?)
      `
      ).run(sourceId, 'e'.repeat(64), now, now)

      // Verify row exists
      const before = db
        .prepare('SELECT count(*) as c FROM knowledge_extracted_documents WHERE source_id = ?')
        .get(sourceId) as { c: number }
      expect(before.c).toBe(1)

      // Delete the source
      db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)

      // Verify cascade deleted the extracted document
      const after = db
        .prepare('SELECT count(*) as c FROM knowledge_extracted_documents WHERE source_id = ?')
        .get(sourceId) as { c: number }
      expect(after.c).toBe(0)
    })

    it('cascades deletion: deleting a Knowledge Base deletes all associated extracted documents', () => {
      runMigrations(db, v9Migrations)
      const now = Date.now()
      const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
      const sourceId1 = 'b1b2c3d4-2222-4000-8000-000000000001'
      const sourceId2 = 'b1b2c3d4-2222-4000-8000-000000000002'

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'KB 1', 'kb-path', now, now)

      for (const sid of [sourceId1, sourceId2]) {
        db.prepare(
          `
          INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
          ) VALUES (?, ?, 'file.txt', 'file.txt', 'originals/file.txt', 'txt', 'text/plain', 10, ?, 'completed', ?, ?)
        `
        ).run(sid, kbId, 'c'.repeat(64), now, now)

        db.prepare(
          `
          INSERT INTO knowledge_extracted_documents (
            source_id, schema_version, document_json, document_hash,
            document_size_bytes, block_count, created_at, updated_at
          ) VALUES (?, 1, '{"text":"content"}', ?, 18, 1, ?, ?)
        `
        ).run(sid, 'f'.repeat(64), now, now)
      }

      expect(
        (
          db.prepare('SELECT count(*) as c FROM knowledge_extracted_documents').get() as {
            c: number
          }
        ).c
      ).toBe(2)

      // Delete the KB
      db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kbId)

      // All extracted documents must be cascaded
      expect(
        (
          db.prepare('SELECT count(*) as c FROM knowledge_extracted_documents').get() as {
            c: number
          }
        ).c
      ).toBe(0)
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  })
})
