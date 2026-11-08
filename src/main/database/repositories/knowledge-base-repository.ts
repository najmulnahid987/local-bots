import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  KnowledgeBaseOverviewDto,
  KnowledgeBaseActivityItemDto,
  KnowledgeBaseActivityType
} from '../../../shared/knowledge-bases'
import {
  type KnowledgeBase,
  type CreateKnowledgeBaseInput,
  type UpdateKnowledgeBaseInput,
  type KnowledgeBaseListOptions,
  ValidationError,
  RepositoryError,
  idSchema,
  createKnowledgeBaseSchema,
  updateKnowledgeBaseSchema
} from './types'

/**
 * Main-process repository providing typed CRUD and lifecycle operations for Knowledge Bases.
 * Interacts with SQLite using parameterized prepared statements.
 */
export class KnowledgeBaseRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for KnowledgeBaseRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new Knowledge Base.
   * Generates id, storage_path, created_at, and updated_at internally.
   */
  public create(input: CreateKnowledgeBaseInput): KnowledgeBase {
    const parseResult = createKnowledgeBaseSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to create Knowledge Base: ${messages}`)
    }

    const { name, description } = parseResult.data
    const id = randomUUID()
    const storagePath = `documents/${id}`
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at, archived_at)
        VALUES (@id, @name, @description, @storage_path, @created_at, @updated_at, NULL)
      `)

      stmt.run({
        id,
        name,
        description: description ?? '',
        storage_path: storagePath,
        created_at: now,
        updated_at: now
      })

      return {
        id,
        name,
        description: description ?? '',
        storage_path: storagePath,
        created_at: now,
        updated_at: now,
        archived_at: null
      }
    } catch (err) {
      throw new RepositoryError(
        `Failed to persist Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a Knowledge Base by its UUID primary key.
   * Returns null if not found.
   */
  public getById(id: string): KnowledgeBase | null {
    this.validateId(id)

    try {
      const stmt = this.db.prepare(`
        SELECT id, name, description, storage_path, created_at, updated_at, archived_at
        FROM knowledge_bases
        WHERE id = ?
      `)

      const row = stmt.get(id) as KnowledgeBase | undefined
      return row ?? null
    } catch (err) {
      throw new RepositoryError(
        `Failed to retrieve Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists Knowledge Bases ordered by created_at DESC.
   * By default, returns active Knowledge Bases (archived_at IS NULL).
   * If includeArchived is true, returns all Knowledge Bases.
   */
  public list(options?: KnowledgeBaseListOptions): KnowledgeBase[] {
    try {
      const includeArchived = options?.includeArchived ?? false
      const sql = includeArchived
        ? `SELECT id, name, description, storage_path, created_at, updated_at, archived_at
           FROM knowledge_bases
           ORDER BY created_at DESC`
        : `SELECT id, name, description, storage_path, created_at, updated_at, archived_at
           FROM knowledge_bases
           WHERE archived_at IS NULL
           ORDER BY created_at DESC`

      return this.db.prepare(sql).all() as KnowledgeBase[]
    } catch (err) {
      throw new RepositoryError(
        `Failed to list Knowledge Bases: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates permitted mutable fields of a Knowledge Base (name, description).
   * Automatically updates updated_at.
   * Returns updated Knowledge Base or null if record was not found.
   */
  public update(id: string, input: UpdateKnowledgeBaseInput): KnowledgeBase | null {
    this.validateId(id)

    const parseResult = updateKnowledgeBaseSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to update Knowledge Base: ${messages}`)
    }

    const existing = this.getById(id)
    if (!existing) {
      return null
    }

    const { name, description } = parseResult.data
    const now = Date.now()

    const setClauses: string[] = ['updated_at = @updated_at']
    const params: Record<string, unknown> = {
      id,
      updated_at: now
    }

    if (name !== undefined) {
      setClauses.push('name = @name')
      params.name = name
    }

    if (description !== undefined) {
      setClauses.push('description = @description')
      params.description = description
    }

    try {
      const sql = `UPDATE knowledge_bases SET ${setClauses.join(', ')} WHERE id = @id`
      this.db.prepare(sql).run(params)

      return this.getById(id)
    } catch (err) {
      throw new RepositoryError(
        `Failed to update Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a Knowledge Base by primary key.
   * SQLite foreign key cascades will automatically delete dependent child rows.
   * Returns true if a record was deleted, false if not found.
   */
  public delete(id: string): boolean {
    this.validateId(id)

    try {
      const stmt = this.db.prepare('DELETE FROM knowledge_bases WHERE id = ?')
      const result = stmt.run(id)
      return result.changes > 0
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Archives a Knowledge Base by setting archived_at timestamp.
   * Returns updated record or null if not found.
   */
  public archive(id: string): KnowledgeBase | null {
    this.validateId(id)

    const existing = this.getById(id)
    if (!existing) {
      return null
    }

    const now = Date.now()
    try {
      this.db
        .prepare('UPDATE knowledge_bases SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id)
      return this.getById(id)
    } catch (err) {
      throw new RepositoryError(
        `Failed to archive Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Unarchives a Knowledge Base by resetting archived_at to NULL.
   * Returns updated record or null if not found.
   */
  public unarchive(id: string): KnowledgeBase | null {
    this.validateId(id)

    const existing = this.getById(id)
    if (!existing) {
      return null
    }

    const now = Date.now()
    try {
      this.db
        .prepare('UPDATE knowledge_bases SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(now, id)
      return this.getById(id)
    } catch (err) {
      throw new RepositoryError(
        `Failed to unarchive Knowledge Base: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves aggregated Overview statistics and recent activity for a Knowledge Base.
   * Runs within a single read transaction snapshot for point-in-time consistency.
   * Throws RepositoryError if the Knowledge Base does not exist.
   */
  public getOverview(id: string): KnowledgeBaseOverviewDto {
    this.validateId(id)

    try {
      const getOverviewTx = this.db.transaction((kbId: string): KnowledgeBaseOverviewDto => {
        // 1. Verify parent Knowledge Base exists
        const kb = this.db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(kbId) as
          { id: string } | undefined

        if (!kb) {
          throw new RepositoryError(`Knowledge Base with ID '${kbId}' does not exist.`)
        }

        // 2. Aggregate Bot statistics
        const botStats = this.db
          .prepare(
            `
            SELECT
              count(*) AS total,
              coalesce(sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
              coalesce(sum(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived
            FROM bots
            WHERE knowledge_base_id = ?
          `
          )
          .get(kbId) as { total: number; active: number; archived: number }

        // 3. Aggregate Document statistics & latest indexed_at timestamp
        const docStats = this.db
          .prepare(
            `
            SELECT
              count(*) AS total,
              coalesce(sum(CASE WHEN indexing_status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
              coalesce(sum(CASE WHEN indexing_status IN ('queued', 'parsing', 'indexing') THEN 1 ELSE 0 END), 0) AS processing,
              coalesce(sum(CASE WHEN indexing_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
              coalesce(sum(file_size), 0) AS total_bytes,
              max(indexed_at) AS last_indexed_at
            FROM knowledge_sources
            WHERE knowledge_base_id = ?
          `
          )
          .get(kbId) as {
          total: number
          ready: number
          processing: number
          failed: number
          total_bytes: number
          last_indexed_at: number | null
        }

        // 4. Aggregate Chunk statistics (knowledge_chunks)
        const chunkStats = this.db
          .prepare(
            `
            SELECT
              count(*) AS total_chunks,
              coalesce(sum(token_count), 0) AS total_tokens
            FROM knowledge_chunks
            WHERE knowledge_base_id = ?
          `
          )
          .get(kbId) as { total_chunks: number; total_tokens: number }

        // 5. Query Recent Activity (bounded to 10 newest items)
        const activityRows = this.db
          .prepare(
            `
            SELECT * FROM (
              SELECT
                id AS id,
                'bot_created' AS type,
                name AS title,
                model_id AS detail,
                created_at AS timestamp,
                status AS status
              FROM bots
              WHERE knowledge_base_id = :kbId

              UNION ALL

              SELECT
                id || ':updated' AS id,
                'bot_updated' AS type,
                name AS title,
                status AS detail,
                updated_at AS timestamp,
                status AS status
              FROM bots
              WHERE knowledge_base_id = :kbId AND updated_at > created_at

              UNION ALL

              SELECT
                id AS id,
                'document_registered' AS type,
                original_file_name AS title,
                file_type AS detail,
                created_at AS timestamp,
                indexing_status AS status
              FROM knowledge_sources
              WHERE knowledge_base_id = :kbId

              UNION ALL

              SELECT
                id || ':indexed' AS id,
                'document_indexed' AS type,
                original_file_name AS title,
                file_type AS detail,
                indexed_at AS timestamp,
                'ready' AS status
              FROM knowledge_sources
              WHERE knowledge_base_id = :kbId AND indexed_at IS NOT NULL AND indexing_status = 'ready'

              UNION ALL

              SELECT
                id || ':failed' AS id,
                'document_failed' AS type,
                original_file_name AS title,
                coalesce(error_message, 'Indexing failed') AS detail,
                updated_at AS timestamp,
                'failed' AS status
              FROM knowledge_sources
              WHERE knowledge_base_id = :kbId AND indexing_status = 'failed'

              UNION ALL

              SELECT
                id AS id,
                'agent_run' AS type,
                selected_model AS title,
                NULL AS detail,
                started_at AS timestamp,
                status AS status
              FROM agent_runs
              WHERE knowledge_base_id = :kbId
            )
            ORDER BY timestamp DESC, id DESC
            LIMIT 10
          `
          )
          .all({ kbId }) as Array<{
          id: string
          type: KnowledgeBaseActivityType
          title: string
          detail: string | null
          timestamp: number
          status: string | null
        }>

        const recentActivity: KnowledgeBaseActivityItemDto[] = activityRows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          ...(row.detail ? { detail: row.detail } : {}),
          timestamp: Number(row.timestamp),
          ...(row.status ? { status: row.status } : {})
        }))

        return {
          knowledgeBaseId: kbId,
          bots: {
            total: Number(botStats.total),
            active: Number(botStats.active),
            archived: Number(botStats.archived)
          },
          documents: {
            total: Number(docStats.total),
            ready: Number(docStats.ready),
            processing: Number(docStats.processing),
            failed: Number(docStats.failed),
            totalBytes: Number(docStats.total_bytes)
          },
          indexing: {
            totalChunks: Number(chunkStats.total_chunks),
            totalTokens: Number(chunkStats.total_tokens),
            lastIndexedAt: docStats.last_indexed_at ? Number(docStats.last_indexed_at) : null
          },
          recentActivity
        }
      })

      return getOverviewTx(id)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to retrieve Knowledge Base overview: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private validateId(id: string): void {
    const parseResult = idSchema.safeParse(id)
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid UUIDv4.`
      )
    }
  }
}
