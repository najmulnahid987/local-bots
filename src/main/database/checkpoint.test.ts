import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { existsSync, rmSync, mkdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DatabaseManager, WalCheckpointMode } from './connection'

describe('DatabaseManager Checkpoint Operations (Step 2.7B)', () => {
  let tempBaseDir: string

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `test-cp-mgr-${randomUUID()}`)
    mkdirSync(tempBaseDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`Failed to cleanup temp dir ${tempBaseDir}:`, err)
      }
    }
  })

  // Test 1: Default PASSIVE checkpoint
  it('1. executes default PASSIVE checkpoint successfully without arguments', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE cp_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO cp_items (title) VALUES ('item_1'), ('item_2');
    `)

    const result = manager.checkpoint()

    expect(result.mode).toBe('PASSIVE')
    expect(result.busy).toBe(0)
    expect(result.logFrames).toBeGreaterThanOrEqual(0)
    expect(result.checkpointedFrames).toBeGreaterThanOrEqual(0)
    expect(result.completed).toBe(true)

    manager.close()
  })

  // Test 2: Successful FULL checkpoint
  it('2. executes FULL checkpoint successfully', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE full_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO full_items (title) VALUES ('full_1'), ('full_2');
    `)

    const result = manager.checkpoint('FULL')

    expect(result.mode).toBe('FULL')
    expect(result.busy).toBe(0)
    expect(result.completed).toBe(true)

    manager.close()
  })

  // Test 3: Successful RESTART checkpoint when no blocking reader exists
  it('3. executes RESTART checkpoint successfully when no blocking reader exists', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE restart_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO restart_items (title) VALUES ('restart_1');
    `)

    const result = manager.checkpoint('RESTART')

    expect(result.mode).toBe('RESTART')
    expect(result.busy).toBe(0)
    expect(result.completed).toBe(true)

    manager.close()
  })

  // Test 4: Successful TRUNCATE checkpoint when no blocking reader exists
  it('4. executes TRUNCATE checkpoint successfully and resets WAL log frames to zero', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE trunc_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO trunc_items (title) VALUES ('trunc_1'), ('trunc_2');
    `)

    const walFilePath = `${manager.getDatabasePath()}-wal`
    expect(existsSync(walFilePath)).toBe(true)

    const result = manager.checkpoint('TRUNCATE')

    expect(result.mode).toBe('TRUNCATE')
    expect(result.busy).toBe(0)
    expect(result.logFrames).toBe(0)
    expect(result.checkpointedFrames).toBe(0)
    expect(result.completed).toBe(true)

    // In SQLite, TRUNCATE resets the WAL file length to 0 bytes
    if (existsSync(walFilePath)) {
      expect(statSync(walFilePath).size).toBe(0)
    }

    manager.close()
  })

  // Test 5: Invalid runtime mode rejected
  it('5. rejects invalid runtime checkpoint mode and throws descriptive error', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)

    expect(() => manager.checkpoint('INVALID_MODE' as unknown as WalCheckpointMode)).toThrow(
      /Invalid checkpoint mode 'INVALID_MODE'/i
    )

    manager.close()
  })

  // Test 6: Checkpoint without an initialized manager rejected
  it('6. rejects checkpoint attempt before DatabaseManager is initialized', () => {
    const manager = new DatabaseManager()

    expect(() => manager.checkpoint('PASSIVE')).toThrow(
      'Database is not initialized or has been closed. Call initialize() first.'
    )
  })

  // Test 7: Checkpoint after close rejected
  it('7. rejects checkpoint attempt after DatabaseManager has been closed', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    manager.close()

    expect(() => manager.checkpoint('PASSIVE')).toThrow(
      'Database is not initialized or has been closed. Call initialize() first.'
    )
  })

  // Test 8: Returned busy/log/checkpointed values are accurately mapped
  it('8. accurately maps and returns numeric busy, logFrames, and checkpointedFrames', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    // Clear WAL to baseline
    manager.checkpoint('TRUNCATE')

    // Generate write frames
    db.exec(`
      CREATE TABLE mapped_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO mapped_items (value) VALUES ('val_a');
      INSERT INTO mapped_items (value) VALUES ('val_b');
    `)

    const result = manager.checkpoint('PASSIVE')

    expect(typeof result.busy).toBe('number')
    expect(typeof result.logFrames).toBe('number')
    expect(typeof result.checkpointedFrames).toBe('number')
    expect(typeof result.completed).toBe('boolean')
    expect(result.logFrames).toBeGreaterThan(0)
    expect(result.checkpointedFrames).toBe(result.logFrames)
    expect(result.completed).toBe(true)

    manager.close()
  })

  // Test 9: Active readers do not cause the result to be falsely reported as complete
  it('9. reports incomplete when active reader blocks frames during PASSIVE checkpoint', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE active_reader_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO active_reader_items (name) VALUES ('initial');
    `)
    // Baseline checkpoint to truncate WAL
    manager.checkpoint('TRUNCATE')

    // Open second connection and hold an active read transaction
    const readerDb = new Database(manager.getDatabasePath())
    readerDb.exec('BEGIN DEFERRED')
    readerDb.prepare('SELECT * FROM active_reader_items').all()

    try {
      // Writer writes new rows to WAL while reader is reading older frame
      db.exec(`
        INSERT INTO active_reader_items (name) VALUES ('written_during_read_1');
        INSERT INTO active_reader_items (name) VALUES ('written_during_read_2');
      `)

      // Passive checkpoint cannot checkpoint newly added frames behind the active reader
      const passiveResult = manager.checkpoint('PASSIVE')

      expect(passiveResult.busy).toBe(0)
      expect(passiveResult.logFrames).toBeGreaterThan(0)
      expect(passiveResult.checkpointedFrames).toBeLessThan(passiveResult.logFrames)
      expect(passiveResult.completed).toBe(false)
    } finally {
      // Close reader transaction and connection
      readerDb.exec('COMMIT')
      readerDb.close()
    }

    // Now with reader closed, checkpoint can complete fully
    const finalResult = manager.checkpoint('TRUNCATE')
    expect(finalResult.completed).toBe(true)
    expect(finalResult.logFrames).toBe(0)

    manager.close()
  })

  // Test 10: Database integrity and data remain intact after checkpointing
  it('10. verifies database integrity and data remain completely intact after checkpointing', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)
    const db = manager.getDatabase()

    db.exec(`
      CREATE TABLE integrity_items (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    const insertStmt = db.prepare(
      'INSERT INTO integrity_items (id, data, created_at) VALUES (?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (let i = 1; i <= 50; i++) {
        insertStmt.run(i, `payload_${i}`, Date.now())
      }
    })
    tx()

    // Execute multiple checkpoints
    const resPassive = manager.checkpoint('PASSIVE')
    expect(resPassive.busy).toBe(0)

    const resTruncate = manager.checkpoint('TRUNCATE')
    expect(resTruncate.busy).toBe(0)
    expect(resTruncate.completed).toBe(true)

    // Check integrity
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    expect(integrity[0].integrity_check).toBe('ok')

    const fkCheck = db.pragma('foreign_key_check') as unknown[]
    expect(fkCheck).toEqual([])

    // Verify all 50 records exist and are unaltered
    const countRow = db.prepare('SELECT count(*) as count FROM integrity_items').get() as {
      count: number
    }
    expect(countRow.count).toBe(50)

    const sample = db.prepare('SELECT data FROM integrity_items WHERE id = 25').get() as {
      data: string
    }
    expect(sample.data).toBe('payload_25')

    manager.close()
  })
})
