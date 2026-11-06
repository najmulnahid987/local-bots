import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  type CredentialRef,
  type CredentialVaultOptions,
  type EncryptionAvailabilityResult,
  type ISafeStorageAdapter,
  type SafeStorageDecryptionResult,
  CREDENTIAL_FILE_EXTENSION,
  TEMP_FILE_PREFIX,
  isValidCredentialRef,
  CredentialVaultError,
  EncryptionUnavailableError,
  LinuxWeakBackendRejectedError,
  InvalidCredentialRefError,
  CredentialNotFoundError,
  EncryptionFailureError,
  DecryptionFailureError,
  CorruptedCredentialFileError,
  FilesystemWriteError,
  FilesystemReplacementError,
  ConcurrentOperationConflictError
} from './types'
import { DefaultSafeStorageAdapter } from './adapter'

/**
 * Main-process service providing secure, hardware-backed credential vault storage.
 *
 * Invariants:
 * 1. Exclusively executed in the Electron Main process.
 * 2. Plaintext credentials are never written to disk, SQLite, or exposed across IPC.
 * 3. File storage uses opaque, unpredictable references (cred_<uuidv4>).
 * 4. Writes are atomic (exclusive temporary file creation + flush + atomic rename).
 * 5. Weak Linux backends (basic_text) are rejected.
 */
export class CredentialVault {
  private readonly vaultDir: string
  private readonly safeStorage: ISafeStorageAdapter
  private readonly platform: NodeJS.Platform
  private readonly activeMutationLocks = new Set<string>()

  constructor(options?: CredentialVaultOptions) {
    this.platform = options?.platform ?? process.platform
    this.safeStorage = options?.safeStorage ?? new DefaultSafeStorageAdapter()

    if (options?.vaultDir) {
      this.vaultDir = path.resolve(options.vaultDir)
    } else if (options?.userDataPath) {
      this.vaultDir = path.resolve(options.userDataPath, 'credentials')
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          this.vaultDir = path.resolve(app.getPath('userData'), 'credentials')
        } else {
          this.vaultDir = path.resolve(process.cwd(), 'credentials')
        }
      } catch {
        this.vaultDir = path.resolve(process.cwd(), 'credentials')
      }
    }
  }

  /**
   * Returns the absolute path of the local credential vault directory.
   */
  public getVaultDirectory(): string {
    return this.vaultDir
  }

  /**
   * Verifies operating-system encryption availability and evaluates platform-specific backends.
   * On Linux: strictly rejects `basic_text` obfuscation.
   */
  public async checkAvailability(): Promise<EncryptionAvailabilityResult> {
    const platform = this.platform

    try {
      const isAsyncAvailable = await this.safeStorage.isAsyncEncryptionAvailable()

      if (platform === 'linux') {
        const backend = this.safeStorage.getSelectedStorageBackend
          ? this.safeStorage.getSelectedStorageBackend()
          : 'unknown'

        if (backend === 'basic_text') {
          return {
            available: false,
            platform: 'linux',
            backend: 'basic_text',
            reason: 'LINUX_WEAK_BACKEND_REJECTED'
          }
        }

        if (!isAsyncAvailable) {
          return {
            available: false,
            platform: 'linux',
            backend,
            reason: 'ASYNC_ENCRYPTION_UNAVAILABLE'
          }
        }

        return {
          available: true,
          platform: 'linux',
          backend
        }
      }

      // Windows and macOS
      if (!isAsyncAvailable) {
        return {
          available: false,
          platform,
          reason: 'ASYNC_ENCRYPTION_UNAVAILABLE'
        }
      }

      return {
        available: true,
        platform
      }
    } catch {
      return {
        available: false,
        platform,
        reason: 'ENCRYPTION_INITIALIZATION_FAILED'
      }
    }
  }

  /**
   * Stores an API credential in the encrypted vault.
   * Generates an opaque reference, encrypts ciphertext, writes via atomic temp file, and flushes to disk.
   */
  public async store(credential: string): Promise<CredentialRef> {
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new CredentialVaultError('Credential cannot be empty', 'INVALID_CREDENTIAL_INPUT')
    }

    const availability = await this.checkAvailability()
    if (!availability.available) {
      if (availability.reason === 'LINUX_WEAK_BACKEND_REJECTED') {
        throw new LinuxWeakBackendRejectedError(
          'Linux basic_text storage backend was detected and rejected. Secure OS keyring required.'
        )
      }
      throw new EncryptionUnavailableError(
        `Encryption is unavailable on this system: ${availability.reason ?? 'UNKNOWN'}`
      )
    }

    await this.ensureVaultDir()

    const credentialRef = `cred_${randomUUID()}` as CredentialRef
    const finalPath = this.getCredentialFilePath(credentialRef)

    // Verify file does not already exist
    try {
      await fs.promises.access(finalPath)
      throw new FilesystemWriteError(`Target credential file already exists: ${credentialRef}`)
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code !== 'ENOENT') {
        throw err
      }
    }

    // Encrypt in memory
    let encryptedBuffer: Buffer
    try {
      encryptedBuffer = await this.safeStorage.encryptStringAsync(credential)
    } catch {
      throw new EncryptionFailureError('Failed to encrypt credential with safeStorage')
    }

    // Atomic write protocol:
    // POSIX (Linux/macOS): mode 0o600 restricts read/write permissions to owner.
    // Windows (NTFS): mode affects only read-only attribute; user data directory DACLs protect file.
    const tempFileName = `${TEMP_FILE_PREFIX}${credentialRef}_${randomUUID()}.tmp`
    const tempFilePath = path.join(this.vaultDir, tempFileName)
    let fileHandle: fs.promises.FileHandle | null = null

    try {
      fileHandle = await fs.promises.open(tempFilePath, 'wx', 0o600)
      await fileHandle.write(encryptedBuffer)
      if (typeof fileHandle.sync === 'function') {
        await fileHandle.sync()
      }
      await fileHandle.close()
      fileHandle = null

      await fs.promises.rename(tempFilePath, finalPath)
    } catch (err: unknown) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {})
      }
      await fs.promises.unlink(tempFilePath).catch(() => {})
      if (err instanceof CredentialVaultError) {
        throw err
      }
      const message = err instanceof Error ? err.message : 'Unknown write failure'
      throw new FilesystemWriteError(`Failed to persist credential file: ${message}`)
    }

    return credentialRef
  }

  /**
   * Retrieves and decrypts the credential referenced by credentialRef.
   * Returns plaintext only to the calling Main-process service.
   * Handles automatic key rotation when shouldReEncrypt is flagged.
   */
  public async retrieve(credentialRef: string): Promise<string> {
    this.assertValidCredentialRef(credentialRef)

    if (this.activeMutationLocks.has(credentialRef)) {
      throw new ConcurrentOperationConflictError(
        `Concurrent operation conflict for credential reference: ${credentialRef}`
      )
    }

    const finalPath = this.getCredentialFilePath(credentialRef)

    let encryptedBuffer: Buffer
    try {
      encryptedBuffer = await fs.promises.readFile(finalPath)
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        throw new CredentialNotFoundError(`Credential not found: ${credentialRef}`)
      }
      const message = err instanceof Error ? err.message : 'Unknown read failure'
      throw new FilesystemWriteError(`Failed to read credential file: ${message}`)
    }

    if (encryptedBuffer.length === 0) {
      throw new CorruptedCredentialFileError(
        `Credential file is empty or corrupted: ${credentialRef}`
      )
    }

    let decryptResult: SafeStorageDecryptionResult
    try {
      decryptResult = await this.safeStorage.decryptStringAsync(encryptedBuffer)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown decryption failure'
      throw new DecryptionFailureError(`Failed to decrypt credential file: ${message}`)
    }

    // Handle shouldReEncrypt rotation
    if (decryptResult.shouldReEncrypt) {
      try {
        await this.withMutationLock(credentialRef, async () => {
          const newEncrypted = await this.safeStorage.encryptStringAsync(decryptResult.result)
          const tempFileName = `${TEMP_FILE_PREFIX}${credentialRef}_${randomUUID()}.tmp`
          const tempFilePath = path.join(this.vaultDir, tempFileName)
          let fileHandle: fs.promises.FileHandle | null = null

          try {
            fileHandle = await fs.promises.open(tempFilePath, 'wx', 0o600)
            await fileHandle.write(newEncrypted)
            if (typeof fileHandle.sync === 'function') {
              await fileHandle.sync()
            }
            await fileHandle.close()
            fileHandle = null

            await fs.promises.rename(tempFilePath, finalPath)
          } catch {
            if (fileHandle) {
              await fileHandle.close().catch(() => {})
            }
            await fs.promises.unlink(tempFilePath).catch(() => {})
            // Preserve existing file on rotation failure; do not log or fail retrieval
          }
        })
      } catch {
        // If mutation lock was contested, skip rotation and return decrypted plaintext
      }
    }

    return decryptResult.result
  }

  /**
   * Replaces an existing encrypted credential with a new secret value.
   * Encrypts and writes the new file atomically before overwriting, guaranteeing that
   * the original credential remains intact if encryption or writing fails.
   */
  public async replace(credentialRef: string, newCredential: string): Promise<void> {
    this.assertValidCredentialRef(credentialRef)

    if (typeof newCredential !== 'string' || newCredential.length === 0) {
      throw new CredentialVaultError('Credential cannot be empty', 'INVALID_CREDENTIAL_INPUT')
    }

    const availability = await this.checkAvailability()
    if (!availability.available) {
      if (availability.reason === 'LINUX_WEAK_BACKEND_REJECTED') {
        throw new LinuxWeakBackendRejectedError(
          'Linux basic_text storage backend was detected and rejected. Secure OS keyring required.'
        )
      }
      throw new EncryptionUnavailableError(
        `Encryption is unavailable on this system: ${availability.reason ?? 'UNKNOWN'}`
      )
    }

    return this.withMutationLock(credentialRef, async () => {
      const finalPath = this.getCredentialFilePath(credentialRef)

      try {
        await fs.promises.access(finalPath)
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code === 'ENOENT') {
          throw new CredentialNotFoundError(
            `Credential not found for replacement: ${credentialRef}`
          )
        }
        throw err
      }

      // Encrypt new credential first; if encryption fails, existing file is untouched
      let encryptedBuffer: Buffer
      try {
        encryptedBuffer = await this.safeStorage.encryptStringAsync(newCredential)
      } catch {
        throw new EncryptionFailureError('Failed to encrypt replacement credential')
      }

      const tempFileName = `${TEMP_FILE_PREFIX}${credentialRef}_${randomUUID()}.tmp`
      const tempFilePath = path.join(this.vaultDir, tempFileName)
      let fileHandle: fs.promises.FileHandle | null = null

      try {
        fileHandle = await fs.promises.open(tempFilePath, 'wx', 0o600)
        await fileHandle.write(encryptedBuffer)
        if (typeof fileHandle.sync === 'function') {
          await fileHandle.sync()
        }
        await fileHandle.close()
        fileHandle = null

        await fs.promises.rename(tempFilePath, finalPath)
      } catch (err: unknown) {
        if (fileHandle) {
          await fileHandle.close().catch(() => {})
        }
        await fs.promises.unlink(tempFilePath).catch(() => {})
        if (err instanceof CredentialVaultError) {
          throw err
        }
        const message = err instanceof Error ? err.message : 'Unknown replacement failure'
        throw new FilesystemReplacementError(`Failed to replace credential file: ${message}`)
      }
    })
  }

  /**
   * Deletes a single credential file referenced by credentialRef.
   * Validates format, deletes strictly the target file, and guards against directory deletion.
   */
  public async delete(credentialRef: string): Promise<void> {
    this.assertValidCredentialRef(credentialRef)

    return this.withMutationLock(credentialRef, async () => {
      const finalPath = this.getCredentialFilePath(credentialRef)

      try {
        await fs.promises.access(finalPath)
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code === 'ENOENT') {
          throw new CredentialNotFoundError(`Credential not found for deletion: ${credentialRef}`)
        }
        throw err
      }

      try {
        await fs.promises.unlink(finalPath)
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code === 'ENOENT') {
          throw new CredentialNotFoundError(`Credential not found for deletion: ${credentialRef}`)
        }
        const message = err instanceof Error ? err.message : 'Unknown deletion failure'
        throw new FilesystemWriteError(`Failed to delete credential file: ${message}`)
      }
    })
  }

  /**
   * Canonical path resolution and boundary verification.
   * Hard-blocks path traversal, absolute injection, and null byte exploits.
   */
  private getCredentialFilePath(credentialRef: string): string {
    this.assertValidCredentialRef(credentialRef)
    const filePath = path.join(this.vaultDir, `${credentialRef}${CREDENTIAL_FILE_EXTENSION}`)
    const resolvedPath = path.resolve(filePath)
    const resolvedVaultDir = path.resolve(this.vaultDir)

    if (!resolvedPath.startsWith(resolvedVaultDir + path.sep)) {
      throw new InvalidCredentialRefError(
        `Invalid credential reference (path traversal detected): ${credentialRef}`
      )
    }

    return filePath
  }

  /**
   * Asserts that a credential reference matches the strict cred_<uuidv4> format.
   */
  private assertValidCredentialRef(credentialRef: unknown): asserts credentialRef is CredentialRef {
    if (!isValidCredentialRef(credentialRef)) {
      throw new InvalidCredentialRefError(
        `Invalid credential reference format: ${typeof credentialRef === 'string' ? credentialRef : 'non-string'}`
      )
    }
  }

  /**
   * Ensures the vault storage directory exists with owner-only access permissions.
   */
  private async ensureVaultDir(): Promise<void> {
    await fs.promises.mkdir(this.vaultDir, { recursive: true, mode: 0o700 })
  }

  /**
   * Concurrency lock runner for mutation operations on a specific credential reference.
   * Protects against race conditions between concurrent replacements, deletions, and reads.
   */
  private async withMutationLock<T>(credentialRef: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeMutationLocks.has(credentialRef)) {
      throw new ConcurrentOperationConflictError(
        `Concurrent operation conflict for credential reference: ${credentialRef}`
      )
    }
    this.activeMutationLocks.add(credentialRef)
    try {
      return await fn()
    } finally {
      this.activeMutationLocks.delete(credentialRef)
    }
  }
}
