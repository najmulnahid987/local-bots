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

describe('ImportRecoveryService', () => {
  let db: Database.Database
  let repo: ImportRecoveryRepository
  let storageManager: DocumentStorageManager
  let service: ImportRecoveryService
  let tmpDir: string
  let docsDir: string
  let tempBaseDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-import-recovery-${randomUUID()}`)
    docsDir = path.join(tmpDir, 'documents')
    tempBaseDir = path.join(tmpDir, 'temp')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.mkdirSync(tempBaseDir, { recursive: true })

    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    repo = new ImportRecoveryRepository(db)
    storageManager = new DocumentStorageManager({ documentsDir: docsDir })
    service = new ImportRecoveryService({
      db,
      journalRepository: repo,
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

  it('1. reconciles operations interrupted during staging by cleaning staging and marking cancelled', async () => {
    const id = randomUUID()
    const stagingDirName = `import-staging-${id}`
    const stagingDirPath = path.join(tempBaseDir, stagingDirName)
    fs.mkdirSync(stagingDirPath, { recursive: true })
    fs.writeFileSync(path.join(stagingDirPath, 'manifest.json'), '{}')

    repo.create({
      id,
      strategy: 'new',
      targetKnowledgeBaseName: 'Test KB',
      archiveSha256: 'a'.repeat(64),
      archiveName: 'test.zip',
      state: 'staging',
      stagingDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('cancelled')
    expect(fs.existsSync(stagingDirPath)).toBe(false)

    const journal = repo.getById(id)
    expect(journal?.state).toBe('cancelled')
  })

  it('2. reconciles replace operation interrupted during quarantining by restoring originals', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const stagingDirName = `import-staging-${id}`
    const stagingDirPath = path.join(tempBaseDir, stagingDirName)
    fs.mkdirSync(stagingDirPath, { recursive: true })

    // Setup KB directory with quarantine directory
    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'original.txt'), 'Original KB file')

    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Existing KB',
      archiveSha256: 'b'.repeat(64),
      archiveName: 'replace.zip',
      state: 'quarantining',
      stagingDirName,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('failed')

    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    expect(fs.existsSync(path.join(originalsDir, 'original.txt'))).toBe(true)
    expect(fs.existsSync(quarantineDir)).toBe(false)
  })

  it('3. detects conflict in quarantining state and marks recovery_required without deleting quarantine', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const stagingDirName = `import-staging-${id}`
    const stagingDirPath = path.join(tempBaseDir, stagingDirName)
    fs.mkdirSync(stagingDirPath, { recursive: true })

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.mkdirSync(originalsDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'quarantined.txt'), 'Quarantine file')
    fs.writeFileSync(path.join(originalsDir, 'active.txt'), 'Active file')

    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Conflicted KB',
      archiveSha256: 'c'.repeat(64),
      archiveName: 'conflict.zip',
      state: 'quarantining',
      stagingDirName,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('recovery_required')
    expect(fs.existsSync(quarantineDir)).toBe(true)
    expect(fs.existsSync(originalsDir)).toBe(true)
  })

  it('4. reconciles replace operation interrupted during files_promoting by removing promoted files and restoring quarantine', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const stagingDirName = `import-staging-${id}`

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.mkdirSync(originalsDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'saved-before-replace.txt'), 'Original data')
    fs.writeFileSync(path.join(originalsDir, 'partially-copied.txt'), 'Partial new data')

    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Replace KB',
      archiveSha256: 'd'.repeat(64),
      archiveName: 'replace.zip',
      state: 'files_promoting',
      stagingDirName,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('failed')

    expect(fs.existsSync(path.join(originalsDir, 'saved-before-replace.txt'))).toBe(true)
    expect(fs.existsSync(path.join(originalsDir, 'partially-copied.txt'))).toBe(false)
  })

  it('5. reconciles merge operation interrupted during files_promoting by unlinking only newly promoted files', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const stagingDirName = `import-staging-${id}`

    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(originalsDir, { recursive: true })
    const existingFile = path.join(originalsDir, 'pre-existing.txt')
    const promotedFile = path.join(originalsDir, 'newly-copied.txt')
    fs.writeFileSync(existingFile, 'Pre-existing file')
    fs.writeFileSync(promotedFile, 'Newly promoted file')

    repo.create({
      id,
      strategy: 'merge',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Merge KB',
      archiveSha256: 'e'.repeat(64),
      archiveName: 'merge.zip',
      state: 'files_promoting',
      stagingDirName,
      promotedFiles: [promotedFile]
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('failed')

    expect(fs.existsSync(existingFile)).toBe(true)
    expect(fs.existsSync(promotedFile)).toBe(false)
  })

  it('6. reconciles committed import by verifying promoted files, updating unindexed sources to needs_reindex, and cleaning quarantine', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const stagingDirName = `import-staging-${id}`

    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Committed KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const fileContent = 'Verified document content'
    const fileBuffer = Buffer.from(fileContent, 'utf8')
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex')

    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(originalsDir, { recursive: true })
    const filePath = path.join(originalsDir, `${sourceId}.txt`)
    fs.writeFileSync(filePath, fileBuffer)

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'file.txt', 'file.txt', ?, 'txt', 'text/plain', ?, ?, 'processing', ?, ?)
    `
    ).run(sourceId, kbId, `originals/${sourceId}.txt`, fileBuffer.length, fileHash, now, now)

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'old.txt'), 'Old data')

    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Committed KB',
      archiveSha256: 'f'.repeat(64),
      archiveName: 'committed.zip',
      state: 'database_committed',
      stagingDirName,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('completed')

    // Quarantine should be cleaned after successful verification
    expect(fs.existsSync(quarantineDir)).toBe(false)
    expect(fs.existsSync(filePath)).toBe(true)

    // Source should have been transitioned to needs_reindex
    const sourceRow = db
      .prepare('SELECT indexing_status, error_message FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as {
      indexing_status: string
      error_message: string
    }
    expect(sourceRow.indexing_status).toBe('needs_reindex')
    expect(sourceRow.error_message).toContain('INTERRUPTED')
  })

  it('7. marks committed import as recovery_required if verified file is missing, strictly preserving quarantine', async () => {
    const id = randomUUID()
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const stagingDirName = `import-staging-${id}`

    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Missing File KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'file.txt', 'file.txt', ?, 'txt', 'text/plain', 50, ?, 'queued', ?, ?)
    `
    ).run(sourceId, kbId, `originals/${sourceId}.txt`, '0'.repeat(64), now, now)

    const kbDir = storageManager.resolveKnowledgeBaseDirectory(kbId)
    const quarantineDirName = `.quarantine_originals_${Date.now()}`
    const quarantineDir = path.join(kbDir, quarantineDirName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'old-precious-data.txt'), 'Do not delete')

    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: kbId,
      targetKnowledgeBaseName: 'Missing File KB',
      archiveSha256: '1'.repeat(64),
      archiveName: 'missing.zip',
      state: 'indexing',
      stagingDirName,
      quarantineDirName
    })

    const report = await service.recoverInterruptedImports()
    expect(report.recoveredCount).toBe(1)
    expect(report.results[0].finalState).toBe('recovery_required')

    // Quarantine MUST NOT be deleted!
    expect(fs.existsSync(quarantineDir)).toBe(true)
    expect(fs.existsSync(path.join(quarantineDir, 'old-precious-data.txt'))).toBe(true)
  })
})
