import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  type DiagnosticsExportDto,
  type DiagnosticsEnvironmentDto,
  type DiagnosticsDatabaseMetricsDto,
  type DiagnosticsStorageMetricsDto,
  type DiagnosticsProviderStatusDto,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_SCHEMA_VERSION,
  diagnosticsExportDtoSchema
} from '../../shared/diagnostics'
import type { DatabaseIntegrityService } from './database-integrity-service'
import type { ApplicationErrorRingBuffer } from './error-ring-buffer'

export interface DiagnosticsCollectorOptions {
  readonly db?: Database.Database | null
  readonly integrityService: DatabaseIntegrityService
  readonly errorRingBuffer: ApplicationErrorRingBuffer
  readonly tempBaseDir?: string
  readonly appVersion?: string
}

/**
 * Service that collects allowlisted, strictly non-secret technical diagnostics,
 * system metrics, and database health metrics.
 */
export class DiagnosticsCollector {
  private readonly db: Database.Database | null
  private readonly integrityService: DatabaseIntegrityService
  private readonly errorRingBuffer: ApplicationErrorRingBuffer
  private readonly tempBaseDir: string | null
  private readonly appVersion: string

  constructor(options: DiagnosticsCollectorOptions) {
    this.db = options.db ?? null
    this.integrityService = options.integrityService
    this.errorRingBuffer = options.errorRingBuffer
    this.tempBaseDir = options.tempBaseDir ? path.resolve(options.tempBaseDir) : null
    this.appVersion = options.appVersion ?? '1.0.0'
  }

  /**
   * Collects and validates full diagnostics export data.
   */
  public async collect(): Promise<DiagnosticsExportDto> {
    const exportedAt = Date.now()

    // 1. Gather safe environment information
    const environment: DiagnosticsEnvironmentDto = {
      appVersion: this.appVersion,
      electronVersion: process.versions.electron ?? 'unknown',
      chromiumVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.floor(process.uptime())
    }

    // 2. Gather database health and integrity
    const databaseHealth = await this.integrityService.getDatabaseHealth()

    // 3. Gather database counts
    const dbAvailable = Boolean(this.db && this.db.open)
    const databaseMetrics: DiagnosticsDatabaseMetricsDto = {
      databaseSizeBytes: databaseHealth.databaseSizeBytes,
      walSizeBytes: databaseHealth.walSizeBytes,
      knowledgeBasesCount: dbAvailable ? this.safeCount('knowledge_bases') : 0,
      botsCount: dbAvailable ? this.safeCount('bots') : 0,
      sourcesCount: dbAvailable ? this.safeCount('knowledge_sources') : 0,
      conversationsCount: dbAvailable ? this.safeCount('conversations') : 0,
      messagesCount: dbAvailable ? this.safeCount('messages') : 0,
      agentRunsCount: dbAvailable ? this.safeCount('agent_runs') : 0,
      toolEventsCount: dbAvailable ? this.safeCount('tool_events') : 0,
      botMemoriesCount: dbAvailable ? this.safeCount('bot_memories') : 0,
      importRecoveryJournalsCount: dbAvailable ? this.safeCount('import_recovery_journal') : 0
    }

    // 4. Gather storage metrics
    let totalOriginalDocumentsSizeBytes = 0
    if (dbAvailable) {
      try {
        const row = this.db!.prepare(
          'SELECT COALESCE(SUM(file_size), 0) as total FROM knowledge_sources'
        ).get() as { total: number }
        totalOriginalDocumentsSizeBytes = Number(row?.total ?? 0)
      } catch {
        totalOriginalDocumentsSizeBytes = 0
      }
    }

    let temporaryStorageSizeBytes = 0
    if (this.tempBaseDir && fs.existsSync(this.tempBaseDir)) {
      temporaryStorageSizeBytes = this.calculateDirectorySize(this.tempBaseDir)
    }

    const storageMetrics: DiagnosticsStorageMetricsDto = {
      totalOriginalDocumentsSizeBytes,
      databaseSizeBytes: databaseHealth.databaseSizeBytes,
      walSizeBytes: databaseHealth.walSizeBytes,
      temporaryStorageSizeBytes
    }

    // 5. Gather safe provider summary (types only, never keys or connection IDs)
    let configuredProviders: string[] = []
    let totalConnectionsCount = 0
    let hasActiveConnection = false

    if (dbAvailable) {
      try {
        const rows = this.db!.prepare(
          'SELECT provider_id, status FROM provider_connections'
        ).all() as Array<{ provider_id: string; status: string }>

        totalConnectionsCount = rows.length
        hasActiveConnection = rows.some((r) => r.status === 'active')
        configuredProviders = Array.from(new Set(rows.map((r) => r.provider_id))).sort()
      } catch {
        configuredProviders = []
      }
    }

    const providerStatus: DiagnosticsProviderStatusDto = {
      configuredProviders,
      totalConnectionsCount,
      hasActiveConnection
    }

    // 6. Gather recent sanitized errors
    const recentErrors = this.errorRingBuffer.getRecentErrors()

    const diagnostics: DiagnosticsExportDto = {
      format: DIAGNOSTICS_FORMAT,
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      exportedAt,
      environment,
      databaseMetrics,
      storageMetrics,
      providerStatus,
      databaseHealth,
      recentErrors
    }

    // Strict schema validation by construction
    return diagnosticsExportDtoSchema.parse(diagnostics)
  }

  private safeCount(tableName: string): number {
    try {
      const row = this.db!.prepare(`SELECT count(*) as c FROM ${tableName}`).get() as {
        c: number
      }
      return Number(row?.c ?? 0)
    } catch {
      return 0
    }
  }

  private calculateDirectorySize(dirPath: string): number {
    let total = 0
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isFile()) {
          total += fs.statSync(fullPath).size
        } else if (entry.isDirectory()) {
          total += this.calculateDirectorySize(fullPath)
        }
      }
    } catch {
      // Ignore directory measurement error
    }
    return total
  }
}
