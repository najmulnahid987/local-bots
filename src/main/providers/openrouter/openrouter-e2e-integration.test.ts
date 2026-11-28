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
import { OpenRouterAdapter } from './openrouter-adapter'
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
import { MODEL_ID_SCHEMA } from '../../ipc/provider-validation'

class DeterministicTestSafeStorage implements ISafeStorageAdapter {
  private readonly backend: LinuxStorageBackend
  private readonly available: boolean

  constructor(backend: LinuxStorageBackend = 'gnome_libsecret', available = true) {
    this.backend = backend
    this.available = available
  }

  isEncryptionAvailable(): boolean {
    return this.available
  }
  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }
  encryptString(plaintext: string): Buffer {
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x3b),
      Buffer.alloc(16, 0x17)
    )
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  }
  async encryptStringAsync(plaintext: string): Promise<Buffer> {
    return this.encryptString(plaintext)
  }
  decryptString(ciphertext: Buffer): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x3b),
      Buffer.alloc(16, 0x17)
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

describe('OpenRouter End-to-End Integration & Security (Phase 13 Step 13.3)', () => {
  let ctx: MigratedTestDatabaseContext
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let cacheFilePath: string
  let activeContext: ActiveWorkspaceContext
  const sessionId = 'test-session-openrouter-e2e'
  const openrouterKey = 'sk-or-v1-e2e_test_openrouter_key_1234567890abcdefghijklmnop'
  const replacementKey = 'sk-or-v1-e2e_replaced_key_abcdefghijklmnopqrstuvwxyz123456'

  const longOpenRouterSlug =
    'some-provider/very-long-openrouter-model-name-with-vendor-and-extended-variant-suffix-0123456789-abcdefghij:free'

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

  it('1. validates OpenRouter credentials, persists connection-scoped discovery across restart, isolates connections, and enforces staleness/tamper checks', async () => {
    const kb = ctx.kbRepo.create({ name: 'OpenRouter KB', description: 'Docs' })
    activeContext.activateWorkspace(sessionId, kb.id)

    // Verify MODEL_ID_SCHEMA permits legitimate >100-char OpenRouter slugs & rejects injection
    expect(MODEL_ID_SCHEMA.safeParse(longOpenRouterSlug).success).toBe(true)
    expect(MODEL_ID_SCHEMA.safeParse('../evil/slug?token=1').success).toBe(false)

    // Verify Linux basic_text / unavailable encryption fails closed in CredentialVault
    const failVault = new CredentialVault({
      vaultDir: path.join(ctx.tempDir, 'fail-vault'),
      safeStorage: new DeterministicTestSafeStorage('basic_text', false)
    })
    await expect(failVault.store(openrouterKey)).rejects.toThrow()

    let includeLongSlug = true
    const fetchMockPhase1 = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/auth/key')) {
        return new Response(JSON.stringify({ data: { label: 'OR Key' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (target.endsWith('/models/user')) {
        const models = [
          {
            id: 'anthropic/claude-3.7-sonnet',
            name: 'Claude 3.7 Sonnet',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            top_provider: { context_length: 200000, max_completion_tokens: 64000 },
            supported_parameters: ['tools', 'structured_outputs']
          },
          ...(includeLongSlug
            ? [
                {
                  id: longOpenRouterSlug,
                  name: 'Long Variant Free Model',
                  context_length: 65536,
                  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                  pricing: { prompt: '0', completion: '0' },
                  top_provider: { context_length: 65536, max_completion_tokens: 8192 },
                  supported_parameters: ['temperature']
                }
              ]
            : [])
        ]
        return new Response(JSON.stringify({ data: models }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`Unexpected request to ${target}`)
    })

    const registry1 = new ProviderRegistry()
    registry1.configurePersistence(cacheFilePath)
    const providerManager1 = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: registry1,
      adapters: { openrouter: new OpenRouterAdapter({ fetchFn: fetchMockPhase1 }) }
    })

    const connA = await providerManager1.createConnection({
      providerId: 'openrouter',
      label: 'OpenRouter Account A',
      apiKey: openrouterKey
    })
    expect(connA.providerId).toBe('openrouter')
    expect(connA.availableModels).toEqual(['anthropic/claude-3.7-sonnet', longOpenRouterSlug])

    // Second independent OpenRouter connection discovering only 'openai/gpt-4o-mini'
    const fetchMockConnB = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/auth/key')) {
        return new Response(JSON.stringify({ data: { label: 'OR B' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o-mini',
              name: 'GPT-4o Mini',
              context_length: 128000,
              architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              supported_parameters: ['tools']
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const pmConnB = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: registry1,
      adapters: { openrouter: new OpenRouterAdapter({ fetchFn: fetchMockConnB }) }
    })
    const connB = await pmConnB.createConnection({
      providerId: 'openrouter',
      label: 'OpenRouter Account B',
      apiKey: replacementKey
    })

    // Cross-connection cache isolation check
    expect(registry1.getModel('openrouter', longOpenRouterSlug, connA.id)).not.toBeNull()
    expect(registry1.getModel('openrouter', longOpenRouterSlug, connB.id)).toBeNull()

    // Create Bot using long OpenRouter slug on Conn A
    const botManager1 = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry: registry1,
      activeContext
    })
    const dynamicBot = botManager1.createBot(sessionId, {
      name: 'OpenRouter Dynamic Bot',
      providerConnectionId: connA.id,
      modelId: longOpenRouterSlug,
      responsePolicy: 'general_ai_chat',
      enabledTools: []
    })
    expect(dynamicBot.modelId).toBe(longOpenRouterSlug)

    // Tamper persisted cache file to try forging `tools: true` on non-tool model
    const rawCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')) as {
      version: 1
      entries: Array<{
        connectionId: string
        providerId: string
        models: Array<{
          id: string
          providerCapabilities?: { tools?: boolean }
        }>
      }>
    }
    const connEntry = rawCache.entries.find((e) => e.connectionId === connA.id)!
    const freeModelInCache = connEntry.models.find((m) => m.id === longOpenRouterSlug)!
    freeModelInCache.providerCapabilities = { tools: true }
    fs.writeFileSync(cacheFilePath, JSON.stringify(rawCache, null, 2), 'utf8')

    // Simulate application restart
    const registryAfterRestart = new ProviderRegistry()
    registryAfterRestart.configurePersistence(cacheFilePath)

    // Tamper check: tools capability MUST still be false because supportedParameters lacks 'tools'
    const reloadedModel = registryAfterRestart.getModel('openrouter', longOpenRouterSlug, connA.id)
    expect(reloadedModel?.providerCapabilities?.tools).toBe(false)
    expect(reloadedModel?.pricing?.isFree).toBe(true)

    const fetchAfterRestart = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/models') || target.endsWith('/models/user')) {
        throw new Error('Must NOT fetch /models on generated messages after restart')
      }
      const encoder = new TextEncoder()
      const sse =
        `data: ${JSON.stringify({
          id: 'gen-restart-1',
          model: longOpenRouterSlug,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Persisted OpenRouter reply.' },
              finish_reason: null
            }
          ]
        })}\n\n` +
        `data: ${JSON.stringify({
          id: 'gen-restart-1',
          model: longOpenRouterSlug,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 }
        })}\n\n` +
        'data: [DONE]\n\n'
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(sse))
            c.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    })

    const providerManagerRestart = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: registryAfterRestart,
      adapters: { openrouter: new OpenRouterAdapter({ fetchFn: fetchAfterRestart }) }
    })

    const convRepo = new ConversationRepository(ctx.db)
    const msgRepo = new MessageRepository(ctx.db)
    const conv = convRepo.getOrCreate({
      botId: dynamicBot.id,
      knowledgeBaseId: kb.id,
      title: 'OR Chat'
    })
    const convService = new ConversationService({
      db: ctx.db,
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      providerConnectionRepo: connectionRepo,
      activeWorkspaceContext: activeContext,
      registry: registryAfterRestart
    })

    const prepared = convService.prepareTurn(sessionId, {
      botId: dynamicBot.id,
      conversationId: conv.id,
      question: 'Respond without querying /models'
    })
    expect(prepared.providerId).toBe('openrouter')
    expect(prepared.modelId).toBe(longOpenRouterSlug)

    const execResult = await new ConversationExecutionService(
      providerManagerRestart
    ).executePreparedTurn(prepared)
    expect(execResult.assistantText).toBe('Persisted OpenRouter reply.')
    expect(fetchAfterRestart).toHaveBeenCalledTimes(1)

    // Test replaceCredential + stale removed model rejection (never silently substitutes another model)
    includeLongSlug = false
    await providerManager1.replaceCredential(connA.id, replacementKey)
    expect(() =>
      new ConversationService({
        db: ctx.db,
        botRepo: ctx.botRepo,
        kbRepo: ctx.kbRepo,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        providerConnectionRepo: connectionRepo,
        activeWorkspaceContext: activeContext,
        registry: registry1
      }).prepareTurn(sessionId, {
        botId: dynamicBot.id,
        conversationId: conv.id,
        question: 'Now model was removed'
      })
    ).toThrow(/was not found/i)

    // Corrupted cache JSON never crashes startup
    fs.writeFileSync(cacheFilePath, '{not valid json', 'utf8')
    const corruptRegistry = new ProviderRegistry()
    expect(() => corruptRegistry.configurePersistence(cacheFilePath)).not.toThrow()
  })

  it('2. executes OpenRouter Agent tool calling via shared resolver, blocks non-tool models, and preserves all 3 policies', async () => {
    const kb = ctx.kbRepo.create({ name: 'OR Agent KB', description: 'Docs' })
    activeContext.activateWorkspace(sessionId, kb.id)

    let round = 0
    const fetchMock = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.endsWith('/auth/key')) {
        return new Response(JSON.stringify({ data: { label: 'Agent Key' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (target.endsWith('/models/user')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-4o',
                name: 'OpenAI GPT-4o',
                context_length: 128000,
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
                supported_parameters: ['tools', 'structured_outputs']
              },
              {
                id: 'mistralai/mistral-7b-instruct:free',
                name: 'Mistral 7B Free',
                context_length: 32768,
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                supported_parameters: ['temperature']
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      round++
      if (round === 1) {
        return new Response(
          JSON.stringify({
            id: 'gen-agent-1',
            model: 'openai/gpt-4o',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_or_kb_1',
                      type: 'function',
                      function: { name: 'search_knowledge_base', arguments: '{"query":"budget"}' }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 22, completion_tokens: 11, total_tokens: 33 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          id: 'gen-agent-2',
          model: 'openai/gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'According to [1], budget targets were verified.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const registry = new ProviderRegistry()
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: { openrouter: new OpenRouterAdapter({ fetchFn: fetchMock }) }
    })

    const conn = await providerManager.createConnection({
      providerId: 'openrouter',
      label: 'OpenRouter Key',
      apiKey: openrouterKey
    })

    const convRepo = new ConversationRepository(ctx.db)
    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      conversationRepo: convRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    const msgRepo = new MessageRepository(ctx.db)
    const convService = new ConversationService({
      db: ctx.db,
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      providerConnectionRepo: connectionRepo,
      activeWorkspaceContext: activeContext,
      registry
    })

    for (const policy of ['strict_kb_only', 'balanced_kb_first', 'general_ai_chat'] as const) {
      const bot = botManager.createBot(sessionId, {
        name: `OR Policy ${policy}`,
        providerConnectionId: conn.id,
        modelId: 'openai/gpt-4o',
        responsePolicy: policy,
        enabledTools: ['search_knowledge_base']
      })
      const conv = convRepo.getOrCreate({
        botId: bot.id,
        knowledgeBaseId: kb.id,
        title: policy
      })
      const prepared = convService.prepareTurn(sessionId, {
        botId: bot.id,
        conversationId: conv.id,
        question: 'Check budget'
      })
      expect(prepared.responsePolicy).toBe(policy)
      expect(prepared.providerId).toBe('openrouter')
    }

    const agentBot = botManager.createBot(sessionId, {
      name: 'OR Agent Bot',
      providerConnectionId: conn.id,
      modelId: 'openai/gpt-4o',
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
      description: 'Search KB docs.',
      schema: z.object({ query: z.string() }),
      requiredPermission: 'search_knowledge_base',
      execute: async (args: { query: string }) => ({
        result: {
          citations: [
            {
              citationNumber: 1,
              sourceId: 'src_budget_1',
              chunkId: 'chunk_budget_1',
              fileName: 'Budget.md',
              fileType: 'md' as const,
              pageNumber: 1,
              snippet: `Budget verified for ${args.query}.`
            }
          ]
        },
        resultSummary: 'Found 1 hit.'
      })
    }
    toolRegistry.register(mockSearchTool)

    const runtime = new BoundedAgentRuntime({
      botRepository: ctx.botRepo,
      knowledgeBaseRepository: ctx.kbRepo,
      agentRunRepository: new AgentRunRepository(ctx.db),
      toolEventRepository: new ToolEventRepository(ctx.db),
      toolRegistry,
      stepExecutor,
      approvalController: new ApprovalController(),
      workspaceFolderService: new WorkspaceFolderService(),
      conversationRepository: convRepo
    })

    const agentConv = convRepo.getOrCreate({
      botId: agentBot.id,
      knowledgeBaseId: kb.id,
      title: 'OR Agent Conv'
    })
    const runRes = await runtime.run({
      botId: agentBot.id,
      conversationId: agentConv.id,
      task: 'Find the budget.'
    })
    expect(runRes.status).toBe('completed')
    expect(runRes.finalResponse).toBe('According to [1], budget targets were verified.')
    expect(runRes.toolEvents).toHaveLength(1)

    // Non-tool OpenRouter model MUST be rejected before execution
    const noToolBot = botManager.createBot(sessionId, {
      name: 'No Tool OR Bot',
      providerConnectionId: conn.id,
      modelId: 'mistralai/mistral-7b-instruct:free',
      enabledTools: ['search_knowledge_base']
    })
    const noToolConv = convRepo.getOrCreate({
      botId: noToolBot.id,
      knowledgeBaseId: kb.id,
      title: 'No tool conv'
    })
    const noToolRes = await runtime.run({
      botId: noToolBot.id,
      conversationId: noToolConv.id,
      task: 'Attempt tool'
    })
    expect(noToolRes.status).toBe('failed')
    expect(noToolRes.errorSummary).toMatch(/does not support tool calling/i)
    expect(noToolRes.iterationCount).toBe(0)
  })

  it('3. preserves OpenRouter Bot modelId across backup export/import while resetting credentials and blocking sk-or-v1 secrets', async () => {
    const kb = ctx.kbRepo.create({ name: 'OR Backup KB', description: 'Backup' })
    activeContext.activateWorkspace(sessionId, kb.id)

    const registry = new ProviderRegistry()
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: {
        openrouter: new OpenRouterAdapter({
          fetchFn: vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
            const target = typeof url === 'string' ? url : url.toString()
            if (target.endsWith('/auth/key')) {
              return new Response(JSON.stringify({ data: { label: 'OR' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              })
            }
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: 'anthropic/claude-3.7-sonnet',
                    name: 'Claude 3.7 Sonnet',
                    context_length: 200000,
                    supported_parameters: ['tools']
                  }
                ]
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          })
        })
      }
    })

    const conn = await providerManager.createConnection({
      providerId: 'openrouter',
      label: 'OR Backup Key',
      apiKey: openrouterKey
    })

    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    const cleanBot = botManager.createBot(sessionId, {
      name: 'OR Clean Bot',
      providerConnectionId: conn.id,
      modelId: 'anthropic/claude-3.7-sonnet',
      enabledTools: []
    })
    expect(JSON.stringify(cleanBot)).not.toContain(openrouterKey)

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

    const exportPath = path.join(ctx.tempDir, 'openrouter-backup.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, exportPath)
    expect(exportRes.success).toBe(true)

    // Secret scanner blocks sk-or-v1 leaks on export
    botManager.createBot(sessionId, {
      name: 'Leaky OR Bot',
      providerConnectionId: conn.id,
      modelId: 'anthropic/claude-3.7-sonnet',
      systemPrompt: `Bearer ${openrouterKey}`,
      enabledTools: []
    })
    const blockedRes = await exportManager.exportKnowledgeBase(
      kb.id,
      path.join(ctx.tempDir, 'blocked-or.zip')
    )
    expect(blockedRes.success).toBe(false)
    expect(blockedRes.code).toBe('CREDENTIAL_LEAK_PREVENTED')

    expect(defaultSecretScanner.scanText(openrouterKey).hasSecret).toBe(true)
    expect(sanitizeConversationErrorMessage(`Fail ${openrouterKey}`)).not.toContain(openrouterKey)
    expect(sanitizeAgentErrorMessage(`Fail ${openrouterKey}`)).not.toContain(openrouterKey)

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
      expect(importedBots[0].modelId).toBe('anthropic/claude-3.7-sonnet')
      expect(importedBots[0].providerConnectionId).toBeNull()
    } finally {
      freshCtx.cleanup()
    }
  })
})
