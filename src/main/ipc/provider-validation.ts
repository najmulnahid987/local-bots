import { z } from 'zod'
import { FIRST_WAVE_PROVIDERS } from '../../shared/providers'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'

export const UUID_SCHEMA = z.string().uuid({ message: 'Must be a valid UUID' })

export const API_KEY_SCHEMA = z
  .string()
  .min(1, { message: 'API key cannot be empty' })
  .max(500, { message: 'API key exceeds maximum permitted length' })

export const LABEL_SCHEMA = z
  .string()
  .trim()
  .min(1, { message: 'Connection label cannot be empty' })
  .max(100, { message: 'Connection label exceeds maximum length (100 characters)' })

export const MODEL_ID_SCHEMA = z
  .string()
  .trim()
  .min(1, { message: 'Model ID cannot be empty' })
  .max(100, { message: 'Model ID exceeds maximum length (100 characters)' })

export const PROVIDER_ID_SCHEMA = z.enum(FIRST_WAVE_PROVIDERS, {
  message: `Invalid provider. Supported providers: ${FIRST_WAVE_PROVIDERS.join(', ')}`
})

export const CHAT_MESSAGE_SCHEMA = z
  .object({
    role: z.enum(['system', 'user', 'assistant'], {
      message: 'Role must be system, user, or assistant'
    }),
    content: z
      .string()
      .max(200_000, { message: 'Individual message content exceeds 200,000 characters' })
  })
  .strict()

export const GENERATE_TEXT_OPTIONS_SCHEMA = z
  .object({
    messages: z
      .array(CHAT_MESSAGE_SCHEMA)
      .min(1, { message: 'At least one message is required' })
      .max(100, { message: 'Message count exceeds maximum permitted (100 messages)' }),
    systemPrompt: z
      .string()
      .max(100_000, { message: 'System prompt exceeds maximum 100,000 characters' })
      .optional(),
    temperature: z
      .number()
      .min(0, { message: 'Temperature must be between 0 and 2' })
      .max(2, { message: 'Temperature must be between 0 and 2' })
      .optional(),
    maxOutputTokens: z
      .number()
      .int()
      .positive({ message: 'maxOutputTokens must be a positive integer' })
      .max(128_000, { message: 'maxOutputTokens cannot exceed 128,000' })
      .optional(),
    tools: z.unknown().optional(),
    jsonSchema: z.unknown().optional()
  })
  .strict()
  .refine(
    (data) => {
      let totalLength = data.systemPrompt?.length ?? 0
      for (const m of data.messages) {
        totalLength += m.content.length
      }
      return totalLength <= 1_000_000
    },
    { message: 'Total prompt size exceeds maximum permitted (1,000,000 characters)' }
  )

export const testDraftConnectionIpcSchema = z
  .object({
    providerId: PROVIDER_ID_SCHEMA,
    apiKey: API_KEY_SCHEMA,
    modelId: MODEL_ID_SCHEMA.optional()
  })
  .strict()

export const createConnectionIpcSchema = z
  .object({
    providerId: PROVIDER_ID_SCHEMA,
    label: LABEL_SCHEMA,
    apiKey: API_KEY_SCHEMA,
    modelId: MODEL_ID_SCHEMA.optional()
  })
  .strict()

export const testConnectionIpcSchema = z
  .object({
    connectionId: UUID_SCHEMA,
    modelId: MODEL_ID_SCHEMA.optional()
  })
  .strict()

export const updateConnectionLabelIpcSchema = z
  .object({
    connectionId: UUID_SCHEMA,
    label: LABEL_SCHEMA
  })
  .strict()

export const replaceCredentialIpcSchema = z
  .object({
    connectionId: UUID_SCHEMA,
    apiKey: API_KEY_SCHEMA,
    modelId: MODEL_ID_SCHEMA.optional()
  })
  .strict()

export const removeConnectionIpcSchema = z
  .object({
    connectionId: UUID_SCHEMA
  })
  .strict()

export const generateTextIpcSchema = z
  .object({
    connectionId: UUID_SCHEMA,
    modelId: MODEL_ID_SCHEMA,
    options: GENERATE_TEXT_OPTIONS_SCHEMA
  })
  .strict()

export const streamStartIpcSchema = z
  .object({
    streamId: UUID_SCHEMA,
    connectionId: UUID_SCHEMA,
    modelId: MODEL_ID_SCHEMA,
    options: GENERATE_TEXT_OPTIONS_SCHEMA
  })
  .strict()

/**
 * Validates raw IPC payload with a given Zod schema and returns sanitized data.
 * Throws a sanitized Error on validation failure, guaranteed never to leak credential inputs.
 */
export function validateIpcPayload<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    // Ensure no raw secret or sensitive fragment appears in validation errors
    throw new Error(`Invalid IPC request payload: ${sanitizeErrorMessage(errorDetails)}`)
  }
  return result.data
}
