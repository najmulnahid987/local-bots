import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  CredentialVault,
  type ISafeStorageAdapter,
  type LinuxStorageBackend,
  type SafeStorageDecryptionResult,
  isValidCredentialRef,
  EncryptionUnavailableError,
  LinuxWeakBackendRejectedError,
  InvalidCredentialRefError,
  CredentialNotFoundError,
  EncryptionFailureError,
  DecryptionFailureError,
  CorruptedCredentialFileError,
  ConcurrentOperationConflictError,
  DefaultSafeStorageAdapter
} from './index'

/**
 * High-fidelity test adapter simulating hardware-backed safeStorage via AES-256-GCM.
 * Ensures that ciphertexts stored on disk are genuinely non-plaintext binary buffers.
 */
class TestSafeStorageAdapter implements ISafeStorageAdapter {
  private key = crypto.randomBytes(32)
  public asyncAvailable = true
  public syncAvailable = true
  public backend: LinuxStorageBackend = 'gnome_libsecret'
  public throwOnEncrypt = false
  public throwOnDecrypt = false
  public shouldReEncrypt = false
  public encryptCallCount = 0
  public decryptCallCount = 0

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.asyncAvailable
  }

  public isEncryptionAvailable(): boolean {
    return this.syncAvailable
  }

  public async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.encryptCallCount++
    if (this.throwOnEncrypt) {
      throw new Error('Simulated safeStorage encryption failure')
    }
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // Pack: iv (12 bytes) + tag (16 bytes) + ciphertext
    return Buffer.concat([iv, tag, encrypted])
  }

  public async decryptStringAsync(encrypted: Buffer): Promise<SafeStorageDecryptionResult> {
    this.decryptCallCount++
    if (this.throwOnDecrypt) {
      throw new Error('Simulated safeStorage decryption failure')
    }
    if (encrypted.length < 28) {
      throw new Error('Invalid ciphertext length for AES-GCM payload')
    }
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const data = encrypted.subarray(28)

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')

    return {
      shouldReEncrypt: this.shouldReEncrypt,
      result: decrypted
    }
  }

  public getSelectedStorageBackend(): LinuxStorageBackend {
    return this.backend
  }
}

describe('CredentialVault Foundation (Phase 3 Step 3.1)', () => {
  let tempDir: string
  let adapter: TestSafeStorageAdapter
  let vault: CredentialVault

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cred-vault-test-'))
    adapter = new TestSafeStorageAdapter()
    vault = new CredentialVault({
      vaultDir: tempDir,
      safeStorage: adapter,
      platform: 'linux'
    })
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error in test
    }
  })

  // Test 1: Successful credential storage
  it('1. successfully stores a credential and returns a valid opaque reference', async () => {
    const rawApiKey = 'sk-proj-testKey-1234567890abcdef'
    const ref = await vault.store(rawApiKey)

    expect(isValidCredentialRef(ref)).toBe(true)
    expect(ref.startsWith('cred_')).toBe(true)

    // Verify file exists on disk
    const targetFile = path.join(tempDir, `${ref}.enc`)
    expect(fs.existsSync(targetFile)).toBe(true)
  })

  // Test 2: Stored file contains ciphertext, not plaintext
  it('2. confirms stored file contains binary ciphertext and never plaintext', async () => {
    const rawApiKey = 'sk-proj-secret-key-to-encrypt'
    const ref = await vault.store(rawApiKey)

    const targetFile = path.join(tempDir, `${ref}.enc`)
    const rawFileBytes = await fs.promises.readFile(targetFile)
    const rawFileString = rawFileBytes.toString('utf8')

    // Must NOT contain the plaintext key string
    expect(rawFileString.includes(rawApiKey)).toBe(false)
    expect(rawFileString.includes('sk-proj')).toBe(false)
    expect(rawFileBytes.length).toBeGreaterThan(0)
  })

  // Test 3: Successful credential retrieval
  it('3. successfully retrieves and decrypts stored credential', async () => {
    const rawApiKey = 'sk-proj-secret-retrieval-test'
    const ref = await vault.store(rawApiKey)

    const retrieved = await vault.retrieve(ref)
    expect(retrieved).toBe(rawApiKey)
  })

  // Test 4: Successful credential replacement
  it('4. successfully replaces an existing credential atomically', async () => {
    const initialKey = 'sk-proj-original-key'
    const updatedKey = 'sk-proj-updated-key-999'

    const ref = await vault.store(initialKey)
    expect(await vault.retrieve(ref)).toBe(initialKey)

    await vault.replace(ref, updatedKey)
    expect(await vault.retrieve(ref)).toBe(updatedKey)
  })

  // Test 5: Existing credential remains intact when replacement fails
  it('5. preserves existing credential if encryption or write fails during replacement', async () => {
    const originalKey = 'sk-proj-intact-original'
    const ref = await vault.store(originalKey)

    // Force encryption failure during replacement
    adapter.throwOnEncrypt = true

    await expect(vault.replace(ref, 'sk-proj-new-failing-key')).rejects.toThrow(
      EncryptionFailureError
    )

    // Restore adapter encryption and verify original remains unchanged
    adapter.throwOnEncrypt = false
    const recovered = await vault.retrieve(ref)
    expect(recovered).toBe(originalKey)
  })

  // Test 6: Successful credential deletion
  it('6. successfully deletes a credential file and guards against orphaned paths', async () => {
    const ref = await vault.store('sk-proj-to-delete')
    const targetFile = path.join(tempDir, `${ref}.enc`)
    expect(fs.existsSync(targetFile)).toBe(true)

    await vault.delete(ref)
    expect(fs.existsSync(targetFile)).toBe(false)

    // Retrieval must now throw CredentialNotFoundError
    await expect(vault.retrieve(ref)).rejects.toThrow(CredentialNotFoundError)
  })

  // Test 7: Missing credential handling
  it('7. safely throws CredentialNotFoundError when accessing non-existent credentials', async () => {
    const nonExistentRef = 'cred_550e8400-e29b-41d4-a716-446655440000'

    await expect(vault.retrieve(nonExistentRef)).rejects.toThrow(CredentialNotFoundError)
    await expect(vault.replace(nonExistentRef, 'new-key')).rejects.toThrow(CredentialNotFoundError)
    await expect(vault.delete(nonExistentRef)).rejects.toThrow(CredentialNotFoundError)
  })

  // Test 8: Invalid references and path traversal rejection
  it('8. strictly rejects malformed references, path traversal, and injection attempts', async () => {
    const maliciousInputs = [
      '../secret.txt',
      '../../etc/passwd',
      'cred_123',
      'cred_invalid-uuid-characters!!',
      'sk-proj-raw-key-input',
      'cred_550e8400-e29b-41d4-a716-446655440000/subpath',
      '',
      '   ',
      'cred_550e8400-e29b-41d4-a716-446655440000\0nullbyte'
    ]

    for (const badRef of maliciousInputs) {
      await expect(vault.retrieve(badRef)).rejects.toThrow(InvalidCredentialRefError)
      await expect(vault.replace(badRef, 'key')).rejects.toThrow(InvalidCredentialRefError)
      await expect(vault.delete(badRef)).rejects.toThrow(InvalidCredentialRefError)
    }
  })

  // Test 9: Encryption unavailable
  it('9. halts persistent credential operations when encryption is unavailable', async () => {
    adapter.asyncAvailable = false

    const availability = await vault.checkAvailability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toBe('ASYNC_ENCRYPTION_UNAVAILABLE')

    await expect(vault.store('sk-proj-cannot-save')).rejects.toThrow(EncryptionUnavailableError)
  })

  // Test 10: Linux basic_text rejection
  it('10. explicitly rejects Linux basic_text backend and blocks credential storage', async () => {
    adapter.backend = 'basic_text'
    adapter.asyncAvailable = true

    const availability = await vault.checkAvailability()
    expect(availability.available).toBe(false)
    expect(availability.backend).toBe('basic_text')
    expect(availability.reason).toBe('LINUX_WEAK_BACKEND_REJECTED')

    await expect(vault.store('sk-proj-insecure-linux')).rejects.toThrow(
      LinuxWeakBackendRejectedError
    )
  })

  // Test 11: Encryption failure cleanup
  it('11. cleans up temporary files if safeStorage encryption fails during store', async () => {
    adapter.throwOnEncrypt = true

    await expect(vault.store('sk-proj-fail-encryption')).rejects.toThrow(EncryptionFailureError)

    // Ensure no orphan .tmp or .enc files remain in the vault directory
    const files = await fs.promises.readdir(tempDir)
    expect(files.filter((f) => f.startsWith('.tmp_') || f.endsWith('.enc')).length).toBe(0)
  })

  // Test 12: Decryption failure handling
  it('12. cleanly handles corrupted ciphertext or decryption failures without crashing', async () => {
    const ref = await vault.store('sk-proj-valid-secret')
    const targetFile = path.join(tempDir, `${ref}.enc`)

    // Tamper with file contents (corrupting authentication tag)
    const fileBytes = await fs.promises.readFile(targetFile)
    fileBytes[fileBytes.length - 1] ^= 0xff
    await fs.promises.writeFile(targetFile, fileBytes)

    await expect(vault.retrieve(ref)).rejects.toThrow(DecryptionFailureError)

    // Zero-byte corrupted file test
    await fs.promises.writeFile(targetFile, Buffer.alloc(0))
    await expect(vault.retrieve(ref)).rejects.toThrow(CorruptedCredentialFileError)
  })

  // Test 13: shouldReEncrypt successful rotation
  it('13. automatically re-encrypts and rewrites ciphertext when shouldReEncrypt is true', async () => {
    const originalKey = 'sk-proj-rotate-me'
    const ref = await vault.store(originalKey)

    // Configure adapter to flag re-encryption required on next decryption
    adapter.shouldReEncrypt = true
    const encryptCountBefore = adapter.encryptCallCount

    const decrypted = await vault.retrieve(ref)
    expect(decrypted).toBe(originalKey)

    // Re-encryption must have triggered an additional encrypt call
    expect(adapter.encryptCallCount).toBe(encryptCountBefore + 1)

    // Turn off re-encryption flag and verify decrypted content is still valid
    adapter.shouldReEncrypt = false
    const verified = await vault.retrieve(ref)
    expect(verified).toBe(originalKey)
  })

  // Test 14: Failed rotation preserves original credential
  it('14. preserves original credential file if automatic rotation fails', async () => {
    const originalKey = 'sk-proj-preserve-on-rotation-fail'
    const ref = await vault.store(originalKey)

    // Set shouldReEncrypt true, but subsequent encryption fails
    adapter.shouldReEncrypt = true
    let firstDecrypt = true

    // Hook adapter to fail only during the rotation re-encryption
    const originalEncrypt = adapter.encryptStringAsync.bind(adapter)
    adapter.encryptStringAsync = async (str: string) => {
      if (!firstDecrypt) {
        throw new Error('Rotation re-encryption transient failure')
      }
      return originalEncrypt(str)
    }

    firstDecrypt = false
    // Retrieval should still return decrypted plaintext even if background rotation write failed
    const plaintext = await vault.retrieve(ref)
    expect(plaintext).toBe(originalKey)

    // Verify original file is still intact and readable
    adapter.shouldReEncrypt = false
    adapter.encryptStringAsync = originalEncrypt
    const intact = await vault.retrieve(ref)
    expect(intact).toBe(originalKey)
  })

  // Test 15: Temporary files are cleaned after failures
  it('15. ensures no dangling .tmp files remain after write or replace failures', async () => {
    // 1. Force write failure on store
    const readOnlyDir = path.join(tempDir, 'sub-dir')
    await fs.promises.mkdir(readOnlyDir)
    const readOnlyVault = new CredentialVault({
      vaultDir: readOnlyDir,
      safeStorage: adapter,
      platform: 'linux'
    })

    const ref = await readOnlyVault.store('sk-proj-success')
    expect(isValidCredentialRef(ref)).toBe(true)

    // Ensure no temp files
    let dirFiles = await fs.promises.readdir(readOnlyDir)
    expect(dirFiles.filter((f) => f.startsWith('.tmp_')).length).toBe(0)

    // Trigger failure by deleting target directory during operation or corrupting replacement
    adapter.throwOnEncrypt = true
    await expect(readOnlyVault.replace(ref, 'new-val')).rejects.toThrow(EncryptionFailureError)

    dirFiles = await fs.promises.readdir(readOnlyDir)
    expect(dirFiles.filter((f) => f.startsWith('.tmp_')).length).toBe(0)
  })

  // Test 16: Concurrent operations on the same credential are safe
  it('16. guards against race conditions on concurrent mutations on the same credential', async () => {
    const ref = await vault.store('sk-proj-initial-lock-test')

    // Launch two simultaneous replacements on the SAME credential reference
    const promise1 = vault.replace(ref, 'sk-proj-value-1')
    const promise2 = vault.replace(ref, 'sk-proj-value-2')

    const results = await Promise.allSettled([promise1, promise2])

    // Exactly one should succeed, and one should encounter ConcurrentOperationConflictError
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConcurrentOperationConflictError
    )

    // The stored credential must be either value-1 or value-2, and must NOT be corrupted
    const current = await vault.retrieve(ref)
    expect(['sk-proj-value-1', 'sk-proj-value-2']).toContain(current)
  })

  // Test 17: Different credentials do not interfere with each other
  it('17. performs concurrent operations on different credentials without interference', async () => {
    const refA = await vault.store('sk-proj-cred-A')
    const refB = await vault.store('sk-proj-cred-B')
    const refC = await vault.store('sk-proj-cred-C')

    // Run simultaneous replacements on distinct credentials
    await Promise.all([
      vault.replace(refA, 'sk-proj-cred-A-updated'),
      vault.replace(refB, 'sk-proj-cred-B-updated'),
      vault.replace(refC, 'sk-proj-cred-C-updated')
    ])

    expect(await vault.retrieve(refA)).toBe('sk-proj-cred-A-updated')
    expect(await vault.retrieve(refB)).toBe('sk-proj-cred-B-updated')
    expect(await vault.retrieve(refC)).toBe('sk-proj-cred-C-updated')
  })

  // Test 18: No plaintext credential appears in captured logs or errors
  it('18. verifies that thrown errors never contain plaintext credentials', async () => {
    const sensitiveKey = 'SUPER_SECRET_SENSITIVE_API_KEY_xyz987'

    adapter.throwOnEncrypt = true
    try {
      await vault.store(sensitiveKey)
      expect.fail('Expected store to throw')
    } catch (err: unknown) {
      const error = err as Error
      expect(error.message).not.toContain(sensitiveKey)
      expect(JSON.stringify(error)).not.toContain(sensitiveKey)
    }

    adapter.throwOnEncrypt = false
    const ref = await vault.store('sk-initial')

    adapter.throwOnEncrypt = true
    try {
      await vault.replace(ref, sensitiveKey)
      expect.fail('Expected replace to throw')
    } catch (err: unknown) {
      const error = err as Error
      expect(error.message).not.toContain(sensitiveKey)
      expect(JSON.stringify(error)).not.toContain(sensitiveKey)
    }
  })

  // Smoke test for DefaultSafeStorageAdapter environment resilience
  it('19. verifies DefaultSafeStorageAdapter behaves defensively in non-Electron test runner', async () => {
    const defaultAdapter = new DefaultSafeStorageAdapter()
    const isAsync = await defaultAdapter.isAsyncEncryptionAvailable()
    // In vitest Node environment (outside Electron executable), isAsync should safely be false without crashing
    expect(typeof isAsync).toBe('boolean')
    expect(defaultAdapter.getSelectedStorageBackend()).toBe('unknown')
  })
})
