import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { type StartupReconciliationReportDto } from '../../shared/export-archive'
import type { ImportRecoveryService } from './import-recovery-service'
import type { DocumentStorageManager } from '../documents/document-storage-manager'
import type { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import type { DeletionRecoveryRepository } from '../database/repositories/deletion-recovery-repository'
import { recoverQuarantinedDocuments } from '../documents/lifecycle/document-quarantine-recovery'

export interface StartupReconciliationServiceOptions {
  readonly db: Database.Database
  readonly importRecoveryService: ImportRecoveryService
  readonly storageManager: DocumentStorageManager
  readonly sourceRepository: KnowledgeSourceRepository
  readonly deletionJournalRepo?: DeletionRecoveryRepository
  readonly tempBaseDir?: string
  readonly stagingTtlMs?: number
}

const DEFAULT_STAGING_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Service orchestrating startup reconciliation across interrupted imports,
 * lingering document quarantines, incomplete document indexing, unfinished
 * agent tasks, and abandoned temporary directories.
 */
export class StartupReconciliationService {
  private readonly db: Database.Database
  private readonly importRecoveryService: ImportRecoveryService
  private readonly storageManager: DocumentStorageManager
  private readonly sourceRepository: KnowledgeSourceRepository
  private readonly deletionJournalRepo?: DeletionRecoveryRepository
  private readonly tempBaseDir: string
  private readonly stagingTtlMs: number

  constructor(options: StartupReconciliationServiceOptions) {
    if (!options.db)
      throw new Error('Database instance is required for StartupReconciliationService.')
    if (!options.importRecoveryService)
      throw new Error('ImportRecoveryService is required for StartupReconciliationService.')
    if (!options.storageManager)
      throw new Error('DocumentStorageManager is required for StartupReconciliationService.')
    if (!options.sourceRepository)
      throw new Error('KnowledgeSourceRepository is required for StartupReconciliationService.')

    this.db = options.db
    this.importRecoveryService = options.importRecoveryService
    this.storageManager = options.storageManager
    this.sourceRepository = options.sourceRepository
    this.deletionJournalRepo = options.deletionJournalRepo
    this.tempBaseDir = options.tempBaseDir ?? path.join(process.cwd(), 'temp')
    this.stagingTtlMs = options.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS
  }

  /**
   * Executes all startup reconciliation procedures in deterministic sequence.
   */
  public async reconcile(): Promise<StartupReconciliationReportDto> {
    const warnings: string[] = []

    // 1. Reconcile interrupted Knowledge Base imports & replacements
    let recoveredImportsCount = 0
    try {
      const importReport = await this.importRecoveryService.recoverInterruptedImports()
      recoveredImportsCount = importReport.recoveredCount
      if (importReport.warnings.length > 0) {
        warnings.push(...importReport.warnings)
      }
    } catch (err: unknown) {
      warnings.push(
        `Import recovery reconciliation encountered an error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 2. Reconcile single-document quarantined deletion files
    let quarantineRecoveredCount = 0
    let quarantineCleanedCount = 0
    try {
      const quarantineReport = await recoverQuarantinedDocuments({
        storageManager: this.storageManager,
        sourceRepository: this.sourceRepository
      })
      quarantineRecoveredCount = quarantineReport.recoveredCount
      quarantineCleanedCount = quarantineReport.cleanedCount
      if (quarantineReport.errors.length > 0) {
        for (const qErr of quarantineReport.errors) {
          warnings.push(`Quarantine recovery error for KB '${qErr.knowledgeBaseId}': ${qErr.error}`)
        }
      }
    } catch (err: unknown) {
      warnings.push(
        `Document quarantine recovery encountered an error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 3. Reconcile interrupted document indexing
    let reconciledSourcesCount = 0
    try {
      reconciledSourcesCount = this.reconcileInterruptedDocumentIndexing()
    } catch (err: unknown) {
      warnings.push(
        `Document indexing reconciliation encountered an error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 4. Reconcile interrupted Agent Tasks & tool events
    let reconciledAgentRunsCount = 0
    let reconciledToolEventsCount = 0
    try {
      const agentResult = this.reconcileInterruptedAgentTasks()
      reconciledAgentRunsCount = agentResult.runsCount
      reconciledToolEventsCount = agentResult.eventsCount
    } catch (err: unknown) {
      warnings.push(
        `Agent tasks reconciliation encountered an error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 5. Clean up abandoned temporary staging directories
    let cleanedStagingDirsCount = 0
    try {
      cleanedStagingDirsCount = this.cleanupAbandonedStagingDirectories()
    } catch (err: unknown) {
      warnings.push(
        `Abandoned staging cleanup encountered an error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 6. Reconcile interrupted deletions (Knowledge Bases and Knowledge Sources)
    if (this.deletionJournalRepo) {
      try {
        const delResult = this.reconcileInterruptedDeletions()
        quarantineRecoveredCount += delResult.recoveredCount
        quarantineCleanedCount += delResult.cleanedCount
      } catch (err: unknown) {
        warnings.push(
          `Deletion recovery reconciliation encountered an error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    return {
      recoveredImportsCount,
      reconciledSourcesCount,
      reconciledAgentRunsCount,
      reconciledToolEventsCount,
      cleanedStagingDirsCount,
      quarantineCleanedCount,
      quarantineRecoveredCount,
      warnings
    }
  }

  /**
   * Reconciles sources left in 'processing' or 'queued' state when the process crashed.
   */
  private reconcileInterruptedDocumentIndexing(): number {
    const rows = this.db
      .prepare(
        `
      SELECT id, knowledge_base_id, file_type, file_name
      FROM knowledge_sources
      WHERE indexing_status IN ('processing', 'queued')
    `
      )
      .all() as Array<{
      id: string
      knowledge_base_id: string
      file_type: string
      file_name: string
    }>

    if (rows.length === 0) return 0

    const now = Date.now()
    const updateStmt = this.db.prepare(`
      UPDATE knowledge_sources
      SET indexing_status = ?,
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `)

    let reconciled = 0
    this.db.transaction(() => {
      for (const row of rows) {
        let fileExists: boolean
        try {
          const filePath = this.storageManager.resolveOriginalPath(
            row.knowledge_base_id,
            row.id,
            row.file_type
          )
          fileExists = fs.existsSync(filePath)
        } catch {
          fileExists = false
        }

        if (fileExists) {
          // File is present in managed storage: mark failed with clear actionable message
          updateStmt.run(
            'failed',
            'INTERRUPTED: Indexing was interrupted by an unexpected application restart. Please reindex.',
            now,
            row.id
          )
        } else {
          // File missing from storage: mark failed
          updateStmt.run(
            'failed',
            `INTERRUPTED: Original source file '${row.file_name}' was missing from storage after restart.`,
            now,
            row.id
          )
        }
        reconciled++
      }
    })()

    return reconciled
  }

  /**
   * Reconciles agent runs left in 'running', 'awaiting_approval', or 'pending' state.
   */
  private reconcileInterruptedAgentTasks(): { runsCount: number; eventsCount: number } {
    const unfinishedRuns = this.db
      .prepare(
        `
      SELECT id, started_at
      FROM agent_runs
      WHERE status IN ('running', 'awaiting_approval', 'pending')
    `
      )
      .all() as Array<{ id: string; started_at: number }>

    if (unfinishedRuns.length === 0) return { runsCount: 0, eventsCount: 0 }

    const now = Date.now()
    let runsCount = 0
    let eventsCount = 0

    this.db.transaction(() => {
      const updateRunStmt = this.db.prepare(`
        UPDATE agent_runs
        SET status = 'failed',
            error_summary = 'Task was interrupted because the application exited before completion.',
            completed_at = ?
        WHERE id = ?
      `)

      const updateToolStmt = this.db.prepare(`
        UPDATE tool_events
        SET status = 'failed',
            error_message = 'Task was interrupted because the application exited before completion.',
            completed_at = ?
        WHERE agent_run_id = ?
          AND status IN ('pending', 'running')
      `)

      for (const run of unfinishedRuns) {
        const completedAt = Math.max(now, run.started_at)
        updateRunStmt.run(completedAt, run.id)
        const toolResult = updateToolStmt.run(completedAt, run.id)
        runsCount++
        eventsCount += toolResult.changes
      }
    })()

    return { runsCount, eventsCount }
  }

  /**
   * Cleans abandoned staging directories in tempBaseDir, excluding any referenced
   * by active or recovery_required journal entries.
   */
  private cleanupAbandonedStagingDirectories(): number {
    if (!fs.existsSync(this.tempBaseDir)) return 0

    // Collect all staging directories protected by non-terminal or recovery_required journal rows
    const protectedDirs = new Set<string>()
    try {
      const rows = this.db
        .prepare(
          `
        SELECT staging_dir_name
        FROM import_recovery_journal
        WHERE state NOT IN ('completed', 'cancelled')
      `
        )
        .all() as Array<{ staging_dir_name: string }>

      for (const row of rows) {
        protectedDirs.add(row.staging_dir_name)
      }
    } catch {
      // If table query fails, don't delete anything
      return 0
    }

    let cleaned = 0
    const now = Date.now()
    const entries = fs.readdirSync(this.tempBaseDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const name = entry.name
      // Only target application staging directories
      if (!name.startsWith('import-staging-') && !name.startsWith('export-staging-')) {
        continue
      }

      // Do not clean directories protected by the recovery journal
      if (protectedDirs.has(name)) {
        continue
      }

      const fullPath = path.resolve(this.tempBaseDir, name)
      // Path traversal security check
      const rel = path.relative(this.tempBaseDir, fullPath)
      if (rel.includes('..') || path.isAbsolute(rel)) {
        continue
      }

      try {
        const stat = fs.statSync(fullPath)
        // Clean if older than or equal to TTL
        if (now - stat.mtimeMs >= this.stagingTtlMs) {
          fs.rmSync(fullPath, { recursive: true, force: true })
          cleaned++
        }
      } catch {
        // Ignore stat or removal error
      }
    }

    return cleaned
  }

  /**
   * Reconciles interrupted deletions tracked in deletion_recovery_journal.
   * If database deletion did not commit, restores quarantined files/directories.
   * If database deletion did commit, finalizes removal of lingering quarantines.
   */
  private reconcileInterruptedDeletions(): { recoveredCount: number; cleanedCount: number } {
    if (!this.deletionJournalRepo) return { recoveredCount: 0, cleanedCount: 0 }

    const activeJournals = this.deletionJournalRepo.listActive()
    let recoveredCount = 0
    let cleanedCount = 0

    const documentsDir = path.resolve(this.storageManager.getDocumentsDirectory())

    for (const journal of activeJournals) {
      if (journal.entityType === 'knowledge_base') {
        const kbExists = Boolean(
          this.db.prepare('SELECT 1 FROM knowledge_bases WHERE id = ?').get(journal.entityId)
        )
        const targetDir = path.resolve(documentsDir, journal.entityId)
        const quarantineDir = path.resolve(documentsDir, journal.quarantinePathName)

        if (kbExists) {
          // DB deletion did NOT commit. Restore quarantine folder if targetDir is missing.
          if (fs.existsSync(quarantineDir) && !fs.existsSync(targetDir)) {
            try {
              fs.renameSync(quarantineDir, targetDir)
              this.deletionJournalRepo.updateState(
                journal.id,
                'failed',
                'Deletion was interrupted before database commit. Restored quarantined directory.'
              )
              recoveredCount++
            } catch (err: unknown) {
              this.deletionJournalRepo.updateState(
                journal.id,
                'recovery_required',
                `Failed to restore quarantined directory: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          } else {
            this.deletionJournalRepo.updateState(
              journal.id,
              'failed',
              'Deletion was interrupted before database commit.'
            )
          }
        } else {
          // DB deletion DID commit. Quarantine directory should be removed.
          if (fs.existsSync(quarantineDir)) {
            try {
              fs.rmSync(quarantineDir, { recursive: true, force: true })
              this.deletionJournalRepo.updateState(journal.id, 'completed')
              cleanedCount++
            } catch (err: unknown) {
              this.deletionJournalRepo.updateState(
                journal.id,
                'recovery_required',
                `Failed to clean quarantined directory: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          } else {
            this.deletionJournalRepo.updateState(journal.id, 'completed')
          }
        }
      } else if (journal.entityType === 'knowledge_source') {
        const sourceExists = Boolean(
          this.db.prepare('SELECT 1 FROM knowledge_sources WHERE id = ?').get(journal.entityId)
        )
        const originalsDir = this.storageManager.resolveOriginalsDirectory(journal.knowledgeBaseId)
        const quarantineFile = path.resolve(originalsDir, journal.quarantinePathName)

        if (sourceExists) {
          this.deletionJournalRepo.updateState(
            journal.id,
            'failed',
            'Source deletion was interrupted before database commit.'
          )
        } else {
          if (fs.existsSync(quarantineFile)) {
            try {
              fs.unlinkSync(quarantineFile)
              cleanedCount++
            } catch {
              // Ignore unlink error
            }
          }
          this.deletionJournalRepo.updateState(journal.id, 'completed')
        }
      }
    }

    return { recoveredCount, cleanedCount }
  }
}
