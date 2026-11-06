import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

export interface DatabaseInitResult {
  dbPath: string
  foreignKeys: boolean
  journalMode: string
  busyTimeout: number
  reusedExisting: boolean
}

/**
 * Manages the lifecycle of the single persistent SQLite database connection
 * in the Electron Main process.
 *
 * Enforces:
 * - Single connection per process.
 * - Production database located at `<userData>/database/app.sqlite`.
 * - PRAGMA foreign_keys = ON (verified).
 * - PRAGMA journal_mode = DELETE (verified safe default; WAL deferred to Step 2.7).
 * - PRAGMA busy_timeout = 5000 (verified).
 */
export class DatabaseManager {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  /**
   * Initializes the persistent SQLite database connection in <userDataPath>/database/app.sqlite.
   * Enforces single-connection idempotency, foreign key verification, journal mode verification,
   * and busy timeout settings.
   */
  public initialize(userDataPath: string): DatabaseInitResult {
    if (!userDataPath || typeof userDataPath !== 'string' || userDataPath.trim().length === 0) {
      throw new Error('Database initialization failed: Invalid or empty userDataPath provided.')
    }

    // Idempotency: Return existing connection if already open
    if (this.db && this.db.open && this.dbPath) {
      const currentFk = this.db.pragma('foreign_keys', { simple: true })
      const currentJournal = this.db.pragma('journal_mode', { simple: true })
      const currentTimeout = this.db.pragma('busy_timeout', { simple: true })

      return {
        dbPath: this.dbPath,
        foreignKeys: currentFk === 1,
        journalMode: String(currentJournal).toLowerCase(),
        busyTimeout: Number(currentTimeout),
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

      // 2. Configure and verify journal mode (DELETE mode for initial implementation; WAL deferred to Step 2.7)
      const journalModeValue = connection.pragma('journal_mode = DELETE', { simple: true })
      const normalizedJournalMode = String(journalModeValue).toLowerCase()
      if (normalizedJournalMode !== 'delete') {
        throw new Error(
          `SQLite connection verification failed: PRAGMA journal_mode returned '${journalModeValue}', expected 'delete'.`
        )
      }

      // 3. Configure and verify busy timeout
      connection.pragma('busy_timeout = 5000')
      const busyTimeoutValue = connection.pragma('busy_timeout', { simple: true })
      const timeoutNumber = Number(busyTimeoutValue)
      if (timeoutNumber !== 5000) {
        throw new Error(
          `SQLite connection verification failed: PRAGMA busy_timeout returned ${busyTimeoutValue}, expected 5000.`
        )
      }

      this.db = connection
      this.dbPath = databaseFilePath

      return {
        dbPath: databaseFilePath,
        foreignKeys: true,
        journalMode: normalizedJournalMode,
        busyTimeout: timeoutNumber,
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
      }
    } else {
      this.db = null
      this.dbPath = null
    }
  }
}

// Export singleton instance for the Electron Main process
export const databaseManager = new DatabaseManager()
