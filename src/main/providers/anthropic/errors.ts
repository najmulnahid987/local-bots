import { type ProviderError, type ProviderErrorCode, ProviderAdapterError } from '../types'

export { ProviderAdapterError }

/**
 * Sanitizes and normalizes an unknown error from Anthropic or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeAnthropicError(err: unknown, statusCodeOverride?: number): ProviderError {
  // If already a sanitized ProviderAdapterError, return its error directly
  if (err instanceof ProviderAdapterError) {
    return err.error
  }

  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with Anthropic.'
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
      message = 'Request to Anthropic timed out.'
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
      message = 'Network connection failure while contacting Anthropic.'
      retryable = true
      return { code, message, statusCode, retryable }
    }
  }

  // 3. Map HTTP status codes to defined application categories
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

      case 413:
        code = 'CONTEXT_LENGTH_EXCEEDED'
        message = 'The prompt or context length exceeds Anthropic model limits.'
        retryable = false
        break

      case 429: {
        // Distinguish rate limit from exhausted credit/quota
        const errString = String(err).toLowerCase()
        if (
          errString.includes('credit') ||
          errString.includes('quota') ||
          errString.includes('billing') ||
          errString.includes('balance')
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
        // Anthropic specific status code for overloaded servers
        code = 'SERVER_ERROR'
        message = 'Anthropic servers are temporarily overloaded. Please retry later.'
        retryable = true
        break

      case 400:
      case 422:
        code = 'INVALID_REQUEST'
        message = 'The request was rejected by Anthropic as invalid.'
        retryable = false
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
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
