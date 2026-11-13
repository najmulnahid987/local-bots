import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type ConversationDto,
  toConversationDto,
  conversationTitleSchema,
  DEFAULT_CONVERSATION_TITLE
} from '../../../shared/conversations'
import {
  type CreateConversationRepositoryInput,
  type ListConversationsRepositoryOptions,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'

interface ConversationRow {
  id: string
  bot_id: string
  knowledge_base_id: string
  title: string
  created_at: number
  updated_at: number
  archived_at: number | null
}

/**
 * Main-process repository providing typed CRUD operations for conversations.
 * Strictly enforces single-bot and parent Knowledge Base ownership.
 */
export class ConversationRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for ConversationRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new conversation thread scoped strictly to a Bot and its parent Knowledge Base.
   * Generates conversation UUIDv4 and timestamps internally.
   */
  public create(input: CreateConversationRepositoryInput): ConversationDto {
    this.validateUuid(input.botId, 'Bot')
    this.validateUuid(input.knowledgeBaseId, 'Knowledge Base')

    let title = DEFAULT_CONVERSATION_TITLE
    if (input.title !== undefined) {
      const titleParse = conversationTitleSchema.safeParse(input.title)
      if (!titleParse.success) {
        throw new ValidationError(
          `Failed to create conversation: ${titleParse.error.issues[0].message}`
        )
      }
      title = titleParse.data
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

    const id = randomUUID()
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        INSERT INTO conversations (
          id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, NULL
        )
      `)
      stmt.run(id, input.botId, input.knowledgeBaseId, title, now, now)

      return {
        id,
        botId: input.botId,
        knowledgeBaseId: input.knowledgeBaseId,
        title,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      }
    } catch (err) {
      throw new RepositoryError(
        `Failed to persist conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a conversation matching all three identifiers: conversationId, botId, knowledgeBaseId.
   * Returns null if no matching record exists.
   */
  public getById(
    conversationId: string,
    botId: string,
    knowledgeBaseId: string
  ): ConversationDto | null {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        FROM conversations
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `)
      const row = stmt.get(conversationId, botId, knowledgeBaseId) as ConversationRow | undefined
      if (!row) {
        return null
      }
      return toConversationDto(row)
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to retrieve conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a conversation strictly by Conversation ID, resolving its authoritative
   * parent Bot ID and Knowledge Base ID.
   * Internal Main-process use only (e.g., authoritative scope resolution for persistence).
   * Returns null if not found.
   */
  public getByIdOnly(conversationId: string): ConversationDto | null {
    this.validateUuid(conversationId, 'Conversation')

    try {
      const stmt = this.db.prepare(`
        SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        FROM conversations
        WHERE id = ?
      `)
      const row = stmt.get(conversationId) as ConversationRow | undefined
      if (!row) {
        return null
      }
      return toConversationDto(row)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to retrieve conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists conversations strictly scoped to a Bot and parent Knowledge Base.
   * Orders newest first by updated_at DESC, with deterministic secondary sort on id ASC.
   */
  public listByBot(
    botId: string,
    knowledgeBaseId: string,
    options?: ListConversationsRepositoryOptions
  ): ConversationDto[] {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    const includeArchived = options?.includeArchived ?? false
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 200))
    const offset = Math.max(0, options?.offset ?? 0)

    try {
      const sql = `
        SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        FROM conversations
        WHERE bot_id = ? AND knowledge_base_id = ?
          ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY updated_at DESC, id ASC
        LIMIT ? OFFSET ?
      `
      const stmt = this.db.prepare(sql)
      const rows = stmt.all(botId, knowledgeBaseId, limit, offset) as ConversationRow[]
      return rows.map(toConversationDto)
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to list conversations: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates the title of an existing conversation matching all three ownership identifiers.
   * Monotonically updates updated_at timestamp.
   */
  public rename(
    conversationId: string,
    botId: string,
    knowledgeBaseId: string,
    title: string
  ): ConversationDto | null {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    const titleParse = conversationTitleSchema.safeParse(title)
    if (!titleParse.success) {
      throw new ValidationError(
        `Failed to rename conversation: ${titleParse.error.issues[0].message}`
      )
    }
    const sanitizedTitle = titleParse.data

    const existing = this.db
      .prepare(
        `
        SELECT created_at, updated_at FROM conversations
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `
      )
      .get(conversationId, botId, knowledgeBaseId) as
      { created_at: number; updated_at: number } | undefined

    if (!existing) {
      return null
    }

    const now = Date.now()
    const updatedAt = Math.max(now, existing.updated_at, existing.created_at)

    try {
      this.db
        .prepare(
          `
          UPDATE conversations
          SET title = ?, updated_at = ?
          WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
        `
        )
        .run(sanitizedTitle, updatedAt, conversationId, botId, knowledgeBaseId)

      return this.getById(conversationId, botId, knowledgeBaseId)
    } catch (err) {
      throw new RepositoryError(
        `Failed to rename conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a conversation by matching all three ownership identifiers.
   * Foreign keys cascade automatically to messages and linked agent runs.
   * Returns true if deleted, false if not found.
   */
  public delete(conversationId: string, botId: string, knowledgeBaseId: string): boolean {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        DELETE FROM conversations
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `)
      const result = stmt.run(conversationId, botId, knowledgeBaseId)
      return result.changes > 0
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete conversation: ${err instanceof Error ? err.message : String(err)}`
      )
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
