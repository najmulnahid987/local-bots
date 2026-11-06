import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DatabaseManager } from './connection'

describe('DatabaseManager Connection Lifecycle and WAL Configuration (Step 2.7B)', () => {
  let tempBaseDir: string

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `test-db-mgr-${randomUUID()}`)
    mkdirSync(tempBaseDir, { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`Failed to cleanup temp dir ${tempBaseDir}:`, err)
      }
    }
  })

  // Test 1: Fresh database initializes successfully in WAL mode
  it('1. fresh database initializes successfully in WAL mode', () => {
    const manager = new DatabaseManager()
    const expectedDbDir = join(tempBaseDir, 'database')
    const expectedDbFile = join(expectedDbDir, 'app.sqlite')

    expect(existsSync(expectedDbDir)).toBe(false)
    expect(existsSync(expectedDbFile)).toBe(false)

    const result = manager.initialize(tempBaseDir)

    expect(result.dbPath).toBe(expectedDbFile)
    expect(result.reusedExisting).toBe(false)
    expect(result.journalMode).toBe('wal')
    expect(existsSync(expectedDbDir)).toBe(true)
    expect(existsSync(expectedDbFile)).toBe(true)
    expect(manager.isOpen()).toBe(true)
    expect(manager.getDatabasePath()).toBe(expectedDbFile)

    const db = manager.getDatabase()
    const jm = db.pragma('journal_mode', { simple: true })
    expect(String(jm).toLowerCase()).toBe('wal')

    manager.close()
    expect(manager.isOpen()).toBe(false)
  })

  // Test 2: Existing database is converted from DELETE to WAL without losing records
  it('2. existing database is converted from DELETE to WAL without losing records', () => {
    const dbDir = join(tempBaseDir, 'database')
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'app.sqlite')

    // Create legacy database explicitly in DELETE mode
    const legacyDb = new Database(dbPath)
    legacyDb.pragma('journal_mode = DELETE')
    expect(String(legacyDb.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete')
    legacyDb.exec(`
      CREATE TABLE legacy_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO legacy_items (title) VALUES ('existing_item_alpha');
      INSERT INTO legacy_items (title) VALUES ('existing_item_beta');
    `)
    legacyDb.close()

    // Initialize through DatabaseManager
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.journalMode).toBe('wal')
    expect(result.reusedExisting).toBe(false)

    const db = manager.getDatabase()
    const jm = db.pragma('journal_mode', { simple: true })
    expect(String(jm).toLowerCase()).toBe('wal')

    // Verify all existing records survived conversion
    const rows = db.prepare('SELECT title FROM legacy_items ORDER BY id ASC').all() as Array<{
      title: string
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0].title).toBe('existing_item_alpha')
    expect(rows[1].title).toBe('existing_item_beta')

    manager.close()
  })

  // Test 3: Reinitialization remains idempotent
  it('3. reinitialization remains idempotent and reuses active connection', () => {
    const manager = new DatabaseManager()
    const firstResult = manager.initialize(tempBaseDir)
    const firstDb = manager.getDatabase()

    expect(firstResult.reusedExisting).toBe(false)
    expect(firstResult.journalMode).toBe('wal')

    const secondResult = manager.initialize(tempBaseDir)
    const secondDb = manager.getDatabase()

    expect(secondResult.reusedExisting).toBe(true)
    expect(secondResult.dbPath).toBe(firstResult.dbPath)
    expect(secondResult.journalMode).toBe('wal')
    expect(secondResult.synchronous).toBe(2)
    expect(secondResult.busyTimeout).toBe(5000)
    expect(secondResult.walAutoCheckpoint).toBe(1000)
    expect(secondDb).toBe(firstDb)

    manager.close()
  })

  // Test 4: Foreign keys are enabled
  it('4. foreign keys are enabled and enforced on connection', () => {
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.foreignKeys).toBe(true)

    const db = manager.getDatabase()
    const fkValue = db.pragma('foreign_keys', { simple: true })
    expect(fkValue).toBe(1)

    // Enforce foreign key constraints actively
    db.exec(`
      CREATE TABLE parent_t (id INTEGER PRIMARY KEY);
      CREATE TABLE child_t (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent_t(id));
      INSERT INTO parent_t (id) VALUES (1);
    `)
    expect(() => db.exec('INSERT INTO child_t (id, parent_id) VALUES (10, 999);')).toThrow(
      /FOREIGN KEY constraint failed/i
    )

    manager.close()
  })

  // Test 5: Synchronous mode is FULL
  it('5. synchronous mode is FULL (numeric 2)', () => {
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.synchronous).toBe(2)

    const db = manager.getDatabase()
    const syncValue = db.pragma('synchronous', { simple: true })
    expect(syncValue).toBe(2)

    manager.close()
  })

  // Test 6: Busy timeout is 5000
  it('6. busy timeout is configured and verified at 5000 ms', () => {
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.busyTimeout).toBe(5000)

    const db = manager.getDatabase()
    const timeoutValue = db.pragma('busy_timeout', { simple: true })
    expect(Number(timeoutValue)).toBe(5000)

    manager.close()
  })

  // Test 7: Automatic checkpoint is 1000
  it('7. automatic checkpoint is configured and verified at 1000 pages', () => {
    const manager = new DatabaseManager()
    const result = manager.initialize(tempBaseDir)

    expect(result.walAutoCheckpoint).toBe(1000)

    const db = manager.getDatabase()
    const cpValue = db.pragma('wal_autocheckpoint', { simple: true })
    expect(Number(cpValue)).toBe(1000)

    manager.close()
  })

  // Test 8: Connection closes normally
  it('8. connection closes normally, supports repeated close calls, and permits reinitialization', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempBaseDir)

    expect(manager.isOpen()).toBe(true)

    // First close
    manager.close()
    expect(manager.isOpen()).toBe(false)
    expect(() => manager.getDatabase()).toThrow(
      'Database is not initialized or has been closed. Call initialize() first.'
    )
    expect(() => manager.getDatabasePath()).toThrow(
      'Database path is not available because the database is not initialized.'
    )

    // Repeated close is completely safe
    expect(() => manager.close()).not.toThrow()
    expect(manager.isOpen()).toBe(false)

    // Reinitialization after close works cleanly
    const reinitResult = manager.initialize(tempBaseDir)
    expect(reinitResult.reusedExisting).toBe(false)
    expect(manager.isOpen()).toBe(true)
    expect(manager.getDatabase().open).toBe(true)

    manager.close()
  })

  // Test 9: Reopening preserves data and WAL mode
  it('9. reopening preserves data and WAL mode across separate manager instances', () => {
    const manager1 = new DatabaseManager()
    manager1.initialize(tempBaseDir)

    const db1 = manager1.getDatabase()
    db1.exec(`
      CREATE TABLE session_data (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
      INSERT INTO session_data (note) VALUES ('written_in_session_1');
    `)

    manager1.close()
    expect(manager1.isOpen()).toBe(false)

    // Second manager opens same database file
    const manager2 = new DatabaseManager()
    const init2 = manager2.initialize(tempBaseDir)

    expect(init2.journalMode).toBe('wal')
    const db2 = manager2.getDatabase()
    expect(String(db2.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')

    const row = db2.prepare('SELECT note FROM session_data WHERE id = 1').get() as {
      note: string
    }
    expect(row?.note).toBe('written_in_session_1')

    manager2.close()
  })

  // Test 10: Failed WAL activation does not leave a partially initialized manager
  it('10. failed WAL activation does not leave a partially initialized manager', () => {
    const origPragma = Database.prototype.pragma
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      ...args: unknown[]
    ) {
      if (typeof sql === 'string' && sql.includes('journal_mode = WAL')) {
        return 'delete' // Simulate failure to switch to WAL mode
      }
      return origPragma.call(this, sql, ...(args as [never]))
    })

    const manager = new DatabaseManager()
    expect(() => manager.initialize(tempBaseDir)).toThrow(
      /SQLite connection verification failed: PRAGMA journal_mode returned 'delete', expected 'wal'/i
    )

    expect(manager.isOpen()).toBe(false)
    expect(() => manager.getDatabase()).toThrow(
      'Database is not initialized or has been closed. Call initialize() first.'
    )
    expect(() => manager.getDatabasePath()).toThrow(
      'Database path is not available because the database is not initialized.'
    )
  })
})
