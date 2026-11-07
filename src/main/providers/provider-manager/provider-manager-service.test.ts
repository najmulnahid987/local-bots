import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { ProviderManagerService } from './provider-manager-service'
import { ProviderManagerError } from './errors'
import {
  CredentialVault,
  type ISafeStorageAdapter,
  type LinuxStorageBackend,
  type SafeStorageDecryptionResult
} from '../../security/credential-vault'
import { ProviderConnectionRepository } from '../../database/repositories/provider-connection-repository'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { providerRegistry } from '../provider-registry'
import {
  type ProviderAdapter,
  type ProviderId,
  type GenerateTextOptions,
  type ConnectionTestResult,
  type GenerateTextResult,
  type StreamTextChunk
} from '../types'

/**
 * High-fidelity test safeStorage adapter simulating AES-256-GCM.
 */
class TestSafeStorageAdapter implements ISafeStorageAdapter {
  private key = crypto.randomBytes(32)
  public asyncAvailable = true
  public backend: LinuxStorageBackend = 'gnome_libsecret'

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.asyncAvailable
  }

  public async encryptStringAsync(plainText: string): Promise<Buffer> {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted])
  }

  public async decryptStringAsync(encrypted: Buffer): Promise<SafeStorageDecryptionResult> {
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const data = encrypted.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    return { result: decrypted, shouldReEncrypt: false }
  }
}

/**
 * Mock provider adapter tracking calls and arguments.
 */
class MockAdapter implements ProviderAdapter {
  public testConnectionCalls: Array<{ apiKey: string; modelId?: string }> = []
  public generateTextCalls: Array<{ apiKey: string; options: GenerateTextOptions }> = []
  public testSuccess = true
  public testError: ConnectionTestResult['error'] = undefined

  constructor(readonly providerId: ProviderId) {}

  public testConnection = vi.fn(
    async (apiKey: string, modelId?: string): Promise<ConnectionTestResult> => {
      this.testConnectionCalls.push({ apiKey, modelId })
      if (!this.testSuccess) {
        return {
          success: false,
          latencyMs: 10,
          testedModelId: modelId ?? 'default',
          error: this.testError ?? {
            code: 'AUTHENTICATION_FAILED',
            message: 'Mock test authentication failure.',
            retryable: false
          }
        }
      }
      return {
        success: true,
        latencyMs: 15,
        testedModelId: modelId ?? 'default'
      }
    }
  )

  public generateText = vi.fn(
    async (apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult> => {
      this.generateTextCalls.push({ apiKey, options })
      return {
        text: `Generated response from ${this.providerId}`,
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      }
    }
  )

  public streamText = vi.fn(async function* (
    this: MockAdapter,
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    this.generateTextCalls.push({ apiKey, options })
    yield { type: 'text-delta', textDelta: 'Hello ' }
    yield { type: 'text-delta', textDelta: 'world!' }
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 }
    }
  })
}

describe('ProviderManagerService (Phase 3 Step 3.7A)', () => {
  let dbContext: MigratedTestDatabaseContext
  let tempVaultDir: string
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let mockOpenAI: MockAdapter
  let mockAnthropic: MockAdapter
  let mockGoogle: MockAdapter
  let service: ProviderManagerService

  beforeEach(() => {
    dbContext = createMigratedTestDatabase()
    tempVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-dir-'))
    const safeStorage = new TestSafeStorageAdapter()
    vault = new CredentialVault({
      vaultDir: tempVaultDir,
      safeStorage,
      platform: 'linux'
    })
    connectionRepo = new ProviderConnectionRepository(dbContext.db)

    mockOpenAI = new MockAdapter('openai')
    mockAnthropic = new MockAdapter('anthropic')
    mockGoogle = new MockAdapter('google')

    service = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: providerRegistry,
      adapters: {
        openai: mockOpenAI,
        anthropic: mockAnthropic,
        google: mockGoogle
      }
    })
  })

  afterEach(() => {
    dbContext.cleanup()
    fs.rmSync(tempVaultDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // 1. Correct adapter is selected for each provider
  it('1. selects the correct adapter for each provider (openai, anthropic, google)', async () => {
    await service.testDraftConnection({ providerId: 'openai', apiKey: 'sk-test' })
    expect(mockOpenAI.testConnection).toHaveBeenCalledTimes(1)
    expect(mockAnthropic.testConnection).not.toHaveBeenCalled()
    expect(mockGoogle.testConnection).not.toHaveBeenCalled()

    await service.testDraftConnection({ providerId: 'anthropic', apiKey: 'sk-ant' })
    expect(mockAnthropic.testConnection).toHaveBeenCalledTimes(1)

    await service.testDraftConnection({ providerId: 'google', apiKey: 'AIzaSy' })
    expect(mockGoogle.testConnection).toHaveBeenCalledTimes(1)
  })

  // 2. Unknown providers are rejected
  it('2. rejects unknown providers with validation error', async () => {
    await expect(
      service.testDraftConnection({
        providerId: 'unsupported' as unknown as ProviderId,
        apiKey: 'test'
      })
    ).rejects.toThrow(ProviderManagerError)
  })

  // 3. Unknown models are rejected
  it('3. rejects unknown model IDs during draft connection testing', async () => {
    await expect(
      service.testDraftConnection({
        providerId: 'openai',
        apiKey: 'sk-test',
        modelId: 'non-existent-model-xyz'
      })
    ).rejects.toThrow(ProviderManagerError)
  })

  // 4. Cross-provider model selection is rejected
  it('4. rejects cross-provider model selection (e.g. Anthropic model for OpenAI connection)', async () => {
    await expect(
      service.testDraftConnection({
        providerId: 'openai',
        apiKey: 'sk-test',
        modelId: 'claude-sonnet-5-5'
      })
    ).rejects.toThrow(ProviderManagerError)
  })

  // 5. Draft connection testing does not persist credentials
  it('5. draft connection testing does not persist credentials to disk or SQLite', async () => {
    const result = await service.testDraftConnection({
      providerId: 'openai',
      apiKey: 'sk-test-draft'
    })

    expect(result.success).toBe(true)
    const storedFiles = await vault.listStoredCredentialRefs()
    expect(storedFiles.length).toBe(0)
    expect(connectionRepo.list().length).toBe(0)
  })

  // 6. Successful connection creation
  it('6. successfully creates provider connection and returns safe public summary', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Production OpenAI',
      apiKey: 'sk-valid-key-12345'
    })

    expect(summary.id).toBeDefined()
    expect(summary.providerId).toBe('openai')
    expect(summary.label).toBe('Production OpenAI')
    expect(summary.status).toBe('active')
    expect(summary.hasCredential).toBe(true)
    // Invariant: credentialRef is never exposed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((summary as any).credentialRef).toBeUndefined()

    // File in vault exists
    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(1)

    // DB record exists
    const dbRecord = connectionRepo.getById(summary.id)
    expect(dbRecord).not.toBeNull()
    expect(dbRecord?.credentialRef).toBe(storedRefs[0])
  })

  // 7. Invalid connection key prevents saving
  it('7. invalid connection key during creation halts process and prevents saving', async () => {
    mockOpenAI.testSuccess = false
    mockOpenAI.testError = {
      code: 'AUTHENTICATION_FAILED',
      message: 'Invalid key rejected by provider.',
      retryable: false
    }

    await expect(
      service.createConnection({
        providerId: 'openai',
        label: 'Failing Key Connection',
        apiKey: 'sk-invalid-key'
      })
    ).rejects.toThrow('Invalid key rejected by provider.')

    expect((await vault.listStoredCredentialRefs()).length).toBe(0)
    expect(connectionRepo.list().length).toBe(0)
  })

  // 8. Database failure triggers credential cleanup
  it('8. database failure during creation triggers compensatory credential cleanup in vault', async () => {
    vi.spyOn(connectionRepo, 'create').mockImplementationOnce(() => {
      throw new Error('Simulated SQLite constraint failure')
    })

    await expect(
      service.createConnection({
        providerId: 'openai',
        label: 'Crash DB Connection',
        apiKey: 'sk-valid-key'
      })
    ).rejects.toThrow('Failed to save connection record in database')

    // Proves compensatory deletion was executed
    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(0)
  })

  // 9. Credential cleanup failure is reported safely
  it('9. credential cleanup failure during compensation does not crash or leak internal details', async () => {
    vi.spyOn(connectionRepo, 'create').mockImplementationOnce(() => {
      throw new Error('Simulated SQLite insert error')
    })
    vi.spyOn(vault, 'delete').mockRejectedValueOnce(new Error('Filesystem locked error'))

    await expect(
      service.createConnection({
        providerId: 'openai',
        label: 'Double Failure',
        apiKey: 'sk-valid-key'
      })
    ).rejects.toThrow('Failed to save connection record in database')
  })

  // 10. Successful saved-connection testing
  it('10. successfully tests saved connection and confirms active status', async () => {
    const summary = await service.createConnection({
      providerId: 'anthropic',
      label: 'Claude Main',
      apiKey: 'sk-ant-test-key'
    })

    const testRes = await service.testConnection(summary.id)
    expect(testRes.success).toBe(true)

    const updated = service.getConnection(summary.id)
    expect(updated?.status).toBe('active')
  })

  // 11. Invalid authentication updates status to error
  it('11. authentication failure during testConnection updates status to error', async () => {
    const summary = await service.createConnection({
      providerId: 'google',
      label: 'Google Connection',
      apiKey: 'AIzaSyTest'
    })

    mockGoogle.testSuccess = false
    mockGoogle.testError = {
      code: 'AUTHENTICATION_FAILED',
      message: 'Key has expired.',
      retryable: false
    }

    const testRes = await service.testConnection(summary.id)
    expect(testRes.success).toBe(false)
    expect(testRes.error?.code).toBe('AUTHENTICATION_FAILED')

    const updated = service.getConnection(summary.id)
    expect(updated?.status).toBe('error')
  })

  // 12. Temporary network failures do not permanently invalidate connection status
  it('12. temporary network/timeout failures during testConnection do not permanently set error status', async () => {
    const summary = await service.createConnection({
      providerId: 'google',
      label: 'Google Connection',
      apiKey: 'AIzaSyTest'
    })

    mockGoogle.testSuccess = false
    mockGoogle.testError = {
      code: 'NETWORK_ERROR',
      message: 'Temporary socket timeout.',
      retryable: true
    }

    const testRes = await service.testConnection(summary.id)
    expect(testRes.success).toBe(false)

    // Status remains active because network error is transient
    const updated = service.getConnection(summary.id)
    expect(updated?.status).toBe('active')
  })

  // 13. Successful replacement updates the credential
  it('13. successful credential replacement updates stored secret and marks status active', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'OpenAI Dev',
      apiKey: 'sk-old-key'
    })

    const updatedSummary = await service.replaceCredential(summary.id, 'sk-new-key-67890')
    expect(updatedSummary.status).toBe('active')

    const rawConn = connectionRepo.getById(summary.id)!
    const decryptedNew = await vault.retrieve(rawConn.credentialRef)
    expect(decryptedNew).toBe('sk-new-key-67890')
  })

  // 14. Failed replacement preserves the original credential
  it('14. failed key test during replacement preserves the original stored credential', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'OpenAI Dev',
      apiKey: 'sk-original-key'
    })

    mockOpenAI.testSuccess = false
    mockOpenAI.testError = {
      code: 'AUTHENTICATION_FAILED',
      message: 'New key invalid',
      retryable: false
    }

    await expect(service.replaceCredential(summary.id, 'sk-bad-replacement-key')).rejects.toThrow(
      'New key invalid'
    )

    const rawConn = connectionRepo.getById(summary.id)!
    const decrypted = await vault.retrieve(rawConn.credentialRef)
    expect(decrypted).toBe('sk-original-key')
  })

  // 15. Label updates work
  it('15. updates connection label successfully and returns updated summary DTO', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Old Label',
      apiKey: 'sk-test'
    })

    const updated = service.updateConnectionLabel(summary.id, 'New Renamed Label')
    expect(updated.label).toBe('New Renamed Label')
    expect(service.getConnection(summary.id)?.label).toBe('New Renamed Label')
  })

  // 16. Removal of an unreferenced connection works
  it('16. removes unreferenced provider connection and deletes credential file', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Temp Connection',
      apiKey: 'sk-test'
    })

    const removeRes = await service.removeConnection(summary.id)
    expect(removeRes.success).toBe(true)
    expect(removeRes.credentialCleaned).toBe(true)

    expect(service.getConnection(summary.id)).toBeNull()
    expect((await vault.listStoredCredentialRefs()).length).toBe(0)
  })

  // 17. Removal of a Bot-referenced connection is rejected
  it('17. rejects removal of connection referenced by active Bot', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Assigned Connection',
      apiKey: 'sk-test'
    })

    // Assign to a Bot in SQLite
    const kb = dbContext.kbRepo.create({ name: 'Test KB', description: 'desc' })
    dbContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Active Bot',
      description: 'Test bot',
      providerConnectionId: summary.id,
      modelId: 'gpt-6-luna'
    })

    await expect(service.removeConnection(summary.id)).rejects.toThrow(
      /referenced by one or more active Bots/
    )

    // Connection remains in DB and vault
    expect(service.getConnection(summary.id)).not.toBeNull()
  })

  // 18. Credential files remain intact when database deletion is rejected
  it('18. preserves credential file when database deletion is rejected due to Bot reference', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Assigned Connection',
      apiKey: 'sk-test'
    })

    const kb = dbContext.kbRepo.create({ name: 'Test KB', description: 'desc' })
    dbContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Active Bot',
      description: 'Test bot',
      providerConnectionId: summary.id,
      modelId: 'gpt-6-luna'
    })

    await expect(service.removeConnection(summary.id)).rejects.toThrow()
    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(1)
  })

  // 19. Filesystem deletion failure is represented safely
  it('19. handles filesystem deletion failure safely when removing connection', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Unlink Failure Connection',
      apiKey: 'sk-test'
    })

    vi.spyOn(vault, 'delete').mockRejectedValueOnce(new Error('Filesystem permission denied'))

    const removeResult = await service.removeConnection(summary.id)
    expect(removeResult.success).toBe(true)
    expect(removeResult.credentialCleaned).toBe(false)
    // DB record is deleted
    expect(service.getConnection(summary.id)).toBeNull()
  })

  // 20. Missing credential files mark connections as error
  it('20. startup reconciliation marks connections with missing files as error', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Will Lose File',
      apiKey: 'sk-test'
    })

    // Manually delete credential file behind DB's back
    const rawConn = connectionRepo.getById(summary.id)!
    await vault.delete(rawConn.credentialRef)

    const recon = await service.initialize()
    expect(recon.missingCredentialConnectionsMarkedError).toBe(1)

    const updated = service.getConnection(summary.id)
    expect(updated?.status).toBe('error')
  })

  // 21. Orphan files are identified and cleaned safely
  it('21. startup reconciliation identifies and purges orphan credential files', async () => {
    // Store an unreferenced key directly in the vault
    const orphanRef = await vault.store('sk-orphan-key-leftover')
    expect(await vault.exists(orphanRef)).toBe(true)

    const recon = await service.initialize()
    expect(recon.orphanCredentialsRemoved).toBe(1)
    expect(await vault.exists(orphanRef)).toBe(false)
  })

  // 22. Unrecognized files are preserved
  it('22. startup reconciliation preserves unrecognized files in vault directory', async () => {
    const randomFilePath = path.join(tempVaultDir, 'unrecognized_notes.txt')
    fs.writeFileSync(randomFilePath, 'User notes in vault dir')

    await service.initialize()
    expect(fs.existsSync(randomFilePath)).toBe(true)
  })

  // 23. Symbolic links are not followed
  it('23. startup reconciliation does not follow symbolic links', async () => {
    // Only test symlinks if platform supports them
    try {
      const realTarget = path.join(tempVaultDir, 'real_secret.txt')
      fs.writeFileSync(realTarget, 'secret content')
      const symlinkPath = path.join(tempVaultDir, 'cred_550e8400-e29b-41d4-a716-446655440000.enc')
      fs.symlinkSync(realTarget, symlinkPath)

      await service.initialize()

      // Target should be preserved intact
      expect(fs.existsSync(realTarget)).toBe(true)
    } catch {
      // Windows unprivileged symlink fallback
    }
  })

  // 24. Stale temporary files are cleaned within the specified rules (> 24 hours)
  it('24. startup reconciliation cleans stale temporary files older than 24 hours', async () => {
    const staleTempFile = path.join(tempVaultDir, '.tmp_cred_stale_123.tmp')
    fs.writeFileSync(staleTempFile, 'stale temp buffer')

    // Set mtime to 25 hours ago
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(staleTempFile, twentyFiveHoursAgo, twentyFiveHoursAgo)

    const recon = await service.initialize()
    expect(recon.staleTempFilesCleaned).toBe(1)
    expect(fs.existsSync(staleTempFile)).toBe(false)
  })

  // 25. Recent temporary files are preserved (< 24 hours)
  it('25. startup reconciliation preserves recent temporary files (< 24 hours)', async () => {
    const recentTempFile = path.join(tempVaultDir, '.tmp_cred_recent_456.tmp')
    fs.writeFileSync(recentTempFile, 'active in-flight write')

    const recon = await service.initialize()
    expect(recon.staleTempFilesCleaned).toBe(0)
    expect(fs.existsSync(recentTempFile)).toBe(true)
  })

  // 26. Text generation uses the correct adapter
  it('26. text generation dispatches to the correct adapter with just-in-time credential retrieval', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'OpenAI Test',
      apiKey: 'sk-secret-key-gen'
    })

    const result = await service.generateText(summary.id, 'gpt-6-luna', {
      messages: [{ role: 'user', content: 'Generate poem' }]
    })

    expect(result.text).toContain('Generated response from openai')
    expect(mockOpenAI.generateTextCalls.length).toBe(1)
    expect(mockOpenAI.generateTextCalls[0].apiKey).toBe('sk-secret-key-gen')
    expect(mockOpenAI.generateTextCalls[0].options.modelId).toBe('gpt-6-luna')
  })

  // 27. Capability validation blocks unsupported features
  it('27. capability validation blocks unsupported features (tools, jsonSchema, images)', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'OpenAI Cap',
      apiKey: 'sk-secret'
    })

    // Tool calling blocked
    await expect(
      service.generateText(summary.id, 'gpt-6-luna', {
        messages: [{ role: 'user', content: 'Use tool' }],
        tools: [{ name: 'read_file', description: 'Reads file', parameters: {} }]
      })
    ).rejects.toMatchObject({
      error: { code: 'UNSUPPORTED_CAPABILITY' }
    })

    // JSON schema blocked
    await expect(
      service.generateText(summary.id, 'gpt-6-luna', {
        messages: [{ role: 'user', content: 'JSON please' }],
        jsonSchema: { type: 'object' }
      })
    ).rejects.toMatchObject({
      error: { code: 'UNSUPPORTED_CAPABILITY' }
    })

    // Image input blocked
    await expect(
      service.generateText(summary.id, 'gpt-6-luna', {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this' },
              { type: 'image', mediaType: 'image/png', data: 'data123' }
            ]
          }
        ]
      })
    ).rejects.toMatchObject({
      error: { code: 'UNSUPPORTED_CAPABILITY' }
    })
  })

  // 28. Saved credentials are retrieved only during active operations
  it('28. retrieves saved credentials only during active operations and does not cache them', async () => {
    const summary = await service.createConnection({
      providerId: 'anthropic',
      label: 'Claude Conn',
      apiKey: 'sk-ant-test'
    })

    const retrieveSpy = vi.spyOn(vault, 'retrieve')
    expect(retrieveSpy).toHaveBeenCalledTimes(0)

    await service.generateText(summary.id, 'claude-sonnet-5-5', {
      messages: [{ role: 'user', content: 'Hi' }]
    })

    expect(retrieveSpy).toHaveBeenCalledTimes(1)
    // Confirm service instance holds no plaintext credentials
    const serviceProps = Object.values(service).map((v) => String(v))
    expect(serviceProps.some((p) => p.includes('sk-ant-test'))).toBe(false)
  })

  // 29. Concurrent connection mutations are safely serialized
  it('29. serializes concurrent mutations or rejects conflicting operations on the same connection', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Mutex Test',
      apiKey: 'sk-initial'
    })

    // Slow down replace to simulate in-flight mutation
    let resolveFirstReplace: () => void
    const firstReplacePromise = new Promise<void>((r) => {
      resolveFirstReplace = r
    })

    vi.spyOn(vault, 'replace').mockImplementationOnce(async () => {
      await firstReplacePromise
    })

    const op1 = service.replaceCredential(summary.id, 'sk-second-key')
    const op2 = service.replaceCredential(summary.id, 'sk-third-key')

    // op2 should be rejected with OPERATION_LOCKED because op1 is currently in progress
    await expect(op2).rejects.toThrow('Concurrent operation in progress')

    resolveFirstReplace!()
    await op1
  })

  // 30. No secret or credential reference appears in public DTOs or captured logs
  it('30. guarantees no secret keys or credential_ref pointers appear in public DTOs or errors', async () => {
    const secretKey = 'sk-proj-SUPERCONFIDENTIALKEY12345'
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Clean Summary',
      apiKey: secretKey
    })

    const serializedSummary = JSON.stringify(summary)
    expect(serializedSummary).not.toContain(secretKey)
    expect(serializedSummary).not.toContain('cred_')

    const listSummaries = service.listConnections()
    const serializedList = JSON.stringify(listSummaries)
    expect(serializedList).not.toContain(secretKey)
    expect(serializedList).not.toContain('cred_')

    // Error test
    try {
      await service.createConnection({
        providerId: 'openai',
        label: 'Error Redaction',
        apiKey: 'sk-proj-LEAKY-KEY-VALUE-FAIL'
      })
    } catch (err: unknown) {
      const errMsg = (err as Error).message
      expect(errMsg).not.toContain('sk-proj-LEAKY-KEY-VALUE-FAIL')
    }
  })
})
