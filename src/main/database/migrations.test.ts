import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  runMigrations,
  getMigrationStatus,
  ensureTrackingTable,
  computeChecksum,
  validateMigrationDefinitions
} from './migrations'
import type { Migration } from './migrations/types'
import { DatabaseManager } from './connection'

describe('Versioned SQLite Migration Engine', () => {
  let db: Database.Database
  let tempDir: string

  beforeEach(() => {
    // Isolated in-memory database with foreign keys enabled
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    tempDir = join(tmpdir(), `test-migrations-${randomUUID()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`Failed to cleanup temp dir ${tempDir}:`, err)
      }
    }
  })

  // Test A — Fresh database bootstrap
  it('bootstraps schema_migrations tracking table and creates zero domain tables on empty registry', () => {
    const result = runMigrations(db, [])

    expect(result.appliedCount).toBe(0)
    expect(result.appliedVersions).toEqual([])
    expect(result.currentVersion).toBe(0)

    // Verify schema_migrations table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get()
    expect(tableExists).toBeDefined()

    // Verify columns and constraints of schema_migrations
    const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    const colMap = new Map(columns.map((c) => [c.name, c]))
    expect(colMap.get('version')).toMatchObject({ type: 'INTEGER', pk: 1 })
    expect(colMap.get('name')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('checksum')).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(colMap.get('applied_at')).toMatchObject({ type: 'INTEGER', notnull: 1 })

    // Verify no application-domain tables exist
    const domainTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
      )
      .all()
    expect(domainTables).toEqual([])

    // Verify status inspection shows 0 applied migrations
    const status = getMigrationStatus(db, [])
    expect(status.availableCount).toBe(0)
    expect(status.appliedCount).toBe(0)
    expect(status.pendingCount).toBe(0)
    expect(status.currentVersion).toBe(0)
    expect(status.history).toEqual([])
  })

  // Test B — First migration execution
  it('applies a single test migration and records its version, name, checksum, and timestamp', () => {
    const testMigration: Migration = {
      version: 1,
      name: '001_create_test_items',
      sql: `
        CREATE TABLE test_items (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL
        );
      `
    }

    const result = runMigrations(db, [testMigration])

    expect(result.appliedCount).toBe(1)
    expect(result.appliedVersions).toEqual([1])
    expect(result.currentVersion).toBe(1)

    // Verify table was created
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_items'")
      .get()
    expect(tableCheck).toBeDefined()

    // Verify record in schema_migrations
    const record = db
      .prepare(
        'SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = 1'
      )
      .get() as { version: number; name: string; checksum: string; applied_at: number }

    expect(record.version).toBe(1)
    expect(record.name).toBe('001_create_test_items')
    expect(record.checksum).toBe(computeChecksum(testMigration.sql))
    expect(record.checksum.length).toBe(64)
    expect(record.applied_at).toBeGreaterThan(0)
  })

  // Test C — Idempotency
  it('skips already applied migrations and does not duplicate history rows or data', () => {
    const testMigration: Migration = {
      version: 1,
      name: '001_create_test_items',
      sql: `
        CREATE TABLE test_items (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL
        );
      `
    }

    // Run first time
    runMigrations(db, [testMigration])

    // Insert user data
    db.prepare('INSERT INTO test_items (id, title) VALUES (?, ?)').run(1, 'sample_item')

    // Run second time with same registry
    const secondResult = runMigrations(db, [testMigration])

    expect(secondResult.appliedCount).toBe(0)
    expect(secondResult.appliedVersions).toEqual([])
    expect(secondResult.currentVersion).toBe(1)

    // Verify record count in schema_migrations remains 1
    const countRow = db.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as {
      total: number
    }
    expect(countRow.total).toBe(1)

    // Verify user data remains intact
    const item = db.prepare('SELECT title FROM test_items WHERE id = 1').get() as { title: string }
    expect(item.title).toBe('sample_item')
  })

  // Test D — Multiple migrations
  it('executes multiple migrations in strictly ascending version order', () => {
    const migrationList: Migration[] = [
      {
        version: 1,
        name: '001_create_authors',
        sql: 'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'
      },
      {
        version: 2,
        name: '002_create_books',
        sql: `
          CREATE TABLE books (
            id INTEGER PRIMARY KEY,
            author_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            FOREIGN KEY (author_id) REFERENCES authors(id)
          );
        `
      }
    ]

    const result = runMigrations(db, migrationList)

    expect(result.appliedCount).toBe(2)
    expect(result.appliedVersions).toEqual([1, 2])
    expect(result.currentVersion).toBe(2)

    // Verify both tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('authors', 'books') ORDER BY name ASC"
      )
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(['authors', 'books'])

    // Verify schema_migrations has exactly 2 records in ascending order
    const history = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number; name: string }>
    expect(history).toEqual([
      { version: 1, name: '001_create_authors' },
      { version: 2, name: '002_create_books' }
    ])
  })

  // Test E — Transaction rollback
  it('rolls back the entire transaction if migration SQL contains a failure, leaving zero partial state', () => {
    // First, apply a valid migration 1
    const initialMigration: Migration = {
      version: 1,
      name: '001_initial',
      sql: 'CREATE TABLE valid_table (id INTEGER PRIMARY KEY, title TEXT NOT NULL);'
    }
    runMigrations(db, [initialMigration])

    // Create a flawed migration 2 that creates a table and then fails
    const failingMigration: Migration = {
      version: 2,
      name: '002_broken',
      sql: `
        CREATE TABLE should_be_rolled_back (id INTEGER PRIMARY KEY);
        THIS_IS_INTENTIONALLY_INVALID_SQL_SYNTAX;
      `
    }

    expect(() => runMigrations(db, [initialMigration, failingMigration])).toThrow()

    // Table from failing migration must not exist
    const checkTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_be_rolled_back'")
      .get()
    expect(checkTable).toBeUndefined()

    // Migration 2 must not be recorded
    const history = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number
    }>
    expect(history.map((h) => h.version)).toEqual([1])

    // Earlier migration remains intact
    const validTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='valid_table'")
      .get()
    expect(validTable).toBeDefined()
  })

  // Test F — Checksum mismatch
  it('throws an error and halts if an already applied migration has modified SQL content', () => {
    const originalMigration: Migration = {
      version: 1,
      name: '001_items',
      sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY);'
    }
    runMigrations(db, [originalMigration])

    // Tampered migration with identical version and name but different SQL
    const tamperedMigration: Migration = {
      version: 1,
      name: '001_items',
      sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, tampered_column TEXT);'
    }

    expect(() => runMigrations(db, [tamperedMigration])).toThrow(/Migration checksum mismatch/)

    // History record in database must remain unchanged
    const record = db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get() as {
      checksum: string
    }
    expect(record.checksum).toBe(computeChecksum(originalMigration.sql))
  })

  // Test G — Unknown applied version
  it('fails safely if the database contains a migration version newer than the application registry', () => {
    ensureTrackingTable(db)
    // Manually insert an unknown future migration version
    db.prepare(
      `
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (99, '099_future_migration', '${'a'.repeat(64)}', ${Date.now()});
    `
    ).run()

    expect(() => runMigrations(db, [])).toThrow(/Unsupported database schema/)

    // Record must not be deleted or altered
    const record = db.prepare('SELECT version FROM schema_migrations WHERE version = 99').get()
    expect(record).toBeDefined()
  })

  // Test H — Duplicate and invalid definitions
  it('rejects invalid migration definitions before any execution', () => {
    // 1. Non-positive or non-integer version
    expect(() =>
      validateMigrationDefinitions([{ version: 0, name: 'zero', sql: 'SELECT 1;' }])
    ).toThrow(/version must be a positive integer/)

    expect(() =>
      validateMigrationDefinitions([{ version: -1, name: 'neg', sql: 'SELECT 1;' }])
    ).toThrow(/version must be a positive integer/)

    expect(() =>
      validateMigrationDefinitions([{ version: 1.5, name: 'float', sql: 'SELECT 1;' }])
    ).toThrow(/version must be a positive integer/)

    // 2. Empty name
    expect(() =>
      validateMigrationDefinitions([{ version: 1, name: '   ', sql: 'SELECT 1;' }])
    ).toThrow(/name must be a non-empty string/)

    // 3. Empty SQL
    expect(() => validateMigrationDefinitions([{ version: 1, name: 'valid', sql: '   ' }])).toThrow(
      /SQL content must be a non-empty string/
    )

    // 4. Duplicate version
    expect(() =>
      validateMigrationDefinitions([
        { version: 1, name: 'first', sql: 'SELECT 1;' },
        { version: 1, name: 'second', sql: 'SELECT 2;' }
      ])
    ).toThrow(/Duplicate migration version detected: version 1/)

    // 5. Duplicate name
    expect(() =>
      validateMigrationDefinitions([
        { version: 1, name: 'same_name', sql: 'SELECT 1;' },
        { version: 2, name: 'same_name', sql: 'SELECT 2;' }
      ])
    ).toThrow(/Duplicate migration name detected: name 'same_name'/)

    // 6. Out-of-order versions
    expect(() =>
      validateMigrationDefinitions([
        { version: 2, name: 'two', sql: 'SELECT 2;' },
        { version: 1, name: 'one', sql: 'SELECT 1;' }
      ])
    ).toThrow(/Migrations out of order/)
  })

  // Test I — Foreign-key configuration check
  it('throws an error if foreign keys are disabled on the database connection', () => {
    db.pragma('foreign_keys = OFF')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0)

    expect(() => runMigrations(db, [])).toThrow(/PRAGMA foreign_keys is not enabled/)
    // Must not have silently enabled foreign keys
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
  })

  // Test J — Migration persistence
  it('persists migration history across connection restarts using DatabaseManager', () => {
    const manager = new DatabaseManager()
    manager.initialize(tempDir)
    const fileDb1 = manager.getDatabase()

    const testMigration: Migration = {
      version: 1,
      name: '001_persisted_table',
      sql: 'CREATE TABLE persisted_table (id INTEGER PRIMARY KEY, note TEXT NOT NULL);'
    }

    const firstRun = runMigrations(fileDb1, [testMigration])
    expect(firstRun.appliedCount).toBe(1)
    expect(firstRun.currentVersion).toBe(1)

    // Insert data into persisted table
    fileDb1.prepare('INSERT INTO persisted_table (note) VALUES (?)').run('saved note')

    // Close manager connection
    manager.close()

    // Reopen connection against same temp directory
    manager.initialize(tempDir)
    const fileDb2 = manager.getDatabase()

    // Run migration runner again with the same registry
    const secondRun = runMigrations(fileDb2, [testMigration])
    expect(secondRun.appliedCount).toBe(0)
    expect(secondRun.currentVersion).toBe(1)

    // Verify table and data persisted
    const row = fileDb2.prepare('SELECT note FROM persisted_table WHERE id = 1').get() as {
      note: string
    }
    expect(row.note).toBe('saved note')

    manager.close()
  })
})
