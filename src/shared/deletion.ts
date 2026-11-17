import { z } from 'zod'

/**
 * Permitted deletable entity types in the application hierarchy.
 */
export const DELETABLE_ENTITY_TYPES = [
  'conversation',
  'bot',
  'knowledge_source',
  'knowledge_base'
] as const

export type DeletableEntityType = (typeof DELETABLE_ENTITY_TYPES)[number]

export const deletableEntityTypeSchema = z.enum(DELETABLE_ENTITY_TYPES)

/**
 * Permitted deletion recovery lifecycle states matching SQLite CHECK constraint.
 */
export const DELETION_RECOVERY_STATES = [
  'preparing',
  'quarantining',
  'database_deleting',
  'database_deleted',
  'filesystem_finalizing',
  'completed',
  'rolling_back',
  'recovery_required',
  'failed'
] as const

export type DeletionRecoveryState = (typeof DELETION_RECOVERY_STATES)[number]

export const deletionRecoveryStateSchema = z.enum(DELETION_RECOVERY_STATES)

export interface DeletionRecoveryJournalEntryDto {
  readonly id: string
  readonly entityType: 'knowledge_base' | 'knowledge_source'
  readonly entityId: string
  readonly knowledgeBaseId: string
  readonly entityName: string
  readonly quarantinePathName: string
  readonly originalRelPath: string | null
  readonly state: DeletionRecoveryState
  readonly errorMessage: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export const deletionRecoveryJournalEntryDtoSchema = z
  .object({
    id: z.string().uuid(),
    entityType: z.enum(['knowledge_base', 'knowledge_source']),
    entityId: z.string().min(1),
    knowledgeBaseId: z.string().min(1),
    entityName: z.string().min(1),
    quarantinePathName: z.string().min(1),
    originalRelPath: z.string().nullable(),
    state: deletionRecoveryStateSchema,
    errorMessage: z.string().nullable(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  .strict()

/**
 * Deletion preview counts breakdown.
 */
export interface DeletionDependentCountsDto {
  readonly bots?: number
  readonly sources?: number
  readonly chunks?: number
  readonly conversations?: number
  readonly messages?: number
  readonly memories?: number
  readonly agentRuns?: number
  readonly toolEvents?: number
}

export const deletionDependentCountsDtoSchema = z
  .object({
    bots: z.number().int().nonnegative().optional(),
    sources: z.number().int().nonnegative().optional(),
    chunks: z.number().int().nonnegative().optional(),
    conversations: z.number().int().nonnegative().optional(),
    messages: z.number().int().nonnegative().optional(),
    memories: z.number().int().nonnegative().optional(),
    agentRuns: z.number().int().nonnegative().optional(),
    toolEvents: z.number().int().nonnegative().optional()
  })
  .strict()

/**
 * Data Transfer Object providing comprehensive, safe preview details
 * before destructive deletion confirmation.
 */
export interface DeletionPreviewDto {
  readonly entityType: DeletableEntityType
  readonly entityId: string
  readonly displayName: string
  readonly parentName: string | null
  readonly parentId: string | null
  readonly dependentCounts: DeletionDependentCountsDto
  readonly affectedCategories: readonly string[]
  readonly unaffectedCategories: readonly string[]
  readonly backupReversible: boolean
  readonly isBlocked: boolean
  readonly blockReason?: string
  readonly warnings: readonly string[]
}

export const deletionPreviewDtoSchema = z
  .object({
    entityType: deletableEntityTypeSchema,
    entityId: z.string().uuid(),
    displayName: z.string().min(1),
    parentName: z.string().nullable(),
    parentId: z.string().uuid().nullable(),
    dependentCounts: deletionDependentCountsDtoSchema,
    affectedCategories: z.array(z.string()),
    unaffectedCategories: z.array(z.string()),
    backupReversible: z.boolean(),
    isBlocked: z.boolean(),
    blockReason: z.string().optional(),
    warnings: z.array(z.string())
  })
  .strict()

/**
 * Request payload to fetch a deletion preview.
 */
export interface GetDeletionPreviewRequest {
  readonly entityType: DeletableEntityType
  readonly entityId: string
}

export const getDeletionPreviewRequestSchema = z
  .object({
    entityType: deletableEntityTypeSchema,
    entityId: z.string().uuid()
  })
  .strict()

/**
 * Request payload to execute an entity deletion.
 */
export interface DeleteEntityRequest {
  readonly entityType: DeletableEntityType
  readonly entityId: string
  readonly confirmName?: string
}

export const deleteEntityRequestSchema = z
  .object({
    entityType: deletableEntityTypeSchema,
    entityId: z.string().uuid(),
    confirmName: z.string().optional()
  })
  .strict()

/**
 * Result DTO returned after entity deletion execution.
 */
export interface DeleteEntityResultDto {
  readonly success: boolean
  readonly entityType: DeletableEntityType
  readonly entityId: string
  readonly directoryCleaned?: boolean
  readonly fileCleaned?: boolean
  readonly cleanupPending?: boolean
  readonly error?: string
}

export const deleteEntityResultDtoSchema = z
  .object({
    success: z.boolean(),
    entityType: deletableEntityTypeSchema,
    entityId: z.string().uuid(),
    directoryCleaned: z.boolean().optional(),
    fileCleaned: z.boolean().optional(),
    cleanupPending: z.boolean().optional(),
    error: z.string().optional()
  })
  .strict()

/**
 * Shared IPC channels for Deletion Previews & Cascade Hardening.
 */
export const DELETION_IPC_CHANNELS = {
  GET_PREVIEW: 'deletion:get-preview',
  DELETE_ENTITY: 'deletion:delete-entity'
} as const

export type DeletionIpcChannel = (typeof DELETION_IPC_CHANNELS)[keyof typeof DELETION_IPC_CHANNELS]

/**
 * Structured client-side bridge error thrown by window.api.deletion.
 */
export class DeletionBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'DELETION_ERROR') {
    super(message)
    this.name = 'DeletionBridgeError'
    this.code = code
    Object.setPrototypeOf(this, DeletionBridgeError.prototype)
  }
}

/**
 * Preload interface exposed to the React Renderer at window.api.deletion.
 */
export interface DeletionApi {
  getPreview(entityType: DeletableEntityType, entityId: string): Promise<DeletionPreviewDto>
  deleteEntity(request: DeleteEntityRequest): Promise<DeleteEntityResultDto>
}
