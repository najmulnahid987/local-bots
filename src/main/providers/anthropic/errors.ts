import { type ProviderError, type ProviderErrorCode, ProviderAdapterError } from '../types'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'

export { ProviderAdapterError }

interface CollectedErrorMetadata {
  readonly adapterError?: ProviderError
  readonly statusCode?: number
  readonly names: readonly string[]
  readonly errorCodes: readonly string[]
  readonly messagesLower: readonly string[]
  readonly combinedTextLower: string
}

/**
 * Safely unwraps nested error objects (such as AI SDK RetryError.lastError / errors[]
 * and Node/Undici Fetch Error.cause chains) without cycles.
 */
function collectErrorMetadata(err: unknown, statusCodeOverride?: number): CollectedErrorMetadata {
  const visited = new Set<unknown>()
  const names: string[] = []
  const errorCodes: string[] = []
  const messagesLower: string[] = []
  let statusCode = statusCodeOverride
  let adapterError: ProviderError | undefined

  const visit = (node: unknown, depth: number): void => {
    if (node == null || depth > 6 || visited.has(node)) {
      return
    }
    visited.add(node)

    if (node instanceof ProviderAdapterError) {
      if (!adapterError) {
        adapterError = node.error
      }
      return
    }

    if (typeof node === 'string') {
      const trimmed = node.trim()
      if (trimmed.length > 0) {
        messagesLower.push(trimmed.toLowerCase())
      }
      return
    }

    if (typeof node !== 'object') {
      return
    }

    const obj = node as Record<string, unknown>

    if (typeof obj.name === 'string' && obj.name.trim().length > 0) {
      names.push(obj.name.trim())
    }

    if (typeof obj.code === 'string' && obj.code.trim().length > 0) {
      errorCodes.push(obj.code.trim())
    } else if (
      typeof obj.code === 'number' &&
      statusCode === undefined &&
      obj.code >= 400 &&
      obj.code <= 599
    ) {
      statusCode = obj.code
    }

    if (typeof obj.statusCode === 'number' && statusCode === undefined) {
      statusCode = obj.statusCode
    } else if (typeof obj.status === 'number' && statusCode === undefined) {
      statusCode = obj.status
    } else if (typeof obj.status === 'string' && obj.status.trim().length > 0) {
      messagesLower.push(obj.status.trim().toLowerCase())
    }

    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      messagesLower.push(obj.message.trim().toLowerCase())
    }

    if (typeof obj.reason === 'string' && obj.reason.trim().length > 0) {
      messagesLower.push(obj.reason.trim().toLowerCase())
    }

    if (typeof obj.responseBody === 'string' && obj.responseBody.trim().length > 0) {
      messagesLower.push(obj.responseBody.trim().toLowerCase())
    }

    // Traverse RetryError.lastError -> errors[] (most recent first) -> cause -> nested error/data
    if ('lastError' in obj && obj.lastError !== undefined) {
      visit(obj.lastError, depth + 1)
    }
    if (Array.isArray(obj.errors)) {
      for (let i = obj.errors.length - 1; i >= 0; i--) {
        visit(obj.errors[i], depth + 1)
      }
    }
    if ('cause' in obj && obj.cause !== undefined) {
      visit(obj.cause, depth + 1)
    }
    if ('error' in obj && obj.error !== undefined) {
      visit(obj.error, depth + 1)
    }
    if ('data' in obj && obj.data !== undefined) {
      visit(obj.data, depth + 1)
    }
  }

  visit(err, 0)

  const stringFallback = err != null && typeof err !== 'string' ? String(err).toLowerCase() : ''
  const combinedParts = [
    ...names.map((n) => n.toLowerCase()),
    ...errorCodes.map((c) => c.toLowerCase()),
    ...messagesLower,
    stringFallback
  ].filter(Boolean)

  return {
    adapterError,
    statusCode,
    names,
    errorCodes,
    messagesLower,
    combinedTextLower: combinedParts.join(' | ')
  }
}

/**
 * Sanitizes and normalizes an unknown error from Anthropic or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeAnthropicError(err: unknown, statusCodeOverride?: number): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride)

  // If already a sanitized ProviderAdapterError, return its error directly
  if (meta.adapterError) {
    return meta.adapterError
  }

  const errText = meta.combinedTextLower
  const statusCode = meta.statusCode
  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with Anthropic.'
  let retryable = false

  // 1. Inspect for timeout before abort
  if (
    errText.includes('timeout') ||
    errText.includes('timed out') ||
    errText.includes('etimedout') ||
    errText.includes('und_err_body_timeout') ||
    errText.includes('und_err_headers_timeout') ||
    errText.includes('und_err_connect_timeout')
  ) {
    return {
      code: 'TIMEOUT',
      message: 'Request to Anthropic timed out.',
      statusCode,
      retryable: true
    }
  }

  // 2. Inspect for explicit client AbortSignal / cancellation
  const isAbort =
    meta.names.some((n) => n === 'AbortError') ||
    meta.messagesLower.some((m) => m.includes('abort') || m.includes('cancel'))
  if (isAbort && statusCode !== 408 && statusCode !== 504) {
    return {
      code: 'OPERATION_ABORTED',
      message: 'The operation was aborted by the client.',
      retryable: false
    }
  }

  // 3. Inspect for network / transport / SSE socket disconnect failures
  if (
    errText.includes('fetch failed') ||
    errText.includes('econnrefused') ||
    errText.includes('econnreset') ||
    errText.includes('enotfound') ||
    errText.includes('epipe') ||
    errText.includes('enetunreach') ||
    errText.includes('ehostunreach') ||
    errText.includes('eai_again') ||
    errText.includes('socket hang up') ||
    errText.includes('other side closed') ||
    errText.includes('terminated') ||
    errText.includes('und_err_socket') ||
    errText.includes('und_err_connect') ||
    errText.includes('network')
  ) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Network connection failure while contacting Anthropic.',
      statusCode,
      retryable: true
    }
  }

  // 4. Inspect Anthropic specific error keywords
  if (
    errText.includes('credit_balance_too_low') ||
    errText.includes('balance is too low') ||
    errText.includes('quota exhausted') ||
    errText.includes('plans & billing')
  ) {
    return {
      code: 'QUOTA_EXCEEDED',
      message:
        'Anthropic account quota or credit balance exhausted. Please check your billing details.',
      statusCode: statusCode ?? 429,
      retryable: false
    }
  }

  if (
    errText.includes('invalid x-api-key') ||
    errText.includes('invalid_x_api_key') ||
    errText.includes('authentication_error')
  ) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: 'Anthropic authentication failed. Please verify your API key.',
      statusCode: statusCode ?? 401,
      retryable: false
    }
  }

  if (
    errText.includes('prompt is too long') ||
    errText.includes('prompt_too_long') ||
    errText.includes('maximum context')
  ) {
    return {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: 'The prompt or context length exceeds Anthropic model limits.',
      statusCode: statusCode ?? 413,
      retryable: false
    }
  }

  if (errText.includes('overloaded_error') || errText.includes('overloaded')) {
    return {
      code: 'SERVER_ERROR',
      message: 'Anthropic servers are temporarily overloaded. Please retry later.',
      statusCode: statusCode ?? 529,
      retryable: true
    }
  }

  // 5. Map HTTP status codes
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401:
        code = 'AUTHENTICATION_FAILED'
        message = 'Anthropic authentication failed. Please verify your API key.'
        retryable = false
        break

      case 403:
        code = 'PERMISSION_DENIED'
        message =
          'Access forbidden. Your Anthropic API key does not have permission for this resource.'
        retryable = false
        break

      case 404:
        code = 'MODEL_NOT_FOUND'
        message = 'The requested Anthropic model was not found or is unavailable for this key.'
        retryable = false
        break

      case 408:
        code = 'TIMEOUT'
        message = 'Request to Anthropic timed out.'
        retryable = true
        break

      case 413:
        code = 'CONTEXT_LENGTH_EXCEEDED'
        message = 'The prompt or context length exceeds Anthropic model limits.'
        retryable = false
        break

      case 429: {
        if (
          errText.includes('credit') ||
          errText.includes('quota') ||
          errText.includes('billing') ||
          errText.includes('balance')
        ) {
          code = 'QUOTA_EXCEEDED'
          message =
            'Anthropic account quota or credit balance exhausted. Please check your billing details.'
          retryable = false
        } else {
          code = 'RATE_LIMITED'
          message = 'Anthropic rate limit exceeded. Please retry after a brief delay.'
          retryable = true
        }
        break
      }

      case 529:
        code = 'SERVER_ERROR'
        message = 'Anthropic servers are temporarily overloaded. Please retry later.'
        retryable = true
        break

      case 400:
      case 422:
        if (
          errText.includes('api key') ||
          errText.includes('x-api-key') ||
          errText.includes('unauthenticated')
        ) {
          code = 'AUTHENTICATION_FAILED'
          message = 'Anthropic authentication failed. Please verify your API key.'
          retryable = false
        } else {
          code = 'INVALID_REQUEST'
          message = 'The request was rejected by Anthropic as invalid.'
          retryable = false
        }
        break

      default:
        if (statusCode >= 500) {
          code = 'SERVER_ERROR'
          message = 'Anthropic servers are temporarily unavailable. Please retry later.'
          retryable = true
        } else {
          code = 'UNKNOWN_ERROR'
          message = `Anthropic API returned an unexpected error (HTTP ${statusCode}).`
          retryable = false
        }
    }

    return { code, message, statusCode, retryable }
  }

  // 6. Check AI SDK stream/parse errors when no status code was attached
  if (
    meta.names.some(
      (n) =>
        n === 'AI_NoOutputGeneratedError' ||
        n === 'AI_EmptyResponseBodyError' ||
        n === 'AI_NoContentGeneratedError'
    )
  ) {
    code = 'SERVER_ERROR'
    message = 'Anthropic returned an empty response. Please try again.'
    retryable = true
  } else if (
    meta.names.some(
      (n) =>
        n === 'AI_TypeValidationError' ||
        n === 'AI_JSONParseError' ||
        n === 'AI_InvalidResponseDataError' ||
        n === 'AI_InvalidStreamPartError'
    )
  ) {
    code = 'SERVER_ERROR'
    message = 'Received an incomplete or unexpected stream response from Anthropic. Please retry.'
    retryable = true
  } else if (meta.names.some((n) => n === 'AI_InvalidPromptError')) {
    code = 'INVALID_REQUEST'
    message = 'The conversation message payload could not be processed by Anthropic.'
    retryable = false
  }

  // 7. Record sanitized structural diagnostic entry if still UNKNOWN_ERROR
  if (code === 'UNKNOWN_ERROR') {
    const diagNames = meta.names.length > 0 ? meta.names.join(',') : 'Error'
    const diagCodes = meta.errorCodes.length > 0 ? ` codes=${meta.errorCodes.join(',')}` : ''
    const firstMsg = meta.messagesLower[0] ? ` msg="${meta.messagesLower[0].slice(0, 140)}"` : ''
    defaultErrorRingBuffer.addError({
      code: 'ANTHROPIC_UNKNOWN_ERROR',
      category: 'provider',
      message: `Anthropic unclassified error [${diagNames}${diagCodes}]${firstMsg}`
    })
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
