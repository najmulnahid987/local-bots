import fs from 'node:fs'
import type Database from 'better-sqlite3'
import {
  type DatabaseHealthDto,
  type ForeignKeyViolationDto,
  type IntegrityCheckStatus,
  type ForeignKeyStatus,
  type DatabaseHealthStatus
} from '../../shared/diagnostics'

export interface DatabaseIntegrityServiceOptions {
  readonly db?: Database.Database | null
  readonly databaseFilePath?: string | null
}

/**
 * Main-process service responsible for verifying SQLite database integrity,
 * foreign-key constraints, file metrics, and providing user recovery guidance.
 *
 * Guarantees:
 * 1. Read-Only: Never mutates or alters database state or schema.
 * 2. Path Sanitization: Never leaks machine-specific filesystem paths or stack traces.
 * 3. Graceful Availability Guard: Safely reports critical status if the DB is closed or absent.
 */
export class DatabaseIntegrityService {
  private db: Database.Database | null
  private readonly databaseFilePath: string | null
  private lastVerifiedHealth: DatabaseHealthDto | null = null

  constructor(options: DatabaseIntegrityServiceOptions = {}) {
    this.db = options.db ?? null
    this.databaseFilePath = options.databaseFilePath ?? null
  }

  /**
   * Updates or binds the active database connection.
   */
  public setDatabase(db: Database.Database | null): void {
    this.db = db
  }

  /**
   * Returns cached database health or performs an active verification if none exists.
   */
  public async getDatabaseHealth(): Promise<DatabaseHealthDto> {
    if (this.lastVerifiedHealth) {
      return this.lastVerifiedHealth
    }
    return this.runIntegrityCheck()
  }

  /**
   * Performs a comprehensive, non-destructive health and integrity check on the database.
   */
  public async runIntegrityCheck(): Promise<DatabaseHealthDto> {
    const now = Date.now()

    if (!this.db || !this.db.open) {
      const unavailableHealth: DatabaseHealthDto = {
        status: 'critical',
        integrityStatus: 'error',
        foreignKeyStatus: 'error',
        databaseAvailable: false,
        databaseSizeBytes: 0,
        walSizeBytes: 0,
        lastVerifiedAt: now,
        violationsCount: 0,
        violations: [],
        summary: 'Database connection is unavailable or closed.',
        diagnosticCodes: ['DB_UNAVAILABLE'],
        recoveryGuidance: [
          'Do not delete or manually modify application data or WAL files.',
          'Verify that the database directory is accessible and not locked by another process.',
          'Restart the application to attempt clean connection initialization.'
        ]
      }
      this.lastVerifiedHealth = unavailableHealth
      return unavailableHealth
    }

    // 1. Calculate database file and WAL sizes safely
    let databaseSizeBytes = 0
    let walSizeBytes = 0
    if (this.databaseFilePath) {
      try {
        if (fs.existsSync(this.databaseFilePath)) {
          databaseSizeBytes = fs.statSync(this.databaseFilePath).size
        }
      } catch {
        databaseSizeBytes = 0
      }

      try {
        const walPath = `${this.databaseFilePath}-wal`
        if (fs.existsSync(walPath)) {
          walSizeBytes = fs.statSync(walPath).size
        }
      } catch {
        walSizeBytes = 0
      }
    }

    let integrityStatus: IntegrityCheckStatus = 'ok'
    let foreignKeyStatus: ForeignKeyStatus = 'ok'
    const diagnosticCodes: string[] = []
    const recoveryGuidance: string[] = []
    let violations: ForeignKeyViolationDto[] = []

    // 2. Execute PRAGMA integrity_check
    try {
      const integrityRows = this.db.pragma('integrity_check') as Array<{
        integrity_check?: string
        [key: string]: unknown
      }>

      const firstRow = integrityRows[0]
      const resultText =
        typeof firstRow === 'object' && firstRow !== null
          ? String(firstRow.integrity_check ?? Object.values(firstRow)[0] ?? '')
          : String(firstRow ?? '')

      if (resultText !== 'ok') {
        integrityStatus = 'failed'
        diagnosticCodes.push('DB_INTEGRITY_FAILED')
        recoveryGuidance.push(
          'Database corruption detected by SQLite PRAGMA integrity_check.',
          'Do not attempt manual edits or deletions of database or WAL files.',
          'Preserve the application data directory and export diagnostics before attempting restoration.',
          'A verified offline backup may be required to restore consistent state.'
        )
      }
    } catch {
      integrityStatus = 'error'
      diagnosticCodes.push('DB_INTEGRITY_ERROR')
      recoveryGuidance.push(
        'Integrity verification query encountered an internal error.',
        'Ensure the database is not corrupted or locked by another process.'
      )
    }

    // 3. Execute PRAGMA foreign_key_check
    try {
      const fkRows = this.db.pragma('foreign_key_check') as Array<{
        table?: string
        rowid?: number
        parent?: string
        fkid?: number
        [key: string]: unknown
      }>

      if (fkRows && fkRows.length > 0) {
        foreignKeyStatus = 'violations_detected'
        diagnosticCodes.push('DB_FK_VIOLATIONS')
        violations = fkRows.map((row) => ({
          table: String(row.table ?? 'unknown'),
          rowid: Number(row.rowid ?? 0),
          parent: String(row.parent ?? 'unknown'),
          fkid: Number(row.fkid ?? 0)
        }))
        recoveryGuidance.push(
          'Referential integrity violations detected across one or more tables.',
          'Do not delete records manually.',
          'Export diagnostics to assist with technical investigation.'
        )
      }
    } catch {
      foreignKeyStatus = 'error'
      diagnosticCodes.push('DB_FK_CHECK_ERROR')
      recoveryGuidance.push('Foreign key verification query encountered an internal error.')
    }

    // 4. Determine overall health status
    let status: DatabaseHealthStatus = 'healthy'
    let summary = 'Database is healthy and consistent.'

    if (integrityStatus === 'failed' || integrityStatus === 'error') {
      status = 'critical'
      summary = 'Database integrity check failed. Immediate preservation advised.'
    } else if (foreignKeyStatus === 'violations_detected' || foreignKeyStatus === 'error') {
      status = 'warning'
      summary = `${violations.length} referential integrity violation(s) detected.`
    }

    const health: DatabaseHealthDto = {
      status,
      integrityStatus,
      foreignKeyStatus,
      databaseAvailable: true,
      databaseSizeBytes,
      walSizeBytes,
      lastVerifiedAt: now,
      violationsCount: violations.length,
      violations,
      summary,
      diagnosticCodes,
      recoveryGuidance
    }

    this.lastVerifiedHealth = health
    return health
  }
}
