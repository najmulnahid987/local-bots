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
 * Sanitizes and normalizes an unknown error from OpenAI or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeOpenAIError(err: unknown, statusCodeOverride?: number): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride)

  // If already a sanitized ProviderAdapterError, return its error directly
  if (meta.adapterError) {
    return meta.adapterError
  }

  const errText = meta.combinedTextLower
  const statusCode = meta.statusCode
  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with OpenAI.'
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
      message: 'Request to OpenAI timed out.',
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
      message: 'Network connection failure while contacting OpenAI.',
      statusCode,
      retryable: true
    }
  }

  // 4. Inspect OpenAI specific error keywords
  if (
    errText.includes('insufficient_quota') ||
    errText.includes('quota exceeded') ||
    errText.includes('billing_not_active') ||
    errText.includes('exceeded your current quota')
  ) {
    return {
      code: 'QUOTA_EXCEEDED',
      message: 'OpenAI account quota exceeded. Please check your plan and billing details.',
      statusCode: statusCode ?? 429,
      retryable: false
    }
  }

  if (
    errText.includes('invalid_api_key') ||
    errText.includes('incorrect api key') ||
    errText.includes('invalid api key')
  ) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: 'OpenAI authentication failed. Please verify your API key.',
      statusCode: statusCode ?? 401,
      retryable: false
    }
  }

  if (
    errText.includes('maximum context length') ||
    errText.includes('context_length_exceeded') ||
    errText.includes('tokens exceeds the limit')
  ) {
    return {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: 'The conversation exceeded OpenAI context window limits.',
      statusCode: statusCode ?? 400,
      retryable: false
    }
  }

  // 5. Map HTTP status codes
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401:
        code = 'AUTHENTICATION_FAILED'
        message = 'OpenAI authentication failed. Please verify your API key.'
        retryable = false
        break

      case 403:
        code = 'PERMISSION_DENIED'
        message =
          'Access forbidden. Your OpenAI API key does not have permission for this resource.'
        retryable = false
        break

      case 404:
        code = 'MODEL_NOT_FOUND'
        message = 'The requested OpenAI model was not found or is unavailable for this key.'
        retryable = false
        break

      case 408:
        code = 'TIMEOUT'
        message = 'Request to OpenAI timed out.'
        retryable = true
        break

      case 429: {
        if (
          errText.includes('quota') ||
          errText.includes('billing') ||
          errText.includes('credit') ||
          errText.includes('balance')
        ) {
          code = 'QUOTA_EXCEEDED'
          message = 'OpenAI account quota exceeded. Please check your plan and billing details.'
          retryable = false
        } else {
          code = 'RATE_LIMITED'
          message = 'OpenAI rate limit exceeded. Please retry after a brief delay.'
          retryable = true
        }
        break
      }

      case 400:
      case 422:
        if (
          errText.includes('api key') ||
          errText.includes('unauthenticated') ||
          errText.includes('invalid_api_key')
        ) {
          code = 'AUTHENTICATION_FAILED'
          message = 'OpenAI authentication failed. Please verify your API key.'
          retryable = false
        } else {
          code = 'INVALID_REQUEST'
          message = 'The request was rejected by OpenAI as invalid.'
          retryable = false
        }
        break

      default:
        if (statusCode >= 500) {
          code = 'SERVER_ERROR'
          message = 'OpenAI servers are temporarily unavailable. Please retry later.'
          retryable = true
        } else {
          code = 'UNKNOWN_ERROR'
          message = `OpenAI API returned an unexpected error (HTTP ${statusCode}).`
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
    message = 'OpenAI returned an empty response. Please try again.'
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
    message = 'Received an incomplete or unexpected stream response from OpenAI. Please retry.'
    retryable = true
  } else if (meta.names.some((n) => n === 'AI_InvalidPromptError')) {
    code = 'INVALID_REQUEST'
    message = 'The conversation message payload could not be processed by OpenAI.'
    retryable = false
  }

  // 7. Record sanitized structural diagnostic entry if still UNKNOWN_ERROR
  if (code === 'UNKNOWN_ERROR') {
    const diagNames = meta.names.length > 0 ? meta.names.join(',') : 'Error'
    const diagCodes = meta.errorCodes.length > 0 ? ` codes=${meta.errorCodes.join(',')}` : ''
    const firstMsg = meta.messagesLower[0] ? ` msg="${meta.messagesLower[0].slice(0, 140)}"` : ''
    defaultErrorRingBuffer.addError({
      code: 'OPENAI_UNKNOWN_ERROR',
      category: 'provider',
      message: `OpenAI unclassified error [${diagNames}${diagCodes}]${firstMsg}`
    })
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
