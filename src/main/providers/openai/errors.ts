import { type ProviderError, type ProviderErrorCode } from '../types'

/**
 * Custom error class wrapping a sanitized, typed ProviderError.
 */
export class ProviderAdapterError extends Error {
  readonly error: ProviderError

  constructor(error: ProviderError) {
    super(error.message)
    this.name = 'ProviderAdapterError'
    this.error = error
    Object.setPrototypeOf(this, ProviderAdapterError.prototype)
  }
}

/**
 * Sanitizes and normalizes an unknown error from OpenAI or the AI SDK into an application-safe ProviderError.
 * Invariant: Never contains API keys, authorization headers, prompt content, or raw request/response bodies.
 */
export function sanitizeOpenAIError(err: unknown, statusCodeOverride?: number): ProviderError {
  // If already a sanitized ProviderAdapterError, return its error directly
  if (err instanceof ProviderAdapterError) {
    return err.error
  }

  let code: ProviderErrorCode = 'UNKNOWN_ERROR'
  let message = 'An unexpected error occurred while communicating with OpenAI.'
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
      message = 'Request to OpenAI timed out.'
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
      message = 'Network connection failure while contacting OpenAI.'
      retryable = true
      return { code, message, statusCode, retryable }
    }
  }

  // 3. Map HTTP status codes to defined application categories
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

      case 429: {
        // Distinguish rate limit from insufficient quota
        const errString = String(err).toLowerCase()
        if (errString.includes('quota') || errString.includes('billing')) {
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
        code = 'INVALID_REQUEST'
        message = 'The request was rejected by OpenAI as invalid.'
        retryable = false
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
  }

  return {
    code,
    message,
    statusCode,
    retryable
  }
}
