import type { ISafeStorageAdapter, LinuxStorageBackend, SafeStorageDecryptionResult } from './types'

/**
 * Default production adapter delegating to Electron's native safeStorage module.
 * Safely guards against invocation in non-Electron environments.
 */
export class DefaultSafeStorageAdapter implements ISafeStorageAdapter {
  private getNativeSafeStorage(): typeof import('electron').safeStorage | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron')
      if (electron && typeof electron === 'object' && 'safeStorage' in electron) {
        return electron.safeStorage
      }
      return undefined
    } catch {
      return undefined
    }
  }

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    const safeStorage = this.getNativeSafeStorage()
    if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function') {
      return false
    }
    return safeStorage.isAsyncEncryptionAvailable()
  }

  public isEncryptionAvailable(): boolean {
    const safeStorage = this.getNativeSafeStorage()
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
      return false
    }
    return safeStorage.isEncryptionAvailable()
  }

  public async encryptStringAsync(plainText: string): Promise<Buffer> {
    const safeStorage = this.getNativeSafeStorage()
    if (!safeStorage || typeof safeStorage.encryptStringAsync !== 'function') {
      throw new Error('Electron safeStorage.encryptStringAsync is unavailable')
    }
    return safeStorage.encryptStringAsync(plainText)
  }

  public async decryptStringAsync(encrypted: Buffer): Promise<SafeStorageDecryptionResult> {
    const safeStorage = this.getNativeSafeStorage()
    if (!safeStorage || typeof safeStorage.decryptStringAsync !== 'function') {
      throw new Error('Electron safeStorage.decryptStringAsync is unavailable')
    }
    return safeStorage.decryptStringAsync(encrypted)
  }

  public getSelectedStorageBackend(): LinuxStorageBackend {
    const safeStorage = this.getNativeSafeStorage()
    if (!safeStorage || typeof safeStorage.getSelectedStorageBackend !== 'function') {
      return 'unknown'
    }
    return safeStorage.getSelectedStorageBackend() as LinuxStorageBackend
  }
}
