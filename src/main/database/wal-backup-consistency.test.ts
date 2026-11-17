import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { existsSync, rmSync, mkdirSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DatabaseManager } from './connection'
import { runMigrations } from './migrations/runner'
import { migrations } from './migrations'
import { KnowledgeBaseRepository } from './repositories/knowledge-base-repository'
import { BotRepository } from './repositories/bot-repository'

describe('WAL-Aware Database Backup Consistency (Phase 9 Step 9.7)', () => {
  let tempBaseDir: string
  let manager: DatabaseManager
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `test-wal-backup-consistency-${randomUUID()}`)
    mkdirSync(tempBaseDir, { recursive: true })

    manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
  })

  afterEach(() => {
    try {
      if (manager && manager.isOpen()) {
        manager.close()
      }
    } catch {
      // Ignore
    }

    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`Failed to cleanup temp dir ${tempBaseDir}:`, err)
      }
    }
  })

  it('1. verifies WAL mode is active and new rows reside in uncheckpointed WAL before backup', async () => {
    const db = manager.getDatabase()
    const journalMode = db.pragma('journal_mode', { simple: true })
    expect(String(journalMode).toLowerCase()).toBe('wal')

    // Truncate WAL to start with 0 frames
    manager.checkpoint('TRUNCATE')

    // Insert new rows into database
    const kb = kbRepo.create({ name: 'Uncheckpointed WAL KB' })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'WAL Bot',
      modelId: 'gpt-4o'
    })

    // WAL file must exist and have non-zero size
    const walFile = `${manager.getDatabasePath()}-wal`
    expect(existsSync(walFile)).toBe(true)
    expect(statSync(walFile).size).toBeGreaterThan(0)

    // Backup directly without running checkpoint
    const bakDir = join(tempBaseDir, 'backups')
    mkdirSync(bakDir, { recursive: true })
    const bakPath = join(bakDir, 'wal-snapshot.sqlite')

    const result = await manager.backup(bakPath)
    expect(result.integrityVerified).toBe(true)
    expect(existsSync(bakPath)).toBe(true)

    // Inspect the backup using an independent connection
    const bakDb = new Database(bakPath, { readonly: true })
    try {
      // Verify integrity_check
      const integrity = bakDb.pragma('integrity_check') as Array<{ integrity_check: string }>
      expect(integrity[0].integrity_check).toBe('ok')

      // Verify foreign_key_check
      const fkViolations = bakDb.pragma('foreign_key_check') as unknown[]
      expect(fkViolations).toEqual([])

      // Verify committed WAL-resident rows are present in backup
      const checkKb = bakDb
        .prepare('SELECT id, name FROM knowledge_bases WHERE id = ?')
        .get(kb.id) as {
        id: string
        name: string
      }
      expect(checkKb).toBeDefined()
      expect(checkKb.name).toBe('Uncheckpointed WAL KB')

      const checkBot = bakDb.prepare('SELECT id, name FROM bots WHERE id = ?').get(bot.id) as {
        id: string
        name: string
      }
      expect(checkBot).toBeDefined()
      expect(checkBot.name).toBe('WAL Bot')

      // Verify all 5 migrations exist
      const migCount = bakDb.prepare('SELECT count(*) as c FROM schema_migrations').get() as {
        c: number
      }
      expect(migCount.c).toBe(5)
    } finally {
      bakDb.close()
    }
  })

  it('2. confirms that live database mutations after backup do not affect the backup file', async () => {
    const bakDir = join(tempBaseDir, 'backups')
    mkdirSync(bakDir, { recursive: true })
    const bakPath = join(bakDir, 'immutable-snapshot.sqlite')

    await manager.backup(bakPath)

    // Insert new data into live database AFTER backup is created
    const postKb = kbRepo.create({ name: 'Post-Backup KB' })

    const bakDb = new Database(bakPath, { readonly: true })
    try {
      const foundInBackup = bakDb
        .prepare('SELECT id FROM knowledge_bases WHERE id = ?')
        .get(postKb.id)
      expect(foundInBackup).toBeUndefined()
    } finally {
      bakDb.close()
    }

    // Live database contains the row
    const foundInLive = kbRepo.getById(postKb.id)
    expect(foundInLive).not.toBeNull()
    expect(foundInLive?.name).toBe('Post-Backup KB')
  })

  it('3. cleans up temporary files and leaves zero output on backup failure', async () => {
    const bakDir = join(tempBaseDir, 'backups')
    mkdirSync(bakDir, { recursive: true })
    const bakPath = join(bakDir, 'failed-snapshot.sqlite')

    // Create an invalid database connection mock or attempt invalid target
    // We can test by targeting an existing file to trigger rejection
    mkdirSync(bakPath, { recursive: true }) // make destination an existing directory

    await expect(manager.backup(bakPath)).rejects.toThrow(
      /Backup destination path cannot be an existing directory/
    )

    // Ensure no .tmp files are left behind in bakDir
    const files = readdirSync(bakDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })
})
