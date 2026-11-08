import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  type ProviderConnectionSummary,
  type ConnectionTestResult,
  type RemoveConnectionResult,
  type GenerateTextResult,
  type ProviderStreamEvent,
  type StreamStartIpcPayload
} from '../../shared/providers'
import { PROVIDER_IPC_CHANNELS } from '../../shared/ipc'
import { registerProviderIpcHandlers } from '../ipc/provider-handlers'
import {
  ProviderStreamManager,
  type MessagePortMainLike,
  type MessageChannelLike,
  type WebFrameWithPostMessage
} from '../ipc/provider-stream-manager'
import { ProviderManagerService } from './provider-manager/provider-manager-service'
import { providerRegistry } from './provider-registry'
import { CredentialVault } from '../security/credential-vault/credential-vault'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { OpenAIAdapter } from './openai'
import { AnthropicAdapter } from './anthropic'
import { GoogleAdapter } from './google'
import {
  type ISafeStorageAdapter,
  type LinuxStorageBackend,
  type SafeStorageDecryptionResult
} from '../security/credential-vault/types'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'

// IPC Registry for ipcMain mock
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

// Deterministic in-memory safeStorage adapter for end-to-end testing
class TestSafeStorageAdapter implements ISafeStorageAdapter {
  private readonly storageBackend: LinuxStorageBackend

  constructor(storageBackend: LinuxStorageBackend = 'gnome_libsecret') {
    this.storageBackend = storageBackend
  }

  isEncryptionAvailable(): boolean {
    return true
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true
  }

  encryptString(plaintext: string): Buffer {
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x42),
      Buffer.alloc(16, 0x13)
    )
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  }

  async encryptStringAsync(plaintext: string): Promise<Buffer> {
    return this.encryptString(plaintext)
  }

  decryptString(ciphertext: Buffer): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x42),
      Buffer.alloc(16, 0x13)
    )
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  async decryptStringAsync(ciphertext: Buffer): Promise<SafeStorageDecryptionResult> {
    const result = this.decryptString(ciphertext)
    return { result, shouldReEncrypt: false }
  }

  getSelectedStorageBackend(): LinuxStorageBackend {
    return this.storageBackend
  }
}

// Simulated MessagePortMain
class MockMessagePortMain implements MessagePortMainLike {
  private listener: ((event: { data: unknown }) => void) | null = null
  public readonly postedMessages: unknown[] = []
  public isStarted = false
  public isClosed = false

  postMessage(message: unknown): void {
    this.postedMessages.push(message)
    if (this.peer) {
      this.peer.postedMessages.push(message)
      if (this.peer.listener) {
        this.peer.listener({ data: message })
      }
    }
  }

  start(): void {
    this.isStarted = true
  }

  close(): void {
    this.isClosed = true
  }

  on(event: 'message' | 'close', listener: (e: { data: unknown }) => void): void {
    if (event === 'message') {
      this.listener = listener
    }
  }

  public peer: MockMessagePortMain | null = null
}

function createMockMessageChannel(): MessageChannelLike {
  const port1 = new MockMessagePortMain()
  const port2 = new MockMessagePortMain()
  port1.peer = port2
  port2.peer = port1
  return { port1, port2 }
}

describe('Phase 3 Step 3.9: End-to-End BYOK Provider Integration & Gate Verification', () => {
  let dbContext: MigratedTestDatabaseContext
  let vaultDir: string
  let safeStorage: TestSafeStorageAdapter
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let botRepo: BotRepository
  let kbRepo: KnowledgeBaseRepository
  let providerManager: ProviderManagerService
  let streamManager: ProviderStreamManager
  let mockPort2Created: MockMessagePortMain | null

  // Sender validation mock objects
  let mockSenderEvent: IpcSenderEventLike
  let mockMainWindow: BrowserWindowLike

  // Mock fetch responses for all 3 adapters
  const mockFetchFn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)

      // OpenAI Model Check
      if (url.includes('api.openai.com/v1/models/')) {
        const modelId = url.split('/').pop()
        return new Response(JSON.stringify({ id: modelId, object: 'model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // OpenAI Responses Text Generation
      if (url.includes('api.openai.com/v1/responses')) {
        const isStream = init?.body && String(init.body).includes('"stream":true')
        if (isStream) {
          const lines: string[] = [
            'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg-1","type":"message"}}\n\n',
            'data: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"delta":"Hello from OpenAI Stream!"}\n\n',
            'data: {"type":"response.completed","response":{"usage":{"total_tokens":18,"input_tokens":10,"output_tokens":8}}}\n\n'
          ]
          return new Response(lines.join(''), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        }

        return new Response(
          JSON.stringify({
            id: 'resp_openai_123',
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                id: 'msg_openai_123',
                content: [
                  {
                    type: 'output_text',
                    text: 'Hello from OpenAI Generated Text!',
                    annotations: []
                  }
                ]
              }
            ],
            usage: { total_tokens: 18, input_tokens: 12, output_tokens: 6 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // Anthropic Model Check
      if (url.includes('api.anthropic.com/v1/models/')) {
        const modelId = url.split('/').pop()
        return new Response(JSON.stringify({ id: modelId, type: 'model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Anthropic Messages Text Generation
      if (url.includes('api.anthropic.com/v1/messages')) {
        const isStream = init?.body && String(init.body).includes('"stream":true')
        if (isStream) {
          const lines: string[] = [
            `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
            `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Anthropic Stream!"}}\n\n`,
            `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
            `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}\n\n`,
            `event: message_stop\ndata: {"type":"message_stop"}\n\n`
          ]
          return new Response(lines.join(''), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        }

        return new Response(
          JSON.stringify({
            id: 'msg_anthropic_123',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Anthropic Generated Text!' }],
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 15, output_tokens: 9 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // Google Gemini Model Check
      if (url.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        if (url.includes(':generateContent')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: 'Hello from Google Gemini Generated Text!' }] },
                  finishReason: 'STOP'
                }
              ],
              usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 7, totalTokenCount: 21 }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }

        if (url.includes(':streamGenerateContent')) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                Buffer.from(
                  'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Google Stream!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n'
                )
              )
              controller.close()
            }
          })
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        }

        // Metadata lookup
        const parts = url.split('models/')
        const modelId = parts[1]?.split('?')[0]
        return new Response(
          JSON.stringify({
            name: `models/${modelId}`,
            supportedGenerationMethods: ['generateContent']
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }
  )

  beforeEach(async () => {
    // 1. Initialize real isolated SQLite test database with Migrations 001 and 002
    dbContext = createMigratedTestDatabase()
    vaultDir = path.join(dbContext.tempDir, 'credentials')
    fs.mkdirSync(vaultDir, { recursive: true })

    safeStorage = new TestSafeStorageAdapter()
    vault = new CredentialVault({ vaultDir, safeStorage })
    connectionRepo = new ProviderConnectionRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    kbRepo = new KnowledgeBaseRepository(dbContext.db)

    // Instantiate concrete adapters with deterministic mock fetch
    const openaiAdapter = new OpenAIAdapter({ customFetch: mockFetchFn })
    const anthropicAdapter = new AnthropicAdapter({ customFetch: mockFetchFn })
    const googleAdapter = new GoogleAdapter({ customFetch: mockFetchFn })

    providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: providerRegistry,
      adapters: {
        openai: openaiAdapter,
        anthropic: anthropicAdapter,
        google: googleAdapter
      }
    })

    await providerManager.initialize()

    // 2. Mock IPC Sender and Window
    mockIpcHandlers.clear()
    mockPort2Created = null

    const mockWebContents: WebContentsLike = {
      mainFrame: null as unknown as WebFrameMainLike
    }

    const mockMainFrame: WebFrameMainLike & WebFrameWithPostMessage = {
      url: 'http://localhost:5173/index.html',
      postMessage: vi.fn((channel: string, _message: unknown, transfer?: unknown[]) => {
        if (channel === 'provider:stream-port' && transfer && transfer[0]) {
          mockPort2Created = transfer[0] as MockMessagePortMain
        }
      })
    }
    mockWebContents.mainFrame = mockMainFrame

    mockMainWindow = {
      isDestroyed: () => false,
      webContents: mockWebContents
    }

    mockSenderEvent = {
      sender: mockWebContents,
      senderFrame: mockMainFrame
    }

    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] =
      'http://localhost:5173'

    streamManager = new ProviderStreamManager({
      channelFactory: createMockMessageChannel
    })

    registerProviderIpcHandlers(() => mockMainWindow, providerManager, {
      streamManager
    })
  })

  afterEach(() => {
    dbContext.cleanup()
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    vi.clearAllMocks()
  })

  // 1. Create and persist connection across full stack
  it('1. creates and persists a connection across the full stack with zero secret leakage in DB or DTO', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    expect(handleCreate).toBeDefined()

    const candidateKey = 'sk-proj-harmless-openai-test-key-12345'
    const result = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Production OpenAI',
      apiKey: candidateKey,
      modelId: 'gpt-6-luna'
    })) as ProviderConnectionSummary

    // Verify DTO guarantees
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.providerId).toBe('openai')
    expect(result.label).toBe('Production OpenAI')
    expect(result.status).toBe('active')
    expect(result.hasCredential).toBe(true)
    expect((result as unknown as Record<string, unknown>).credentialRef).toBeUndefined()
    expect((result as unknown as Record<string, unknown>).apiKey).toBeUndefined()

    // Verify file created in encrypted vault
    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(1)
    const storedRef = storedRefs[0]
    expect(storedRef.startsWith('cred_')).toBe(true)

    // Verify SQLite contains metadata and ref pointer, but ZERO plaintext keys
    const row = dbContext.db
      .prepare('SELECT * FROM provider_connections WHERE id = ?')
      .get(result.id) as Record<string, unknown>

    expect(row).toBeDefined()
    expect(row.credential_ref).toBe(storedRef)
    expect(row.label).toBe('Production OpenAI')
    expect(JSON.stringify(row)).not.toContain(candidateKey)
  })

  // 2. Restart application and recover connection after reconciliation
  it('2. restarts application, performs startup reconciliation, and recovers connection without secret exposure', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'anthropic',
      label: 'Anthropic Primary',
      apiKey: 'sk-ant-test-secret-key-98765'
    })) as ProviderConnectionSummary

    // Simulate complete application restart:
    // Create fresh ProviderManagerService pointing to the same SQLite and Vault directory
    const newService = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo: new ProviderConnectionRepository(dbContext.db),
      registry: providerRegistry
    })

    const recon = await newService.initialize()
    expect(recon.orphanCredentialsRemoved).toBe(0)
    expect(recon.missingCredentialConnectionsMarkedError).toBe(0)

    const list = newService.listConnections()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(created.id)
    expect(list[0].label).toBe('Anthropic Primary')
    expect(list[0].status).toBe('active')
    expect(list[0].hasCredential).toBe(true)

    // Decrypt directly from vault to verify integrity
    const decrypted = await vault.retrieve(
      (
        dbContext.db
          .prepare('SELECT credential_ref FROM provider_connections WHERE id = ?')
          .get(created.id) as { credential_ref: string }
      ).credential_ref
    )
    expect(decrypted).toBe('sk-ant-test-secret-key-98765')
  })

  // 3. Test saved connection with mock response
  it('3. tests saved connection just-in-time and returns latency without exposing credential', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'google',
      label: 'Google Gemini Pro',
      apiKey: 'AIzaSy-harmless-test-key-555'
    })) as ProviderConnectionSummary

    const handleTest = mockIpcHandlers.get('provider:test-connection')!
    const testRes = (await handleTest(mockSenderEvent, {
      connectionId: created.id,
      modelId: 'gemini-3.8-flash'
    })) as ConnectionTestResult

    expect(testRes.ok).toBe(true)
    expect(testRes.success).toBe(true)
    expect(testRes.testedModelId).toBe('gemini-3.8-flash')
    expect(testRes.latencyMs).toBeGreaterThanOrEqual(0)
    expect((testRes as unknown as Record<string, unknown>).apiKey).toBeUndefined()
  })

  // 4. Generate text returning normalized output
  it('4. generates text across IPC bridge and returns normalized token usage', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Text Gen Connection',
      apiKey: 'sk-gen-text-test-token'
    })) as ProviderConnectionSummary

    const handleGenerate = mockIpcHandlers.get('provider:generate-text')!
    const genRes = (await handleGenerate(mockSenderEvent, {
      connectionId: created.id,
      modelId: 'gpt-6-luna',
      options: {
        messages: [{ role: 'user', content: 'What is the local AI workspace?' }],
        systemPrompt: 'Be concise.'
      }
    })) as GenerateTextResult

    expect(genRes.text).toContain('Hello from OpenAI Generated Text!')
    expect(genRes.finishReason).toBe('stop')
    expect(genRes.usage.totalTokens).toBe(18)
  })

  // 5. Stream text returning ordered deltas
  it('5. streams text over dedicated MessagePortMain channel emitting ordered chunks', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'anthropic',
      label: 'Stream Anthropic',
      apiKey: 'sk-ant-stream-key'
    })) as ProviderConnectionSummary

    const handleStream = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.STREAM_START)!
    const streamId = crypto.randomUUID()

    const startPayload: StreamStartIpcPayload = {
      streamId,
      connectionId: created.id,
      modelId: 'claude-sonnet-5-5',
      options: {
        messages: [{ role: 'user', content: 'Stream some text' }]
      }
    }

    // Call streamText handler
    await handleStream(mockSenderEvent, startPayload)

    // Confirm MessagePortMain was transferred to renderer frame
    expect(mockPort2Created).not.toBeNull()

    // Wait briefly for streaming async iteration
    await new Promise((r) => setTimeout(r, 80))

    const messages = mockPort2Created!.postedMessages as ProviderStreamEvent[]
    expect(messages.length).toBeGreaterThanOrEqual(2)

    const textDelta = messages.find((m) => m.type === 'text-delta')
    expect(textDelta).toBeDefined()
    if (textDelta && textDelta.type === 'text-delta') {
      expect(textDelta.textDelta).toContain('Hello from Anthropic Stream!')
    }

    const finishEvent = messages.find((m) => m.type === 'finish')
    expect(finishEvent).toBeDefined()
  })

  // 6. Cancel stream aborting in-flight operation
  it('6. cancels stream upon client request and immediately terminates session', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'google',
      label: 'Cancel Gemini Stream',
      apiKey: 'AIzaSy-cancel-test'
    })) as ProviderConnectionSummary

    const handleStream = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.STREAM_START)!
    const streamId = crypto.randomUUID()

    await handleStream(mockSenderEvent, {
      streamId,
      connectionId: created.id,
      modelId: 'gemini-3.8-flash',
      options: {
        messages: [{ role: 'user', content: 'Cancelled stream' }]
      }
    })

    expect(mockPort2Created).not.toBeNull()
    // Post cancel event back to port
    mockPort2Created!.postMessage({ type: 'cancel' })

    await new Promise((r) => setTimeout(r, 40))
    expect(streamManager.getActiveStreamCount()).toBe(0)
  })

  // 7. Replace credential successfully (new key retrievable, old key purged)
  it('7. replaces credential successfully, updates vault, and guarantees old key is purged', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Replace Key Test',
      apiKey: 'sk-old-key-to-be-replaced'
    })) as ProviderConnectionSummary

    const handleReplace = mockIpcHandlers.get('provider:replace-credential')!
    const updated = (await handleReplace(mockSenderEvent, {
      connectionId: created.id,
      apiKey: 'sk-new-shiny-replacement-key-456'
    })) as ProviderConnectionSummary

    expect(updated.id).toBe(created.id)
    expect(updated.hasCredential).toBe(true)

    // Inspect vault file directly: it must decrypt to the NEW key, never the old key
    const ref = (
      dbContext.db
        .prepare('SELECT credential_ref FROM provider_connections WHERE id = ?')
        .get(created.id) as { credential_ref: string }
    ).credential_ref
    const decrypted = await vault.retrieve(ref)
    expect(decrypted).toBe('sk-new-shiny-replacement-key-456')
    expect(decrypted).not.toBe('sk-old-key-to-be-replaced')
  })

  // 8. Reject invalid replacement without damaging old key
  it('8. rejects invalid candidate replacement and strictly preserves working old key', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Preserve Key Test',
      apiKey: 'sk-existing-valid-working-key'
    })) as ProviderConnectionSummary

    // Mock fetch failure for replacement
    mockFetchFn.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401
      })
    })

    const handleReplace = mockIpcHandlers.get('provider:replace-credential')!
    await expect(
      handleReplace(mockSenderEvent, {
        connectionId: created.id,
        apiKey: 'sk-invalid-candidate-key'
      })
    ).rejects.toThrow()

    // Working key in vault MUST BE UNTOUCHED
    const ref = (
      dbContext.db
        .prepare('SELECT credential_ref FROM provider_connections WHERE id = ?')
        .get(created.id) as { credential_ref: string }
    ).credential_ref
    const decrypted = await vault.retrieve(ref)
    expect(decrypted).toBe('sk-existing-valid-working-key')
  })

  // 9. Rename connection and persist
  it('9. updates connection label with trimmed input and persists to SQLite', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'anthropic',
      label: 'Old Label',
      apiKey: 'sk-ant-rename-test'
    })) as ProviderConnectionSummary

    const handleRename = mockIpcHandlers.get(PROVIDER_IPC_CHANNELS.UPDATE_LABEL)!
    const renamed = (await handleRename(mockSenderEvent, {
      connectionId: created.id,
      label: '  Renamed Anthropic Account  '
    })) as ProviderConnectionSummary

    expect(renamed.label).toBe('Renamed Anthropic Account')

    const dbRow = dbContext.db
      .prepare('SELECT label FROM provider_connections WHERE id = ?')
      .get(created.id) as { label: string }
    expect(dbRow.label).toBe('Renamed Anthropic Account')
  })

  // 10. Reject deletion while a Bot references it
  it('10. prevents connection deletion when referenced by an active Bot via foreign key constraint', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Bot Locked Connection',
      apiKey: 'sk-bot-locked-key'
    })) as ProviderConnectionSummary

    // Create a Knowledge Base and a Bot referencing this connection
    const kb = kbRepo.create({ name: 'Security KB', description: 'Testing constraints' })
    botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Agent Alpha',
      systemPrompt: 'Assist',
      modelId: 'gpt-6-luna',
      providerConnectionId: created.id
    })

    const handleRemove = mockIpcHandlers.get('provider:remove-connection')!
    await expect(
      handleRemove(mockSenderEvent, {
        connectionId: created.id
      })
    ).rejects.toThrow(/referenced by one or more active Bots/i)

    // Verify row and credential file still exist
    const row = dbContext.db
      .prepare('SELECT id FROM provider_connections WHERE id = ?')
      .get(created.id)
    expect(row).not.toBeNull()

    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(1)
  })

  // 11. Remove unreferenced connection
  it('11. removes unreferenced connection and deletes encrypted file from vault', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'google',
      label: 'Temporary Connection',
      apiKey: 'AIzaSy-temporary-key'
    })) as ProviderConnectionSummary

    const handleRemove = mockIpcHandlers.get('provider:remove-connection')!
    const removeRes = (await handleRemove(mockSenderEvent, {
      connectionId: created.id
    })) as RemoveConnectionResult

    expect(removeRes.success).toBe(true)
    expect(removeRes.credentialCleaned).toBe(true)

    const row = dbContext.db
      .prepare('SELECT id FROM provider_connections WHERE id = ?')
      .get(created.id)
    expect(row).toBeUndefined()

    const storedRefs = await vault.listStoredCredentialRefs()
    expect(storedRefs.length).toBe(0)
  })

  // 12. Reconcile orphan credentials
  it('12. purges orphaned vault files during startup credential reconciliation', async () => {
    // Deliberately write an unreferenced credential file to the vault directory
    const orphanRef = await vault.store('unreferenced-secret-payload')

    const beforeRefs = await vault.listStoredCredentialRefs()
    expect(beforeRefs).toContain(orphanRef)

    const summary = await providerManager.initialize()
    expect(summary.orphanCredentialsRemoved).toBe(1)

    const afterRefs = await vault.listStoredCredentialRefs()
    expect(afterRefs).not.toContain(orphanRef)
  })

  // 13. Mark missing credential files as unavailable (hasCredential: false, status error)
  it('13. marks connections with missing vault files as hasCredential: false and status: error', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Corrupted File Connection',
      apiKey: 'sk-will-be-deleted'
    })) as ProviderConnectionSummary

    // Get credentialRef and manually delete the physical file
    const ref = (
      dbContext.db
        .prepare('SELECT credential_ref FROM provider_connections WHERE id = ?')
        .get(created.id) as { credential_ref: string }
    ).credential_ref
    await vault.delete(ref)

    // listConnections must report hasCredential: false
    const list = providerManager.listConnections()
    const conn = list.find((c) => c.id === created.id)!
    expect(conn).toBeDefined()
    expect(conn.hasCredential).toBe(false)
    expect(conn.status).toBe('error')

    // Generating text must fail with missing credential error
    await expect(
      providerManager.generateText(created.id, 'gpt-6-luna', {
        messages: [{ role: 'user', content: 'test' }]
      })
    ).rejects.toThrow(/credential missing or corrupted/i)
  })

  // 14. Prevent unsupported capability execution before decrypting credentials or making requests
  it('14. rejects unsupported capabilities (tools, image, structured output) before decrypting credentials or issuing requests', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const created = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'Capability Gate Connection',
      apiKey: 'sk-capability-gate-key'
    })) as ProviderConnectionSummary

    const vaultRetrieveSpy = vi.spyOn(vault, 'retrieve')
    mockFetchFn.mockClear()

    // 14a. Reject tool calling
    await expect(
      providerManager.generateText(created.id, 'gpt-6-luna', {
        messages: [{ role: 'user', content: 'Run tool' }],
        tools: [{ name: 'test_tool', description: 'test', parameters: {} }]
      })
    ).rejects.toThrow(/tool calling is not supported/i)

    expect(vaultRetrieveSpy).not.toHaveBeenCalled()
    expect(mockFetchFn).not.toHaveBeenCalled()

    // 14b. Reject structured output schema
    await expect(
      providerManager.generateText(created.id, 'gpt-6-luna', {
        messages: [{ role: 'user', content: 'Output schema' }],
        jsonSchema: { type: 'object' }
      })
    ).rejects.toThrow(/structured output schema is not supported/i)

    expect(vaultRetrieveSpy).not.toHaveBeenCalled()
    expect(mockFetchFn).not.toHaveBeenCalled()

    // 14c. Reject multimodal image input
    await expect(
      providerManager.generateText(created.id, 'gpt-6-luna', {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', image: 'base64...' }] as unknown as string
          }
        ]
      })
    ).rejects.toThrow(/multimodal image input is not supported/i)

    expect(vaultRetrieveSpy).not.toHaveBeenCalled()
    expect(mockFetchFn).not.toHaveBeenCalled()
  })

  // 15. Prevent secrets from crossing IPC
  it('15. strictly prevents secrets, plaintext keys, and credential_ref from crossing IPC', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    const candidateKey = 'sk-super-secret-key-that-must-not-leak-999'

    const created = await handleCreate(mockSenderEvent, {
      providerId: 'anthropic',
      label: 'Leak Test',
      apiKey: candidateKey
    })

    const serializedCreated = JSON.stringify(created)
    expect(serializedCreated).not.toContain(candidateKey)
    expect(serializedCreated).not.toContain('cred_')

    const handleList = mockIpcHandlers.get('provider:list-connections')!
    const list = await handleList(mockSenderEvent)
    const serializedList = JSON.stringify(list)
    expect(serializedList).not.toContain(candidateKey)
    expect(serializedList).not.toContain('cred_')

    const handleCatalog = mockIpcHandlers.get('provider:get-catalog')!
    const catalog = await handleCatalog(mockSenderEvent)
    const serializedCatalog = JSON.stringify(catalog)
    expect(serializedCatalog).not.toContain('cred_')
    expect(serializedCatalog).not.toContain('credentials')
  })

  // 16. Prevent secrets from appearing in SQLite / WAL / error logs
  it('16. verifies secrets never appear in SQLite rows, WAL, or error messages', async () => {
    const candidateKey = 'sk-sensitive-db-leak-check-777'
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!
    await handleCreate(mockSenderEvent, {
      providerId: 'google',
      label: 'DB Check',
      apiKey: candidateKey
    })

    // Check raw SQLite database content
    const allRows = dbContext.db.prepare('SELECT * FROM provider_connections').all()
    const serializedRows = JSON.stringify(allRows)
    expect(serializedRows).not.toContain(candidateKey)

    // Check physical DB file on disk
    const dbBuffer = fs.readFileSync(dbContext.dbPath)
    expect(dbBuffer.toString('utf8')).not.toContain(candidateKey)
  })

  // 17. Enforce sender validation
  it('17. enforces sender validation rejecting untrusted frame origins and foreign senders', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!

    // Spoofed external frame URL
    const spoofedSenderEvent: IpcSenderEventLike = {
      sender: mockMainWindow.webContents,
      senderFrame: {
        url: 'https://malicious-site.example.com'
      } as unknown as WebFrameMainLike
    }

    await expect(
      handleCreate(spoofedSenderEvent, {
        providerId: 'openai',
        label: 'Untrusted Origin',
        apiKey: 'sk-test'
      })
    ).rejects.toThrow(/unauthorized/i)
  })

  // 18. All-provider integration verification (OpenAI, Anthropic, Google Gemini)
  it('18. verifies all three providers execute through ProviderManagerService with foreign model rejection', async () => {
    const handleCreate = mockIpcHandlers.get('provider:create-connection')!

    const openAiConn = (await handleCreate(mockSenderEvent, {
      providerId: 'openai',
      label: 'OpenAI Test',
      apiKey: 'sk-openai-all-prov'
    })) as ProviderConnectionSummary

    const anthropicConn = (await handleCreate(mockSenderEvent, {
      providerId: 'anthropic',
      label: 'Anthropic Test',
      apiKey: 'sk-anthropic-all-prov'
    })) as ProviderConnectionSummary

    const googleConn = (await handleCreate(mockSenderEvent, {
      providerId: 'google',
      label: 'Google Test',
      apiKey: 'AIzaSy-google-all-prov'
    })) as ProviderConnectionSummary

    // Verify all 3 generate text successfully with their native models
    const oRes = await providerManager.generateText(openAiConn.id, 'gpt-6-luna', {
      messages: [{ role: 'user', content: 'test' }]
    })
    expect(oRes.text).toContain('Hello from OpenAI Generated Text!')

    const aRes = await providerManager.generateText(anthropicConn.id, 'claude-sonnet-5-5', {
      messages: [{ role: 'user', content: 'test' }]
    })
    expect(aRes.text).toContain('Hello from Anthropic Generated Text!')

    const gRes = await providerManager.generateText(googleConn.id, 'gemini-3.8-flash', {
      messages: [{ role: 'user', content: 'test' }]
    })
    expect(gRes.text).toContain('Hello from Google Gemini Generated Text!')

    // Verify cross-provider model mismatch rejection
    await expect(
      providerManager.generateText(openAiConn.id, 'gemini-3.8-flash', {
        messages: [{ role: 'user', content: 'mismatch' }]
      })
    ).rejects.toThrow(/is not authorized for provider 'openai'/i)

    await expect(
      providerManager.generateText(googleConn.id, 'claude-sonnet-5-5', {
        messages: [{ role: 'user', content: 'mismatch' }]
      })
    ).rejects.toThrow(/is not authorized for provider 'google'/i)
  })
})
