import { z } from 'zod'
import {
  dispatchAgentTaskRequestSchema,
  cancelAgentTaskRequestSchema,
  getAgentRunRequestSchema,
  listAgentRunsRequestSchema,
  listToolEventsRequestSchema,
  getApprovalDetailsRequestSchema,
  respondToApprovalRequestSchema,
  agentStreamEventSchema,
  type DispatchAgentTaskRequest,
  type CancelAgentTaskRequest,
  type GetAgentRunRequest,
  type ListAgentRunsRequest,
  type ListAgentRunsResponse,
  type ListToolEventsRequest,
  type GetApprovalDetailsRequest,
  type RespondToApprovalRequest,
  type AgentStreamEvent
} from '../../shared/agents'

export interface AgentIpcErrorDto {
  code: string
  message: string
  retryable?: boolean
}

/**
 * Strips raw filesystem paths, secrets, API keys, credential refs, bearer tokens,
 * or internal stack traces from error messages before crossing the IPC bridge.
 */
export function sanitizeAgentErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during agent task operation.'
  }
  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/=]{10,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b((?:x-api-key|x-goog-api-key)\s*:\s*)[^\s,;'"\r\n]+/gi, '$1[REDACTED_SECRET]')
    .replace(
      /([?&](?:api_?key|key|token|access_token|secret|auth)=)[^&\s"'<>]+/gi,
      '$1[REDACTED_SECRET]'
    )
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
    .replace(/(?:\r?\n)\s*at\s+.*$/gm, '')
}

/**
 * Formats any caught Main-process error into a safe JSON-stringified AgentIpcErrorDto.
 * Preserves stable error codes and retryable flags while redacting sensitive tokens and paths.
 */
export function formatAgentIpcError(err: unknown): Error {
  if (typeof err === 'string') {
    const safeDto: AgentIpcErrorDto = {
      code: 'AGENT_OPERATION_FAILED',
      message: sanitizeAgentErrorMessage(err),
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
          const safeDto: AgentIpcErrorDto = {
            code: parsed.code,
            message: sanitizeAgentErrorMessage(parsed.message),
            retryable: Boolean(parsed.retryable)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not pre-serialized JSON
      }
    }

    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'AGENT_OPERATION_FAILED'
    const retryable =
      'retryable' in err && typeof err.retryable === 'boolean' ? err.retryable : false
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)

    const safeDto: AgentIpcErrorDto = {
      code,
      message: sanitizeAgentErrorMessage(rawMessage),
      retryable
    }
    return new Error(JSON.stringify(safeDto))
  }

  const fallback: AgentIpcErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the agent operation.',
    retryable: false
  }
  return new Error(JSON.stringify(fallback))
}

/**
 * Validates any raw untrusted IPC payload against a strict Zod schema.
 * Rejects unexpected keys and formats validation issues into structured errors.
 */
export function validateAgentIpcPayload<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    throw new Error(
      JSON.stringify({
        code: 'VALIDATION_FAILED',
        message: `Invalid agent IPC payload: ${issues.join('; ')}`,
        retryable: false
      })
    )
  }
  return result.data
}

export {
  dispatchAgentTaskRequestSchema,
  cancelAgentTaskRequestSchema,
  getAgentRunRequestSchema,
  listAgentRunsRequestSchema,
  listToolEventsRequestSchema,
  getApprovalDetailsRequestSchema,
  respondToApprovalRequestSchema,
  agentStreamEventSchema,
  type DispatchAgentTaskRequest,
  type CancelAgentTaskRequest,
  type GetAgentRunRequest,
  type ListAgentRunsRequest,
  type ListAgentRunsResponse,
  type ListToolEventsRequest,
  type GetApprovalDetailsRequest,
  type RespondToApprovalRequest,
  type AgentStreamEvent
}
