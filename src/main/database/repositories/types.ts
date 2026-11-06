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
