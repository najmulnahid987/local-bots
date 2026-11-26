import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type MessageDto,
  toMessageDto,
  messageRoleSchema,
  messageContentFormatSchema,
  messageMetadataSchema,
  messageTokenUsageSchema,
  serializeMessageMetadata,
  serializeMessageTokenUsage,
  MAX_MESSAGE_CONTENT_LENGTH
} from '../../../shared/conversations'
import {
  type CreateMessageRepositoryInput,
  type ListMessagesRepositoryOptions,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'

interface MessageRow {
  id: string
  conversation_id: string
  segment_id?: string | null
  role: string
  content: string
  content_format: string
  metadata_json: string
  token_usage_json: string
  created_at: number
}

/**
 * Main-process repository providing typed CRUD operations for conversation messages.
 * Enforces Message -> Conversation -> Bot -> Knowledge Base ownership chains.
 */
export class MessageRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for MessageRepository.')
    }
    this.db = db
  }

  /**
   * Persists a message into a conversation under atomic ownership verification.
   * Updates parent conversation's updated_at monotonically.
   * Strictly validates metadata before writing so citations are never silently discarded.
   */
  public create(input: CreateMessageRepositoryInput): MessageDto {
    this.validateUuid(input.conversationId, 'Conversation')
    this.validateUuid(input.botId, 'Bot')
    this.validateUuid(input.knowledgeBaseId, 'Knowledge Base')

    const roleParse = messageRoleSchema.safeParse(input.role)
    if (!roleParse.success) {
      throw new ValidationError(`Invalid message role: ${roleParse.error.issues[0].message}`)
    }
    const role = roleParse.data

    const formatParse = messageContentFormatSchema.safeParse(input.contentFormat ?? 'markdown')
    if (!formatParse.success) {
      throw new ValidationError(`Invalid content format: ${formatParse.error.issues[0].message}`)
    }
    const contentFormat = formatParse.data

    if (typeof input.content !== 'string') {
      throw new ValidationError('Message content must be a string.')
    }
    if (input.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      throw new ValidationError(
        `Message content exceeds maximum allowed length of ${MAX_MESSAGE_CONTENT_LENGTH} characters.`
      )
    }

    // Strict validation of new metadata to ensure citations and tool calls are well-formed
    if (input.metadata !== undefined && input.metadata !== null) {
      const metaParse = messageMetadataSchema.safeParse(input.metadata)
      if (!metaParse.success) {
        const msg = metaParse.error.issues.map((i) => i.message).join('; ')
        throw new ValidationError(`Invalid message metadata: ${msg}`)
      }
    }

    if (input.tokenUsage !== undefined && input.tokenUsage !== null) {
      const usageParse = messageTokenUsageSchema.safeParse(input.tokenUsage)
      if (!usageParse.success) {
        const msg = usageParse.error.issues.map((i) => i.message).join('; ')
        throw new ValidationError(`Invalid token usage: ${msg}`)
      }
    }

    let segmentId: string | null = input.segmentId ?? null
    if (segmentId) {
      this.validateUuid(segmentId, 'Conversation Segment')
    }

    const id = randomUUID()
    const now = Date.now()
    const metadataJson = serializeMessageMetadata(input.metadata)
    const tokenUsageJson = serializeMessageTokenUsage(input.tokenUsage)

    let effectiveCreatedAt = now

    // Execute ownership check, conversation updated_at update, and message insertion inside a transaction
    const executeInsert = this.db.transaction(() => {
      const conv = this.db
        .prepare(
          `
          SELECT created_at, updated_at FROM conversations
          WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
        `
        )
        .get(input.conversationId, input.botId, input.knowledgeBaseId) as
        { created_at: number; updated_at: number } | undefined

      if (!conv) {
        throw new ValidationError(
          `Conversation with ID '${input.conversationId}' does not exist under Bot '${input.botId}' in Knowledge Base '${input.knowledgeBaseId}'.`
        )
      }

      // If no segmentId was provided, look up the latest active segment for the conversation
      if (!segmentId) {
        const latestSeg = this.db
          .prepare(
            'SELECT id FROM conversation_segments WHERE conversation_id = ? ORDER BY segment_order DESC LIMIT 1'
          )
          .get(input.conversationId) as { id: string } | undefined
        if (latestSeg) {
          segmentId = latestSeg.id
        }
      }

      // Ensure monotonic created_at for messages within the conversation so chronological ordering is strictly preserved
      const latestMsg = this.db
        .prepare('SELECT MAX(created_at) as max_created_at FROM messages WHERE conversation_id = ?')
        .get(input.conversationId) as { max_created_at: number | null } | undefined
      effectiveCreatedAt =
        latestMsg?.max_created_at !== null && latestMsg?.max_created_at !== undefined
          ? Math.max(now, latestMsg.max_created_at + 1)
          : now

      // Monotonic-safe conversation timestamp update
      const newUpdatedAt = Math.max(effectiveCreatedAt, conv.updated_at, conv.created_at)
      this.db
        .prepare(
          `
          UPDATE conversations SET updated_at = ? WHERE id = ?
        `
        )
        .run(newUpdatedAt, input.conversationId)

      // Update segment statistics if assigned
      if (segmentId) {
        this.db
          .prepare(
            `
            UPDATE conversation_segments
            SET message_count = message_count + 1,
                first_message_created_at = COALESCE(first_message_created_at, ?),
                last_message_created_at = ?
            WHERE id = ?
          `
          )
          .run(effectiveCreatedAt, effectiveCreatedAt, segmentId)
      }

      this.db
        .prepare(
          `
          INSERT INTO messages (
            id, conversation_id, segment_id, role, content, content_format, metadata_json, token_usage_json, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `
        )
        .run(
          id,
          input.conversationId,
          segmentId,
          role,
          input.content,
          contentFormat,
          metadataJson,
          tokenUsageJson,
          effectiveCreatedAt
        )
    })

    try {
      executeInsert()
    } catch (err) {
      if (err instanceof ValidationError || err instanceof RepositoryError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to persist message: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return {
      id,
      conversationId: input.conversationId,
      segmentId,
      role,
      content: input.content,
      contentFormat,
      metadata: input.metadata ?? {},
      tokenUsage: input.tokenUsage ?? null,
      createdAt: effectiveCreatedAt
    }
  }

  /**
   * Retrieves a message only if the complete ownership chain matches:
   * Message -> Conversation -> Bot -> Knowledge Base.
   */
  public getById(
    messageId: string,
    conversationId: string,
    botId: string,
    knowledgeBaseId: string
  ): MessageDto | null {
    this.validateUuid(messageId, 'Message')
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        SELECT m.id, m.conversation_id, m.segment_id, m.role, m.content, m.content_format,
               m.metadata_json, m.token_usage_json, m.created_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ? AND m.conversation_id = ? AND c.bot_id = ? AND c.knowledge_base_id = ?
      `)
      const row = stmt.get(messageId, conversationId, botId, knowledgeBaseId) as
        MessageRow | undefined
      if (!row) {
        return null
      }
      return toMessageDto(row)
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to retrieve message: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists messages belonging strictly to the specified conversation, Bot and Knowledge Base.
   * Orders oldest first by created_at ASC, id ASC for deterministic chronological sorting.
   */
  public listByConversation(
    conversationId: string,
    botId: string,
    knowledgeBaseId: string,
    options?: ListMessagesRepositoryOptions
  ): MessageDto[] {
    this.validateUuid(conversationId, 'Conversation')
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    // Verify conversation ownership before listing
    const conv = this.db
      .prepare(
        `
        SELECT 1 FROM conversations
        WHERE id = ? AND bot_id = ? AND knowledge_base_id = ?
      `
      )
      .get(conversationId, botId, knowledgeBaseId)

    if (!conv) {
      throw new ValidationError(
        `Conversation with ID '${conversationId}' does not exist under Bot '${botId}' in Knowledge Base '${knowledgeBaseId}'.`
      )
    }

    const limit = options?.limit !== undefined ? Math.max(1, Math.min(options.limit, 10000)) : 10000
    const offset = Math.max(0, options?.offset ?? 0)

    try {
      const stmt = this.db.prepare(`
        SELECT m.id, m.conversation_id, m.segment_id, m.role, m.content, m.content_format,
               m.metadata_json, m.token_usage_json, m.created_at
        FROM messages m
        LEFT JOIN conversation_segments cs ON cs.id = m.segment_id
        WHERE m.conversation_id = ?
        ORDER BY COALESCE(cs.segment_order, 2147483647) ASC, m.created_at ASC, m.id ASC
        LIMIT ? OFFSET ?
      `)
      const rows = stmt.all(conversationId, limit, offset) as MessageRow[]
      return rows.map(toMessageDto)
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to list messages: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a message by ID. If the message was associated with a segment,
   * decrements the segment's message_count.
   * Returns true if a row was deleted, false otherwise.
   */
  public delete(messageId: string): boolean {
    this.validateUuid(messageId, 'Message')
    try {
      return this.db.transaction(() => {
        const msg = this.db
          .prepare('SELECT segment_id FROM messages WHERE id = ?')
          .get(messageId) as { segment_id: string | null } | undefined
        if (!msg) {
          return false
        }
        const res = this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
        if (res.changes > 0 && msg.segment_id) {
          this.db
            .prepare(
              'UPDATE conversation_segments SET message_count = MAX(0, message_count - 1) WHERE id = ?'
            )
            .run(msg.segment_id)
        }
        return res.changes > 0
      })()
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to delete message: ${err instanceof Error ? err.message : String(err)}`
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
