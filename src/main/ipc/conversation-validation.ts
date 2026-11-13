import { z } from 'zod'
import {
  conversationIdSchema,
  createConversationRequestSchema,
  listMessagesRequestSchema,
  renameConversationIpcRequestSchema,
  deleteConversationIpcRequestSchema,
  sendMessageIpcRequestSchema,
  retryTurnIpcRequestSchema,
  cancelGenerationIpcRequestSchema
} from '../../shared/conversations'
import { botIdSchema } from '../../shared/bots'

export interface ConversationErrorDto {
  code: string
  message: string
  retryable?: boolean
}

/**
 * Strips raw filesystem paths, secrets, API keys, credential refs, bearer tokens,
 * or internal stack traces from error messages before crossing the IPC bridge.
 */
export function sanitizeConversationErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during conversation operation.'
  }
  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/=]{10,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
    .replace(/(?:\r?\n)\s*at\s+.*$/gm, '')
}

/**
 * Formats any caught Main-process error into a safe JSON-stringified ConversationErrorDto.
 * Preserves stable error codes and retryable flags while redacting sensitive tokens and paths.
 */
export function formatConversationIpcError(err: unknown): Error {
  if (typeof err === 'string') {
    const safeDto: ConversationErrorDto = {
      code: 'CONVERSATION_OPERATION_FAILED',
      message: sanitizeConversationErrorMessage(err),
      retryable: false
    }
    return new Error(JSON.stringify(safeDto))
  }

  if (err && typeof err === 'object') {
    // If already a JSON-stringified error dto in message
    if ('message' in err && typeof err.message === 'string') {
      try {
        const parsed = JSON.parse(err.message) as {
          code?: string
          message?: string
          retryable?: boolean
        }
        if (parsed.code && parsed.message) {
          const safeDto: ConversationErrorDto = {
            code: parsed.code,
            message: sanitizeConversationErrorMessage(parsed.message),
            retryable: Boolean(parsed.retryable)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not pre-serialized JSON
      }
    }

    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'CONVERSATION_OPERATION_FAILED'
    const retryable =
      'retryable' in err && typeof err.retryable === 'boolean' ? err.retryable : false
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)

    const safeDto: ConversationErrorDto = {
      code,
      message: sanitizeConversationErrorMessage(rawMessage),
      retryable
    }
    return new Error(JSON.stringify(safeDto))
  }

  const fallback: ConversationErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the conversation operation.',
    retryable: false
  }
  return new Error(JSON.stringify(fallback))
}

// ============================================================================
// IPC Schemas with Strict Input Validation
// ============================================================================

/**
 * Validates create conversation payloads.
 * Rejects arbitrary or injected fields like knowledgeBaseId or sessionId.
 */
export const conversationCreateIpcSchema = createConversationRequestSchema

/**
 * Validates list conversations requests.
 * Requires botId to enforce bot-level scoping under the active workspace.
 */
export const conversationListIpcSchema = z
  .object({
    botId: botIdSchema,
    includeArchived: z.boolean().optional().default(false),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional()
  })
  .strict()

/**
 * Validates list messages requests.
 * Accepts `{ conversationId, limit?, offset? }` or raw UUID string.
 */
export const conversationGetMessagesIpcSchema = z.union([
  listMessagesRequestSchema,
  conversationIdSchema.transform((conversationId) => ({ conversationId }))
])

/**
 * Validates rename conversation requests.
 * Accepts `{ conversationId, title }`.
 */
export const conversationRenameIpcSchema = renameConversationIpcRequestSchema

/**
 * Validates delete conversation requests.
 * Accepts `{ conversationId }` or raw UUID string.
 */
export const conversationDeleteIpcSchema = z.union([
  deleteConversationIpcRequestSchema,
  conversationIdSchema.transform((conversationId) => ({ conversationId }))
])

/**
 * Validates send message streaming requests.
 * Accepts `{ requestId, conversationId, content, contentFormat? }`.
 */
export const conversationSendMessageIpcSchema = sendMessageIpcRequestSchema

/**
 * Validates retry turn streaming requests.
 * Accepts `{ requestId, conversationId, messageId? }`.
 */
export const conversationRetryIpcSchema = retryTurnIpcRequestSchema

/**
 * Validates cancel generation requests.
 * Accepts `{ requestId }` or raw UUID string.
 */
export const conversationCancelIpcSchema = z.union([
  cancelGenerationIpcRequestSchema,
  z
    .string()
    .uuid({ message: 'requestId must be a valid UUIDv4 string.' })
    .transform((requestId) => ({ requestId }))
])

/**
 * Validates resolve citation requests.
 * Enforces strict input schema: requires conversationId, messageId, citationNumber.
 * Rejects any injected fields like knowledgeBaseId or sourceId.
 */
export const conversationResolveCitationIpcSchema = z
  .object({
    conversationId: conversationIdSchema,
    messageId: z.string().uuid({ message: 'messageId must be a valid UUIDv4 string.' }),
    citationNumber: z
      .number()
      .int()
      .min(1, { message: 'citationNumber must be a positive integer.' })
  })
  .strict()

/**
 * Validates a raw IPC payload using a strict Zod schema.
 * Throws a sanitized Error with code 'INVALID_INPUT' on failure.
 */
export function validateConversationIpcPayload<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ')
    const sanitized = sanitizeConversationErrorMessage(errorDetails)
    const err = new Error(`Invalid Conversation IPC payload: ${sanitized}`)
    ;(err as unknown as { code: string }).code = 'INVALID_INPUT'
    throw err
  }
  return result.data
}
