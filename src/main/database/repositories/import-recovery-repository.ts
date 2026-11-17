import type Database from 'better-sqlite3'
import {
  type ImportRecoveryJournalEntryDto,
  type ImportRecoveryState,
  IMPORT_RECOVERY_STATES
} from '../../../shared/export-archive'
import {
  type CreateImportRecoveryJournalInput,
  type UpdateImportRecoveryJournalInput,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'

interface RawJournalRow {
  id: string
  strategy: 'new' | 'merge' | 'replace'
  target_knowledge_base_id: string | null
  target_knowledge_base_name: string
  archive_sha256: string
  archive_name: string
  state: ImportRecoveryState
  staging_dir_name: string
  quarantine_dir_name: string | null
  promoted_files_json: string
  remapping_json: string
  counts_json: string
  error_message: string | null
  created_at: number
  updated_at: number
}

function parseJsonField<T>(jsonStr: string, fallback: T): T {
  try {
    return JSON.parse(jsonStr) as T
  } catch {
    return fallback
  }
}

function mapRowToDto(row: RawJournalRow): ImportRecoveryJournalEntryDto {
  return {
    id: row.id,
    strategy: row.strategy,
    targetKnowledgeBaseId: row.target_knowledge_base_id,
    targetKnowledgeBaseName: row.target_knowledge_base_name,
    archiveSha256: row.archive_sha256,
    archiveName: row.archive_name,
    state: row.state,
    stagingDirName: row.staging_dir_name,
    quarantineDirName: row.quarantine_dir_name,
    promotedFiles: parseJsonField<string[]>(row.promoted_files_json, []),
    remapping: parseJsonField<Record<string, Record<string, string>>>(row.remapping_json, {}),
    counts: parseJsonField<Record<string, number>>(row.counts_json, {}),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Main-process repository managing durable recovery journal records for
 * Knowledge Base imports and replacements.
 */
export class ImportRecoveryRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for ImportRecoveryRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new recovery journal entry.
   */
  public create(input: CreateImportRecoveryJournalInput): ImportRecoveryJournalEntryDto {
    if (!input) {
      throw new ValidationError('Input is required to create an import recovery journal entry.')
    }

    const idCheck = idSchema.safeParse(input.id)
    if (!idCheck.success) {
      throw new ValidationError(`Invalid session ID '${input.id}': must be a valid UUIDv4.`)
    }

    if (!['new', 'merge', 'replace'].includes(input.strategy)) {
      throw new ValidationError(
        `Invalid strategy '${input.strategy}': must be 'new', 'merge', or 'replace'.`
      )
    }

    const state = input.state ?? 'preparing'
    if (!IMPORT_RECOVERY_STATES.includes(state)) {
      throw new ValidationError(`Invalid initial state '${state}'.`)
    }

    const now = Date.now()
    const promotedFilesJson = JSON.stringify(input.promotedFiles ?? [])
    const remappingJson = JSON.stringify(input.remapping ?? {})
    const countsJson = JSON.stringify(input.counts ?? {})

    try {
      this.db
        .prepare(
          `
        INSERT INTO import_recovery_journal (
          id, strategy, target_knowledge_base_id, target_knowledge_base_name,
          archive_sha256, archive_name, state, staging_dir_name, quarantine_dir_name,
          promoted_files_json, remapping_json, counts_json, error_message,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
        )
      `
        )
        .run(
          input.id,
          input.strategy,
          input.targetKnowledgeBaseId ?? null,
          input.targetKnowledgeBaseName,
          input.archiveSha256,
          input.archiveName,
          state,
          input.stagingDirName,
          input.quarantineDirName ?? null,
          promotedFilesJson,
          remappingJson,
          countsJson,
          input.errorMessage ?? null,
          now,
          now
        )

      return this.getById(input.id)!
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to create import recovery journal entry: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates fields and timestamps on an existing journal entry.
   */
  public update(
    id: string,
    input: UpdateImportRecoveryJournalInput
  ): ImportRecoveryJournalEntryDto {
    const existing = this.getById(id)
    if (!existing) {
      throw new RepositoryError(`Import recovery journal entry '${id}' not found.`)
    }

    if (input.state && !IMPORT_RECOVERY_STATES.includes(input.state)) {
      throw new ValidationError(`Invalid recovery state '${input.state}'.`)
    }

    const now = Date.now()
    const newState = input.state ?? existing.state
    const newStrategy = input.strategy ?? existing.strategy
    const newTargetKbId =
      input.targetKnowledgeBaseId !== undefined
        ? input.targetKnowledgeBaseId
        : existing.targetKnowledgeBaseId
    const newQuarantineDir =
      input.quarantineDirName !== undefined ? input.quarantineDirName : existing.quarantineDirName
    const newPromotedFilesJson =
      input.promotedFiles !== undefined
        ? JSON.stringify(input.promotedFiles)
        : JSON.stringify(existing.promotedFiles)
    const newRemappingJson =
      input.remapping !== undefined
        ? JSON.stringify(input.remapping)
        : JSON.stringify(existing.remapping)
    const newCountsJson =
      input.counts !== undefined ? JSON.stringify(input.counts) : JSON.stringify(existing.counts)
    const newErrorMessage =
      input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage

    try {
      this.db
        .prepare(
          `
        UPDATE import_recovery_journal
        SET state = ?,
            strategy = ?,
            target_knowledge_base_id = ?,
            quarantine_dir_name = ?,
            promoted_files_json = ?,
            remapping_json = ?,
            counts_json = ?,
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `
        )
        .run(
          newState,
          newStrategy,
          newTargetKbId,
          newQuarantineDir,
          newPromotedFilesJson,
          newRemappingJson,
          newCountsJson,
          newErrorMessage,
          now,
          id
        )

      return this.getById(id)!
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to update import recovery journal entry '${id}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Transition state helper.
   */
  public updateState(
    id: string,
    state: ImportRecoveryState,
    extra?: Partial<UpdateImportRecoveryJournalInput>
  ): ImportRecoveryJournalEntryDto {
    return this.update(id, { ...extra, state })
  }

  /**
   * Retrieves a journal record by its ID.
   */
  public getById(id: string): ImportRecoveryJournalEntryDto | null {
    const row = this.db.prepare('SELECT * FROM import_recovery_journal WHERE id = ?').get(id) as
      RawJournalRow | undefined

    if (!row) {
      return null
    }

    return mapRowToDto(row)
  }

  /**
   * Lists all journal entries currently in a non-terminal pending or recovery state.
   */
  public listPending(): ImportRecoveryJournalEntryDto[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM import_recovery_journal
      WHERE state NOT IN ('completed', 'cancelled', 'failed')
      ORDER BY created_at ASC
    `
      )
      .all() as RawJournalRow[]

    return rows.map(mapRowToDto)
  }

  /**
   * Lists all journal entries in descending creation order.
   */
  public listAll(): ImportRecoveryJournalEntryDto[] {
    const rows = this.db
      .prepare('SELECT * FROM import_recovery_journal ORDER BY created_at DESC')
      .all() as RawJournalRow[]

    return rows.map(mapRowToDto)
  }

  /**
   * Deletes a journal record by its ID.
   */
  public delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM import_recovery_journal WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * Cleans up old terminal journal entries created before threshold timestamp.
   */
  public deleteCompletedBefore(thresholdTimestampMs: number): number {
    const result = this.db
      .prepare(
        `
      DELETE FROM import_recovery_journal
      WHERE state IN ('completed', 'cancelled')
        AND updated_at < ?
    `
      )
      .run(thresholdTimestampMs)

    return result.changes
  }
}
