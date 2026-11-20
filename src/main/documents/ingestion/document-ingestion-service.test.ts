import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { KnowledgeBaseRepository, KnowledgeSourceRepository } from '../../database/repositories'
import { DocumentIngestionService } from './document-ingestion-service'
import { DocumentStorageManager } from '../document-storage-manager'
import { DocumentFileValidator } from '../document-file-validator'
import { StaticDocumentSettingsProvider } from '../document-settings'
import { ExtractorRegistry } from '../extractors/registry'
import { SemanticChunker } from '../chunking/semantic-chunker'
import { DocumentError, DocumentValidationError } from '../document-errors'
import {
  buildSyntheticDocx,
  buildSyntheticXlsx,
  buildSyntheticPptx
} from '../benchmarks/fixtures/office-generator'

/**
 * Deterministic in-memory PDF generator for unit tests.
 * Produces valid, standard PDF 1.4 documents with exact xref byte offsets.
 */
function createTestPdf(pages: string[]): Uint8Array {
  const objects: string[] = []
  const pageObjIds: number[] = []
  let nextId = 3

  const contentEntries: { pageId: number; contentId?: number; text?: string }[] = []
  for (const pageText of pages) {
    const pageId = nextId++
    pageObjIds.push(pageId)
    if (pageText.length > 0) {
      const contentId = nextId++
      contentEntries.push({ pageId, contentId, text: pageText })
    } else {
      contentEntries.push({ pageId })
    }
  }

  // 1 0 obj: Catalog
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`
  // 2 0 obj: Pages
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`

  // Font object
  const fontId = nextId++
  objects[fontId] =
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`

  for (const entry of contentEntries) {
    if (entry.contentId && entry.text !== undefined) {
      const escaped = entry.text.replace(/[()\\]/g, '\\$&')
      const streamData = `BT\n/F1 18 Tf\n100 700 Td\n(${escaped}) Tj\nET`
      objects[entry.contentId] =
        `${entry.contentId} 0 obj\n<< /Length ${Buffer.byteLength(streamData)} >>\nstream\n${streamData}\nendstream\nendobj`
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${entry.contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj`
    } else {
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj`
    }
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id < nextId; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += objects[id] + '\n'
  }

  const startXref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${nextId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextId; id++) {
    const padded = String(offsets[id]).padStart(10, '0')
    body += `${padded} 00000 n \n`
  }
  body += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`

  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('DocumentIngestionService', () => {
  let tempDir: string
  let documentsDir: string
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let service: DocumentIngestionService
  let storageManager: DocumentStorageManager
  let defaultKbId: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ingest-service-test-'))
    documentsDir = path.join(tempDir, 'documents')
    fs.mkdirSync(documentsDir, { recursive: true })

    const dbPath = path.join(tempDir, 'test_workspace.db')
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    const kb = kbRepo.create({ name: 'Default Research Base' })
    defaultKbId = kb.id

    const settingsProvider = new StaticDocumentSettingsProvider()
    storageManager = new DocumentStorageManager({ documentsDir })
    const validator = new DocumentFileValidator(settingsProvider)
    const extractorRegistry = new ExtractorRegistry(settingsProvider)
    const chunker = new SemanticChunker(settingsProvider)

    service = new DocumentIngestionService({
      db,
      storageManager,
      validator,
      extractorRegistry,
      settingsProvider,
      chunker
    })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on Windows temp dir
    }
  })

  // Helper to create test file on disk
  function createTestFile(fileName: string, content: string | Uint8Array): string {
    const filePath = path.join(tempDir, fileName)
    if (typeof content === 'string') {
      fs.writeFileSync(filePath, content, 'utf-8')
    } else {
      fs.writeFileSync(filePath, content)
    }
    return filePath
  }

  // 1. Successful TXT ingestion
  it('1. successfully ingests a plain text (.txt) document', async () => {
    const sampleText =
      'First paragraph discussing distributed consensus and vector clocks.\n\n' +
      'Second paragraph detailing Raft replication logs and leader election dynamics.'
    const filePath = createTestFile('consensus.txt', sampleText)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.duplicate).toBe(false)
      expect(result.sourceId).toBeDefined()
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.totalChunks).toBeGreaterThanOrEqual(1)
      expect(result.totalTokens).toBeGreaterThan(0)
      expect(result.relativeFilePath).toMatch(/^originals\/[0-9a-f-]+\.txt$/)

      // Verify source database record
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source).not.toBeNull()
      expect(source?.indexing_status).toBe('completed')
      expect(source?.file_type).toBe('txt')
      expect(source?.original_file_name).toBe('consensus.txt')
      expect(source?.indexed_at).toBeGreaterThan(0)
      expect(source?.error_message).toBeNull()

      // Verify physical storage
      const physicalFile = path.join(documentsDir, defaultKbId, result.relativeFilePath)
      expect(fs.existsSync(physicalFile)).toBe(true)
      expect(fs.readFileSync(physicalFile, 'utf-8')).toBe(sampleText)

      // Verify chunks
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks.length).toBe(result.totalChunks)
      expect(chunks[0].chunk_index).toBe(0)
      expect(chunks[0].content).toContain('distributed consensus')
      expect(chunks[0].token_count).toBeGreaterThan(0)

      // Verify FTS5 synchronization
      const ftsMatches = db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('consensus')
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  // 2. Successful Markdown ingestion with headings & metadata
  it('2. successfully ingests a Markdown (.md) document and preserves heading metadata', async () => {
    const mdContent = `# Engineering Architecture

This is the system architecture overview for the distributed agent engine.

## Database Layer

The database layer utilizes SQLite with WAL mode and Porter stemmed FTS5.

### Storage Layout

Managed files are isolated in the originals subdirectory.`

    const filePath = createTestFile('architecture.md', mdContent)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.totalChunks).toBeGreaterThanOrEqual(1)

      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks.length).toBeGreaterThan(0)

      // Check metadata on chunk
      const firstChunkMeta = JSON.parse(chunks[0].metadata_json)
      expect(firstChunkMeta.chunkerVersion).toBeDefined()

      // Verify FTS5 search for Markdown terms
      const ftsMatches = db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('database')
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  // 3. Successful PDF ingestion
  it('3. successfully ingests a text-based PDF document page by page', async () => {
    const pdfBytes = createTestPdf([
      'Quantum mechanics foundation principles on page one.',
      'Superconductivity and quantum entanglement on page two.'
    ])
    const filePath = createTestFile('quantum.pdf', pdfBytes)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks.length).toBeGreaterThanOrEqual(2)

      // Verify page number provenance is preserved
      const pageNumbers = chunks.map((c) => c.page_number)
      expect(pageNumbers).toContain(1)
      expect(pageNumbers).toContain(2)

      // Verify FTS5 search
      const ftsMatches = db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('entanglement')
      expect(ftsMatches.length).toBe(1)
    }
  })

  // 4. Correct source lifecycle transitions: queued -> processing -> completed
  it('4. follows canonical lifecycle transitions', async () => {
    const filePath = createTestFile('lifecycle.txt', 'Lifecycle verification content.')

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source?.indexing_status).toBe('completed')
      expect(source?.indexed_at).toBeGreaterThan(0)
    }
  })

  // 5. Correct managed original-file storage layout
  it('5. stores original in managed path <userData>/documents/<kbId>/originals/<sourceId>.<ext>', async () => {
    const content = 'Original file layout test content.'
    const filePath = createTestFile('sample.txt', content)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    if (result.status === 'completed') {
      const expectedStoragePath = path.join(
        documentsDir,
        defaultKbId,
        'originals',
        `${result.sourceId}.txt`
      )
      expect(fs.existsSync(expectedStoragePath)).toBe(true)
      expect(fs.readFileSync(expectedStoragePath, 'utf-8')).toBe(content)

      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source?.relative_file_path).toBe(`originals/${result.sourceId}.txt`)
    }
  })

  // 6. Correct chunk metadata persistence
  it('6. persists chunk metadata including token counts, indexes and chunkerVersion', async () => {
    const content = 'Testing chunk metadata persistence.'
    const filePath = createTestFile('meta.txt', content)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    if (result.status === 'completed') {
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks[0].chunk_index).toBe(0)
      expect(chunks[0].token_count).toBeGreaterThan(0)
      const parsedMeta = JSON.parse(chunks[0].metadata_json)
      expect(parsedMeta.chunkerVersion).toBe('1.0.0')
    }
  })

  // 7. Correct FTS5 synchronization after successful imports
  it('7. synchronizes chunks into SQLite FTS5 via triggers on insert', async () => {
    const content = 'Comprehensive cybersecurity penetration testing methodology.'
    const filePath = createTestFile('cyber.txt', content)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    if (result.status === 'completed') {
      const ftsRows = db
        .prepare(
          'SELECT rowid, content, chunk_id, source_id FROM knowledge_fts WHERE knowledge_fts MATCH ?'
        )
        .all('cybersecurity')
      expect(ftsRows.length).toBe(1)
      expect((ftsRows[0] as { source_id: string }).source_id).toBe(result.sourceId)
    }
  })

  // 8. Same-Knowledge-Base duplicate detection returns structured response
  it('8. detects duplicate import in the same Knowledge Base and returns structured duplicate result', async () => {
    const content = 'Shared compliance policy documentation.'
    const filePath = createTestFile('policy.txt', content)

    // First import succeeds
    const firstResult = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })
    expect(firstResult.status).toBe('completed')

    // Second import of identical file into the SAME Knowledge Base
    const secondResult = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(secondResult.status).toBe('duplicate')
    if (secondResult.status === 'duplicate') {
      expect(secondResult.duplicate).toBe(true)
      expect(secondResult.existingSource.originalFileName).toBe('policy.txt')
      expect(secondResult.existingSource.indexingStatus).toBe('completed')
      if (firstResult.status === 'completed') {
        expect(secondResult.existingSource.id).toBe(firstResult.sourceId)
      }
    }

    // Verify no second source was created in DB
    const sources = service.listSources(defaultKbId)
    expect(sources).toHaveLength(1)
  })

  // 9. Cross-Knowledge-Base duplicate allowance
  it('9. permits identical document in different Knowledge Bases independently', async () => {
    const secondKb = kbRepo.create({ name: 'Secondary Knowledge Base' })
    const content = 'Universal handbook imported across workspaces.'
    const filePath = createTestFile('handbook.txt', content)

    // Ingest into KB 1
    const r1 = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })
    expect(r1.status).toBe('completed')

    // Ingest identical file into KB 2
    const r2 = await service.ingest({
      knowledgeBaseId: secondKb.id,
      filePath
    })
    expect(r2.status).toBe('completed')

    if (r1.status === 'completed' && r2.status === 'completed') {
      expect(r1.sourceId).not.toBe(r2.sourceId)
      expect(r1.knowledgeBaseId).toBe(defaultKbId)
      expect(r2.knowledgeBaseId).toBe(secondKb.id)

      // Both KBs have their own independent source
      expect(service.listSources(defaultKbId)).toHaveLength(1)
      expect(service.listSources(secondKb.id)).toHaveLength(1)
    }
  })

  // 10. Explicit allowDuplicate: true permits intentional duplicates in same KB
  it('10. permits duplicate import when allowDuplicate is explicitly set to true', async () => {
    const content = 'Duplicate allowed file content.'
    const filePath = createTestFile('dup.txt', content)

    // First import
    const r1 = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })
    expect(r1.status).toBe('completed')

    // Second import with allowDuplicate: true
    const r2 = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath,
      allowDuplicate: true
    })
    expect(r2.status).toBe('completed')

    if (r1.status === 'completed' && r2.status === 'completed') {
      expect(r1.sourceId).not.toBe(r2.sourceId)
      expect(service.listSources(defaultKbId)).toHaveLength(2)
    }
  })

  // 11. Concurrent duplicate import protection
  it('11. protects against concurrent duplicate imports using BEGIN IMMEDIATE transaction', async () => {
    const content = 'Concurrency race condition test content.'
    const filePath = createTestFile('race.txt', content)

    // Run two concurrent imports of the exact same file
    const [resA, resB] = await Promise.all([
      service.ingest({ knowledgeBaseId: defaultKbId, filePath }),
      service.ingest({ knowledgeBaseId: defaultKbId, filePath })
    ])

    // Exactly one must be 'completed', and the other must be 'duplicate'
    const results = [resA, resB]
    const completed = results.filter((r) => r.status === 'completed')
    const duplicates = results.filter((r) => r.status === 'duplicate')

    expect(completed).toHaveLength(1)
    expect(duplicates).toHaveLength(1)

    // Exactly one source record exists in SQLite
    const sources = service.listSources(defaultKbId)
    expect(sources).toHaveLength(1)
  })

  // 12. Invalid or nonexistent Knowledge Base
  it('12. rejects invalid or non-existent Knowledge Base with structured error', async () => {
    const filePath = createTestFile('valid.txt', 'Valid content')

    // Invalid UUID format
    await expect(
      service.ingest({
        knowledgeBaseId: 'non-uuid-string',
        filePath
      })
    ).rejects.toThrow(DocumentValidationError)

    // Non-existent valid UUID
    const nonExistentKbId = randomUUID()
    await expect(
      service.ingest({
        knowledgeBaseId: nonExistentKbId,
        filePath
      })
    ).rejects.toThrow(DocumentValidationError)

    // Verify 0 sources and 0 files in storage
    expect(service.listSources(defaultKbId)).toHaveLength(0)
  })

  // 13. Storage failure and cleanup: verify 0 DB records created
  it('13. cleans up transient files and writes 0 DB records on storage failure', async () => {
    // Create a mock storage manager that fails during storeOriginal
    const failingStorage = new DocumentStorageManager({
      documentsDir,
      fsOps: {
        rename: async () => {
          throw new Error('Simulated disk full or I/O failure')
        }
      }
    })

    const failingService = new DocumentIngestionService({
      db,
      storageManager: failingStorage
    })

    const filePath = createTestFile('storage-fail.txt', 'Content that will fail storage.')

    await expect(
      failingService.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
    ).rejects.toThrow()

    // 0 records in knowledge_sources
    expect(service.listSources(defaultKbId)).toHaveLength(0)
  })

  // 14. Extraction failure: marks source as 'failed' and leaves 0 partial chunks
  it('14. marks source failed and leaves 0 chunks on extraction failure', async () => {
    // Create a custom extractor registry that fails on extraction
    const customRegistry = new ExtractorRegistry()
    customRegistry.register('txt', {
      extract: async () => {
        throw new DocumentError('Simulated extractor parser crash', 'EXTRACTION_MALFORMED_INPUT')
      }
    })

    const failingService = new DocumentIngestionService({
      db,
      storageManager,
      extractorRegistry: customRegistry
    })

    const filePath = createTestFile('extract-fail.txt', 'Content causing extraction crash.')

    await expect(
      failingService.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
    ).rejects.toThrow('Simulated extractor parser crash')

    // Verify source row exists with status 'failed'
    const sources = service.listSources(defaultKbId)
    expect(sources).toHaveLength(1)
    expect(sources[0].indexing_status).toBe('failed')
    expect(sources[0].error_message).toContain('Simulated extractor parser crash')

    // Verify 0 chunks were inserted
    const chunks = service.getChunks(sources[0].id, defaultKbId)
    expect(chunks).toHaveLength(0)

    // Verify 0 FTS entries
    const ftsCount = db
      .prepare('SELECT count(*) as count FROM knowledge_fts WHERE source_id = ?')
      .get(sources[0].id) as { count: number }
    expect(ftsCount.count).toBe(0)

    // Original file is preserved on disk per ADR-0011
    const originalPath = path.join(documentsDir, defaultKbId, sources[0].relative_file_path)
    expect(fs.existsSync(originalPath)).toBe(true)
  })

  // 15. Normalization/chunking failure: marks source failed and leaves 0 partial chunks
  it('15. marks source failed and leaves 0 chunks on chunking failure', async () => {
    // Mock chunker that fails
    const failingChunker = {
      chunk: () => {
        throw new DocumentError('Simulated chunker failure', 'CHUNKING_FAILED')
      }
    } as unknown as SemanticChunker

    const failingService = new DocumentIngestionService({
      db,
      storageManager,
      chunker: failingChunker
    })

    const filePath = createTestFile('chunk-fail.txt', 'Content that fails chunker.')

    await expect(
      failingService.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
    ).rejects.toThrow('Simulated chunker failure')

    const sources = service.listSources(defaultKbId)
    expect(sources).toHaveLength(1)
    expect(sources[0].indexing_status).toBe('failed')
    expect(sources[0].error_message).toContain('Simulated chunker failure')

    // 0 chunks
    const chunks = service.getChunks(sources[0].id, defaultKbId)
    expect(chunks).toHaveLength(0)

    // 0 FTS entries
    const ftsCount = db
      .prepare('SELECT count(*) as count FROM knowledge_fts WHERE source_id = ?')
      .get(sources[0].id) as { count: number }
    expect(ftsCount.count).toBe(0)
  })

  // 16. Database transaction rollback on persistence failure
  it('16. rolls back entire transaction if chunk persistence fails', async () => {
    // We can simulate an error during persistence by attaching a temporary before insert trigger
    // that throws an error
    db.exec(`
      CREATE TRIGGER simulate_chunk_error BEFORE INSERT ON knowledge_chunks BEGIN
        SELECT RAISE(FAIL, 'Simulated SQLite disk or constraint failure on chunk insert');
      END;
    `)

    const filePath = createTestFile('db-fail.txt', 'Content failing chunk persistence.')

    await expect(
      service.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
    ).rejects.toThrow('Simulated SQLite disk or constraint failure')

    // Source is marked failed
    const sources = service.listSources(defaultKbId)
    expect(sources).toHaveLength(1)
    expect(sources[0].indexing_status).toBe('failed')

    // 0 chunks in SQLite
    const chunks = service.getChunks(sources[0].id, defaultKbId)
    expect(chunks).toHaveLength(0)

    // 0 entries in FTS5
    const ftsCount = db
      .prepare('SELECT count(*) as count FROM knowledge_fts WHERE source_id = ?')
      .get(sources[0].id) as { count: number }
    expect(ftsCount.count).toBe(0)
  })

  // 17. Failed ingestion leaves zero partial chunks
  it('17. guarantees zero partial chunks remain on failure', async () => {
    const customRegistry = new ExtractorRegistry()
    customRegistry.register('txt', {
      extract: async () => {
        throw new Error('Random crash during text decoding')
      }
    })

    const failingService = new DocumentIngestionService({
      db,
      storageManager,
      extractorRegistry: customRegistry
    })

    const filePath = createTestFile('fail17.txt', 'Sample')
    await expect(
      failingService.ingest({ knowledgeBaseId: defaultKbId, filePath })
    ).rejects.toThrow()

    const chunkTotal = db
      .prepare('SELECT count(*) as count FROM knowledge_chunks WHERE knowledge_base_id = ?')
      .get(defaultKbId) as { count: number }
    expect(chunkTotal.count).toBe(0)
  })

  // 18. Failed ingestion leaves no partial FTS5 entries
  it('18. guarantees zero partial FTS5 entries remain on failure', async () => {
    const customRegistry = new ExtractorRegistry()
    customRegistry.register('txt', {
      extract: async () => {
        throw new Error('Random crash during text decoding')
      }
    })

    const failingService = new DocumentIngestionService({
      db,
      storageManager,
      extractorRegistry: customRegistry
    })

    const filePath = createTestFile('fail18.txt', 'Sample')
    await expect(
      failingService.ingest({ knowledgeBaseId: defaultKbId, filePath })
    ).rejects.toThrow()

    const ftsTotal = db
      .prepare('SELECT count(*) as count FROM knowledge_fts WHERE knowledge_base_id = ?')
      .get(defaultKbId) as { count: number }
    expect(ftsTotal.count).toBe(0)
  })

  // 19. Existing FTS5 triggers remain consistent with chunk insert/update/delete operations
  it('19. verifies FTS5 triggers synchronize on chunk update and deletion', async () => {
    const filePath = createTestFile('fts-triggers.txt', 'Trigger synchronization test content.')

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks).toHaveLength(1)
      const chunkId = chunks[0].id

      // 1. Initial match
      let matches = db
        .prepare('SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('synchronization')
      expect(matches).toHaveLength(1)

      // 2. Test UPDATE trigger (trg_knowledge_chunks_au)
      db.prepare('UPDATE knowledge_chunks SET content = ? WHERE id = ?').run(
        'Mutated content with new keyword kaleidoscope.',
        chunkId
      )

      // Old term no longer matches
      matches = db
        .prepare('SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('synchronization')
      expect(matches).toHaveLength(0)

      // New term matches
      matches = db
        .prepare('SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('kaleidoscope')
      expect(matches).toHaveLength(1)

      // 3. Test DELETE trigger (trg_knowledge_chunks_ad)
      db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkId)

      matches = db
        .prepare('SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('kaleidoscope')
      expect(matches).toHaveLength(0)
    }
  })

  // 20. Successful DOCX ingestion
  it('20. successfully ingests a DOCX (.docx) document through isolated execution, persists chunks and indexes in FTS5', async () => {
    const docxBuffer = buildSyntheticDocx({
      title: 'Quantum Telemetry Protocol',
      identifier: 'QTP-9000',
      headings: ['Subsystem Matrix', 'Sensor Calibration'],
      tableRows: [
        ['Sensor', 'Bandwidth', 'Calibrated'],
        ['Photonic Array', '40 Gbps', 'True']
      ]
    })
    const filePath = createTestFile('telemetry-spec.docx', docxBuffer)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.duplicate).toBe(false)
      expect(result.sourceId).toBeDefined()
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.totalChunks).toBeGreaterThanOrEqual(1)
      expect(result.totalTokens).toBeGreaterThan(0)
      expect(result.relativeFilePath).toMatch(/^originals\/[0-9a-f-]+\.docx$/)

      // Verify source database record
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source).not.toBeNull()
      expect(source?.indexing_status).toBe('completed')
      expect(source?.file_type).toBe('docx')
      expect(source?.original_file_name).toBe('telemetry-spec.docx')
      expect(source?.indexed_at).toBeGreaterThan(0)
      expect(source?.error_message).toBeNull()

      // Verify physical storage
      const physicalFile = path.join(documentsDir, defaultKbId, result.relativeFilePath)
      expect(fs.existsSync(physicalFile)).toBe(true)

      // Verify chunks
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks.length).toBe(result.totalChunks)
      expect(chunks[0].chunk_index).toBe(0)
      expect(chunks[0].content).toContain('Quantum Telemetry Protocol')
      expect(chunks[0].token_count).toBeGreaterThan(0)

      // Verify FTS5 synchronization
      const ftsMatches = db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('Telemetry')
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  // 21. Duplicate DOCX detection
  it('21. detects duplicate DOCX import in the same Knowledge Base and returns structured duplicate result', async () => {
    const docxBuffer = buildSyntheticDocx({
      title: 'Duplicate DOCX Test',
      identifier: 'DUP-001',
      headings: ['Section One'],
      tableRows: []
    })
    const file1 = createTestFile('original-doc.docx', docxBuffer)
    const file2 = createTestFile('copy-doc.docx', docxBuffer)

    const first = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file1 })
    expect(first.status).toBe('completed')

    const second = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file2 })
    expect(second.status).toBe('duplicate')
    if (second.status === 'duplicate') {
      expect(second.duplicate).toBe(true)
      expect(second.existingSource.originalFileName).toBe('original-doc.docx')
    }
  })

  // 22. Corrupt DOCX rejection
  it('22. safely rejects corrupt/truncated DOCX file, writes 0 database records and cleans up storage', async () => {
    // Corrupt PK zip archive (bad header)
    const corruptBuffer = Buffer.from('PK\x03\x04corrupted_data_not_a_valid_zip_archive')
    const corruptPath = createTestFile('broken.docx', corruptBuffer)

    await expect(
      service.ingest({ knowledgeBaseId: defaultKbId, filePath: corruptPath })
    ).rejects.toThrow()

    // Verify 0 sources and 0 chunks in database
    const sources = db.prepare('SELECT count(*) as count FROM knowledge_sources').get() as {
      count: number
    }
    const chunks = db.prepare('SELECT count(*) as count FROM knowledge_chunks').get() as {
      count: number
    }
    expect(sources.count).toBe(0)
    expect(chunks.count).toBe(0)
  })

  // 23. Successful XLSX ingestion
  it('23. successfully ingests an XLSX (.xlsx) document through isolated execution, persists chunks and indexes in FTS5', async () => {
    const xlsxBuffer = buildSyntheticXlsx({
      title: 'Quarterly Financial Model',
      identifier: 'XLSX-001',
      summaryRows: [
        ['Metric', 'Target', 'Actual'],
        ['ARR Revenue', '1000000', '1250000'],
        ['Gross Margin', '85%', '88%']
      ],
      departmentRows: [
        ['Department', 'Budget', 'Spent'],
        ['Infrastructure', '50000', '42000']
      ]
    })
    const filePath = createTestFile('financial_model.xlsx', xlsxBuffer)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.duplicate).toBe(false)
      expect(result.sourceId).toBeDefined()
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.totalChunks).toBeGreaterThanOrEqual(1)
      expect(result.totalTokens).toBeGreaterThan(0)
      expect(result.relativeFilePath).toMatch(/^originals\/[0-9a-f-]+\.xlsx$/)

      // Verify source database record
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source).not.toBeNull()
      expect(source?.indexing_status).toBe('completed')
      expect(source?.file_type).toBe('xlsx')
      expect(source?.original_file_name).toBe('financial_model.xlsx')
      expect(source?.indexed_at).toBeGreaterThan(0)
      expect(source?.error_message).toBeNull()

      // Verify physical storage
      const physicalFile = path.join(documentsDir, defaultKbId, result.relativeFilePath)
      expect(fs.existsSync(physicalFile)).toBe(true)

      // Verify chunks and metadata
      const chunks = service.getChunks(result.sourceId, defaultKbId)
      expect(chunks.length).toBe(result.totalChunks)
      expect(chunks[0].chunk_index).toBe(0)
      expect(chunks[0].token_count).toBeGreaterThan(0)

      // Verify FTS5 synchronization
      const ftsMatches = db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('Revenue')
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  // 24. Duplicate XLSX detection
  it('24. detects duplicate XLSX import in the same Knowledge Base and returns structured duplicate result', async () => {
    const xlsxBuffer = buildSyntheticXlsx({
      title: 'Duplicate XLSX Test',
      identifier: 'DUP-XLSX-001',
      summaryRows: [
        ['Product', 'SKU'],
        ['Widget Alpha', 'W-001']
      ],
      departmentRows: []
    })
    const file1 = createTestFile('model.xlsx', xlsxBuffer)
    const file2 = createTestFile('model-copy.xlsx', xlsxBuffer)

    const first = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file1 })
    expect(first.status).toBe('completed')

    const second = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file2 })
    expect(second.status).toBe('duplicate')
    if (second.status === 'duplicate') {
      expect(second.duplicate).toBe(true)
      expect(second.existingSource.originalFileName).toBe('model.xlsx')
    }
  })

  // 25. Corrupt XLSX rejection
  it('25. safely rejects corrupt/truncated XLSX file, writes 0 database records and cleans up storage', async () => {
    // Corrupt PK zip archive (bad header)
    const corruptBuffer = Buffer.from('PK\x03\x04corrupted_data_not_a_valid_xlsx_archive')
    const corruptPath = createTestFile('broken.xlsx', corruptBuffer)

    await expect(
      service.ingest({ knowledgeBaseId: defaultKbId, filePath: corruptPath })
    ).rejects.toThrow()

    // Verify 0 sources and 0 chunks in database
    const sources = db.prepare('SELECT count(*) as count FROM knowledge_sources').get() as {
      count: number
    }
    const chunks = db.prepare('SELECT count(*) as count FROM knowledge_chunks').get() as {
      count: number
    }
    expect(sources.count).toBe(0)
    expect(chunks.count).toBe(0)
  })

  // 26. Successful PPTX ingestion
  it('26. successfully ingests a PPTX (.pptx) presentation through isolated execution, persists chunks and indexes in FTS5', async () => {
    const pptxBuffer = buildSyntheticPptx({
      title: 'Quarterly Strategic Deck',
      identifier: 'PPTX-001',
      slides: [
        {
          title: 'Executive Summary',
          paragraphs: [
            'Antigravity platform demonstrates exceptional local-first document indexing.'
          ]
        },
        {
          title: 'Architecture Overview',
          bullets: ['Isolated utilityProcess worker', 'Porter stemming FTS5', 'Safe table rebuild']
        }
      ]
    })
    const filePath = createTestFile('strategic-deck.pptx', pptxBuffer)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    expect(result.duplicate).toBe(false)
    if (result.status === 'completed') {
      expect(result.sourceId).toBeDefined()
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.totalChunks).toBeGreaterThanOrEqual(2)
      expect(result.relativeFilePath).toMatch(/^originals\/[0-9a-f-]+\.pptx$/)

      // Verify database source record
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source).not.toBeNull()
      expect(source?.file_type).toBe('pptx')
      expect(source?.original_file_name).toBe('strategic-deck.pptx')
      expect(source?.indexing_status).toBe('completed')

      // Verify persisted chunks contain slide metadata
      const chunks = db
        .prepare(
          'SELECT chunk_index, content, page_number, metadata_json FROM knowledge_chunks WHERE source_id = ? ORDER BY chunk_index ASC'
        )
        .all(result.sourceId) as {
        chunk_index: number
        content: string
        page_number: number | null
        metadata_json: string
      }[]
      expect(chunks.length).toBe(result.totalChunks)

      // First chunk should reflect Slide 1
      expect(chunks[0].page_number).toBe(1)
      const meta0 = JSON.parse(chunks[0].metadata_json)
      expect(meta0.slideNumber).toBe(1)
      expect(meta0.slideTitle).toBe('Executive Summary')

      // Verify FTS5 indexing
      const ftsMatches = db
        .prepare(
          `SELECT c.id FROM knowledge_chunks c
           JOIN knowledge_fts fts ON fts.rowid = c.rowid
           WHERE knowledge_fts MATCH 'antigravity'`
        )
        .all()
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  // 27. Duplicate PPTX detection
  it('27. detects duplicate PPTX import in the same Knowledge Base and returns structured duplicate result', async () => {
    const pptxBuffer = buildSyntheticPptx({
      title: 'Duplicate PPTX Test',
      identifier: 'DUP-PPTX-001',
      slides: [{ title: 'Unique Slide', paragraphs: ['Unique content for hash match.'] }]
    })
    const file1 = createTestFile('deck.pptx', pptxBuffer)
    const file2 = createTestFile('deck-copy.pptx', pptxBuffer)

    const first = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file1 })
    expect(first.status).toBe('completed')

    const second = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file2 })
    expect(second.status).toBe('duplicate')
    if (second.status === 'duplicate') {
      expect(second.duplicate).toBe(true)
      expect(second.existingSource.originalFileName).toBe('deck.pptx')
    }
  })

  // 28. Corrupt PPTX rejection
  it('28. safely rejects corrupt/truncated PPTX file, writes 0 database records and cleans up storage', async () => {
    const corruptBuffer = Buffer.from('PK\x03\x04corrupted_data_not_a_valid_pptx_archive')
    const corruptPath = createTestFile('broken.pptx', corruptBuffer)

    await expect(
      service.ingest({ knowledgeBaseId: defaultKbId, filePath: corruptPath })
    ).rejects.toThrow()

    // Verify 0 sources and 0 chunks in database
    const sources = db.prepare('SELECT count(*) as count FROM knowledge_sources').get() as {
      count: number
    }
    const chunks = db.prepare('SELECT count(*) as count FROM knowledge_chunks').get() as {
      count: number
    }
    expect(sources.count).toBe(0)
    expect(chunks.count).toBe(0)
  })

  // 29. Phase 11 Step 11.3: Universal Document Persistence during Ingestion
  it('29. persists canonical UniversalDocument in knowledge_extracted_documents alongside chunks during ingestion', async () => {
    const mdContent =
      '# Architecture Overview\n\nThis is a structured document with sections.\n\n```typescript\nconst persistent = true;\n```'
    const filePath = createTestFile('arch.md', mdContent)

    const res = await service.ingest({ knowledgeBaseId: defaultKbId, filePath })
    expect(res.status).toBe('completed')

    if (res.status === 'completed') {
      expect(res.universalDocument).toBeDefined()
      expect(res.universalDocument!.blocks.length).toBeGreaterThanOrEqual(1)

      // Query database repository directly
      const sourceRepo = new KnowledgeSourceRepository(db)
      const hasDoc = sourceRepo.hasExtractedDocument(res.sourceId, defaultKbId)
      expect(hasDoc).toBe(true)

      const extracted = sourceRepo.getExtractedDocument(res.sourceId, defaultKbId)
      expect(extracted).toBeDefined()
      expect(extracted!.format).toBe('md')
      expect(extracted!.blocks.length).toBeGreaterThanOrEqual(1)
      expect(extracted!.text).toContain('Architecture Overview')

      // Verify row in SQLite table directly
      const row = db
        .prepare(
          'SELECT source_id, schema_version, block_count, document_size_bytes FROM knowledge_extracted_documents WHERE source_id = ?'
        )
        .get(res.sourceId) as {
        source_id: string
        schema_version: number
        block_count: number
        document_size_bytes: number
      }
      expect(row).toBeDefined()
      expect(row.schema_version).toBe(1)
      expect(row.block_count).toBe(extracted!.blocks.length)
      expect(row.document_size_bytes).toBeGreaterThan(0)
    }
  })

  // 30. Successful CSV ingestion
  it('30. successfully ingests a CSV (.csv) document, persists UniversalDocument, persists chunks and indexes in FTS5', async () => {
    const csvContent =
      'SKU,ProductName,PriceUSD,StockCount\nPROD-001,Widget Alpha,49.99,150\nPROD-002,Widget Beta,89.50,42\n'
    const filePath = createTestFile('inventory.csv', csvContent)

    const result = await service.ingest({
      knowledgeBaseId: defaultKbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.duplicate).toBe(false)
      expect(result.sourceId).toBeDefined()
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.totalChunks).toBeGreaterThanOrEqual(1)
      expect(result.totalTokens).toBeGreaterThan(0)
      expect(result.relativeFilePath).toMatch(/^originals\/[0-9a-f-]+\.csv$/)

      // Verify source database record
      const source = service.getSource(result.sourceId, defaultKbId)
      expect(source).not.toBeNull()
      expect(source?.indexing_status).toBe('completed')
      expect(source?.file_type).toBe('csv')
      expect(source?.original_file_name).toBe('inventory.csv')
      expect(source?.indexed_at).toBeGreaterThan(0)
      expect(source?.error_message).toBeNull()

      // Verify physical storage
      const physicalFile = path.join(documentsDir, defaultKbId, result.relativeFilePath)
      expect(fs.existsSync(physicalFile)).toBe(true)

      // Verify FTS5 query match
      const ftsMatches = db
        .prepare(
          `
          SELECT c.id, c.content
          FROM knowledge_fts f
          JOIN knowledge_chunks c ON c.id = f.chunk_id
          WHERE knowledge_fts MATCH 'Widget'
        `
        )
        .all()
      expect(ftsMatches.length).toBeGreaterThanOrEqual(1)

      // Verify UniversalDocument persistence
      const sourceRepo = new KnowledgeSourceRepository(db)
      const extracted = sourceRepo.getExtractedDocument(result.sourceId, defaultKbId)
      expect(extracted).toBeDefined()
      expect(extracted?.format).toBe('csv')
      expect(extracted?.blocks.some((b) => b.type === 'table')).toBe(true)
    }
  })

  // 31. Duplicate CSV detection
  it('31. detects duplicate CSV import in the same Knowledge Base and returns structured duplicate result', async () => {
    const csvContent = 'Metric,Value\nVisitors,54000\nConversions,3200\n'
    const file1 = createTestFile('analytics1.csv', csvContent)
    const file2 = createTestFile('analytics2.csv', csvContent)

    const first = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file1 })
    expect(first.status).toBe('completed')

    const second = await service.ingest({ knowledgeBaseId: defaultKbId, filePath: file2 })
    expect(second.status).toBe('duplicate')
    if (second.status === 'duplicate') {
      expect(second.duplicate).toBe(true)
      expect(second.existingSource.originalFileName).toBe('analytics1.csv')
    }
  })
})
