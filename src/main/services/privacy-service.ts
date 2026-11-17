import fs from 'node:fs'
import path from 'node:path'
import {
  type LocalStorageInfoDto,
  type OpenStorageFolderResponse,
  type StorageTarget,
  STORAGE_TARGETS
} from '../../shared/privacy'
import type { CredentialVault } from '../security/credential-vault/credential-vault'

export class PrivacyServiceError extends Error {
  public readonly code: string

  constructor(message: string, code: string = 'PRIVACY_SERVICE_ERROR') {
    super(message)
    this.name = 'PrivacyServiceError'
    this.code = code
    Object.setPrototypeOf(this, PrivacyServiceError.prototype)
  }
}

export interface PrivacyServiceOptions {
  readonly userDataPath?: string
  readonly credentialVault?: CredentialVault
  readonly platform?: string
  readonly openPathFn?: (targetPath: string) => Promise<string>
}

/**
 * Service providing authoritative local storage path resolution, OS encryption state,
 * and safe, narrow folder-revealing operations in the Electron Main process.
 *
 * Security Invariants:
 * 1. Executes exclusively in the Main process.
 * 2. Only strictly allowlisted storage targets ('userData', 'documents', 'database') can be opened.
 * 3. Never accepts arbitrary paths from the Renderer.
 * 4. Resolves paths relative to the authoritative app.getPath('userData').
 */
export class PrivacyService {
  private readonly userDataPath: string
  private readonly credentialVault?: CredentialVault
  private readonly platform: string
  private readonly openPathFn: (targetPath: string) => Promise<string>

  constructor(options: PrivacyServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.credentialVault = options.credentialVault

    if (options.userDataPath) {
      this.userDataPath = path.resolve(options.userDataPath)
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          this.userDataPath = path.resolve(app.getPath('userData'))
        } else {
          this.userDataPath = path.resolve(process.cwd(), 'userData')
        }
      } catch {
        this.userDataPath = path.resolve(process.cwd(), 'userData')
      }
    }

    if (options.openPathFn) {
      this.openPathFn = options.openPathFn
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shell } = require('electron')
        this.openPathFn = (p: string) => shell.openPath(p)
      } catch {
        this.openPathFn = async () => ''
      }
    }
  }

  /**
   * Retrieves authoritative local storage paths, database file sizes, and OS encryption status.
   */
  public async getStorageInfo(): Promise<LocalStorageInfoDto> {
    const databaseDir = path.join(this.userDataPath, 'database')
    const databasePath = path.join(databaseDir, 'app.sqlite')
    const walPath = path.join(databaseDir, 'app.sqlite-wal')
    const documentsPath = path.join(this.userDataPath, 'documents')
    const credentialsPath = path.join(this.userDataPath, 'credentials')

    let databaseSizeBytes = 0
    let walSizeBytes = 0

    try {
      if (fs.existsSync(databasePath)) {
        databaseSizeBytes = fs.statSync(databasePath).size
      }
    } catch {
      // Keep 0
    }

    try {
      if (fs.existsSync(walPath)) {
        walSizeBytes = fs.statSync(walPath).size
      }
    } catch {
      // Keep 0
    }

    let encryptionAvailable: boolean
    let encryptionBackend: string | undefined

    if (this.credentialVault) {
      try {
        const check = await this.credentialVault.checkAvailability()
        encryptionAvailable = check.available
        encryptionBackend = check.backend
      } catch {
        encryptionAvailable = false
        encryptionBackend = 'unknown'
      }
    } else {
      // Fallback check based on platform defaults
      encryptionAvailable = this.platform === 'win32' || this.platform === 'darwin'
      encryptionBackend =
        this.platform === 'win32' ? 'dpapi' : this.platform === 'darwin' ? 'keychain' : 'unknown'
    }

    return {
      userDataPath: this.userDataPath,
      databasePath,
      documentsPath,
      credentialsPath,
      platform: this.platform,
      encryptionAvailable,
      encryptionBackend,
      databaseSizeBytes,
      walSizeBytes
    }
  }

  /**
   * Safely opens an allowlisted application storage folder in the OS file manager.
   * Rejects any arbitrary path or unlisted target.
   */
  public async openStorageFolder(target: StorageTarget): Promise<OpenStorageFolderResponse> {
    if (!STORAGE_TARGETS.includes(target)) {
      throw new PrivacyServiceError(
        `Invalid storage target: '${String(target)}'. Allowed targets: ${STORAGE_TARGETS.join(', ')}.`,
        'INVALID_STORAGE_TARGET'
      )
    }

    let folderPath: string
    switch (target) {
      case 'userData':
        folderPath = this.userDataPath
        break
      case 'documents':
        folderPath = path.join(this.userDataPath, 'documents')
        break
      case 'database':
        folderPath = path.join(this.userDataPath, 'database')
        break
      default:
        throw new PrivacyServiceError(
          `Unsupported storage target: '${String(target)}'.`,
          'INVALID_STORAGE_TARGET'
        )
    }

    const resolved = path.resolve(folderPath)
    const resolvedRoot = path.resolve(this.userDataPath)

    // Security guard: Ensure target is strictly inside or equal to userDataPath
    if (!resolved.startsWith(resolvedRoot)) {
      throw new PrivacyServiceError(
        'Path traversal detected: storage folder escapes application data directory.',
        'ACCESS_DENIED'
      )
    }

    // Ensure directory exists before opening
    try {
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true })
      }
    } catch (err: unknown) {
      throw new PrivacyServiceError(
        `Failed to create directory before opening: ${err instanceof Error ? err.message : String(err)}`,
        'FS_ERROR'
      )
    }

    const errMsg = await this.openPathFn(resolved)
    if (errMsg && typeof errMsg === 'string' && errMsg.trim().length > 0) {
      throw new PrivacyServiceError(
        `Failed to open folder in OS file manager: ${errMsg}`,
        'OPEN_FAILED'
      )
    }

    return {
      success: true,
      target
    }
  }
}
