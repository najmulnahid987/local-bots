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
import { PerplexityAdapter } from './perplexity-adapter'
import { BotManagerService } from '../../services/bot-manager'
import { ActiveWorkspaceContext } from '../../services/active-workspace-context'
import { BotRagService } from '../../services/bot-rag-service'
import { ConversationService } from '../../services/conversation-service'
import { ConversationExecutionService } from '../../services/conversation-execution-service'
import { ConversationPersistenceService } from '../../services/conversation-persistence-service'
import {
  ConversationTurnService,
  type ConversationTurnEvent
} from '../../services/conversation-turn-service'
import { AiSdkAgentModelStepExecutor } from '../../agents/ai-sdk-agent-model-step-executor'
import { BoundedAgentRuntime } from '../../services/bounded-agent-runtime'
import { ApprovalController } from '../../services/approval-controller'
import { WorkspaceFolderService } from '../../services/workspace-folder-service'
import { ToolRegistry } from '../../tools/tool-registry'
import type { AgentTool } from '../../tools/agent-tool'
import { BackupExportManager } from '../../services/backup-export-manager'
import { BackupImportManager } from '../../services/backup-import-manager'
import { defaultSecretScanner } from '../../services/secret-scanner'
import { DiagnosticSanitizer } from '../../services/diagnostic-sanitizer'
import { sanitizeConversationErrorMessage } from '../../ipc/conversation-validation'
import { sanitizeAgentErrorMessage } from '../../ipc/agent-validation'
import { messageMetadataSchema, type CitationDto } from '../../../shared/conversations'

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
      Buffer.alloc(32, 0x41),
      Buffer.alloc(16, 0x22)
    )
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  }
  async encryptStringAsync(plaintext: string): Promise<Buffer> {
    return this.encryptString(plaintext)
  }
  decryptString(ciphertext: Buffer): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.alloc(32, 0x41),
      Buffer.alloc(16, 0x22)
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

function createAgentSseResponse(params: {
  model: string
  text: string
  webSources?: Array<{ id: number; title: string; url: string; snippet: string; date?: string }>
  cost?: { input_cost: number; output_cost: number; total_cost: number; currency: string }
}): Response {
  const encoder = new TextEncoder()
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        sequence_number: 0,
        response: {
          id: 'resp_e2e_1',
          created_at: 1760000000,
          object: 'response',
          status: 'in_progress',
          model: params.model,
          output: []
        }
      }
    }
  ]

  if (params.webSources && params.webSources.length > 0) {
    events.push({
      event: 'response.reasoning.search_results',
      data: {
        type: 'response.reasoning.search_results',
        sequence_number: 1,
        results: params.webSources
      }
    })
  }

  events.push({
    event: 'response.output_text.delta',
    data: {
      type: 'response.output_text.delta',
      sequence_number: 2,
      item_id: 'msg_e2e_1',
      output_index: 0,
      content_index: 0,
      delta: params.text
    }
  })

  events.push({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: 'resp_e2e_1',
        created_at: 1760000000,
        object: 'response',
        status: 'completed',
        model: params.model,
        output: [],
        usage: {
          input_tokens: 30,
          output_tokens: 18,
          total_tokens: 48,
          ...(params.cost ? { cost: params.cost } : {})
        }
      }
    }
  })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(
          encoder.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)
        )
      }
      controller.close()
    }
  })

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

describe('Perplexity End-to-End Integration, Grounding Isolation & Security (Phase 13 Step 13.4)', () => {
  let ctx: MigratedTestDatabaseContext
  let vault: CredentialVault
  let connectionRepo: ProviderConnectionRepository
  let activeContext: ActiveWorkspaceContext
  const sessionId = 'test-session-perplexity-e2e'
  const pplxKey = 'pplx-e2e_test_perplexity_key_1234567890abcdefghijklmnop'

  const kbCitation: CitationDto = {
    citationNumber: 1,
    sourceId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    fileName: 'ComplianceHandbook.md',
    fileType: 'md',
    pageNumber: 1,
    headingPath: ['Compliance'],
    chunkIndex: 0
  }

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    const vaultDir = path.join(ctx.tempDir, 'vault')
    fs.mkdirSync(vaultDir, { recursive: true })
    vault = new CredentialVault({
      vaultDir,
      safeStorage: new DeterministicTestSafeStorage()
    })
    connectionRepo = new ProviderConnectionRepository(ctx.db)
    activeContext = new ActiveWorkspaceContext(ctx.kbRepo)
  })

  afterEach(() => {
    ctx.cleanup()
    vi.restoreAllMocks()
  })

  it('1. enforces vault encryption fail-closed on Linux basic_text, persists Perplexity connections/Bots across restart, and isolates webSources from KB citations & grounding', async () => {
    const failVault = new CredentialVault({
      vaultDir: path.join(ctx.tempDir, 'fail-vault'),
      safeStorage: new DeterministicTestSafeStorage('basic_text', false)
    })
    await expect(failVault.store(pplxKey)).rejects.toThrow()

    const kb = ctx.kbRepo.create({ name: 'Perplexity Research KB', description: 'KB Docs' })
    activeContext.activateWorkspace(sessionId, kb.id)

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof url === 'string' ? url : url.toString()
        expect(target).toBe('https://api.perplexity.ai/v1/agent')
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}

        // Verification call uses max_tool_calls: 0
        if (body.max_tool_calls === 0) {
          return new Response(
            JSON.stringify({
              id: 'resp_verify',
              created_at: 1760000000,
              object: 'response',
              status: 'completed',
              model: 'perplexity/sonar',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'OK' }]
                }
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }

        return createAgentSseResponse({
          model: String(body.model ?? body.preset ?? 'perplexity/sonar'),
          text: 'Local policy requires MFA enforcement [1]. Additionally, external analysts report rapid adoption.',
          webSources: [
            {
              id: 1,
              title: 'External Analyst Report',
              url: 'https://example.org/analyst-report',
              snippet: 'Rapid enterprise adoption in 2026.',
              date: '2026-10-15'
            },
            {
              id: 2,
              title: 'Injected Script Link',
              url: 'javascript:alert(1)',
              snippet: 'Unsafe protocol'
            }
          ],
          cost: {
            input_cost: 0.0002,
            output_cost: 0.0004,
            total_cost: 0.0006,
            currency: 'USD'
          }
        })
      })

    const registry = new ProviderRegistry()
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: { perplexity: new PerplexityAdapter({ fetch: fetchMock }) }
    })

    const conn = await providerManager.createConnection({
      providerId: 'perplexity',
      label: 'Primary Perplexity Key',
      apiKey: pplxKey
    })
    expect(conn.providerId).toBe('perplexity')

    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    const chatBot = botManager.createBot(sessionId, {
      name: 'Perplexity Sonar Bot',
      providerConnectionId: conn.id,
      modelId: 'perplexity/sonar',
      responsePolicy: 'balanced_kb_first',
      enabledTools: []
    })
    const presetBot = botManager.createBot(sessionId, {
      name: 'Perplexity Preset Bot',
      providerConnectionId: conn.id,
      modelId: 'fast',
      responsePolicy: 'general_ai_chat',
      enabledTools: []
    })

    // Confirm SQLite persistence retains direct model ID & preset ID across repository re-read
    expect(ctx.botRepo.getByIdOnly(chatBot.id)?.modelId).toBe('perplexity/sonar')
    expect(ctx.botRepo.getByIdOnly(presetBot.id)?.modelId).toBe('fast')

    const convRepo = new ConversationRepository(ctx.db)
    const msgRepo = new MessageRepository(ctx.db)
    const ragService = new BotRagService({ db: ctx.db })
    vi.spyOn(ragService, 'retrieve').mockReturnValue({
      status: 'SUCCESS',
      chunks: [
        {
          citationNumber: 1,
          sourceId: kbCitation.sourceId,
          chunkId: kbCitation.chunkId,
          fileName: kbCitation.fileName,
          fileType: kbCitation.fileType,
          pageNumber: 1,
          headingPath: ['Compliance'],
          chunkIndex: 0,
          score: 0.98,
          content: 'Local policy requires MFA enforcement for all admins.',
          tokenCount: 12,
          isTruncated: false,
          citation: kbCitation
        }
      ],
      citations: [kbCitation],
      totalTokens: 12
    })

    const conversationService = new ConversationService({
      db: ctx.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext,
      botRagService: ragService
    })
    const executionService = new ConversationExecutionService({
      providerManagerService: providerManager
    })
    const persistenceService = new ConversationPersistenceService({
      db: ctx.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo
    })
    const turnService = new ConversationTurnService({
      db: ctx.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext,
      conversationService,
      executionService,
      persistenceService
    })

    const conv = convRepo.getOrCreate({
      botId: chatBot.id,
      knowledgeBaseId: kb.id,
      title: 'Perplexity Research Thread'
    })

    const events: ConversationTurnEvent[] = []
    const stream = turnService.sendMessage(sessionId, {
      conversationId: conv.id,
      content: 'Does our policy require MFA and what do external reports say?'
    })
    for await (const ev of stream) {
      events.push(ev)
    }
    const turnResult = await stream.getResult()

    // 1) KB citation stays 100% authoritative local KB chunk only
    const citations = turnResult.assistantMessage.metadata.citations ?? []
    expect(citations).toHaveLength(1)
    expect(citations[0].chunkId).toBe(kbCitation.chunkId)

    // 2) External Perplexity webSources live separately & unsafe URLs are dropped
    const webSources = turnResult.assistantMessage.metadata.webSources ?? []
    expect(webSources).toHaveLength(1)
    expect(webSources[0].url).toBe('https://example.org/analyst-report')
    expect(webSources[0].originLabel).toBe('Perplexity Web Search')

    // 3) GroundingValidator keeps un-cited external web claims as general_knowledge (NEVER kb_supported)
    const claims = turnResult.assistantMessage.metadata.claims ?? []
    const externalClaim = claims.find((c) => c.claimText.includes('external analysts'))
    expect(externalClaim?.provenance).toBe('general_knowledge')

    // 4) Perplexity cost breakdown persisted cleanly
    expect(turnResult.assistantMessage.metadata.generation?.cost?.totalCost).toBe(0.0006)

    // 5) Chat mode Perplexity web_search MUST NOT create agent_runs or tool_events
    const agentRunsCount = (
      ctx.db.prepare('SELECT COUNT(*) as cnt FROM agent_runs').get() as { cnt: number }
    ).cnt
    const toolEventsCount = (
      ctx.db.prepare('SELECT COUNT(*) as cnt FROM tool_events').get() as { cnt: number }
    ).cnt
    expect(agentRunsCount).toBe(0)
    expect(toolEventsCount).toBe(0)
  })

  it('2. executes BoundedAgentRuntime tools on tool-capable Perplexity models while disabling native server tools and rejecting non-tool models', async () => {
    const kb = ctx.kbRepo.create({ name: 'Perplexity Agent KB', description: 'Agent Docs' })
    activeContext.activateWorkspace(sessionId, kb.id)

    let turnCallCount = 0
    const capturedAgentPayloads: Array<Record<string, unknown>> = []
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        if (body.max_tool_calls === 0) {
          return new Response(
            JSON.stringify({
              id: 'resp_v2',
              created_at: 1760000000,
              object: 'response',
              status: 'completed',
              model: 'perplexity/sonar',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'OK' }]
                }
              ],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }

        capturedAgentPayloads.push(body)
        turnCallCount++
        if (turnCallCount === 1) {
          return new Response(
            JSON.stringify({
              id: 'resp_agent_step_1',
              created_at: 1760000000,
              object: 'response',
              status: 'completed',
              model: 'fast',
              output: [
                {
                  type: 'function_call',
                  id: 'fc_1',
                  call_id: 'call_kb_1',
                  name: 'search_knowledge_base',
                  arguments: JSON.stringify({ query: 'quarterly capex' })
                }
              ],
              usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }

        return new Response(
          JSON.stringify({
            id: 'resp_agent_step_2',
            created_at: 1760000000,
            object: 'response',
            status: 'completed',
            model: 'fast',
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'According to [1], capex is approved.' }]
              }
            ],
            usage: { input_tokens: 60, output_tokens: 20, total_tokens: 80 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

    const registry = new ProviderRegistry()
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry,
      adapters: { perplexity: new PerplexityAdapter({ fetch: fetchMock }) }
    })
    const conn = await providerManager.createConnection({
      providerId: 'perplexity',
      label: 'Perplexity Agent Key',
      apiKey: pplxKey
    })

    const botManager = new BotManagerService({
      botRepo: ctx.botRepo,
      kbRepo: ctx.kbRepo,
      connectionRepo,
      db: ctx.db,
      registry,
      activeContext
    })

    const agentBot = botManager.createBot(sessionId, {
      name: 'Perplexity Agent Bot',
      providerConnectionId: conn.id,
      modelId: 'fast',
      enabledTools: ['search_knowledge_base']
    })

    const convRepo = new ConversationRepository(ctx.db)
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
    const mockTool: AgentTool = {
      name: 'search_knowledge_base',
      description: 'Search local Knowledge Base.',
      schema: z.object({ query: z.string() }),
      requiredPermission: 'search_knowledge_base',
      execute: async () => ({
        result: { citations: [{ citationNumber: 1, snippet: 'Capex approved.' }] },
        resultSummary: 'Found capex doc.'
      })
    }
    toolRegistry.register(mockTool)

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
      title: 'Perplexity Agent Run'
    })
    const runRes = await runtime.run({
      botId: agentBot.id,
      conversationId: agentConv.id,
      task: 'Look up quarterly capex.'
    })

    expect(runRes.status).toBe('completed')
    expect(runRes.toolEvents).toHaveLength(1)
    expect(runRes.finalResponse).toBe('According to [1], capex is approved.')

    // Confirm Perplexity native tools were NOT mixed alongside local ToolRegistry functions
    for (const payload of capturedAgentPayloads) {
      const sentTools = (payload.tools as Array<Record<string, unknown>>) ?? []
      expect(sentTools.every((t) => t.type === 'function')).toBe(true)
    }

    // Confirm non-tool perplexity/sonar rejects Agent mode safely
    const noToolBot = botManager.createBot(sessionId, {
      name: 'Sonar Non-Tool Bot',
      providerConnectionId: conn.id,
      modelId: 'perplexity/sonar',
      enabledTools: ['search_knowledge_base']
    })
    const noToolConv = convRepo.getOrCreate({
      botId: noToolBot.id,
      knowledgeBaseId: kb.id,
      title: 'Sonar Reject Run'
    })
    const rejectedRun = await runtime.run({
      botId: noToolBot.id,
      conversationId: noToolConv.id,
      task: 'Should reject'
    })
    expect(rejectedRun.status).toBe('failed')
    expect(rejectedRun.errorSummary).toMatch(/does not support tool calling/i)
    expect(rejectedRun.iterationCount).toBe(0)
  })

  it('3. preserves Perplexity Bots & webSources metadata across backup export/import while resetting credentials and blocking pplx- secrets', async () => {
    const kb = ctx.kbRepo.create({ name: 'Perplexity Backup KB', description: 'Backup' })
    activeContext.activateWorkspace(sessionId, kb.id)

    const registry = new ProviderRegistry()
    const conn = connectionRepo.create({
      providerId: 'perplexity',
      label: 'Perplexity Backup Conn',
      credentialRef: await vault.store(pplxKey)
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
      name: 'Perplexity Clean Bot',
      providerConnectionId: conn.id,
      modelId: 'perplexity/sonar',
      enabledTools: []
    })

    const convRepo = new ConversationRepository(ctx.db)
    const msgRepo = new MessageRepository(ctx.db)
    const conv = convRepo.getOrCreate({
      botId: cleanBot.id,
      knowledgeBaseId: kb.id,
      title: 'Backup Thread'
    })

    const savedMsg = msgRepo.create({
      conversationId: conv.id,
      botId: cleanBot.id,
      knowledgeBaseId: kb.id,
      role: 'assistant',
      content: 'Researched via Perplexity.',
      contentFormat: 'markdown',
      metadata: {
        providerId: 'perplexity',
        modelId: 'perplexity/sonar',
        citations: [],
        webSources: [
          {
            id: 'ws_bkp_1',
            title: 'Backup Web Source',
            url: 'https://docs.perplexity.ai',
            sourceType: 'search'
          }
        ]
      }
    })
    expect(messageMetadataSchema.safeParse(savedMsg.metadata).success).toBe(true)

    const storageManager = new DocumentStorageManager({ userDataPath: ctx.tempDir })
    const exportManager = new BackupExportManager({
      db: ctx.db,
      kbRepository: ctx.kbRepo,
      botRepository: ctx.botRepo,
      botMemoryRepository: new BotMemoryRepository(ctx.db),
      knowledgeSourceRepository: new KnowledgeSourceRepository(ctx.db),
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager
    })

    const exportPath = path.join(ctx.tempDir, 'perplexity-backup.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, exportPath)
    expect(exportRes.success).toBe(true)

    // Scanner & sanitizers block/redact pplx- keys everywhere
    expect(defaultSecretScanner.scanText(pplxKey).hasSecret).toBe(true)
    expect(DiagnosticSanitizer.sanitize(`Leak ${pplxKey}`)).not.toContain(pplxKey)
    expect(sanitizeConversationErrorMessage(`Fail ${pplxKey}`)).not.toContain(pplxKey)
    expect(sanitizeAgentErrorMessage(`Fail ${pplxKey}`)).not.toContain(pplxKey)

    botManager.createBot(sessionId, {
      name: 'Leaky Perplexity Bot',
      providerConnectionId: conn.id,
      modelId: 'perplexity/sonar',
      systemPrompt: `Auth: ${pplxKey}`,
      enabledTools: []
    })
    const blockedRes = await exportManager.exportKnowledgeBase(
      kb.id,
      path.join(ctx.tempDir, 'perplexity-blocked.zip')
    )
    expect(blockedRes.success).toBe(false)
    expect(blockedRes.code).toBe('CREDENTIAL_LEAK_PREVENTED')

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

      const preview = await importManager.selectAndPreviewArchive(exportPath)
      expect(preview.success).toBe(true)
      const imported = await importManager.executeImport({
        sessionId: preview.preview!.sessionId,
        strategy: 'new'
      })
      expect(imported.success).toBe(true)

      const importedBots = freshCtx.botRepo.listByKnowledgeBase(imported.knowledgeBaseId!)
      expect(importedBots).toHaveLength(1)
      expect(importedBots[0].modelId).toBe('perplexity/sonar')
      expect(importedBots[0].providerConnectionId).toBeNull()

      const importedConv = new ConversationRepository(freshCtx.db).getOrCreate({
        botId: importedBots[0].id,
        knowledgeBaseId: imported.knowledgeBaseId!
      })
      const importedMsgs = new MessageRepository(freshCtx.db).listByConversation(
        importedConv.id,
        importedBots[0].id,
        imported.knowledgeBaseId!
      )
      expect(importedMsgs[0]?.metadata.webSources?.[0]?.url).toBe('https://docs.perplexity.ai')
      expect(importedMsgs[0]?.metadata.citations).toEqual([])
    } finally {
      freshCtx.cleanup()
    }
  })
})
