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
import { DocumentLifecycleService } from './document-lifecycle-service'
import { buildSyntheticDocx } from '../benchmarks/fixtures/office-generator'

describe('DocumentLifecycleService (Phase 5 Step 5.10)', () => {
  let dbContext: MigratedTestDatabaseContext
  let tempBaseDir: string
  let documentsDir: string
  let kbRepo: KnowledgeBaseRepository
  let sourceRepo: KnowledgeSourceRepository
  let storageManager: DocumentStorageManager
  let ingestionService: DocumentIngestionService
  let lifecycleService: DocumentLifecycleService
  let kbId: string

  beforeEach(() => {
    dbContext = createMigratedTestDatabase()
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-lifecycle-test-'))
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

    lifecycleService = new DocumentLifecycleService({
      db: dbContext.db,
      sourceRepository: sourceRepo,
      storageManager
    })

    const kb = kbRepo.create({ name: 'Lifecycle Test Knowledge Base' })
    kbId = kb.id
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

  async function ingestCompleted(
    fileName: string,
    content: string | Buffer,
    targetKbId = kbId
  ): Promise<string> {
    const filePath = createTestFile(fileName, content)
    const ingestRes = await ingestionService.ingest({
      knowledgeBaseId: targetKbId,
      filePath
    })
    if (ingestRes.status !== 'completed') {
      throw new Error(`Ingest failed with status: ${ingestRes.status}`)
    }
    return ingestRes.source.id
  }

  // Minimal valid 1-page PDF with extractable text
  function createTestPdf(): Buffer {
    return Buffer.from(
      '%PDF-1.4\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n' +
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
        '5 0 obj\n<< /Length 55 >>\nstream\n' +
        'BT /F1 12 Tf 72 712 Td (Quantum computing algorithms) Tj ET\nendstream\nendobj\n' +
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

  describe('Reindexing Workflows', () => {
    it('1. successfully reindexes a TXT document and updates chunks and FTS5 search', async () => {
      const sourceId = await ingestCompleted(
        'article.txt',
        'Astrophysics research on pulsar magnetospheres.'
      )

      // Initial search finds "pulsar"
      const initialSearch = sourceRepo.searchChunks(kbId, 'pulsar', 10)
      expect(initialSearch).toHaveLength(1)

      // Reindex the document
      const reindexRes = await lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(reindexRes.status).toBe('completed')
      expect(reindexRes.source.id).toBe(sourceId)
      expect(reindexRes.source.indexingStatus).toBe('completed')
      expect(reindexRes.totalChunks).toBeGreaterThan(0)
      expect(reindexRes.totalTokens).toBeGreaterThan(0)

      // FTS search still works after reindexing
      const postSearch = sourceRepo.searchChunks(kbId, 'pulsar', 10)
      expect(postSearch).toHaveLength(1)
      expect(postSearch[0].source_id).toBe(sourceId)
    })

    it('2. successfully reindexes a Markdown document with headings and preserves metadata', async () => {
      const mdContent =
        '# Section Alpha\n\nDeep learning neural network architectures.\n\n# Section Beta\n\nReinforcement learning policy gradients.'
      const sourceId = await ingestCompleted('notes.md', mdContent)

      const reindexRes = await lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(reindexRes.status).toBe('completed')
      expect(reindexRes.source.originalFileName).toBe('notes.md')

      // Check chunks have section metadata preserved
      const chunks = sourceRepo.getChunksBySourceId(sourceId, kbId)
      expect(chunks.length).toBeGreaterThan(0)
      const metadata = JSON.parse(chunks[0].metadata_json)
      expect(metadata.heading).toBeDefined()
    })

    it('3. successfully reindexes a PDF document', async () => {
      const pdfBytes = createTestPdf()
      const sourceId = await ingestCompleted('quantum.pdf', pdfBytes)

      const reindexRes = await lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(reindexRes.status).toBe('completed')
      expect(reindexRes.source.fileType).toBe('pdf')
      expect(reindexRes.totalChunks).toBeGreaterThan(0)

      const search = sourceRepo.searchChunks(kbId, 'quantum', 10)
      expect(search).toHaveLength(1)
    })

    it('4. preserves source ID, created_at, and relative_file_path while updating timestamps', async () => {
      const sourceId = await ingestCompleted(
        'preserve.txt',
        'Preserved properties verification document.'
      )
      const sourceBefore = sourceRepo.getById(sourceId, kbId)!

      // Add a small artificial delay so timestamps advance
      await new Promise((resolve) => setTimeout(resolve, 10))

      const reindexRes = await lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId: sourceBefore.id
      })

      const sourceAfter = sourceRepo.getById(sourceBefore.id, kbId)!
      expect(sourceAfter.id).toBe(sourceBefore.id)
      expect(sourceAfter.created_at).toBe(sourceBefore.created_at)
      expect(sourceAfter.relative_file_path).toBe(sourceBefore.relative_file_path)
      expect(sourceAfter.content_hash).toBe(sourceBefore.content_hash)
      expect(sourceAfter.updated_at).toBeGreaterThanOrEqual(sourceBefore.updated_at)
      expect(sourceAfter.indexed_at).toBeGreaterThanOrEqual(sourceBefore.indexed_at ?? 0)
      expect(reindexRes.source.id).toBe(sourceBefore.id)
    })

    it('4b. successfully reindexes a DOCX document and updates chunks and FTS5 search', async () => {
      const docxBuffer = buildSyntheticDocx({
        title: 'Network Optimization Specification',
        identifier: 'NET-OPT-001',
        headings: ['Throughput Analysis', 'Latency Benchmarks'],
        tableRows: [
          ['Protocol', 'Bandwidth', 'LossRate'],
          ['QUIC', '10 Gbps', '0.01%']
        ]
      })
      const sourceId = await ingestCompleted('network-spec.docx', docxBuffer)

      // Initial search finds "Throughput"
      const initialSearch = sourceRepo.searchChunks(kbId, 'Throughput', 10)
      expect(initialSearch.length).toBeGreaterThanOrEqual(1)

      // Reindex the document
      const reindexRes = await lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(reindexRes.status).toBe('completed')
      expect(reindexRes.source.id).toBe(sourceId)
      expect(reindexRes.source.fileType).toBe('docx')
      expect(reindexRes.source.indexingStatus).toBe('completed')
      expect(reindexRes.totalChunks).toBeGreaterThanOrEqual(1)

      // FTS search still works after reindexing
      const postSearch = sourceRepo.searchChunks(kbId, 'Throughput', 10)
      expect(postSearch.length).toBeGreaterThanOrEqual(1)
      expect(postSearch[0].source_id).toBe(sourceId)
    })

    it('5. transitions source to failed on disk file checksum mismatch', async () => {
      const sourceId = await ingestCompleted(
        'corrupted.txt',
        'Original text before external tampering.'
      )

      // Tamper with managed original file directly on disk
      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
      fs.writeFileSync(storagePath, 'Tampered modified text with different checksum.', 'utf-8')

      await expect(
        lifecycleService.reindex({
          knowledgeBaseId: kbId,
          sourceId
        })
      ).rejects.toThrow(/checksum/)

      // Status must transition to 'failed' and preserve error message
      const failedSource = sourceRepo.getById(sourceId, kbId)!
      expect(failedSource.indexing_status).toBe('failed')
      expect(failedSource.error_message).toContain('checksum')
    })

    it('6. transitions source to failed when original file is missing on disk', async () => {
      const sourceId = await ingestCompleted('missing.txt', 'Text will be deleted from disk.')

      // Delete managed file from disk
      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
      fs.unlinkSync(storagePath)

      await expect(
        lifecycleService.reindex({
          knowledgeBaseId: kbId,
          sourceId
        })
      ).rejects.toThrow()

      const failedSource = sourceRepo.getById(sourceId, kbId)!
      expect(failedSource.indexing_status).toBe('failed')
    })

    it('7. blocks concurrent operations on the same source with OPERATION_IN_PROGRESS', async () => {
      const sourceId = await ingestCompleted('concurrency.txt', 'Long concurrent text '.repeat(100))

      // Trigger two simultaneous reindex operations
      const p1 = lifecycleService.reindex({ knowledgeBaseId: kbId, sourceId })
      const p2 = lifecycleService.reindex({ knowledgeBaseId: kbId, sourceId })

      // One must succeed, one must reject with OPERATION_IN_PROGRESS
      const results = await Promise.allSettled([p1, p2])
      const rejected = results.find((r) => r.status === 'rejected')
      const fulfilled = results.find((r) => r.status === 'fulfilled')

      expect(fulfilled).toBeDefined()
      expect(rejected).toBeDefined()
      if (rejected && rejected.status === 'rejected') {
        expect((rejected.reason as { code?: string })?.code).toBe('OPERATION_IN_PROGRESS')
      }
    })
  })

  describe('Deletion Workflows', () => {
    it('8. safely deletes a document, unlinks original file, and cascades chunks and FTS rows', async () => {
      const sourceId = await ingestCompleted(
        'delete_me.txt',
        'Cryptographic hashing algorithms and salting.'
      )

      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
      expect(fs.existsSync(storagePath)).toBe(true)

      // Verify searchable initially
      expect(sourceRepo.searchChunks(kbId, 'cryptographic', 10)).toHaveLength(1)

      const deleteRes = await lifecycleService.delete({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(deleteRes.success).toBe(true)
      expect(deleteRes.sourceId).toBe(sourceId)
      expect(deleteRes.knowledgeBaseId).toBe(kbId)
      expect(deleteRes.fileCleaned).toBe(true)
      expect(deleteRes.cleanupPending).toBe(false)

      // Managed original file removed
      expect(fs.existsSync(storagePath)).toBe(false)

      // Database record deleted
      expect(sourceRepo.getById(sourceId, kbId)).toBeNull()

      // Chunks cascaded
      expect(sourceRepo.getChunksBySourceId(sourceId, kbId)).toHaveLength(0)

      // FTS search returns 0 results
      expect(sourceRepo.searchChunks(kbId, 'cryptographic', 10)).toHaveLength(0)
    })

    it('8b. safely deletes a DOCX document, unlinks original file, and cascades chunks and FTS rows', async () => {
      const docxBuffer = buildSyntheticDocx({
        title: 'DOCX Deletion Protocol',
        identifier: 'DEL-DOCX-001',
        headings: ['Cleanup Directives'],
        tableRows: []
      })
      const sourceId = await ingestCompleted('delete_me.docx', docxBuffer)

      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'docx')
      expect(fs.existsSync(storagePath)).toBe(true)

      // Verify searchable initially
      expect(sourceRepo.searchChunks(kbId, 'Cleanup', 10).length).toBeGreaterThanOrEqual(1)

      const deleteRes = await lifecycleService.delete({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(deleteRes.success).toBe(true)
      expect(deleteRes.sourceId).toBe(sourceId)
      expect(deleteRes.knowledgeBaseId).toBe(kbId)
      expect(deleteRes.fileCleaned).toBe(true)

      // Managed original file removed
      expect(fs.existsSync(storagePath)).toBe(false)

      // Database record deleted
      expect(sourceRepo.getById(sourceId, kbId)).toBeNull()

      // Chunks cascaded
      expect(sourceRepo.getChunksBySourceId(sourceId, kbId)).toHaveLength(0)

      // FTS search returns 0 results
      expect(sourceRepo.searchChunks(kbId, 'Cleanup', 10)).toHaveLength(0)
    })

    it('9. restores original file from quarantine if database deletion fails', async () => {
      const sourceId = await ingestCompleted(
        'quarantine_rollback.txt',
        'Protected content under quarantine rollback test.'
      )
      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')

      // Mock sourceRepository.delete to simulate a database failure during delete
      const originalDelete = sourceRepo.delete.bind(sourceRepo)
      sourceRepo.delete = () => {
        throw new Error('Simulated SQLite disk I/O error during DELETE')
      }

      await expect(
        lifecycleService.delete({
          knowledgeBaseId: kbId,
          sourceId
        })
      ).rejects.toThrow('Simulated SQLite disk I/O error during DELETE')

      // Compensation verification: original file must be restored at its original path
      expect(fs.existsSync(storagePath)).toBe(true)

      // Document record still intact in database
      sourceRepo.delete = originalDelete
      expect(sourceRepo.getById(sourceId, kbId)).not.toBeNull()
    })

    it('10. handles already-missing file on disk gracefully without failing DB cleanup', async () => {
      const sourceId = await ingestCompleted(
        'already_missing.txt',
        'Content whose file will disappear.'
      )

      // Delete file from disk before calling delete()
      const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
      fs.unlinkSync(storagePath)

      const deleteRes = await lifecycleService.delete({
        knowledgeBaseId: kbId,
        sourceId
      })

      expect(deleteRes.success).toBe(true)
      expect(deleteRes.fileCleaned).toBe(true)
      expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
    })

    it('11. blocks concurrent deletion on the same source with OPERATION_IN_PROGRESS', async () => {
      const sourceId = await ingestCompleted(
        'delete_concurrency.txt',
        'Content for delete concurrency test.'
      )

      const p1 = lifecycleService.delete({ knowledgeBaseId: kbId, sourceId })
      const p2 = lifecycleService.delete({ knowledgeBaseId: kbId, sourceId })

      const results = await Promise.allSettled([p1, p2])
      const rejected = results.find((r) => r.status === 'rejected')
      const fulfilled = results.find((r) => r.status === 'fulfilled')

      expect(fulfilled).toBeDefined()
      expect(rejected).toBeDefined()
      if (rejected && rejected.status === 'rejected') {
        expect((rejected.reason as { code?: string })?.code).toBe('OPERATION_IN_PROGRESS')
      }
    })
  })

  describe('Isolation and Validation Security', () => {
    it('12. strictly rejects cross-Knowledge-Base reindex attempts', async () => {
      const otherKb = kbRepo.create({ name: 'Foreign Base' })
      const sourceId = await ingestCompleted(
        'foreign_iso.txt',
        'Foreign document content.',
        otherKb.id
      )

      // Attempting to reindex otherKb's source using kbId MUST throw DOCUMENT_NOT_FOUND
      await expect(
        lifecycleService.reindex({
          knowledgeBaseId: kbId,
          sourceId
        })
      ).rejects.toThrow(/could not be found in Knowledge Base/)
    })

    it('13. strictly rejects cross-Knowledge-Base delete attempts', async () => {
      const otherKb = kbRepo.create({ name: 'Foreign Base 2' })
      const sourceId = await ingestCompleted(
        'foreign_iso2.txt',
        'Foreign document content 2.',
        otherKb.id
      )

      await expect(
        lifecycleService.delete({
          knowledgeBaseId: kbId,
          sourceId
        })
      ).rejects.toThrow(/could not be found in Knowledge Base/)

      // Source in otherKb must remain intact
      expect(sourceRepo.getById(sourceId, otherKb.id)).not.toBeNull()
    })

    it('14. rejects reindex and delete for non-existent Knowledge Base', async () => {
      const fakeKbId = randomUUID()
      const fakeSourceId = randomUUID()

      await expect(
        lifecycleService.reindex({
          knowledgeBaseId: fakeKbId,
          sourceId: fakeSourceId
        })
      ).rejects.toThrow(/Knowledge Base '.*' could not be found/)

      await expect(
        lifecycleService.delete({
          knowledgeBaseId: fakeKbId,
          sourceId: fakeSourceId
        })
      ).rejects.toThrow(/Knowledge Base '.*' could not be found/)
    })

    it('15. rejects invalid UUID arguments via Zod validation', async () => {
      await expect(
        lifecycleService.reindex({
          knowledgeBaseId: 'not-a-uuid',
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/Invalid reindex request/)

      await expect(
        lifecycleService.delete({
          knowledgeBaseId: kbId,
          sourceId: 'not-a-uuid'
        })
      ).rejects.toThrow(/Invalid delete request/)
    })
  })
})
