import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
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

  private validateId(id: string): void {
    const parseResult = idSchema.safeParse(id)
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid UUIDv4.`
      )
    }
  }
}
