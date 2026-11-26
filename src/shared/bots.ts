import { z } from 'zod'
import type { KnowledgeBaseDto } from './knowledge-bases'

/**
 * Shared IPC channel definitions for Bot management and workspace context.
 */
export const BOT_IPC_CHANNELS = {
  LIST: 'bot:list',
  GET: 'bot:get',
  CREATE: 'bot:create',
  UPDATE: 'bot:update',
  ARCHIVE: 'bot:archive',
  UNARCHIVE: 'bot:unarchive',
  DELETE: 'bot:delete',
  GET_DELETION_PREVIEW: 'bot:get-deletion-preview',
  ACTIVATE_WORKSPACE: 'bot:activate-workspace',
  DEACTIVATE_WORKSPACE: 'bot:deactivate-workspace'
} as const

export type BotIpcChannel = (typeof BOT_IPC_CHANNELS)[keyof typeof BOT_IPC_CHANNELS]

/**
 * Approved read-only and analytical tools for Bots.
 * Includes canonical Phase 8 tools and historical legacy aliases for compatibility.
 */
export const APPROVED_BOT_TOOLS = [
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

export type ApprovedBotTool = (typeof APPROVED_BOT_TOOLS)[number]
export type ToolPermission = ApprovedBotTool
export const APPROVED_TOOL_PERMISSIONS = APPROVED_BOT_TOOLS

/**
 * Valid lifecycle statuses for Bots.
 */
export const BOT_STATUSES = ['active', 'archived'] as const
export type BotStatus = (typeof BOT_STATUSES)[number]

/**
 * Configurable per-Bot response policy governing Knowledge Base usage and general AI behavior.
 */
export const BOT_RESPONSE_POLICIES = [
  'strict_kb_only',
  'balanced_kb_first',
  'general_ai_chat'
] as const
export type BotResponsePolicy = (typeof BOT_RESPONSE_POLICIES)[number]

/**
 * Default response policy applied to newly created and migrated Bots.
 */
export const DEFAULT_BOT_RESPONSE_POLICY: BotResponsePolicy = 'balanced_kb_first'

export interface BotResponsePolicyMetadata {
  readonly id: BotResponsePolicy
  readonly label: string
  readonly shortLabel: string
  readonly description: string
  readonly recommended?: boolean
}

export const BOT_RESPONSE_POLICY_METADATA: Readonly<
  Record<BotResponsePolicy, BotResponsePolicyMetadata>
> = {
  strict_kb_only: {
    id: 'strict_kb_only',
    label: 'Strict Knowledge Base Only',
    shortLabel: 'Strict KB Only',
    description:
      'Answers strictly from retrieved documents in this Knowledge Base and refuses unsupported claims.'
  },
  balanced_kb_first: {
    id: 'balanced_kb_first',
    label: 'Knowledge Base First (Balanced)',
    shortLabel: 'KB First (Balanced)',
    description:
      'Prioritizes Knowledge Base documents first and clearly separates helpful general AI knowledge when needed.',
    recommended: true
  },
  general_ai_chat: {
    id: 'general_ai_chat',
    label: 'General AI Chat',
    shortLabel: 'General AI Chat',
    description:
      'Responds freely as a general assistant while still referencing relevant Knowledge Base documents when helpful.'
  }
}

export const botResponsePolicySchema = z.enum(BOT_RESPONSE_POLICIES, {
  message: 'Response policy must be strict_kb_only, balanced_kb_first, or general_ai_chat.'
})

export function isBotResponsePolicy(value: unknown): value is BotResponsePolicy {
  return typeof value === 'string' && (BOT_RESPONSE_POLICIES as readonly string[]).includes(value)
}

export function resolveBotResponsePolicy(value: unknown): BotResponsePolicy {
  return isBotResponsePolicy(value) ? value : DEFAULT_BOT_RESPONSE_POLICY
}

export function getBotResponsePolicyMeta(policy: BotResponsePolicy): BotResponsePolicyMetadata {
  return BOT_RESPONSE_POLICY_METADATA[policy]
}

/**
 * Public, renderer-safe Data Transfer Object representing an AI Bot.
 * Excludes internal database internals, credential references, or vault paths.
 */
export interface BotDto {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly providerConnectionId: string | null
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly modelId: string
  readonly status: BotStatus
  readonly responsePolicy: BotResponsePolicy
  readonly enabledTools: readonly ToolPermission[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Caller input for creating a new Bot.
 * Note: knowledgeBaseId is deliberately omitted because the authoritative
 * Knowledge Base context is established by the Main process.
 */
export interface CreateBotRequest {
  readonly name: string
  readonly modelId: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly responsePolicy?: BotResponsePolicy
  readonly providerConnectionId?: string | null
  readonly enabledTools?: readonly ToolPermission[]
}

/**
 * Caller input for updating mutable Bot configuration.
 * Immutable fields (id, knowledgeBaseId, createdAt, status) cannot be altered here.
 * Status transitions (archive / unarchive) are managed as separate operations.
 */
export interface UpdateBotRequest {
  readonly name?: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly responsePolicy?: BotResponsePolicy
  readonly providerConnectionId?: string | null
  readonly modelId?: string
  readonly enabledTools?: readonly ToolPermission[]
}

/**
 * Query filter options for listing Bots within a Knowledge Base.
 */
export interface ListBotsRequest {
  readonly status?: BotStatus
}

/**
 * Structured result of a Bot deletion operation.
 */
export interface DeleteBotResultDto {
  readonly success: boolean
  readonly botId: string
}

/**
 * Structured result of a Bot archive / unarchive operation.
 */
export interface ArchiveBotResultDto {
  readonly success: boolean
  readonly bot: BotDto
}

/**
 * Typed Preload bridge interface exposed at window.api.bots.
 */
export interface BotApi {
  list(options?: ListBotsRequest): Promise<readonly BotDto[]>
  get(botId: string): Promise<BotDto | null>
  create(request: CreateBotRequest): Promise<BotDto>
  update(botId: string, request: UpdateBotRequest): Promise<BotDto>
  archive(botId: string): Promise<BotDto>
  unarchive(botId: string): Promise<BotDto>
  delete(botId: string): Promise<DeleteBotResultDto>
  getDeletionPreview?(botId: string): Promise<import('./deletion').DeletionPreviewDto>
  activateWorkspace(knowledgeBaseId: string): Promise<KnowledgeBaseDto>
  deactivateWorkspace(): Promise<{ success: boolean }>
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

/**
 * Validates a canonical RFC 4122 UUIDv4 string.
 */
export const botIdSchema = z
  .string()
  .uuid({ message: 'Invalid Bot ID: must be a valid RFC 4122 UUIDv4.' })

/**
 * Validates enabled tool permissions:
 * - Each tool must be in the approved list.
 * - Duplicate tool entries are strictly rejected.
 */
export const enabledToolsSchema = z
  .array(z.enum(APPROVED_BOT_TOOLS, { message: 'Invalid tool identifier.' }))
  .refine((items) => new Set(items).size === items.length, {
    message: 'Duplicate tool identifiers are not allowed.'
  })

/**
 * Validates Bot creation requests.
 * Enforces strict property rules:
 * - Non-empty trimmed name (1-100 characters).
 * - Non-empty trimmed model ID (1-100 characters).
 * - Max description length of 2000 characters.
 * - Max system prompt length of 10000 characters.
 * - Nullable UUIDv4 provider connection ID.
 * - Prohibits unrecognized fields (e.g. knowledgeBaseId, id, createdAt, status).
 */
export const createBotRequestSchema = z
  .object({
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
    providerConnectionId: z
      .string()
      .uuid({ message: 'providerConnectionId must be a valid UUIDv4 string.' })
      .nullable()
      .optional()
      .default(null),
    responsePolicy: botResponsePolicySchema.optional().default(DEFAULT_BOT_RESPONSE_POLICY),
    enabledTools: enabledToolsSchema.optional().default([])
  })
  .strict()

/**
 * Validates Bot update requests.
 * Prohibits mutating immutable identity or lifecycle fields.
 * Requires at least one mutable field to be provided.
 */
export const updateBotRequestSchema = z
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
    providerConnectionId: z
      .string()
      .uuid({ message: 'providerConnectionId must be a valid UUIDv4 string.' })
      .nullable()
      .optional(),
    responsePolicy: botResponsePolicySchema.optional(),
    enabledTools: enabledToolsSchema.optional()
  })
  .strict()
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.systemPrompt !== undefined ||
      data.modelId !== undefined ||
      data.providerConnectionId !== undefined ||
      data.responsePolicy !== undefined ||
      data.enabledTools !== undefined,
    { message: 'At least one editable Bot field must be provided for update.' }
  )

/**
 * Validates Bot list filter options.
 */
export const listBotsRequestSchema = z
  .object({
    status: z.enum(BOT_STATUSES).optional()
  })
  .strict()
  .optional()

// ============================================================================
// DTO Conversion & Error Handling
// ============================================================================

/**
 * Pure converter mapping database records or internal Bot entities into public BotDto objects.
 */
export function toBotDto(input: {
  id: string
  knowledgeBaseId?: string
  knowledge_base_id?: string
  providerConnectionId?: string | null
  provider_connection_id?: string | null
  name: string
  description?: string
  systemPrompt?: string
  system_prompt?: string
  modelId?: string
  model_id?: string
  status?: string
  responsePolicy?: string
  response_policy?: string
  toolPermissions?: readonly string[]
  enabledTools?: readonly string[]
  tool_permissions_json?: string
  createdAt?: number
  created_at?: number
  updatedAt?: number
  updated_at?: number
}): BotDto {
  const kbId = input.knowledgeBaseId ?? input.knowledge_base_id
  if (!kbId) {
    throw new Error('Knowledge Base ID is required to construct BotDto.')
  }

  let tools: ToolPermission[] = []
  if (Array.isArray(input.enabledTools)) {
    tools = [...input.enabledTools] as ToolPermission[]
  } else if (Array.isArray(input.toolPermissions)) {
    tools = [...input.toolPermissions] as ToolPermission[]
  } else if (typeof input.tool_permissions_json === 'string') {
    try {
      const parsed = JSON.parse(input.tool_permissions_json)
      if (Array.isArray(parsed)) {
        tools = parsed as ToolPermission[]
      }
    } catch {
      tools = []
    }
  }

  const status: BotStatus = input.status === 'archived' ? 'archived' : 'active'
  const responsePolicy = resolveBotResponsePolicy(input.responsePolicy ?? input.response_policy)

  return {
    id: input.id,
    knowledgeBaseId: kbId,
    providerConnectionId: input.providerConnectionId ?? input.provider_connection_id ?? null,
    name: input.name,
    description: input.description ?? '',
    systemPrompt: input.systemPrompt ?? input.system_prompt ?? '',
    modelId: input.modelId ?? input.model_id ?? '',
    status,
    responsePolicy,
    enabledTools: Object.freeze(tools),
    createdAt: input.createdAt ?? input.created_at ?? 0,
    updatedAt: input.updatedAt ?? input.updated_at ?? input.createdAt ?? input.created_at ?? 0
  }
}

/**
 * Normalized error class instantiated in Renderer/Preload when Bot bridge calls reject.
 */
export class BotBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'BOT_ERROR') {
    super(message)
    this.name = 'BotBridgeError'
    this.code = code
    Object.setPrototypeOf(this, BotBridgeError.prototype)
  }
}
