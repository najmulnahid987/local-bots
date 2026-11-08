import { z } from 'zod'
import {
  knowledgeBaseIdSchema,
  createKnowledgeBaseRequestSchema,
  updateKnowledgeBaseRequestSchema,
  knowledgeBaseListRequestSchema
} from '../../shared/knowledge-bases'

/**
 * Strips raw filesystem paths or internal storage references from error strings.
 */
export function sanitizeKnowledgeBaseErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during Knowledge Base operation.'
  }

  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
    .replace(/\.quarantine_[a-zA-Z0-9_-]+/g, '[REDACTED_QUARANTINE]')
}

export const knowledgeBaseByIdIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema
  })
  .strict()

export const knowledgeBaseCreateIpcSchema = createKnowledgeBaseRequestSchema

export const knowledgeBaseUpdateIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema,
    input: updateKnowledgeBaseRequestSchema
  })
  .strict()

export const knowledgeBaseArchiveIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema
  })
  .strict()

export const knowledgeBaseUnarchiveIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema
  })
  .strict()

export const knowledgeBaseDeleteIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema
  })
  .strict()

export const knowledgeBaseOverviewIpcSchema = z
  .object({
    id: knowledgeBaseIdSchema
  })
  .strict()

export const knowledgeBaseListIpcSchema = knowledgeBaseListRequestSchema

/**
 * Validates a raw IPC payload using a strict Zod schema.
 * Throws a sanitized Error with a code of 'VALIDATION_ERROR' on failure.
 */
export function validateKnowledgeBaseIpcPayload<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    const sanitized = sanitizeKnowledgeBaseErrorMessage(errorDetails)
    const err = new Error(`Invalid Knowledge Base IPC payload: ${sanitized}`)
    ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
    throw err
  }
  return result.data
}
