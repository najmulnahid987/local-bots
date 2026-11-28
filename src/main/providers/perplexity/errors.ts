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
 * Redacts Perplexity API keys (`pplx-...`), other provider keys, Bearer tokens, and query secrets.
 */
export function redactPerplexitySecrets(message: string): string {
  if (!message || typeof message !== 'string') {
    return ''
  }

  return message
    .replace(
      /(pplx-|sk-or-v1-|sk-or-|gsk_|sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi,
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
    } else if (typeof obj.type === 'string' && obj.type.trim().length > 0) {
      errorCodes.push(obj.type.trim())
    }

    if (statusCode === undefined) {
      if (typeof obj.statusCode === 'number' && Number.isFinite(obj.statusCode)) {
        statusCode = obj.statusCode
      } else if (typeof obj.status === 'number' && Number.isFinite(obj.status)) {
        statusCode = obj.status
      }
    }

    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      messagesRaw.push(obj.message.trim())
      messagesLower.push(obj.message.trim().toLowerCase())
    }

    if (typeof obj.responseBody === 'string' && obj.responseBody.trim().length > 0) {
      try {
        visit(JSON.parse(obj.responseBody), depth + 1)
      } catch {
        messagesRaw.push(obj.responseBody.trim())
        messagesLower.push(obj.responseBody.trim().toLowerCase())
      }
    }

    if (obj.error !== undefined) {
      visit(obj.error, depth + 1)
    }
    if (obj.data !== undefined) {
      visit(obj.data, depth + 1)
    }
    if (obj.cause !== undefined) {
      visit(obj.cause, depth + 1)
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
    combinedTextLower: [...messagesLower, ...errorCodes.map((c) => c.toLowerCase())].join(' ')
  }
}

function createNormalizedError(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  statusCode?: number,
  details?: string
): ProviderError {
  const safeMessage = redactPerplexitySecrets(message) || 'Perplexity provider request failed.'
  const safeDetails = details ? redactPerplexitySecrets(details) : undefined

  try {
    defaultErrorRingBuffer.addError({
      code,
      category: 'provider',
      message: `Provider [perplexity]: ${safeMessage}`
    })
  } catch {
    // Non-fatal diagnostics failure
  }

  return {
    code,
    message: safeMessage,
    retryable,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(safeDetails ? { details: safeDetails } : {})
  }
}

/**
 * Classifies Perplexity Agent API and transport failures into normalized ProviderError DTOs,
 * ensuring Perplexity API keys (`pplx-...`) and sensitive payloads never escape into UI or logs.
 */
export function sanitizePerplexityError(
  err: unknown,
  statusCodeOverride?: number,
  requestIdOverride?: string
): ProviderError {
  const meta = collectErrorMetadata(err, statusCodeOverride)

  if (meta.adapterError) {
    return {
      ...meta.adapterError,
      message: redactPerplexitySecrets(meta.adapterError.message),
      ...(meta.adapterError.details
        ? { details: redactPerplexitySecrets(meta.adapterError.details) }
        : {})
    }
  }

  const statusCode = meta.statusCode
  const combined = meta.combinedTextLower
  const rawPrimary = meta.messagesRaw[0] ? redactPerplexitySecrets(meta.messagesRaw[0]) : undefined
  const detailText =
    requestIdOverride && rawPrimary
      ? `${rawPrimary} (requestId=${requestIdOverride})`
      : (rawPrimary ?? (requestIdOverride ? `requestId=${requestIdOverride}` : undefined))

  const isTimeout =
    meta.names.some((n) => n === 'TimeoutError') ||
    meta.errorCodes.some(
      (c) =>
        c === 'ETIMEDOUT' ||
        c === 'UND_ERR_HEADERS_TIMEOUT' ||
        c === 'UND_ERR_CONNECT_TIMEOUT' ||
        c === 'UND_ERR_BODY_TIMEOUT'
    ) ||
    combined.includes('timed out') ||
    combined.includes('timeout')

  if (isTimeout) {
    return createNormalizedError(
      'TIMEOUT',
      'Perplexity API request timed out. Please verify network stability or try again.',
      true,
      statusCode,
      detailText
    )
  }

  const isAbort =
    meta.names.some((n) => n === 'AbortError') ||
    meta.errorCodes.some((c) => c === 'ABORT_ERR' || c === 'OPERATION_ABORTED') ||
    combined.includes('aborted') ||
    combined.includes('cancelled') ||
    combined.includes('canceled')

  if (isAbort) {
    return createNormalizedError(
      'OPERATION_ABORTED',
      'Perplexity request was cancelled.',
      false,
      statusCode,
      detailText
    )
  }

  const isNetwork =
    meta.errorCodes.some((c) =>
      ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(
        c.toUpperCase()
      )
    ) ||
    combined.includes('fetch failed') ||
    combined.includes('networkerror') ||
    combined.includes('enotfound') ||
    combined.includes('econnrefused')

  if (isNetwork) {
    return createNormalizedError(
      'NETWORK_ERROR',
      'Network connectivity error reaching api.perplexity.ai. Check internet connection.',
      true,
      statusCode,
      detailText
    )
  }

  if (
    statusCode === 401 ||
    combined.includes('unauthorized') ||
    combined.includes('invalid api key') ||
    combined.includes('authentication')
  ) {
    return createNormalizedError(
      'AUTHENTICATION_FAILED',
      'Perplexity authentication failed (HTTP 401). Verify your Perplexity API key (pplx-...).',
      false,
      statusCode ?? 401,
      detailText
    )
  }

  if (
    statusCode === 403 ||
    combined.includes('forbidden') ||
    combined.includes('insufficient quota') ||
    combined.includes('insufficient credits') ||
    combined.includes('credit balance')
  ) {
    return createNormalizedError(
      'PERMISSION_DENIED',
      'Perplexity API key lacks permission or active credit balance for the requested Agent API model.',
      false,
      statusCode ?? 403,
      detailText
    )
  }

  if (
    statusCode === 429 ||
    combined.includes('rate limit') ||
    combined.includes('too many requests')
  ) {
    if (combined.includes('quota exceeded') || combined.includes('insufficient_quota')) {
      return createNormalizedError(
        'QUOTA_EXCEEDED',
        'Perplexity account quota or spend limit exceeded. Check your Perplexity API billing.',
        false,
        429,
        detailText
      )
    }

    return createNormalizedError(
      'RATE_LIMITED',
      'Perplexity rate limit exceeded (HTTP 429). Please retry after a short pause.',
      true,
      429,
      detailText
    )
  }

  if (
    statusCode === 413 ||
    combined.includes('context length') ||
    combined.includes('maximum context') ||
    combined.includes('too many tokens')
  ) {
    return createNormalizedError(
      'CONTEXT_LENGTH_EXCEEDED',
      `Prompt or output length exceeds the selected Perplexity model limits: ${rawPrimary ?? 'limit exceeded'}`,
      false,
      statusCode ?? 413,
      detailText
    )
  }

  if (
    statusCode === 404 ||
    combined.includes('model not found') ||
    combined.includes('unknown model') ||
    combined.includes('invalid model')
  ) {
    return createNormalizedError(
      'MODEL_NOT_FOUND',
      `Requested Perplexity Agent API model or preset is unavailable: ${rawPrimary ?? 'unknown model'}`,
      false,
      statusCode ?? 404,
      detailText
    )
  }

  if (statusCode === 400 || statusCode === 422) {
    return createNormalizedError(
      'INVALID_REQUEST',
      `Perplexity rejected the request parameters (HTTP ${statusCode}): ${rawPrimary ?? 'invalid request'}`,
      false,
      statusCode,
      detailText
    )
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return createNormalizedError(
      'SERVER_ERROR',
      `Perplexity API service unavailable (HTTP ${statusCode}). Please try again shortly.`,
      true,
      statusCode,
      detailText
    )
  }

  const fallbackCode: ProviderErrorCode =
    statusCode && statusCode >= 400 && statusCode < 500 ? 'INVALID_REQUEST' : 'UNKNOWN_ERROR'
  return createNormalizedError(
    fallbackCode,
    rawPrimary || 'Unexpected Perplexity provider error.',
    false,
    statusCode,
    detailText
  )
}
