import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import {
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  statSync,
  symlinkSync
} from 'fs'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DatabaseManager } from './connection'
import { runMigrations } from './migrations/runner'
import { migrations } from './migrations'
import { KnowledgeBaseRepository } from './repositories/knowledge-base-repository'
import { BotRepository } from './repositories/bot-repository'

describe('DatabaseManager Online Backup Operations (Step 2.7B)', () => {
  let tempBaseDir: string
  let manager: DatabaseManager
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `test-bak-mgr-${randomUUID()}`)
    mkdirSync(tempBaseDir, { recursive: true })

    manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      if (manager && manager.isOpen()) {
        manager.close()
      }
    } catch {
      // Ignore teardown close errors
    }

    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`Failed to cleanup temp dir ${tempBaseDir}:`, err)
      }
    }
  })

  // Test A & B: Valid online backup and content verification
  it('A & B: creates valid online backup while source connection remains open and preserves schema/records', async () => {
    // 1. Seed domain data
    const kb = kbRepo.create({
      name: 'Backup Alpha KB',
      description: 'Knowledge Base to verify backup'
    })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Backup Alpha Bot',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base']
    })

    const bakPath = join(tempBaseDir, 'backups', 'alpha.sqlite.bak')
    mkdirSync(join(tempBaseDir, 'backups'), { recursive: true })

    // Source database must be open and operational
    expect(manager.isOpen()).toBe(true)

    // 2. Execute online backup
    const result = await manager.backup(bakPath)

    expect(result.destinationPath).toBe(bakPath)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.integrityVerified).toBe(true)
    expect(existsSync(bakPath)).toBe(true)

    // Source database must still be open
    expect(manager.isOpen()).toBe(true)

    // 3. Inspect backup independently
    const bakDb = new Database(bakPath, { readonly: true })
    try {
      const bakKbRepo = new KnowledgeBaseRepository(bakDb)
      const bakBotRepo = new BotRepository(bakDb)

      // Verify schema_migrations history
      const migRow = bakDb
        .prepare('SELECT version, name FROM schema_migrations WHERE version = 1')
        .get() as { version: number; name: string }
      expect(migRow.version).toBe(1)
      expect(migRow.name).toBe('initial_schema')

      // Verify Knowledge Base
      const retrievedKb = bakKbRepo.getById(kb.id)
      expect(retrievedKb).not.toBeNull()
      expect(retrievedKb?.name).toBe('Backup Alpha KB')
      expect(retrievedKb?.description).toBe('Knowledge Base to verify backup')

      // Verify Bot and strict KB relationship
      const retrievedBot = bakBotRepo.getById(bot.id, kb.id)
      expect(retrievedBot).not.toBeNull()
      expect(retrievedBot?.name).toBe('Backup Alpha Bot')
      expect(retrievedBot?.knowledgeBaseId).toBe(kb.id)
      expect(retrievedBot?.toolPermissions).toEqual(['search_knowledge_base'])

      const botsInKb = bakBotRepo.listByKnowledgeBase(kb.id)
      expect(botsInKb).toHaveLength(1)
      expect(botsInKb[0].id).toBe(bot.id)
    } finally {
      bakDb.close()
    }
  })

  // Test C: Backup during WAL writes (uncheckpointed committed data)
  it('C: captures committed data residing exclusively in uncheckpointed WAL frames', async () => {
    // 1. Truncate WAL to ensure a clean 0-frame baseline
    manager.checkpoint('TRUNCATE')

    // 2. Insert new records into database (written directly to WAL)
    const uncheckKb = kbRepo.create({ name: 'Uncheckpointed KB' })
    const uncheckBot = botRepo.create({
      knowledgeBaseId: uncheckKb.id,
      name: 'Uncheckpointed Bot',
      modelId: 'claude-3-5-sonnet-20241022'
    })

    // Verify WAL contains uncheckpointed data
    const walFile = `${manager.getDatabasePath()}-wal`
    expect(existsSync(walFile)).toBe(true)
    expect(statSync(walFile).size).toBeGreaterThan(0)

    // Do NOT checkpoint! Execute backup directly
    const bakPath = join(tempBaseDir, 'uncheckpointed.sqlite.bak')
    await manager.backup(bakPath)

    // 3. Inspect backup file
    const bakDb = new Database(bakPath, { readonly: true })
    try {
      const bakKbRepo = new KnowledgeBaseRepository(bakDb)
      const bakBotRepo = new BotRepository(bakDb)

      const recoveredKb = bakKbRepo.getById(uncheckKb.id)
      expect(recoveredKb).not.toBeNull()
      expect(recoveredKb?.name).toBe('Uncheckpointed KB')

      const recoveredBot = bakBotRepo.getById(uncheckBot.id, uncheckKb.id)
      expect(recoveredBot).not.toBeNull()
      expect(recoveredBot?.name).toBe('Uncheckpointed Bot')
      expect(recoveredBot?.knowledgeBaseId).toBe(uncheckKb.id)
    } finally {
      bakDb.close()
    }
  })

  // Test D: Backup integrity
  it('D: verifies integrity_check returns ok and foreign_key_check returns zero rows on backup', async () => {
    const bakPath = join(tempBaseDir, 'integrity-test.sqlite.bak')
    await manager.backup(bakPath)

    const bakDb = new Database(bakPath, { readonly: true })
    try {
      bakDb.pragma('foreign_keys = ON')
      const integrity = bakDb.pragma('integrity_check') as Array<{ integrity_check: string }>
      expect(integrity[0].integrity_check).toBe('ok')

      const fkViolations = bakDb.pragma('foreign_key_check') as unknown[]
      expect(fkViolations).toEqual([])
    } finally {
      bakDb.close()
    }
  })

  // Test E: Existing destination
  it('E: rejects backup if destination already exists and preserves existing file unmodified', async () => {
    const existingBakPath = join(tempBaseDir, 'already-exists.sqlite.bak')
    writeFileSync(existingBakPath, 'IMPORTANT_ORIGINAL_USER_BACKUP_CONTENT')

    await expect(manager.backup(existingBakPath)).rejects.toThrow(
      /Backup destination file already exists/i
    )

    // Confirm original file remained untouched
    expect(readFileSync(existingBakPath, 'utf8')).toBe('IMPORTANT_ORIGINAL_USER_BACKUP_CONTENT')
  })

  // Test F: Invalid destination validation
  it('F: rejects empty, relative, self/sidecar, nonexistent parent, directory, and symlink destinations', async () => {
    // 1. Empty path
    await expect(manager.backup('')).rejects.toThrow(
      /Backup destination path must be a non-empty string/i
    )

    // 2. Relative path
    await expect(manager.backup('relative/backup.bak')).rejects.toThrow(
      /Backup destination path must be an absolute path/i
    )

    // 3. Same source database path
    await expect(manager.backup(manager.getDatabasePath())).rejects.toThrow(
      /Backup destination path cannot be the source database or its auxiliary sidecar files/i
    )

    // 4. Source WAL sidecar path
    await expect(manager.backup(`${manager.getDatabasePath()}-wal`)).rejects.toThrow(
      /Backup destination path cannot be the source database or its auxiliary sidecar files/i
    )

    // 5. Source SHM sidecar path
    await expect(manager.backup(`${manager.getDatabasePath()}-shm`)).rejects.toThrow(
      /Backup destination path cannot be the source database or its auxiliary sidecar files/i
    )

    // 6. Nonexistent parent directory
    const missingParent = join(tempBaseDir, 'no_such_directory', 'backup.bak')
    await expect(manager.backup(missingParent)).rejects.toThrow(
      /Backup destination parent directory does not exist/i
    )

    // 7. Directory supplied as destination
    const existingDir = join(tempBaseDir, 'folder_target')
    mkdirSync(existingDir, { recursive: true })
    await expect(manager.backup(existingDir)).rejects.toThrow(
      /Backup destination path cannot be an existing directory/i
    )

    // 8. Symlink destination guard
    const targetDir = join(tempBaseDir, 'symlink_target_dir')
    mkdirSync(targetDir, { recursive: true })
    const linkPath = join(tempBaseDir, 'symlink_destination.bak')
    symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(manager.backup(linkPath)).rejects.toThrow(/must not be a symbolic link/i)

    // 9. Symlink parent directory guard
    const fileInsideSymlinkDir = join(linkPath, 'inner_backup.bak')
    await expect(manager.backup(fileInsideSymlinkDir)).rejects.toThrow(
      /Backup destination parent directory must not be a symbolic link/i
    )
  })

  // Test G: Transaction handling
  it('G: rejects backup attempt while active source transaction is open and preserves transaction control', async () => {
    const db = manager.getDatabase()
    const bakPath = join(tempBaseDir, 'tx-test.sqlite.bak')

    db.exec('BEGIN IMMEDIATE')
    expect(db.inTransaction).toBe(true)

    try {
      await expect(manager.backup(bakPath)).rejects.toThrow(
        /Cannot perform database backup while an active transaction is open/i
      )
      expect(existsSync(bakPath)).toBe(false)
      expect(db.inTransaction).toBe(true)
    } finally {
      db.exec('ROLLBACK')
      expect(db.inTransaction).toBe(false)
    }

    // After rollback, database is operational and can be backed up normally
    const result = await manager.backup(bakPath)
    expect(result.integrityVerified).toBe(true)
  })

  // Test H: Overlapping backups
  it('H: safely controls overlapping backup attempts through same manager instance', async () => {
    const dest1 = join(tempBaseDir, 'overlap1.sqlite.bak')
    const dest2 = join(tempBaseDir, 'overlap2.sqlite.bak')

    // Start first backup without awaiting immediately
    const backupPromise1 = manager.backup(dest1)

    // Attempt second backup while first is in progress
    await expect(manager.backup(dest2)).rejects.toThrow(/A database backup is already in progress/i)

    const result1 = await backupPromise1
    expect(result1.destinationPath).toBe(dest1)
    expect(existsSync(dest1)).toBe(true)

    // After first finishes, a new backup can execute
    const result2 = await manager.backup(dest2)
    expect(result2.destinationPath).toBe(dest2)
    expect(existsSync(dest2)).toBe(true)
  })

  // Test I: Failure cleanup
  it('I: cleans up temporary file on failure without modifying source database', async () => {
    const bakPath = join(tempBaseDir, 'failure-test.sqlite.bak')

    // Mock better-sqlite3 backup method to create a temporary file and then fail
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      destPath: string
    ) {
      writeFileSync(destPath, 'partial_temporary_bytes')
      throw new Error('Simulated SQLite engine failure during backup execution')
    })

    await expect(manager.backup(bakPath)).rejects.toThrow(
      /Simulated SQLite engine failure during backup execution/i
    )

    // Destination should not exist
    expect(existsSync(bakPath)).toBe(false)

    // Temporary files inside tempBaseDir should be cleanly unlinked
    const remainingFiles = fs.readdirSync(tempBaseDir)
    const tempTmpFiles = remainingFiles.filter((f) => f.startsWith('.') && f.endsWith('.tmp'))
    expect(tempTmpFiles).toHaveLength(0)

    // Source database must remain open, valid, and fully operational
    expect(manager.isOpen()).toBe(true)
    const testRow = manager
      .getDatabase()
      .prepare('SELECT count(*) as count FROM knowledge_bases')
      .get() as {
      count: number
    }
    expect(typeof testRow.count).toBe('number')
  })

  // Test J: Full restoration into a fresh DatabaseManager
  it('J: restores backup cleanly into fresh DatabaseManager with WAL mode, foreign keys, and all data intact', async () => {
    // 1. Populate source with rich domain entities
    const originalKb = kbRepo.create({
      name: 'Restoration Source KB',
      description: 'KB for disaster recovery test'
    })
    const originalBot = botRepo.create({
      knowledgeBaseId: originalKb.id,
      name: 'Restoration Bot',
      modelId: 'gpt-4o',
      systemPrompt: 'You are a disaster recovery test bot.'
    })

    const backupFile = join(tempBaseDir, 'cold-restore.sqlite.bak')
    await manager.backup(backupFile)

    // Close source manager
    manager.close()
    expect(manager.isOpen()).toBe(false)

    // 2. Set up fresh destination userData directory
    const destUserData = join(tempBaseDir, 'restored-workspace')
    const destDbDir = join(destUserData, 'database')
    mkdirSync(destDbDir, { recursive: true })
    const destDbFile = join(destDbDir, 'app.sqlite')

    // Copy backup into app.sqlite location while no connection is open
    copyFileSync(backupFile, destDbFile)

    // 3. Initialize brand new DatabaseManager on the restored location
    const restoredManager = new DatabaseManager()
    try {
      const initResult = restoredManager.initialize(destUserData)

      expect(initResult.journalMode).toBe('wal')
      expect(initResult.synchronous).toBe(2)
      expect(initResult.foreignKeys).toBe(true)
      expect(initResult.busyTimeout).toBe(5000)
      expect(initResult.walAutoCheckpoint).toBe(1000)

      const restoredDb = restoredManager.getDatabase()

      // Confirm migrations idempotency
      const migResult = runMigrations(restoredDb, migrations)
      expect(migResult.appliedCount).toBe(0)
      expect(migResult.currentVersion).toBe(migrations.length)

      // Confirm integrity and foreign keys
      const integrity = restoredDb.pragma('integrity_check') as Array<{ integrity_check: string }>
      expect(integrity[0].integrity_check).toBe('ok')

      const fkViolations = restoredDb.pragma('foreign_key_check') as unknown[]
      expect(fkViolations).toEqual([])

      // Verify domain repositories retrieve original data
      const restoredKbRepo = new KnowledgeBaseRepository(restoredDb)
      const restoredBotRepo = new BotRepository(restoredDb)

      const recoveredKb = restoredKbRepo.getById(originalKb.id)
      expect(recoveredKb).not.toBeNull()
      expect(recoveredKb?.name).toBe('Restoration Source KB')
      expect(recoveredKb?.description).toBe('KB for disaster recovery test')

      const recoveredBot = restoredBotRepo.getById(originalBot.id, originalKb.id)
      expect(recoveredBot).not.toBeNull()
      expect(recoveredBot?.name).toBe('Restoration Bot')
      expect(recoveredBot?.knowledgeBaseId).toBe(originalKb.id)
      expect(recoveredBot?.systemPrompt).toBe('You are a disaster recovery test bot.')
    } finally {
      restoredManager.close()
    }
  })

  // Test K: No-clobber regression test under concurrent file creation
  it('K: guarantees no-clobber behavior if destination file is created concurrently before finalization', async () => {
    const concurrentDest = join(tempBaseDir, 'concurrent-target.sqlite.bak')

    // Spy on better-sqlite3 backup to inject a concurrent file at the destination path
    // immediately after the online backup finishes writing to the temporary file,
    // simulating a TOCTOU race condition before finalization.
    const origBackup = Database.prototype.backup
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      destPath: string,
      options?: Database.BackupOptions
    ) {
      // Execute the real SQLite online backup to write valid temp database bytes
      const res = await origBackup.call(this, destPath, options)
      // Simulate concurrent process creating the destination file right before finalization
      writeFileSync(concurrentDest, 'CONCURRENT_PROCESS_PAYLOAD_DO_NOT_OVERWRITE')
      return res
    })

    await expect(manager.backup(concurrentDest)).rejects.toThrow(
      /Backup destination file already exists/i
    )

    // Verify destination was NOT clobbered and preserved external content
    expect(readFileSync(concurrentDest, 'utf8')).toBe('CONCURRENT_PROCESS_PAYLOAD_DO_NOT_OVERWRITE')

    // Verify temporary files were cleanly unlinked
    const remainingFiles = fs.readdirSync(tempBaseDir)
    const tempTmpFiles = remainingFiles.filter((f) => f.startsWith('.') && f.endsWith('.tmp'))
    expect(tempTmpFiles).toHaveLength(0)
  })
})
