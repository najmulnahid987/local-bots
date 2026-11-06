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
