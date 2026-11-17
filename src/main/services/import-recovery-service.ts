import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type ImportRecoveryJournalEntryDto,
  type ImportRecoveryState,
  type ImportStrategy
} from '../../shared/export-archive'
import type { ImportRecoveryRepository } from '../database/repositories/import-recovery-repository'
import type { DocumentStorageManager } from '../documents/document-storage-manager'

export interface ImportRecoveryServiceOptions {
  readonly db: Database.Database
  readonly journalRepository: ImportRecoveryRepository
  readonly storageManager: DocumentStorageManager
  readonly tempBaseDir?: string
}

export interface RecoveredImportResult {
  readonly journalId: string
  readonly strategy: ImportStrategy
  readonly previousState: ImportRecoveryState
  readonly finalState: ImportRecoveryState
  readonly actionTaken: string
  readonly warning?: string
}

export interface ImportRecoveryReport {
  readonly recoveredCount: number
  readonly results: readonly RecoveredImportResult[]
  readonly warnings: readonly string[]
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Service that handles persistent journaling and crash recovery for Knowledge Base imports.
 */
export class ImportRecoveryService {
  private readonly db: Database.Database
  private readonly journalRepo: ImportRecoveryRepository
  private readonly storageManager: DocumentStorageManager
  private readonly tempBaseDir: string

  constructor(options: ImportRecoveryServiceOptions) {
    if (!options.db) throw new Error('Database instance is required for ImportRecoveryService.')
    if (!options.journalRepository)
      throw new Error('ImportRecoveryRepository is required for ImportRecoveryService.')
    if (!options.storageManager)
      throw new Error('DocumentStorageManager is required for ImportRecoveryService.')

    this.db = options.db
    this.journalRepo = options.journalRepository
    this.storageManager = options.storageManager
    this.tempBaseDir = options.tempBaseDir ?? path.join(process.cwd(), 'temp')
  }

  public recordOperationStart(params: {
    id: string
    strategy: ImportStrategy
    targetKnowledgeBaseId?: string | null
    targetKnowledgeBaseName: string
    archiveSha256: string
    archiveName: string
    state?: ImportRecoveryState
    stagingDirName: string
  }): ImportRecoveryJournalEntryDto {
    return this.journalRepo.create(params)
  }

  public transition(
    id: string,
    state: ImportRecoveryState,
    extra?: {
      strategy?: ImportStrategy
      targetKnowledgeBaseId?: string | null
      quarantineDirName?: string | null
      promotedFiles?: readonly string[]
      remapping?: Record<string, Record<string, string>>
      counts?: Record<string, number>
      errorMessage?: string | null
    }
  ): ImportRecoveryJournalEntryDto {
    return this.journalRepo.updateState(id, state, extra)
  }

  public getJournalEntry(id: string): ImportRecoveryJournalEntryDto | null {
    return this.journalRepo.getById(id)
  }

  public listPendingOperations(): ImportRecoveryJournalEntryDto[] {
    return this.journalRepo.listPending()
  }

  /**
   * Scans the journal on startup and reconciles any imports that were interrupted
   * by an application or OS crash.
   */
  public async recoverInterruptedImports(): Promise<ImportRecoveryReport> {
    const pending = this.journalRepo.listPending()
    const results: RecoveredImportResult[] = []
    const warnings: string[] = []

    for (const entry of pending) {
      try {
        const result = await this.recoverSingleOperation(entry)
        results.push(result)
        if (result.warning) {
          warnings.push(result.warning)
        }
      } catch (err: unknown) {
        const msg = `Failed to reconcile import operation '${entry.id}': ${err instanceof Error ? err.message : String(err)}`
        warnings.push(msg)
        // Ensure state is marked recovery_required so data is preserved
        try {
          this.journalRepo.updateState(entry.id, 'recovery_required', {
            errorMessage: msg
          })
        } catch {
          // Ignore secondary DB error
        }
        results.push({
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: 'recovery_required',
          actionTaken: 'Marked recovery_required after reconciliation error.',
          warning: msg
        })
      }
    }

    return {
      recoveredCount: results.length,
      results,
      warnings
    }
  }

  private async recoverSingleOperation(
    entry: ImportRecoveryJournalEntryDto
  ): Promise<RecoveredImportResult> {
    const stagingDir = this.resolveSafeStagingPath(entry.stagingDirName)

    switch (entry.state) {
      case 'preparing':
      case 'staging':
      case 'validated': {
        // Crash occurred during staging. No database or originals mutations occurred.
        this.safeRemoveDirectory(stagingDir)
        this.journalRepo.updateState(entry.id, 'cancelled', {
          errorMessage: 'Interrupted before execution; staging cleaned.'
        })
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: 'cancelled',
          actionTaken: 'Cleaned staging directory and marked cancelled.'
        }
      }

      case 'quarantining': {
        // Crash occurred during or right after quarantine renaming
        const action = this.recoverQuarantiningState(entry)
        this.safeRemoveDirectory(stagingDir)
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: action.finalState,
          actionTaken: action.actionTaken,
          warning: action.warning
        }
      }

      case 'files_promoting': {
        // Crash occurred while copying new files into originals before DB transaction
        const action = this.recoverFilesPromotingState(entry)
        this.safeRemoveDirectory(stagingDir)
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: action.finalState,
          actionTaken: action.actionTaken,
          warning: action.warning
        }
      }

      case 'database_committing': {
        // In SQLite WAL mode: check if the DB transaction actually committed
        const committed = this.isDatabaseTransactionCommitted(entry)
        if (!committed) {
          // DB did not commit: rollback files and restore quarantine
          const rollbackAction = this.recoverFilesPromotingState(entry)
          this.safeRemoveDirectory(stagingDir)
          return {
            journalId: entry.id,
            strategy: entry.strategy,
            previousState: entry.state,
            finalState: rollbackAction.finalState,
            actionTaken: `Database transaction was not committed. ${rollbackAction.actionTaken}`,
            warning: rollbackAction.warning
          }
        }
        // DB did commit! Fall through to post-commit verification
        return await this.verifyAndCompleteCommittedOperation(entry, stagingDir)
      }

      case 'database_committed':
      case 'indexing':
      case 'verifying': {
        // DB transaction was committed. Verify integrity and reindex if necessary.
        return await this.verifyAndCompleteCommittedOperation(entry, stagingDir)
      }

      case 'rolling_back': {
        // Crash occurred during in-process rollback
        const action = this.recoverFilesPromotingState(entry)
        this.safeRemoveDirectory(stagingDir)
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: action.finalState,
          actionTaken: `Recovered from interrupted rollback: ${action.actionTaken}`,
          warning: action.warning
        }
      }

      case 'recovery_required': {
        // In recovery_required state: DO NOT delete or alter quarantine/originals
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: 'recovery_required',
          actionTaken: 'Preserved all files for manual recovery.',
          warning: `Operation '${entry.id}' is in recovery_required state. User data is preserved.`
        }
      }

      default:
        return {
          journalId: entry.id,
          strategy: entry.strategy,
          previousState: entry.state,
          finalState: entry.state,
          actionTaken: 'No recovery action required for terminal state.'
        }
    }
  }

  private recoverQuarantiningState(entry: ImportRecoveryJournalEntryDto): {
    finalState: ImportRecoveryState
    actionTaken: string
    warning?: string
  } {
    if (!entry.targetKnowledgeBaseId || !entry.quarantineDirName) {
      this.journalRepo.updateState(entry.id, 'failed', {
        errorMessage: 'Quarantine metadata missing.'
      })
      return {
        finalState: 'failed',
        actionTaken: 'Marked failed due to missing quarantine metadata.'
      }
    }

    const kbDir = this.storageManager.resolveKnowledgeBaseDirectory(entry.targetKnowledgeBaseId)
    const quarantineDir = path.resolve(kbDir, entry.quarantineDirName)
    const originalsDir = this.storageManager.resolveOriginalsDirectory(entry.targetKnowledgeBaseId)

    if (fs.existsSync(quarantineDir)) {
      if (!fs.existsSync(originalsDir) || fs.readdirSync(originalsDir).length === 0) {
        if (fs.existsSync(originalsDir)) {
          fs.rmSync(originalsDir, { recursive: true, force: true })
        }
        fs.renameSync(quarantineDir, originalsDir)
        this.journalRepo.updateState(entry.id, 'failed', {
          errorMessage: 'Interrupted during quarantine; original files restored.'
        })
        return {
          finalState: 'failed',
          actionTaken: 'Restored quarantined originals back to originals directory.'
        }
      } else {
        // Conflict: originals and quarantine both have files
        const warn = `Conflict detected for KB '${entry.targetKnowledgeBaseId}': both originals and quarantine exist. Marked recovery_required.`
        this.journalRepo.updateState(entry.id, 'recovery_required', {
          errorMessage: warn
        })
        return {
          finalState: 'recovery_required',
          actionTaken: 'Quarantine preserved due to conflict.',
          warning: warn
        }
      }
    }

    this.journalRepo.updateState(entry.id, 'failed', {
      errorMessage: 'Quarantine directory was not created before interruption.'
    })
    return {
      finalState: 'failed',
      actionTaken: 'Marked failed; quarantine directory did not exist.'
    }
  }

  private recoverFilesPromotingState(entry: ImportRecoveryJournalEntryDto): {
    finalState: ImportRecoveryState
    actionTaken: string
    warning?: string
  } {
    if (entry.strategy === 'replace') {
      if (!entry.targetKnowledgeBaseId) {
        this.journalRepo.updateState(entry.id, 'failed', {
          errorMessage: 'Target Knowledge Base ID missing.'
        })
        return { finalState: 'failed', actionTaken: 'Marked failed.' }
      }

      const kbDir = this.storageManager.resolveKnowledgeBaseDirectory(entry.targetKnowledgeBaseId)
      const originalsDir = this.storageManager.resolveOriginalsDirectory(
        entry.targetKnowledgeBaseId
      )

      // Clean promoted files in originals directory
      if (fs.existsSync(originalsDir)) {
        fs.rmSync(originalsDir, { recursive: true, force: true })
      }

      if (entry.quarantineDirName) {
        const quarantineDir = path.resolve(kbDir, entry.quarantineDirName)
        if (fs.existsSync(quarantineDir)) {
          fs.renameSync(quarantineDir, originalsDir)
          this.journalRepo.updateState(entry.id, 'failed', {
            errorMessage: 'Interrupted during file promotion; quarantined originals restored.'
          })
          return {
            finalState: 'failed',
            actionTaken:
              'Removed partially promoted files and restored original files from quarantine.'
          }
        }
      }

      // If quarantine directory was not found, mark recovery_required
      const warn = `Quarantine directory '${entry.quarantineDirName}' missing during replace rollback. Marked recovery_required.`
      this.journalRepo.updateState(entry.id, 'recovery_required', { errorMessage: warn })
      return { finalState: 'recovery_required', actionTaken: 'Preserved state.', warning: warn }
    }

    if (entry.strategy === 'new') {
      if (entry.targetKnowledgeBaseId) {
        try {
          const kbDir = this.storageManager.resolveKnowledgeBaseDirectory(
            entry.targetKnowledgeBaseId
          )
          if (fs.existsSync(kbDir)) {
            fs.rmSync(kbDir, { recursive: true, force: true })
          }
        } catch {
          // Ignore directory missing
        }
      }
      this.journalRepo.updateState(entry.id, 'failed', {
        errorMessage: 'Interrupted during file promotion for new Knowledge Base.'
      })
      return {
        finalState: 'failed',
        actionTaken: 'Cleaned partially promoted files for new Knowledge Base.'
      }
    }

    if (entry.strategy === 'merge') {
      // For merge: only delete files specifically recorded in promotedFiles
      for (const filePath of entry.promotedFiles) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
        } catch {
          // Ignore
        }
      }
      this.journalRepo.updateState(entry.id, 'failed', {
        errorMessage: 'Interrupted during file promotion for merge.'
      })
      return {
        finalState: 'failed',
        actionTaken: 'Unlinked newly promoted files from merge; preserved existing files.'
      }
    }

    return { finalState: 'failed', actionTaken: 'Marked failed.' }
  }

  private isDatabaseTransactionCommitted(entry: ImportRecoveryJournalEntryDto): boolean {
    if (!entry.targetKnowledgeBaseId) return false

    // Check if target KB exists
    const kbRow = this.db
      .prepare('SELECT id FROM knowledge_bases WHERE id = ?')
      .get(entry.targetKnowledgeBaseId)
    if (!kbRow) return false

    // If remapping has sources or bots, check if any of them exist in DB
    const remappedBots = Object.values(entry.remapping['bots'] ?? {})
    if (remappedBots.length > 0) {
      const botRow = this.db
        .prepare('SELECT id FROM bots WHERE id = ? AND knowledge_base_id = ?')
        .get(remappedBots[0], entry.targetKnowledgeBaseId)
      return Boolean(botRow)
    }

    const remappedSources = Object.values(entry.remapping['sources'] ?? {})
    if (remappedSources.length > 0) {
      const sourceRow = this.db
        .prepare('SELECT id FROM knowledge_sources WHERE id = ? AND knowledge_base_id = ?')
        .get(remappedSources[0], entry.targetKnowledgeBaseId)
      return Boolean(sourceRow)
    }

    return true
  }

  private async verifyAndCompleteCommittedOperation(
    entry: ImportRecoveryJournalEntryDto,
    stagingDir: string
  ): Promise<RecoveredImportResult> {
    if (!entry.targetKnowledgeBaseId) {
      this.journalRepo.updateState(entry.id, 'recovery_required', {
        errorMessage: 'Committed operation missing target Knowledge Base ID.'
      })
      return {
        journalId: entry.id,
        strategy: entry.strategy,
        previousState: entry.state,
        finalState: 'recovery_required',
        actionTaken: 'Marked recovery_required: target Knowledge Base ID missing.'
      }
    }

    const kbId = entry.targetKnowledgeBaseId

    // 1. Verify all sources recorded in DB have files on disk
    const sources = this.db
      .prepare(
        'SELECT id, file_name, relative_file_path, file_size, content_hash, indexing_status FROM knowledge_sources WHERE knowledge_base_id = ?'
      )
      .all(kbId) as Array<{
      id: string
      file_name: string
      relative_file_path: string
      file_size: number
      content_hash: string
      indexing_status: string
    }>

    const kbDir = this.storageManager.resolveKnowledgeBaseDirectory(kbId)
    let allFilesIntact = true

    for (const src of sources) {
      const filePath = path.resolve(kbDir, src.relative_file_path)
      if (!fs.existsSync(filePath)) {
        allFilesIntact = false
        break
      }
      const stat = fs.statSync(filePath)
      if (stat.size !== src.file_size) {
        allFilesIntact = false
        break
      }
      const hash = sha256File(filePath)
      if (hash.toLowerCase() !== src.content_hash.toLowerCase()) {
        allFilesIntact = false
        break
      }
    }

    if (!allFilesIntact) {
      const warn = `Verification failed for committed import '${entry.id}': one or more original files are missing or corrupt. Quarantined data preserved.`
      this.journalRepo.updateState(entry.id, 'recovery_required', { errorMessage: warn })
      return {
        journalId: entry.id,
        strategy: entry.strategy,
        previousState: entry.state,
        finalState: 'recovery_required',
        actionTaken: 'Preserved quarantine and files for manual recovery.',
        warning: warn
      }
    }

    // 2. Mark any sources still in 'queued' or 'processing' as 'needs_reindex'
    this.db
      .prepare(
        `
      UPDATE knowledge_sources
      SET indexing_status = 'needs_reindex',
          error_message = 'INTERRUPTED: Indexing was interrupted by an application restart. Please reindex.',
          updated_at = ?
      WHERE knowledge_base_id = ?
        AND indexing_status IN ('queued', 'processing')
    `
      )
      .run(Date.now(), kbId)

    // 3. Since files and DB are intact, safe to clean quarantine directory
    if (entry.quarantineDirName) {
      const quarantineDir = path.resolve(kbDir, entry.quarantineDirName)
      if (fs.existsSync(quarantineDir)) {
        try {
          fs.rmSync(quarantineDir, { recursive: true, force: true })
        } catch {
          // Non-critical cleanup
        }
      }
    }

    // 4. Safe to clean staging directory
    this.safeRemoveDirectory(stagingDir)

    // 5. Update journal to completed
    this.journalRepo.updateState(entry.id, 'completed', {
      errorMessage: null
    })

    return {
      journalId: entry.id,
      strategy: entry.strategy,
      previousState: entry.state,
      finalState: 'completed',
      actionTaken:
        'Verified file integrity, transitioned unindexed sources to needs_reindex, cleaned quarantine and marked completed.'
    }
  }

  private resolveSafeStagingPath(stagingDirName: string): string {
    if (!stagingDirName || stagingDirName.includes('..') || path.isAbsolute(stagingDirName)) {
      throw new Error(`Unsafe staging directory name '${stagingDirName}'`)
    }
    const fullPath = path.resolve(this.tempBaseDir, stagingDirName)
    const rel = path.relative(this.tempBaseDir, fullPath)
    if (rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error(`Path traversal detected for staging directory '${stagingDirName}'`)
    }
    return fullPath
  }

  private safeRemoveDirectory(targetDir: string): void {
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup error
    }
  }
}
