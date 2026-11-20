import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 010: CSV Persistence Enablement', () => {
  let db: Database.Database
  const v10Migrations = migrations.slice(0, 10)

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
  // 1. Fresh Database Migration to v10
  // -------------------------------------------------------------------------
  describe('1. Fresh Database Migration to v10', () => {
    it('applies migrations 001 through 010 in sequence on a fresh database', () => {
      const result = runMigrations(db, v10Migrations)

      expect(result.appliedCount).toBe(10)
      expect(result.currentVersion).toBe(10)
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

      const status = getMigrationStatus(db, v10Migrations)
      expect(status.currentVersion).toBe(10)
      expect(status.pendingCount).toBe(0)

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })

    it('verifies knowledge_sources table CHECK constraint permits csv and all previous formats', () => {
      runMigrations(db, v10Migrations)

      const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Test KB', 'kb-path-1', ?, ?)
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

      const validFormats = ['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx', 'csv'] as const
      for (let i = 0; i < validFormats.length; i++) {
        const fmt = validFormats[i]
        const sourceId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
        expect(() => {
          insertStmt.run(
            sourceId,
            kbId,
            `file.${fmt}`,
            `file.${fmt}`,
            `originals/file.${fmt}`,
            fmt,
            'application/octet-stream',
            100,
            'b'.repeat(64),
            now,
            now
          )
        }).not.toThrow()
      }

      // Rejects invalid formats
      const invalidFormats = ['exe', 'dll', 'sh', 'zip', 'tar', 'unknown']
      for (let i = 0; i < invalidFormats.length; i++) {
        const badFmt = invalidFormats[i]
        const badId = `bad00000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
        expect(() => {
          insertStmt.run(
            badId,
            kbId,
            `file.${badFmt}`,
            `file.${badFmt}`,
            `originals/file.${badFmt}`,
            badFmt,
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
  // 2. Real Populated Migration 001-009 Upgrade Verification (15 Acceptance Steps)
  // -------------------------------------------------------------------------
  describe('2. Real Populated Migration 001-009 Upgrade Verification', () => {
    it('executes the 15-step data preservation and schema integrity verification', () => {
      // Step 1: Create database and apply actual migrations 001 through 009
      const v9Migrations = migrations.slice(0, 9)
      const v9Result = runMigrations(db, v9Migrations)
      expect(v9Result.currentVersion).toBe(9)

      // Step 2: Insert representative Knowledge Bases
      const kb1 = 'kb-00000001-4000-8000-000000000001'
      const kb2 = 'kb-00000002-4000-8000-000000000002'
      const now = Date.now()

      const insertKb = db.prepare(`
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      insertKb.run(kb1, 'Engineering Docs', 'kb-path-1', now - 10000, now - 5000)
      insertKb.run(kb2, 'Financial Records', 'kb-path-2', now - 20000, now - 1000)

      // Step 3: Insert multiple source records with every relevant column populated
      const insertSource = db.prepare(`
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          error_message, created_at, updated_at, indexed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)

      const s1 = 'src-00000001-4000-8000-000000000001'
      const s2 = 'src-00000002-4000-8000-000000000002'
      const s3 = 'src-00000003-4000-8000-000000000003'

      insertSource.run(
        s1,
        kb1,
        'spec_v1.docx',
        'System Specification v1.docx',
        'originals/spec_v1.docx',
        'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        1048576,
        '1'.repeat(64),
        'completed',
        null,
        now - 8000,
        now - 2000,
        now - 2000
      )

      insertSource.run(
        s2,
        kb1,
        'failed_upload.pdf',
        'Broken Scan.pdf',
        'originals/failed_upload.pdf',
        'pdf',
        'application/pdf',
        2048,
        '2'.repeat(64),
        'failed',
        'Corrupted PDF catalog dictionary',
        now - 6000,
        now - 1000,
        null
      )

      insertSource.run(
        s3,
        kb2,
        'budget_2026.xlsx',
        'Corporate Budget 2026.xlsx',
        'originals/budget_2026.xlsx',
        'xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        524288,
        '3'.repeat(64),
        'completed',
        null,
        now - 5000,
        now - 500,
        now - 500
      )

      // Step 4: Insert extracted documents (Migration 009)
      const insertExtractedDoc = db.prepare(`
        INSERT INTO knowledge_extracted_documents (
          source_id, schema_version, document_json, document_hash,
          document_size_bytes, block_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const dummyDoc1 = JSON.stringify({
        id: 'doc-1',
        sourceId: s1,
        format: 'docx',
        blocks: [{ type: 'heading', text: 'Overview', heading: { level: 1 } }]
      })
      const dummyDoc3 = JSON.stringify({
        id: 'doc-3',
        sourceId: s3,
        format: 'xlsx',
        blocks: [{ type: 'table', text: 'Sales', isSpreadsheet: true }]
      })

      insertExtractedDoc.run(
        s1,
        1,
        dummyDoc1,
        '4'.repeat(64),
        dummyDoc1.length,
        1,
        now - 2000,
        now - 2000
      )
      insertExtractedDoc.run(
        s3,
        1,
        dummyDoc3,
        '5'.repeat(64),
        dummyDoc3.length,
        1,
        now - 500,
        now - 500
      )

      // Step 5: Insert multiple chunks
      const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, token_count,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const c1 = 'chk-00000001-4000-8000-000000000001'
      const c2 = 'chk-00000002-4000-8000-000000000002'
      const c3 = 'chk-00000003-4000-8000-000000000003'

      insertChunk.run(
        c1,
        kb1,
        s1,
        0,
        'System architecture overview with high availability',
        12,
        '{"section":"intro"}',
        now - 2000
      )
      insertChunk.run(
        c2,
        kb1,
        s1,
        1,
        'Database failover protocol and replication mechanics',
        10,
        '{"section":"db"}',
        now - 2000
      )
      insertChunk.run(
        c3,
        kb2,
        s3,
        0,
        'Q3 revenue projection and expenditure analysis',
        11,
        '{"sheet":"Financials"}',
        now - 500
      )

      // Step 6: Verify FTS5 entries exist prior to migration 010
      const preFtsMatches = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM knowledge_fts WHERE knowledge_fts MATCH 'architecture'
      `
        )
        .get() as { count: number }
      expect(preFtsMatches.count).toBe(1)

      // Step 7: Record full source rows and child-row counts before migration
      const preSources = db.prepare('SELECT * FROM knowledge_sources ORDER BY id ASC').all()
      const preExtractedDocsCount = (
        db.prepare('SELECT COUNT(*) as count FROM knowledge_extracted_documents').get() as {
          count: number
        }
      ).count
      const preChunksCount = (
        db.prepare('SELECT COUNT(*) as count FROM knowledge_chunks').get() as { count: number }
      ).count

      expect(preSources.length).toBe(3)
      expect(preExtractedDocsCount).toBe(2)
      expect(preChunksCount).toBe(3)

      // Step 8: Run Migration 010
      const migrationResult = runMigrations(db, v10Migrations)
      expect(migrationResult.appliedCount).toBe(1)
      expect(migrationResult.currentVersion).toBe(10)

      // Step 9: Compare all previous source values exactly
      const postSources = db.prepare('SELECT * FROM knowledge_sources ORDER BY id ASC').all()
      expect(postSources).toEqual(preSources)

      // Step 10: Verify extracted documents remain intact
      const postExtractedDocs = db
        .prepare('SELECT * FROM knowledge_extracted_documents ORDER BY source_id ASC')
        .all() as Array<{ source_id: string; document_json: string }>
      expect(postExtractedDocs.length).toBe(2)
      expect(postExtractedDocs[0].source_id).toBe(s1)
      expect(postExtractedDocs[0].document_json).toBe(dummyDoc1)
      expect(postExtractedDocs[1].source_id).toBe(s3)
      expect(postExtractedDocs[1].document_json).toBe(dummyDoc3)

      // Step 11: Verify chunk values and metadata remain intact
      const postChunks = db
        .prepare('SELECT * FROM knowledge_chunks ORDER BY id ASC')
        .all() as Array<{ id: string; content: string; metadata_json: string }>
      expect(postChunks.length).toBe(3)
      expect(postChunks[0].content).toBe('System architecture overview with high availability')
      expect(postChunks[1].content).toBe('Database failover protocol and replication mechanics')
      expect(postChunks[2].content).toBe('Q3 revenue projection and expenditure analysis')

      // Step 12: Verify FTS5 search still returns expected content after migration
      const postFtsArch = db
        .prepare(
          `
        SELECT c.id FROM knowledge_fts f JOIN knowledge_chunks c ON c.id = f.chunk_id WHERE knowledge_fts MATCH 'architecture'
      `
        )
        .all()
      expect(postFtsArch.length).toBe(1)

      const postFtsRevenue = db
        .prepare(
          `
        SELECT c.id FROM knowledge_fts f JOIN knowledge_chunks c ON c.id = f.chunk_id WHERE knowledge_fts MATCH 'revenue'
      `
        )
        .all()
      expect(postFtsRevenue.length).toBe(1)

      // Step 13: Verify source and Knowledge Base ownership remains correct
      const s3Row = db
        .prepare('SELECT knowledge_base_id FROM knowledge_sources WHERE id = ?')
        .get(s3) as { knowledge_base_id: string }
      expect(s3Row.knowledge_base_id).toBe(kb2)

      // Step 14: Verify cascade deletion continues to function
      db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kb1)

      // Sources belonging to kb1 must be deleted
      const remainingSourcesKb1 = db
        .prepare('SELECT COUNT(*) as count FROM knowledge_sources WHERE knowledge_base_id = ?')
        .get(kb1) as { count: number }
      expect(remainingSourcesKb1.count).toBe(0)

      // Chunks belonging to s1/s2 must cascade
      const remainingChunksKb1 = db
        .prepare('SELECT COUNT(*) as count FROM knowledge_chunks WHERE source_id IN (?, ?)')
        .get(s1, s2) as { count: number }
      expect(remainingChunksKb1.count).toBe(0)

      // Extracted document for s1 must cascade
      const remainingExtractedDocs = db
        .prepare('SELECT COUNT(*) as count FROM knowledge_extracted_documents WHERE source_id = ?')
        .get(s1) as { count: number }
      expect(remainingExtractedDocs.count).toBe(0)

      // kb2 source and chunk must remain intact
      const remainingSourcesKb2 = db
        .prepare('SELECT COUNT(*) as count FROM knowledge_sources WHERE knowledge_base_id = ?')
        .get(kb2) as { count: number }
      expect(remainingSourcesKb2.count).toBe(1)

      // Step 15: Run PRAGMA foreign_key_check and integrity_check
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Transaction & Foreign-Key Ordering Verification
  // -------------------------------------------------------------------------
  describe('3. Transaction & Foreign-Key Ordering Verification', () => {
    it('verifies rollback safety when migration runner encounters an error during table rebuild', () => {
      // Apply migrations 001 through 009
      runMigrations(db, migrations.slice(0, 9))

      const kbId = 'kb-rollback-test-000000000001'
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
        VALUES (?, 'Rollback KB', 'kb-rollback', ?, ?)
      `
      ).run(kbId, now, now)

      db.prepare(
        `
        INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          created_at, updated_at
        ) VALUES (
          'src-rollback-1', ?, 'test.pdf', 'test.pdf', 'originals/test.pdf',
          'pdf', 'application/pdf', 100, '${'f'.repeat(64)}', 'completed', ?, ?
        )
      `
      ).run(kbId, now, now)

      // Construct a malicious/failing migration 010 definition that throws mid-rebuild
      const failingMigration10 = {
        version: 10,
        name: 'failing_table_rebuild',
        disableForeignKeysForTableRebuild: true,
        sql: `
          CREATE TABLE knowledge_sources_new (id TEXT PRIMARY KEY);
          INSERT INTO knowledge_sources_new (id) SELECT id FROM knowledge_sources;
          -- Intentional syntax error to trigger rollback inside transaction
          SYNTAX ERROR INVALID SQL STATEMENT;
        `
      }

      // Execution must fail and throw
      expect(() => {
        runMigrations(db, [...migrations.slice(0, 9), failingMigration10])
      }).toThrow(/syntax error|SYNTAX ERROR/i)

      // Database state must be cleanly rolled back:
      // 1. Current version is still 9
      const status = getMigrationStatus(db, migrations.slice(0, 9))
      expect(status.currentVersion).toBe(9)

      // 2. Original knowledge_sources table is untouched
      const sourceCount = (
        db.prepare('SELECT COUNT(*) as count FROM knowledge_sources').get() as { count: number }
      ).count
      expect(sourceCount).toBe(1)

      // 3. Temporary table does not exist
      const tempTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_sources_new'"
        )
        .get()
      expect(tempTable).toBeUndefined()

      // 4. Foreign keys remain enabled
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  })
})
