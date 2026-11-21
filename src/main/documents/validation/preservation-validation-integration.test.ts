import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { DocumentIngestionService } from '../ingestion/document-ingestion-service'
import { DocumentLifecycleService } from '../lifecycle/document-lifecycle-service'
import {
  KnowledgeSourceRepository,
  ExtractedDocumentRepository,
  DocumentValidationRepository
} from '../../database/repositories'
import { DocumentStorageManager } from '../document-storage-manager'
import { StaticDocumentSettingsProvider } from '../document-settings'

describe('Preservation Validation Integration (Ingestion & Lifecycle)', () => {
  let db: Database.Database
  let tempDir: string
  let ingestionService: DocumentIngestionService
  let lifecycleService: DocumentLifecycleService
  let sourceRepo: KnowledgeSourceRepository
  let extractedDocRepo: ExtractedDocumentRepository
  let validationRepo: DocumentValidationRepository
  let storageManager: DocumentStorageManager

  const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
  const otherKbId = 'a1b2c3d4-0000-4000-8000-000000000002'

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'preservation-val-test-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    sourceRepo = new KnowledgeSourceRepository(db)
    extractedDocRepo = new ExtractedDocumentRepository(db)
    validationRepo = new DocumentValidationRepository(db)
    storageManager = new DocumentStorageManager({ documentsDir: path.join(tempDir, 'documents') })
    const settingsProvider = new StaticDocumentSettingsProvider()

    ingestionService = new DocumentIngestionService({
      db,
      sourceRepository: sourceRepo,
      extractedDocumentRepository: extractedDocRepo,
      validationRepository: validationRepo,
      storageManager,
      settingsProvider
    })

    lifecycleService = new DocumentLifecycleService({
      db,
      sourceRepository: sourceRepo,
      extractedDocumentRepository: extractedDocRepo,
      validationRepository: validationRepo,
      storageManager,
      settingsProvider
    })

    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
      VALUES (?, 'Primary KB', 'primary-path', ?, ?)
    `
    ).run(kbId, now, now)

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
      VALUES (?, 'Secondary KB', 'secondary-path', ?, ?)
    `
    ).run(otherKbId, now, now)
  })

  afterEach(async () => {
    if (db && db.open) {
      db.close()
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('persists source, extracted doc, chunks, and validation report atomically on successful ingestion', async () => {
    const filePath = path.join(tempDir, 'sample.txt')
    const content = 'First paragraph.\n\nSecond paragraph.'
    await fs.promises.writeFile(filePath, content, 'utf-8')

    const result = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return

    expect(result.sourceId).toBeDefined()
    expect(result.preservationReport).toBeDefined()
    expect(result.preservationReport?.status).toBe('complete')
    expect(result.preservationReport?.extractionStatus).toBe('complete')
    expect(result.preservationReport?.chunkCoverageStatus).toBe('complete')

    // Verify database records
    const storedSource = sourceRepo.getById(result.sourceId, kbId)
    expect(storedSource?.indexing_status).toBe('completed')

    const storedDoc = extractedDocRepo.get(result.sourceId, kbId)
    expect(storedDoc).not.toBeNull()
    expect(storedDoc?.text).toContain('First paragraph.')

    const storedReport = validationRepo.getReport(result.sourceId, kbId)
    expect(storedReport).not.toBeNull()
    expect(storedReport?.status).toBe('complete')
    expect(storedReport?.extractionReport.totalElements).toBeGreaterThan(0)

    const verification = validationRepo.verifyReport(result.sourceId, kbId)
    expect(verification.valid).toBe(true)

    const chunks = sourceRepo.getChunksBySourceId(result.sourceId, kbId)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('marks preservation report as partial when document contains unsupported visual content', async () => {
    const filePath = path.join(tempDir, 'unsupported.md')
    const content = '# Title\n\n![diagram](diagram.png)\n\nParagraph text here.'
    await fs.promises.writeFile(filePath, content, 'utf-8')

    const result = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return

    expect(result.preservationReport?.status).toBe('partial')
    expect(result.preservationReport?.extractionStatus).toBe('partial')
    expect(result.preservationReport?.chunkCoverageStatus).toBe('complete')
    expect(
      result.preservationReport?.extractionReport.referenceOnlyElements.length
    ).toBeGreaterThan(0)
  })

  it('re-indexing updates the validation report and atomically replaces previous report', async () => {
    const filePath = path.join(tempDir, 'reindex-test.txt')
    await fs.promises.writeFile(filePath, 'Initial text content.', 'utf-8')

    const ingestResult = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })
    expect(ingestResult.status).toBe('completed')
    if (ingestResult.status !== 'completed') return

    const sourceId = ingestResult.sourceId
    const initialReport = validationRepo.getReport(sourceId, kbId)
    expect(initialReport?.status).toBe('complete')

    // Execute re-indexing
    const reindexResult = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })

    expect(reindexResult.status).toBe('completed')
    const updatedReport = validationRepo.getReport(sourceId, kbId)
    expect(updatedReport).not.toBeNull()
    expect(updatedReport?.sourceId).toBe(sourceId)
    expect(updatedReport?.timestamp).toBeGreaterThanOrEqual(initialReport!.timestamp)
  })

  it('re-indexing failure preserves previous valid extracted doc, chunks, and validation report', async () => {
    const filePath = path.join(tempDir, 'fail-preserve.txt')
    await fs.promises.writeFile(filePath, 'Valid initial text.', 'utf-8')

    const ingestResult = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })
    expect(ingestResult.status).toBe('completed')
    if (ingestResult.status !== 'completed') return

    const sourceId = ingestResult.sourceId
    const originalDoc = extractedDocRepo.get(sourceId, kbId)
    const originalReport = validationRepo.getReport(sourceId, kbId)
    const originalChunks = sourceRepo.getChunksBySourceId(sourceId, kbId)

    // Delete stored original file to cause re-indexing failure
    const storagePath = storageManager.resolveOriginalPath(kbId, sourceId, 'txt')
    await fs.promises.unlink(storagePath)

    await expect(
      lifecycleService.reindex({
        knowledgeBaseId: kbId,
        sourceId
      })
    ).rejects.toThrow()

    // Previous data must be preserved!
    const postFailDoc = extractedDocRepo.get(sourceId, kbId)
    expect(postFailDoc?.id).toBe(originalDoc?.id)

    const postFailReport = validationRepo.getReport(sourceId, kbId)
    expect(postFailReport?.timestamp).toBe(originalReport?.timestamp)

    const postFailChunks = sourceRepo.getChunksBySourceId(sourceId, kbId)
    expect(postFailChunks.length).toBe(originalChunks.length)
  })

  it('cascades deletion of validation record when document is deleted', async () => {
    const filePath = path.join(tempDir, 'delete-test.txt')
    await fs.promises.writeFile(filePath, 'Will be deleted.', 'utf-8')

    const ingestResult = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })
    expect(ingestResult.status).toBe('completed')
    if (ingestResult.status !== 'completed') return

    const sourceId = ingestResult.sourceId
    expect(validationRepo.getReport(sourceId, kbId)).not.toBeNull()

    // Delete document via lifecycle service
    const deleteResult = await lifecycleService.delete({
      knowledgeBaseId: kbId,
      sourceId
    })

    expect(deleteResult.success).toBe(true)
    expect(validationRepo.getReport(sourceId, kbId)).toBeNull()
  })

  it('enforces Cross-KB isolation and returns null for documents belonging to other KBs', async () => {
    const filePath = path.join(tempDir, 'kb-isolation.txt')
    await fs.promises.writeFile(filePath, 'KB Isolation Text.', 'utf-8')

    const ingestResult = await ingestionService.ingest({
      knowledgeBaseId: kbId,
      filePath
    })
    expect(ingestResult.status).toBe('completed')
    if (ingestResult.status !== 'completed') return

    const sourceId = ingestResult.sourceId

    // Querying report under wrong KB ID returns null
    const isolatedReport = validationRepo.getReport(sourceId, otherKbId)
    expect(isolatedReport).toBeNull()

    const isolatedFromService = ingestionService.getValidationReport(sourceId, otherKbId)
    expect(isolatedFromService).toBeNull()
  })
})
