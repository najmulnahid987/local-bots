import type Database from 'better-sqlite3'
import {
  type DeletionRecoveryJournalEntryDto,
  type DeletionRecoveryState,
  DELETION_RECOVERY_STATES
} from '../../../shared/deletion'
import { RepositoryError, ValidationError, idSchema } from './types'

export interface CreateDeletionJournalInput {
  readonly id: string
  readonly entityType: 'knowledge_base' | 'knowledge_source'
  readonly entityId: string
  readonly knowledgeBaseId: string
  readonly entityName: string
  readonly quarantinePathName: string
  readonly originalRelPath?: string | null
  readonly state?: DeletionRecoveryState
}

interface RawDeletionJournalRow {
  id: string
  entity_type: 'knowledge_base' | 'knowledge_source'
  entity_id: string
  knowledge_base_id: string
  entity_name: string
  quarantine_path_name: string
  original_rel_path: string | null
  state: DeletionRecoveryState
  error_message: string | null
  created_at: number
  updated_at: number
}

function mapRowToDto(row: RawDeletionJournalRow): DeletionRecoveryJournalEntryDto {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    knowledgeBaseId: row.knowledge_base_id,
    entityName: row.entity_name,
    quarantinePathName: row.quarantine_path_name,
    originalRelPath: row.original_rel_path,
    state: row.state,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Main-process repository managing durable recovery journal records for
 * safe crash-resilient deletions of Knowledge Bases and Knowledge Sources.
 */
export class DeletionRecoveryRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for DeletionRecoveryRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new durable deletion recovery journal record.
   */
  public create(input: CreateDeletionJournalInput): DeletionRecoveryJournalEntryDto {
    this.validateId(input.id, 'Journal ID')
    if (!input.entityName || input.entityName.trim().length === 0) {
      throw new ValidationError('Entity name must not be empty.')
    }
    if (!input.quarantinePathName || input.quarantinePathName.trim().length === 0) {
      throw new ValidationError('Quarantine path name must not be empty.')
    }

    const now = Date.now()
    const state = input.state ?? 'preparing'

    const stmt = this.db.prepare(`
      INSERT INTO deletion_recovery_journal (
        id, entity_type, entity_id, knowledge_base_id, entity_name,
        quarantine_path_name, original_rel_path, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      stmt.run(
        input.id,
        input.entityType,
        input.entityId,
        input.knowledgeBaseId,
        input.entityName.trim(),
        input.quarantinePathName.trim(),
        input.originalRelPath ?? null,
        state,
        now,
        now
      )
    } catch (err: unknown) {
      throw new RepositoryError(
        `Failed to create deletion recovery journal entry: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return this.getById(input.id)!
  }

  /**
   * Retrieves a journal record by its ID.
   */
  public getById(id: string): DeletionRecoveryJournalEntryDto | null {
    this.validateId(id, 'Journal ID')

    const stmt = this.db.prepare(`
      SELECT *
      FROM deletion_recovery_journal
      WHERE id = ?
    `)

    const row = stmt.get(id) as RawDeletionJournalRow | undefined
    return row ? mapRowToDto(row) : null
  }

  /**
   * Updates the lifecycle state and optional error message of a journal entry.
   */
  public updateState(
    id: string,
    state: DeletionRecoveryState,
    errorMessage?: string | null
  ): DeletionRecoveryJournalEntryDto {
    this.validateId(id, 'Journal ID')

    if (!DELETION_RECOVERY_STATES.includes(state)) {
      throw new ValidationError(`Invalid deletion recovery state: '${state}'.`)
    }

    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE deletion_recovery_journal
      SET state = ?,
          error_message = COALESCE(?, error_message),
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(state, errorMessage ?? null, now, id)
    if (result.changes === 0) {
      throw new RepositoryError(`Deletion recovery journal record '${id}' not found for update.`)
    }

    return this.getById(id)!
  }

  /**
   * Lists all non-terminal journal entries (active operations).
   */
  public listActive(): readonly DeletionRecoveryJournalEntryDto[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM deletion_recovery_journal
      WHERE state NOT IN ('completed', 'failed')
      ORDER BY created_at ASC
    `)

    const rows = stmt.all() as RawDeletionJournalRow[]
    return rows.map(mapRowToDto)
  }

  /**
   * Lists all entries requiring manual user recovery.
   */
  public listRecoveryRequired(): readonly DeletionRecoveryJournalEntryDto[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM deletion_recovery_journal
      WHERE state = 'recovery_required'
      ORDER BY created_at DESC
    `)

    const rows = stmt.all() as RawDeletionJournalRow[]
    return rows.map(mapRowToDto)
  }

  /**
   * Deletes a journal record by its ID.
   */
  public delete(id: string): boolean {
    this.validateId(id, 'Journal ID')

    const stmt = this.db.prepare('DELETE FROM deletion_recovery_journal WHERE id = ?')
    const result = stmt.run(id)
    return result.changes > 0
  }

  /**
   * Purges completed or failed records older than the specified TTL.
   */
  public cleanCompletedOlderThan(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs
    const stmt = this.db.prepare(`
      DELETE FROM deletion_recovery_journal
      WHERE state IN ('completed', 'failed')
        AND updated_at < ?
    `)

    const result = stmt.run(cutoff)
    return result.changes
  }

  private validateId(id: string, label: string): void {
    const parseResult = idSchema.safeParse(id)
    if (!parseResult.success) {
      throw new ValidationError(`Invalid ${label}: '${id}'. Must be a valid UUIDv4 string.`)
    }
  }
}
