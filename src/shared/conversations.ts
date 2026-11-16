import { z } from 'zod'
import { botIdSchema, APPROVED_BOT_TOOLS, type ApprovedBotTool } from './bots'
import { SUPPORTED_PROVIDERS, type ProviderId } from './providers'

// ============================================================================
// Core Constants
// ============================================================================

/**
 * Shared IPC channel definitions for conversations and messages.
 */
export const CONVERSATION_IPC_CHANNELS = {
  CREATE: 'conversation:create',
  LIST: 'conversation:list',
  GET_MESSAGES: 'conversation:get-messages',
  RENAME: 'conversation:rename',
  DELETE: 'conversation:delete',
  SEND_MESSAGE: 'conversation:send-message',
  RETRY_LAST_USER_MESSAGE: 'conversation:retry-last-user-message',
  CANCEL_GENERATION: 'conversation:cancel-generation',
  STREAM_PORT: 'conversation:stream-port',
  RESOLVE_CITATION: 'conversation:resolve-citation'
} as const

export type ConversationIpcChannel =
  (typeof CONVERSATION_IPC_CHANNELS)[keyof typeof CONVERSATION_IPC_CHANNELS]

/**
 * Maximum allowed character length for a conversation title.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 200

/**
 * Default title assigned to newly created conversations when not specified.
 */
export const DEFAULT_CONVERSATION_TITLE = 'New Conversation'

/**
 * Maximum allowed character length for a single message content payload.
 */
export const MAX_MESSAGE_CONTENT_LENGTH = 50000

/**
 * Supported message roles strictly matching the SQLite database CHECK constraint:
 * CHECK (role IN ('user', 'assistant', 'system', 'tool'))
 */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * Supported message content formats strictly matching the SQLite database CHECK constraint:
 * CHECK (content_format IN ('text', 'markdown', 'json'))
 */
export const MESSAGE_CONTENT_FORMATS = ['text', 'markdown', 'json'] as const
export type MessageContentFormat = (typeof MESSAGE_CONTENT_FORMATS)[number]

/**
 * Supported document formats for cited knowledge sources.
 */
export const CITATION_FILE_TYPES = ['txt', 'md', 'pdf'] as const
export type CitationFileType = (typeof CITATION_FILE_TYPES)[number]

/**
 * Valid execution statuses for structured tool calls, matching tool_events status:
 * CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
 */
export const TOOL_CALL_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
] as const
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number]

// ============================================================================
// Conversation DTOs and Interfaces
// ============================================================================

/**
 * Public, renderer-safe Data Transfer Object representing a conversation thread.
 * Scoped strictly to its parent Bot and Knowledge Base.
 */
export interface ConversationDto {
  readonly id: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

/**
 * Caller input for creating a new conversation.
 * Note: knowledgeBaseId is deliberately omitted because the authoritative
 * Knowledge Base context is established by the Main process session.
 * The botId must belong to the active Knowledge Base.
 */
export interface CreateConversationRequest {
  readonly botId: string
  readonly title?: string
}

/**
 * Caller input for renaming an existing conversation.
 * Prohibits mutating immutable identity or ownership fields.
 */
export interface RenameConversationRequest {
  readonly title: string
}

/**
 * Query filter options for listing conversations.
 */
export interface ListConversationsRequest {
  readonly botId?: string
  readonly includeArchived?: boolean
}

/**
 * Structured result of a conversation deletion operation.
 */
export interface DeleteConversationResultDto {
  readonly success: boolean
  readonly conversationId: string
}

// ============================================================================
// Citation and Token Usage DTOs
// ============================================================================

/**
 * Structured citation representing an authoritative reference to a retrieved chunk.
 * Excludes absolute filesystem paths, internal storage keys, or raw provider headers.
 */
export interface CitationDto {
  readonly citationNumber: number
  readonly sourceId: string
  readonly chunkId: string
  readonly fileName: string
  readonly fileType: CitationFileType
  readonly pageNumber: number | null
  readonly headingPath: readonly string[] | null
  readonly chunkIndex: number
}

/**
 * Token usage accounting for a message.
 * Follows the existing ProviderTokenUsage structure.
 */
export interface MessageTokenUsageDto {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/**
 * Structured reference to a tool call executed or pending for a message.
 * Strictly constrained to approved Bot tools.
 */
export interface MessageToolCallDto {
  readonly id: string
  readonly toolName: ApprovedBotTool
  readonly status: ToolCallStatus
  readonly argumentsSummary?: string
  readonly resultSummary?: string
  readonly errorMessage?: string | null
}

/**
 * Execution and performance metadata for assistant responses.
 */
export interface GenerationMetadataDto {
  readonly finishReason?: string
  readonly durationMs?: number
  readonly firstTokenMs?: number
  readonly temperature?: number
}

/**
 * Typed, serializable metadata stored in messages.metadata_json.
 */
export interface MessageMetadataDto {
  readonly providerId?: ProviderId
  readonly modelId?: string
  readonly citations?: readonly CitationDto[]
  readonly toolCalls?: readonly MessageToolCallDto[]
  readonly generation?: GenerationMetadataDto
  readonly agentRunId?: string
}

/**
 * Public, renderer-safe Data Transfer Object representing a chat message.
 */
export interface MessageDto {
  readonly id: string
  readonly conversationId: string
  readonly role: MessageRole
  readonly content: string
  readonly contentFormat: MessageContentFormat
  readonly metadata: MessageMetadataDto
  readonly tokenUsage?: MessageTokenUsageDto | null
  readonly createdAt: number
}

/**
 * Caller input for sending a user message into a conversation.
 */
export interface SendMessageRequest {
  readonly conversationId: string
  readonly content: string
  readonly contentFormat?: MessageContentFormat
}

/**
 * Caller input for listing messages of a conversation.
 */
export interface ListMessagesRequest {
  readonly conversationId: string
  readonly limit?: number
  readonly offset?: number
}

/**
 * Caller input for renaming an existing conversation via IPC.
 */
export interface RenameConversationIpcRequest {
  readonly conversationId: string
  readonly title: string
}

/**
 * Caller input for deleting an existing conversation via IPC.
 */
export interface DeleteConversationIpcRequest {
  readonly conversationId: string
}

/**
 * Complete IPC payload for starting a new streaming conversation turn.
 */
export interface SendMessageIpcRequest {
  readonly requestId: string
  readonly conversationId: string
  readonly content: string
  readonly contentFormat?: MessageContentFormat
}

/**
 * Complete IPC payload for retrying the latest unanswered user message.
 */
export interface RetryTurnIpcRequest {
  readonly requestId: string
  readonly conversationId: string
  readonly messageId?: string
}

/**
 * Complete IPC payload for cancelling an active generation turn.
 */
export interface CancelGenerationIpcRequest {
  readonly requestId: string
}

/**
 * Caller input for resolving an authoritative citation target in a conversation message.
 * Strict authority: client provides ONLY conversationId, messageId, and citationNumber.
 * Knowledge Base ID, source ID, chunk ID, and file paths are never accepted from the caller.
 */
export interface ResolveCitationRequest {
  readonly conversationId: string
  readonly messageId: string
  readonly citationNumber: number
}

/**
 * Public, renderer-safe Data Transfer Object representing a verified, resolved citation preview target.
 * Excludes filesystem paths, internal storage keys, or provider secrets.
 */
export interface ResolvedCitationTargetDto {
  readonly citationNumber: number
  readonly sourceId: string
  readonly chunkId: string
  readonly knowledgeBaseId: string
  readonly fileName: string
  readonly fileType: CitationFileType
  readonly pageNumber: number | null
  readonly headingPath: readonly string[] | null
  readonly chunkIndex: number
}

// ============================================================================
// Public Streaming Event and Turn Result Contracts
// ============================================================================

export interface PublicTextDeltaEvent {
  readonly type: 'text_delta'
  readonly textDelta: string
}

export interface PublicFinishEvent {
  readonly type: 'finish'
  readonly finishReason: string
  readonly usage?: MessageTokenUsageDto | null
  readonly totalTextLength: number
  readonly durationMs: number
  readonly message: MessageDto
  readonly userMessage?: MessageDto
}

export interface PublicErrorEvent {
  readonly type: 'error'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}

export type PublicConversationTurnEvent =
  PublicTextDeltaEvent | PublicFinishEvent | PublicErrorEvent

export interface ConversationTurnResultDto {
  readonly userMessage?: MessageDto
  readonly assistantMessage: MessageDto
  readonly finishReason: string
  readonly durationMs: number
  readonly usage?: MessageTokenUsageDto | null
}

/**
 * Renderer-facing typed conversation API exposed via Preload bridge.
 */
export interface ConversationApi {
  createConversation(request: CreateConversationRequest): Promise<ConversationDto>
  listConversations(request: ListConversationsRequest): Promise<readonly ConversationDto[]>
  listMessages(request: ListMessagesRequest | string): Promise<readonly MessageDto[]>
  renameConversation(request: RenameConversationIpcRequest): Promise<ConversationDto>
  deleteConversation(
    request: DeleteConversationIpcRequest | string
  ): Promise<DeleteConversationResultDto>
  sendMessage(
    request: SendMessageRequest & { requestId?: string },
    onEvent?: (event: PublicConversationTurnEvent) => void
  ): Promise<ConversationTurnResultDto>
  retryLastUserMessage(
    request: { conversationId: string; messageId?: string; requestId?: string },
    onEvent?: (event: PublicConversationTurnEvent) => void
  ): Promise<ConversationTurnResultDto>
  cancelGeneration(request: CancelGenerationIpcRequest | string): Promise<void>
  resolveCitation(request: ResolveCitationRequest): Promise<ResolvedCitationTargetDto>
}

// ============================================================================
// Custom Bridge Error Hierarchy
// ============================================================================

export class ConversationBridgeError extends Error {
  public readonly code: string
  public readonly retryable: boolean

  constructor(message: string, code = 'CONVERSATION_BRIDGE_ERROR', retryable = false) {
    super(message)
    this.name = 'ConversationBridgeError'
    this.code = code
    this.retryable = retryable
    Object.setPrototypeOf(this, ConversationBridgeError.prototype)
  }
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

/**
 * Validates a canonical RFC 4122 UUIDv4 conversation ID.
 */
export const conversationIdSchema = z
  .string()
  .uuid({ message: 'Invalid Conversation ID: must be a valid RFC 4122 UUIDv4.' })

/**
 * Validates a canonical RFC 4122 UUIDv4 message ID.
 */
export const messageIdSchema = z
  .string()
  .uuid({ message: 'Invalid Message ID: must be a valid RFC 4122 UUIDv4.' })

/**
 * Validates a conversation title:
 * - Trims whitespace.
 * - Non-empty (at least 1 character).
 * - Maximum character limit enforced.
 */
export const conversationTitleSchema = z
  .string()
  .trim()
  .min(1, { message: 'Conversation title cannot be blank.' })
  .max(CONVERSATION_TITLE_MAX_LENGTH, {
    message: `Conversation title cannot exceed ${CONVERSATION_TITLE_MAX_LENGTH} characters.`
  })

/**
 * Validates conversation creation requests.
 * Enforces strict object structure, rejecting unknown properties and knowledgeBaseId injection.
 */
export const createConversationRequestSchema = z
  .object({
    botId: botIdSchema,
    title: conversationTitleSchema.optional().default(DEFAULT_CONVERSATION_TITLE)
  })
  .strict()

/**
 * Validates conversation renaming requests.
 * Prohibits mutating bot ownership or other properties.
 */
export const renameConversationRequestSchema = z
  .object({
    title: conversationTitleSchema
  })
  .strict()

/**
 * Validates conversation listing options.
 */
export const listConversationsRequestSchema = z
  .object({
    botId: botIdSchema.optional(),
    includeArchived: z.boolean().optional().default(false)
  })
  .strict()
  .optional()

/**
 * Validates delete conversation result DTO.
 */
export const deleteConversationResultSchema = z
  .object({
    success: z.boolean(),
    conversationId: conversationIdSchema
  })
  .strict()

/**
 * Validates message roles.
 */
export const messageRoleSchema = z.enum(MESSAGE_ROLES, {
  message: `Invalid message role. Supported roles: ${MESSAGE_ROLES.join(', ')}.`
})

/**
 * Validates message content formats.
 */
export const messageContentFormatSchema = z.enum(MESSAGE_CONTENT_FORMATS, {
  message: `Invalid content format. Supported formats: ${MESSAGE_CONTENT_FORMATS.join(', ')}.`
})

/**
 * Validates token usage metrics: non-negative integers only.
 */
export const messageTokenUsageSchema = z
  .object({
    promptTokens: z
      .number()
      .int({ message: 'promptTokens must be an integer.' })
      .nonnegative({ message: 'promptTokens must be non-negative.' }),
    completionTokens: z
      .number()
      .int({ message: 'completionTokens must be an integer.' })
      .nonnegative({ message: 'completionTokens must be non-negative.' }),
    totalTokens: z
      .number()
      .int({ message: 'totalTokens must be an integer.' })
      .nonnegative({ message: 'totalTokens must be non-negative.' })
  })
  .strict()

/**
 * Validates a CitationDto structure:
 * - citationNumber: positive integer (>= 1).
 * - sourceId, chunkId: valid UUIDv4 strings.
 * - fileName: trimmed, 1-255 characters, no path separators.
 * - fileType: 'txt' | 'md' | 'pdf'.
 * - pageNumber: nullable positive integer (>= 1).
 * - headingPath: nullable array of non-empty heading strings (max 20 levels).
 * - chunkIndex: non-negative integer (>= 0).
 * - Rejects unknown properties (e.g. storage paths, URLs, raw secrets).
 */
export const citationDtoSchema = z
  .object({
    citationNumber: z
      .number()
      .int({ message: 'citationNumber must be an integer.' })
      .positive({ message: 'citationNumber must be a positive 1-based integer.' }),
    sourceId: z.string().uuid({ message: 'sourceId must be a valid RFC 4122 UUIDv4.' }),
    chunkId: z.string().uuid({ message: 'chunkId must be a valid RFC 4122 UUIDv4.' }),
    fileName: z
      .string()
      .trim()
      .min(1, { message: 'fileName cannot be blank.' })
      .max(255, { message: 'fileName cannot exceed 255 characters.' })
      .refine((name) => !name.includes('/') && !name.includes('\\'), {
        message: 'fileName must be a simple filename without path separators.'
      }),
    fileType: z.enum(CITATION_FILE_TYPES, {
      message: "fileType must be 'txt', 'md', or 'pdf'."
    }),
    pageNumber: z
      .number()
      .int({ message: 'pageNumber must be an integer.' })
      .positive({ message: 'pageNumber must be a positive 1-based integer.' })
      .nullable(),
    headingPath: z
      .array(
        z
          .string()
          .trim()
          .min(1, { message: 'Heading cannot be empty.' })
          .max(200, { message: 'Heading cannot exceed 200 characters.' })
      )
      .max(20, { message: 'headingPath cannot exceed 20 levels.' })
      .nullable(),
    chunkIndex: z
      .number()
      .int({ message: 'chunkIndex must be an integer.' })
      .nonnegative({ message: 'chunkIndex must be a non-negative integer.' })
  })
  .strict()

/**
 * Validates structured tool-call metadata.
 */
export const messageToolCallSchema = z
  .object({
    id: z.string().trim().min(1, { message: 'Tool call ID cannot be blank.' }),
    toolName: z.enum(APPROVED_BOT_TOOLS, { message: 'Invalid tool identifier.' }),
    status: z.enum(TOOL_CALL_STATUSES, { message: 'Invalid tool call status.' }),
    argumentsSummary: z.string().max(2000).optional(),
    resultSummary: z.string().max(4000).optional(),
    errorMessage: z.string().max(2000).nullable().optional()
  })
  .strict()

/**
 * Validates assistant generation metadata.
 */
export const generationMetadataSchema = z
  .object({
    finishReason: z.string().max(50).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    firstTokenMs: z.number().int().nonnegative().optional(),
    temperature: z.number().min(0).max(2).optional()
  })
  .strict()

/**
 * Validates message metadata structure.
 */
export const messageMetadataSchema = z
  .object({
    providerId: z.enum(SUPPORTED_PROVIDERS).optional(),
    modelId: z.string().trim().min(1).max(100).optional(),
    citations: z.array(citationDtoSchema).optional(),
    toolCalls: z.array(messageToolCallSchema).optional(),
    generation: generationMetadataSchema.optional(),
    agentRunId: z.string().uuid().optional()
  })
  .strict()

/**
 * Validates send message requests.
 */
export const sendMessageRequestSchema = z
  .object({
    conversationId: conversationIdSchema,
    content: z
      .string()
      .trim()
      .min(1, { message: 'Message content cannot be blank.' })
      .max(MAX_MESSAGE_CONTENT_LENGTH, {
        message: `Message content cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`
      }),
    contentFormat: messageContentFormatSchema.optional().default('markdown')
  })
  .strict()

/**
 * Validates list messages requests with optional pagination.
 */
export const listMessagesRequestSchema = z
  .object({
    conversationId: conversationIdSchema,
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional()
  })
  .strict()

/**
 * Validates rename conversation IPC requests.
 */
export const renameConversationIpcRequestSchema = z
  .object({
    conversationId: conversationIdSchema,
    title: conversationTitleSchema
  })
  .strict()

/**
 * Validates delete conversation IPC requests.
 */
export const deleteConversationIpcRequestSchema = z
  .object({
    conversationId: conversationIdSchema
  })
  .strict()

/**
 * Validates send message streaming IPC requests.
 */
export const sendMessageIpcRequestSchema = z
  .object({
    requestId: z.string().uuid({ message: 'requestId must be a valid UUIDv4 string.' }),
    conversationId: conversationIdSchema,
    content: z
      .string()
      .trim()
      .min(1, { message: 'Message content cannot be blank.' })
      .max(MAX_MESSAGE_CONTENT_LENGTH, {
        message: `Message content cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`
      }),
    contentFormat: messageContentFormatSchema.optional().default('markdown')
  })
  .strict()

/**
 * Validates retry streaming IPC requests.
 */
export const retryTurnIpcRequestSchema = z
  .object({
    requestId: z.string().uuid({ message: 'requestId must be a valid UUIDv4 string.' }),
    conversationId: conversationIdSchema,
    messageId: messageIdSchema.optional()
  })
  .strict()

/**
 * Validates cancel generation IPC requests.
 */
export const cancelGenerationIpcRequestSchema = z
  .object({
    requestId: z.string().uuid({ message: 'requestId must be a valid UUIDv4 string.' })
  })
  .strict()

/**
 * Validates a complete ConversationDto.
 */
export const conversationDtoSchema = z
  .object({
    id: conversationIdSchema,
    botId: botIdSchema,
    knowledgeBaseId: z
      .string()
      .uuid({ message: 'Invalid Knowledge Base ID: must be a valid RFC 4122 UUIDv4.' }),
    title: conversationTitleSchema,
    createdAt: z.number().int().positive({ message: 'createdAt must be a positive integer.' }),
    updatedAt: z.number().int().positive({ message: 'updatedAt must be a positive integer.' }),
    archivedAt: z
      .number()
      .int()
      .positive({ message: 'archivedAt must be a positive integer.' })
      .nullable()
  })
  .strict()

/**
 * Validates a complete MessageDto.
 */
export const messageDtoSchema = z
  .object({
    id: messageIdSchema,
    conversationId: conversationIdSchema,
    role: messageRoleSchema,
    content: z.string(),
    contentFormat: messageContentFormatSchema,
    metadata: messageMetadataSchema,
    tokenUsage: messageTokenUsageSchema.nullable().optional(),
    createdAt: z.number().int().positive({ message: 'createdAt must be a positive integer.' })
  })
  .strict()

// ============================================================================
// Safe Serialization and Parsing Utilities
// ============================================================================

/**
 * Safely serializes message metadata into a valid JSON string.
 * Validates against messageMetadataSchema before serializing.
 * Always returns a valid JSON string ('{}' on empty or invalid input).
 */
export function serializeMessageMetadata(metadata?: MessageMetadataDto | null): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return '{}'
  }
  const parsed = messageMetadataSchema.safeParse(metadata)
  if (!parsed.success) {
    return '{}'
  }
  return JSON.stringify(parsed.data)
}

/**
 * Safely deserializes raw JSON or unknown input into a MessageMetadataDto.
 * Invariants:
 * 1. Never throws JSON parsing errors or leaks internal paths to Renderer.
 * 2. Returns a safe fallback `{}` if JSON is malformed, invalid, or violates schema.
 * 3. Does not fabricate missing citations or source references.
 */
export function deserializeMessageMetadata(raw: unknown): MessageMetadataDto {
  if (!raw) {
    return {}
  }

  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed === '{}') {
      return {}
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }

  const result = messageMetadataSchema.safeParse(parsed)
  if (!result.success) {
    return {}
  }

  return result.data
}

/**
 * Safely serializes message token usage into a valid JSON string.
 */
export function serializeMessageTokenUsage(usage?: MessageTokenUsageDto | null): string {
  if (!usage) {
    return '{}'
  }
  const parsed = messageTokenUsageSchema.safeParse(usage)
  if (!parsed.success) {
    return '{}'
  }
  return JSON.stringify(parsed.data)
}

/**
 * Safely deserializes token usage JSON or object into a MessageTokenUsageDto or null.
 * Never throws exceptions.
 */
export function deserializeMessageTokenUsage(raw: unknown): MessageTokenUsageDto | null {
  if (!raw) {
    return null
  }

  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed === '{}') {
      return null
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
  }

  const result = messageTokenUsageSchema.safeParse(parsed)
  return result.success ? result.data : null
}

// ============================================================================
// DTO Conversion Utilities
// ============================================================================

export interface ConversationEntityLike {
  id: string
  bot_id?: string
  botId?: string
  knowledge_base_id?: string
  knowledgeBaseId?: string
  title: string
  created_at?: number
  createdAt?: number
  updated_at?: number
  updatedAt?: number
  archived_at?: number | null
  archivedAt?: number | null
}

/**
 * Maps a domain entity or database row to a validated, renderer-safe ConversationDto.
 */
export function toConversationDto(source: ConversationEntityLike): ConversationDto {
  const botId = source.botId ?? source.bot_id
  if (!botId) {
    throw new Error('Bot ID is required to construct ConversationDto.')
  }
  const knowledgeBaseId = source.knowledgeBaseId ?? source.knowledge_base_id
  if (!knowledgeBaseId) {
    throw new Error('Knowledge Base ID is required to construct ConversationDto.')
  }
  const createdAt = source.createdAt ?? source.created_at
  if (createdAt === undefined || createdAt === null) {
    throw new Error('createdAt timestamp is required to construct ConversationDto.')
  }
  const updatedAt = source.updatedAt ?? source.updated_at ?? createdAt
  const archivedAt =
    source.archivedAt !== undefined ? source.archivedAt : (source.archived_at ?? null)

  const dto: ConversationDto = {
    id: source.id,
    botId,
    knowledgeBaseId,
    title: source.title,
    createdAt,
    updatedAt,
    archivedAt
  }

  return conversationDtoSchema.parse(dto)
}

export interface MessageEntityLike {
  id: string
  conversation_id?: string
  conversationId?: string
  role: string
  content: string
  content_format?: string
  contentFormat?: string
  metadata_json?: string
  metadata?: MessageMetadataDto
  token_usage_json?: string
  tokenUsage?: MessageTokenUsageDto | null
  token_usage?: MessageTokenUsageDto | null
  created_at?: number
  createdAt?: number
}

/**
 * Maps a domain entity or database row to a validated, renderer-safe MessageDto.
 */
export function toMessageDto(source: MessageEntityLike): MessageDto {
  const conversationId = source.conversationId ?? source.conversation_id
  if (!conversationId) {
    throw new Error('Conversation ID is required to construct MessageDto.')
  }
  const createdAt = source.createdAt ?? source.created_at
  if (createdAt === undefined || createdAt === null) {
    throw new Error('createdAt timestamp is required to construct MessageDto.')
  }

  const role = messageRoleSchema.parse(source.role)
  const contentFormat = messageContentFormatSchema.parse(
    source.contentFormat ?? source.content_format ?? 'markdown'
  )

  const metadata = source.metadata
    ? deserializeMessageMetadata(source.metadata)
    : deserializeMessageMetadata(source.metadata_json)

  const tokenUsage =
    source.tokenUsage !== undefined
      ? deserializeMessageTokenUsage(source.tokenUsage)
      : source.token_usage !== undefined
        ? deserializeMessageTokenUsage(source.token_usage)
        : deserializeMessageTokenUsage(source.token_usage_json)

  const dto: MessageDto = {
    id: source.id,
    conversationId,
    role,
    content: source.content,
    contentFormat,
    metadata,
    tokenUsage,
    createdAt
  }

  return messageDtoSchema.parse(dto)
}
