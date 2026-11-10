import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { runMigrations, migrations } from '../../database/migrations'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import {
  DocumentQuarantineRecoveryService,
  recoverQuarantinedDocuments
} from './document-quarantine-recovery'

describe('DocumentQuarantineRecoveryService (Step 5.12)', () => {
  let tempDir: string
  let documentsDir: string
  let db: Database.Database
  let sourceRepo: KnowledgeSourceRepository

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-recovery-test-'))
    documentsDir = path.join(tempDir, 'documents')
    fs.mkdirSync(documentsDir, { recursive: true })

    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    sourceRepo = new KnowledgeSourceRepository(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore if already closed
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('1. returns empty report when documents directory does not exist', async () => {
    const nonExistentDir = path.join(tempDir, 'non_existent_dir')
    const service = new DocumentQuarantineRecoveryService({
      documentsDir: nonExistentDir,
      sourceRepository: sourceRepo
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)
  })

  it('2. returns empty report when documents directory has no knowledge base directories', async () => {
    const service = new DocumentQuarantineRecoveryService({
      documentsDir,
      sourceRepository: sourceRepo
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)
  })

  it('3. ignores non-UUID subdirectories and non-quarantine files', async () => {
    const otherDir = path.join(documentsDir, 'some-random-folder')
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'test.txt'), 'hello')

    const kbId = randomUUID()
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    fs.writeFileSync(path.join(originalsDir, `${randomUUID()}.txt`), 'normal file')

    const service = new DocumentQuarantineRecoveryService({
      documentsDir,
      sourceRepository: sourceRepo
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)
  })

  it('4. records error for malformed quarantine filenames or unsupported extensions', async () => {
    const kbId = randomUUID()
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })

    // Malformed: missing parts
    fs.writeFileSync(path.join(originalsDir, '.quarantine_invalid.txt'), 'malformed')
    // Unsupported extension
    const sourceId = randomUUID()
    const qUuid = randomUUID()
    fs.writeFileSync(
      path.join(originalsDir, `.quarantine_${sourceId}_${qUuid}.exe`),
      'bad extension'
    )

    const service = new DocumentQuarantineRecoveryService({
      documentsDir,
      sourceRepository: sourceRepo
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(2)
    const errMsgs = report.errors.map((e) => e.error).join(' ')
    expect(errMsgs).toContain('Malformed quarantine filename')
    expect(errMsgs).toContain('Unsupported file extension')
  })

  const DUMMY_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('5. Scenario A (Restore): restores quarantined file when SQLite source record exists and original is missing', async () => {
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const qUuid = randomUUID()
    const now = Date.now()

    // 1. Insert KB and Source in SQLite
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Test KB', `documents/${kbId}`, now, now)
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: `${sourceId}.txt`,
      original_file_name: 'sample.txt',
      relative_file_path: `originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 12,
      content_hash: DUMMY_HASH,
      indexing_status: 'completed',
      created_at: now
    })

    // 2. Set up originals directory with only the quarantine file (original is missing)
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    const quarantineFileName = `.quarantine_${sourceId}_${qUuid}.txt`
    const quarantineFilePath = path.join(originalsDir, quarantineFileName)
    fs.writeFileSync(quarantineFilePath, 'restored content')

    const report = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(report.recoveredCount).toBe(1)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)

    // Verify quarantine file was renamed to original file
    expect(fs.existsSync(quarantineFilePath)).toBe(false)
    const originalFilePath = path.join(originalsDir, `${sourceId}.txt`)
    expect(fs.existsSync(originalFilePath)).toBe(true)
    expect(fs.readFileSync(originalFilePath, 'utf-8')).toBe('restored content')
  })

  it('6. Scenario B (Cleanup): safely deletes orphaned quarantine file when SQLite source record does not exist', async () => {
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const qUuid = randomUUID()

    // No record in SQLite
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    const quarantineFileName = `.quarantine_${sourceId}_${qUuid}.md`
    const quarantineFilePath = path.join(originalsDir, quarantineFileName)
    fs.writeFileSync(quarantineFilePath, 'orphaned content')

    const report = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(1)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)

    // Verify orphaned quarantine file was unlinked
    expect(fs.existsSync(quarantineFilePath)).toBe(false)
  })

  it('7. Scenario C (Conflict): preserves both files without overwriting when SQLite source exists and original already exists', async () => {
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const qUuid = randomUUID()
    const now = Date.now()

    // 1. Insert KB and Source in SQLite
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Test KB', `documents/${kbId}`, now, now)
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: `${sourceId}.pdf`,
      original_file_name: 'sample.pdf',
      relative_file_path: `originals/${sourceId}.pdf`,
      file_type: 'pdf',
      mime_type: 'application/pdf',
      file_size: 20,
      content_hash: DUMMY_HASH,
      indexing_status: 'completed',
      created_at: now
    })

    // 2. Both original file and quarantine file exist
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    const originalFilePath = path.join(originalsDir, `${sourceId}.pdf`)
    fs.writeFileSync(originalFilePath, 'existing original')

    const quarantineFileName = `.quarantine_${sourceId}_${qUuid}.pdf`
    const quarantineFilePath = path.join(originalsDir, quarantineFileName)
    fs.writeFileSync(quarantineFilePath, 'quarantine version')

    const report = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(1)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].error).toContain('Conflict detected: Original file')

    // Both files must remain intact and unmodified
    expect(fs.existsSync(originalFilePath)).toBe(true)
    expect(fs.readFileSync(originalFilePath, 'utf-8')).toBe('existing original')
    expect(fs.existsSync(quarantineFilePath)).toBe(true)
    expect(fs.readFileSync(quarantineFilePath, 'utf-8')).toBe('quarantine version')
  })

  it('8. handles multiple quarantine files across multiple knowledge bases in a single recovery run', async () => {
    const now = Date.now()
    const kb1 = randomUUID()
    const kb2 = randomUUID()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kb1, 'KB 1', `documents/${kb1}`, now, now)
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kb2, 'KB 2', `documents/${kb2}`, now, now)

    // KB 1 has a Scenario A (Restore) item
    const s1 = randomUUID()
    sourceRepo.create({
      id: s1,
      knowledge_base_id: kb1,
      file_name: `${s1}.txt`,
      original_file_name: 'doc1.txt',
      relative_file_path: `originals/${s1}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 10,
      content_hash: DUMMY_HASH,
      indexing_status: 'completed',
      created_at: now
    })
    const kb1Dir = path.join(documentsDir, kb1, 'originals')
    fs.mkdirSync(kb1Dir, { recursive: true })
    fs.writeFileSync(path.join(kb1Dir, `.quarantine_${s1}_${randomUUID()}.txt`), 'content 1')

    // KB 2 has a Scenario B (Cleanup) item
    const s2 = randomUUID()
    const kb2Dir = path.join(documentsDir, kb2, 'originals')
    fs.mkdirSync(kb2Dir, { recursive: true })
    fs.writeFileSync(path.join(kb2Dir, `.quarantine_${s2}_${randomUUID()}.txt`), 'content 2')

    const report = await recoverQuarantinedDocuments({
      documentsDir,
      sourceRepository: sourceRepo
    })

    expect(report.recoveredCount).toBe(1)
    expect(report.cleanedCount).toBe(1)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(0)

    expect(fs.existsSync(path.join(kb1Dir, `${s1}.txt`))).toBe(true)
    expect(fs.readdirSync(kb2Dir)).toHaveLength(0)
  })

  it('9. security: skips and logs error when quarantine file is detected as a symbolic link', async () => {
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const qUuid = randomUUID()
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    const quarantineFileName = `.quarantine_${sourceId}_${qUuid}.txt`
    const quarantineFilePath = path.join(originalsDir, quarantineFileName)
    fs.writeFileSync(quarantineFilePath, 'symlink target content')

    // Inject fsOps that reports isSymbolicLink = true for the quarantine file
    const service = new DocumentQuarantineRecoveryService({
      documentsDir,
      sourceRepository: sourceRepo,
      fsOps: {
        lstat: async (p: string) => {
          const realStat = await fs.promises.lstat(p)
          if (p === quarantineFilePath) {
            return {
              ...realStat,
              isSymbolicLink: () => true,
              isDirectory: () => false,
              isFile: () => true
            } as unknown as fs.Stats
          }
          return realStat
        }
      }
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].error).toContain('is a symbolic link. Skipping for security')
    // File remains untouched
    expect(fs.existsSync(quarantineFilePath)).toBe(true)
  })

  it('10. resilience: gracefully logs error and continues when source lookup encounters an unexpected database error', async () => {
    const kbId = randomUUID()
    const sourceId = randomUUID()
    const qUuid = randomUUID()
    const originalsDir = path.join(documentsDir, kbId, 'originals')
    fs.mkdirSync(originalsDir, { recursive: true })
    const quarantineFileName = `.quarantine_${sourceId}_${qUuid}.txt`
    const quarantineFilePath = path.join(originalsDir, quarantineFileName)
    fs.writeFileSync(quarantineFilePath, 'pending content')

    // Close the database to force SQLite lookup to throw
    db.close()

    const service = new DocumentQuarantineRecoveryService({
      documentsDir,
      sourceRepository: sourceRepo
    })

    const report = await service.recover()
    expect(report.recoveredCount).toBe(0)
    expect(report.cleanedCount).toBe(0)
    expect(report.conflictCount).toBe(0)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].error).toContain('Database lookup failed')
    expect(fs.existsSync(quarantineFilePath)).toBe(true)
  })
})
