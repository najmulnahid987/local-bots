import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { KnowledgeBaseRepository } from '../../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { DocumentStorageManager } from '../document-storage-manager'
import { DocumentIngestionService } from '../ingestion/document-ingestion-service'
import type { IngestDocumentResult, IngestDocumentSuccessResult } from '../ingestion/types'
import { DocumentSearchService } from '../search/document-search-service'
import { DocumentLifecycleService } from '../lifecycle/document-lifecycle-service'
import { recoverQuarantinedDocuments } from '../lifecycle/document-quarantine-recovery'

describe('Document Lifecycle End-to-End Acceptance (Step 5.12)', () => {
  let dbContext: MigratedTestDatabaseContext
  let tempBaseDir: string
  let documentsDir: string
  let kbRepo: KnowledgeBaseRepository
  let sourceRepo: KnowledgeSourceRepository
  let storageManager: DocumentStorageManager
  let ingestionService: DocumentIngestionService
  let searchService: DocumentSearchService
  let lifecycleService: DocumentLifecycleService

  beforeEach(() => {
    dbContext = createMigratedTestDatabase()
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-acceptance-test-'))
    documentsDir = path.join(tempBaseDir, 'documents')
    fs.mkdirSync(documentsDir, { recursive: true })

    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    sourceRepo = new KnowledgeSourceRepository(dbContext.db)
    storageManager = new DocumentStorageManager({ documentsDir })

    ingestionService = new DocumentIngestionService({
      db: dbContext.db,
      sourceRepository: sourceRepo,
      storageManager
    })

    searchService = new DocumentSearchService({
      sourceRepository: sourceRepo
    })

    lifecycleService = new DocumentLifecycleService({
      db: dbContext.db,
      sourceRepository: sourceRepo,
      storageManager
    })
  })

  afterEach(() => {
    dbContext.cleanup()
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  function createTestFile(fileName: string, content: string | Buffer): string {
    const filePath = path.join(tempBaseDir, fileName)
    if (typeof content === 'string') {
      fs.writeFileSync(filePath, content, 'utf-8')
    } else {
      fs.writeFileSync(filePath, content)
    }
    return filePath
  }

  function assertCompleted(res: IngestDocumentResult): asserts res is IngestDocumentSuccessResult {
    expect(res.status).toBe('completed')
    if (res.status !== 'completed') {
      throw new Error(`Expected completed status, received: ${res.status}`)
    }
  }

  // Minimal valid 1-page PDF
  function createTestPdf(text: string): Buffer {
    const streamContent = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`
    const streamLength = Buffer.byteLength(streamContent)
    return Buffer.from(
      '%PDF-1.4\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n' +
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
        `5 0 obj\n<< /Length ${streamLength} >>\nstream\n` +
        streamContent +
        '\nendstream\nendobj\n' +
        'xref\n0 6\n' +
        '0000000000 65535 f \n' +
        '0000000009 00000 n \n' +
        '0000000058 00000 n \n' +
        '0000000115 00000 n \n' +
        '0000000227 00000 n \n' +
        '0000000298 00000 n \n' +
        'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n405\n%%EOF'
    )
  }

  // --------------------------------------------------------------------------
  // Acceptance Test A: Complete Document Lifecycle
  // --------------------------------------------------------------------------
  it('Acceptance Test A: full document lifecycle (import, storage, chunking, FTS search, preview, reindex, delete, and cleanup)', async () => {
    const kb = kbRepo.create({ name: 'Acceptance KB A' })
    const kbId = kb.id

    // 1. Ingest a multi-section Markdown document
    const mdContent =
      '# Superconducting Circuits\n\n' +
      'Josephson junctions and flux qubits in cryogenic environments operate with microkelvin control.\n\n' +
      '# Quantum Error Correction\n\n' +
      'Surface code quantum memory maintains fault tolerance against thermal fluctuations.'

    const sourceFilePath = createTestFile('quantum_research.md', mdContent)
    const ingestResult = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: sourceFilePath
    })
    assertCompleted(ingestResult)

    const sourceId = ingestResult.source.id
    expect(sourceId).toBeDefined()
    expect(ingestResult.source.file_type).toBe('md')
    expect(ingestResult.totalChunks).toBeGreaterThan(0)

    // 2. Verify physical original file storage layout
    const managedOriginalPath = storageManager.resolveOriginalPath(kbId, sourceId, 'md')
    expect(fs.existsSync(managedOriginalPath)).toBe(true)
    expect(fs.readFileSync(managedOriginalPath, 'utf-8')).toBe(mdContent)

    // 3. Verify SQLite relational persistence and FTS5 synchronization
    const sourceRow = sourceRepo.getByIdWithChunkCount(sourceId, kbId)
    expect(sourceRow).not.toBeNull()
    expect(sourceRow?.indexing_status).toBe('completed')
    expect(sourceRow?.chunk_count).toBeGreaterThan(0)

    // 4. BM25 Search & Snippets
    const searchMatches = await searchService.search({
      knowledgeBaseId: kbId,
      query: 'Josephson cryogenic microkelvin',
      limit: 10
    })

    expect(searchMatches.length).toBeGreaterThan(0)
    expect(searchMatches[0].sourceId).toBe(sourceId)
    expect(searchMatches[0].snippet).toContain('[[HL]]')
    expect(searchMatches[0].snippet).toContain('Josephson')

    // 5. Bounded Document Preview
    const preview = sourceRepo.getPreview(sourceId, kbId, 5)
    expect(preview).not.toBeNull()
    expect(preview?.sourceId).toBe(sourceId)
    expect(preview?.fileType).toBe('md')
    expect(preview?.chunks.length).toBeGreaterThan(0)
    expect(preview?.chunks[0].content).toContain('Josephson junctions')

    // 6. Reindex Document Workflow
    // Atomically reprocesses the original file and replaces chunks/FTS entries
    const reindexResult = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })

    expect(reindexResult.status).toBe('completed')
    expect(reindexResult.source.id).toBe(sourceId)
    expect(reindexResult.totalChunks).toBeGreaterThan(0)

    // Verify FTS search still works after reindexing
    const postReindexMatches = await searchService.search({
      knowledgeBaseId: kbId,
      query: 'cryogenic microkelvin'
    })
    expect(postReindexMatches.length).toBeGreaterThan(0)
    expect(postReindexMatches[0].sourceId).toBe(sourceId)

    // 7. Safe Deletion Workflow
    const deleteResult = await lifecycleService.delete({
      knowledgeBaseId: kbId,
      sourceId
    })

    expect(deleteResult.success).toBe(true)
    expect(deleteResult.fileCleaned).toBe(true)

    // Verify physical file was unlinked
    expect(fs.existsSync(managedOriginalPath)).toBe(false)

    // Verify SQLite source and chunks deleted via cascade
    expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
    const remainingChunks = dbContext.db
      .prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE source_id = ?')
      .get(sourceId) as { count: number }
    expect(remainingChunks.count).toBe(0)

    // Verify FTS5 returns 0 matches
    const postDeleteMatches = await searchService.search({
      knowledgeBaseId: kbId,
      query: 'cryogenic'
    })
    expect(postDeleteMatches).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Acceptance Test A2: Complete TXT Document Lifecycle
  // --------------------------------------------------------------------------
  it('Acceptance Test A2: full TXT document lifecycle (import, storage, chunking, FTS search, preview, reindex, delete, and cleanup)', async () => {
    const kb = kbRepo.create({ name: 'Acceptance KB A2' })
    const kbId = kb.id

    const txtContent =
      'Stellar nucleosynthesis and thermonuclear fusion processes inside massive stars synthesize heavy elements.'
    const txtPath = createTestFile('astrophysics.txt', txtContent)

    // 1. Ingest plain text document
    const ingestRes = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: txtPath
    })
    assertCompleted(ingestRes)

    const sourceId = ingestRes.source.id
    expect(ingestRes.source.file_type).toBe('txt')
    expect(ingestRes.totalChunks).toBeGreaterThan(0)

    // 2. Verify managed original file storage layout
    const managedPath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
    expect(fs.existsSync(managedPath)).toBe(true)
    expect(fs.readFileSync(managedPath, 'utf-8')).toBe(txtContent)

    // 3. Verify SQLite relational persistence and FTS5 search
    const sourceRow = sourceRepo.getByIdWithChunkCount(sourceId, kbId)
    expect(sourceRow).not.toBeNull()
    expect(sourceRow?.indexing_status).toBe('completed')

    const searchMatches = await searchService.search({
      knowledgeBaseId: kbId,
      query: 'nucleosynthesis fusion'
    })
    expect(searchMatches).toHaveLength(1)
    expect(searchMatches[0].sourceId).toBe(sourceId)
    expect(searchMatches[0].snippet).toContain('[[HL]]')

    // 4. Bounded Preview
    const preview = sourceRepo.getPreview(sourceId, kbId, 3)
    expect(preview).not.toBeNull()
    expect(preview?.fileType).toBe('txt')
    expect(preview?.chunks.length).toBeGreaterThan(0)
    expect(preview?.chunks[0].content).toContain('thermonuclear fusion')

    // 5. Reindex Workflow
    const reindexRes = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(reindexRes.status).toBe('completed')
    expect(reindexRes.source.id).toBe(sourceId)

    // 6. Delete Workflow
    const deleteRes = await lifecycleService.delete({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(deleteRes.success).toBe(true)
    expect(deleteRes.fileCleaned).toBe(true)

    // Verify storage and DB removal
    expect(fs.existsSync(managedPath)).toBe(false)
    expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
    expect(
      await searchService.search({ knowledgeBaseId: kbId, query: 'nucleosynthesis' })
    ).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Acceptance Test A3: Complete PDF Document Lifecycle
  // --------------------------------------------------------------------------
  it('Acceptance Test A3: full PDF document lifecycle (import, page-aware chunking, FTS search, preview, reindex, delete, and cleanup)', async () => {
    const kb = kbRepo.create({ name: 'Acceptance KB A3' })
    const kbId = kb.id

    const pdfBytes = createTestPdf('Bose Einstein condensates in optical lattices')
    const pdfPath = createTestFile('condensed_matter.pdf', pdfBytes)

    // 1. Ingest PDF document
    const ingestRes = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: pdfPath
    })
    assertCompleted(ingestRes)

    const sourceId = ingestRes.source.id
    expect(ingestRes.source.file_type).toBe('pdf')
    expect(ingestRes.totalChunks).toBeGreaterThan(0)

    // 2. Verify managed original file storage layout
    const managedPath = storageManager.resolveOriginalPath(kbId, sourceId, 'pdf')
    expect(fs.existsSync(managedPath)).toBe(true)

    // 3. Verify SQLite relational persistence, page number, and FTS5 search
    const sourceRow = sourceRepo.getByIdWithChunkCount(sourceId, kbId)
    expect(sourceRow).not.toBeNull()
    expect(sourceRow?.indexing_status).toBe('completed')

    const searchMatches = await searchService.search({
      knowledgeBaseId: kbId,
      query: 'condensates optical'
    })
    expect(searchMatches).toHaveLength(1)
    expect(searchMatches[0].sourceId).toBe(sourceId)
    expect(searchMatches[0].pageNumber).toBe(1)
    expect(searchMatches[0].snippet).toContain('[[HL]]')

    // 4. Bounded Preview
    const preview = sourceRepo.getPreview(sourceId, kbId, 3)
    expect(preview).not.toBeNull()
    expect(preview?.fileType).toBe('pdf')
    expect(preview?.chunks[0].pageNumber).toBe(1)
    expect(preview?.chunks[0].content).toContain('condensates')

    // 5. Reindex Workflow
    const reindexRes = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(reindexRes.status).toBe('completed')
    expect(reindexRes.source.id).toBe(sourceId)

    // 6. Delete Workflow
    const deleteRes = await lifecycleService.delete({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(deleteRes.success).toBe(true)
    expect(deleteRes.fileCleaned).toBe(true)

    // Verify storage and DB removal
    expect(fs.existsSync(managedPath)).toBe(false)
    expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
    expect(
      await searchService.search({ knowledgeBaseId: kbId, query: 'condensates' })
    ).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Acceptance Test B: Knowledge Base Isolation
  // --------------------------------------------------------------------------
  it('Acceptance Test B: enforces strict Knowledge Base isolation across multiple KBs with identical content', async () => {
    const kb1 = kbRepo.create({ name: 'Knowledge Base Alpha' })
    const kb2 = kbRepo.create({ name: 'Knowledge Base Beta' })

    const identicalContent =
      'Cosmological inflation and cosmic microwave background polarization patterns in early universe.'
    const docPath = createTestFile('shared_topic.txt', identicalContent)

    // Ingest identical document into KB 1
    const res1 = await ingestionService.ingest({
      knowledgeBaseId: kb1.id,
      filePath: docPath
    })
    assertCompleted(res1)

    // Ingest identical document into KB 2
    const res2 = await ingestionService.ingest({
      knowledgeBaseId: kb2.id,
      filePath: docPath
    })
    assertCompleted(res2)

    expect(res1.source.id).not.toBe(res2.source.id)
    expect(res1.source.knowledge_base_id).toBe(kb1.id)
    expect(res2.source.knowledge_base_id).toBe(kb2.id)

    // Search KB 1 returns only KB 1 chunk
    const searchKb1 = await searchService.search({
      knowledgeBaseId: kb1.id,
      query: 'cosmological microwave'
    })
    expect(searchKb1).toHaveLength(1)
    expect(searchKb1[0].sourceId).toBe(res1.source.id)
    expect(searchKb1[0].knowledgeBaseId).toBe(kb1.id)

    // Search KB 2 returns only KB 2 chunk
    const searchKb2 = await searchService.search({
      knowledgeBaseId: kb2.id,
      query: 'cosmological microwave'
    })
    expect(searchKb2).toHaveLength(1)
    expect(searchKb2[0].sourceId).toBe(res2.source.id)
    expect(searchKb2[0].knowledgeBaseId).toBe(kb2.id)

    // Cross-KB lookup firewall: attempting to find KB 2 source using KB 1 ID returns null
    expect(sourceRepo.getById(res2.source.id, kb1.id)).toBeNull()

    // Delete document in KB 1
    await lifecycleService.delete({
      knowledgeBaseId: kb1.id,
      sourceId: res1.source.id
    })

    // KB 1 search is now empty
    const postDelKb1 = await searchService.search({
      knowledgeBaseId: kb1.id,
      query: 'cosmological'
    })
    expect(postDelKb1).toHaveLength(0)

    // KB 2 search remains unaffected and fully functional
    const postDelKb2 = await searchService.search({
      knowledgeBaseId: kb2.id,
      query: 'cosmological'
    })
    expect(postDelKb2).toHaveLength(1)
    expect(postDelKb2[0].sourceId).toBe(res2.source.id)
  })

  // --------------------------------------------------------------------------
  // Acceptance Test C: Failure & Rollback Reliability
  // --------------------------------------------------------------------------
  it('Acceptance Test C: rollback and failure safety (corrupted files, duplicates, reindex failure)', async () => {
    const kb = kbRepo.create({ name: 'Acceptance KB C' })
    const kbId = kb.id

    // 1. Validation failure: Ingest unsupported file type -> rejected immediately with zero DB rows or storage files
    const invalidExtPath = createTestFile('script.exe', 'binary content')
    await expect(
      ingestionService.ingest({
        knowledgeBaseId: kbId,
        filePath: invalidExtPath
      })
    ).rejects.toThrow()

    // Verify zero records in DB and zero stored files
    expect(sourceRepo.listByKnowledgeBase(kbId)).toHaveLength(0)
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    if (fs.existsSync(originalsDir)) {
      expect(fs.readdirSync(originalsDir)).toHaveLength(0)
    }

    // 2. Extraction failure: empty PDF -> registered but marked 'failed' with zero chunks and zero FTS entries
    const emptyPdfPath = createTestFile('empty.pdf', '%PDF-1.4\n%%EOF')
    await expect(
      ingestionService.ingest({
        knowledgeBaseId: kbId,
        filePath: emptyPdfPath
      })
    ).rejects.toThrow()

    const failedSources = sourceRepo.listByKnowledgeBase(kbId)
    expect(failedSources).toHaveLength(1)
    expect(failedSources[0].indexing_status).toBe('failed')
    const failedWithChunkCount = sourceRepo.getByIdWithChunkCount(failedSources[0].id, kbId)
    expect(failedWithChunkCount?.chunk_count).toBe(0)
    expect(failedSources[0].error_message).toBeDefined()

    // Clean up failed source for subsequent sub-tests
    await lifecycleService.delete({ knowledgeBaseId: kbId, sourceId: failedSources[0].id })
    expect(sourceRepo.listByKnowledgeBase(kbId)).toHaveLength(0)

    // 3. Ingest valid PDF
    const validPdfBytes = createTestPdf('Photonic computing systems')
    const validPdfPath = createTestFile('photonics.pdf', validPdfBytes)
    const firstIngest = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: validPdfPath
    })
    assertCompleted(firstIngest)
    expect(firstIngest.duplicate).toBe(false)

    // Duplicate detection in the same KB
    const duplicateIngest = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: validPdfPath
    })
    expect(duplicateIngest.duplicate).toBe(true)
    expect(duplicateIngest.status).toBe('duplicate')
    if (duplicateIngest.status === 'duplicate') {
      expect(duplicateIngest.existingSource.id).toBe(firstIngest.source.id)
    }

    // 4. Reindex failure handling when file becomes corrupted
    const managedPdfPath = storageManager.resolveOriginalPath(kbId, firstIngest.source.id, 'pdf')
    // Corrupt the managed file by writing empty bytes
    fs.writeFileSync(managedPdfPath, '%PDF-corrupted\n')

    await expect(
      lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId: firstIngest.source.id
      })
    ).rejects.toThrow()

    // Verify the record is marked failed, but database integrity remains intact
    const failedSource = sourceRepo.getById(firstIngest.source.id, kbId)
    expect(failedSource?.indexing_status).toBe('failed')
    expect(failedSource?.error_message).toBeDefined()
  })

  // --------------------------------------------------------------------------
  // Acceptance Test D: Interrupted Deletion & Startup Crash Recovery
  // --------------------------------------------------------------------------
  it('Acceptance Test D: handles interrupted deletion and reconciles quarantined files on startup', async () => {
    const kb = kbRepo.create({ name: 'Acceptance KB D' })
    const kbId = kb.id

    // Ingest a document
    const docPath = createTestFile('crash_test.txt', 'Resilience test document content.')
    const ingestRes = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath: docPath
    })
    assertCompleted(ingestRes)
    const sourceId = ingestRes.source.id
    const managedPath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)

    // Scenario A: Simulate crash before SQLite deletion
    // File was renamed to quarantine, but SQLite record remains
    const quarantinePathA = path.join(originalsDir, `.quarantine_${sourceId}_${randomUUID()}.txt`)
    fs.renameSync(managedPath, quarantinePathA)
    expect(fs.existsSync(managedPath)).toBe(false)
    expect(fs.existsSync(quarantinePathA)).toBe(true)

    // Run startup quarantine recovery
    const recoveryReportA = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(recoveryReportA.recoveredCount).toBe(1)
    expect(recoveryReportA.cleanedCount).toBe(0)
    expect(recoveryReportA.conflictCount).toBe(0)
    expect(fs.existsSync(managedPath)).toBe(true)
    expect(fs.existsSync(quarantinePathA)).toBe(false)

    // Scenario B: Simulate crash after SQLite deletion
    // Delete from SQLite manually, leaving quarantine file behind
    const quarantinePathB = path.join(originalsDir, `.quarantine_${sourceId}_${randomUUID()}.txt`)
    fs.renameSync(managedPath, quarantinePathB)
    sourceRepo.delete(sourceId, kbId)

    const recoveryReportB = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(recoveryReportB.recoveredCount).toBe(0)
    expect(recoveryReportB.cleanedCount).toBe(1)
    expect(recoveryReportB.conflictCount).toBe(0)
    expect(fs.existsSync(quarantinePathB)).toBe(false)
  })
})
