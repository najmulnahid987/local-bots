import { z } from 'zod'

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
 * Approved MVP read-only and analytical tools.
 */
export const APPROVED_TOOL_PERMISSIONS = [
  'search_knowledge_base',
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
