/**
 * Types, interfaces, error definitions, and constants for the secure CredentialVault.
 * Main-process only: never expose raw keys, decrypted secrets, or vault handles to Renderer.
 */

/**
 * Opaque credential reference format: cred_<uuidv4>
 * Example: cred_550e8400-e29b-41d4-a716-446655440000
 */
export type CredentialRef = string & { readonly __brand: unique symbol }

export const CREDENTIAL_REF_REGEX =
  /^cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CREDENTIAL_REF_PREFIX = 'cred_'
export const CREDENTIAL_FILE_EXTENSION = '.enc'
export const TEMP_FILE_PREFIX = '.tmp_'

/**
 * Validates whether a value conforms to the opaque CredentialRef format.
 * Strictly prevents path traversal and arbitrary filesystem references.
 */
export function isValidCredentialRef(ref: unknown): ref is CredentialRef {
  return typeof ref === 'string' && CREDENTIAL_REF_REGEX.test(ref)
}

/**
 * Supported storage backends reported by Electron on Linux systems.
 */
export type LinuxStorageBackend =
  'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'

/**
 * Detailed platform encryption availability status.
 */
export interface EncryptionAvailabilityResult {
  readonly available: boolean
  readonly platform: NodeJS.Platform
  readonly backend?: LinuxStorageBackend
  readonly reason?:
    | 'ASYNC_ENCRYPTION_UNAVAILABLE'
    | 'SYNC_ENCRYPTION_UNAVAILABLE'
    | 'LINUX_WEAK_BACKEND_REJECTED'
    | 'ENCRYPTION_INITIALIZATION_FAILED'
}

/**
 * Decryption result returned by asynchronous safeStorage.
 */
export interface SafeStorageDecryptionResult {
  readonly shouldReEncrypt: boolean
  readonly result: string
}

/**
 * Abstraction layer for Electron safeStorage operations.
 * Allows dependency injection for automated testing and runtime decoupling.
 */
export interface ISafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>
  isEncryptionAvailable?(): boolean
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<SafeStorageDecryptionResult>
  getSelectedStorageBackend?(): LinuxStorageBackend
}

/**
 * Configuration options for initializing the CredentialVault.
 */
export interface CredentialVaultOptions {
  vaultDir?: string
  userDataPath?: string
  safeStorage?: ISafeStorageAdapter
  platform?: NodeJS.Platform
}

/**
 * Standard error codes emitted by CredentialVault.
 */
export type CredentialVaultErrorCode =
  | 'ENCRYPTION_UNAVAILABLE'
  | 'LINUX_WEAK_BACKEND_REJECTED'
  | 'INVALID_CREDENTIAL_REF'
  | 'INVALID_CREDENTIAL_INPUT'
  | 'CREDENTIAL_NOT_FOUND'
  | 'ENCRYPTION_FAILURE'
  | 'DECRYPTION_FAILURE'
  | 'CORRUPTED_CREDENTIAL_FILE'
  | 'FILESYSTEM_WRITE_FAILURE'
  | 'FILESYSTEM_REPLACEMENT_FAILURE'
  | 'CONCURRENT_OPERATION_CONFLICT'

/**
 * Base sanitized error for all credential vault exceptions.
 * Guarantees zero leakage of plaintext keys, ciphertext buffers, or provider tokens.
 */
export class CredentialVaultError extends Error {
  public readonly code: CredentialVaultErrorCode

  constructor(message: string, code: CredentialVaultErrorCode) {
    super(message)
    this.name = 'CredentialVaultError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class EncryptionUnavailableError extends CredentialVaultError {
  constructor(message = 'Encryption is not available on this platform/environment') {
    super(message, 'ENCRYPTION_UNAVAILABLE')
    this.name = 'EncryptionUnavailableError'
  }
}

export class LinuxWeakBackendRejectedError extends CredentialVaultError {
  constructor(
    message = 'Linux basic_text storage backend was detected and rejected. Secure OS keyring required.'
  ) {
    super(message, 'LINUX_WEAK_BACKEND_REJECTED')
    this.name = 'LinuxWeakBackendRejectedError'
  }
}

export class InvalidCredentialRefError extends CredentialVaultError {
  constructor(message = 'Invalid credential reference format') {
    super(message, 'INVALID_CREDENTIAL_REF')
    this.name = 'InvalidCredentialRefError'
  }
}

export class CredentialNotFoundError extends CredentialVaultError {
  constructor(message = 'Credential not found') {
    super(message, 'CREDENTIAL_NOT_FOUND')
    this.name = 'CredentialNotFoundError'
  }
}

export class EncryptionFailureError extends CredentialVaultError {
  constructor(message = 'Failed to encrypt credential') {
    super(message, 'ENCRYPTION_FAILURE')
    this.name = 'EncryptionFailureError'
  }
}

export class DecryptionFailureError extends CredentialVaultError {
  constructor(message = 'Failed to decrypt credential') {
    super(message, 'DECRYPTION_FAILURE')
    this.name = 'DecryptionFailureError'
  }
}

export class CorruptedCredentialFileError extends CredentialVaultError {
  constructor(message = 'Credential file is corrupted or empty') {
    super(message, 'CORRUPTED_CREDENTIAL_FILE')
    this.name = 'CorruptedCredentialFileError'
  }
}

export class FilesystemWriteError extends CredentialVaultError {
  constructor(message = 'Failed to write credential file') {
    super(message, 'FILESYSTEM_WRITE_FAILURE')
    this.name = 'FilesystemWriteError'
  }
}

export class FilesystemReplacementError extends CredentialVaultError {
  constructor(message = 'Failed to replace credential file') {
    super(message, 'FILESYSTEM_REPLACEMENT_FAILURE')
    this.name = 'FilesystemReplacementError'
  }
}

export class ConcurrentOperationConflictError extends CredentialVaultError {
  constructor(message = 'Concurrent operation conflict for credential reference') {
    super(message, 'CONCURRENT_OPERATION_CONFLICT')
    this.name = 'ConcurrentOperationConflictError'
  }
}
