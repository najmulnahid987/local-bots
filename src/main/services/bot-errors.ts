import { type ProviderManagerErrorCode } from '../providers/provider-manager/errors'

export type BotManagerErrorCode =
  | 'NO_ACTIVE_WORKSPACE'
  | 'KB_NOT_FOUND'
  | 'ARCHIVED_WORKSPACE'
  | 'NOT_FOUND'
  | 'BOT_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'LIFECYCLE_ERROR'
  | 'INTERNAL_ERROR'
  | ProviderManagerErrorCode

/**
 * Strips raw filesystem paths, secrets, API keys, or internal references from error strings.
 */
export function sanitizeBotErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during Bot operation.'
  }
  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

/**
 * Base application error for BotManagerService operations.
 */
export class BotManagerError extends Error {
  readonly code: BotManagerErrorCode
  readonly details?: unknown

  constructor(message: string, code: BotManagerErrorCode = 'INTERNAL_ERROR', details?: unknown) {
    const sanitizedMsg = sanitizeBotErrorMessage(message)
    super(sanitizedMsg)
    this.name = 'BotManagerError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, BotManagerError.prototype)
  }
}

export class NoActiveWorkspaceError extends BotManagerError {
  constructor(message = 'No active Knowledge Base workspace found for this session.') {
    super(message, 'NO_ACTIVE_WORKSPACE')
    this.name = 'NoActiveWorkspaceError'
    Object.setPrototypeOf(this, NoActiveWorkspaceError.prototype)
  }
}

export class BotNotFoundError extends BotManagerError {
  constructor(message = 'Bot not found in active Knowledge Base.') {
    super(message, 'NOT_FOUND')
    this.name = 'BotNotFoundError'
    Object.setPrototypeOf(this, BotNotFoundError.prototype)
  }
}

export class BotValidationError extends BotManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details)
    this.name = 'BotValidationError'
    Object.setPrototypeOf(this, BotValidationError.prototype)
  }
}

export class BotLifecycleError extends BotManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'LIFECYCLE_ERROR', details)
    this.name = 'BotLifecycleError'
    Object.setPrototypeOf(this, BotLifecycleError.prototype)
  }
}
