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
})
