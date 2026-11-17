import { z } from 'zod'
import { botIdSchema } from './bots'

/**
 * Shared IPC channels for Bot Memory persistence.
 */
export const BOT_MEMORY_IPC_CHANNELS = {
  CREATE: 'bot-memory:create',
  GET: 'bot-memory:get',
  LIST: 'bot-memory:list',
  UPDATE: 'bot-memory:update',
  DELETE: 'bot-memory:delete',
  COUNT: 'bot-memory:count'
} as const

export type BotMemoryIpcChannel =
  (typeof BOT_MEMORY_IPC_CHANNELS)[keyof typeof BOT_MEMORY_IPC_CHANNELS]

/**
 * Permitted memory types matching SQLite CHECK constraint:
 * CHECK (memory_type IN ('user_note', 'pinned_instruction'))
 */
export const BOT_MEMORY_TYPES = ['user_note', 'pinned_instruction'] as const
export type BotMemoryType = (typeof BOT_MEMORY_TYPES)[number]

/**
 * Maximum content length for a per-Bot memory item (10,000 characters).
 * Consistent with Bot system prompt and Agent task prompt boundaries.
 */
export const MAX_BOT_MEMORY_CONTENT_LENGTH = 10_000

/**
 * Dedicated maximum token budget for Bot memories in prompt construction (1,500 tokens).
 */
export const MAX_BOT_MEMORY_CONTEXT_TOKENS = 1500

/**
 * Standard project token estimator: ~4 characters per token (Math.ceil(length / 4)).
 * Pure, side-effect-free, and consistent across Main and Renderer layers.
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Structured bridge error thrown by the Bot Memories Preload bridge.
 */
export class BotMemoryBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'BOT_MEMORY_ERROR') {
    super(message)
    this.name = 'BotMemoryBridgeError'
    this.code = code
    Object.setPrototypeOf(this, BotMemoryBridgeError.prototype)
  }
}

/**
 * Public, renderer-safe Data Transfer Object representing a per-Bot saved memory.
 */
export interface BotMemoryDto {
  readonly id: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly memoryType: BotMemoryType
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Input for creating a new memory for a Bot.
 * Note: knowledgeBaseId is deliberately omitted because the authoritative
 * Knowledge Base context is resolved in the Main process from the Bot record.
 */
export interface CreateBotMemoryInput {
  readonly botId: string
  readonly memoryType?: BotMemoryType
  readonly content: string
}

/**
 * Input for updating an existing Bot memory.
 * Immutable fields (id, botId, knowledgeBaseId, createdAt) cannot be updated.
 */
export interface UpdateBotMemoryInput {
  readonly memoryType?: BotMemoryType
  readonly content?: string
}

/**
 * Filter options for listing memories for a Bot.
 */
export interface ListBotMemoriesInput {
  readonly botId: string
  readonly memoryType?: BotMemoryType
}

/**
 * Input for fetching a single memory for a Bot.
 */
export interface GetBotMemoryInput {
  readonly memoryId: string
  readonly botId: string
}

/**
 * Input for deleting a memory belonging to a Bot.
 */
export interface DeleteBotMemoryInput {
  readonly memoryId: string
  readonly botId: string
}

/**
 * Structured result of a memory deletion operation.
 */
export interface DeleteBotMemoryResultDto {
  readonly success: boolean
  readonly memoryId: string
}

/**
 * Structured count of memories for a Bot.
 */
export interface BotMemoryCountDto {
  readonly botId: string
  readonly count: number
}

/**
 * Typed Preload bridge interface exposed at window.api.botMemories (and window.api.memories).
 */
export interface BotMemoryApi {
  create(input: CreateBotMemoryInput): Promise<BotMemoryDto>
  get(memoryId: string, botId: string): Promise<BotMemoryDto | null>
  list(input: ListBotMemoriesInput): Promise<readonly BotMemoryDto[]>
  update(memoryId: string, botId: string, input: UpdateBotMemoryInput): Promise<BotMemoryDto>
  delete(memoryId: string, botId: string): Promise<DeleteBotMemoryResultDto>
  count(botId: string): Promise<BotMemoryCountDto>
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

/**
 * Validates a canonical RFC 4122 UUIDv4 memory ID string.
 */
export const botMemoryIdSchema = z
  .string()
  .uuid({ message: 'Invalid Memory ID: must be a valid RFC 4122 UUIDv4.' })

/**
 * Validates permitted memory types.
 */
export const botMemoryTypeSchema = z.enum(BOT_MEMORY_TYPES, {
  message: `Invalid memory type. Must be one of: ${BOT_MEMORY_TYPES.join(', ')}`
})

/**
 * Validates non-empty, trimmed memory text content within length bounds.
 */
export const botMemoryContentSchema = z
  .string()
  .trim()
  .min(1, { message: 'Memory content cannot be blank.' })
  .max(MAX_BOT_MEMORY_CONTENT_LENGTH, {
    message: `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH} characters.`
  })

/**
 * Validates CreateBotMemoryInput payloads from renderer.
 * Strictly rejects unrecognized properties (e.g. knowledgeBaseId, id, createdAt).
 */
export const createBotMemorySchema = z
  .object({
    botId: botIdSchema,
    memoryType: botMemoryTypeSchema.optional().default('user_note'),
    content: botMemoryContentSchema
  })
  .strict()

/**
 * Validates UpdateBotMemoryInput payloads.
 * Requires at least one mutable field (content or memoryType).
 * Strictly rejects unrecognized properties.
 */
export const updateBotMemorySchema = z
  .object({
    memoryType: botMemoryTypeSchema.optional(),
    content: botMemoryContentSchema.optional()
  })
  .strict()
  .refine((data) => data.memoryType !== undefined || data.content !== undefined, {
    message: 'At least one field (content or memoryType) must be provided for update.'
  })

/**
 * Validates ListBotMemoriesInput.
 */
export const listBotMemoriesSchema = z
  .object({
    botId: botIdSchema,
    memoryType: botMemoryTypeSchema.optional()
  })
  .strict()

/**
 * Validates GetBotMemoryInput.
 */
export const getBotMemorySchema = z
  .object({
    memoryId: botMemoryIdSchema,
    botId: botIdSchema
  })
  .strict()

/**
 * Validates DeleteBotMemoryInput.
 */
export const deleteBotMemorySchema = z
  .object({
    memoryId: botMemoryIdSchema,
    botId: botIdSchema
  })
  .strict()

/**
 * Validates BotMemoryCount request.
 */
export const botMemoryCountSchema = z
  .object({
    botId: botIdSchema
  })
  .strict()

/**
 * Maps a raw database row or repository entity to a public BotMemoryDto.
 */
export function toBotMemoryDto(row: {
  id: string
  bot_id?: string
  botId?: string
  knowledge_base_id?: string
  knowledgeBaseId?: string
  memory_type?: string
  memoryType?: string
  content: string
  created_at?: number
  createdAt?: number
  updated_at?: number
  updatedAt?: number
}): BotMemoryDto {
  return {
    id: row.id,
    botId: row.botId ?? row.bot_id ?? '',
    knowledgeBaseId: row.knowledgeBaseId ?? row.knowledge_base_id ?? '',
    memoryType: (row.memoryType ?? row.memory_type ?? 'user_note') as BotMemoryType,
    content: row.content,
    createdAt: row.createdAt ?? row.created_at ?? 0,
    updatedAt: row.updatedAt ?? row.updated_at ?? 0
  }
}
