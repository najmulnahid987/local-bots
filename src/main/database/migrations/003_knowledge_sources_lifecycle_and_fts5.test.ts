import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'
import type { Migration } from './types'

describe('Migration 003: Knowledge Sources Lifecycle and FTS5 Foundation', () => {
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

  // -------------------------------------------------------------------------
  // Part 1: Fresh Database Migration
  // -------------------------------------------------------------------------
  describe('Part 1: Fresh Database Migration', () => {
    it('applies migrations 001, 002, and 003 in sequence on a fresh database', () => {
      const v3Migrations = migrations.slice(0, 3)
      const result = runMigrations(db, v3Migrations)

      expect(result.appliedCount).toBe(3)
      expect(result.currentVersion).toBe(3)
      expect(result.appliedVersions).toEqual([1, 2, 3])

      const status = getMigrationStatus(db, v3Migrations)
      expect(status.currentVersion).toBe(3)
      expect(status.pendingCount).toBe(0)

      // foreign_keys must be active and have zero violations
      const fkPragma = db.pragma('foreign_keys', { simple: true })
      expect(fkPragma).toBe(1)

      const fkCheck = db.pragma('foreign_key_check') as unknown[]
      expect(fkCheck).toEqual([])
    })

    it('creates knowledge_fts virtual table with unindexed metadata columns and porter tokenizer', () => {
      runMigrations(db, migrations)

      // Verify knowledge_fts table exists
      const table = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'"
        )
        .get() as { name: string; sql: string } | undefined

      expect(table).toBeDefined()
      expect(table?.sql).toContain('VIRTUAL TABLE')
      expect(table?.sql).toContain('fts5')
      expect(table?.sql).toContain('chunk_id UNINDEXED')
      expect(table?.sql).toContain('knowledge_base_id UNINDEXED')
      expect(table?.sql).toContain('source_id UNINDEXED')
      expect(table?.sql).toContain("tokenize = 'porter unicode61'")
    })

    it('creates all three FTS synchronization triggers on knowledge_chunks', () => {
      runMigrations(db, migrations)

      const triggers = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_knowledge_chunks_%' ORDER BY name ASC"
        )
        .all() as Array<{ name: string }>

      const triggerNames = triggers.map((t) => t.name)
      expect(triggerNames).toEqual([
        'trg_knowledge_chunks_ad',
        'trg_knowledge_chunks_ai',
        'trg_knowledge_chunks_au'
      ])
    })

    it('creates all performance indexes on knowledge_sources', () => {
      runMigrations(db, migrations)

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge_sources' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
        )
        .all() as Array<{ name: string }>

      const indexNames = indexes.map((i) => i.name)
      expect(indexNames).toContain('idx_knowledge_sources_hash')
      expect(indexNames).toContain('idx_knowledge_sources_kb')
      expect(indexNames).toContain('idx_knowledge_sources_status')
    })
  })

  // -------------------------------------------------------------------------
  // Part 2: Populated v2 Migration & Status Mapping
  // -------------------------------------------------------------------------
  describe('Part 2: Populated v2 Migration & Status Mapping', () => {
    it('safely migrates existing legacy statuses to canonical 5-status lifecycle', () => {
      // Step 1: Run migrations 001 and 002 only
      runMigrations(db, [migrations[0], migrations[1]])
      expect(getMigrationStatus(db, migrations).currentVersion).toBe(2)

      const now = Date.now()
      const kbId = '00000000-0000-4000-8000-000000000001'

      // Insert parent Knowledge Base
      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(kbId, 'Migration Test KB', `documents/${kbId}`, now, now)

      // Insert sources with each legacy status
      const legacyDocs = [
        { id: '10000000-0000-4000-8000-000000000001', name: 'ready.txt', status: 'ready' },
        { id: '10000000-0000-4000-8000-000000000002', name: 'parsing.txt', status: 'parsing' },
        { id: '10000000-0000-4000-8000-000000000003', name: 'indexing.txt', status: 'indexing' },
        { id: '10000000-0000-4000-8000-000000000004', name: 'queued.txt', status: 'queued' },
        { id: '10000000-0000-4000-8000-000000000005', name: 'failed.txt', status: 'failed' }
      ]

      for (const doc of legacyDocs) {
        db.prepare(
          `INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          doc.id,
          kbId,
          doc.name,
          doc.name,
          `documents/${kbId}/${doc.name}`,
          'txt',
          'text/plain',
          1024,
          doc.name.repeat(5).padEnd(64, '0'),
          doc.status,
          now,
          now
        )
      }

      // Insert a chunk for the ready document
      const chunkId = '20000000-0000-4000-8000-000000000001'
      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        chunkId,
        kbId,
        legacyDocs[0].id,
        0,
        'Existing document content prior to migration 003.',
        1,
        10,
        now
      )

      // Step 2: Apply Migration 003
      const migrationResult = runMigrations(db, migrations.slice(0, 3))
      expect(migrationResult.appliedCount).toBe(1)
      expect(migrationResult.currentVersion).toBe(3)

      // Step 3: Verify all rows survived and mapped correctly
      const sources = db
        .prepare('SELECT id, indexing_status FROM knowledge_sources ORDER BY id ASC')
        .all() as Array<{ id: string; indexing_status: string }>

      expect(sources).toHaveLength(5)
      expect(sources.find((s) => s.id === legacyDocs[0].id)?.indexing_status).toBe('completed')
      expect(sources.find((s) => s.id === legacyDocs[1].id)?.indexing_status).toBe('processing')
      expect(sources.find((s) => s.id === legacyDocs[2].id)?.indexing_status).toBe('processing')
      expect(sources.find((s) => s.id === legacyDocs[3].id)?.indexing_status).toBe('queued')
      expect(sources.find((s) => s.id === legacyDocs[4].id)?.indexing_status).toBe('failed')

      // Step 4: Verify chunk survived and was backfilled into FTS5
      const chunk = db
        .prepare('SELECT rowid, id, content FROM knowledge_chunks WHERE id = ?')
        .get(chunkId) as { rowid: number; id: string; content: string }
      expect(chunk).toBeDefined()

      const ftsRow = db
        .prepare(
          'SELECT rowid, content, chunk_id, knowledge_base_id, source_id FROM knowledge_fts WHERE rowid = ?'
        )
        .get(chunk.rowid) as {
        rowid: number
        content: string
        chunk_id: string
        knowledge_base_id: string
        source_id: string
      }
      expect(ftsRow).toBeDefined()
      expect(ftsRow.chunk_id).toBe(chunkId)
      expect(ftsRow.content).toBe('Existing document content prior to migration 003.')
      expect(ftsRow.knowledge_base_id).toBe(kbId)
      expect(ftsRow.source_id).toBe(legacyDocs[0].id)

      // Step 5: Verify foreign key check passes cleanly
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('enforces CHECK constraint to strictly accept only the 5 canonical statuses', () => {
      runMigrations(db, migrations)

      const kbId = '00000000-0000-4000-8000-000000000002'
      const now = Date.now()

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(kbId, 'Status Constraint KB', `documents/${kbId}`, now, now)

      const insertDocWithStatus = (status: string, id: string): void => {
        db.prepare(
          `INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          kbId,
          `${status}.txt`,
          `${status}.txt`,
          `documents/${kbId}/${status}.txt`,
          'txt',
          'text/plain',
          100,
          status.repeat(4).padEnd(64, '0'),
          status,
          now,
          now
        )
      }

      // Canonical statuses must succeed
      const canonicalStatuses = ['queued', 'processing', 'completed', 'failed', 'needs_reindex']
      for (let i = 0; i < canonicalStatuses.length; i++) {
        const id = `30000000-0000-4000-8000-00000000000${i + 1}`
        expect(() => insertDocWithStatus(canonicalStatuses[i], id)).not.toThrow()
      }

      // Legacy and invalid statuses must fail
      const invalidStatuses = [
        'ready',
        'parsing',
        'indexing',
        'in_progress',
        'done',
        'error',
        'pending'
      ]
      for (let i = 0; i < invalidStatuses.length; i++) {
        const id = `40000000-0000-4000-8000-00000000000${i + 1}`
        expect(() => insertDocWithStatus(invalidStatuses[i], id)).toThrow(/CHECK constraint failed/)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Part 3: FTS5 Trigger Synchronization
  // -------------------------------------------------------------------------
  describe('Part 3: FTS5 Trigger Synchronization', () => {
    const kbId = '00000000-0000-4000-8000-000000000010'
    const sourceId = '00000000-0000-4000-8000-000000000011'
    const now = Date.now()

    beforeEach(() => {
      runMigrations(db, migrations)

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(kbId, 'Trigger Test KB', `documents/${kbId}`, now, now)

      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sourceId,
        kbId,
        'doc.txt',
        'doc.txt',
        `documents/${kbId}/doc.txt`,
        'txt',
        'text/plain',
        500,
        '1'.repeat(64),
        'completed',
        now,
        now
      )
    })

    it('automatically inserts into knowledge_fts when a chunk is inserted', () => {
      const chunkId = '50000000-0000-4000-8000-000000000001'

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        chunkId,
        kbId,
        sourceId,
        0,
        'Antigravity architecture and Electron IPC contracts.',
        1,
        15,
        now
      )

      const chunk = db
        .prepare('SELECT rowid, id FROM knowledge_chunks WHERE id = ?')
        .get(chunkId) as { rowid: number; id: string }

      const ftsRow = db
        .prepare(
          'SELECT rowid, content, chunk_id, knowledge_base_id, source_id FROM knowledge_fts WHERE rowid = ?'
        )
        .get(chunk.rowid) as {
        rowid: number
        content: string
        chunk_id: string
        knowledge_base_id: string
        source_id: string
      }

      expect(ftsRow).toBeDefined()
      expect(ftsRow.rowid).toBe(chunk.rowid)
      expect(ftsRow.chunk_id).toBe(chunkId)
      expect(ftsRow.content).toBe('Antigravity architecture and Electron IPC contracts.')
      expect(ftsRow.knowledge_base_id).toBe(kbId)
      expect(ftsRow.source_id).toBe(sourceId)
    })

    it('automatically updates knowledge_fts when chunk content or metadata changes', () => {
      const chunkId = '50000000-0000-4000-8000-000000000002'

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, sourceId, 0, 'Initial draft before replacement.', 1, 10, now)

      const chunk = db.prepare('SELECT rowid FROM knowledge_chunks WHERE id = ?').get(chunkId) as {
        rowid: number
      }

      // Update content
      db.prepare('UPDATE knowledge_chunks SET content = ? WHERE id = ?').run(
        'Updated text content with optimized index terms.',
        chunkId
      )

      const updatedFts = db
        .prepare('SELECT rowid, content, chunk_id FROM knowledge_fts WHERE rowid = ?')
        .get(chunk.rowid) as { rowid: number; content: string; chunk_id: string }

      expect(updatedFts.content).toBe('Updated text content with optimized index terms.')
      expect(updatedFts.chunk_id).toBe(chunkId)

      // Search matching revised content
      const searchHits = db
        .prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'optimized'")
        .all()
      expect(searchHits).toHaveLength(1)

      // Search old content returns nothing
      const oldHits = db
        .prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'replacement'")
        .all()
      expect(oldHits).toHaveLength(0)
    })

    it('automatically deletes from knowledge_fts when chunk is deleted', () => {
      const chunkId = '50000000-0000-4000-8000-000000000003'

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, sourceId, 0, 'Ephemeral chunk to be removed.', 1, 8, now)

      const chunk = db.prepare('SELECT rowid FROM knowledge_chunks WHERE id = ?').get(chunkId) as {
        rowid: number
      }

      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE rowid = ?').get(chunk.rowid)
      ).toEqual({ c: 1 })

      // Delete chunk
      db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkId)

      // Verify FTS row removed
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE rowid = ?').get(chunk.rowid)
      ).toEqual({ c: 0 })
    })

    it('removes FTS rows when parent knowledge_source is deleted via foreign key cascade', () => {
      const chunkId = '50000000-0000-4000-8000-000000000004'

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, sourceId, 0, 'Source cascade chunk content.', 1, 8, now)

      const chunk = db.prepare('SELECT rowid FROM knowledge_chunks WHERE id = ?').get(chunkId) as {
        rowid: number
      }

      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE rowid = ?').get(chunk.rowid)
      ).toEqual({ c: 1 })

      // Delete parent source
      const del = db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)
      expect(del.changes).toBe(1)

      // knowledge_chunks row should be deleted by foreign key cascade
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_chunks WHERE id = ?').get(chunkId)
      ).toEqual({ c: 0 })

      // knowledge_fts row should be deleted by trg_knowledge_chunks_ad trigger
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE rowid = ?').get(chunk.rowid)
      ).toEqual({ c: 0 })
    })

    it('removes FTS rows when parent knowledge_base is deleted via cascade', () => {
      const chunkId = '50000000-0000-4000-8000-000000000005'

      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, sourceId, 0, 'KB cascade chunk content.', 1, 8, now)

      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE knowledge_base_id = ?').get(kbId)
      ).toEqual({ c: 1 })

      // Delete Knowledge Base
      db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kbId)

      // Both chunks and FTS rows should be purged
      expect(
        db
          .prepare('SELECT count(*) as c FROM knowledge_chunks WHERE knowledge_base_id = ?')
          .get(kbId)
      ).toEqual({ c: 0 })
      expect(
        db.prepare('SELECT count(*) as c FROM knowledge_fts WHERE knowledge_base_id = ?').get(kbId)
      ).toEqual({ c: 0 })
    })
  })

  // -------------------------------------------------------------------------
  // Part 4: Rowid Identity Mapping
  // -------------------------------------------------------------------------
  describe('Part 4: Rowid Identity Mapping', () => {
    it('guarantees 1:1 rowid equivalence between knowledge_chunks and knowledge_fts', () => {
      runMigrations(db, migrations)
      const now = Date.now()
      const kbId = '00000000-0000-4000-8000-000000000020'
      const sourceId = '00000000-0000-4000-8000-000000000021'

      db.prepare(
        `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(kbId, 'Rowid KB', `documents/${kbId}`, now, now)

      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sourceId,
        kbId,
        'rowid.txt',
        'rowid.txt',
        `documents/${kbId}/rowid.txt`,
        'txt',
        'text/plain',
        100,
        'r'.repeat(64),
        'completed',
        now,
        now
      )

      // Insert multiple chunks
      const insertChunk = db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content,
          page_number, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )

      for (let i = 1; i <= 10; i++) {
        insertChunk.run(
          `c0000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
          kbId,
          sourceId,
          i - 1,
          `Deterministic paragraph sentence number ${i} regarding indexing invariants.`,
          1,
          10,
          now
        )
      }

      // Check all 10 chunks have exact rowid matching
      const joined = db
        .prepare(
          `SELECT
             c.rowid as chunk_rowid,
             f.rowid as fts_rowid,
             c.id as chunk_id,
             f.chunk_id as fts_chunk_id,
             c.content as chunk_content,
             f.content as fts_content
           FROM knowledge_chunks c
           JOIN knowledge_fts f ON f.rowid = c.rowid
           ORDER BY c.rowid ASC`
        )
        .all() as Array<{
        chunk_rowid: number
        fts_rowid: number
        chunk_id: string
        fts_chunk_id: string
        chunk_content: string
        fts_content: string
      }>

      expect(joined).toHaveLength(10)
      for (const row of joined) {
        expect(row.chunk_rowid).toBe(row.fts_rowid)
        expect(row.chunk_id).toBe(row.fts_chunk_id)
        expect(row.chunk_content).toBe(row.fts_content)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Part 5: Search Isolation, Stemming, and BM25 Ranking
  // -------------------------------------------------------------------------
  describe('Part 5: Search Isolation, Stemming, and BM25 Ranking', () => {
    const kbA = '00000000-0000-4000-8000-0000000000aa'
    const kbB = '00000000-0000-4000-8000-0000000000bb'
    const now = Date.now()

    beforeEach(() => {
      runMigrations(db, migrations)

      // Create KB A and KB B
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbA, 'Workspace Alpha', `documents/${kbA}`, now, now)

      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbB, 'Workspace Beta', `documents/${kbB}`, now, now)

      // Create source for KB A
      db.prepare(
        `INSERT INTO knowledge_sources (id, knowledge_base_id, file_name, original_file_name, relative_file_path, file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'src-a',
        kbA,
        'docA.txt',
        'docA.txt',
        `documents/${kbA}/docA.txt`,
        'txt',
        'text/plain',
        100,
        'a'.repeat(64),
        'completed',
        now,
        now
      )

      // Create source for KB B
      db.prepare(
        `INSERT INTO knowledge_sources (id, knowledge_base_id, file_name, original_file_name, relative_file_path, file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'src-b',
        kbB,
        'docB.txt',
        'docB.txt',
        `documents/${kbB}/docB.txt`,
        'txt',
        'text/plain',
        100,
        'b'.repeat(64),
        'completed',
        now,
        now
      )

      // Insert chunks into KB A
      db.prepare(
        `INSERT INTO knowledge_chunks (id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'chunk-a-1',
        kbA,
        'src-a',
        0,
        'Quantum computing architectures and superconducting qubits in Alpha laboratory.',
        20,
        now
      )

      db.prepare(
        `INSERT INTO knowledge_chunks (id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'chunk-a-2',
        kbA,
        'src-a',
        1,
        'Quantum quantum quantum algorithms and quantum entanglement circuits.',
        25,
        now
      )

      // Insert chunks into KB B
      db.prepare(
        `INSERT INTO knowledge_chunks (id, knowledge_base_id, source_id, chunk_index, content, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'chunk-b-1',
        kbB,
        'src-b',
        0,
        'Quantum computing simulations and decoherence models in Beta laboratory.',
        20,
        now
      )
    })

    it('enforces strict multi-KB search isolation using hard knowledge_base_id filter', () => {
      const searchAlpha = db
        .prepare(
          `SELECT f.chunk_id, f.knowledge_base_id, f.content
           FROM knowledge_fts f
           WHERE f.knowledge_base_id = :authoritative_kb_id
             AND knowledge_fts MATCH :query`
        )
        .all({ authoritative_kb_id: kbA, query: 'quantum' }) as Array<{
        chunk_id: string
        knowledge_base_id: string
        content: string
      }>

      expect(searchAlpha).toHaveLength(2)
      for (const row of searchAlpha) {
        expect(row.knowledge_base_id).toBe(kbA)
      }

      const searchBeta = db
        .prepare(
          `SELECT f.chunk_id, f.knowledge_base_id, f.content
           FROM knowledge_fts f
           WHERE f.knowledge_base_id = :authoritative_kb_id
             AND knowledge_fts MATCH :query`
        )
        .all({ authoritative_kb_id: kbB, query: 'quantum' }) as Array<{
        chunk_id: string
        knowledge_base_id: string
        content: string
      }>

      expect(searchBeta).toHaveLength(1)
      expect(searchBeta[0].chunk_id).toBe('chunk-b-1')
      expect(searchBeta[0].knowledge_base_id).toBe(kbB)
    })

    it('uses Porter stemming to match variations of words', () => {
      // "circuits" -> matches "circuit"
      const matchCircuit = db
        .prepare(
          `SELECT f.chunk_id
           FROM knowledge_fts f
           WHERE f.knowledge_base_id = :kbId
             AND knowledge_fts MATCH 'circuit'`
        )
        .all({ kbId: kbA }) as Array<{ chunk_id: string }>

      expect(matchCircuit).toHaveLength(1)
      expect(matchCircuit[0].chunk_id).toBe('chunk-a-2')

      // "superconducting" -> matches "superconduct"
      const matchSuper = db
        .prepare(
          `SELECT f.chunk_id
           FROM knowledge_fts f
           WHERE f.knowledge_base_id = :kbId
             AND knowledge_fts MATCH 'superconduct'`
        )
        .all({ kbId: kbA }) as Array<{ chunk_id: string }>

      expect(matchSuper).toHaveLength(1)
      expect(matchSuper[0].chunk_id).toBe('chunk-a-1')
    })

    it('ranks results by BM25 relevance score', () => {
      // Chunk A-2 has term "quantum" 4 times; Chunk A-1 has it 1 time
      // FTS5 bm25() returns negative numbers where more negative is higher relevance
      const results = db
        .prepare(
          `SELECT
             f.chunk_id,
             bm25(knowledge_fts) as score
           FROM knowledge_fts f
           WHERE f.knowledge_base_id = :kbId
             AND knowledge_fts MATCH 'quantum'
           ORDER BY bm25(knowledge_fts) ASC`
        )
        .all({ kbId: kbA }) as Array<{ chunk_id: string; score: number }>

      expect(results).toHaveLength(2)
      // chunk-a-2 has higher frequency so its score is lower (more negative in sqlite bm25)
      expect(results[0].chunk_id).toBe('chunk-a-2')
      expect(results[1].chunk_id).toBe('chunk-a-1')
      expect(results[0].score).toBeLessThan(results[1].score)
    })

    it('supports snippet generation with custom highlight delimiters', () => {
      const result = db
        .prepare(
          `SELECT
             snippet(knowledge_fts, 0, '<mark>', '</mark>', '...', 8) as highlighted_snippet
           FROM knowledge_fts
           WHERE knowledge_base_id = :kbId
             AND knowledge_fts MATCH 'entanglement'`
        )
        .get({ kbId: kbA }) as { highlighted_snippet: string }

      expect(result).toBeDefined()
      expect(result.highlighted_snippet).toContain('<mark>entanglement</mark>')
    })
  })

  // -------------------------------------------------------------------------
  // Part 6: Rollback and Foreign Key Preservation
  // -------------------------------------------------------------------------
  describe('Part 6: Rollback and Foreign Key Preservation', () => {
    it('safely rolls back and restores foreign_keys = 1 if migration fails due to FK violation', () => {
      // Run migrations 001 and 002
      runMigrations(db, [migrations[0], migrations[1]])
      expect(getMigrationStatus(db, migrations).currentVersion).toBe(2)

      // Craft an invalid migration that creates a table with an orphaned foreign key
      const brokenMigration: Migration = {
        version: 3,
        name: 'failing_fk_migration',
        disableForeignKeysForTableRebuild: true,
        sql: `
          CREATE TABLE broken_table (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL,
            FOREIGN KEY (parent_id) REFERENCES non_existent_table(id)
          );
          INSERT INTO broken_table (id, parent_id) VALUES ('b1', 'orphan_parent');
        `
      }

      expect(() => runMigrations(db, [migrations[0], migrations[1], brokenMigration])).toThrow(
        /Foreign key integrity check failed/
      )

      // Confirm DB is still at version 2
      expect(
        getMigrationStatus(db, [migrations[0], migrations[1], brokenMigration]).currentVersion
      ).toBe(2)

      // Confirm foreign_keys = 1 was restored by runner finally block
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      // Confirm broken_table was rolled back
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken_table'")
        .get()
      expect(tableExists).toBeUndefined()
    })

    it('preserves existing v2 data intact if Migration 003 encounters an unexpected error', () => {
      // Run migrations 001 and 002
      runMigrations(db, [migrations[0], migrations[1]])

      const now = Date.now()
      const kbId = '00000000-0000-4000-8000-000000000099'
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'Protected KB', `documents/${kbId}`, now, now)

      // Craft failing migration with syntax error
      const badSyntaxMigration: Migration = {
        version: 3,
        name: 'syntax_error',
        sql: 'THIS IS INVALID SQL STATEMENT;'
      }

      expect(() => runMigrations(db, [migrations[0], migrations[1], badSyntaxMigration])).toThrow()

      // DB remains at version 2 and original data intact
      expect(getMigrationStatus(db, migrations).currentVersion).toBe(2)
      const kb = db.prepare('SELECT name FROM knowledge_bases WHERE id = ?').get(kbId) as {
        name: string
      }
      expect(kb.name).toBe('Protected KB')
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })
  })
})
