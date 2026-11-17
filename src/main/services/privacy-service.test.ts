import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PrivacyService, PrivacyServiceError } from './privacy-service'
import type { CredentialVault } from '../security/credential-vault/credential-vault'

describe('PrivacyService (Step 9.9)', () => {
  let tempDir: string
  let mockVault: Partial<CredentialVault>
  let mockOpenPath: ((targetPath: string) => Promise<string>) & ReturnType<typeof vi.fn>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyaro-privacy-test-'))
    fs.mkdirSync(path.join(tempDir, 'database'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'documents'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'credentials'), { recursive: true })

    // Seed dummy database file
    fs.writeFileSync(path.join(tempDir, 'database', 'app.sqlite'), 'dummy database content')

    mockVault = {
      checkAvailability: vi.fn().mockResolvedValue({
        available: true,
        platform: 'win32',
        backend: 'dpapi'
      })
    }

    mockOpenPath = vi.fn(async (): Promise<string> => '')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('1. returns authoritative storage paths, file sizes, and encryption info', async () => {
    const service = new PrivacyService({
      userDataPath: tempDir,
      credentialVault: mockVault as CredentialVault,
      platform: 'win32',
      openPathFn: mockOpenPath
    })

    const info = await service.getStorageInfo()

    expect(info.userDataPath).toBe(tempDir)
    expect(info.databasePath).toBe(path.join(tempDir, 'database', 'app.sqlite'))
    expect(info.documentsPath).toBe(path.join(tempDir, 'documents'))
    expect(info.credentialsPath).toBe(path.join(tempDir, 'credentials'))
    expect(info.platform).toBe('win32')
    expect(info.encryptionAvailable).toBe(true)
    expect(info.encryptionBackend).toBe('dpapi')
    expect(info.databaseSizeBytes).toBeGreaterThan(0)
    expect(info.walSizeBytes).toBe(0)
  })

  it('2. successfully opens allowlisted storage folders', async () => {
    const service = new PrivacyService({
      userDataPath: tempDir,
      credentialVault: mockVault as CredentialVault,
      platform: 'win32',
      openPathFn: mockOpenPath
    })

    const resUser = await service.openStorageFolder('userData')
    expect(resUser.success).toBe(true)
    expect(mockOpenPath).toHaveBeenCalledWith(tempDir)

    const resDocs = await service.openStorageFolder('documents')
    expect(resDocs.success).toBe(true)
    expect(mockOpenPath).toHaveBeenCalledWith(path.join(tempDir, 'documents'))

    const resDb = await service.openStorageFolder('database')
    expect(resDb.success).toBe(true)
    expect(mockOpenPath).toHaveBeenCalledWith(path.join(tempDir, 'database'))
  })

  it('3. rejects invalid or unlisted storage targets', async () => {
    const service = new PrivacyService({
      userDataPath: tempDir,
      credentialVault: mockVault as CredentialVault,
      platform: 'win32',
      openPathFn: mockOpenPath
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(service.openStorageFolder('credentials' as any)).rejects.toThrow(
      PrivacyServiceError
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(service.openStorageFolder('../../etc' as any)).rejects.toThrow(PrivacyServiceError)
  })

  it('4. throws when openPath returns an error message', async () => {
    const failingOpenPath = vi.fn().mockResolvedValue('OS access denied')
    const service = new PrivacyService({
      userDataPath: tempDir,
      credentialVault: mockVault as CredentialVault,
      platform: 'win32',
      openPathFn: failingOpenPath
    })

    await expect(service.openStorageFolder('documents')).rejects.toThrow(
      'Failed to open folder in OS file manager: OS access denied'
    )
  })
})
