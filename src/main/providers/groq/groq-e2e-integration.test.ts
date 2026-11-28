import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { ProviderConnectionRepository } from '../../database/repositories/provider-connection-repository'
import { ConversationRepository } from '../../database/repositories/conversation-repository'
import { MessageRepository } from '../../database/repositories/message-repository'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { BotMemoryRepository } from '../../database/repositories/bot-memory-repository'
import { AgentRunRepository } from '../../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../../database/repositories/tool-event-repository'
import { DocumentStorageManager } from '../../documents/document-storage-manager'
import { CredentialVault } from '../../security/credential-vault/credential-vault'
import type {
  ISafeStorageAdapter,
  LinuxStorageBackend,
  SafeStorageDecryptionResult
} from '../../security/credential-vault/types'
import { ProviderRegistry } from '../provider-registry'
import { ProviderManagerService } from '../provider-manager/provider-manager-service'
import { GroqAdapter } from './groq-adapter'
import { BotManagerService } from '../../services/bot-manager'
import { ActiveWorkspaceContext } from '../../services/active-workspace-context'
import { ConversationService } from '../../services/conversation-service'
import { ConversationExecutionService } from '../../services/conversation-execution-service'
import { AiSdkAgentModelStepExecutor } from '../../agents/ai-sdk-agent-model-step-executor'
import { BoundedAgentRuntime } from '../../services/bounded-agent-runtime'
import { ApprovalController } from '../../services/approval-controller'
import { WorkspaceFolderService } from '../../services/workspace-folder-service'
import { ToolRegistry } from '../../tools/tool-registry'
import type { AgentTool } from '../../tools/agent-tool'
import { BackupExportManager } from '../../services/backup-export-manager'
import { BackupImportManager } from '../../services/backup-import-manager'
import { defaultSecretScanner } from '../../services/secret-scanner'
import { sanitizeConversationErrorMessage } from '../../ipc/conversation-validation'
import { sanitizeAgentErrorMessage } from '../../ipc/agent-validation'

class DeterministicTestSafeStorage implements ISafeStorageAdapter {
  private readonly backend: LinuxStorageBackend
  constructor(backend: LinuxStorageBackend = 'gnome_libsecret') {
    this.backend = backend
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
      Buffer.alloc(32, 0x2a),
      Buffer.alloc(16, 0x11)
    )
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  }
  async encryptStringAsync(plaintext: string): Promise<Buffer> {
    return this.encryptString(plaintext)
  }
  decryptString(ciphertext: Buffer): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x2a),
      Buffer.alloc(16, 0x11)
    )
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
  async decryptStringAsync(ciphertext: Buffer): Promise<SafeStorageDecryptionResult> {
    return { result: this.decryptString(ciphertext), shouldReEncrypt: false }
  }
  getSelectedStorageBackend(): LinuxStorageBackend {
    return this.backend
  }
}

describe('Groq End-to-End Integration & Dynamic Model Persistence (Phase 13 Step 13.2)', () => {
  let ctx: MigratedTestDatabaseContext
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let cacheFilePath: string
  let activeContext: ActiveWorkspaceContext
  const sessionId = 'test-session-groq-e2e'
  const groqApiKey = 'gsk_e2e_test_groq_key_1234567890abcdefghijklmnop'

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    const vaultDir = path.join(ctx.tempDir, 'vault')
    fs.mkdirSync(vaultDir, { recursive: true })
    vault = new CredentialVault({
      vaultDir,
      safeStorage: new DeterministicTestSafeStorage()
    })
    connectionRepo = new ProviderConnectionRepository(ctx.db)
    cacheFilePath = path.join(ctx.tempDir, 'discovered-models-cache.json')
    activeContext = new ActiveWorkspaceContext(ctx.kbRepo)
  })

  afterEach(() => {
    ctx.cleanup()
    vi.restoreAllMocks()
  })

  it('1. persists discovered Groq models across restart and executes Chat turns with zero extra /models calls', async () => {
    const kbDir = path.join(ctx.tempDir, 'kb-1')
    fs.mkdirSync(kbDir, { recursive: true })
    const kb = ctx.kbRepo.create({
      name: 'Groq Research KB',
      description: 'Docs'
    })
    activeContext.activateWorkspace(sessionId, kb.id)

    let modelDiscoveryCalls = 0
    const fetchMockPhase1 = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const targetUrl = typeof url === 'string' ? url : url.toString()
      if (targetUrl.endsWith('/models')) {
        modelDiscoveryCalls++
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'llama-3.3-70b-versatile',
                active: true,
                owned_by: 'Meta',
                context_window: 131072,
                max_completion_tokens: 32768
              },
              {
                id: 'groq/dynamic-v2-chat',
                active: true,
                owned_by: 'Groq',
                context_window: 65536,
                max_completion_tokens: 8192
              },
              {
                id: 'whisper-large-v3',
                active: true,
                owned_by: 'OpenAI',
                context_window: 448,
                max_completion_tokens: 448
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1730000000,
          model: 'groq/dynamic-v2-chat',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Dynamic Groq model answer.' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    // First application lifecycle: configure persistence, create Groq connection, create Bot with dynamic model
    const registry1 = new ProviderRegistry()
    registry1.configurePersistence(cacheFilePath)
    const providerManager1 = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: registry1,
      adapters: { groq: new GroqAdapter({ fetchFn: fetchMockPhase1 }) }
    })

    const createdConn = await providerManager1.createConnection({
      providerId: 'groq',
      label: 'My Groq Account',
      apiKey: groqApiKey
    })
    expect(createdConn.providerId).toBe('groq')
    expect(createdConn.availableModels).toEqual(['llama-3.3-70b-versatile', 'groq/dynamic-v2-chat'])
    expect(modelDiscoveryCalls).toBe(1)

    // Verify SQLite NEVER stores plaintext API keys
    const rawDbRows = ctx.db.prepare('SELECT * FROM provider_connections').all()
    expect(JSON.stringify(rawDbRows)).not.toContain(groqApiKey)

    const botManager1 = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry: registry1,
      activeContext
    })

    // Cross-provider pairing must fail
    expect(() =>
      botManager1.createBot(sessionId, {
        name: 'Bad Cross Provider Bot',
        providerConnectionId: createdConn.id,
        modelId: 'gpt-6-luna',
        enabledTools: []
      })
    ).toThrow()

    // Untrusted arbitrary model ID must fail
    expect(() =>
      botManager1.createBot(sessionId, {
        name: 'Untrusted Model Bot',
        providerConnectionId: createdConn.id,
        modelId: 'groq/forged-unauthenticated-model',
        enabledTools: []
      })
    ).toThrow()

    // Selecting discovered Groq model succeeds
    const createdBot = botManager1.createBot(sessionId, {
      name: 'Groq Dynamic Bot',
      providerConnectionId: createdConn.id,
      modelId: 'groq/dynamic-v2-chat',
      responsePolicy: 'general_ai_chat',
      enabledTools: []
    })
    expect(createdBot.modelId).toBe('groq/dynamic-v2-chat')

    // Simulate application restart: brand-new ProviderRegistry & ProviderManagerService
    const fetchMockAfterRestart = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const targetUrl = typeof url === 'string' ? url : url.toString()
      if (targetUrl.endsWith('/models')) {
        throw new Error('Unexpected /models network request after restart')
      }
      const encoder = new TextEncoder()
      const sse =
        `data: ${JSON.stringify({
          id: 'chatcmpl-restart',
          object: 'chat.completion.chunk',
          created: 1730000001,
          model: 'groq/dynamic-v2-chat',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Restart persisted reply.' },
              finish_reason: null
            }
          ]
        })}\n\n` +
        `data: ${JSON.stringify({
          id: 'chatcmpl-restart',
          object: 'chat.completion.chunk',
          created: 1730000001,
          model: 'groq/dynamic-v2-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
        })}\n\n` +
        'data: [DONE]\n\n'
      return new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(sse))
            ctrl.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    })

    const registry2 = new ProviderRegistry()
    registry2.configurePersistence(cacheFilePath)
    const providerManager2 = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: registry2,
      adapters: { groq: new GroqAdapter({ fetchFn: fetchMockAfterRestart }) }
    })

    // Persisted connection summary immediately carries discovered models
    const summariesAfterRestart = providerManager2.listConnections()
    expect(summariesAfterRestart[0].availableModels).toEqual([
      'llama-3.3-70b-versatile',
      'groq/dynamic-v2-chat'
    ])

    // ConversationService + ConversationExecutionService execute Turn without hitting /models
    const conversationRepo = new ConversationRepository(ctx.db)
    const messageRepo = new MessageRepository(ctx.db)
    const conv = conversationRepo.getOrCreate({
      botId: createdBot.id,
      knowledgeBaseId: kb.id,
      title: 'Test Conversation'
    })

    const conversationService = new ConversationService({
      db: ctx.db,
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      conversationRepo,
      messageRepo,
      providerConnectionRepo: connectionRepo,
      activeWorkspaceContext: activeContext,
      registry: registry2
    })

    const prepared = conversationService.prepareTurn(sessionId, {
      botId: createdBot.id,
      conversationId: conv.id,
      question: 'Hello after restart!'
    })
    expect(prepared.providerId).toBe('groq')
    expect(prepared.modelId).toBe('groq/dynamic-v2-chat')
    expect(prepared.contextWindowLimits).toEqual({ inputTokens: 65536, outputTokens: 8192 })

    const execService = new ConversationExecutionService(providerManager2)
    const execResult = await execService.executePreparedTurn(prepared)
    expect(execResult.assistantText).toBe('Restart persisted reply.')
    expect(fetchMockAfterRestart).toHaveBeenCalledTimes(1)
  })

  it('2. supports Groq across strict_kb_only, balanced_kb_first, and general_ai_chat policies + Agent tool calling', async () => {
    const kbDir = path.join(ctx.tempDir, 'kb-2')
    fs.mkdirSync(kbDir, { recursive: true })
    const kb = ctx.kbRepo.create({
      name: 'Policy KB',
      description: 'KB docs'
    })
    activeContext.activateWorkspace(sessionId, kb.id)

    let agentRound = 0
    const groqFetchMock = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const targetUrl = typeof url === 'string' ? url : url.toString()
      if (targetUrl.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'llama-3.3-70b-versatile',
                active: true,
                context_window: 131072,
                max_completion_tokens: 32768
              },
              {
                id: 'groq/compound',
                active: true,
                context_window: 131072,
                max_completion_tokens: 8192
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      agentRound++
      if (agentRound === 1) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-agent-1',
            object: 'chat.completion',
            created: 1730000000,
            model: 'llama-3.3-70b-versatile',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_kb_1',
                      type: 'function',
                      function: { name: 'search_knowledge_base', arguments: '{"query":"roadmap"}' }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-agent-2',
          object: 'chat.completion',
          created: 1730000001,
          model: 'llama-3.3-70b-versatile',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'According to [1], the roadmap items are on track.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const registry = new ProviderRegistry()
    const groqAdapter = new GroqAdapter({ fetchFn: groqFetchMock })
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: { groq: groqAdapter }
    })

    const conn = await providerManager.createConnection({
      providerId: 'groq',
      label: 'Groq Agent Connection',
      apiKey: groqApiKey
    })

    const conversationRepo = new ConversationRepository(ctx.db)
    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      conversationRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    const messageRepo = new MessageRepository(ctx.db)
    const conversationService = new ConversationService({
      db: ctx.db,
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      conversationRepo,
      messageRepo,
      providerConnectionRepo: connectionRepo,
      activeWorkspaceContext: activeContext,
      registry
    })

    // Check all 3 response policies prepare cleanly for Groq
    for (const policy of ['strict_kb_only', 'balanced_kb_first', 'general_ai_chat'] as const) {
      const bot = botManager.createBot(sessionId, {
        name: `Bot ${policy}`,
        providerConnectionId: conn.id,
        modelId: 'llama-3.3-70b-versatile',
        responsePolicy: policy,
        enabledTools: ['search_knowledge_base']
      })
      const conv = conversationRepo.getOrCreate({
        botId: bot.id,
        knowledgeBaseId: kb.id,
        title: `${policy} chat`
      })
      const prepared = conversationService.prepareTurn(sessionId, {
        botId: bot.id,
        conversationId: conv.id,
        question: 'Summarize the roadmap.'
      })
      expect(prepared.responsePolicy).toBe(policy)
      expect(prepared.providerId).toBe('groq')
    }

    // Verify Agent execution using shared resolveAdapter & BoundedAgentRuntime
    const toolBot = botManager.createBot(sessionId, {
      name: 'Groq Agent Bot',
      providerConnectionId: conn.id,
      modelId: 'llama-3.3-70b-versatile',
      responsePolicy: 'balanced_kb_first',
      enabledTools: ['search_knowledge_base']
    })

    const stepExecutor = new AiSdkAgentModelStepExecutor({
      botRepository: ctx.botRepo,
      connectionRepository: connectionRepo,
      credentialVault: vault,
      registry,
      adapterResolver: (pid) => providerManager.resolveAdapter(pid)
    })

    const toolRegistry = new ToolRegistry({
      botRepository: ctx.botRepo,
      knowledgeBaseRepository: ctx.kbRepo
    })
    const mockSearchTool: AgentTool = {
      name: 'search_knowledge_base',
      description: 'Search indexed KB documents.',
      schema: z.object({ query: z.string() }),
      requiredPermission: 'search_knowledge_base',
      execute: async (args: { query: string }) => ({
        result: {
          citations: [
            {
              citationNumber: 1,
              sourceId: 'src_roadmap_1',
              chunkId: 'chunk_roadmap_1',
              fileName: 'Roadmap.md',
              fileType: 'md' as const,
              pageNumber: 1,
              snippet: `Roadmap details for ${args.query}: Phase 13 deliverables are on track.`
            }
          ]
        },
        resultSummary: `Found 1 hit for "${args.query}".`
      })
    }
    toolRegistry.register(mockSearchTool)

    const agentRunRepo = new AgentRunRepository(ctx.db)
    const toolEventRepo = new ToolEventRepository(ctx.db)
    const approvalController = new ApprovalController()
    const workspaceFolderService = new WorkspaceFolderService()

    const runtime = new BoundedAgentRuntime({
      botRepository: ctx.botRepo,
      knowledgeBaseRepository: ctx.kbRepo,
      agentRunRepository: agentRunRepo,
      toolEventRepository: toolEventRepo,
      toolRegistry,
      stepExecutor,
      approvalController,
      workspaceFolderService,
      conversationRepository: conversationRepo
    })

    const agentConv = conversationRepo.getOrCreate({
      botId: toolBot.id,
      knowledgeBaseId: kb.id,
      title: 'Agent Task'
    })

    const runResult = await runtime.run({
      botId: toolBot.id,
      conversationId: agentConv.id,
      task: 'Check the roadmap using tools.'
    })

    expect(runResult.status).toBe('completed')
    expect(runResult.finalResponse).toBe('According to [1], the roadmap items are on track.')
    expect(runResult.toolEvents).toHaveLength(1)
    expect(runResult.toolEvents[0].toolName).toBe('search_knowledge_base')

    // Verify non-tool Groq model ('groq/compound') is rejected for Agent tool execution
    const compoundBot = botManager.createBot(sessionId, {
      name: 'Compound Bot',
      providerConnectionId: conn.id,
      modelId: 'groq/compound',
      enabledTools: ['search_knowledge_base']
    })
    const compoundConv = conversationRepo.getOrCreate({
      botId: compoundBot.id,
      knowledgeBaseId: kb.id,
      title: 'Compound Conv'
    })
    const compoundRes = await runtime.run({
      botId: compoundBot.id,
      conversationId: compoundConv.id,
      task: 'Run tool'
    })
    expect(compoundRes.status).toBe('failed')
    expect(compoundRes.errorSummary).toMatch(/does not support tool calling/i)
    expect(compoundRes.iterationCount).toBe(0)
  })

  it('3. preserves Groq Bot modelId in backup export/import while resetting credentials and blocking gsk_ secrets', async () => {
    const kbDir = path.join(ctx.tempDir, 'kb-backup')
    fs.mkdirSync(kbDir, { recursive: true })
    const kb = ctx.kbRepo.create({
      name: 'Backup KB',
      description: 'Groq backup test'
    })
    activeContext.activateWorkspace(sessionId, kb.id)

    const registry = new ProviderRegistry()
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: {
        groq: new GroqAdapter({
          fetchFn: vi.fn().mockImplementation(
            async () =>
              new Response(
                JSON.stringify({
                  data: [{ id: 'llama-3.3-70b-versatile', active: true }]
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
          )
        })
      }
    })

    const conn = await providerManager.createConnection({
      providerId: 'groq',
      label: 'Groq Backup Key',
      apiKey: groqApiKey
    })

    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    botManager.createBot(sessionId, {
      name: 'Backup Groq Bot',
      providerConnectionId: conn.id,
      modelId: 'llama-3.3-70b-versatile',
      enabledTools: []
    })

    const storageManager = new DocumentStorageManager({ userDataPath: ctx.tempDir })
    const exportManager = new BackupExportManager({
      db: ctx.db,
      kbRepository: ctx.kbRepo,
      botRepository: ctx.botRepo,
      botMemoryRepository: new BotMemoryRepository(ctx.db),
      knowledgeSourceRepository: new KnowledgeSourceRepository(ctx.db),
      conversationRepository: new ConversationRepository(ctx.db),
      messageRepository: new MessageRepository(ctx.db),
      storageManager
    })

    const exportPath = path.join(ctx.tempDir, 'groq-backup.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, exportPath)
    expect(exportRes.success).toBe(true)

    // Verify gsk_ detection blocks export if leaked in bot prompt
    botManager.createBot(sessionId, {
      name: 'Leaky Bot',
      providerConnectionId: conn.id,
      modelId: 'llama-3.3-70b-versatile',
      systemPrompt: `Use ${groqApiKey}`,
      enabledTools: []
    })
    const blockedExportPath = path.join(ctx.tempDir, 'blocked.zip')
    const blockedRes = await exportManager.exportKnowledgeBase(kb.id, blockedExportPath)
    expect(blockedRes.success).toBe(false)
    expect(blockedRes.code).toBe('CREDENTIAL_LEAK_PREVENTED')

    expect(defaultSecretScanner.scanText(`token=${groqApiKey}`).hasSecret).toBe(true)
    expect(sanitizeConversationErrorMessage(`Failed with ${groqApiKey}`)).not.toContain(groqApiKey)
    expect(sanitizeAgentErrorMessage(`Agent failed with ${groqApiKey}`)).not.toContain(groqApiKey)

    // Import clean archive into fresh DB & verify Bot modelId preserved and connection reset to null
    const freshCtx = createMigratedTestDatabase()
    try {
      const importStorage = new DocumentStorageManager({ userDataPath: freshCtx.tempDir })
      const importManager = new BackupImportManager({
        db: freshCtx.db,
        kbRepository: freshCtx.kbRepo,
        botRepository: freshCtx.botRepo,
        botMemoryRepository: new BotMemoryRepository(freshCtx.db),
        knowledgeSourceRepository: new KnowledgeSourceRepository(freshCtx.db),
        conversationRepository: new ConversationRepository(freshCtx.db),
        messageRepository: new MessageRepository(freshCtx.db),
        storageManager: importStorage,
        tempBaseDir: path.join(freshCtx.tempDir, 'import-staging')
      })
      const previewRes = await importManager.selectAndPreviewArchive(exportPath)
      expect(previewRes.success).toBe(true)
      const importRes = await importManager.executeImport({
        sessionId: previewRes.preview!.sessionId,
        strategy: 'new'
      })
      expect(importRes.success).toBe(true)
      const importedBots = freshCtx.botRepo.listByKnowledgeBase(importRes.knowledgeBaseId!)
      expect(importedBots).toHaveLength(1)
      expect(importedBots[0].modelId).toBe('llama-3.3-70b-versatile')
      expect(importedBots[0].providerConnectionId).toBeNull()
    } finally {
      freshCtx.cleanup()
    }
  })
})
