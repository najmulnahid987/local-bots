import { z } from 'zod'
import {
  botIdSchema,
  createBotRequestSchema,
  updateBotRequestSchema,
  listBotsRequestSchema,
  type UpdateBotRequest
} from '../../shared/bots'
import { idSchema } from '../database/repositories/types'
import { sanitizeBotErrorMessage } from '../services/bot-errors'

/**
 * Validates payloads containing a single target Bot ID.
 * Accepts:
 * 1. An object with `{ id: <UUID> }`
 * 2. An object with `{ botId: <UUID> }`
 * 3. A raw string `<UUID>`
 *
 * Strictly rejects unrecognized properties (such as renderer-injected `knowledgeBaseId`).
 */
export const botByIdIpcSchema = z.union([
  z
    .object({
      id: botIdSchema
    })
    .strict(),
  z
    .object({
      botId: botIdSchema
    })
    .strict()
    .transform((d) => ({ id: d.botId })),
  botIdSchema.transform((id) => ({ id }))
])

/**
 * Validates Bot creation payloads.
 * Reuses the strict createBotRequestSchema (no knowledgeBaseId, no status, trimmed name/model).
 */
export const botCreateIpcSchema = createBotRequestSchema

/**
 * Validates Bot update payloads.
 * Accepts:
 * 1. `{ id: <UUID>, input: <UpdateBotRequest> }`
 * 2. `{ id: <UUID>, request: <UpdateBotRequest> }`
 * 3. Flat object: `{ id: <UUID>, ...UpdateBotRequest }`
 *
 * In all cases, immutable fields (knowledgeBaseId, status, createdAt) and unknown keys are rejected.
 */
export const botUpdateIpcSchema = z.union([
  z
    .object({
      id: botIdSchema,
      input: updateBotRequestSchema
    })
    .strict(),
  z
    .object({
      id: botIdSchema,
      request: updateBotRequestSchema
    })
    .strict()
    .transform((d) => ({ id: d.id, input: d.request })),
  updateBotRequestSchema
    .extend({
      id: botIdSchema
    })
    .strict()
    .transform((d) => {
      const { id, ...input } = d
      return { id, input: input as UpdateBotRequest }
    })
])

/**
 * Validates listing options for Bots.
 */
export const botListIpcSchema = listBotsRequestSchema

/**
 * Validates workspace activation requests.
 * Accepts `{ id: <UUID> }`, `{ knowledgeBaseId: <UUID> }`, or raw `<UUID>`.
 * Rejects unknown properties.
 */
export const workspaceActivateIpcSchema = z.union([
  z
    .object({
      id: idSchema
    })
    .strict(),
  z
    .object({
      knowledgeBaseId: idSchema
    })
    .strict()
    .transform((d) => ({ id: d.knowledgeBaseId })),
  idSchema.transform((id) => ({ id }))
])

/**
 * Validates a raw IPC payload using a strict Zod schema.
 * Throws a sanitized Error with a code of 'VALIDATION_ERROR' on failure.
 */
export function validateBotIpcPayload<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ')
    const sanitized = sanitizeBotErrorMessage(errorDetails)
    const err = new Error(`Invalid Bot IPC payload: ${sanitized}`)
    ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
    throw err
  }
  return result.data
}
