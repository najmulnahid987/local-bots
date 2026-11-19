import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { KnowledgeBaseRepository } from '../../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { DocumentSearchService } from './document-search-service'

describe('DocumentSearchService (Phase 5 Step 5.9)', () => {
  let tempDir: string
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let sourceRepo: KnowledgeSourceRepository
  let searchService: DocumentSearchService
  let kbAId: string
  let kbBId: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-test-'))
    const dbPath = path.join(tempDir, 'workspace.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    searchService = new DocumentSearchService({ sourceRepository: sourceRepo })

    const kbA = kbRepo.create({ name: 'Alpha Knowledge Base', description: 'Alpha test' })
    const kbB = kbRepo.create({ name: 'Beta Knowledge Base', description: 'Beta test' })
    kbAId = kbA.id
    kbBId = kbB.id
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('1. successfully searches and retrieves matching plain text (.txt) document chunks', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'notes.txt',
      original_file_name: 'Meeting Notes.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1024,
      content_hash: '1'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Antigravity propulsion systems and gravitational wave detection experiments.',
        page_number: null,
        token_count: 15,
        metadata_json: JSON.stringify({ chunkerVersion: '1.0.0' })
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'propulsion'
    })

    expect(results).toHaveLength(1)
    expect(results[0].filename).toBe('Meeting Notes.txt')
    expect(results[0].content).toContain('Antigravity propulsion systems')
    expect(results[0].snippet).toContain('[[HL]]propulsion[[/HL]]')
    expect(results[0].pageNumber).toBeNull()
    expect(results[0].heading).toBeNull()
    expect(results[0].headingLevel).toBeNull()
    expect(results[0].headingPath).toBeNull()
    expect(results[0].chunkerVersion).toBe('1.0.0')
  })

  it('2. preserves Markdown heading, level, and headingPath metadata in search results', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'guide.md',
      original_file_name: 'Architecture Guide.md',
      relative_file_path: `originals/${sourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 2048,
      content_hash: '2'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Local-first architecture requires SQLite FTS5 for offline document indexing.',
        page_number: null,
        token_count: 14,
        metadata_json: JSON.stringify({
          heading: 'Offline Search Engine',
          headingLevel: 2,
          headingPath: ['System Architecture', 'Storage Layer', 'Offline Search Engine'],
          chunkerVersion: '1.0.0'
        })
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'offline indexing'
    })

    expect(results).toHaveLength(1)
    expect(results[0].filename).toBe('Architecture Guide.md')
    expect(results[0].heading).toBe('Offline Search Engine')
    expect(results[0].headingLevel).toBe(2)
    expect(results[0].headingPath).toEqual([
      'System Architecture',
      'Storage Layer',
      'Offline Search Engine'
    ])
    expect(results[0].pageNumber).toBeNull()
  })

  it('3. preserves PDF page numbers and format-specific metadata in search results', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'manual.pdf',
      original_file_name: 'Operator Manual.pdf',
      relative_file_path: `originals/${sourceId}.pdf`,
      file_type: 'pdf',
      mime_type: 'application/pdf',
      file_size: 4096,
      content_hash: '3'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Emergency shutdown procedures for superconducting particle accelerators.',
        page_number: 42,
        token_count: 12,
        metadata_json: JSON.stringify({
          pageNumber: 42,
          chunkerVersion: '1.0.0'
        })
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'accelerators shutdown'
    })

    expect(results).toHaveLength(1)
    expect(results[0].filename).toBe('Operator Manual.pdf')
    expect(results[0].pageNumber).toBe(42)
    expect(results[0].heading).toBeNull()
    expect(results[0].headingPath).toBeNull()
    expect(results[0].chunkerVersion).toBe('1.0.0')
  })

  it('4. ranks results in correct BM25 relevance order (more relevant match first)', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'algorithms.txt',
      original_file_name: 'Algorithms.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 2048,
      content_hash: '4'.repeat(64),
      indexing_status: 'completed'
    })

    const lowRelevanceChunkId = randomUUID()
    const highRelevanceChunkId = randomUUID()

    sourceRepo.insertChunks([
      {
        id: lowRelevanceChunkId,
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'General overview of sorting algorithms and linear data structures.',
        page_number: null,
        token_count: 10,
        metadata_json: '{}'
      },
      {
        id: highRelevanceChunkId,
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 1,
        content:
          'Sorting sorting sorting: quicksort mergesort heapsort radix sorting performance benchmarks.',
        page_number: null,
        token_count: 16,
        metadata_json: '{}'
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'sorting'
    })

    expect(results).toHaveLength(2)
    // High relevance chunk has higher term frequency -> more negative BM25 score -> index 0
    expect(results[0].chunkId).toBe(highRelevanceChunkId)
    expect(results[1].chunkId).toBe(lowRelevanceChunkId)
    expect(results[0].score).toBeLessThan(results[1].score)
  })

  it('5. enforces deterministic secondary ordering for identical BM25 relevance scores', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'identical.txt',
      original_file_name: 'Identical.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1024,
      content_hash: '5'.repeat(64),
      indexing_status: 'completed'
    })

    const chunk0Id = randomUUID()
    const chunk1Id = randomUUID()

    sourceRepo.insertChunks([
      {
        id: chunk0Id,
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content: 'Deterministic test token occurrence alpha.',
        page_number: null,
        token_count: 6,
        metadata_json: '{}'
      },
      {
        id: chunk1Id,
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 1,
        content: 'Deterministic test token occurrence beta.',
        page_number: null,
        token_count: 6,
        metadata_json: '{}'
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'deterministic'
    })

    expect(results).toHaveLength(2)
    // Both chunks have identical BM25 scores; ordered deterministically by chunk_index ASC
    expect(results[0].chunkIndex).toBe(0)
    expect(results[0].chunkId).toBe(chunk0Id)
    expect(results[1].chunkIndex).toBe(1)
    expect(results[1].chunkId).toBe(chunk1Id)
  })

  it('6. strictly enforces Knowledge Base isolation (cross-KB data is unreachable)', async () => {
    const sourceA = randomUUID()
    const sourceB = randomUUID()

    sourceRepo.create({
      id: sourceA,
      knowledge_base_id: kbAId,
      file_name: 'alpha.txt',
      original_file_name: 'Alpha Secret.txt',
      relative_file_path: `originals/${sourceA}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.create({
      id: sourceB,
      knowledge_base_id: kbBId,
      file_name: 'beta.txt',
      original_file_name: 'Beta Secret.txt',
      relative_file_path: `originals/${sourceB}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'b'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceA,
        chunk_index: 0,
        content: 'Top secret proprietary algorithm Alpha.',
        page_number: null,
        token_count: 7,
        metadata_json: '{}'
      },
      {
        id: randomUUID(),
        knowledge_base_id: kbBId,
        source_id: sourceB,
        chunk_index: 0,
        content: 'Top secret proprietary algorithm Beta.',
        page_number: null,
        token_count: 7,
        metadata_json: '{}'
      }
    ])

    // Search in KB A
    const resA = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'secret proprietary'
    })
    expect(resA).toHaveLength(1)
    expect(resA[0].knowledgeBaseId).toBe(kbAId)
    expect(resA[0].content).toContain('algorithm Alpha')

    // Search in KB B
    const resB = await searchService.search({
      knowledgeBaseId: kbBId,
      query: 'secret proprietary'
    })
    expect(resB).toHaveLength(1)
    expect(resB[0].knowledgeBaseId).toBe(kbBId)
    expect(resB[0].content).toContain('algorithm Beta')
  })

  it('7. strictly excludes documents in queued, processing, failed, or needs_reindex states', async () => {
    const statuses = ['queued', 'processing', 'failed', 'needs_reindex'] as const

    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i]
      const srcId = randomUUID()
      sourceRepo.create({
        id: srcId,
        knowledge_base_id: kbAId,
        file_name: `${status}.txt`,
        original_file_name: `${status}.txt`,
        relative_file_path: `originals/${srcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 100,
        content_hash: (i + 1).toString().repeat(64),
        indexing_status: status
      })

      sourceRepo.insertChunks([
        {
          id: randomUUID(),
          knowledge_base_id: kbAId,
          source_id: srcId,
          chunk_index: 0,
          content: `Incomplete document content for status ${status}.`,
          page_number: null,
          token_count: 8,
          metadata_json: '{}'
        }
      ])
    }

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'incomplete document'
    })

    expect(results).toHaveLength(0)
  })

  it('8. respects custom and default result limits', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'multi.txt',
      original_file_name: 'Multi.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 5000,
      content_hash: '8'.repeat(64),
      indexing_status: 'completed'
    })

    const chunks = Array.from({ length: 15 }, (_, i) => ({
      id: randomUUID(),
      knowledge_base_id: kbAId,
      source_id: sourceId,
      chunk_index: i,
      content: `Repeated benchmark keyword item number ${i} in document collection.`,
      page_number: null,
      token_count: 10,
      metadata_json: '{}'
    }))

    sourceRepo.insertChunks(chunks)

    // Default limit should be 10
    const defaultRes = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'benchmark'
    })
    expect(defaultRes).toHaveLength(10)

    // Explicit limit 5
    const limitedRes = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'benchmark',
      limit: 5
    })
    expect(limitedRes).toHaveLength(5)
  })

  it('9. returns empty array when no matches exist or when query sanitizes to empty', async () => {
    const noMatch = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'nonexistenttermxyz123'
    })
    expect(noMatch).toEqual([])

    // Empty tokens like bare operators
    const emptyTokens = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'AND'
    })
    expect(emptyTokens).toEqual([])
  })

  it('10. handles punctuation, quotation marks, parentheses, and special characters safely', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'special.txt',
      original_file_name: 'Special.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1000,
      content_hash: '9'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content:
          'Contact user@example.com for C++ compiler version v1.2.3 and error code (123-456).',
        page_number: null,
        token_count: 15,
        metadata_json: '{}'
      }
    ])

    // Test complex queries with punctuation
    expect(
      (await searchService.search({ knowledgeBaseId: kbAId, query: 'user@example.com' })).length
    ).toBe(1)
    expect((await searchService.search({ knowledgeBaseId: kbAId, query: 'C++' })).length).toBe(1)
    expect((await searchService.search({ knowledgeBaseId: kbAId, query: 'v1.2.3' })).length).toBe(1)
    expect(
      (await searchService.search({ knowledgeBaseId: kbAId, query: '(123-456)' })).length
    ).toBe(1)
    expect(
      (await searchService.search({ knowledgeBaseId: kbAId, query: '"compiler version"' })).length
    ).toBe(1)
    expect((await searchService.search({ knowledgeBaseId: kbAId, query: 'compil*' })).length).toBe(
      1
    )
  })

  it('11. generates safe snippets with [[HL]] delimiters and never emits executable HTML', async () => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbAId,
      file_name: 'xss_test.txt',
      original_file_name: 'XSS Test.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1000,
      content_hash: 'e'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceId,
        chunk_index: 0,
        content:
          'Security alert: <script>alert("payload")</script> tested inside vulnerability report.',
        page_number: null,
        token_count: 15,
        metadata_json: '{}'
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'vulnerability'
    })

    expect(results).toHaveLength(1)
    // Delimiters must be [[HL]]...[[/HL]]
    expect(results[0].snippet).toContain('[[HL]]vulnerability[[/HL]]')
    // Raw script tag in content is preserved as inert text, NOT interpreted as executable HTML
    expect(results[0].snippet).toContain('<script>')
    expect(results[0].snippet).not.toContain('<mark>')
  })

  it('12. rejects non-existent Knowledge Base with KNOWLEDGE_BASE_NOT_FOUND', async () => {
    const nonExistentKb = randomUUID()
    await expect(
      searchService.search({
        knowledgeBaseId: nonExistentKb,
        query: 'quantum'
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_BASE_NOT_FOUND'
    })
  })

  it('13. rejects empty or invalid query payload with VALIDATION_ERROR', async () => {
    await expect(
      searchService.search({
        knowledgeBaseId: kbAId,
        query: ''
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })

    await expect(
      searchService.search({
        knowledgeBaseId: 'not-a-uuid',
        query: 'test'
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
  })

  it('14. successfully searches and returns results for DOCX source chunks with correct fileType and snippets', async () => {
    const docxSourceId = randomUUID()
    sourceRepo.create({
      id: docxSourceId,
      knowledge_base_id: kbAId,
      file_name: 'telemetry_spec.docx',
      original_file_name: 'Telemetry_Specification.docx',
      relative_file_path: `originals/${docxSourceId}.docx`,
      file_type: 'docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      file_size: 15420,
      content_hash: '9'.repeat(64),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: docxSourceId,
        chunk_index: 0,
        content:
          'Autonomous drone telemetry stream transmits synchronized LiDAR navigation vectors.',
        page_number: null,
        token_count: 12,
        metadata_json: JSON.stringify({ heading: 'Navigation Matrix', headingLevel: 1 })
      }
    ])

    const results = await searchService.search({
      knowledgeBaseId: kbAId,
      query: 'drone telemetry LiDAR'
    })

    expect(results).toHaveLength(1)
    expect(results[0].sourceId).toBe(docxSourceId)
    expect(results[0].filename).toBe('Telemetry_Specification.docx')
    expect(results[0].heading).toBe('Navigation Matrix')
    expect(results[0].headingLevel).toBe(1)
    expect(results[0].snippet).toContain('[[HL]]drone[[/HL]]')
    expect(results[0].snippet).toContain('[[HL]]telemetry[[/HL]]')
    expect(results[0].snippet).toContain('[[HL]]LiDAR[[/HL]]')
  })
})
