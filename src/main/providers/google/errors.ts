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
 * Sanitizes and normalizes an unknown error from Google Gemini or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeGoogleError(err: unknown, statusCodeOverride?: number): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride)

  if (meta.adapterError) {
    return meta.adapterError
  }

  const errText = meta.combinedTextLower
  const statusCode = meta.statusCode
  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with Google Gemini.'
  let retryable = false

  // 1. Inspect for timeout before abort (since AbortController timeouts wrap Error reasons)
  if (
    errText.includes('timeout') ||
    errText.includes('timed out') ||
    errText.includes('etimedout') ||
    errText.includes('und_err_body_timeout') ||
    errText.includes('und_err_headers_timeout') ||
    errText.includes('und_err_connect_timeout') ||
    errText.includes('deadline_exceeded')
  ) {
    return {
      code: 'TIMEOUT',
      message: 'Request to Google Gemini timed out.',
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

  // 3. Inspect for network / transport / SSE stream disconnect failures (including Fetch Error.cause)
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
      message: 'Network connection failure while contacting Google Gemini.',
      statusCode,
      retryable: true
    }
  }

  // 4. Inspect structured Google RPC error details/reasons
  if (
    errText.includes('api_key_invalid') ||
    errText.includes('api key not valid') ||
    errText.includes('api_key_service_blocked') ||
    errText.includes('consumer_suspended')
  ) {
    code = 'AUTHENTICATION_FAILED'
    if (
      errText.includes('legacy') ||
      errText.includes('expired') ||
      errText.includes('authorization key')
    ) {
      message =
        'Google API key was rejected or has expired. If using a legacy key, generate a new Authorization key at Google AI Studio.'
    } else {
      message = 'Google Gemini authentication failed. Please verify your API key.'
    }
    return { code, message, statusCode: statusCode ?? 400, retryable: false }
  }

  // 5. Inspect context window / payload size limits
  if (
    errText.includes('context length') ||
    errText.includes('maximum context') ||
    errText.includes('token count') ||
    errText.includes('exceeds the maximum number of tokens') ||
    errText.includes('too many tokens') ||
    errText.includes('payload size exceeds')
  ) {
    return {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: 'The conversation exceeded Google Gemini context window limits.',
      statusCode,
      retryable: false
    }
  }

  // 6. Map HTTP status codes (including unwrapped RetryError.lastError status codes)
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401:
        code = 'AUTHENTICATION_FAILED'
        message = 'Google Gemini authentication failed. Please verify your API key.'
        retryable = false
        break

      case 403:
        code = 'PERMISSION_DENIED'
        message =
          'Access forbidden. Your Google API key does not have permission for this resource.'
        retryable = false
        break

      case 404:
        code = 'MODEL_NOT_FOUND'
        message = 'The requested Google Gemini model was not found or is unavailable for this key.'
        retryable = false
        break

      case 408:
        code = 'TIMEOUT'
        message = 'Request to Google Gemini timed out.'
        retryable = true
        break

      case 499:
        code = 'OPERATION_ABORTED'
        message = 'The operation was cancelled.'
        retryable = false
        break

      case 429: {
        // Distinguish rate limit from exhausted quota
        if (
          errText.includes('rate') ||
          errText.includes('rate_limit') ||
          errText.includes('concurrency')
        ) {
          code = 'RATE_LIMITED'
          message = 'Google Gemini rate limit exceeded. Please retry after a brief delay.'
          retryable = true
        } else if (
          errText.includes('quota') ||
          errText.includes('billing') ||
          errText.includes('credit') ||
          errText.includes('balance')
        ) {
          code = 'QUOTA_EXCEEDED'
          message =
            'Google Gemini account quota exceeded. Please check your plan and billing details.'
          retryable = false
        } else {
          code = 'RATE_LIMITED'
          message = 'Google Gemini rate limit exceeded. Please retry after a brief delay.'
          retryable = true
        }
        break
      }

      case 400:
      case 422:
        if (
          errText.includes('api key') ||
          errText.includes('unauthenticated') ||
          errText.includes('invalid_key')
        ) {
          code = 'AUTHENTICATION_FAILED'
          if (errText.includes('legacy') || errText.includes('expired')) {
            message =
              'Google API key was rejected or has expired. If using a legacy key, generate a new Authorization key at Google AI Studio.'
          } else {
            message = 'Google Gemini authentication failed. Please verify your API key.'
          }
          retryable = false
        } else if (errText.includes('safety') || errText.includes('blocked')) {
          code = 'INVALID_REQUEST'
          message = 'The request was blocked by Google Gemini safety filters.'
          retryable = false
        } else {
          code = 'INVALID_REQUEST'
          message = 'The request was rejected by Google Gemini as invalid.'
          retryable = false
        }
        break

      default:
        if (statusCode >= 500) {
          code = 'SERVER_ERROR'
          message = 'Google Gemini servers are temporarily unavailable. Please retry later.'
          retryable = true
        } else {
          code = 'UNKNOWN_ERROR'
          message = `Google Gemini API returned an unexpected error (HTTP ${statusCode}).`
          retryable = false
        }
    }
    return { code, message, statusCode, retryable }
  }

  // 7. Check RPC status names & AI SDK stream/parse/overload errors when no numeric status was attached
  if (errText.includes('unauthenticated')) {
    code = 'AUTHENTICATION_FAILED'
    message = 'Google Gemini authentication failed. Please verify your API key.'
    retryable = false
  } else if (errText.includes('permission_denied')) {
    code = 'PERMISSION_DENIED'
    message = 'Access forbidden. Your Google API key does not have permission for this resource.'
    retryable = false
  } else if (errText.includes('not_found')) {
    code = 'MODEL_NOT_FOUND'
    message = 'The requested Google Gemini model was not found or is unavailable for this key.'
    retryable = false
  } else if (errText.includes('resource_exhausted')) {
    if (
      (errText.includes('quota') ||
        errText.includes('billing') ||
        errText.includes('credit') ||
        errText.includes('balance')) &&
      !errText.includes('rate')
    ) {
      code = 'QUOTA_EXCEEDED'
      message = 'Google Gemini account quota exceeded. Please check your plan and billing details.'
      retryable = false
    } else {
      code = 'RATE_LIMITED'
      message = 'Google Gemini rate limit exceeded. Please retry after a brief delay.'
      retryable = true
    }
  } else if (
    errText.includes('unavailable') ||
    errText.includes('internal') ||
    errText.includes('overloaded') ||
    errText.includes('high demand')
  ) {
    code = 'SERVER_ERROR'
    message = 'Google Gemini servers are temporarily unavailable. Please retry later.'
    retryable = true
  } else if (
    meta.names.some(
      (n) =>
        n === 'AI_NoOutputGeneratedError' ||
        n === 'AI_EmptyResponseBodyError' ||
        n === 'AI_NoContentGeneratedError'
    )
  ) {
    code = 'SERVER_ERROR'
    message = 'Google Gemini returned an empty response. Please try again.'
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
    message =
      'Received an incomplete or unexpected stream response from Google Gemini. Please retry.'
    retryable = true
  } else if (meta.names.some((n) => n === 'AI_InvalidPromptError')) {
    code = 'INVALID_REQUEST'
    message = 'The conversation message payload could not be processed by Google Gemini.'
    retryable = false
  }

  // 8. Record sanitized structural diagnostic entry if still UNKNOWN_ERROR so root causes stay observable
  if (code === 'UNKNOWN_ERROR') {
    const diagNames = meta.names.length > 0 ? meta.names.join(',') : 'Error'
    const diagCodes = meta.errorCodes.length > 0 ? ` codes=${meta.errorCodes.join(',')}` : ''
    const firstMsg = meta.messagesLower[0] ? ` msg="${meta.messagesLower[0].slice(0, 140)}"` : ''
    defaultErrorRingBuffer.addError({
      code: 'GOOGLE_UNKNOWN_ERROR',
      category: 'provider',
      message: `Google Gemini unclassified error [${diagNames}${diagCodes}]${firstMsg}`
    })
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
