import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { DatabaseManager } from './connection'

describe('DatabaseManager', () => {
  let tempBaseDir: string

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `test-db-mgr-${randomUUID()}`)
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

  // Test A — Initial database creation
  it('creates the database directory and app.sqlite file on initialization', () => {
    const manager = new DatabaseManager()
    const expectedDbDir = join(tempBaseDir, 'database')
    const expectedDbFile = join(expectedDbDir, 'app.sqlite')

    expect(existsSync(expectedDbDir)).toBe(false)
    expect(existsSync(expectedDbFile)).toBe(false)

    const result = manager.initialize(tempBaseDir)

    expect(result.dbPath).toBe(expectedDbFile)
    expect(result.reusedExisting).toBe(false)
    expect(existsSync(expectedDbDir)).toBe(true)
    expect(existsSync(expectedDbFile)).toBe(true)
    expect(manager.isOpen()).toBe(true)
    expect(manager.getDatabasePath()).toBe(expectedDbFile)

    manager.close()
    expect(manager.isOpen()).toBe(false)
  })

  // Test B — Connection configuration
  it('configures foreign_keys, journal_mode DELETE, and busy_timeout 5000', () => {
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.foreignKeys).toBe(true)
    expect(result.journalMode).toBe('delete')
    expect(result.busyTimeout).toBe(5000)

    const db = manager.getDatabase()
    const fk = db.pragma('foreign_keys', { simple: true })
    const jm = db.pragma('journal_mode', { simple: true })
    const timeout = db.pragma('busy_timeout', { simple: true })

    expect(fk).toBe(1)
    expect(String(jm).toLowerCase()).toBe('delete')
    expect(Number(timeout)).toBe(5000)

    manager.close()
  })

  // Test C — Initialization idempotency
  it('reuses the active connection and does not re-open when initialized multiple times', () => {
    const manager = new DatabaseManager()
    const firstResult = manager.initialize(tempBaseDir)
    const firstDb = manager.getDatabase()

    expect(firstResult.reusedExisting).toBe(false)

    const secondResult = manager.initialize(tempBaseDir)
    const secondDb = manager.getDatabase()

    expect(secondResult.reusedExisting).toBe(true)
    expect(secondResult.dbPath).toBe(firstResult.dbPath)
    expect(secondDb).toBe(firstDb)

    manager.close()
  })

  // Test D — Database access before initialization
  it('throws an understandable error if getDatabase() or getDatabasePath() is called before initialization', () => {
    const manager = new DatabaseManager()

    expect(() => manager.getDatabase()).toThrow(
      'Database is not initialized or has been closed. Call initialize() first.'
    )
    expect(() => manager.getDatabasePath()).toThrow(
      'Database path is not available because the database is not initialized.'
    )
    expect(manager.isOpen()).toBe(false)
  })

  // Test E — Database persistence
  it('persists data across manager close and subsequent reopen on the same database file', () => {
    const manager1 = new DatabaseManager()
    manager1.initialize(tempBaseDir)

    const db1 = manager1.getDatabase()
    db1.exec(`
      CREATE TABLE test_persistence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL
      );
    `)

    const insertStmt = db1.prepare('INSERT INTO test_persistence (message) VALUES (?)')
    insertStmt.run('persisted_across_sessions')

    const count1 = db1.prepare('SELECT COUNT(*) AS total FROM test_persistence').get() as {
      total: number
    }
    expect(count1.total).toBe(1)

    manager1.close()
    expect(manager1.isOpen()).toBe(false)

    // Reopen using a fresh manager instance pointing to the same userData directory
    const manager2 = new DatabaseManager()
    manager2.initialize(tempBaseDir)
    const db2 = manager2.getDatabase()

    const count2 = db2.prepare('SELECT COUNT(*) AS total FROM test_persistence').get() as {
      total: number
    }
    expect(count2.total).toBe(1)

    const row = db2.prepare('SELECT message FROM test_persistence WHERE id = 1').get() as {
      message: string
    }
    expect(row?.message).toBe('persisted_across_sessions')

    manager2.close()
  })

  // Test F — Connection shutdown
  it('handles close cleanly, supports repeated close calls, and permits reinitialization', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)

    expect(manager.isOpen()).toBe(true)

    // First close
    manager.close()
    expect(manager.isOpen()).toBe(false)
    expect(() => manager.getDatabase()).toThrow('Database is not initialized')

    // Repeated close is harmless
    expect(() => manager.close()).not.toThrow()
    expect(manager.isOpen()).toBe(false)

    // Reinitialization after close works cleanly
    const reinitResult = manager.initialize(tempBaseDir)
    expect(reinitResult.reusedExisting).toBe(false)
    expect(manager.isOpen()).toBe(true)
    expect(manager.getDatabase().open).toBe(true)

    manager.close()
  })

  // Test G — Initialization error handling
  it('handles invalid paths safely, leaves manager in uninitialized state, and cleans up partially opened connections', () => {
    const manager = new DatabaseManager()

    // 1. Empty path validation
    expect(() => manager.initialize('')).toThrow(
      'Database initialization failed: Invalid or empty userDataPath provided.'
    )
    expect(manager.isOpen()).toBe(false)

    // 2. Path collision where a file already exists at the database folder path
    const blockingFilePath = join(tempBaseDir, 'blocking-file')
    writeFileSync(blockingFilePath, 'not a directory')

    // Attempting to use a path where mkdir fails because a regular file exists at the directory path
    const invalidUserData = join(blockingFilePath, 'sub')
    expect(() => manager.initialize(invalidUserData)).toThrow()
    expect(manager.isOpen()).toBe(false)
    expect(() => manager.getDatabase()).toThrow('Database is not initialized')
  })
})
