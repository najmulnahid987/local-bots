/**
 * Typed migration contracts and data transfer objects for the versioned
 * SQLite migration engine.
 */

export interface Migration {
  /**
   * Positive integer representing the monotonic schema version.
   * Versions must be strictly increasing.
   */
  readonly version: number

  /**
   * Unique, descriptive name for the migration (e.g. '001_initial_schema').
   */
  readonly name: string

  /**
   * Exact SQL content to execute for this migration.
   * Must not contain manual BEGIN, COMMIT, or ROLLBACK statements.
   */
  readonly sql: string

  /**
   * Optional flag for migrations requiring a SQLite 12-step table rebuild.
   * When true, the migration runner temporarily disables PRAGMA foreign_keys
   * outside the transaction, executes the migration transaction with BEGIN IMMEDIATE,
   * validates PRAGMA foreign_key_check, and guarantees foreign_keys is restored to ON
   * in a finally block.
   */
  readonly disableForeignKeysForTableRebuild?: boolean
}

export interface MigrationRecord {
  /**
   * Monotonic schema version stored in schema_migrations.
   */
  readonly version: number

  /**
   * Name of the migration stored at application time.
   */
  readonly name: string

  /**
   * Exact 64-character hex SHA-256 checksum of the migration SQL.
   */
  readonly checksum: string

  /**
   * UTC Unix timestamp (in milliseconds) when the migration was applied.
   */
  readonly applied_at: number
}

export interface MigrationStatus {
  /**
   * Total number of migrations defined in the registry.
   */
  readonly availableCount: number

  /**
   * Number of migrations already recorded in schema_migrations.
   */
  readonly appliedCount: number

  /**
   * Number of pending migrations awaiting execution.
   */
  readonly pendingCount: number

  /**
   * Highest applied schema version currently active in the database (0 if none).
   */
  readonly currentVersion: number

  /**
   * Chronological list of all applied migration records.
   */
  readonly history: readonly MigrationRecord[]
}

export interface MigrationResult {
  /**
   * Number of migrations newly applied during this execution run.
   */
  readonly appliedCount: number

  /**
   * List of version numbers that were newly applied.
   */
  readonly appliedVersions: readonly number[]

  /**
   * Final active schema version in the database after migration execution.
   */
  readonly currentVersion: number
}
