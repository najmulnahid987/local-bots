import type Database from 'better-sqlite3'
import {
  type ConversationDto,
  type MessageDto,
  type CreateConversationRequest,
  type ListConversationsRequest,
  type DeleteConversationResultDto,
  type ResolveCitationRequest,
  type ResolvedCitationTargetDto,
  createConversationRequestSchema,
  conversationTitleSchema,
  conversationIdSchema
} from '../../shared/conversations'
import { idSchema, ValidationError } from '../database/repositories/types'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ActiveWorkspaceContext, type SessionId } from './active-workspace-context'

export type ConversationManagerErrorCode =
  | 'NO_ACTIVE_WORKSPACE'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ARCHIVED'
  | 'BOT_NOT_FOUND'
  | 'BOT_MISMATCH'
  | 'BOT_ARCHIVED'
  | 'MESSAGE_NOT_FOUND'
  | 'CITATION_NOT_FOUND'
  | 'CITATION_SOURCE_UNAVAILABLE'
  | 'CITATION_CHUNK_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'PERSISTENCE_ERROR'
  | 'INTERNAL_ERROR'

export class ConversationManagerError extends Error {
  readonly code: ConversationManagerErrorCode

  constructor(message: string, code: ConversationManagerErrorCode = 'INTERNAL_ERROR') {
    super(message)
    this.name = 'ConversationManagerError'
    this.code = code
    Object.setPrototypeOf(this, ConversationManagerError.prototype)
  }
}

export interface ConversationManagerServiceOptions {
  readonly conversationRepo?: ConversationRepository
  readonly messageRepo?: MessageRepository
  readonly botRepo?: BotRepository
  readonly sourceRepo?: KnowledgeSourceRepository
  readonly activeContext?: ActiveWorkspaceContext
  readonly db?: Database.Database
}

/**
 * Main-process service managing the lifecycle, retrieval, and access control
 * of conversations and messages within the active Knowledge Base and parent Bot boundary.
 *
 * Security Invariants:
 * 1. Derives authoritative Knowledge Base ID strictly from ActiveWorkspaceContext (never trusted from caller).
 * 2. Cross-KB conversation access or listing is blocked.
 * 3. Bot ownership within active KB is strictly verified before creating or listing threads.
 * 4. Archived parent Bots cannot have new conversations created.
 * 5. Archived conversations cannot be renamed.
 */
export class ConversationManagerService {
  private readonly conversationRepo: ConversationRepository
  private readonly messageRepo: MessageRepository
  private readonly botRepo: BotRepository
  private readonly sourceRepo?: KnowledgeSourceRepository
  private readonly activeContext?: ActiveWorkspaceContext
  private readonly db?: Database.Database

  constructor(options: ConversationManagerServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new ConversationManagerError(
        'Options object is required for ConversationManagerService.',
        'INVALID_INPUT'
      )
    }

    this.db = options.db
    if (options.db) {
      this.conversationRepo = options.conversationRepo ?? new ConversationRepository(options.db)
      this.messageRepo = options.messageRepo ?? new MessageRepository(options.db)
      this.botRepo = options.botRepo ?? new BotRepository(options.db)
      this.sourceRepo = options.sourceRepo ?? new KnowledgeSourceRepository(options.db)
    } else {
      if (!options.conversationRepo) {
        throw new ConversationManagerError(
          'ConversationRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!options.messageRepo) {
        throw new ConversationManagerError(
          'MessageRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!options.botRepo) {
        throw new ConversationManagerError(
          'BotRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      this.conversationRepo = options.conversationRepo
      this.messageRepo = options.messageRepo
      this.botRepo = options.botRepo
      this.sourceRepo = options.sourceRepo
    }

    this.activeContext = options.activeContext
  }

  /**
   * Resolves the authoritative active Knowledge Base ID for the caller session.
   * Throws NO_ACTIVE_WORKSPACE if not active.
   */
  public getActiveKnowledgeBaseId(sessionId: SessionId): string {
    if (!this.activeContext) {
      throw new ConversationManagerError(
        'ActiveWorkspaceContext is required to resolve session workspace.',
        'NO_ACTIVE_WORKSPACE'
      )
    }
    try {
      return this.activeContext.getActiveWorkspaceId(sessionId)
    } catch {
      throw new ConversationManagerError(
        'No active Knowledge Base workspace found for this session.',
        'NO_ACTIVE_WORKSPACE'
      )
    }
  }

  /**
   * Creates a new conversation thread scoped to a Bot in the active Knowledge Base.
   */
  public createConversation(
    sessionId: SessionId,
    request: CreateConversationRequest
  ): ConversationDto {
    const parseResult = createConversationRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const msg = parseResult.error.issues.map((i) => i.message).join('; ')
      throw new ConversationManagerError(
        `Invalid create conversation payload: ${msg}`,
        'INVALID_INPUT'
      )
    }
    const validated = parseResult.data

    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const bot = this.botRepo.getById(validated.botId, activeKbId)
    if (!bot) {
      throw new ConversationManagerError(
        `Bot with ID '${validated.botId}' does not exist in the active Knowledge Base.`,
        'BOT_MISMATCH'
      )
    }

    if (bot.status === 'archived') {
      throw new ConversationManagerError(
        `Cannot create conversation: Bot '${bot.name}' is archived.`,
        'BOT_ARCHIVED'
      )
    }

    try {
      return this.conversationRepo.create({
        botId: validated.botId,
        knowledgeBaseId: activeKbId,
        title: validated.title
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new ConversationManagerError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationManagerError(
        `Failed to create conversation: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Lists conversations belonging to a Bot in the active Knowledge Base.
   */
  public listConversations(
    sessionId: SessionId,
    request: ListConversationsRequest & { limit?: number; offset?: number }
  ): ConversationDto[] {
    if (!request?.botId) {
      throw new ConversationManagerError(
        'botId is required to list conversations.',
        'INVALID_INPUT'
      )
    }

    const botIdParse = idSchema.safeParse(request.botId)
    if (!botIdParse.success) {
      throw new ConversationManagerError(
        `Invalid botId: ${botIdParse.error.issues[0].message}`,
        'INVALID_INPUT'
      )
    }
    const botId = botIdParse.data

    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const bot = this.botRepo.getById(botId, activeKbId)
    if (!bot) {
      throw new ConversationManagerError(
        `Bot with ID '${botId}' does not exist in the active Knowledge Base.`,
        'BOT_MISMATCH'
      )
    }

    try {
      return this.conversationRepo.listByBot(botId, activeKbId, {
        includeArchived: request.includeArchived,
        limit: request.limit,
        offset: request.offset
      })
    } catch (err) {
      throw new ConversationManagerError(
        `Failed to list conversations: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Retrieves a single conversation by ID, strictly enforcing active Knowledge Base ownership.
   */
  public getConversation(sessionId: SessionId, conversationId: string): ConversationDto {
    this.assertValidUuid(conversationId, 'Conversation')
    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const conversation = this.conversationRepo.getByIdOnly(conversationId)
    if (!conversation || conversation.knowledgeBaseId !== activeKbId) {
      throw new ConversationManagerError(
        `Conversation with ID '${conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    const bot = this.botRepo.getById(conversation.botId, activeKbId)
    if (!bot) {
      throw new ConversationManagerError(
        `Parent Bot of conversation '${conversationId}' does not belong to the active Knowledge Base.`,
        'BOT_MISMATCH'
      )
    }

    return conversation
  }

  /**
   * Loads message history for a conversation in chronological order.
   */
  public getMessages(
    sessionId: SessionId,
    conversationId: string,
    options?: { limit?: number; offset?: number }
  ): MessageDto[] {
    this.assertValidUuid(conversationId, 'Conversation')
    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const conversation = this.conversationRepo.getByIdOnly(conversationId)
    if (!conversation || conversation.knowledgeBaseId !== activeKbId) {
      throw new ConversationManagerError(
        `Conversation with ID '${conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    const bot = this.botRepo.getById(conversation.botId, activeKbId)
    if (!bot) {
      throw new ConversationManagerError(
        `Parent Bot of conversation '${conversationId}' does not belong to the active Knowledge Base.`,
        'BOT_MISMATCH'
      )
    }

    try {
      return this.messageRepo.listByConversation(
        conversationId,
        conversation.botId,
        activeKbId,
        options
      )
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new ConversationManagerError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationManagerError(
        `Failed to load conversation messages: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Renames an active conversation thread.
   */
  public renameConversation(
    sessionId: SessionId,
    conversationId: string,
    title: string
  ): ConversationDto {
    this.assertValidUuid(conversationId, 'Conversation')

    const titleParse = conversationTitleSchema.safeParse(title)
    if (!titleParse.success) {
      throw new ConversationManagerError(
        `Invalid conversation title: ${titleParse.error.issues[0].message}`,
        'INVALID_INPUT'
      )
    }
    const validatedTitle = titleParse.data

    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const conversation = this.conversationRepo.getByIdOnly(conversationId)
    if (!conversation || conversation.knowledgeBaseId !== activeKbId) {
      throw new ConversationManagerError(
        `Conversation with ID '${conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    if (conversation.archivedAt !== null) {
      throw new ConversationManagerError(
        `Conversation '${conversation.title}' is archived and cannot be renamed.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    try {
      const updated = this.conversationRepo.rename(
        conversationId,
        conversation.botId,
        activeKbId,
        validatedTitle
      )
      if (!updated) {
        throw new ConversationManagerError(
          `Conversation with ID '${conversationId}' was not found.`,
          'CONVERSATION_NOT_FOUND'
        )
      }
      return updated
    } catch (err) {
      if (err instanceof ConversationManagerError) throw err
      if (err instanceof ValidationError) {
        throw new ConversationManagerError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationManagerError(
        `Failed to rename conversation: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Deletes a conversation thread and cascades deletion to linked messages.
   */
  public deleteConversation(
    sessionId: SessionId,
    conversationId: string
  ): DeleteConversationResultDto {
    this.assertValidUuid(conversationId, 'Conversation')
    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    const conversation = this.conversationRepo.getByIdOnly(conversationId)
    if (!conversation || conversation.knowledgeBaseId !== activeKbId) {
      throw new ConversationManagerError(
        `Conversation with ID '${conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    try {
      const deleted = this.conversationRepo.delete(conversationId, conversation.botId, activeKbId)
      if (!deleted) {
        throw new ConversationManagerError(
          `Conversation with ID '${conversationId}' was not found.`,
          'CONVERSATION_NOT_FOUND'
        )
      }
      return {
        success: true,
        conversationId
      }
    } catch (err) {
      if (err instanceof ConversationManagerError) throw err
      throw new ConversationManagerError(
        `Failed to delete conversation: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  private assertValidUuid(value: string, label: string): void {
    const parseResult = conversationIdSchema.safeParse(value)
    if (!parseResult.success) {
      throw new ConversationManagerError(
        `Invalid ${label} ID: '${value}'. Must be a valid UUIDv4 string.`,
        'INVALID_INPUT'
      )
    }
  }

  /**
   * Resolves an authentic citation reference to a verified preview target.
   *
   * Security & Integrity Invariants (Phase 7 Step 7.10):
   * 1. Resolves authoritative active Knowledge Base ID strictly from ActiveWorkspaceContext.
   * 2. Verifies that the conversation belongs to the active Knowledge Base.
   * 3. Verifies that the message belongs to that conversation.
   * 4. Inspects persisted message metadata from SQLite to find matching citationNumber.
   * 5. Rejects if citationNumber was not saved in persisted metadata.
   * 6. Verifies that the cited source still exists and belongs to the active Knowledge Base.
   * 7. Verifies that the cited chunk belongs to the cited source and active Knowledge Base.
   * 8. Returns safe preview target with no filesystem paths, internal keys, or credentials.
   */
  public resolveCitation(
    sessionId: SessionId,
    request: ResolveCitationRequest
  ): ResolvedCitationTargetDto {
    this.assertValidUuid(request.conversationId, 'Conversation')
    this.assertValidUuid(request.messageId, 'Message')

    if (!Number.isInteger(request.citationNumber) || request.citationNumber < 1) {
      throw new ConversationManagerError(
        'citationNumber must be a positive integer.',
        'INVALID_INPUT'
      )
    }

    const activeKbId = this.getActiveKnowledgeBaseId(sessionId)

    // 1. Verify conversation belongs to active KB
    const conversation = this.conversationRepo.getByIdOnly(request.conversationId)
    if (!conversation || conversation.knowledgeBaseId !== activeKbId) {
      throw new ConversationManagerError(
        `Conversation '${request.conversationId}' not found in active Knowledge Base.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    // 2. Verify message belongs to this conversation and active KB
    const message = this.messageRepo.getById(
      request.messageId,
      request.conversationId,
      conversation.botId,
      activeKbId
    )
    if (!message) {
      throw new ConversationManagerError(
        `Message '${request.messageId}' not found in conversation '${request.conversationId}'.`,
        'MESSAGE_NOT_FOUND'
      )
    }

    // 3. Find citation in persisted message metadata
    const citations = message.metadata?.citations ?? []
    const citation = citations.find((c) => c.citationNumber === request.citationNumber)
    if (!citation) {
      throw new ConversationManagerError(
        `Citation #${request.citationNumber} not found in persisted message metadata.`,
        'CITATION_NOT_FOUND'
      )
    }

    // 4. Verify cited source in database
    if (this.db) {
      const sourceStmt = this.db.prepare(`
        SELECT id, original_file_name, file_type, indexing_status
        FROM knowledge_sources
        WHERE id = ? AND knowledge_base_id = ?
      `)
      const sourceRow = sourceStmt.get(citation.sourceId, activeKbId) as
        | { id: string; original_file_name: string; file_type: string; indexing_status: string }
        | undefined

      if (!sourceRow) {
        throw new ConversationManagerError(
          `Cited source '${citation.sourceId}' does not exist or does not belong to active Knowledge Base.`,
          'CITATION_SOURCE_UNAVAILABLE'
        )
      }

      // 5. Verify cited chunk in database
      const chunkStmt = this.db.prepare(`
        SELECT id, chunk_index, page_number, metadata_json
        FROM knowledge_chunks
        WHERE id = ? AND source_id = ? AND knowledge_base_id = ?
      `)
      const chunkRow = chunkStmt.get(citation.chunkId, citation.sourceId, activeKbId) as
        | { id: string; chunk_index: number; page_number: number | null; metadata_json: string }
        | undefined

      if (!chunkRow) {
        throw new ConversationManagerError(
          `Cited chunk '${citation.chunkId}' does not exist or does not belong to cited source.`,
          'CITATION_CHUNK_UNAVAILABLE'
        )
      }

      let parsedHeadingPath: readonly string[] | null = null
      try {
        const parsedMeta = JSON.parse(chunkRow.metadata_json)
        if (Array.isArray(parsedMeta.headingPath)) {
          parsedHeadingPath = parsedMeta.headingPath
        }
      } catch {
        // Use fallback from citation DTO
      }

      return {
        citationNumber: citation.citationNumber,
        sourceId: citation.sourceId,
        chunkId: citation.chunkId,
        knowledgeBaseId: activeKbId,
        fileName: sourceRow.original_file_name,
        fileType: citation.fileType,
        pageNumber: chunkRow.page_number ?? citation.pageNumber,
        headingPath: parsedHeadingPath ?? citation.headingPath,
        chunkIndex: chunkRow.chunk_index ?? citation.chunkIndex
      }
    } else if (this.sourceRepo) {
      const sourceRow = this.sourceRepo.getById(citation.sourceId, activeKbId)
      if (!sourceRow) {
        throw new ConversationManagerError(
          `Cited source '${citation.sourceId}' does not exist or does not belong to active Knowledge Base.`,
          'CITATION_SOURCE_UNAVAILABLE'
        )
      }
      return {
        citationNumber: citation.citationNumber,
        sourceId: citation.sourceId,
        chunkId: citation.chunkId,
        knowledgeBaseId: activeKbId,
        fileName: sourceRow.original_file_name,
        fileType: citation.fileType,
        pageNumber: citation.pageNumber,
        headingPath: citation.headingPath,
        chunkIndex: citation.chunkIndex
      }
    } else {
      throw new ConversationManagerError(
        'Database connection or KnowledgeSourceRepository is required for citation verification.',
        'INTERNAL_ERROR'
      )
    }
  }
}
