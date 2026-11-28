import { type ProviderError, type ProviderErrorCode, ProviderAdapterError } from '../types'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'

export { ProviderAdapterError }

const MAX_SANITIZED_LENGTH = 400

interface CollectedErrorMetadata {
  readonly adapterError?: ProviderError
  readonly statusCode?: number
  readonly names: readonly string[]
  readonly errorCodes: readonly string[]
  readonly messagesRaw: readonly string[]
  readonly messagesLower: readonly string[]
  readonly combinedTextLower: string
}

/**
 * Redacts Groq API keys (`gsk_...`), generic bearer tokens, and query secrets.
 */
export function redactGroqSecrets(message: string): string {
  if (!message || typeof message !== 'string') {
    return ''
  }

  return message
    .replace(/(gsk_|sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /([?&](?:api_?key|key|token|access_token|secret|auth)=)[^&\s"'<>]+/gi,
      '$1[REDACTED_SECRET]'
    )
    .replace(/\b((?:authorization|x-api-key)\s*[:=]\s*)[^\s,;'"\r\n]+/gi, '$1[REDACTED_SECRET]')
    .slice(0, MAX_SANITIZED_LENGTH)
}

function collectErrorMetadata(err: unknown, statusCodeOverride?: number): CollectedErrorMetadata {
  const visited = new Set<unknown>()
  const names: string[] = []
  const errorCodes: string[] = []
  const messagesRaw: string[] = []
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
        messagesRaw.push(trimmed)
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
      messagesRaw.push(obj.status.trim())
      messagesLower.push(obj.status.trim().toLowerCase())
    }

    if (typeof obj.type === 'string' && obj.type.trim().length > 0) {
      messagesLower.push(obj.type.trim().toLowerCase())
    }

    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      messagesRaw.push(obj.message.trim())
      messagesLower.push(obj.message.trim().toLowerCase())
    }

    if (typeof obj.responseBody === 'string' && obj.responseBody.trim().length > 0) {
      messagesRaw.push(obj.responseBody.trim())
      messagesLower.push(obj.responseBody.trim().toLowerCase())
    }

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

  return {
    adapterError,
    statusCode,
    names,
    errorCodes,
    messagesRaw,
    messagesLower,
    combinedTextLower: messagesLower.join(' | ')
  }
}

function createNormalizedError(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  statusCode?: number,
  details?: string
): ProviderError {
  const safeMessage = redactGroqSecrets(message) || 'Groq provider request failed.'
  const safeDetails = details ? redactGroqSecrets(details) : undefined

  defaultErrorRingBuffer.addError({
    code,
    category: 'provider',
    message: `Provider [groq]: ${safeMessage}`
  })

  return {
    code,
    message: safeMessage,
    retryable,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(safeDetails ? { details: safeDetails } : {})
  }
}

/**
 * Classifies and sanitizes Groq API, AI SDK, HTTP, and network errors into ProviderError.
 * Guarantees no API key (`gsk_...`) or sensitive credential leaks in error text or logs.
 */
export function sanitizeGroqError(err: unknown, statusCodeOverride?: number): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride)

  if (meta.adapterError) {
    return {
      ...meta.adapterError,
      message: redactGroqSecrets(meta.adapterError.message),
      ...(meta.adapterError.details
        ? { details: redactGroqSecrets(meta.adapterError.details) }
        : {})
    }
  }

  const text = meta.combinedTextLower
  const rawDetails = meta.messagesRaw[0] ? redactGroqSecrets(meta.messagesRaw[0]) : undefined
  const namesLower = meta.names.map((n) => n.toLowerCase())
  const codesUpper = meta.errorCodes.map((c) => c.toUpperCase())

  // 1. Timeout vs User Abort
  if (
    namesLower.includes('timeouterror') ||
    codesUpper.includes('ETIMEDOUT') ||
    codesUpper.includes('UND_ERR_CONNECT_TIMEOUT') ||
    codesUpper.includes('UND_ERR_HEADERS_TIMEOUT') ||
    codesUpper.includes('UND_ERR_BODY_TIMEOUT') ||
    text.includes('timed out') ||
    text.includes('timeout')
  ) {
    return createNormalizedError(
      'TIMEOUT',
      'Request to Groq API timed out. Please try again.',
      true,
      meta.statusCode,
      rawDetails
    )
  }

  if (
    namesLower.includes('aborterror') ||
    codesUpper.includes('ABORT_ERR') ||
    text.includes('abort') ||
    text.includes('cancelled') ||
    text.includes('canceled')
  ) {
    return createNormalizedError(
      'OPERATION_ABORTED',
      'Groq request was cancelled.',
      false,
      meta.statusCode,
      rawDetails
    )
  }

  // 2. Network connectivity failures
  if (
    codesUpper.some((c) =>
      [
        'ENOTFOUND',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'EHOSTUNREACH',
        'ENETUNREACH'
      ].includes(c)
    ) ||
    text.includes('fetch failed') ||
    text.includes('network error') ||
    text.includes('socket hang up') ||
    text.includes('econnreset') ||
    text.includes('enotfound') ||
    text.includes('econnrefused')
  ) {
    return createNormalizedError(
      'NETWORK_ERROR',
      'Unable to reach Groq API servers. Check your internet connection and firewall settings.',
      true,
      meta.statusCode,
      rawDetails
    )
  }

  const status = meta.statusCode

  // 3. Authentication & Permission errors
  if (
    status === 401 ||
    text.includes('invalid_api_key') ||
    text.includes('invalid api key') ||
    text.includes('incorrect api key') ||
    text.includes('unauthorized')
  ) {
    return createNormalizedError(
      'AUTHENTICATION_FAILED',
      'Authentication failed: invalid or revoked Groq API key.',
      false,
      status ?? 401,
      rawDetails
    )
  }

  if (
    status === 403 ||
    text.includes('permission denied') ||
    text.includes('access denied') ||
    text.includes('organization_restricted')
  ) {
    return createNormalizedError(
      'PERMISSION_DENIED',
      'Groq API access denied for this credential or organization.',
      false,
      status ?? 403,
      rawDetails
    )
  }

  // 4. Context length exceeded (413 / token limit errors)
  if (
    status === 413 ||
    text.includes('context_length_exceeded') ||
    text.includes('context window') ||
    text.includes('request too large') ||
    text.includes('reduce the length') ||
    text.includes('maximum context length') ||
    text.includes('please reduce your prompt')
  ) {
    return createNormalizedError(
      'CONTEXT_LENGTH_EXCEEDED',
      'The prompt or context exceeds the selected Groq model token limit.',
      false,
      status,
      rawDetails
    )
  }

  // 5. Rate limiting vs Quota exhaustion (429)
  if (status === 429 || text.includes('rate_limit') || text.includes('too many requests')) {
    if (
      text.includes('insufficient_quota') ||
      text.includes('quota exceeded') ||
      text.includes('spend limit') ||
      text.includes('billing') ||
      text.includes('credits')
    ) {
      return createNormalizedError(
        'QUOTA_EXCEEDED',
        'Groq account quota or spend limit exceeded. Check your Groq console billing and limits.',
        false,
        429,
        rawDetails
      )
    }

    return createNormalizedError(
      'RATE_LIMITED',
      'Groq API rate limit reached (RPM/TPM). Please wait briefly and try again.',
      true,
      429,
      rawDetails
    )
  }

  // 6. Model not found / decommissioned (404 or model errors)
  if (
    status === 404 ||
    text.includes('model_not_found') ||
    text.includes('model_decommissioned') ||
    (text.includes('model') &&
      (text.includes('not found') ||
        text.includes('does not exist') ||
        text.includes('decommissioned') ||
        text.includes('not supported')))
  ) {
    return createNormalizedError(
      'MODEL_NOT_FOUND',
      'The requested Groq model was not found, is inactive, or has been decommissioned.',
      false,
      status,
      rawDetails
    )
  }

  // 7. Invalid request / tool formatting / structured output validation errors (400 / 422)
  if (
    status === 400 ||
    status === 422 ||
    text.includes('invalid_request_error') ||
    text.includes('tool_use_failed') ||
    text.includes('json_validate_failed') ||
    text.includes('reasoning_format')
  ) {
    return createNormalizedError(
      'INVALID_REQUEST',
      'Groq rejected the request due to invalid parameters or unsupported model options.',
      false,
      status ?? 400,
      rawDetails
    )
  }

  // 8. Provider transient server failures (5xx)
  if (status !== undefined && status >= 500) {
    return createNormalizedError(
      'SERVER_ERROR',
      `Groq API is temporarily unavailable (HTTP ${status}). Please try again shortly.`,
      true,
      status,
      rawDetails
    )
  }

  return createNormalizedError(
    'UNKNOWN_ERROR',
    'An unexpected error occurred while communicating with Groq.',
    false,
    status,
    rawDetails
  )
}
