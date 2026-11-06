import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { runMigrations } from './migrations/runner'
import { migrations } from './migrations'
import { DatabaseManager } from './connection'
import { KnowledgeBaseRepository, BotRepository } from './repositories'

describe('SQLite Journal Modes, WAL, Backup and Restoration Evaluation (Step 2.7A)', () => {
  let tempBaseDir: string

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'wal-eval-'))
  })

  afterEach(() => {
    try {
      rmSync(tempBaseDir, { recursive: true, force: true })
    } catch {
      // Handle transient Windows file lock delays
    }
  })

  // Test A — DELETE mode baseline
  it('Test A: verifies DELETE journal mode baseline, transactions, and integrity', () => {
    const dbPath = join(tempBaseDir, 'delete-baseline.sqlite')
    const db = new Database(dbPath)

    try {
      const mode = db.pragma('journal_mode = DELETE', { simple: true })
      expect(String(mode).toLowerCase()).toBe('delete')
      db.pragma('foreign_keys = ON')

      // Run migrations on DELETE mode database
      runMigrations(db, migrations)

      // Insert baseline data
      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-del-1', 'DELETE Mode KB', 'documents/kb-del-1', now, now)

      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('bot-del-1', 'kb-del-1', 'DELETE Mode Bot', 'gpt-4o', now, now)

      // Verify row presence
      const kbCount = db.prepare('SELECT count(*) as c FROM knowledge_bases').get() as { c: number }
      expect(kbCount.c).toBe(1)

      const botCount = db.prepare('SELECT count(*) as c FROM bots').get() as { c: number }
      expect(botCount.c).toBe(1)

      // Verify integrity and foreign keys
      const integrity = db.pragma('integrity_check') as { integrity_check: string }[]
      expect(integrity[0].integrity_check).toBe('ok')

      const fkViolations = db.pragma('foreign_key_check') as unknown[]
      expect(fkViolations).toEqual([])

      // Close and reopen to verify persistence
      db.close()

      const reopenDb = new Database(dbPath)
      try {
        reopenDb.pragma('foreign_keys = ON')
        const reopenedKb = reopenDb
          .prepare('SELECT name FROM knowledge_bases WHERE id = ?')
          .get('kb-del-1') as { name: string }
        expect(reopenedKb.name).toBe('DELETE Mode KB')
      } finally {
        reopenDb.close()
      }
    } finally {
      if (db.open) {
        db.close()
      }
    }
  })

  // Test B — WAL mode activation and sidecars
  it('Test B: verifies WAL mode activation, operation, and sidecar file lifecycle', () => {
    const dbPath = join(tempBaseDir, 'wal-activation.sqlite')
    const db = new Database(dbPath)

    try {
      const mode = db.pragma('journal_mode = WAL', { simple: true })
      expect(String(mode).toLowerCase()).toBe('wal')
      db.pragma('foreign_keys = ON')

      runMigrations(db, migrations)

      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('kb-wal-1', 'WAL Mode KB', 'documents/kb-wal-1', now, now)

      // While connection is open, verify WAL and SHM sidecars
      const walPath = `${dbPath}-wal`
      const shmPath = `${dbPath}-shm`
      expect(existsSync(walPath)).toBe(true)
      expect(existsSync(shmPath)).toBe(true)

      const integrity = db.pragma('integrity_check') as { integrity_check: string }[]
      expect(integrity[0].integrity_check).toBe('ok')

      db.close()

      // After clean shutdown, verify sidecars are cleaned up by SQLite
      expect(existsSync(shmPath)).toBe(false)

      // Reopen connection and verify data remains intact
      const reopenDb = new Database(dbPath)
      try {
        reopenDb.pragma('foreign_keys = ON')
        const reopenedKb = reopenDb
          .prepare('SELECT name FROM knowledge_bases WHERE id = ?')
          .get('kb-wal-1') as { name: string }
        expect(reopenedKb.name).toBe('WAL Mode KB')
      } finally {
        reopenDb.close()
      }
    } finally {
      if (db.open) {
        db.close()
      }
    }
  })

  // Test C — Concurrent reader and writer behavior
  it('Test C: demonstrates that WAL allows concurrent readers and writers whereas DELETE blocks writers', () => {
    // 1. DELETE Mode Concurrency
    const deleteDbPath = join(tempBaseDir, 'concur-delete.sqlite')
    const setupDel = new Database(deleteDbPath)
    setupDel.pragma('journal_mode = DELETE')
    setupDel.exec(
      "CREATE TABLE items (id INT PRIMARY KEY, val TEXT); INSERT INTO items VALUES (1, 'initial');"
    )
    setupDel.close()

    const delConnA = new Database(deleteDbPath, { timeout: 50 })
    const delConnB = new Database(deleteDbPath, { timeout: 50 })

    try {
      // Reader A opens read transaction
      delConnA.exec('BEGIN DEFERRED')
      delConnA.prepare('SELECT * FROM items').all()

      // Writer B attempts write transaction while Reader A is reading
      let writerBlocked = false
      try {
        delConnB.exec('BEGIN IMMEDIATE')
        delConnB.prepare("UPDATE items SET val = 'updated-by-B' WHERE id = 1").run()
        delConnB.exec('COMMIT')
      } catch (err) {
        writerBlocked = true
        expect((err as Error).message).toMatch(/database is locked/i)
        try {
          delConnB.exec('ROLLBACK')
        } catch {
          // Ignored
        }
      }
      expect(writerBlocked).toBe(true)

      // Reader A commits and releases read lock
      delConnA.exec('COMMIT')

      // Writer B can now proceed
      delConnB.exec('BEGIN IMMEDIATE')
      delConnB.prepare("UPDATE items SET val = 'updated-by-B' WHERE id = 1").run()
      delConnB.exec('COMMIT')

      const updatedVal = delConnB.prepare('SELECT val FROM items WHERE id = 1').get() as {
        val: string
      }
      expect(updatedVal.val).toBe('updated-by-B')
    } finally {
      delConnA.close()
      delConnB.close()
    }

    // 2. WAL Mode Concurrency
    const walDbPath = join(tempBaseDir, 'concur-wal.sqlite')
    const setupWal = new Database(walDbPath)
    setupWal.pragma('journal_mode = WAL')
    setupWal.exec(
      "CREATE TABLE items (id INT PRIMARY KEY, val TEXT); INSERT INTO items VALUES (1, 'initial');"
    )
    setupWal.close()

    const walConnA = new Database(walDbPath, { timeout: 50 })
    const walConnB = new Database(walDbPath, { timeout: 50 })

    try {
      // Reader A starts read transaction
      walConnA.exec('BEGIN DEFERRED')
      const read1 = walConnA.prepare('SELECT val FROM items WHERE id = 1').get() as { val: string }
      expect(read1.val).toBe('initial')

      // Writer B writes and commits while Reader A is still in an active read transaction!
      walConnB.exec('BEGIN IMMEDIATE')
      walConnB.prepare("UPDATE items SET val = 'wal-updated' WHERE id = 1").run()
      walConnB.exec('COMMIT')

      // Reader A reads again inside active transaction: snapshot isolation (MVCC) guarantees it still sees 'initial'
      const read2 = walConnA.prepare('SELECT val FROM items WHERE id = 1').get() as { val: string }
      expect(read2.val).toBe('initial')

      // Reader A commits read transaction
      walConnA.exec('COMMIT')

      // Subsequent read by A now observes the committed value from B
      const read3 = walConnA.prepare('SELECT val FROM items WHERE id = 1').get() as { val: string }
      expect(read3.val).toBe('wal-updated')

      // 3. Writer serialization: Two simultaneous writers are still serialized by SQLite
      walConnA.exec('BEGIN IMMEDIATE')
      let secondWriterBlocked = false
      try {
        walConnB.exec('BEGIN IMMEDIATE')
      } catch (err) {
        secondWriterBlocked = true
        expect((err as Error).message).toMatch(/database is locked/i)
      }
      expect(secondWriterBlocked).toBe(true)
      walConnA.exec('COMMIT')
    } finally {
      walConnA.close()
      walConnB.close()
    }
  })

  // Test D — WAL checkpoint behavior
  it('Test D: verifies PASSIVE and TRUNCATE checkpoint mechanics in WAL mode', () => {
    const dbPath = join(tempBaseDir, 'wal-checkpoint.sqlite')
    const db = new Database(dbPath)

    try {
      db.pragma('journal_mode = WAL')
      db.exec('CREATE TABLE test_data (id INT, val TEXT);')

      // Insert records across multiple transactions
      for (let i = 0; i < 20; i++) {
        db.prepare('INSERT INTO test_data VALUES (?, ?)').run(i, `val-${i}`)
      }

      // Checkpoint 1: PASSIVE checkpoint
      const passiveResult = db.pragma('wal_checkpoint(PASSIVE)') as {
        busy: number
        log: number
        checkpointed: number
      }[]
      expect(passiveResult).toBeDefined()
      expect(passiveResult[0].busy).toBe(0)
      expect(passiveResult[0].checkpointed).toBeGreaterThanOrEqual(0)

      // Verify all committed rows remain queryable
      const count1 = db.prepare('SELECT count(*) as c FROM test_data').get() as { c: number }
      expect(count1.c).toBe(20)

      // Checkpoint 2: TRUNCATE checkpoint
      const truncateResult = db.pragma('wal_checkpoint(TRUNCATE)') as {
        busy: number
        log: number
        checkpointed: number
      }[]
      expect(truncateResult).toBeDefined()
      expect(truncateResult[0].busy).toBe(0)
      expect(truncateResult[0].log).toBe(0) // Truncated to 0 frames

      const integrity = db.pragma('integrity_check') as { integrity_check: string }[]
      expect(integrity[0].integrity_check).toBe('ok')

      const count2 = db.prepare('SELECT count(*) as c FROM test_data').get() as { c: number }
      expect(count2.c).toBe(20)
    } finally {
      db.close()
    }
  })

  // Test E & F — Online backup using better-sqlite3 & consistency verification
  it('Test E & F: verifies consistent online backup for both DELETE and WAL modes without closing connections', async () => {
    for (const mode of ['DELETE', 'WAL']) {
      const srcPath = join(tempBaseDir, `src-${mode}.sqlite`)
      const bakPath = join(tempBaseDir, `bak-${mode}.sqlite`)

      const db = new Database(srcPath)
      try {
        db.pragma(`journal_mode = ${mode}`)
        db.pragma('foreign_keys = ON')

        runMigrations(db, migrations)

        const kbRepo = new KnowledgeBaseRepository(db)
        const botRepo = new BotRepository(db)

        // Seed domain data
        const kb1 = kbRepo.create({ name: `${mode} Knowledge Base 1` })
        const kb2 = kbRepo.create({ name: `${mode} Knowledge Base 2` })

        const bot1 = botRepo.create({
          knowledgeBaseId: kb1.id,
          name: `${mode} Bot 1`,
          modelId: 'gpt-4o'
        })
        const bot2 = botRepo.create({
          knowledgeBaseId: kb2.id,
          name: `${mode} Bot 2`,
          modelId: 'claude-3-5-sonnet-20241022'
        })

        // Seed conversation and message
        const now = Date.now()
        const convId = '00000000-0000-4000-8000-000000000001'
        db.prepare(
          'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(convId, bot1.id, kb1.id, `${mode} Thread`, now, now)

        db.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('00000000-0000-4000-8000-000000000002', convId, 'user', 'Hello backup', now)

        // Keep source database open and execute online backup
        expect(db.open).toBe(true)
        await db.backup(bakPath)

        expect(existsSync(bakPath)).toBe(true)
        expect(statSync(bakPath).size).toBeGreaterThan(0)

        // Test F: Verify backup consistency and integrity with fresh connection
        const bakDb = new Database(bakPath)
        try {
          bakDb.pragma('foreign_keys = ON')

          const integrity = bakDb.pragma('integrity_check') as { integrity_check: string }[]
          expect(integrity[0].integrity_check).toBe('ok')

          const fkViolations = bakDb.pragma('foreign_key_check') as unknown[]
          expect(fkViolations).toEqual([])

          const bakKbRepo = new KnowledgeBaseRepository(bakDb)
          const bakBotRepo = new BotRepository(bakDb)

          const kbs = bakKbRepo.list()
          expect(kbs).toHaveLength(2)

          const botsInKb1 = bakBotRepo.listByKnowledgeBase(kb1.id)
          expect(botsInKb1).toHaveLength(1)
          expect(botsInKb1[0].id).toBe(bot1.id)
          expect(botsInKb1[0].name).toBe(`${mode} Bot 1`)

          const botsInKb2 = bakBotRepo.listByKnowledgeBase(kb2.id)
          expect(botsInKb2).toHaveLength(1)
          expect(botsInKb2[0].id).toBe(bot2.id)
          expect(botsInKb2[0].name).toBe(`${mode} Bot 2`)

          const messages = bakDb
            .prepare('SELECT content FROM messages WHERE conversation_id = ?')
            .all(convId) as {
            content: string
          }[]
          expect(messages).toHaveLength(1)
          expect(messages[0].content).toBe('Hello backup')
        } finally {
          bakDb.close()
        }
      } finally {
        db.close()
      }
    }
  })

  // Test G — WAL backup with uncheckpointed committed writes
  it('Test G: confirms online backup captures committed writes residing only in WAL file without explicit checkpoint', async () => {
    const srcPath = join(tempBaseDir, 'uncheckpointed-src.sqlite')
    const bakPath = join(tempBaseDir, 'uncheckpointed-bak.sqlite')

    const db = new Database(srcPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')

      runMigrations(db, migrations)
      const kbRepo = new KnowledgeBaseRepository(db)

      // Insert committed data
      const kb = kbRepo.create({ name: 'Uncheckpointed KB' })

      // Verify WAL sidecar exists and holds data
      const walFile = `${srcPath}-wal`
      expect(existsSync(walFile)).toBe(true)
      expect(statSync(walFile).size).toBeGreaterThan(0)

      // Do NOT run manual checkpoint; perform online backup directly
      await db.backup(bakPath)

      // Verify backup file contains uncheckpointed committed rows
      const bakDb = new Database(bakPath)
      try {
        bakDb.pragma('foreign_keys = ON')
        const bakKbRepo = new KnowledgeBaseRepository(bakDb)
        const fetched = bakKbRepo.getById(kb.id)
        expect(fetched).not.toBeNull()
        expect(fetched?.name).toBe('Uncheckpointed KB')

        const integrity = bakDb.pragma('integrity_check') as { integrity_check: string }[]
        expect(integrity[0].integrity_check).toBe('ok')

        const fkViolations = bakDb.pragma('foreign_key_check') as unknown[]
        expect(fkViolations).toEqual([])
      } finally {
        bakDb.close()
      }
    } finally {
      db.close()
    }
  })

  // Test H — Restoration through a fresh database
  it('Test H: evaluates cold restoration of a backup file into a fresh DatabaseManager instance', async () => {
    // 1. Source database
    const srcDir = join(tempBaseDir, 'restore-source')
    mkdirSync(srcDir)
    const srcPath = join(srcDir, 'source.sqlite')
    const bakPath = join(tempBaseDir, 'source-backup.sqlite')

    const db = new Database(srcPath)
    let seededKbId: string
    let seededBotId: string

    try {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      runMigrations(db, migrations)

      const kbRepo = new KnowledgeBaseRepository(db)
      const botRepo = new BotRepository(db)

      const kb = kbRepo.create({ name: 'Production KB to Restore' })
      const bot = botRepo.create({
        knowledgeBaseId: kb.id,
        name: 'Production Bot',
        modelId: 'gpt-4o'
      })

      seededKbId = kb.id
      seededBotId = bot.id

      await db.backup(bakPath)
    } finally {
      db.close()
    }

    // 2. Prepare clean destination userData directory
    const destUserData = join(tempBaseDir, 'restore-dest-user-data')
    const destDbDir = join(destUserData, 'database')
    mkdirSync(destDbDir, { recursive: true })
    const destDbFile = join(destDbDir, 'app.sqlite')

    // Copy backup file as app.sqlite into destination while connection is closed
    copyFileSync(bakPath, destDbFile)

    // 3. Initialize fresh DatabaseManager on destination
    const manager = new DatabaseManager()
    try {
      const initResult = manager.initialize(destUserData)
      expect(initResult.foreignKeys).toBe(true)
      expect(initResult.journalMode).toBe('wal') // Production DatabaseManager WAL mode

      const restoredDb = manager.getDatabase()

      // Re-run migration runner to confirm idempotency and version
      const migResult = runMigrations(restoredDb, migrations)
      expect(migResult.appliedCount).toBe(0)
      expect(migResult.currentVersion).toBe(migrations.length)

      const kbRepo = new KnowledgeBaseRepository(restoredDb)
      const botRepo = new BotRepository(restoredDb)

      const restoredKb = kbRepo.getById(seededKbId)
      expect(restoredKb).not.toBeNull()
      expect(restoredKb?.name).toBe('Production KB to Restore')

      const restoredBot = botRepo.getById(seededBotId, seededKbId)
      expect(restoredBot).not.toBeNull()
      expect(restoredBot?.name).toBe('Production Bot')

      const integrity = restoredDb.pragma('integrity_check') as { integrity_check: string }[]
      expect(integrity[0].integrity_check).toBe('ok')

      const fkViolations = restoredDb.pragma('foreign_key_check') as unknown[]
      expect(fkViolations).toEqual([])
    } finally {
      manager.close()
    }
  })

  // Test I — Database shutdown and sidecar lifecycle
  it('Test I: verifies sidecar creation and clean removal across connection lifecycles', () => {
    // 1. DELETE Mode Lifecycle
    const delPath = join(tempBaseDir, 'del-lifecycle.sqlite')
    const delDb = new Database(delPath)
    delDb.pragma('journal_mode = DELETE')
    delDb.exec('CREATE TABLE t (id INT); INSERT INTO t VALUES (1);')

    expect(existsSync(delPath)).toBe(true)
    expect(existsSync(`${delPath}-journal`)).toBe(false) // Rollback journal only exists during active write
    delDb.close()
    expect(existsSync(delPath)).toBe(true)
    expect(existsSync(`${delPath}-journal`)).toBe(false)

    // 2. WAL Mode Lifecycle
    const walPath = join(tempBaseDir, 'wal-lifecycle.sqlite')
    const walDb = new Database(walPath)
    walDb.pragma('journal_mode = WAL')
    walDb.exec('CREATE TABLE t (id INT); INSERT INTO t VALUES (1);')

    // While connection open, sidecars exist
    expect(existsSync(walPath)).toBe(true)
    expect(existsSync(`${walPath}-wal`)).toBe(true)
    expect(existsSync(`${walPath}-shm`)).toBe(true)

    walDb.close()

    // After normal clean close, SQLite checkpoints and cleans up SHM and WAL
    expect(existsSync(`${walPath}-shm`)).toBe(false)

    // Reopen and verify data recovered cleanly
    const walDbReopen = new Database(walPath)
    try {
      const row = walDbReopen.prepare('SELECT * FROM t').get() as { id: number }
      expect(row.id).toBe(1)
    } finally {
      walDbReopen.close()
    }
  })

  // Test J — Performance evaluation benchmark
  it('Test J: executes performance benchmark comparing DELETE and WAL modes', () => {
    function benchmarkMode(mode: 'DELETE' | 'WAL'): {
      mode: string
      insertBatchMs: number
      pointReadsMs: number
      concurrentRoundsMs: number
      concurrentWriteErrors: number
    } {
      const dbPath = join(tempBaseDir, `bench-${mode}.sqlite`)
      const db = new Database(dbPath)
      db.pragma(`journal_mode = ${mode}`)
      db.pragma('foreign_keys = ON')
      db.exec('CREATE TABLE bench_items (id INTEGER PRIMARY KEY, name TEXT, payload TEXT);')

      // Workload 1: 500 batch inserts inside transaction
      const insertStmt = db.prepare('INSERT INTO bench_items (name, payload) VALUES (?, ?)')
      const t0 = performance.now()
      const tx = db.transaction(() => {
        for (let i = 0; i < 500; i++) {
          insertStmt.run(`item-${i}`, 'benchmark-payload-data')
        }
      })
      tx()
      const insertBatchMs = performance.now() - t0

      // Workload 2: 1000 point reads
      const selectStmt = db.prepare('SELECT * FROM bench_items WHERE id = ?')
      const t1 = performance.now()
      for (let i = 1; i <= 1000; i++) {
        selectStmt.get((i % 500) + 1)
      }
      const pointReadsMs = performance.now() - t1

      // Workload 3: Concurrent reader and writer across 2 separate connections (5 rounds, 50ms timeout)
      const connReader = new Database(dbPath, { timeout: 50 })
      const connWriter = new Database(dbPath, { timeout: 50 })
      let writeErrors = 0
      const t2 = performance.now()

      for (let round = 0; round < 5; round++) {
        connReader.exec('BEGIN DEFERRED')
        connReader.prepare('SELECT count(*) FROM bench_items').get()

        try {
          connWriter
            .prepare('INSERT INTO bench_items (name, payload) VALUES (?, ?)')
            .run(`round-${round}`, 'writer-payload')
        } catch {
          writeErrors++
        }

        connReader.exec('COMMIT')
      }
      const concurrentRoundsMs = performance.now() - t2

      connReader.close()
      connWriter.close()
      db.close()

      return {
        mode,
        insertBatchMs: Math.round(insertBatchMs),
        pointReadsMs: Math.round(pointReadsMs),
        concurrentRoundsMs: Math.round(concurrentRoundsMs),
        concurrentWriteErrors: writeErrors
      }
    }

    const delMetrics = benchmarkMode('DELETE')
    const walMetrics = benchmarkMode('WAL')

    // Expectations based on SQLite architectural behavior:
    // 1. WAL mode allows concurrent writes without SQLITE_BUSY errors
    expect(walMetrics.concurrentWriteErrors).toBe(0)
    // 2. In DELETE mode, writes during active reader transactions encounter SQLITE_BUSY
    expect(delMetrics.concurrentWriteErrors).toBeGreaterThan(0)
    // 3. Both modes complete all valid benchmark operations
    expect(delMetrics.insertBatchMs).toBeGreaterThan(0)
    expect(walMetrics.insertBatchMs).toBeGreaterThan(0)
  })
})
