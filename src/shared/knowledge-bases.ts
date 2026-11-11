import { z } from 'zod'

/**
 * Public, renderer-safe Data Transfer Object representing a Knowledge Base.
 * Excludes internal database-only fields (e.g. storage_path).
 */
export interface KnowledgeBaseDto {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

/**
 * Caller input for creating a new Knowledge Base.
 */
export interface CreateKnowledgeBaseRequest {
  readonly name: string
  readonly description?: string
}

/**
 * Caller input for updating an existing Knowledge Base.
 */
export interface UpdateKnowledgeBaseRequest {
  readonly name?: string
  readonly description?: string
}

/**
 * Query options for listing Knowledge Bases.
 */
export interface KnowledgeBaseListRequest {
  readonly includeArchived?: boolean
}

/**
 * Structured result of a Knowledge Base deletion operation.
 * Communicates both SQLite database cascade deletion and physical storage cleanup status.
 */
export interface DeleteKnowledgeBaseResult {
  readonly success: boolean
  readonly directoryCleaned: boolean
  readonly cleanupPending: boolean
  readonly code?: string
  readonly error?: string
}

/**
 * Zod schema validating a canonical RFC 4122 UUIDv4 Knowledge Base ID.
 */
export const knowledgeBaseIdSchema = z
  .string()
  .uuid({ message: 'Invalid Knowledge Base ID: must be a valid RFC 4122 UUIDv4.' })

/**
 * Zod schema validating Knowledge Base creation requests.
 * Enforces strict non-empty trimmed name and max description length.
 */
export const createKnowledgeBaseRequestSchema = z
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

/**
 * Zod schema validating Knowledge Base update requests.
 * Prohibits updating immutable fields and requires at least one editable field.
 */
export const updateKnowledgeBaseRequestSchema = z
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

/**
 * Zod schema validating Knowledge Base listing filter options.
 */
export const knowledgeBaseListRequestSchema = z
  .object({
    includeArchived: z.boolean().optional().default(false)
  })
  .strict()
  .optional()

/**
 * Converts an internal database entity into a public, renderer-safe KnowledgeBaseDto.
 */
export function toKnowledgeBaseDto(row: {
  id: string
  name: string
  description: string
  created_at: number
  updated_at: number
  archived_at: number | null
}): KnowledgeBaseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

/**
 * Normalized error class instantiated in Renderer/Preload when Knowledge Base bridge calls reject.
 */
export class KnowledgeBaseBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'KNOWLEDGE_BASE_ERROR') {
    super(message)
    this.name = 'KnowledgeBaseBridgeError'
    this.code = code
    Object.setPrototypeOf(this, KnowledgeBaseBridgeError.prototype)
  }
}

/**
 * Typed Preload bridge interface exposed at window.api.knowledgeBases.
 */
export interface KnowledgeBaseApi {
  list(options?: KnowledgeBaseListRequest): Promise<readonly KnowledgeBaseDto[]>
  getById(id: string): Promise<KnowledgeBaseDto | null>
  create(input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDto>
  update(id: string, input: UpdateKnowledgeBaseRequest): Promise<KnowledgeBaseDto | null>
  archive(id: string): Promise<KnowledgeBaseDto | null>
  unarchive(id: string): Promise<KnowledgeBaseDto | null>
  delete(id: string): Promise<DeleteKnowledgeBaseResult>
  getOverview(id: string): Promise<KnowledgeBaseOverviewDto>
  activateWorkspace?(id: string): Promise<KnowledgeBaseDto>
  deactivateWorkspace?(): Promise<{ success: boolean }>
}

/**
 * Supported types of historical activity events scoped to a Knowledge Base.
 */
export type KnowledgeBaseActivityType =
  | 'bot_created'
  | 'bot_updated'
  | 'document_registered'
  | 'document_indexed'
  | 'document_failed'
  | 'agent_run'

/**
 * Public, renderer-safe Data Transfer Object representing a single scoped activity item.
 */
export interface KnowledgeBaseActivityItemDto {
  readonly id: string
  readonly type: KnowledgeBaseActivityType
  readonly title: string
  readonly detail?: string
  readonly timestamp: number
  readonly status?: string
}

/**
 * Public, renderer-safe Data Transfer Object representing aggregated Knowledge Base Overview statistics.
 */
export interface KnowledgeBaseOverviewDto {
  readonly knowledgeBaseId: string
  readonly bots: {
    readonly total: number
    readonly active: number
    readonly archived: number
  }
  readonly documents: {
    readonly total: number
    readonly ready: number
    readonly processing: number
    readonly failed: number
    readonly needsReindex?: number
    readonly totalBytes: number
  }
  readonly indexing: {
    readonly totalChunks: number
    readonly totalTokens: number
    readonly lastIndexedAt: number | null
  }
  readonly recentActivity: readonly KnowledgeBaseActivityItemDto[]
}

/**
 * Zod schema validating a KnowledgeBaseActivityType enum.
 */
export const knowledgeBaseActivityTypeSchema = z.enum([
  'bot_created',
  'bot_updated',
  'document_registered',
  'document_indexed',
  'document_failed',
  'agent_run'
])

/**
 * Zod schema validating a KnowledgeBaseActivityItemDto.
 */
export const knowledgeBaseActivityItemDtoSchema = z
  .object({
    id: z.string().min(1),
    type: knowledgeBaseActivityTypeSchema,
    title: z.string().min(1),
    detail: z.string().optional(),
    timestamp: z.number().int().positive(),
    status: z.string().optional()
  })
  .strict()

/**
 * Zod schema validating an aggregated KnowledgeBaseOverviewDto.
 */
export const knowledgeBaseOverviewDtoSchema = z
  .object({
    knowledgeBaseId: z.string().uuid(),
    bots: z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative()
      })
      .strict(),
    documents: z
      .object({
        total: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        processing: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        needsReindex: z.number().int().nonnegative().optional().default(0),
        totalBytes: z.number().int().nonnegative()
      })
      .strict(),
    indexing: z
      .object({
        totalChunks: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        lastIndexedAt: z.number().int().positive().nullable()
      })
      .strict(),
    recentActivity: z.array(knowledgeBaseActivityItemDtoSchema)
  })
  .strict()
