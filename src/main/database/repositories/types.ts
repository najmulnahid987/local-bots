import { z } from 'zod'
import { type CredentialRef, isValidCredentialRef } from '../../security/credential-vault'
export type { CredentialRef }

/**
 * Domain entity representing an isolated Knowledge Base.
 */
export interface KnowledgeBase {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly storage_path: string
  readonly created_at: number
  readonly updated_at: number
  readonly archived_at: number | null
}

/**
 * Caller input for creating a new Knowledge Base.
 * id, storage_path, created_at, updated_at, and archived_at are managed internally.
 */
export interface CreateKnowledgeBaseInput {
  name: string
  description?: string
}

/**
 * Caller input for updating an existing Knowledge Base.
 * Immutable fields (id, storage_path, created_at) cannot be updated.
 */
export interface UpdateKnowledgeBaseInput {
  name?: string
  description?: string
}

/**
 * Query options for listing Knowledge Bases.
 */
export interface KnowledgeBaseListOptions {
  includeArchived?: boolean
}

/**
 * Approved read-only and analytical tools (canonical Phase 8 tools + legacy aliases).
 */
export const APPROVED_TOOL_PERMISSIONS = [
  'search_knowledge_base',
  'read_knowledge_source',
  'list_knowledge_sources',
  'search_workspace_files',
  'read_workspace_file',
  'save_report',
  'read_knowledge_base_document',
  'list_knowledge_base_documents',
  'search_project_files',
  'read_project_file',
  'prepare_report'
] as const

export type ToolPermission = (typeof APPROVED_TOOL_PERMISSIONS)[number]

/**
 * Domain entity representing a persistent, specialized AI Bot.
 */
export interface Bot {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly providerConnectionId: string | null
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly modelId: string
  readonly status: 'active' | 'archived'
  readonly toolPermissions: readonly ToolPermission[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Caller input for creating a new Bot inside a Knowledge Base.
 */
export interface CreateBotInput {
  knowledgeBaseId: string
  name: string
  modelId: string
  description?: string
  systemPrompt?: string
  status?: 'active' | 'archived'
  providerConnectionId?: string | null
  toolPermissions?: readonly ToolPermission[]
}

/**
 * Caller input for updating an existing Bot.
 * Immutable fields (id, knowledgeBaseId, createdAt) cannot be updated.
 */
export interface UpdateBotInput {
  name?: string
  description?: string
  systemPrompt?: string
  modelId?: string
  status?: 'active' | 'archived'
  providerConnectionId?: string | null
  toolPermissions?: readonly ToolPermission[]
}

/**
 * Query options for listing Bots in a Knowledge Base.
 */
export interface ListBotsOptions {
  status?: 'active' | 'archived'
}

/**
 * Custom error hierarchy for repository operations.
 */
export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'REPOSITORY_ERROR'
  ) {
    super(message)
    this.name = 'RepositoryError'
  }
}

export class ValidationError extends RepositoryError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

// Zod schemas for input validation
export const idSchema = z.string().uuid({ message: 'Invalid ID: must be a valid UUIDv4 string.' })

export const createKnowledgeBaseSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: 'Knowledge base name cannot be blank.' })
      .max(255, { message: 'Knowledge base name cannot exceed 255 characters.' }),
    description: z
      .string()
      .max(2000, { message: 'Description cannot exceed 2000 characters.' })
      .optional()
      .default('')
  })
  .strict()

export const updateKnowledgeBaseSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: 'Knowledge base name cannot be blank.' })
      .max(255, { message: 'Knowledge base name cannot exceed 255 characters.' })
      .optional(),
    description: z
      .string()
      .max(2000, { message: 'Description cannot exceed 2000 characters.' })
      .optional()
  })
  .strict()
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one field (name or description) must be provided for update.'
  })

export const toolPermissionsSchema = z
  .array(z.enum(APPROVED_TOOL_PERMISSIONS, { message: 'Invalid tool permission identifier.' }))
  .refine((items) => new Set(items).size === items.length, {
    message: 'Duplicate tool permissions are not allowed.'
  })

export const createBotSchema = z
  .object({
    knowledgeBaseId: z.string().uuid({ message: 'knowledgeBaseId must be a valid UUIDv4 string.' }),
    name: z
      .string()
      .trim()
      .min(1, { message: 'Bot name cannot be blank.' })
      .max(100, { message: 'Bot name cannot exceed 100 characters.' }),
    modelId: z
      .string()
      .trim()
      .min(1, { message: 'Model ID cannot be blank.' })
      .max(100, { message: 'Model ID cannot exceed 100 characters.' }),
    description: z
      .string()
      .max(2000, { message: 'Description cannot exceed 2000 characters.' })
      .optional()
      .default(''),
    systemPrompt: z
      .string()
      .max(10000, { message: 'System prompt cannot exceed 10000 characters.' })
      .optional()
      .default(''),
    status: z.enum(['active', 'archived']).optional().default('active'),
    providerConnectionId: z
      .string()
      .uuid({ message: 'providerConnectionId must be a valid UUIDv4 string.' })
      .nullable()
      .optional()
      .default(null),
    toolPermissions: toolPermissionsSchema.optional().default([])
  })
  .strict()

export const updateBotSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: 'Bot name cannot be blank.' })
      .max(100, { message: 'Bot name cannot exceed 100 characters.' })
      .optional(),
    description: z
      .string()
      .max(2000, { message: 'Description cannot exceed 2000 characters.' })
      .optional(),
    systemPrompt: z
      .string()
      .max(10000, { message: 'System prompt cannot exceed 10000 characters.' })
      .optional(),
    modelId: z
      .string()
      .trim()
      .min(1, { message: 'Model ID cannot be blank.' })
      .max(100, { message: 'Model ID cannot exceed 100 characters.' })
      .optional(),
    status: z.enum(['active', 'archived']).optional(),
    providerConnectionId: z
      .string()
      .uuid({ message: 'providerConnectionId must be a valid UUIDv4 string.' })
      .nullable()
      .optional(),
    toolPermissions: toolPermissionsSchema.optional()
  })
  .strict()
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.systemPrompt !== undefined ||
      data.modelId !== undefined ||
      data.status !== undefined ||
      data.providerConnectionId !== undefined ||
      data.toolPermissions !== undefined,
    { message: 'At least one editable Bot field must be provided for update.' }
  )

/**
 * Supported first-wave provider IDs centralized from domain provider registry.
 */
import { SUPPORTED_PROVIDER_IDS, type ProviderId } from '../../providers'
export { SUPPORTED_PROVIDER_IDS, type ProviderId }

/**
 * All provider IDs permitted by SQLite schema CHECK constraint.
 */
export const ALL_DATABASE_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'openrouter'
] as const
export type DatabaseProviderId = (typeof ALL_DATABASE_PROVIDER_IDS)[number]

/**
 * Valid connection statuses for provider_connections.
 */
export const PROVIDER_CONNECTION_STATUSES = ['active', 'revoked', 'error'] as const
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number]

/**
 * Domain entity representing an AI model provider connection.
 * SQLite stores metadata and opaque credential references only; never raw API keys or ciphertexts.
 */
export interface ProviderConnection {
  readonly id: string
  readonly providerId: DatabaseProviderId
  readonly label: string
  readonly credentialRef: CredentialRef
  readonly status: ProviderConnectionStatus
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Input for creating a new provider connection record.
 */
export interface CreateProviderConnectionInput {
  readonly providerId: ProviderId
  readonly label: string
  readonly credentialRef: CredentialRef
  readonly status?: ProviderConnectionStatus
}

/**
 * Zod schemas for ProviderConnection operations.
 */
export const createProviderConnectionSchema = z
  .object({
    providerId: z.enum(SUPPORTED_PROVIDER_IDS, {
      message: `Invalid provider ID. Supported first-wave providers: ${SUPPORTED_PROVIDER_IDS.join(', ')}`
    }),
    label: z
      .string()
      .trim()
      .min(1, { message: 'Provider connection label cannot be blank.' })
      .max(255, { message: 'Provider connection label cannot exceed 255 characters.' }),
    credentialRef: z.string().refine(isValidCredentialRef, {
      message: 'Invalid credential reference: must match opaque format cred_<uuidv4>.'
    }),
    status: z.enum(PROVIDER_CONNECTION_STATUSES).optional().default('active')
  })
  .strict()

export const updateProviderConnectionLabelSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, { message: 'Provider connection label cannot be blank.' })
      .max(255, { message: 'Provider connection label cannot exceed 255 characters.' })
  })
  .strict()

export const updateProviderCredentialRefSchema = z
  .object({
    credentialRef: z.string().refine(isValidCredentialRef, {
      message: 'Invalid credential reference: must match opaque format cred_<uuidv4>.'
    })
  })
  .strict()

export const updateProviderConnectionStatusSchema = z
  .object({
    status: z.enum(PROVIDER_CONNECTION_STATUSES, {
      message: `Invalid provider status. Allowed values: ${PROVIDER_CONNECTION_STATUSES.join(', ')}`
    })
  })
  .strict()

/**
 * Canonical indexing statuses for knowledge_sources enforced by SQLite CHECK constraint in Migration 003.
 */
export const KNOWLEDGE_SOURCE_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'needs_reindex'
] as const

export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number]

/**
 * Domain entity representing a document source record in knowledge_sources.
 */
export interface KnowledgeSource {
  readonly id: string
  readonly knowledge_base_id: string
  readonly file_name: string
  readonly original_file_name: string
  readonly relative_file_path: string
  readonly file_type: 'txt' | 'md' | 'pdf'
  readonly mime_type: string
  readonly file_size: number
  readonly content_hash: string
  readonly indexing_status: KnowledgeSourceStatus
  readonly error_message: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly indexed_at: number | null
}

/**
 * Knowledge source domain entity augmented with aggregated chunk count.
 */
export interface KnowledgeSourceWithChunkCount extends KnowledgeSource {
  readonly chunk_count: number
}

/**
 * Raw relational record returned by KnowledgeSourceRepository.searchChunks.
 */
export interface SearchChunkMatchRow {
  readonly chunk_id: string
  readonly source_id: string
  readonly knowledge_base_id: string
  readonly original_file_name: string
  readonly file_type: 'txt' | 'md' | 'pdf'
  readonly chunk_index: number
  readonly content: string
  readonly page_number: number | null
  readonly metadata_json: string
  readonly rank_score: number
  readonly match_snippet: string
}

/**
 * Input for creating a new knowledge_sources row.
 */
export interface CreateKnowledgeSourceInput {
  readonly id: string
  readonly knowledge_base_id: string
  readonly file_name: string
  readonly original_file_name: string
  readonly relative_file_path: string
  readonly file_type: 'txt' | 'md' | 'pdf'
  readonly mime_type: string
  readonly file_size: number
  readonly content_hash: string
  readonly indexing_status?: KnowledgeSourceStatus
  readonly error_message?: string | null
  readonly created_at?: number
  readonly updated_at?: number
  readonly indexed_at?: number | null
}

/**
 * Domain entity representing an indexed text chunk in knowledge_chunks.
 */
export interface KnowledgeChunk {
  readonly id: string
  readonly knowledge_base_id: string
  readonly source_id: string
  readonly chunk_index: number
  readonly content: string
  readonly page_number: number | null
  readonly token_count: number
  readonly metadata_json: string
  readonly created_at: number
}

/**
 * Input for inserting a knowledge chunk into knowledge_chunks.
 */
export interface CreateKnowledgeChunkInput {
  readonly id: string
  readonly knowledge_base_id: string
  readonly source_id: string
  readonly chunk_index: number
  readonly content: string
  readonly page_number: number | null
  readonly token_count: number
  readonly metadata_json: string
  readonly created_at?: number
}

export const createKnowledgeSourceSchema = z
  .object({
    id: z.string().uuid({ message: 'Source id must be a valid RFC 4122 UUIDv4.' }),
    knowledge_base_id: z
      .string()
      .uuid({ message: 'knowledge_base_id must be a valid RFC 4122 UUIDv4.' }),
    file_name: z.string().trim().min(1, { message: 'file_name cannot be blank.' }),
    original_file_name: z
      .string()
      .trim()
      .min(1, { message: 'original_file_name cannot be blank.' }),
    relative_file_path: z
      .string()
      .trim()
      .min(1, { message: 'relative_file_path cannot be blank.' }),
    file_type: z.enum(['txt', 'md', 'pdf'], {
      message: "file_type must be 'txt', 'md', or 'pdf'."
    }),
    mime_type: z.string().trim().min(1, { message: 'mime_type cannot be blank.' }),
    file_size: z
      .number()
      .int()
      .nonnegative({ message: 'file_size must be a non-negative integer.' }),
    content_hash: z
      .string()
      .length(64, { message: 'content_hash must be a 64-character SHA-256 hex string.' }),
    indexing_status: z.enum(KNOWLEDGE_SOURCE_STATUSES).optional().default('queued'),
    error_message: z.string().nullable().optional().default(null),
    created_at: z.number().int().positive().optional(),
    updated_at: z.number().int().positive().optional(),
    indexed_at: z.number().int().positive().nullable().optional().default(null)
  })
  .strict()

export const createKnowledgeChunkSchema = z
  .object({
    id: z.string().uuid({ message: 'Chunk id must be a valid RFC 4122 UUIDv4.' }),
    knowledge_base_id: z
      .string()
      .uuid({ message: 'knowledge_base_id must be a valid RFC 4122 UUIDv4.' }),
    source_id: z.string().uuid({ message: 'source_id must be a valid RFC 4122 UUIDv4.' }),
    chunk_index: z
      .number()
      .int()
      .nonnegative({ message: 'chunk_index must be a non-negative integer.' }),
    content: z.string().trim().min(1, { message: 'content cannot be blank.' }),
    page_number: z.number().int().positive().nullable().optional().default(null),
    token_count: z
      .number()
      .int()
      .nonnegative({ message: 'token_count must be a non-negative integer.' }),
    metadata_json: z.string().refine(
      (val) => {
        try {
          JSON.parse(val)
          return true
        } catch {
          return false
        }
      },
      { message: 'metadata_json must be valid JSON string.' }
    ),
    created_at: z.number().int().positive().optional()
  })
  .strict()

/**
 * Re-exports and repository contracts for Phase 7 conversations and messages.
 */
import type {
  ConversationDto,
  MessageDto,
  CitationDto,
  MessageRole,
  MessageContentFormat,
  MessageMetadataDto,
  MessageTokenUsageDto
} from '../../../shared/conversations'

export type {
  ConversationDto,
  MessageDto,
  CitationDto,
  MessageRole,
  MessageContentFormat,
  MessageMetadataDto,
  MessageTokenUsageDto
}

export type Conversation = ConversationDto
export type Message = MessageDto

export interface CreateConversationRepositoryInput {
  botId: string
  knowledgeBaseId: string
  title?: string
}

export interface ListConversationsRepositoryOptions {
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface CreateMessageRepositoryInput {
  conversationId: string
  botId: string
  knowledgeBaseId: string
  role: MessageRole
  content: string
  contentFormat?: MessageContentFormat
  metadata?: MessageMetadataDto
  tokenUsage?: MessageTokenUsageDto | null
}

export interface ListMessagesRepositoryOptions {
  limit?: number
  offset?: number
}

/**
 * Re-exports and repository contracts for Phase 8 agent execution and tool events.
 */
import type {
  AgentRunStatus,
  DbAgentRunStatus,
  AgentRunDto,
  CanonicalBotTool,
  ToolEventStatus,
  ToolApprovalStatus,
  ToolEventDto
} from '../../../shared/agents'

export type {
  AgentRunStatus,
  DbAgentRunStatus,
  AgentRunDto,
  CanonicalBotTool,
  ToolEventStatus,
  ToolApprovalStatus,
  ToolEventDto
}

export type AgentRun = AgentRunDto
export type ToolEvent = ToolEventDto

export interface CreateAgentRunRepositoryInput {
  readonly id?: string
  readonly botId: string
  readonly conversationId?: string | null
  readonly selectedModel: string
  readonly initialStatus?: AgentRunStatus
}

export interface ListAgentRunsRepositoryOptions {
  readonly limit?: number
  readonly offset?: number
}

export interface CreateToolEventRepositoryInput {
  readonly agentRunId: string
  readonly toolName: string
  readonly sequenceNumber?: number
  readonly argumentsSummary?: string
  readonly initialStatus?: ToolEventStatus
  readonly initialApprovalStatus?: ToolApprovalStatus
}

export interface UpdateToolEventSummariesInput {
  readonly argumentsSummary?: string
  readonly resultSummary?: string
}

/**
 * Repository contracts and domain types for Bot Memories.
 */
export interface BotMemory {
  readonly id: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly memoryType: 'user_note' | 'pinned_instruction'
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateBotMemoryRepositoryInput {
  readonly id?: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly memoryType?: 'user_note' | 'pinned_instruction'
  readonly content: string
}

export interface UpdateBotMemoryRepositoryInput {
  readonly memoryType?: 'user_note' | 'pinned_instruction'
  readonly content?: string
}

export interface ListBotMemoriesRepositoryOptions {
  readonly memoryType?: 'user_note' | 'pinned_instruction'
}
