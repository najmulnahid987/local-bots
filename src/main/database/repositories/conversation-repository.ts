import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type ConversationDto,
  type ConversationSegmentDto,
  type ClearConversationResultDto,
  toConversationDto,
  toConversationSegmentDto,
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

interface ConversationSegmentRow {
  id: string
  conversation_id: string
  original_conversation_id: string
  title: string
  segment_order: number
  first_message_created_at: number | null
  last_message_created_at: number | null
  message_count: number
  created_at: number
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
      const executeTx = this.db.transaction(() => {
        const stmtConv = this.db.prepare(`
          INSERT INTO conversations (
            id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, NULL
          )
        `)
        stmtConv.run(id, input.botId, input.knowledgeBaseId, title, now, now)

        const stmtSegment = this.db.prepare(`
          INSERT INTO conversation_segments (
            id, conversation_id, original_conversation_id, title, segment_order,
            first_message_created_at, last_message_created_at, message_count,
            created_at, archived_at
          ) VALUES (
            ?, ?, ?, ?, 0, NULL, NULL, 0, ?, NULL
          )
        `)
        stmtSegment.run(id, id, id, title, now)
      })

      executeTx()

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
      if (err instanceof ValidationError || err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to persist conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves or creates the single canonical conversation for a Bot.
   * If a conversation already exists for the Bot, returns it idempotently without error.
   */
  public getOrCreate(input: CreateConversationRepositoryInput): ConversationDto {
    const existing = this.getByBotId(input.botId, input.knowledgeBaseId)
    if (existing) {
      return existing
    }
    return this.create(input)
  }

  /**
   * Retrieves the conversation strictly owned by a Bot in a parent Knowledge Base.
   * Returns null if no conversation exists for the Bot.
   */
  public getByBotId(botId: string, knowledgeBaseId: string): ConversationDto | null {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        FROM conversations
        WHERE bot_id = ? AND knowledge_base_id = ?
      `)
      const row = stmt.get(botId, knowledgeBaseId) as ConversationRow | undefined
      if (!row) {
        return null
      }
      return toConversationDto(row)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to retrieve conversation by Bot ID: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves the conversation owned by a Bot, resolving its Knowledge Base ID.
   * Internal Main-process use only.
   */
  public getByBotIdOnly(botId: string): ConversationDto | null {
    this.validateUuid(botId, 'Bot')

    try {
      const stmt = this.db.prepare(`
        SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
        FROM conversations
        WHERE bot_id = ?
      `)
      const row = stmt.get(botId) as ConversationRow | undefined
      if (!row) {
        return null
      }
      return toConversationDto(row)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to retrieve conversation by Bot ID: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves all historical conversation segments for a conversation,
   * sorted by segment_order ASC, created_at ASC.
   */
  public getSegments(conversationId: string): ConversationSegmentDto[] {
    this.validateUuid(conversationId, 'Conversation')

    try {
      const stmt = this.db.prepare(`
        SELECT id, conversation_id, original_conversation_id, title, segment_order,
               first_message_created_at, last_message_created_at, message_count,
               created_at, archived_at
        FROM conversation_segments
        WHERE conversation_id = ?
        ORDER BY segment_order ASC, created_at ASC
      `)
      const rows = stmt.all(conversationId) as ConversationSegmentRow[]
      return rows.map(toConversationSegmentDto)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to retrieve conversation segments: ${err instanceof Error ? err.message : String(err)}`
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
   * Computes non-destructive counts prior to clearing a canonical conversation.
   * Returns null if conversation does not exist under the ownership tuple.
   */
  public getClearPreviewStats(
    conversationId: string,
    botId: string,
    knowledgeBaseId: string
  ): {
    readonly conversation: ConversationDto
    readonly messageCount: number
    readonly segmentCount: number
    readonly agentRunCount: number
    readonly toolEventCount: number
    readonly activeAgentRunCount: number
  } | null {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    const conversation = this.getById(conversationId, botId, knowledgeBaseId)
    if (!conversation) {
      return null
    }

    const messageCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { c: number }
    ).c

    const segmentCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM conversation_segments WHERE conversation_id = ?')
        .get(conversationId) as { c: number }
    ).c

    const agentRunCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM agent_runs WHERE conversation_id = ?')
        .get(conversationId) as { c: number }
    ).c

    const toolEventCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM tool_events te
           JOIN agent_runs ar ON te.agent_run_id = ar.id
           WHERE ar.conversation_id = ?`
        )
        .get(conversationId) as { c: number }
    ).c

    const activeAgentRunCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM agent_runs
           WHERE conversation_id = ? AND status IN ('pending', 'running', 'awaiting_approval')`
        )
        .get(conversationId) as { c: number }
    ).c

    return {
      conversation,
      messageCount,
      segmentCount,
      agentRunCount,
      toolEventCount,
      activeAgentRunCount
    }
  }

  /**
   * Atomically clears all messages and resets historical segments for a Bot's canonical
   * conversation while retaining the conversation row/ID and preserving Agent Task audit records.
   */
  public clearConversation(
    conversationId: string,
    botId: string,
    knowledgeBaseId: string
  ): ClearConversationResultDto | null {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const executeClearTx = this.db.transaction((): ClearConversationResultDto | null => {
        const existingRow = this.db
          .prepare(
            `SELECT id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
             FROM conversations
             WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?`
          )
          .get(conversationId, botId, knowledgeBaseId) as ConversationRow | undefined

        if (!existingRow) {
          return null
        }

        const activeRunRow = this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM agent_runs
             WHERE conversation_id = ? AND status IN ('pending', 'running', 'awaiting_approval')`
          )
          .get(conversationId) as { c: number }

        if (activeRunRow.c > 0) {
          throw new RepositoryError(
            'Cannot clear conversation while an Agent Task is currently active.'
          )
        }

        const msgDelResult = this.db
          .prepare('DELETE FROM messages WHERE conversation_id = ?')
          .run(conversationId)
        const deletedMessagesCount = msgDelResult.changes

        // Preserve historical Agent Task & tool_events audit trail under bot_id & kb_id,
        // detaching from the cleared conversation transcript cleanly (conversation_id is nullable)
        const runsDetachResult = this.db
          .prepare('UPDATE agent_runs SET conversation_id = NULL WHERE conversation_id = ?')
          .run(conversationId)
        const preservedAgentRunsCount = runsDetachResult.changes

        // Reset historical segment metadata cleanly and recreate fresh active empty segment
        this.db
          .prepare('DELETE FROM conversation_segments WHERE conversation_id = ?')
          .run(conversationId)

        const now = Date.now()
        const newUpdatedAt = Math.max(now, existingRow.updated_at, existingRow.created_at)
        const newSegmentId = randomUUID()

        this.db
          .prepare(
            `INSERT INTO conversation_segments (
              id, conversation_id, original_conversation_id, title, segment_order,
              first_message_created_at, last_message_created_at, message_count,
              created_at, archived_at
            ) VALUES (
              ?, ?, ?, ?, 0, NULL, NULL, 0, ?, NULL
            )`
          )
          .run(newSegmentId, conversationId, conversationId, existingRow.title, now)

        this.db
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(newUpdatedAt, conversationId)

        const updatedConversation = toConversationDto({
          ...existingRow,
          updated_at: newUpdatedAt
        })
        const activeSegment = toConversationSegmentDto({
          id: newSegmentId,
          conversation_id: conversationId,
          original_conversation_id: conversationId,
          title: existingRow.title,
          segment_order: 0,
          first_message_created_at: null,
          last_message_created_at: null,
          message_count: 0,
          created_at: now,
          archived_at: null
        })

        return {
          success: true,
          conversation: updatedConversation,
          activeSegment,
          deletedMessagesCount,
          preservedAgentRunsCount
        }
      })

      return executeClearTx()
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to clear conversation: ${err instanceof Error ? err.message : String(err)}`
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
