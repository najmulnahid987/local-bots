import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type BotMemory,
  type CreateBotMemoryRepositoryInput,
  type UpdateBotMemoryRepositoryInput,
  type ListBotMemoriesRepositoryOptions,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'
import {
  BOT_MEMORY_TYPES,
  MAX_BOT_MEMORY_CONTENT_LENGTH,
  type BotMemoryType
} from '../../../shared/bot-memories'

interface BotMemoryRow {
  id: string
  bot_id: string
  knowledge_base_id: string
  memory_type: 'user_note' | 'pinned_instruction'
  content: string
  created_at: number
  updated_at: number
}

/**
 * Main-process repository providing typed CRUD operations for Bot memories.
 * Strictly preserves the composite (bot_id, knowledge_base_id) isolation invariant.
 */
export class BotMemoryRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for BotMemoryRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new memory for a specific Bot and its parent Knowledge Base.
   * Generates memory UUIDv4 and timestamps internally unless explicitly specified.
   */
  public create(input: CreateBotMemoryRepositoryInput): BotMemory {
    if (!input) {
      throw new ValidationError('Input is required to create a Bot memory.')
    }

    this.validateUuid(input.botId, 'Bot')
    this.validateUuid(input.knowledgeBaseId, 'Knowledge Base')

    if (input.id !== undefined) {
      this.validateUuid(input.id, 'Memory')
    }

    const memoryType: BotMemoryType = input.memoryType ?? 'user_note'
    if (!BOT_MEMORY_TYPES.includes(memoryType)) {
      throw new ValidationError(
        `Invalid memory type: '${memoryType}'. Supported types are: ${BOT_MEMORY_TYPES.join(', ')}.`
      )
    }

    const trimmedContent = typeof input.content === 'string' ? input.content.trim() : ''
    if (trimmedContent.length === 0) {
      throw new ValidationError('Memory content cannot be blank.')
    }
    if (trimmedContent.length > MAX_BOT_MEMORY_CONTENT_LENGTH) {
      throw new ValidationError(
        `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH} characters.`
      )
    }

    // Verify parent Bot exists and belongs to the specified Knowledge Base
    const botExists = this.db
      .prepare('SELECT 1 FROM bots WHERE id = ? AND knowledge_base_id = ?')
      .get(input.botId, input.knowledgeBaseId)

    if (!botExists) {
      throw new ValidationError(
        `Parent Bot with ID '${input.botId}' does not exist in Knowledge Base '${input.knowledgeBaseId}'.`
      )
    }

    const id = input.id ?? randomUUID()
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        INSERT INTO bot_memories (
          id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?
        )
      `)

      stmt.run(id, input.botId, input.knowledgeBaseId, memoryType, trimmedContent, now, now)

      return {
        id,
        botId: input.botId,
        knowledgeBaseId: input.knowledgeBaseId,
        memoryType,
        content: trimmedContent,
        createdAt: now,
        updatedAt: now
      }
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to persist Bot memory: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a memory by ID within its authoritative Bot and Knowledge Base scope.
   * Never returns a memory belonging to another Bot or Knowledge Base.
   */
  public getById(memoryId: string, botId: string, knowledgeBaseId: string): BotMemory | null {
    this.validateUuid(memoryId, 'Memory')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        SELECT id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
        FROM bot_memories
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `)

      const row = stmt.get(memoryId, botId, knowledgeBaseId) as BotMemoryRow | undefined
      if (!row) {
        return null
      }

      return this.mapRowToBotMemory(row)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to retrieve Bot memory: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves all memories belonging to one Bot in its parent Knowledge Base.
   * Orders results by updated_at DESC.
   */
  public listByBot(
    botId: string,
    knowledgeBaseId: string,
    options?: ListBotMemoriesRepositoryOptions
  ): BotMemory[] {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    if (options?.memoryType && !BOT_MEMORY_TYPES.includes(options.memoryType)) {
      throw new ValidationError(
        `Invalid memory type filter: '${options.memoryType}'. Supported types are: ${BOT_MEMORY_TYPES.join(', ')}.`
      )
    }

    try {
      let rows: BotMemoryRow[]
      if (options?.memoryType) {
        const stmt = this.db.prepare(`
          SELECT id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
          FROM bot_memories
          WHERE bot_id = ? AND knowledge_base_id = ? AND memory_type = ?
          ORDER BY updated_at DESC
        `)
        rows = stmt.all(botId, knowledgeBaseId, options.memoryType) as BotMemoryRow[]
      } else {
        const stmt = this.db.prepare(`
          SELECT id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
          FROM bot_memories
          WHERE bot_id = ? AND knowledge_base_id = ?
          ORDER BY updated_at DESC
        `)
        rows = stmt.all(botId, knowledgeBaseId) as BotMemoryRow[]
      }

      return rows.map((row) => this.mapRowToBotMemory(row))
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to list Bot memories: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates an existing memory's editable fields (content, memory_type).
   * Automatically advances updated_at while preserving id, bot_id, knowledge_base_id, and created_at.
   * Fails safely (returns null) if memory does not belong to the authoritative Bot.
   */
  public update(
    memoryId: string,
    botId: string,
    knowledgeBaseId: string,
    input: UpdateBotMemoryRepositoryInput
  ): BotMemory | null {
    this.validateUuid(memoryId, 'Memory')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    if (!input || (input.content === undefined && input.memoryType === undefined)) {
      throw new ValidationError(
        'At least one editable field (content or memoryType) must be provided for update.'
      )
    }

    let trimmedContent: string | undefined
    if (input.content !== undefined) {
      trimmedContent = input.content.trim()
      if (trimmedContent.length === 0) {
        throw new ValidationError('Memory content cannot be blank.')
      }
      if (trimmedContent.length > MAX_BOT_MEMORY_CONTENT_LENGTH) {
        throw new ValidationError(
          `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH} characters.`
        )
      }
    }

    if (input.memoryType !== undefined && !BOT_MEMORY_TYPES.includes(input.memoryType)) {
      throw new ValidationError(
        `Invalid memory type: '${input.memoryType}'. Supported types are: ${BOT_MEMORY_TYPES.join(', ')}.`
      )
    }

    // Verify existing record belongs to the authoritative Bot and Knowledge Base
    const existing = this.db
      .prepare(
        `
        SELECT created_at, updated_at, content, memory_type
        FROM bot_memories
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `
      )
      .get(memoryId, botId, knowledgeBaseId) as
      { created_at: number; updated_at: number; content: string; memory_type: string } | undefined

    if (!existing) {
      return null
    }

    const now = Date.now()
    const updatedAt = Math.max(now, existing.updated_at, existing.created_at)
    const nextContent = trimmedContent !== undefined ? trimmedContent : existing.content
    const nextMemoryType = input.memoryType !== undefined ? input.memoryType : existing.memory_type

    try {
      this.db
        .prepare(
          `
          UPDATE bot_memories
          SET content = ?, memory_type = ?, updated_at = ?
          WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
        `
        )
        .run(nextContent, nextMemoryType, updatedAt, memoryId, botId, knowledgeBaseId)

      return this.getById(memoryId, botId, knowledgeBaseId)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to update Bot memory: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a memory within the specified authoritative Bot scope.
   * Returns true if deleted, false if not found within the authoritative scope.
   */
  public delete(memoryId: string, botId: string, knowledgeBaseId: string): boolean {
    this.validateUuid(memoryId, 'Memory')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        DELETE FROM bot_memories
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `)

      const result = stmt.run(memoryId, botId, knowledgeBaseId)
      return result.changes > 0
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to delete Bot memory: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Returns the total count of memories for one Bot within its Knowledge Base.
   */
  public countByBot(
    botId: string,
    knowledgeBaseId: string,
    options?: ListBotMemoriesRepositoryOptions
  ): number {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    if (options?.memoryType && !BOT_MEMORY_TYPES.includes(options.memoryType)) {
      throw new ValidationError(
        `Invalid memory type filter: '${options.memoryType}'. Supported types are: ${BOT_MEMORY_TYPES.join(', ')}.`
      )
    }

    try {
      if (options?.memoryType) {
        const stmt = this.db.prepare(`
          SELECT count(*) as count
          FROM bot_memories
          WHERE bot_id = ? AND knowledge_base_id = ? AND memory_type = ?
        `)
        const row = stmt.get(botId, knowledgeBaseId, options.memoryType) as { count: number }
        return row.count
      }

      const stmt = this.db.prepare(`
        SELECT count(*) as count
        FROM bot_memories
        WHERE bot_id = ? AND knowledge_base_id = ?
      `)
      const row = stmt.get(botId, knowledgeBaseId) as { count: number }
      return row.count
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to count Bot memories: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private mapRowToBotMemory(row: BotMemoryRow): BotMemory {
    return {
      id: row.id,
      botId: row.bot_id,
      knowledgeBaseId: row.knowledge_base_id,
      memoryType: row.memory_type,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private validateUuid(value: string, entityLabel: string): void {
    const parseResult = idSchema.safeParse(value)
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid ${entityLabel} identifier: '${value}'. Must be a valid UUIDv4 string.`
      )
    }
  }
}
