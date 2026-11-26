/**
 * Error classifications emitted by ProviderManagerService.
 */
export type ProviderManagerErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_STATUS_ERROR'
  | 'CONNECTION_REVOKED'
  | 'INVALID_PROVIDER_ID'
  | 'MODEL_NOT_FOUND'
  | 'CROSS_PROVIDER_MODEL_MISMATCH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'VALIDATION_ERROR'
  | 'CREDENTIAL_STORAGE_FAILURE'
  | 'CREDENTIAL_CLEANUP_FAILURE'
  | 'RECONCILIATION_FAILURE'
  | 'OPERATION_LOCKED'

/**
 * Sanitized application error thrown by ProviderManagerService.
 * Guarantees zero leakage of plaintext API keys, tokens, or credential_ref pointers.
 */
export class ProviderManagerError extends Error {
  readonly code: ProviderManagerErrorCode
  readonly details?: unknown

  constructor(message: string, code: ProviderManagerErrorCode, details?: unknown) {
    const sanitizedMsg = sanitizeErrorMessage(message)
    super(sanitizedMsg)
    this.name = 'ProviderManagerError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, ProviderManagerError.prototype)
  }
}

/**
 * Strips raw secrets, tokens, credential references, or filesystem paths from an error string.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during provider manager operation.'
  }

  return message
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:x-api-key|x-goog-api-key)\s*:\s*)[^\s,;'"\r\n]+/gi, '$1[REDACTED_SECRET]')
    .replace(
      /([?&](?:api_?key|key|token|access_token|secret|auth)=)[^&\s"'<>]+/gi,
      '$1[REDACTED_SECRET]'
    )
}
