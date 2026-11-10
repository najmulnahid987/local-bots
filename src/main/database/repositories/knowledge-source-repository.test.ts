import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { KnowledgeSourceRepository } from './knowledge-source-repository'
import { ValidationError } from './types'

describe('KnowledgeSourceRepository', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let sourceRepo: KnowledgeSourceRepository
  let kbId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    kbRepo = new KnowledgeBaseRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)

    const kb = kbRepo.create({ name: 'Test Knowledge Base' })
    kbId = kb.id
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. creates a valid knowledge source record', () => {
    const sourceId = randomUUID()
    const hash = 'a'.repeat(64)
    const source = sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'test.txt',
      original_file_name: 'test.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1024,
      content_hash: hash,
      indexing_status: 'queued'
    })

    expect(source.id).toBe(sourceId)
    expect(source.knowledge_base_id).toBe(kbId)
    expect(source.file_name).toBe('test.txt')
    expect(source.file_type).toBe('txt')
    expect(source.indexing_status).toBe('queued')
    expect(source.error_message).toBeNull()
    expect(source.created_at).toBeGreaterThan(0)
    expect(source.updated_at).toBeGreaterThanOrEqual(source.created_at)
    expect(source.indexed_at).toBeNull()

    const fetched = sourceRepo.getById(sourceId, kbId)
    expect(fetched).toEqual(source)
  })

  it('2. throws ValidationError on invalid source input', () => {
    expect(() =>
      sourceRepo.create({
        id: 'not-a-uuid',
        knowledge_base_id: kbId,
        file_name: 'bad.txt',
        original_file_name: 'bad.txt',
        relative_file_path: 'originals/bad.txt',
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 100,
        content_hash: 'short-hash'
      })
    ).toThrow(ValidationError)
  })

  it('3. finds sources by checksum with excludeFailed filter', () => {
    const hash = 'b'.repeat(64)
    const s1 = sourceRepo.create({
      id: randomUUID(),
      knowledge_base_id: kbId,
      file_name: 'failed.txt',
      original_file_name: 'failed.txt',
      relative_file_path: 'originals/failed.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 500,
      content_hash: hash,
      indexing_status: 'failed',
      error_message: 'Extraction failed'
    })

    // excludeFailed: true should not find s1
    const notFound = sourceRepo.findByChecksum(kbId, hash, true)
    expect(notFound).toBeNull()

    // excludeFailed: false should find s1
    const found = sourceRepo.findByChecksum(kbId, hash, false)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(s1.id)

    // Create completed source with same hash
    const s2 = sourceRepo.create({
      id: randomUUID(),
      knowledge_base_id: kbId,
      file_name: 'success.txt',
      original_file_name: 'success.txt',
      relative_file_path: 'originals/success.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 500,
      content_hash: hash,
      indexing_status: 'completed'
    })

    const foundSuccess = sourceRepo.findByChecksum(kbId, hash, true)
    expect(foundSuccess).not.toBeNull()
    expect(foundSuccess?.id).toBe(s2.id)
  })

  it('4. updates status and completes source indexing', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'doc.md',
      original_file_name: 'doc.md',
      relative_file_path: `originals/${sourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 2048,
      content_hash: 'c'.repeat(64),
      indexing_status: 'queued'
    })

    sourceRepo.updateStatus(sourceId, kbId, 'processing')
    let current = sourceRepo.getById(sourceId, kbId)
    expect(current?.indexing_status).toBe('processing')

    const now = Date.now()
    sourceRepo.complete(sourceId, kbId, now)
    current = sourceRepo.getById(sourceId, kbId)
    expect(current?.indexing_status).toBe('completed')
    expect(current?.indexed_at).toBe(now)
    expect(current?.error_message).toBeNull()

    // Mark failed with error message
    sourceRepo.updateStatus(sourceId, kbId, 'failed', 'Parser timeout')
    current = sourceRepo.getById(sourceId, kbId)
    expect(current?.indexing_status).toBe('failed')
    expect(current?.error_message).toBe('Parser timeout')
  })

  it('5. inserts chunks and verifies automatic FTS5 synchronization and search', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'guide.txt',
      original_file_name: 'guide.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1500,
      content_hash: 'd'.repeat(64),
      indexing_status: 'processing'
    })

    const chunk1Id = randomUUID()
    const chunk2Id = randomUUID()

    sourceRepo.insertChunks([
      {
        id: chunk1Id,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Antigravity quantum mechanics and relativity principles in physics.',
        page_number: null,
        token_count: 15,
        metadata_json: JSON.stringify({ chunkerVersion: '1.0.0' })
      },
      {
        id: chunk2Id,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 1,
        content: 'Thermodynamics entropy laws and heat transfer fundamentals.',
        page_number: null,
        token_count: 12,
        metadata_json: JSON.stringify({ chunkerVersion: '1.0.0' })
      }
    ])

    const chunks = sourceRepo.getChunksBySourceId(sourceId, kbId)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].chunk_index).toBe(0)
    expect(chunks[1].chunk_index).toBe(1)
    expect(sourceRepo.countChunks(kbId)).toBe(2)

    // FTS5 MATCH search verification
    const searchResults = sourceRepo.searchFts(kbId, 'quantum')
    expect(searchResults).toHaveLength(1)
    expect(searchResults[0].chunk_id).toBe(chunk1Id)
    expect(searchResults[0].content).toContain('Antigravity quantum mechanics')

    const searchEntropy = sourceRepo.searchFts(kbId, 'entropy')
    expect(searchEntropy).toHaveLength(1)
    expect(searchEntropy[0].chunk_id).toBe(chunk2Id)
  })

  it('6. verifies trigger cleanup when chunks or sources are deleted', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'doc.txt',
      original_file_name: 'doc.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'e'.repeat(64),
      indexing_status: 'processing'
    })

    const chunkId = randomUUID()
    sourceRepo.insertChunks([
      {
        id: chunkId,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Confidential corporate strategy roadmap document.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      }
    ])

    // Verify chunk in FTS5
    let matches = sourceRepo.searchFts(kbId, 'confidential')
    expect(matches).toHaveLength(1)

    // Delete chunks directly
    sourceRepo.deleteChunksBySourceId(sourceId, kbId)
    expect(sourceRepo.getChunksBySourceId(sourceId, kbId)).toHaveLength(0)

    // Verify FTS5 entry was deleted by trigger
    matches = sourceRepo.searchFts(kbId, 'confidential')
    expect(matches).toHaveLength(0)

    // Insert another chunk, then delete source and test cascading deletion
    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Another top secret strategy paper.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      }
    ])

    expect(sourceRepo.searchFts(kbId, 'secret')).toHaveLength(1)

    // Delete source
    const deleted = sourceRepo.delete(sourceId, kbId)
    expect(deleted).toBe(true)
    expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
    expect(sourceRepo.getChunksBySourceId(sourceId, kbId)).toHaveLength(0)
    expect(sourceRepo.searchFts(kbId, 'secret')).toHaveLength(0)
  })

  it('7. lists sources scoped to a Knowledge Base', () => {
    const otherKb = kbRepo.create({ name: 'Other KB' })

    sourceRepo.create({
      id: randomUUID(),
      knowledge_base_id: kbId,
      file_name: 'kb1.txt',
      original_file_name: 'kb1.txt',
      relative_file_path: 'originals/kb1.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 10,
      content_hash: '1'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.create({
      id: randomUUID(),
      knowledge_base_id: otherKb.id,
      file_name: 'kb2.txt',
      original_file_name: 'kb2.txt',
      relative_file_path: 'originals/kb2.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 10,
      content_hash: '2'.repeat(64),
      indexing_status: 'completed'
    })

    const kb1Sources = sourceRepo.listByKnowledgeBase(kbId)
    expect(kb1Sources).toHaveLength(1)
    expect(kb1Sources[0].file_name).toBe('kb1.txt')

    const kb2Sources = sourceRepo.listByKnowledgeBase(otherKb.id)
    expect(kb2Sources).toHaveLength(1)
    expect(kb2Sources[0].file_name).toBe('kb2.txt')
  })

  it('8. lists sources with aggregated chunk counts without N+1 queries', () => {
    const s1Id = randomUUID()
    const s2Id = randomUUID()

    sourceRepo.create({
      id: s1Id,
      knowledge_base_id: kbId,
      file_name: 'multi_chunk.txt',
      original_file_name: 'multi_chunk.txt',
      relative_file_path: 'originals/multi_chunk.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 500,
      content_hash: '3'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.create({
      id: s2Id,
      knowledge_base_id: kbId,
      file_name: 'no_chunks.txt',
      original_file_name: 'no_chunks.txt',
      relative_file_path: 'originals/no_chunks.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: '4'.repeat(64),
      indexing_status: 'queued'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbId,
        source_id: s1Id,
        chunk_index: 0,
        content: 'Chunk 1',
        page_number: null,
        token_count: 5,
        metadata_json: '{}'
      },
      {
        id: randomUUID(),
        knowledge_base_id: kbId,
        source_id: s1Id,
        chunk_index: 1,
        content: 'Chunk 2',
        page_number: null,
        token_count: 5,
        metadata_json: '{}'
      }
    ])

    const list = sourceRepo.listWithChunkCounts(kbId)
    expect(list).toHaveLength(2)

    const multi = list.find((s) => s.id === s1Id)
    const zero = list.find((s) => s.id === s2Id)

    expect(multi?.chunk_count).toBe(2)
    expect(zero?.chunk_count).toBe(0)

    // Test getByIdWithChunkCount
    const single = sourceRepo.getByIdWithChunkCount(s1Id, kbId)
    expect(single).not.toBeNull()
    expect(single?.chunk_count).toBe(2)

    // Cross KB check returns null
    const otherKb = kbRepo.create({ name: 'Another KB' })
    const cross = sourceRepo.getByIdWithChunkCount(s1Id, otherKb.id)
    expect(cross).toBeNull()
  })

  it('9. verifies knowledgeBaseExists correctly reports existence', () => {
    expect(sourceRepo.knowledgeBaseExists(kbId)).toBe(true)
    expect(sourceRepo.knowledgeBaseExists(randomUUID())).toBe(false)
  })

  it('10. verifies searchChunks executes scoped BM25 full-text search with metadata and status filtering', () => {
    const completedSourceId = randomUUID()
    const failedSourceId = randomUUID()
    const otherKb = kbRepo.create({ name: 'Foreign Workspace' })
    const foreignSourceId = randomUUID()

    // 1. Completed source in target KB
    sourceRepo.create({
      id: completedSourceId,
      knowledge_base_id: kbId,
      file_name: 'quantum_doc.md',
      original_file_name: 'Quantum Analysis.md',
      relative_file_path: `originals/${completedSourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 2048,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })

    // 2. Failed source in target KB (should be excluded from searchChunks)
    sourceRepo.create({
      id: failedSourceId,
      knowledge_base_id: kbId,
      file_name: 'failed_doc.txt',
      original_file_name: 'Failed.txt',
      relative_file_path: `originals/${failedSourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 500,
      content_hash: 'b'.repeat(64),
      indexing_status: 'failed'
    })

    // 3. Completed source in other KB (should be excluded by KB scoping)
    sourceRepo.create({
      id: foreignSourceId,
      knowledge_base_id: otherKb.id,
      file_name: 'foreign_quantum.txt',
      original_file_name: 'Foreign Quantum.txt',
      relative_file_path: `originals/${foreignSourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1000,
      content_hash: 'c'.repeat(64),
      indexing_status: 'completed'
    })

    const c1Id = randomUUID()
    const c2Id = randomUUID()
    const cFailId = randomUUID()
    const cForeignId = randomUUID()

    // Insert chunks
    sourceRepo.insertChunks([
      // High relevance in target KB (quantum repeated multiple times)
      {
        id: c1Id,
        knowledge_base_id: kbId,
        source_id: completedSourceId,
        chunk_index: 0,
        content:
          'Quantum quantum quantum entanglement principles and quantum teleportation protocols.',
        page_number: null,
        token_count: 20,
        metadata_json: JSON.stringify({
          heading: 'Quantum Teleportation',
          headingLevel: 2,
          chunkerVersion: '1.0.0'
        })
      },
      // Lower relevance in target KB (quantum mentioned once)
      {
        id: c2Id,
        knowledge_base_id: kbId,
        source_id: completedSourceId,
        chunk_index: 1,
        content: 'Classical computing vs quantum computational complexity limits.',
        page_number: null,
        token_count: 15,
        metadata_json: JSON.stringify({
          heading: 'Complexity Limits',
          headingLevel: 2,
          chunkerVersion: '1.0.0'
        })
      },
      // In failed source
      {
        id: cFailId,
        knowledge_base_id: kbId,
        source_id: failedSourceId,
        chunk_index: 0,
        content: 'Quantum processing in failed source.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      },
      // In foreign KB
      {
        id: cForeignId,
        knowledge_base_id: otherKb.id,
        source_id: foreignSourceId,
        chunk_index: 0,
        content: 'Quantum physics in foreign workspace.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      }
    ])

    // Search in target KB
    const results = sourceRepo.searchChunks(kbId, '"quantum"', 10)

    // Verify only completed sources from target KB are returned
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.chunk_id)).toEqual([c1Id, c2Id])

    // Verify BM25 ordering: c1 has more quantum mentions -> more negative score -> first
    expect(results[0].rank_score).toBeLessThan(results[1].rank_score)

    // Verify metadata
    expect(results[0].original_file_name).toBe('Quantum Analysis.md')
    expect(results[0].file_type).toBe('md')
    expect(results[0].chunk_index).toBe(0)
    expect(results[0].match_snippet).toContain('[[HL]]quantum[[/HL]]')

    const meta = JSON.parse(results[0].metadata_json)
    expect(meta.heading).toBe('Quantum Teleportation')
    expect(meta.chunkerVersion).toBe('1.0.0')

    // Verify foreign KB search returns only foreign KB chunks
    const foreignResults = sourceRepo.searchChunks(otherKb.id, '"quantum"', 10)
    expect(foreignResults).toHaveLength(1)
    expect(foreignResults[0].chunk_id).toBe(cForeignId)
    expect(foreignResults[0].knowledge_base_id).toBe(otherKb.id)

    // Verify limit enforcement
    const limitedResults = sourceRepo.searchChunks(kbId, '"quantum"', 1)
    expect(limitedResults).toHaveLength(1)
    expect(limitedResults[0].chunk_id).toBe(c1Id)
  })

  it('11. replaces chunks atomically and updates FTS5 index', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'reindex-test.txt',
      original_file_name: 'reindex-test.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1000,
      content_hash: 'c'.repeat(64),
      indexing_status: 'completed'
    })

    const oldChunkId = randomUUID()
    sourceRepo.insertChunks([
      {
        id: oldChunkId,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Old obsolete content about dinosaurs in prehistory.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      }
    ])

    // Verify old chunk is searchable
    let searchOld = sourceRepo.searchChunks(kbId, '"dinosaurs"', 10)
    expect(searchOld).toHaveLength(1)
    expect(searchOld[0].chunk_id).toBe(oldChunkId)

    // Atomically replace chunks with new content
    const newChunk1Id = randomUUID()
    const newChunk2Id = randomUUID()
    const now = Date.now()
    sourceRepo.replaceChunks(
      sourceId,
      kbId,
      [
        {
          id: newChunk1Id,
          knowledge_base_id: kbId,
          source_id: sourceId,
          chunk_index: 0,
          content: 'Modern aerospace propulsion and rocket dynamics.',
          page_number: null,
          token_count: 12,
          metadata_json: JSON.stringify({ section: 'Aerospace' }),
          created_at: now
        },
        {
          id: newChunk2Id,
          knowledge_base_id: kbId,
          source_id: sourceId,
          chunk_index: 1,
          content: 'Orbital velocity and satellite trajectory calculations.',
          page_number: null,
          token_count: 14,
          metadata_json: JSON.stringify({ section: 'Orbital' }),
          created_at: now
        }
      ],
      now
    )

    // Old content must no longer be found in FTS5
    searchOld = sourceRepo.searchChunks(kbId, '"dinosaurs"', 10)
    expect(searchOld).toHaveLength(0)

    // New content must be found
    const searchAerospace = sourceRepo.searchChunks(kbId, '"aerospace"', 10)
    expect(searchAerospace).toHaveLength(1)
    expect(searchAerospace[0].chunk_id).toBe(newChunk1Id)

    const searchOrbital = sourceRepo.searchChunks(kbId, '"orbital"', 10)
    expect(searchOrbital).toHaveLength(1)
    expect(searchOrbital[0].chunk_id).toBe(newChunk2Id)

    // Source record must reflect updated chunk count and completed status
    const updatedSource = sourceRepo.getByIdWithChunkCount(sourceId, kbId)
    expect(updatedSource).not.toBeNull()
    expect(updatedSource!.chunk_count).toBe(2)
    expect(updatedSource!.indexing_status).toBe('completed')
    expect(updatedSource!.indexed_at).toBe(now)
  })

  it('12. throws error and rolls back when replaceChunks is called with invalid parameters', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'rollback-test.txt',
      original_file_name: 'rollback-test.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1000,
      content_hash: 'd'.repeat(64),
      indexing_status: 'completed'
    })

    const initialChunkId = randomUUID()
    sourceRepo.insertChunks([
      {
        id: initialChunkId,
        knowledge_base_id: kbId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Preserved initial content that should survive failed replace.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      }
    ])

    // Invalid chunk triggers ValidationError and rolls back
    expect(() =>
      sourceRepo.replaceChunks(sourceId, kbId, [
        {
          id: 'invalid-uuid',
          knowledge_base_id: kbId,
          source_id: sourceId,
          chunk_index: 0,
          content: 'Will fail validation',
          page_number: null,
          token_count: 5,
          metadata_json: '{}'
        }
      ])
    ).toThrow(ValidationError)

    // Non-existent sourceId triggers RepositoryError
    expect(() => sourceRepo.replaceChunks(randomUUID(), kbId, [])).toThrow('not found')

    // Initial chunk must still exist intact (transaction rollback succeeded)
    const chunks = sourceRepo.getChunksBySourceId(sourceId, kbId)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].id).toBe(initialChunkId)
  })

  it('13. retrieves bounded document preview for completed documents and excludes uncompleted', () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: 'preview-test.md',
      original_file_name: 'Preview Document.md',
      relative_file_path: `originals/${sourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 2048,
      content_hash: 'e'.repeat(64),
      indexing_status: 'completed'
    })

    const chunkInputs = Array.from({ length: 5 }, (_, i) => ({
      id: randomUUID(),
      knowledge_base_id: kbId,
      source_id: sourceId,
      chunk_index: i,
      content: `Section ${i + 1} content explaining distributed systems consensus.`,
      page_number: null,
      token_count: 12,
      metadata_json: JSON.stringify({
        heading: `Heading ${i + 1}`,
        headingLevel: 2,
        headingPath: ['Architecture', `Heading ${i + 1}`]
      })
    }))

    sourceRepo.insertChunks(chunkInputs)

    // Bounded preview requesting max 3 chunks
    const preview = sourceRepo.getPreview(sourceId, kbId, 3)
    expect(preview).not.toBeNull()
    expect(preview!.sourceId).toBe(sourceId)
    expect(preview!.knowledgeBaseId).toBe(kbId)
    expect(preview!.originalFileName).toBe('Preview Document.md')
    expect(preview!.fileType).toBe('md')
    expect(preview!.totalChunks).toBe(5)
    expect(preview!.chunks).toHaveLength(3)
    expect(preview!.chunks[0].chunkIndex).toBe(0)
    expect(preview!.chunks[0].heading).toBe('Heading 1')
    expect(preview!.chunks[0].headingPath).toEqual(['Architecture', 'Heading 1'])
    expect(preview!.chunks[1].chunkIndex).toBe(1)
    expect(preview!.chunks[2].chunkIndex).toBe(2)

    // Default maxChunks is 3
    const defaultPreview = sourceRepo.getPreview(sourceId, kbId)
    expect(defaultPreview!.chunks).toHaveLength(3)

    // Non-completed documents return null
    const failedSourceId = randomUUID()
    sourceRepo.create({
      id: failedSourceId,
      knowledge_base_id: kbId,
      file_name: 'failed.txt',
      original_file_name: 'failed.txt',
      relative_file_path: `originals/${failedSourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'f'.repeat(64),
      indexing_status: 'failed'
    })
    expect(sourceRepo.getPreview(failedSourceId, kbId)).toBeNull()

    // Cross-KB preview returns null
    const otherKb = kbRepo.create({ name: 'Other KB' })
    expect(sourceRepo.getPreview(sourceId, otherKb.id)).toBeNull()

    // Invalid UUID throws ValidationError
    expect(() => sourceRepo.getPreview('not-uuid', kbId)).toThrow(ValidationError)
  })
})
