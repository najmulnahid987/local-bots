import { type ProviderError, type ProviderErrorCode, ProviderAdapterError } from '../types'
import { defaultErrorRingBuffer } from '../../services/error-ring-buffer'

export { ProviderAdapterError }

const MAX_SANITIZED_LENGTH = 400

interface CollectedErrorMetadata {
  readonly adapterError?: ProviderError
  readonly statusCode?: number
  readonly retryAfterSeconds?: number
  readonly requestId?: string
  readonly providerName?: string
  readonly names: readonly string[]
  readonly errorCodes: readonly string[]
  readonly messagesRaw: readonly string[]
  readonly messagesLower: readonly string[]
  readonly combinedTextLower: string
}

/**
 * Redacts OpenRouter (`sk-or-v1-...`), Groq (`gsk_...`), OpenAI/Anthropic (`sk-...`),
 * Google (`AIzaSy...`), Bearer tokens, and URL query credentials.
 */
export function redactOpenRouterSecrets(message: string): string {
  if (!message || typeof message !== 'string') {
    return ''
  }

  return message
    .replace(
      /(sk-or-v1-|sk-or-|sk-proj-|sk-ant-|AIzaSy|gsk_|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi,
      '[REDACTED_KEY]'
    )
    .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /([?&](?:api_?key|key|token|access_token|secret|auth)=)[^&\s"'<>]+/gi,
      '$1[REDACTED_SECRET]'
    )
    .replace(/\b((?:authorization|x-api-key)\s*[:=]\s*)[^\s,;'"\r\n]+/gi, '$1[REDACTED_SECRET]')
    .slice(0, MAX_SANITIZED_LENGTH)
}

function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  let raw: string | undefined
  if (typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('retry-after') ?? undefined
  } else {
    const rec = headers as Record<string, unknown>
    const candidate = rec['retry-after'] ?? rec['Retry-After']
    if (typeof candidate === 'string') raw = candidate
    else if (typeof candidate === 'number' && Number.isFinite(candidate))
      return Math.ceil(candidate)
  }

  if (!raw) return undefined
  const trimmed = raw.trim()
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric)
  }
  const parsedDate = Date.parse(trimmed)
  if (Number.isFinite(parsedDate)) {
    const deltaSec = Math.ceil((parsedDate - Date.now()) / 1000)
    return deltaSec > 0 ? deltaSec : undefined
  }
  return undefined
}

function collectErrorMetadata(
  err: unknown,
  statusCodeOverride?: number,
  requestIdOverride?: string
): CollectedErrorMetadata {
  const visited = new Set<unknown>()
  const names: string[] = []
  const errorCodes: string[] = []
  const messagesRaw: string[] = []
  const messagesLower: string[] = []
  let statusCode = statusCodeOverride
  let retryAfterSeconds: number | undefined
  let requestId = requestIdOverride
  let providerName: string | undefined
  let adapterError: ProviderError | undefined

  const visit = (node: unknown, depth: number): void => {
    if (node == null || depth > 7 || visited.has(node)) {
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

    if (typeof obj.id === 'string' && obj.id.startsWith('gen-') && !requestId) {
      requestId = obj.id
    }

    if (
      typeof obj.provider_name === 'string' &&
      obj.provider_name.trim().length > 0 &&
      !providerName
    ) {
      providerName = obj.provider_name.trim()
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

    if (retryAfterSeconds === undefined && obj.responseHeaders) {
      retryAfterSeconds = parseRetryAfter(obj.responseHeaders)
    }
    if (retryAfterSeconds === undefined && obj.headers) {
      retryAfterSeconds = parseRetryAfter(obj.headers)
    }

    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      messagesRaw.push(obj.message.trim())
      messagesLower.push(obj.message.trim().toLowerCase())
    }

    if (typeof obj.raw === 'string' && obj.raw.trim().length > 0) {
      messagesRaw.push(obj.raw.trim())
      messagesLower.push(obj.raw.trim().toLowerCase())
    }

    if (typeof obj.responseBody === 'string' && obj.responseBody.trim().length > 0) {
      messagesRaw.push(obj.responseBody.trim())
      messagesLower.push(obj.responseBody.trim().toLowerCase())
      try {
        const parsed = JSON.parse(obj.responseBody) as unknown
        visit(parsed, depth + 1)
      } catch {
        // Not JSON; already recorded raw text
      }
    }

    for (const key of ['lastError', 'cause', 'error', 'data', 'metadata'] as const) {
      if (key in obj && obj[key] !== undefined) {
        visit(obj[key], depth + 1)
      }
    }

    if (Array.isArray(obj.errors)) {
      for (let i = obj.errors.length - 1; i >= 0; i--) {
        visit(obj.errors[i], depth + 1)
      }
    }
  }

  visit(err, 0)

  return {
    adapterError,
    statusCode,
    retryAfterSeconds,
    requestId,
    providerName,
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
  details?: string,
  requestId?: string
): ProviderError {
  const safeMessage = redactOpenRouterSecrets(message) || 'OpenRouter provider request failed.'
  const requestNote = requestId ? ` [requestId=${redactOpenRouterSecrets(requestId)}]` : ''
  const combinedDetails = details
    ? `${redactOpenRouterSecrets(details)}${requestNote}`.slice(0, MAX_SANITIZED_LENGTH)
    : requestId
      ? `requestId=${redactOpenRouterSecrets(requestId)}`
      : undefined

  defaultErrorRingBuffer.addError({
    code,
    category: 'provider',
    message: `Provider [openrouter]: ${safeMessage}${requestNote}`
  })

  return {
    code,
    message: safeMessage,
    retryable,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(combinedDetails ? { details: combinedDetails } : {})
  }
}

/**
 * Classifies and sanitizes OpenRouter SDK, HTTP, SSE mid-stream, and network errors.
 * Never leaks `sk-or-v1-` keys, auth headers, or raw credential payloads.
 */
export function sanitizeOpenRouterError(
  err: unknown,
  statusCodeOverride?: number,
  requestIdOverride?: string
): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride, requestIdOverride)

  if (meta.adapterError) {
    return {
      ...meta.adapterError,
      message: redactOpenRouterSecrets(meta.adapterError.message),
      ...(meta.adapterError.details
        ? { details: redactOpenRouterSecrets(meta.adapterError.details) }
        : {})
    }
  }

  const text = meta.combinedTextLower
  const rawDetails = meta.messagesRaw[0] ? redactOpenRouterSecrets(meta.messagesRaw[0]) : undefined
  const namesLower = meta.names.map((n) => n.toLowerCase())
  const codesUpper = meta.errorCodes.map((c) => c.toUpperCase())
  const status = meta.statusCode
  const providerPrefix = meta.providerName ? ` (upstream provider: ${meta.providerName})` : ''

  // 1. Timeout vs User Abort
  if (
    namesLower.includes('timeouterror') ||
    codesUpper.some((c) =>
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT'
      ].includes(c)
    ) ||
    text.includes('timed out') ||
    text.includes('timeout')
  ) {
    return createNormalizedError(
      'TIMEOUT',
      'Request to OpenRouter timed out. Please try again.',
      true,
      status ?? 408,
      rawDetails,
      meta.requestId
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
      'OpenRouter request was cancelled.',
      false,
      status,
      rawDetails,
      meta.requestId
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
      'Unable to reach OpenRouter API servers. Check your internet connection and firewall settings.',
      true,
      status,
      rawDetails,
      meta.requestId
    )
  }

  // 3. Payment Required / Insufficient Credits (402)
  if (
    status === 402 ||
    text.includes('insufficient credits') ||
    text.includes('payment required') ||
    text.includes('requires more credits')
  ) {
    return createNormalizedError(
      'QUOTA_EXCEEDED',
      'OpenRouter account has insufficient credits or requires payment.',
      false,
      402,
      rawDetails,
      meta.requestId
    )
  }

  // 4. Authentication & Permission / Guardrail Denied
  if (
    status === 401 ||
    text.includes('no auth credentials') ||
    text.includes('invalid credentials') ||
    text.includes('user not found') ||
    text.includes('unauthorized')
  ) {
    return createNormalizedError(
      'AUTHENTICATION_FAILED',
      'Authentication failed: invalid or revoked OpenRouter API key.',
      false,
      status ?? 401,
      rawDetails,
      meta.requestId
    )
  }

  if (
    status === 403 ||
    text.includes('moderation') ||
    text.includes('guardrail') ||
    text.includes('data policy') ||
    text.includes('permission denied')
  ) {
    return createNormalizedError(
      'PERMISSION_DENIED',
      `OpenRouter denied this request due to key permissions, privacy policy, or content guardrails${providerPrefix}.`,
      false,
      status ?? 403,
      rawDetails,
      meta.requestId
    )
  }

  // 5. Context Length Exceeded
  if (
    status === 413 ||
    text.includes('context_length_exceeded') ||
    text.includes('maximum context length') ||
    text.includes('context window') ||
    text.includes('prompt is too long') ||
    text.includes('request too large')
  ) {
    return createNormalizedError(
      'CONTEXT_LENGTH_EXCEEDED',
      'The prompt or retrieved context exceeds this OpenRouter model context length limit.',
      false,
      status,
      rawDetails,
      meta.requestId
    )
  }

  // 6. Rate Limited (429)
  if (status === 429 || text.includes('rate limit') || text.includes('too many requests')) {
    const retryNote = meta.retryAfterSeconds
      ? ` Retry after ${meta.retryAfterSeconds}s.`
      : ' Please wait briefly and try again.'
    return createNormalizedError(
      'RATE_LIMITED',
      `OpenRouter rate limit reached${providerPrefix}.${retryNote}`,
      true,
      429,
      rawDetails,
      meta.requestId
    )
  }

  // 7. Model / Endpoint Not Found (404)
  if (
    status === 404 ||
    text.includes('no endpoints found') ||
    text.includes('not a valid model id') ||
    (text.includes('model') && (text.includes('not found') || text.includes('does not exist')))
  ) {
    return createNormalizedError(
      'MODEL_NOT_FOUND',
      'The requested OpenRouter model or compatible routing endpoint was not found.',
      false,
      status ?? 404,
      rawDetails,
      meta.requestId
    )
  }

  // 8. Upstream Provider Errors / Unavailable (502 / 503 / 5xx)
  if (
    status === 502 ||
    status === 503 ||
    (status !== undefined && status >= 500) ||
    text.includes('provider returned error') ||
    text.includes('no available provider') ||
    text.includes('overloaded') ||
    text.includes('bad gateway')
  ) {
    return createNormalizedError(
      'SERVER_ERROR',
      `OpenRouter upstream provider error or service unavailability${providerPrefix}${status ? ` (HTTP ${status})` : ''}. Please try again shortly.`,
      true,
      status ?? 502,
      rawDetails,
      meta.requestId
    )
  }

  // 9. Bad / Invalid Request (400 / 422)
  if (
    status === 400 ||
    status === 422 ||
    text.includes('invalid') ||
    text.includes('unsupported parameter')
  ) {
    return createNormalizedError(
      'INVALID_REQUEST',
      'OpenRouter rejected the request due to invalid input or unsupported model parameters.',
      false,
      status ?? 400,
      rawDetails,
      meta.requestId
    )
  }

  return createNormalizedError(
    'UNKNOWN_ERROR',
    `An unexpected error occurred while communicating with OpenRouter${providerPrefix}.`,
    false,
    status,
    rawDetails,
    meta.requestId
  )
}
