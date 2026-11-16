import { z } from 'zod'
import {
  createBotMemorySchema,
  updateBotMemorySchema,
  listBotMemoriesSchema,
  getBotMemorySchema,
  deleteBotMemorySchema,
  botMemoryCountSchema,
  botMemoryIdSchema,
  MAX_BOT_MEMORY_CONTENT_LENGTH,
  BOT_MEMORY_TYPES
} from '../../shared/bot-memories'
import { botIdSchema } from '../../shared/bots'
import { sanitizeBotErrorMessage } from '../services/bot-errors'

export interface BotMemoryErrorDto {
  code: string
  message: string
}

/**
 * Strips raw filesystem paths, secrets, API keys, or internal references from error strings.
 */
export function sanitizeBotMemoryErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during Bot Memory operation.'
  }
  return sanitizeBotErrorMessage(message)
}

/**
 * Formats any caught error into a safe JSON-stringified BotMemoryErrorDto.
 * Strips secrets, filesystem paths, and internal stack traces.
 */
export function formatBotMemoryIpcError(err: unknown): Error {
  if (typeof err === 'string') {
    const safeDto: BotMemoryErrorDto = {
      code: 'BOT_MEMORY_OPERATION_FAILED',
      message: sanitizeBotMemoryErrorMessage(err)
    }
    return new Error(JSON.stringify(safeDto))
  }

  if (err && typeof err === 'object') {
    if ('message' in err && typeof err.message === 'string') {
      try {
        const parsed = JSON.parse(err.message) as { code?: string; message?: string }
        if (parsed.code && parsed.message) {
          const safeDto: BotMemoryErrorDto = {
            code: parsed.code,
            message: sanitizeBotMemoryErrorMessage(parsed.message)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not JSON, continue below
      }
    }

    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'BOT_MEMORY_OPERATION_FAILED'
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    const safeDto: BotMemoryErrorDto = {
      code,
      message: sanitizeBotMemoryErrorMessage(rawMessage)
    }
    return new Error(JSON.stringify(safeDto))
  }

  const fallback: BotMemoryErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the Bot Memory operation.'
  }
  return new Error(JSON.stringify(fallback))
}

/**
 * Validates any IPC payload against a given Zod schema, throwing formatted JSON error on failure.
 */
export function validateBotMemoryIpcPayload<T>(schema: z.ZodType<T>, rawPayload: unknown): T {
  const result = schema.safeParse(rawPayload)
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join('; ')
    throw new Error(
      JSON.stringify({
        code: 'VALIDATION_ERROR',
        message: sanitizeBotMemoryErrorMessage(message)
      })
    )
  }
  return result.data
}

/**
 * Validates Bot Memory create payload.
 */
export const botMemoryCreateIpcSchema = createBotMemorySchema

/**
 * Validates Bot Memory get payload.
 */
export const botMemoryGetIpcSchema = getBotMemorySchema

/**
 * Validates Bot Memory list payload.
 */
export const botMemoryListIpcSchema = listBotMemoriesSchema

/**
 * Validates Bot Memory update payload.
 * Accepts:
 * 1. `{ memoryId, botId, input: { content?, memoryType? } }`
 * 2. `{ memoryId, botId, content?, memoryType? }`
 */
export const botMemoryUpdateIpcSchema = z.union([
  z
    .object({
      memoryId: botMemoryIdSchema,
      botId: botIdSchema,
      input: updateBotMemorySchema
    })
    .strict(),
  z
    .object({
      memoryId: botMemoryIdSchema,
      botId: botIdSchema,
      content: z
        .string()
        .trim()
        .min(1, { message: 'Memory content cannot be blank.' })
        .max(MAX_BOT_MEMORY_CONTENT_LENGTH, {
          message: `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH} characters.`
        })
        .optional(),
      memoryType: z.enum(BOT_MEMORY_TYPES).optional()
    })
    .strict()
    .refine((data) => data.content !== undefined || data.memoryType !== undefined, {
      message: 'At least one field (content or memoryType) must be provided for update.'
    })
    .transform((data) => ({
      memoryId: data.memoryId,
      botId: data.botId,
      input: {
        content: data.content,
        memoryType: data.memoryType
      }
    }))
])

/**
 * Validates Bot Memory delete payload.
 */
export const botMemoryDeleteIpcSchema = deleteBotMemorySchema

/**
 * Validates Bot Memory count payload.
 */
export const botMemoryCountIpcSchema = botMemoryCountSchema
