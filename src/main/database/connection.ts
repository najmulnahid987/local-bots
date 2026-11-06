import Database from 'better-sqlite3'
import { join, resolve, dirname, basename, isAbsolute } from 'path'
import { existsSync, mkdirSync, renameSync, statSync, lstatSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

export interface DatabaseInitResult {
  dbPath: string
  foreignKeys: boolean
  journalMode: string
  synchronous: number
  busyTimeout: number
  walAutoCheckpoint: number
  reusedExisting: boolean
}

export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'

export interface WalCheckpointResult {
  mode: WalCheckpointMode
  busy: number
  logFrames: number
  checkpointedFrames: number
  completed: boolean
}

export interface DatabaseBackupResult {
  destinationPath: string
  completedAt: number
  sizeBytes: number
  integrityVerified: boolean
}

const ALLOWED_CHECKPOINT_MODES: ReadonlySet<WalCheckpointMode> = new Set([
  'PASSIVE',
  'FULL',
  'RESTART',
  'TRUNCATE'
])

const REQUIRED_APPLICATION_TABLES: readonly string[] = [
  'agent_runs',
  'app_settings',
  'bot_memories',
  'bots',
  'conversations',
  'knowledge_bases',
  'knowledge_chunks',
  'knowledge_sources',
  'messages',
  'provider_connections',
  'tool_events'
]

/**
 * Manages the lifecycle of the single persistent SQLite database connection
 * in the Electron Main process.
 *
 * Enforces:
 * - Single connection per process.
 * - Production database located at `<userData>/database/app.sqlite`.
 * - PRAGMA foreign_keys = ON (verified 1).
 * - PRAGMA journal_mode = WAL (verified 'wal').
 * - PRAGMA synchronous = FULL (verified 2).
 * - PRAGMA busy_timeout = 5000 (verified 5000).
 * - PRAGMA wal_autocheckpoint = 1000 (verified 1000).
 * - Safe internal checkpointing (`checkpoint()`).
 * - Safe asynchronous online backup (`backup()`).
 */
export class DatabaseManager {
  private db: Database.Database | null = null
  private dbPath: string | null = null
  private isBackupInProgress: boolean = false

  /**
   * Initializes the persistent SQLite database connection in <userDataPath>/database/app.sqlite.
   * Enforces single-connection idempotency, foreign key verification, WAL journal mode,
   * synchronous FULL durability, busy timeout, and automatic checkpoint threshold.
   */
  public initialize(userDataPath: string): DatabaseInitResult {
    if (!userDataPath || typeof userDataPath !== 'string' || userDataPath.trim().length === 0) {
      throw new Error('Database initialization failed: Invalid or empty userDataPath provided.')
    }

    // Idempotency: Return existing connection if already open
    if (this.db && this.db.open && this.dbPath) {
      const currentFk = this.db.pragma('foreign_keys', { simple: true })
      const currentJournal = this.db.pragma('journal_mode', { simple: true })
      const currentSync = this.db.pragma('synchronous', { simple: true })
      const currentTimeout = this.db.pragma('busy_timeout', { simple: true })
      const currentAutoCp = this.db.pragma('wal_autocheckpoint', { simple: true })

      return {
        dbPath: this.dbPath,
        foreignKeys: currentFk === 1,
        journalMode: String(currentJournal).toLowerCase(),
        synchronous: Number(currentSync),
        busyTimeout: Number(currentTimeout),
        walAutoCheckpoint: Number(currentAutoCp),
        reusedExisting: true
      }
    }

    // If a previous instance is closed or partially uninitialized, ensure state is reset
    this.close()

    const databaseDir = join(userDataPath, 'database')
    const databaseFilePath = join(databaseDir, 'app.sqlite')

    let connection: Database.Database | null = null

    try {
      if (!existsSync(databaseDir)) {
        mkdirSync(databaseDir, { recursive: true })
      }

      connection = new Database(databaseFilePath, { timeout: 5000 })

      // 1. Configure and verify foreign keys
      connection.pragma('foreign_keys = ON')
      const fkValue = connection.pragma('foreign_keys', { simple: true })
      if (fkValue !== 1) {
        throw new Error(
          `SQLite connection verification failed: PRAGMA foreign_keys returned ${fkValue}, expected 1.`
        )
      }

      // 2. Configure and verify journal mode (WAL mode)
      const journalModeValue = connection.pragma('journal_mode = WAL', { simple: true })
      const normalizedJournalMode = String(journalModeValue).toLowerCase()
      if (normalizedJournalMode !== 'wal') {
        throw new Error(
          `SQLite connection verification failed: PRAGMA journal_mode returned '${journalModeValue}', expected 'wal'.`
        )
      }

      // 3. Configure and verify synchronous mode (FULL = 2)
      connection.pragma('synchronous = FULL')
      const syncValue = connection.pragma('synchronous', { simple: true })
      const syncNumber = Number(syncValue)
      if (syncNumber !== 2) {
        throw new Error(
          `SQLite connection verification failed: PRAGMA synchronous returned ${syncValue}, expected 2.`
        )
      }

      // 4. Configure and verify busy timeout (5000 ms)
      connection.pragma('busy_timeout = 5000')
      const busyTimeoutValue = connection.pragma('busy_timeout', { simple: true })
      const timeoutNumber = Number(busyTimeoutValue)
      if (timeoutNumber !== 5000) {
        throw new Error(
          `SQLite connection verification failed: PRAGMA busy_timeout returned ${busyTimeoutValue}, expected 5000.`
        )
      }

      // 5. Configure and verify automatic checkpoint (1000 pages)
      connection.pragma('wal_autocheckpoint = 1000')
      const autoCpValue = connection.pragma('wal_autocheckpoint', { simple: true })
      const autoCpNumber = Number(autoCpValue)
      if (autoCpNumber !== 1000) {
        throw new Error(
          `SQLite connection verification failed: PRAGMA wal_autocheckpoint returned ${autoCpValue}, expected 1000.`
        )
      }

      this.db = connection
      this.dbPath = databaseFilePath

      return {
        dbPath: databaseFilePath,
        foreignKeys: true,
        journalMode: normalizedJournalMode,
        synchronous: syncNumber,
        busyTimeout: timeoutNumber,
        walAutoCheckpoint: autoCpNumber,
        reusedExisting: false
      }
    } catch (error) {
      if (connection) {
        try {
          connection.close()
        } catch {
          // Ignore cleanup error on failed teardown
        }
      }
      this.db = null
      this.dbPath = null
      this.isBackupInProgress = false
      throw error instanceof Error
        ? error
        : new Error(`Database initialization failed unexpectedly: ${String(error)}`)
    }
  }

  /**
   * Returns the active database instance.
   * Throws an error if called before initialize() or after close().
   */
  public getDatabase(): Database.Database {
    if (!this.db || !this.db.open) {
      throw new Error('Database is not initialized or has been closed. Call initialize() first.')
    }
    return this.db
  }

  /**
   * Returns the absolute file path of the managed SQLite database.
   * Throws an error if the manager is not initialized.
   */
  public getDatabasePath(): string {
    if (!this.dbPath) {
      throw new Error('Database path is not available because the database is not initialized.')
    }
    return this.dbPath
  }

  /**
   * Returns whether the database connection is currently open.
   */
  public isOpen(): boolean {
    return Boolean(this.db && this.db.open)
  }

  /**
   * Executes a WAL checkpoint operation using the specified allowlisted mode.
   * Internal Main-process only: must not be exposed over IPC.
   *
   * @param mode Checkpoint mode: 'PASSIVE' (default), 'FULL', 'RESTART', or 'TRUNCATE'.
   * @returns Typed result with busy flag, log frame count, checkpointed frame count, and completion status.
   */
  public checkpoint(mode: WalCheckpointMode = 'PASSIVE'): WalCheckpointResult {
    if (!this.db || !this.db.open || !this.dbPath) {
      throw new Error('Database is not initialized or has been closed. Call initialize() first.')
    }

    const currentJm = String(this.db.pragma('journal_mode', { simple: true })).toLowerCase()
    if (currentJm !== 'wal') {
      throw new Error(`Checkpoint requires WAL journal mode, but found '${currentJm}'.`)
    }

    if (!ALLOWED_CHECKPOINT_MODES.has(mode)) {
      throw new Error(
        `Invalid checkpoint mode '${mode}'. Allowed modes: ${Array.from(ALLOWED_CHECKPOINT_MODES).join(', ')}.`
      )
    }

    const rows = this.db.pragma(`wal_checkpoint(${mode})`) as Array<{
      busy: number
      log: number
      checkpointed: number
    }>

    if (!rows || rows.length === 0) {
      return {
        mode,
        busy: 0,
        logFrames: 0,
        checkpointedFrames: 0,
        completed: false
      }
    }

    const { busy, log, checkpointed } = rows[0]
    const busyNum = Number(busy)
    const logNum = Number(log)
    const checkpointedNum = Number(checkpointed)

    // Checkpoint completed if not busy and either:
    // - for TRUNCATE: log frames truncated to 0
    // - for PASSIVE/FULL/RESTART: all frames checkpointed or WAL already empty
    const completed =
      busyNum === 0 &&
      (mode === 'TRUNCATE' ? logNum === 0 : logNum === 0 || checkpointedNum >= logNum)

    return {
      mode,
      busy: busyNum,
      logFrames: logNum,
      checkpointedFrames: checkpointedNum,
      completed
    }
  }

  /**
   * Creates a safe, validated online backup of the active database using SQLite's native backup API.
   * Backs up to a unique temporary file in the destination's directory, verifies foreign keys,
   * schema integrity, and tables via a separate read-only connection, and atomically moves to destination.
   *
   * Internal Main-process only: must never be exposed directly to Renderer or IPC.
   *
   * @param destinationPath Target absolute file path for the backup file.
   * @returns Typed backup metadata.
   */
  public async backup(destinationPath: string): Promise<DatabaseBackupResult> {
    if (!this.db || !this.db.open || !this.dbPath) {
      throw new Error('Database is not initialized or has been closed. Call initialize() first.')
    }

    const currentJm = String(this.db.pragma('journal_mode', { simple: true })).toLowerCase()
    if (currentJm !== 'wal') {
      throw new Error(`Backup requires WAL journal mode, but found '${currentJm}'.`)
    }

    if (this.db.inTransaction) {
      throw new Error('Cannot perform database backup while an active transaction is open.')
    }

    if (this.isBackupInProgress) {
      throw new Error('A database backup is already in progress.')
    }

    if (
      !destinationPath ||
      typeof destinationPath !== 'string' ||
      destinationPath.trim().length === 0
    ) {
      throw new Error('Backup destination path must be a non-empty string.')
    }

    if (!isAbsolute(destinationPath)) {
      throw new Error(`Backup destination path must be an absolute path: '${destinationPath}'.`)
    }

    const normalizedDestination = resolve(destinationPath)
    const parentDir = dirname(normalizedDestination)

    if (!existsSync(parentDir)) {
      throw new Error(`Backup destination parent directory does not exist: '${parentDir}'.`)
    }

    const parentStat = statSync(parentDir)
    if (!parentStat.isDirectory()) {
      throw new Error(`Backup destination parent path is not a directory: '${parentDir}'.`)
    }

    if (lstatSync(parentDir).isSymbolicLink()) {
      throw new Error('Backup destination parent directory must not be a symbolic link.')
    }

    // Check forbidden paths (source DB and its auxiliary sidecars) first
    const normDbPath = resolve(this.dbPath)
    const forbiddenPaths = [
      normDbPath,
      `${normDbPath}-wal`,
      `${normDbPath}-shm`,
      `${normDbPath}-journal`
    ]
    const isSameFile = (p1: string, p2: string): boolean =>
      process.platform === 'win32' ? p1.toLowerCase() === p2.toLowerCase() : p1 === p2

    for (const forbidden of forbiddenPaths) {
      if (isSameFile(forbidden, normalizedDestination)) {
        throw new Error(
          'Backup destination path cannot be the source database or its auxiliary sidecar files.'
        )
      }
    }

    try {
      const destLstat = lstatSync(normalizedDestination)
      if (destLstat.isSymbolicLink()) {
        throw new Error('Backup destination path must not be a symbolic link.')
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    if (existsSync(normalizedDestination)) {
      if (statSync(normalizedDestination).isDirectory()) {
        throw new Error(
          `Backup destination path cannot be an existing directory: '${normalizedDestination}'.`
        )
      }
      throw new Error(`Backup destination file already exists: '${normalizedDestination}'.`)
    }

    this.isBackupInProgress = true
    const tempFileName = `.${basename(normalizedDestination)}.${randomUUID()}.tmp`
    const tempBackupPath = join(parentDir, tempFileName)

    try {
      // 1. Create temporary backup via native SQLite Online Backup API
      await this.db.backup(tempBackupPath)

      // 2. Validate temporary backup integrity using an isolated read-only connection
      let inspectDb: Database.Database | null = null
      try {
        inspectDb = new Database(tempBackupPath, { readonly: true })
        inspectDb.pragma('foreign_keys = ON')

        const integrity = inspectDb.pragma('integrity_check') as Array<{ integrity_check: string }>
        if (!integrity || integrity.length === 0 || integrity[0].integrity_check !== 'ok') {
          throw new Error(`Backup integrity check failed: ${JSON.stringify(integrity)}`)
        }

        const fkViolations = inspectDb.pragma('foreign_key_check') as unknown[]
        if (fkViolations && fkViolations.length > 0) {
          throw new Error(
            `Backup foreign key check failed with violations: ${JSON.stringify(fkViolations)}`
          )
        }

        // Verify schema_migrations table
        const migrationTable = inspectDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
          )
          .get() as { name: string } | undefined
        if (!migrationTable) {
          throw new Error('Backup validation failed: schema_migrations table does not exist.')
        }

        const appliedCountRow = inspectDb
          .prepare('SELECT count(*) as count FROM schema_migrations')
          .get() as { count: number }
        if (!appliedCountRow || appliedCountRow.count === 0) {
          throw new Error('Backup validation failed: no applied migrations found.')
        }

        // Verify all 11 core tables
        const existingTables = inspectDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .all() as Array<{ name: string }>
        const existingSet = new Set(existingTables.map((t) => t.name))
        for (const table of REQUIRED_APPLICATION_TABLES) {
          if (!existingSet.has(table)) {
            throw new Error(
              `Backup validation failed: required application table '${table}' is missing.`
            )
          }
        }

        // Ensure database can be queried
        inspectDb.prepare('SELECT count(*) FROM knowledge_bases').get()
      } finally {
        if (inspectDb) {
          try {
            inspectDb.close()
          } catch {
            // Ignore inspection connection cleanup error
          }
        }
      }

      // 3. Confirm destination still does not exist and safely rename
      if (existsSync(normalizedDestination)) {
        throw new Error(`Backup destination file already exists: '${normalizedDestination}'.`)
      }

      renameSync(tempBackupPath, normalizedDestination)
      const finalStat = statSync(normalizedDestination)

      return {
        destinationPath: normalizedDestination,
        completedAt: Date.now(),
        sizeBytes: finalStat.size,
        integrityVerified: true
      }
    } catch (error) {
      if (tempBackupPath && existsSync(tempBackupPath)) {
        try {
          unlinkSync(tempBackupPath)
        } catch {
          // Ignore cleanup error on failed backup temp file
        }
      }
      throw error instanceof Error ? error : new Error(`Database backup failed: ${String(error)}`)
    } finally {
      this.isBackupInProgress = false
    }
  }

  /**
   * Closes the active database connection safely.
   * Safe to call multiple times.
   */
  public close(): void {
    if (this.db) {
      try {
        if (this.db.open) {
          this.db.close()
        }
      } catch (err) {
        console.error('[DatabaseManager] Error while closing SQLite database:', err)
      } finally {
        this.db = null
        this.dbPath = null
        this.isBackupInProgress = false
      }
    } else {
      this.db = null
      this.dbPath = null
      this.isBackupInProgress = false
    }
  }
}

// Export singleton instance for the Electron Main process
export const databaseManager = new DatabaseManager()
