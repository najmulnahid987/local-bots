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
  validateMigrationDefinitions,
  migrations
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

describe('Migration 002: Provider Credential References Schema (Phase 3 Step 3.2)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. applies all registered migrations successfully on a fresh database with zero FK violations', () => {
    const result = runMigrations(db, migrations)
    expect(result.appliedCount).toBe(migrations.length)
    expect(result.currentVersion).toBe(migrations.length)
    expect(result.appliedVersions).toEqual(migrations.map((m) => m.version))

    const fkCheck = db.pragma('foreign_key_check') as unknown[]
    expect(fkCheck).toEqual([])
  })

  it('2. verifies provider_connections has the expected new schema columns', () => {
    runMigrations(db, migrations)

    const columns = db.prepare('PRAGMA table_info(provider_connections)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>
    const colNames = columns.map((c) => c.name)

    expect(colNames).toEqual([
      'id',
      'provider_id',
      'label',
      'credential_ref',
      'status',
      'created_at',
      'updated_at'
    ])
  })

  it('3. confirms encrypted_credentials BLOB column no longer exists in SQLite', () => {
    runMigrations(db, migrations)
    const columns = (
      db.prepare('PRAGMA table_info(provider_connections)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns.includes('encrypted_credentials')).toBe(false)
  })

  it('4. confirms key_preview column no longer exists in SQLite', () => {
    runMigrations(db, migrations)
    const columns = (
      db.prepare('PRAGMA table_info(provider_connections)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns.includes('key_preview')).toBe(false)
  })

  it('5. enforces NOT NULL constraint on credential_ref', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    expect(() => {
      db.prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('prov-1', 'openai', 'Test Key', null, 'active', now, now)
    }).toThrow(/NOT NULL constraint failed/)
  })

  it('6. rejects duplicate credential references across connections', () => {
    runMigrations(db, migrations)
    const now = Date.now()
    const duplicateRef = 'cred_11111111-1111-4111-8111-111111111111'

    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('prov-1', 'openai', 'Key 1', duplicateRef, 'active', now, now)

    expect(() => {
      db.prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('prov-2', 'anthropic', 'Key 2', duplicateRef, 'active', now, now)
    }).toThrow(/UNIQUE constraint failed/)
  })

  it('7. rejects blank or empty credential references via CHECK constraint', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    expect(() => {
      db.prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('prov-1', 'openai', 'Key 1', '   ', 'active', now, now)
    }).toThrow(/CHECK constraint failed/)
  })

  it('8. rejects invalid provider IDs via CHECK constraint', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    expect(() => {
      db.prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'prov-1',
        'unknown_vendor',
        'Key',
        'cred_22222222-2222-4222-8222-222222222222',
        'active',
        now,
        now
      )
    }).toThrow(/CHECK constraint failed/)
  })

  it('9. rejects invalid connection statuses via CHECK constraint', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    expect(() => {
      db.prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'prov-1',
        'openai',
        'Key',
        'cred_22222222-2222-4222-8222-222222222222',
        'invalid_status',
        now,
        now
      )
    }).toThrow(/CHECK constraint failed/)
  })

  it('10. verifies Bot-to-provider foreign-key relationship remains valid after migration', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    // Create KB
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

    // Valid provider connection
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'prov-valid',
      'anthropic',
      'Valid Key',
      'cred_33333333-3333-4333-8333-333333333333',
      'active',
      now,
      now
    )

    // Bot with valid provider succeeds
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'prov-valid', 'Claude Bot', 'claude-3-5-sonnet', now, now)

    // Bot with non-existent provider fails
    expect(() => {
      db.prepare(
        'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('bot-2', 'kb-1', 'prov-nonexistent', 'Ghost Bot', 'claude-3-5-sonnet', now, now)
    }).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('11. verifies a referenced provider cannot be deleted while a Bot uses it (ON DELETE RESTRICT)', () => {
    runMigrations(db, migrations)
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('kb-1', 'KB 1', 'documents/kb-1', now, now)

    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'prov-restricted',
      'openai',
      'Restricted Key',
      'cred_44444444-4444-4444-8444-444444444444',
      'active',
      now,
      now
    )

    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('bot-1', 'kb-1', 'prov-restricted', 'Attached Bot', 'gpt-4o', now, now)

    expect(() => {
      db.prepare('DELETE FROM provider_connections WHERE id = ?').run('prov-restricted')
    }).toThrow(/FOREIGN KEY constraint failed/)

    // Deleting bot unlocks provider deletion
    db.prepare('DELETE FROM bots WHERE id = ?').run('bot-1')
    const del = db.prepare('DELETE FROM provider_connections WHERE id = ?').run('prov-restricted')
    expect(del.changes).toBe(1)
  })

  it('12. idempotently recognizes migrations on subsequent startup', () => {
    const firstRun = runMigrations(db, migrations)
    expect(firstRun.appliedCount).toBe(migrations.length)

    const secondRun = runMigrations(db, migrations)
    expect(secondRun.appliedCount).toBe(0)
    expect(secondRun.currentVersion).toBe(migrations.length)
  })

  it('13. confirms migration checksums are recorded accurately', () => {
    runMigrations(db, migrations)

    const history = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number; name: string; checksum: string }>

    expect(history.length).toBe(migrations.length)
    expect(history[0].version).toBe(1)
    expect(history[0].checksum).toBe(computeChecksum(migrations[0].sql))

    expect(history[1].version).toBe(2)
    expect(history[1].name).toBe('provider_credential_refs')
    expect(history[1].checksum).toBe(computeChecksum(migrations[1].sql))

    expect(history[2].version).toBe(3)
    expect(history[2].name).toBe('knowledge_sources_lifecycle_and_fts5')
    expect(history[2].checksum).toBe(computeChecksum(migrations[2].sql))

    expect(history[3].version).toBe(4)
    expect(history[3].name).toBe('import_recovery_journal')
    expect(history[3].checksum).toBe(computeChecksum(migrations[3].sql))

    expect(history[4].version).toBe(5)
    expect(history[4].name).toBe('deletion_recovery_journal')
    expect(history[4].checksum).toBe(computeChecksum(migrations[4].sql))

    expect(history[5].version).toBe(6)
    expect(history[5].name).toBe('docx_persistence_support')
    expect(history[5].checksum).toBe(computeChecksum(migrations[5].sql))

    expect(history[6].version).toBe(7)
    expect(history[6].name).toBe('xlsx_persistence_support')
    expect(history[6].checksum).toBe(computeChecksum(migrations[6].sql))

    expect(history[7].version).toBe(8)
    expect(history[7].name).toBe('pptx_persistence_support')
    expect(history[7].checksum).toBe(computeChecksum(migrations[7].sql))
  })

  it('14. safely aborts and rolls back Migration 002 if legacy provider rows exist', () => {
    // Apply Migration 001 only
    runMigrations(db, [migrations[0]])
    const now = Date.now()

    // Insert legacy row with BLOB credentials
    db.prepare(
      'INSERT INTO provider_connections (id, provider_name, connection_name, encrypted_credentials, key_preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'legacy-prov-1',
      'openai',
      'Legacy Key',
      Buffer.from('legacy-secret-blob'),
      'sk-proj-...1234',
      now,
      now
    )

    // Attempting to apply Migration 002 must abort due to the safety guard
    expect(() => runMigrations(db, migrations)).toThrow(
      /CHECK constraint failed: legacy_rows_count = 0/
    )
  })

  it('15. verifies failed migration leaves original schema and legacy records 100% intact', () => {
    // Apply Migration 001 only
    runMigrations(db, [migrations[0]])
    const now = Date.now()
    const legacyCiphertext = Buffer.from('legacy-secret-blob-payload')

    db.prepare(
      'INSERT INTO provider_connections (id, provider_name, connection_name, encrypted_credentials, key_preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('legacy-prov-1', 'anthropic', 'Legacy Claude', legacyCiphertext, 'ant-...9876', now, now)

    // Attempt Migration 002 (should fail)
    try {
      runMigrations(db, migrations)
    } catch {
      // Expected rollback
    }

    // Verify schema_migrations is still at version 1
    const currentVersion = db.prepare('SELECT max(version) as v FROM schema_migrations').get() as {
      v: number
    }
    expect(currentVersion.v).toBe(1)

    // Verify legacy table still has encrypted_credentials column and data
    const row = db
      .prepare(
        'SELECT id, provider_name, connection_name, encrypted_credentials FROM provider_connections WHERE id = ?'
      )
      .get('legacy-prov-1') as {
      id: string
      provider_name: string
      connection_name: string
      encrypted_credentials: Buffer
    }

    expect(row).toBeDefined()
    expect(row.provider_name).toBe('anthropic')
    expect(row.connection_name).toBe('Legacy Claude')
    expect(row.encrypted_credentials.equals(legacyCiphertext)).toBe(true)

    // Confirm foreign keys remain clean
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
