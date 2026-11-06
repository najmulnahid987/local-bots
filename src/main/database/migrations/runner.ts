import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Migration, MigrationRecord, MigrationResult, MigrationStatus } from './types'

/**
 * Calculates the exact 64-character lowercase hex SHA-256 checksum
 * of the raw UTF-8 SQL string.
 */
export function computeChecksum(sql: string): string {
  if (typeof sql !== 'string') {
    throw new TypeError('Expected SQL content to be a string.')
  }
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Ensures the schema_migrations tracking table exists in the database.
 * This is database infrastructure and not an application domain migration.
 */
export function ensureTrackingTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      CHECK (version > 0),
      CHECK (length(checksum) = 64)
    );
  `)
}

/**
 * Validates the syntax, uniqueness, and ordering constraints of a migration registry
 * before any migration execution begins.
 */
export function validateMigrationDefinitions(migrationsList: readonly Migration[]): void {
  const seenVersions = new Set<number>()
  const seenNames = new Set<string>()

  for (let i = 0; i < migrationsList.length; i++) {
    const migration = migrationsList[i]

    // 1. Version must be a positive integer
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(
        `Invalid migration at index ${i}: version must be a positive integer, got ${migration.version}.`
      )
    }

    // 2. Name must be non-empty
    if (typeof migration.name !== 'string' || migration.name.trim().length === 0) {
      throw new Error(
        `Invalid migration version ${migration.version}: name must be a non-empty string.`
      )
    }

    // 3. SQL content must be non-empty
    if (typeof migration.sql !== 'string' || migration.sql.trim().length === 0) {
      throw new Error(
        `Invalid migration version ${migration.version} ('${migration.name}'): SQL content must be a non-empty string.`
      )
    }

    // 4. Versions must be unique
    if (seenVersions.has(migration.version)) {
      throw new Error(`Duplicate migration version detected: version ${migration.version}.`)
    }
    seenVersions.add(migration.version)

    // 5. Names must be unique
    if (seenNames.has(migration.name)) {
      throw new Error(`Duplicate migration name detected: name '${migration.name}'.`)
    }
    seenNames.add(migration.name)

    // 6. Ordered by strictly increasing version
    if (i > 0 && migration.version <= migrationsList[i - 1].version) {
      throw new Error(
        `Migrations out of order: version ${migration.version} must be strictly greater than preceding version ${migrationsList[i - 1].version}.`
      )
    }
  }
}

/**
 * Asserts that foreign keys are enabled on the database connection.
 * The migration runner must not silently enable foreign keys itself if the
 * database manager failed to configure them.
 */
export function assertForeignKeysEnabled(db: Database.Database): void {
  const fkValue = db.pragma('foreign_keys', { simple: true })
  if (fkValue !== 1) {
    throw new Error(
      `MigrationRunner cannot execute: PRAGMA foreign_keys is not enabled (expected 1, got ${fkValue}).`
    )
  }
}

/**
 * Reads all applied migration records from schema_migrations in ascending version order.
 */
export function readAppliedMigrations(db: Database.Database): MigrationRecord[] {
  ensureTrackingTable(db)
  const stmt = db.prepare(`
    SELECT version, name, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC;
  `)
  return stmt.all() as MigrationRecord[]
}

/**
 * Validates previously applied migrations against the currently registered migrations:
 * - Ensures each applied migration exists in the current registry.
 * - Confirms stored names match registered names.
 * - Verifies stored checksums match the recalculated SHA-256 of registered SQL.
 */
export function verifyMigrationHistory(
  applied: readonly MigrationRecord[],
  definedList: readonly Migration[]
): void {
  const definedMap = new Map<number, Migration>()
  for (const m of definedList) {
    definedMap.set(m.version, m)
  }

  for (const record of applied) {
    const defined = definedMap.get(record.version)
    if (!defined) {
      throw new Error(
        `Unsupported database schema: migration version ${record.version} ('${record.name}') exists in the database but is not defined in the current migration registry.`
      )
    }

    if (defined.name !== record.name) {
      throw new Error(
        `Migration name mismatch for version ${record.version}: database has '${record.name}', but registry has '${defined.name}'.`
      )
    }

    const expectedChecksum = computeChecksum(defined.sql)
    if (expectedChecksum !== record.checksum) {
      throw new Error(
        `Migration checksum mismatch for version ${record.version} ('${record.name}'): stored checksum is '${record.checksum}', but source checksum is '${expectedChecksum}'.`
      )
    }
  }
}

/**
 * Inspects and returns the current migration status of the database.
 */
export function getMigrationStatus(
  db: Database.Database,
  migrationsList: readonly Migration[] = []
): MigrationStatus {
  validateMigrationDefinitions(migrationsList)
  ensureTrackingTable(db)
  const history = readAppliedMigrations(db)
  verifyMigrationHistory(history, migrationsList)

  const appliedCount = history.length
  const availableCount = migrationsList.length
  const pendingCount = Math.max(0, availableCount - appliedCount)
  const currentVersion = history.length > 0 ? history[history.length - 1].version : 0

  return {
    availableCount,
    appliedCount,
    pendingCount,
    currentVersion,
    history
  }
}

/**
 * Executes all pending migrations transactionally against the provided database connection.
 *
 * Each pending migration is executed inside a synchronous immediate transaction
 * (`db.transaction(...).immediate()`).
 * If an error occurs, the transaction rolls back cleanly, leaving zero partial state.
 */
export function runMigrations(
  db: Database.Database,
  migrationsList: readonly Migration[] = []
): MigrationResult {
  // 1. Verify foreign keys pragma is active
  assertForeignKeysEnabled(db)

  // 2. Validate migration registry integrity
  validateMigrationDefinitions(migrationsList)

  // 3. Ensure schema_migrations exists
  ensureTrackingTable(db)

  // 4. Read applied history and verify checksum integrity
  const applied = readAppliedMigrations(db)
  verifyMigrationHistory(applied, migrationsList)

  const appliedVersionsSet = new Set(applied.map((r) => r.version))
  const pendingMigrations = migrationsList.filter((m) => !appliedVersionsSet.has(m.version))

  const newlyAppliedVersions: number[] = []

  // Prepared insert statement for recording applied migrations
  const insertStmt = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?);
  `)

  // 5. Execute each pending migration inside an immediate transaction
  for (const migration of pendingMigrations) {
    const executeTx = db.transaction(() => {
      // Execute the migration DDL/DML
      db.exec(migration.sql)

      // Calculate checksum and record
      const checksum = computeChecksum(migration.sql)
      const appliedAt = Date.now()
      insertStmt.run(migration.version, migration.name, checksum, appliedAt)
    })

    // Execute with BEGIN IMMEDIATE
    executeTx.immediate()
    newlyAppliedVersions.push(migration.version)
  }

  // Determine current active version
  const finalHistory = readAppliedMigrations(db)
  const currentVersion = finalHistory.length > 0 ? finalHistory[finalHistory.length - 1].version : 0

  return {
    appliedCount: newlyAppliedVersions.length,
    appliedVersions: newlyAppliedVersions,
    currentVersion
  }
}
