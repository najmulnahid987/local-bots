import { type ProviderError, type ProviderErrorCode, ProviderAdapterError } from '../types'

export { ProviderAdapterError }

/**
 * Sanitizes and normalizes an unknown error from Google Gemini or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeGoogleError(err: unknown, statusCodeOverride?: number): ProviderError {
  // If already a sanitized ProviderAdapterError, return its error directly
  if (err instanceof ProviderAdapterError) {
    return err.error
  }

  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with Google Gemini.'
  let retryable = false
  let statusCode = statusCodeOverride

  // 1. Inspect for AbortSignal / cancellation
  if (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.message.toLowerCase().includes('abort') ||
      err.message.toLowerCase().includes('cancel'))
  ) {
    return {
      code: 'OPERATION_ABORTED',
      message: 'The operation was aborted by the client.',
      retryable: false
    }
  }

  // 2. Inspect for HTTP status code from AI SDK or fetch response
  if (err && typeof err === 'object') {
    const errorObj = err as Record<string, unknown>

    if (typeof errorObj.statusCode === 'number') {
      statusCode = errorObj.statusCode
    } else if (typeof errorObj.status === 'number') {
      statusCode = errorObj.status
    }

    // Inspect error message for keyword classification
    const rawMsg = typeof errorObj.message === 'string' ? errorObj.message.toLowerCase() : ''

    if (rawMsg.includes('timeout') || rawMsg.includes('timed out')) {
      code = 'TIMEOUT'
      message = 'Request to Google Gemini timed out.'
      retryable = true
      return { code, message, statusCode, retryable }
    }

    if (
      rawMsg.includes('fetch failed') ||
      rawMsg.includes('econnrefused') ||
      rawMsg.includes('enotfound') ||
      rawMsg.includes('network')
    ) {
      code = 'NETWORK_ERROR'
      message = 'Network connection failure while contacting Google Gemini.'
      retryable = true
      return { code, message, statusCode, retryable }
    }
  }

  const errString = String(err).toLowerCase()

  // 3. Inspect structured Google RPC error details/reasons
  if (
    errString.includes('api_key_invalid') ||
    errString.includes('api key not valid') ||
    errString.includes('api_key_service_blocked') ||
    errString.includes('consumer_suspended')
  ) {
    code = 'AUTHENTICATION_FAILED'
    if (
      errString.includes('legacy') ||
      errString.includes('expired') ||
      errString.includes('authorization key')
    ) {
      message =
        'Google API key was rejected or has expired. If using a legacy key, generate a new Authorization key at Google AI Studio.'
    } else {
      message = 'Google Gemini authentication failed. Please verify your API key.'
    }
    retryable = false
    return { code, message, statusCode: statusCode ?? 400, retryable }
  }

  // 4. Map HTTP status codes and standard RPC statuses
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

      case 429: {
        // Distinguish rate limit from exhausted quota
        if (
          errString.includes('rate') ||
          errString.includes('rate_limit') ||
          errString.includes('concurrency')
        ) {
          code = 'RATE_LIMITED'
          message = 'Google Gemini rate limit exceeded. Please retry after a brief delay.'
          retryable = true
        } else if (
          errString.includes('quota') ||
          errString.includes('billing') ||
          errString.includes('credit') ||
          errString.includes('balance')
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
          errString.includes('api key') ||
          errString.includes('unauthenticated') ||
          errString.includes('invalid_key')
        ) {
          code = 'AUTHENTICATION_FAILED'
          if (errString.includes('legacy') || errString.includes('expired')) {
            message =
              'Google API key was rejected or has expired. If using a legacy key, generate a new Authorization key at Google AI Studio.'
          } else {
            message = 'Google Gemini authentication failed. Please verify your API key.'
          }
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
  } else {
    // Check RPC status names if statusCode wasn't explicitly numeric
    if (errString.includes('unauthenticated')) {
      code = 'AUTHENTICATION_FAILED'
      message = 'Google Gemini authentication failed. Please verify your API key.'
      retryable = false
    } else if (errString.includes('permission_denied')) {
      code = 'PERMISSION_DENIED'
      message = 'Access forbidden. Your Google API key does not have permission for this resource.'
      retryable = false
    } else if (errString.includes('not_found')) {
      code = 'MODEL_NOT_FOUND'
      message = 'The requested Google Gemini model was not found or is unavailable for this key.'
      retryable = false
    } else if (errString.includes('resource_exhausted')) {
      if (errString.includes('rate')) {
        code = 'RATE_LIMITED'
        message = 'Google Gemini rate limit exceeded. Please retry after a brief delay.'
        retryable = true
      } else if (
        errString.includes('quota') ||
        errString.includes('billing') ||
        errString.includes('credit') ||
        errString.includes('balance')
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
    } else if (errString.includes('unavailable') || errString.includes('internal')) {
      code = 'SERVER_ERROR'
      message = 'Google Gemini servers are temporarily unavailable. Please retry later.'
      retryable = true
    }
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
