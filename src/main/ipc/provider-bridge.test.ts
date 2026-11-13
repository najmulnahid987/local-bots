import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  PROVIDER_IPC_CHANNELS,
  type ProviderCatalogDto,
  type ProviderConnectionSummary,
  type ConnectionTestResult,
  type RemoveConnectionResult,
  type GenerateTextResult,
  type ProviderStreamEvent,
  type StreamStartIpcPayload
} from '../../shared/ipc'
import {
  registerProviderIpcHandlers,
  registerFailingProviderIpcHandlers,
  formatIpcError
} from './provider-handlers'
import {
  ProviderStreamManager,
  type MessagePortMainLike,
  type MessageChannelLike,
  type WebFrameWithPostMessage
} from './provider-stream-manager'
import { createProvidersApi, normalizeBridgeError } from '../../preload'
import { ProviderManagerService } from '../providers/provider-manager/provider-manager-service'
import { ProviderRegistry } from '../providers/provider-registry'
import { CredentialVault } from '../security/credential-vault/credential-vault'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import {
  type ProviderAdapter,
  type GenerateTextOptions,
  type StreamTextChunk,
  type ConnectionTestResult as InternalConnectionTestResult,
  type GenerateTextResult as InternalGenerateTextResult
} from '../providers/types'
import crypto from 'crypto'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'
import {
  type ISafeStorageAdapter,
  type LinuxStorageBackend,
  type SafeStorageDecryptionResult
} from '../security/credential-vault/types'

// IPC Registry for ipcMain mock (prefixed with mock so Vitest hoisting preserves it)
const mockIpcHandlers = new Map<
  string,
  (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
>()

vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
        ) => {
          mockIpcHandlers.set(channel, handler)
        }
      ),
      removeHandler: vi.fn((channel: string) => {
        mockIpcHandlers.delete(channel)
      })
    },
    contextBridge: {
      exposeInMainWorld: vi.fn()
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    },
    BrowserWindow: vi.fn()
  }
})

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

// In-memory mock for Electron MessagePortMain
class MockMessagePortMain implements MessagePortMainLike {
  public messages: unknown[] = []
  public remotePort: MockMessagePortMain | null = null
  public isStarted = false
  public isClosed = false
  private listeners: {
    message: ((event: { data: unknown }) => void)[]
    close: (() => void)[]
  } = {
    message: [],
    close: []
  }

  public start(): void {
    this.isStarted = true
  }

  public close(): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const listener of this.listeners.close) {
      listener()
    }
  }

  public postMessage(message: unknown): void {
    if (this.isClosed) return
    this.messages.push(message)
    if (this.remotePort && !this.remotePort.isClosed) {
      for (const listener of this.remotePort.listeners.message) {
        listener({ data: message })
      }
    }
  }

  public on(
    event: 'message' | 'close',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (event === 'message') {
      this.listeners.message.push(listener as (event: { data: unknown }) => void)
    } else if (event === 'close') {
      this.listeners.close.push(listener as () => void)
    }
  }
}

function createMockMessageChannel(): MessageChannelLike {
  const port1 = new MockMessagePortMain()
  const port2 = new MockMessagePortMain()
  port1.remotePort = port2
  port2.remotePort = port1
  return { port1, port2 }
}

// Mock Provider Adapter for testing
class MockAdapter implements ProviderAdapter {
  public providerId: 'openai' | 'anthropic' | 'google'

  constructor(providerId: 'openai' | 'anthropic' | 'google') {
    this.providerId = providerId
  }

  public testConnection = vi.fn(
    async (
      apiKey: string,
      modelId?: string,
      signal?: AbortSignal
    ): Promise<InternalConnectionTestResult> => {
      void signal
      const targetModelId = modelId ?? 'default-model'
      if (apiKey.includes('bad') || apiKey.includes('invalid')) {
        return {
          success: false,
          latencyMs: 15,
          testedModelId: targetModelId,
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'Invalid key rejected by provider',
            retryable: false
          }
        }
      }
      return {
        success: true,
        latencyMs: 42,
        testedModelId: targetModelId
      }
    }
  )

  public generateText = vi.fn(
    async (apiKey: string, options: GenerateTextOptions): Promise<InternalGenerateTextResult> => {
      void apiKey
      void options
      return {
        text: `Mock generation from ${this.providerId}`,
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 25, totalTokens: 35 }
      }
    }
  )

  public streamText = vi.fn(async function* (
    this: MockAdapter,
    apiKey: string,
    options: GenerateTextOptions
  ): AsyncIterable<StreamTextChunk> {
    void apiKey
    if (options.abortSignal?.aborted) {
      throw new Error('Operation aborted')
    }
    yield { type: 'text-delta', textDelta: 'Chunk 1 ' }
    if (options.abortSignal?.aborted) {
      throw new Error('Operation aborted')
    }
    yield { type: 'text-delta', textDelta: 'Chunk 2' }
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 }
    }
  })
}

describe('Phase 3 Step 3.7B: Secure IPC Bridge & Preload Integration', () => {
  let dbContext: MigratedTestDatabaseContext
  let vaultDir: string
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let registry: ProviderRegistry
  let mockOpenAI: MockAdapter
  let mockAnthropic: MockAdapter
  let mockGoogle: MockAdapter
  let service: ProviderManagerService
  let streamManager: ProviderStreamManager

  // Mock BrowserWindow & frames
  const devOrigin = 'http://localhost:5173'
  let mockMainFrame: WebFrameWithPostMessage
  let mockWebContents: WebContentsLike
  let mockWindow: BrowserWindowLike
  let windowClosedListeners: (() => void)[]
  let windowNavigationListeners: (() => void)[]
  let isWindowDestroyed: boolean

  beforeEach(async () => {
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-bridge-test-vault-'))

    const safeStorage = new TestSafeStorageAdapter()
    vault = new CredentialVault({
      vaultDir,
      safeStorage,
      platform: 'linux'
    })

    connectionRepo = new ProviderConnectionRepository(dbContext.db)
    registry = new ProviderRegistry()

    mockOpenAI = new MockAdapter('openai')
    mockAnthropic = new MockAdapter('anthropic')
    mockGoogle = new MockAdapter('google')

    service = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: {
        openai: mockOpenAI,
        anthropic: mockAnthropic,
        google: mockGoogle
      }
    })

    await service.initialize()

    streamManager = new ProviderStreamManager({
      maxStreams: 3,
      channelFactory: createMockMessageChannel
    })

    // Setup Mock BrowserWindow
    windowClosedListeners = []
    windowNavigationListeners = []
    isWindowDestroyed = false

    mockMainFrame = {
      url: `${devOrigin}/index.html`,
      postMessage: vi.fn()
    }

    mockWebContents = {
      mainFrame: mockMainFrame as unknown as WebFrameMainLike,
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'did-start-navigation') {
          windowNavigationListeners.push(listener)
        }
      })
    } as unknown as WebContentsLike

    mockWindow = {
      isDestroyed: () => isWindowDestroyed,
      webContents: mockWebContents,
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'closed') {
          windowClosedListeners.push(listener)
        }
      })
    } as unknown as BrowserWindowLike

    mockIpcHandlers.clear()
    registerProviderIpcHandlers(() => mockWindow, service, { streamManager })
  })

  afterEach(() => {
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    dbContext.cleanup()
    try {
      fs.rmSync(vaultDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
    vi.restoreAllMocks()
  })

  function createValidEvent(): IpcSenderEventLike {
    return {
      sender: mockWebContents,
      senderFrame: mockMainFrame as unknown as WebFrameMainLike
    }
  }

  async function invokeHandler(channel: string, payload?: unknown): Promise<unknown> {
    const handler = mockIpcHandlers.get(channel)
    if (!handler) {
      throw new Error(`Handler not registered for channel: ${channel}`)
    }
    return handler(createValidEvent(), payload)
  }

  // ==========================================
  // SECTION 1: Ordinary IPC (1 - 10)
  // ==========================================

  it('1. provider catalog can be retrieved', async () => {
    const catalog = (await invokeHandler(PROVIDER_IPC_CHANNELS.GET_CATALOG)) as ProviderCatalogDto
    expect(catalog).toBeDefined()
    expect(catalog.providers.length).toBeGreaterThan(0)
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.providers.some((p) => p.id === 'openai')).toBe(true)
  })

  it('2. connection summaries can be listed', async () => {
    await service.createConnection({
      providerId: 'openai',
      label: 'Main OpenAI',
      apiKey: 'sk-test-key'
    })

    const list = (await invokeHandler(
      PROVIDER_IPC_CHANNELS.LIST_CONNECTIONS
    )) as ProviderConnectionSummary[]
    expect(list.length).toBe(1)
    expect(list[0].label).toBe('Main OpenAI')
    expect(list[0].hasCredential).toBe(true)
    expect(list[0].status).toBe('active')
  })

  it('3. draft key testing forwards only its requested arguments', async () => {
    const result = (await invokeHandler(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION, {
      providerId: 'openai',
      apiKey: 'sk-draft-key',
      modelId: 'gpt-6-luna'
    })) as ConnectionTestResult

    expect(result.ok).toBe(true)
    expect(mockOpenAI.testConnection).toHaveBeenCalledWith('sk-draft-key', 'gpt-6-luna', undefined)
  })

  it('4. connection creation forwards validated input', async () => {
    const summary = (await invokeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, {
      providerId: 'anthropic',
      label: 'Production Claude',
      apiKey: 'sk-ant-valid-key'
    })) as ProviderConnectionSummary

    expect(summary.id).toBeDefined()
    expect(summary.providerId).toBe('anthropic')
    expect(summary.label).toBe('Production Claude')
    expect(summary.hasCredential).toBe(true)
    expect(service.getConnection(summary.id)).not.toBeNull()
  })

  it('5. saved connection testing works', async () => {
    const summary = await service.createConnection({
      providerId: 'google',
      label: 'Gemini Test',
      apiKey: 'AIzaSy-test'
    })

    const testRes = (await invokeHandler(PROVIDER_IPC_CHANNELS.TEST_CONNECTION, {
      connectionId: summary.id
    })) as ConnectionTestResult

    expect(testRes.ok).toBe(true)
    expect(testRes.latencyMs).toBe(42)
  })

  it('6. connection label update works', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Old Label',
      apiKey: 'sk-test'
    })

    const updated = (await invokeHandler(PROVIDER_IPC_CHANNELS.UPDATE_LABEL, {
      connectionId: summary.id,
      label: 'New Renamed Label'
    })) as ProviderConnectionSummary

    expect(updated.label).toBe('New Renamed Label')
    expect(service.getConnection(summary.id)?.label).toBe('New Renamed Label')
  })

  it('7. credential replacement works', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Replace Key Test',
      apiKey: 'sk-old-key'
    })

    const updated = (await invokeHandler(PROVIDER_IPC_CHANNELS.REPLACE_CREDENTIAL, {
      connectionId: summary.id,
      apiKey: 'sk-new-super-key'
    })) as ProviderConnectionSummary

    expect(updated.status).toBe('active')
    expect(updated.hasCredential).toBe(true)
  })

  it('8. connection removal works', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'To Remove',
      apiKey: 'sk-test'
    })

    const removeRes = (await invokeHandler(PROVIDER_IPC_CHANNELS.REMOVE_CONNECTION, {
      connectionId: summary.id
    })) as RemoveConnectionResult

    expect(removeRes.success).toBe(true)
    expect(removeRes.connectionId).toBe(summary.id)
    expect(service.getConnection(summary.id)).toBeNull()
  })

  it('9. text generation works', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Gen Test',
      apiKey: 'sk-test'
    })

    const result = (await invokeHandler(PROVIDER_IPC_CHANNELS.GENERATE_TEXT, {
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Say hello' }]
      }
    })) as GenerateTextResult

    expect(result.text).toContain('Mock generation from openai')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.totalTokens).toBe(35)
  })

  it('10. unknown IPC channels are not exposed through Preload', () => {
    const mockIpc = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    } as unknown as typeof import('electron').ipcRenderer

    const preloadApi = createProvidersApi(mockIpc)
    const exposedMethods = Object.keys(preloadApi)

    expect(exposedMethods).toEqual([
      'getCatalog',
      'listConnections',
      'getAvailableModels',
      'testDraftConnection',
      'createConnection',
      'testConnection',
      'updateConnectionLabel',
      'replaceCredential',
      'removeConnection',
      'generateText',
      'streamText'
    ])
    // Proves arbitrary invocation methods are not exposed
    const apiRecords = preloadApi as unknown as Record<string, unknown>
    expect(apiRecords['invoke']).toBeUndefined()
    expect(apiRecords['send']).toBeUndefined()
    expect(apiRecords['on']).toBeUndefined()
  })

  // ==========================================
  // SECTION 2: Sender Security (11 - 16)
  // ==========================================

  it('11. valid main-frame sender is accepted', async () => {
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    const result = await handler(createValidEvent())
    expect(result).toBeDefined()
  })

  it('12. invalid sender is rejected', async () => {
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    const invalidEvent: IpcSenderEventLike = {
      sender: { mainFrame: mockMainFrame as unknown as WebFrameMainLike },
      senderFrame: mockMainFrame as unknown as WebFrameMainLike
    }

    await expect(handler(invalidEvent)).rejects.toThrow('Unauthorized IPC invocation')
  })

  it('13. subframe sender is rejected', async () => {
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    const subframe: WebFrameMainLike = {
      url: `${devOrigin}/subframe.html`
    }
    const invalidEvent: IpcSenderEventLike = {
      sender: mockWebContents,
      senderFrame: subframe
    }

    await expect(handler(invalidEvent)).rejects.toThrow('Unauthorized IPC invocation')
  })

  it('14. untrusted URL is rejected', async () => {
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    const untrustedFrame: WebFrameWithPostMessage = {
      url: 'https://attacker-controlled-site.com/exploit.html',
      postMessage: vi.fn()
    }
    const invalidEvent: IpcSenderEventLike = {
      sender: mockWebContents,
      senderFrame: untrustedFrame as unknown as WebFrameMainLike
    }

    await expect(handler(invalidEvent)).rejects.toThrow('Unauthorized IPC invocation')
  })

  it('15. different BrowserWindow is rejected', async () => {
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    const otherWebContents: WebContentsLike = {
      mainFrame: mockMainFrame as unknown as WebFrameMainLike
    }
    const otherEvent: IpcSenderEventLike = {
      sender: otherWebContents,
      senderFrame: mockMainFrame as unknown as WebFrameMainLike
    }

    await expect(handler(otherEvent)).rejects.toThrow('Unauthorized IPC invocation')
  })

  it('16. destroyed window cannot receive provider results', async () => {
    isWindowDestroyed = true
    const handler = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.GET_CATALOG)!
    await expect(handler(createValidEvent())).rejects.toThrow('Unauthorized IPC invocation')
  })

  // ==========================================
  // SECTION 3: Input Validation (17 - 23)
  // ==========================================

  it('17. unknown provider IDs are rejected', async () => {
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION, {
        providerId: 'unsupported-provider',
        apiKey: 'sk-test'
      })
    ).rejects.toThrow('Invalid provider')
  })

  it('18. unknown model IDs are rejected where applicable', async () => {
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION, {
        providerId: 'openai',
        apiKey: 'sk-test',
        modelId: 'nonexistent-model'
      })
    ).rejects.toThrow('not authorized for provider')
  })

  it('19. malformed connection IDs are rejected', async () => {
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.TEST_CONNECTION, {
        connectionId: 'not-a-uuid'
      })
    ).rejects.toThrow('Must be a valid UUID')
  })

  it('20. unexpected properties are rejected', async () => {
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, {
        providerId: 'openai',
        label: 'Strict Test',
        apiKey: 'sk-valid',
        unexpectedEvilField: 'malicious'
      })
    ).rejects.toThrow('Invalid IPC request payload')
  })

  it('21. empty keys are rejected', async () => {
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, {
        providerId: 'openai',
        label: 'Empty Key Test',
        apiKey: ''
      })
    ).rejects.toThrow('API key cannot be empty')
  })

  it('22. oversized payloads are rejected', async () => {
    const hugeMessage = 'A'.repeat(250_000)
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.GENERATE_TEXT, {
        connectionId: crypto.randomUUID(),
        modelId: 'gpt-6-luna',
        options: {
          messages: [{ role: 'user', content: hugeMessage }]
        }
      })
    ).rejects.toThrow('Individual message content exceeds 200,000 characters')
  })

  it('23. API-key input never appears in error output', async () => {
    const superConfidentialKey = 'sk-proj-CONFIDENTIAL-SECRET-12345'
    try {
      await invokeHandler(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION, {
        providerId: 'openai',
        apiKey: superConfidentialKey,
        extraMalicious: true
      })
      expect.fail('Should have rejected')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain(superConfidentialKey)
      expect(message).not.toContain('CONFIDENTIAL')
    }
  })

  // ==========================================
  // SECTION 4: DTO & Secret Safety (24 - 29)
  // ==========================================

  it('24. connection summaries never include credential_ref', async () => {
    const summary = (await invokeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, {
      providerId: 'openai',
      label: 'Safe Summary Test',
      apiKey: 'sk-secret'
    })) as ProviderConnectionSummary

    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('credential_ref')
    expect(serialized).not.toContain('credentialRef')
    expect(serialized).not.toContain('cred_')
    const summaryRecord = summary as unknown as Record<string, unknown>
    expect(summaryRecord['credentialRef']).toBeUndefined()
  })

  it('25. connection summaries never include stored key fragments', async () => {
    const secret = 'sk-super-secret-key-to-hide'
    const summary = (await invokeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, {
      providerId: 'openai',
      label: 'No Key Preview',
      apiKey: secret
    })) as ProviderConnectionSummary

    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('sk-')
    const summaryRecord = summary as unknown as Record<string, unknown>
    expect(summaryRecord['keyPreview']).toBeUndefined()
  })

  it('26. provider catalog contains no secret or internal filesystem fields', async () => {
    const catalog = (await invokeHandler(PROVIDER_IPC_CHANNELS.GET_CATALOG)) as ProviderCatalogDto
    const serialized = JSON.stringify(catalog)

    expect(serialized).not.toContain('app.sqlite')
    expect(serialized).not.toContain('credentials')
    expect(serialized).not.toContain('sk-')
    expect(serialized).not.toContain('secret')
  })

  it('27. safe error conversion removes sensitive information', () => {
    const rawError = new Error(
      'Authentication failed for sk-proj-1234567890abcdef and ref cred_123e4567-e89b-12d3-a456-426614174000 at D:/projects/secret'
    )
    const formatted = formatIpcError(rawError)

    expect(formatted.message).not.toContain('sk-proj-1234567890abcdef')
    expect(formatted.message).not.toContain('cred_123e4567-e89b-12d3-a456-426614174000')
    expect(formatted.message).toContain('[REDACTED_KEY]')
    expect(formatted.message).toContain('[REDACTED_REF]')

    const normalized = normalizeBridgeError(formatted)
    expect(normalized.code).toBe('PROVIDER_OPERATION_FAILED')
    expect(normalized.message).toContain('[REDACTED_KEY]')
  })

  it('28. no plaintext key appears in captured logs', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secretKey = 'sk-sensitive-logger-test'

    registerFailingProviderIpcHandlers(() => mockWindow, `Failure with key ${secretKey}`)
    await expect(invokeHandler(PROVIDER_IPC_CHANNELS.GET_CATALOG)).rejects.toThrow()

    for (const call of consoleSpy.mock.calls) {
      const output = call.join(' ')
      expect(output).not.toContain(secretKey)
    }
  })

  it('29. no raw Electron objects cross into Renderer', () => {
    const mockIpc = {
      invoke: vi.fn().mockResolvedValue({ id: '1', label: 'test' }),
      on: vi.fn(),
      removeListener: vi.fn()
    } as unknown as typeof import('electron').ipcRenderer

    const preloadApi = createProvidersApi(mockIpc)
    // Verify no prototype links to Electron EventEmitter, ipcRenderer, or process
    const apiRecords = preloadApi as unknown as Record<string, unknown>
    expect(apiRecords['ipcRenderer']).toBeUndefined()
    expect(apiRecords['process']).toBeUndefined()
    expect(preloadApi.constructor.name).toBe('Object')
  })

  // ==========================================
  // SECTION 5: Streaming (30 - 40)
  // ==========================================

  it('30. stream port is associated with the correct request', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Stream Association',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    const payload: StreamStartIpcPayload = {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Stream test' }]
      }
    }

    const startRes = (await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, payload)) as {
      started: true
    }
    expect(startRes.started).toBe(true)

    expect(mockMainFrame.postMessage).toHaveBeenCalledWith(
      PROVIDER_IPC_CHANNELS.STREAM_PORT,
      { streamId },
      expect.any(Array)
    )
  })

  it('31. ordered text events reach the correct caller', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Stream Delivery',
      apiKey: 'sk-test'
    })

    let capturedPort: MockMessagePortMain | null = null
    const customStreamManager = new ProviderStreamManager({
      channelFactory: () => {
        const channel = createMockMessageChannel()
        capturedPort = channel.port2 as MockMessagePortMain
        return channel
      }
    })

    registerProviderIpcHandlers(() => mockWindow, service, {
      streamManager: customStreamManager
    })

    const streamId = crypto.randomUUID()
    const deliveredEvents: ProviderStreamEvent[] = []

    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      const port2 = transfer![0] as MockMessagePortMain
      port2.on('message', (e) => {
        deliveredEvents.push(e.data as ProviderStreamEvent)
      })
      port2.start()
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Hi' }]
      }
    })

    // Allow async stream consumption to complete
    await new Promise((r) => setTimeout(r, 60))

    expect(deliveredEvents.length).toBe(3)
    expect(deliveredEvents[0]).toEqual({
      type: 'text-delta',
      textDelta: 'Chunk 1 '
    })
    expect(deliveredEvents[1]).toEqual({
      type: 'text-delta',
      textDelta: 'Chunk 2'
    })
    expect(deliveredEvents[2].type).toBe('finish')
    expect(capturedPort).not.toBeNull()
  })

  it('32. finish event is delivered', async () => {
    const summary = await service.createConnection({
      providerId: 'anthropic',
      label: 'Stream Finish',
      apiKey: 'sk-test'
    })

    const deliveredEvents: ProviderStreamEvent[] = []
    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      const port2 = transfer![0] as MockMessagePortMain
      port2.on('message', (e) => {
        deliveredEvents.push(e.data as ProviderStreamEvent)
      })
      port2.start()
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId: crypto.randomUUID(),
      connectionId: summary.id,
      modelId: 'claude-sonnet-5-5',
      options: {
        messages: [{ role: 'user', content: 'Finish test' }]
      }
    })

    await new Promise((r) => setTimeout(r, 60))

    const finishEvent = deliveredEvents.find((e) => e.type === 'finish')
    expect(finishEvent).toBeDefined()
    if (finishEvent && finishEvent.type === 'finish') {
      expect(finishEvent.finishReason).toBe('stop')
      expect(finishEvent.usage.totalTokens).toBe(13)
    }
  })

  it('33. sanitized provider error is delivered', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Stream Error',
      apiKey: 'sk-test'
    })

    mockOpenAI.streamText.mockImplementationOnce(async function* () {
      yield { type: 'text-delta', textDelta: 'Initial' }
      throw new Error('Provider internal crash with secret sk-super-secret-error-key')
    })

    const deliveredEvents: ProviderStreamEvent[] = []
    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      const port2 = transfer![0] as MockMessagePortMain
      port2.on('message', (e) => {
        deliveredEvents.push(e.data as ProviderStreamEvent)
      })
      port2.start()
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId: crypto.randomUUID(),
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Error trigger' }]
      }
    })

    await new Promise((r) => setTimeout(r, 60))

    const errorEvent = deliveredEvents.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent && errorEvent.type === 'error') {
      expect(errorEvent.error.message).not.toContain('sk-super-secret-error-key')
      expect(errorEvent.error.message).toContain('[REDACTED_KEY]')
    }
  })

  it('34. cancellation aborts the underlying operation', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Cancel Test',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    let clientPort: MockMessagePortMain | null = null

    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      clientPort = transfer![0] as MockMessagePortMain
      clientPort.start()
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Cancel test' }]
      }
    })

    expect(streamManager.hasStream(streamId)).toBe(true)

    // Send cancellation message through client port
    clientPort!.postMessage({ type: 'cancel' })

    await new Promise((r) => setTimeout(r, 30))
    expect(streamManager.hasStream(streamId)).toBe(false)
  })

  it('35. window closure aborts active streams', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Close Window Test',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Close test' }]
      }
    })

    expect(streamManager.hasStream(streamId)).toBe(true)

    // Simulate window closure event
    for (const listener of windowClosedListeners) {
      listener()
    }

    expect(streamManager.hasStream(streamId)).toBe(false)
  })

  it('36. navigation cancels active streams', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Nav Window Test',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Nav test' }]
      }
    })

    expect(streamManager.hasStream(streamId)).toBe(true)

    // Simulate window did-start-navigation event
    for (const listener of windowNavigationListeners) {
      listener()
    }

    expect(streamManager.hasStream(streamId)).toBe(false)
  })

  it('37. disconnected ports clean up sessions', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Disconnect Test',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    let clientPort: MockMessagePortMain | null = null

    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      clientPort = transfer![0] as MockMessagePortMain
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Port close test' }]
      }
    })

    expect(streamManager.hasStream(streamId)).toBe(true)

    // Client closes the message port
    clientPort!.close()

    await new Promise((r) => setTimeout(r, 30))
    expect(streamManager.hasStream(streamId)).toBe(false)
  })

  it('38. cross-window cancellation is rejected', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Cross-Window Test',
      apiKey: 'sk-test'
    })

    const streamId = crypto.randomUUID()
    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId,
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Window test' }]
      }
    })

    // Other window attempts to abort streams
    const otherWindow: BrowserWindowLike = {
      isDestroyed: () => false,
      webContents: { mainFrame: mockMainFrame as unknown as WebFrameMainLike }
    }

    const count = streamManager.abortWindowStreams(otherWindow)
    expect(count).toBe(0)
    // Stream belongs to mockWindow, so it remains active
    expect(streamManager.hasStream(streamId)).toBe(true)
  })

  it('39. concurrent stream limits are enforced', async () => {
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Concurrency Limit',
      apiKey: 'sk-test'
    })

    // Start 3 streams (maxStreams = 3 configured in beforeEach)
    for (let i = 0; i < 3; i++) {
      await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
        streamId: crypto.randomUUID(),
        connectionId: summary.id,
        modelId: 'gpt-6-luna',
        options: {
          messages: [{ role: 'user', content: `Stream ${i}` }]
        }
      })
    }

    // 4th stream must be rejected with concurrency limit error
    await expect(
      invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
        streamId: crypto.randomUUID(),
        connectionId: summary.id,
        modelId: 'gpt-6-luna',
        options: {
          messages: [{ role: 'user', content: 'Stream 4' }]
        }
      })
    ).rejects.toThrow('Maximum concurrent streams limit (3) exceeded')
  })

  it('40. no secret or credential reference appears in stream events', async () => {
    const secretKey = 'sk-proj-CONFIDENTIAL-STREAM-KEY-9999'
    const summary = await service.createConnection({
      providerId: 'openai',
      label: 'Stream Secret Test',
      apiKey: secretKey
    })

    const deliveredEvents: ProviderStreamEvent[] = []
    mockMainFrame.postMessage = vi.fn((_channel, _msg, transfer) => {
      const port2 = transfer![0] as MockMessagePortMain
      port2.on('message', (e) => {
        deliveredEvents.push(e.data as ProviderStreamEvent)
      })
      port2.start()
    })

    await invokeHandler(PROVIDER_IPC_CHANNELS.STREAM_START, {
      streamId: crypto.randomUUID(),
      connectionId: summary.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'Check events' }]
      }
    })

    await new Promise((r) => setTimeout(r, 60))

    for (const event of deliveredEvents) {
      const serialized = JSON.stringify(event)
      expect(serialized).not.toContain(secretKey)
      expect(serialized).not.toContain('cred_')
    }
  })
})
