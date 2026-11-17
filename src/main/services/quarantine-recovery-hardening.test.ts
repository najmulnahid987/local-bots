import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto, { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations/index'
import { ImportRecoveryRepository } from '../database/repositories/import-recovery-repository'
import { ImportRecoveryService } from './import-recovery-service'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'

describe('Quarantine Recovery & Crash Resilience Hardening', () => {
  let db: Database.Database
  let importRepo: ImportRecoveryRepository
  let sourceRepo: KnowledgeSourceRepository
  let storageManager: DocumentStorageManager
  let lifecycleService: DocumentLifecycleService
  let service: ImportRecoveryService
  let tmpDir: string
  let docsDir: string
  let tempBaseDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-quarantine-hardening-${randomUUID()}`)
    docsDir = path.join(tmpDir, 'documents')
    tempBaseDir = path.join(tmpDir, 'temp')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.mkdirSync(tempBaseDir, { recursive: true })

    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    importRepo = new ImportRecoveryRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    storageManager = new DocumentStorageManager({ documentsDir: docsDir })
    lifecycleService = new DocumentLifecycleService({
      db,
      sourceRepository: sourceRepo,
      storageManager
    })
    service = new ImportRecoveryService({
      db,
      journalRepository: importRepo,
      storageManager,
      tempBaseDir
    })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('1. crash during replace file promotion preserves original data by restoring quarantine', async () => {
    const kbId = randomUUID()
    const operationId = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Replace Target KB', 'Original KB', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)

    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.mkdirSync(originalsDir, { recursive: true })

    fs.writeFileSync(path.join(quarantineDir, 'precious-original-doc.txt'), 'Crucial user data')
    fs.writeFileSync(path.join(originalsDir, 'half-written-new-doc.txt'), 'Incomplete write')

    importRepo.create({
      id: operationId,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Replace Target KB',
      archiveSha256: 'a'.repeat(64),
      archiveName: 'replace.zip',
      state: 'files_promoting',
      stagingDirName: `import-staging-${operationId}`,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('failed')

    // Original file must be restored in originals directory
    expect(fs.existsSync(path.join(originalsDir, 'precious-original-doc.txt'))).toBe(true)
    // Partial file must be deleted
    expect(fs.existsSync(path.join(originalsDir, 'half-written-new-doc.txt'))).toBe(false)
    // Quarantine directory should no longer exist because it was moved back
    expect(fs.existsSync(quarantineDir)).toBe(false)
  })

  it('2. crash after DB commit verifies files, marks sources needs_reindex, and only deletes quarantine after verification', async () => {
    const kbId = randomUUID()
    const operationId = randomUUID()
    const sourceId = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Committed KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const textContent = 'Full document content for post-crash reindex verification.'
    const buffer = Buffer.from(textContent, 'utf8')
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')

    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(originalsDir, { recursive: true })
    const filePath = path.join(originalsDir, `${sourceId}.txt`)
    fs.writeFileSync(filePath, buffer)

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'doc.txt', 'doc.txt', ?, 'txt', 'text/plain', ?, ?, 'processing', ?, ?)
    `
    ).run(sourceId, kbId, `originals/${sourceId}.txt`, buffer.length, hash, now, now)

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'old-replaced-doc.txt'), 'Old data')

    importRepo.create({
      id: operationId,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Committed KB',
      archiveSha256: 'b'.repeat(64),
      archiveName: 'committed.zip',
      state: 'database_committed',
      stagingDirName: `import-staging-${operationId}`,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('completed')

    // Quarantine was safely cleaned because all files verified 100%
    expect(fs.existsSync(quarantineDir)).toBe(false)
    expect(fs.existsSync(filePath)).toBe(true)

    // Reconciled source is in needs_reindex
    const sourceRow = db
      .prepare('SELECT indexing_status, error_message FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as {
      indexing_status: string
      error_message: string
    }
    expect(sourceRow.indexing_status).toBe('needs_reindex')
    expect(sourceRow.error_message).toContain('INTERRUPTED')

    // Now test idempotent re-indexing via DocumentLifecycleService:
    // It should successfully index the document into chunks and FTS5 without error
    const reindexResult = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(reindexResult.status).toBe('completed')
    expect(reindexResult.totalChunks).toBeGreaterThan(0)

    // Verify chunks and FTS5 rows exist
    const chunks = db
      .prepare('SELECT count(*) as c FROM knowledge_chunks WHERE source_id = ?')
      .get(sourceId) as { c: number }
    expect(chunks.c).toBe(reindexResult.totalChunks)

    const fts = db
      .prepare('SELECT count(*) as c FROM knowledge_fts WHERE source_id = ?')
      .get(sourceId) as { c: number }
    expect(fts.c).toBe(reindexResult.totalChunks)

    // Running reindex a second time must be strictly idempotent (no duplicate chunks or FTS rows)
    const reindexResult2 = await lifecycleService.reindex({
      knowledgeBaseId: kbId,
      sourceId
    })
    expect(reindexResult2.totalChunks).toBe(reindexResult.totalChunks)

    const chunksAfter = db
      .prepare('SELECT count(*) as c FROM knowledge_chunks WHERE source_id = ?')
      .get(sourceId) as { c: number }
    expect(chunksAfter.c).toBe(reindexResult.totalChunks)

    const ftsAfter = db
      .prepare('SELECT count(*) as c FROM knowledge_fts WHERE source_id = ?')
      .get(sourceId) as { c: number }
    expect(ftsAfter.c).toBe(reindexResult.totalChunks)
  })

  it('3. corrupt file after crash triggers recovery_required and strictly protects quarantine directory', async () => {
    const kbId = randomUUID()
    const operationId = randomUUID()
    const sourceId = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Corrupt KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(originalsDir, { recursive: true })
    const filePath = path.join(originalsDir, `${sourceId}.txt`)
    // Write corrupted content that doesn't match expected hash
    fs.writeFileSync(filePath, 'Corrupted data bytes')

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'doc.txt', 'doc.txt', ?, 'txt', 'text/plain', 50, ?, 'queued', ?, ?)
    `
    ).run(sourceId, kbId, `originals/${sourceId}.txt`, 'c'.repeat(64), now, now)

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(
      path.join(quarantineDir, 'safe-original.txt'),
      'Crucial original user document'
    )

    importRepo.create({
      id: operationId,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Corrupt KB',
      archiveSha256: 'd'.repeat(64),
      archiveName: 'corrupt.zip',
      state: 'indexing',
      stagingDirName: `import-staging-${operationId}`,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('recovery_required')

    // QUARANTINE DIRECTORY MUST NEVER BE DELETED
    expect(fs.existsSync(quarantineDir)).toBe(true)
    expect(fs.existsSync(path.join(quarantineDir, 'safe-original.txt'))).toBe(true)

    // Second recovery run must recognize recovery_required and preserve quarantine
    const report2 = await service.recoverInterruptedImports()
    expect(report2.results[0].finalState).toBe('recovery_required')
    expect(fs.existsSync(quarantineDir)).toBe(true)
  })
})
