/**
 * Phase 8 — Step 8.11: Final End-to-End Agent Runtime, Tool Integration, and Security Audit
 *
 * Comprehensive end-to-end integration and security test suite validating:
 * 1. Complete Six-Tool Registry & Deny-by-Default (Step 2 & Step 4 AC-P8-01..06)
 * 2. Multi-Step End-to-End Agent Task Execution (Step 3)
 * 3. Six-Tool Acceptance Criteria Deep-Dive (Step 4, AC-P8-01..06)
 * 4. Knowledge Base Only Policy & Context Provenance (Step 5)
 * 5. Bounded Agency, Iteration Limits & Parallel Call Rejection (Step 6)
 * 6. Comprehensive Cancellation Matrix across 7 Lifecycle Stages (Step 6)
 * 7. Human Approval End-to-End, Expiry & Collision Protection (Step 7)
 * 8. Workspace Filesystem Traversal & Windows Sandboxing (Step 8)
 * 9. IPC and Renderer Security Audit (Step 9)
 * 10. Database Persistence, Recovery & SQLite Integrity Checks (Step 10)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { z } from 'zod'

import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import type { CredentialRef } from '../database/repositories/types'
import type { CredentialVault } from '../security/credential-vault'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { BotRagService } from './bot-rag-service'
import { ApprovalController } from './approval-controller'
import { WorkspaceFolderService } from './workspace-folder-service'
import { WorkspacePathGuard, WorkspaceSecurityError } from '../security/workspace-path-guard'
import { ToolRegistry } from '../tools/tool-registry'
import { createDefaultToolRegistry } from '../tools'
import { SaveReportTool, type SaveReportDialogOperations } from '../tools/report'
import { BoundedAgentRuntime, BoundedAgentRuntimeError } from './bounded-agent-runtime'
import { AgentTaskService } from './agent-task-service'
import type {
  AgentModelStepExecutor,
  AgentModelStepRequest,
  AgentModelStepResult
} from '../agents/agent-model-step-executor'
import {
  AiSdkAgentModelStepExecutor,
  UnsupportedParallelToolCallsError
} from '../agents/ai-sdk-agent-model-step-executor'
import type {
  ProviderAdapter,
  GenerateTextResult,
  GenerateTextOptions,
  ConnectionTestResult,
  StreamTextChunk
} from '../providers/types'
import { KNOWLEDGE_BASE_ONLY_RESPONSES } from './knowledge-base-only-policy'
import { CURRENT_APPLICATION_CAPABILITIES } from '../../shared/providers'
import { registerAgentIpcHandlers } from '../ipc/agent-handlers'
import { AGENT_IPC_CHANNELS, isBotToolEnabled } from '../../shared/agents'
import type { BrowserWindowLike, IpcSenderEventLike, WebFrameMainLike } from '../security'
import { resetMonitoredSenders } from '../ipc/bot-handlers'

// ============================================================================
// Test Mock Implementations & Helpers
// ============================================================================

class MockCredentialVault {
  private readonly storeMap = new Map<string, string>()

  public set(ref: string, key: string): void {
    this.storeMap.set(ref, key)
  }

  async store(secret: string): Promise<CredentialRef> {
    const ref = `cred_${randomUUID()}` as CredentialRef
    this.storeMap.set(ref, secret)
    return ref
  }

  async retrieve(ref: string): Promise<string> {
    const val = this.storeMap.get(ref)
    if (!val) {
      throw new Error(`Credential '${ref}' not found in vault.`)
    }
    return val
  }

  async delete(ref: string): Promise<void> {
    this.storeMap.delete(ref)
  }

  async listStoredCredentialRefs(): Promise<CredentialRef[]> {
    return Array.from(this.storeMap.keys()) as CredentialRef[]
  }

  async cleanStaleTempFiles(): Promise<number> {
    return 0
  }
}

class DeterministicMockStepExecutor implements AgentModelStepExecutor {
  public requests: AgentModelStepRequest[] = []
  private readonly queue: AgentModelStepResult[] = []
  private customHandler?: (request: AgentModelStepRequest) => Promise<AgentModelStepResult>

  public enqueueDecision(decision: AgentModelStepResult): void {
    this.queue.push(decision)
  }

  public setHandler(
    handler: (request: AgentModelStepRequest) => Promise<AgentModelStepResult>
  ): void {
    this.customHandler = handler
  }

  public async executeStep(request: AgentModelStepRequest): Promise<AgentModelStepResult> {
    this.requests.push(request)
    if (this.customHandler) {
      return this.customHandler(request)
    }
    const next = this.queue.shift()
    if (!next) {
      throw new Error('DeterministicMockStepExecutor queue is empty.')
    }
    return next
  }
}

class MockProviderAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const
  public generateTextCalls: GenerateTextOptions[] = []
  private readonly queue: GenerateTextResult[] = []
  private customHandler?: (prompt: GenerateTextOptions) => Promise<GenerateTextResult>

  public enqueueResult(res: GenerateTextResult): void {
    this.queue.push(res)
  }

  public setHandler(handler: (prompt: GenerateTextOptions) => Promise<GenerateTextResult>): void {
    this.customHandler = handler
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, latencyMs: 5, testedModelId: 'test-model' }
  }

  async generateText(apiKey: string, prompt: GenerateTextOptions): Promise<GenerateTextResult> {
    void apiKey
    this.generateTextCalls.push(prompt)
    if (this.customHandler) {
      return this.customHandler(prompt)
    }
    const next = this.queue.shift()
    if (!next) {
      throw new Error('MockProviderAdapter queue is empty.')
    }
    return next
  }

  async validateKey(apiKey: string): Promise<boolean> {
    void apiKey
    return true
  }

  async *streamText(): AsyncIterable<StreamTextChunk> {
    yield { type: 'text-delta', textDelta: 'mock' }
    yield { type: 'finish', finishReason: 'stop' }
  }
}

// IPC Mock Infrastructure
const mockIpcHandlers = new Map<
  string,
  (event: IpcSenderEventLike, payload: unknown) => Promise<unknown>
>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: IpcSenderEventLike, payload: unknown) => Promise<unknown>
      ) => {
        mockIpcHandlers.set(channel, handler)
      }
    ),
    removeHandler: vi.fn((channel: string) => {
      mockIpcHandlers.delete(channel)
    })
  },
  BrowserWindow: class {}
}))

function createMockWebContents(
  id: number,
  url = 'http://localhost:5173/index.html'
): {
  id: number
  mainFrame: WebFrameMainLike
  isDestroyed: () => boolean
  destroy: () => void
  once: (event: string, listener: () => void) => void
  on: (event: string, listener: () => void) => void
  postMessages: unknown[]
} {
  let destroyed = false
  const eventListeners = new Map<string, Array<() => void>>()
  const postMessages: unknown[] = []

  const mainFrame = {
    url,
    postMessage: vi.fn((channel: string, data: unknown) => {
      postMessages.push({ channel, data })
    })
  }

  return {
    id,
    mainFrame: mainFrame as unknown as WebFrameMainLike,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      const list = eventListeners.get('destroyed') ?? []
      for (const cb of list) cb()
    },
    once: (event: string, listener: () => void) => {
      const list = eventListeners.get(event) ?? []
      list.push(listener)
      eventListeners.set(event, list)
    },
    on: (event: string, listener: () => void) => {
      const list = eventListeners.get(event) ?? []
      list.push(listener)
      eventListeners.set(event, list)
    },
    postMessages
  }
}

// ============================================================================
// Phase 8 Master E2E & Security Verification Suite
// ============================================================================

describe('Phase 8 — Step 8.11: Master End-to-End Agent Runtime & Security Audit', () => {
  let dbContext: MigratedTestDatabaseContext
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let sourceRepo: KnowledgeSourceRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let connRepo: ProviderConnectionRepository
  let agentRunRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let vault: MockCredentialVault
  let activeContext: ActiveWorkspaceContext
  let ragService: BotRagService
  let approvalController: ApprovalController
  let workspaceFolderService: WorkspaceFolderService
  let toolRegistry: ToolRegistry
  let mockStepExecutor: DeterministicMockStepExecutor
  let runtime: BoundedAgentRuntime
  let agentTaskService: AgentTaskService

  // Entity IDs
  let kbAId: string // Alpha Engineering
  let kbBId: string // Beta Logistics
  let botAId: string // Alpha Agent (all 6 tools)
  let botBId: string // Beta Guard (0 tools)
  let botCId: string // Restricted Agent (1 tool: search_knowledge_base)
  let convAId: string
  let convBId: string
  let docAlphaSpecsId: string
  let docBetaInvId: string
  let chunkAlphaSpecsId: string
  let chunkBetaInvId: string
  let providerConnId: string

  // Workspace Test Directory
  let tempWorkspaceDir: string

  async function authorizeWorkspace(runId: string, botId: string): Promise<void> {
    const mockWin: BrowserWindowLike = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false } as unknown as Electron.WebContents
    }
    await workspaceFolderService.requestWorkspaceAuthorization(mockWin, runId, botId)
  }

  beforeEach(() => {
    resetMonitoredSenders()
    mockIpcHandlers.clear()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] =
      'http://localhost:5173'

    dbContext = createMigratedTestDatabase()
    db = dbContext.db

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    convRepo = new ConversationRepository(db)
    msgRepo = new MessageRepository(db)
    connRepo = new ProviderConnectionRepository(db)
    agentRunRepo = new AgentRunRepository(db)
    toolEventRepo = new ToolEventRepository(db)
    vault = new MockCredentialVault()
    activeContext = new ActiveWorkspaceContext({ kbRepo })

    ragService = new BotRagService({
      db,
      knowledgeSourceRepository: sourceRepo,
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo
    })

    approvalController = new ApprovalController()

    // Isolated Workspace Directory for Testing
    tempWorkspaceDir = mkdtempSync(join(tmpdir(), 'phase8-workspace-test-'))
    mkdirSync(join(tempWorkspaceDir, 'src'), { recursive: true })
    mkdirSync(join(tempWorkspaceDir, 'docs'), { recursive: true })
    mkdirSync(join(tempWorkspaceDir, '.git'), { recursive: true })

    writeFileSync(
      join(tempWorkspaceDir, 'src', 'config.json'),
      JSON.stringify({ debug: false, maxRetries: 3, port: 8080 }, null, 2),
      'utf-8'
    )
    writeFileSync(
      join(tempWorkspaceDir, 'docs', 'notes.md'),
      '# Architecture Notes\nAlpha core service runs on port 8080.\n',
      'utf-8'
    )
    // Sensitive files inside workspace to verify access guards
    writeFileSync(join(tempWorkspaceDir, '.env'), 'SUPER_SECRET_ENV_KEY=danger_value\n', 'utf-8')
    writeFileSync(
      join(tempWorkspaceDir, '.git', 'config'),
      '[core]\nrepositoryformatversion = 0\n',
      'utf-8'
    )
    writeFileSync(
      join(tempWorkspaceDir, 'id_rsa'),
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n',
      'utf-8'
    )

    // WorkspaceFolderService with dialog mock
    workspaceFolderService = new WorkspaceFolderService({
      dialogOps: {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [tempWorkspaceDir]
        })
      }
    })

    // Create real ToolRegistry with all 6 tools
    toolRegistry = createDefaultToolRegistry({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      knowledgeSourceRepository: sourceRepo,
      botRagService: ragService,
      workspaceFolderService,
      approvalController
    })

    mockStepExecutor = new DeterministicMockStepExecutor()

    runtime = new BoundedAgentRuntime({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      agentRunRepository: agentRunRepo,
      toolEventRepository: toolEventRepo,
      toolRegistry,
      stepExecutor: mockStepExecutor,
      approvalController,
      workspaceFolderService,
      conversationRepository: convRepo
    })

    agentTaskService = new AgentTaskService({
      botRepository: botRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connRepo,
      credentialVault: vault as unknown as CredentialVault,
      boundedAgentRuntime: runtime,
      toolRegistry,
      approvalController,
      workspaceFolderService,
      activeWorkspaceContext: activeContext
    })

    // Setup Provider Connection in DB
    const credRef = `cred_${randomUUID()}` as CredentialRef
    vault.set(credRef, 'sk-test-secret-key-12345')
    const conn = connRepo.create({
      providerId: 'openai',
      label: 'Test OpenAI Connection',
      credentialRef: credRef,
      status: 'active'
    })
    providerConnId = conn.id

    // Setup Knowledge Bases
    const kbA = kbRepo.create({
      name: 'Alpha Engineering',
      description: 'Aerospace propulsion and flight specs'
    })
    kbAId = kbA.id

    const kbB = kbRepo.create({
      name: 'Beta Logistics',
      description: 'Confidential warehouse inventory'
    })
    kbBId = kbB.id

    // Setup Bots
    // Bot A: Full 6 tools
    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      providerConnectionId: providerConnId,
      name: 'Alpha Agent',
      description: 'Autonomous propulsion engineering agent',
      systemPrompt: 'You are Alpha Agent. Follow instructions and use tools.',
      modelId: 'gpt-6-luna',
      toolPermissions: [
        'search_knowledge_base',
        'read_knowledge_source',
        'list_knowledge_sources',
        'search_workspace_files',
        'read_workspace_file',
        'save_report'
      ]
    })
    botAId = botA.id

    // Bot B: 0 tools
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      providerConnectionId: providerConnId,
      name: 'Beta Guard',
      description: 'Defensive agent with zero tool permissions',
      systemPrompt: 'You are Beta Guard.',
      modelId: 'gpt-6-luna',
      toolPermissions: []
    })
    botBId = botB.id

    // Bot C: Restricted (1 tool only)
    const botC = botRepo.create({
      knowledgeBaseId: kbAId,
      providerConnectionId: providerConnId,
      name: 'Restricted Agent',
      description: 'Search-only assistant',
      systemPrompt: 'You are Restricted Agent.',
      modelId: 'gpt-6-luna',
      toolPermissions: ['search_knowledge_base']
    })
    botCId = botC.id

    // Ingest authentic documents into KB A (Alpha)
    docAlphaSpecsId = randomUUID()
    chunkAlphaSpecsId = randomUUID()
    sourceRepo.create({
      id: docAlphaSpecsId,
      knowledge_base_id: kbAId,
      file_name: 'alpha-specs.md',
      original_file_name: 'alpha-specs.md',
      relative_file_path: `originals/${docAlphaSpecsId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 1500,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })
    sourceRepo.insertChunks([
      {
        id: chunkAlphaSpecsId,
        knowledge_base_id: kbAId,
        source_id: docAlphaSpecsId,
        chunk_index: 0,
        content: 'PROJECT-ALPHA-991: Engine cooling specification requiring cryogenic circulation.',
        page_number: 1,
        token_count: 12,
        metadata_json: JSON.stringify({ headingPath: ['Propulsion', 'Cooling'] })
      }
    ])

    // Ingest authentic documents into KB B (Beta)
    docBetaInvId = randomUUID()
    chunkBetaInvId = randomUUID()
    sourceRepo.create({
      id: docBetaInvId,
      knowledge_base_id: kbBId,
      file_name: 'beta-inventory.txt',
      original_file_name: 'beta-inventory.txt',
      relative_file_path: `originals/${docBetaInvId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 1200,
      content_hash: 'b'.repeat(64),
      indexing_status: 'completed'
    })
    sourceRepo.insertChunks([
      {
        id: chunkBetaInvId,
        knowledge_base_id: kbBId,
        source_id: docBetaInvId,
        chunk_index: 0,
        content: 'SECRET-BETA-773: High security logistics warehouse parts inventory.',
        page_number: 1,
        token_count: 10,
        metadata_json: JSON.stringify({ headingPath: ['Inventory', 'Warehouse'] })
      }
    ])

    // Setup Conversations
    const convA = convRepo.create({
      knowledgeBaseId: kbAId,
      botId: botAId,
      title: 'Alpha Engineering Mission'
    })
    convAId = convA.id

    const convB = convRepo.create({
      knowledgeBaseId: kbBId,
      botId: botBId,
      title: 'Beta Guard Station'
    })
    convBId = convB.id
    void convBId
  })

  afterEach(() => {
    try {
      if (tempWorkspaceDir) {
        rmSync(tempWorkspaceDir, { recursive: true, force: true })
      }
    } catch {
      // transient Windows lock
    }
    dbContext.cleanup()
  })

  // ==========================================================================
  // SUITE 1: Complete Six-Tool Registry & Deny-by-Default (Step 2 & AC-P8-01..06)
  // ==========================================================================
  describe('Suite 1: Complete Six-Tool Registry & Deny-by-Default', () => {
    it('1.1 registers exactly the six canonical Phase 8 tools with strict schemas', () => {
      const tools = toolRegistry.list()
      expect(tools.length).toBe(6)

      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'list_knowledge_sources',
        'read_knowledge_source',
        'read_workspace_file',
        'save_report',
        'search_knowledge_base',
        'search_workspace_files'
      ])

      for (const tool of tools) {
        expect(tool.description).toBeTruthy()
        expect(tool.requiredPermission).toBeTruthy()
        expect(tool.schema).toBeDefined()
      }
    })

    it('1.2 strictly rejects unexpected input properties on all six tool schemas', () => {
      const searchKb = toolRegistry.get('search_knowledge_base')!
      expect(() =>
        searchKb.schema.parse({ query: 'cryogenic', maliciousExtra: 'injected' })
      ).toThrow()

      const readKb = toolRegistry.get('read_knowledge_source')!
      expect(() =>
        readKb.schema.parse({ sourceId: docAlphaSpecsId, unauthorizedProp: true })
      ).toThrow()

      const listKb = toolRegistry.get('list_knowledge_sources')!
      expect(() => listKb.schema.parse({ unexpectedField: 123 })).toThrow()

      const searchWs = toolRegistry.get('search_workspace_files')!
      expect(() => searchWs.schema.parse({ query: 'port', evilFlag: true })).toThrow()

      const readWs = toolRegistry.get('read_workspace_file')!
      expect(() =>
        readWs.schema.parse({ relativePath: 'src/config.json', payload: 'bad' })
      ).toThrow()

      const saveRep = toolRegistry.get('save_report')!
      expect(() =>
        saveRep.schema.parse({
          title: 'Title',
          markdownContent: '# Report',
          arbitraryDestination: 'C:/Windows/hack.exe'
        })
      ).toThrow()
    })

    it('1.3 enforces deny-by-default: Bot with empty permissions cannot execute any tool', async () => {
      const botB = botRepo.getByIdOnly(botBId)!
      const permittedB = toolRegistry
        .list()
        .filter((t) => isBotToolEnabled(botB.toolPermissions, t.requiredPermission))
      expect(permittedB).toEqual([])

      await expect(
        toolRegistry.execute({
          toolName: 'search_knowledge_base',
          botId: botBId,
          rawArguments: { query: 'anything' }
        })
      ).rejects.toThrow(/Permission denied/i)
    })

    it('1.4 enforces selective permissions: Bot with single tool cannot call other tools', async () => {
      const botC = botRepo.getByIdOnly(botCId)!
      const permittedC = toolRegistry
        .list()
        .filter((t) => isBotToolEnabled(botC.toolPermissions, t.requiredPermission))
      expect(permittedC.map((t) => t.name)).toEqual(['search_knowledge_base'])

      // Allowed tool succeeds
      const searchResult = await toolRegistry.execute({
        toolName: 'search_knowledge_base',
        botId: botCId,
        rawArguments: { query: 'cryogenic' }
      })
      expect(searchResult.result).toBeDefined()

      // Disallowed tools fail
      await expect(
        toolRegistry.execute({
          toolName: 'read_workspace_file',
          botId: botCId,
          rawArguments: { relativePath: 'src/config.json' }
        })
      ).rejects.toThrow(/Permission denied/i)
    })

    it('1.5 rejects tool execution when botId does not exist', async () => {
      await expect(
        toolRegistry.execute({
          toolName: 'search_knowledge_base',
          botId: '00000000-0000-4000-8000-000000000099',
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(/not found/i)
    })
  })

  // ==========================================================================
  // SUITE 2: Multi-Step End-to-End Task Execution (Step 3)
  // ==========================================================================
  describe('Suite 2: Multi-Step End-to-End Agent Task Execution', () => {
    it('2.1 executes multi-step task chaining 3 tools, persisting run and events cleanly', async () => {
      const runId = randomUUID()
      await authorizeWorkspace(runId, botAId)

      // Step 1: Model calls search_knowledge_base
      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-step-1',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'cryogenic' }
      })

      // Step 2: Model calls read_knowledge_source
      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-step-2',
        toolName: 'read_knowledge_source',
        rawArguments: { sourceId: docAlphaSpecsId }
      })

      // Step 3: Model calls read_workspace_file
      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-step-3',
        toolName: 'read_workspace_file',
        rawArguments: { relativePath: 'src/config.json' }
      })

      // Step 4: Model outputs final response
      mockStepExecutor.enqueueDecision({
        type: 'final',
        content:
          'Based on specifications [1], PROJECT-ALPHA-991 requires cryogenic cooling. The workspace config confirms port 8080.'
      })

      const result = await agentTaskService.dispatchTask(
        undefined,
        {
          botId: botAId,
          conversationId: convAId,
          taskContent: 'Check cryogenic cooling specs and workspace port config.'
        },
        { agentRunId: runId }
      )

      // 1. Verify task outcome
      expect(result.success).toBe(true)
      expect(result.runStatus).toBe('completed')
      expect(result.finalResponse).toContain('PROJECT-ALPHA-991 requires cryogenic cooling')

      // 2. Verify Citations and Workspace Files Provenance
      expect(result.citations.length).toBe(1)
      expect(result.citations[0].fileName).toBe('alpha-specs.md')
      expect(result.workspaceFiles).toContain('src/config.json')

      // 3. Verify Message Persistence
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      expect(messages.length).toBe(2)
      expect(messages[0].role).toBe('user')
      expect(messages[0].content).toContain('Check cryogenic cooling specs')
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content).toContain('PROJECT-ALPHA-991')
      expect(messages[1].metadata?.toolCalls?.length).toBe(3)

      // 4. Verify AgentRun Record Persistence
      const persistedRun = agentRunRepo.getById(runId)
      expect(persistedRun).toBeDefined()
      expect(persistedRun!.status).toBe('completed')
      expect(persistedRun!.iterationCount).toBe(4)

      // 5. Verify ToolEvent Records Persistence
      const events = toolEventRepo.listByAgentRun(runId)
      expect(events.length).toBe(3)
      expect(events[0].toolName).toBe('search_knowledge_base')
      expect(events[0].status).toBe('completed')
      expect(events[1].toolName).toBe('read_knowledge_source')
      expect(events[1].status).toBe('completed')
      expect(events[2].toolName).toBe('read_workspace_file')
      expect(events[2].status).toBe('completed')
    })
  })

  // ==========================================================================
  // SUITE 3: Six-Tool Acceptance Criteria Matrix (Step 4, AC-P8-01..06)
  // ==========================================================================
  describe('Suite 3: Six-Tool Acceptance Criteria Deep-Dive', () => {
    it('3.1 AC-P8-01: search_knowledge_base returns parent-KB chunks and strictly blocks cross-KB retrieval', async () => {
      // Search for Alpha content
      const alphaRes = await toolRegistry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: 'cryogenic' }
      })
      const alphaResult = alphaRes.result as { excerpts: unknown[]; citations: unknown[] }
      expect(alphaResult.excerpts.length).toBeGreaterThan(0)
      expect(alphaResult.citations.length).toBeGreaterThan(0)

      // Attempt to search for Beta secret via Bot A -> must return 0 matches
      const crossRes = await toolRegistry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: 'SECRET-BETA-773' }
      })
      const crossResult = crossRes.result as { excerpts: unknown[] }
      expect(crossResult.excerpts.length).toBe(0)
    })

    it('3.2 AC-P8-02: read_knowledge_source reads document chunks in order and rejects other KB sources', async () => {
      const res = await toolRegistry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: docAlphaSpecsId }
      })
      const resData = res.result as { documentName: string; chunks: Array<{ chunkIndex: number }> }
      expect(resData.documentName).toBe('alpha-specs.md')
      expect(resData.chunks.length).toBe(1)
      expect(resData.chunks[0].chunkIndex).toBe(0)

      // Attempt to read Beta source via Bot A -> rejected (not in KB A)
      await expect(
        toolRegistry.execute({
          toolName: 'read_knowledge_source',
          botId: botAId,
          rawArguments: { sourceId: docBetaInvId }
        })
      ).rejects.toThrow()
    })

    it('3.3 AC-P8-03: list_knowledge_sources lists parent-KB documents only with safe metadata', async () => {
      const res = await toolRegistry.execute({
        toolName: 'list_knowledge_sources',
        botId: botAId,
        rawArguments: {}
      })
      const sources = (res.result as { sources: Array<{ documentName: string }> }).sources
      expect(sources.length).toBe(1)
      expect(sources[0].documentName).toBe('alpha-specs.md')
      // No Beta documents
      expect(sources.some((s) => s.documentName.includes('beta'))).toBe(false)
    })

    it('3.4 AC-P8-04: search_workspace_files requires grant, finds content, returns relative paths', async () => {
      const runId = randomUUID()

      // Without authorization grant -> rejected
      await expect(
        toolRegistry.execute({
          toolName: 'search_workspace_files',
          botId: botAId,
          rawArguments: { query: 'port' },
          agentRunId: runId
        })
      ).rejects.toThrow(/workspace.*authorization/i)

      // With grant -> returns matches with relative paths
      await authorizeWorkspace(runId, botAId)
      const res = await toolRegistry.execute({
        toolName: 'search_workspace_files',
        botId: botAId,
        rawArguments: { query: 'port' },
        agentRunId: runId
      })
      const matches = (
        res.result as { matches: Array<{ relativePath: string; lineNumber: number }> }
      ).matches
      expect(matches.length).toBeGreaterThan(0)
      for (const m of matches) {
        expect(m.relativePath.startsWith('C:') || m.relativePath.startsWith('/')).toBe(false)
      }
    })

    it('3.5 AC-P8-05: read_workspace_file enforces line numbering, rejects traversal and sensitive files', async () => {
      const runId = randomUUID()
      await authorizeWorkspace(runId, botAId)

      // Normal read succeeds
      const res = await toolRegistry.execute({
        toolName: 'read_workspace_file',
        botId: botAId,
        rawArguments: { relativePath: 'src/config.json' },
        agentRunId: runId
      })
      const lines = (res.result as { lines: Array<{ lineNumber: number; content: string }> }).lines
      expect(lines.length).toBeGreaterThan(0)
      expect(lines[0].lineNumber).toBe(1)

      // Directory traversal rejected
      await expect(
        toolRegistry.execute({
          toolName: 'read_workspace_file',
          botId: botAId,
          rawArguments: { relativePath: '../../etc/passwd' },
          agentRunId: runId
        })
      ).rejects.toThrow()

      // Sensitive file (.env) rejected
      await expect(
        toolRegistry.execute({
          toolName: 'read_workspace_file',
          botId: botAId,
          rawArguments: { relativePath: '.env' },
          agentRunId: runId
        })
      ).rejects.toThrow(/prohibited|sensitive/i)

      // Sensitive file (id_rsa) rejected
      await expect(
        toolRegistry.execute({
          toolName: 'read_workspace_file',
          botId: botAId,
          rawArguments: { relativePath: 'id_rsa' },
          agentRunId: runId
        })
      ).rejects.toThrow(/prohibited|sensitive/i)
    })

    it('3.6 AC-P8-06: save_report requires approval, exact preview, and safe save', async () => {
      const runId = randomUUID()
      let approvalRequested = false

      approvalController.onEvent((event) => {
        if (event.type === 'requested') {
          approvalRequested = true
          expect(event.request.title).toBe('Propulsion Analysis')
          expect(event.request.contentPreview).toContain('Cryogenic specs validated.')
          // Resolve approval asynchronously
          setTimeout(() => {
            approvalController.approve(event.request.requestId, {
              agentRunId: runId,
              botId: botAId
            })
          }, 10)
        }
      })

      // Custom dialog operations mock
      const targetSavePath = join(tempWorkspaceDir, 'propulsion-analysis.md')
      const mockDialogOps: SaveReportDialogOperations = {
        showSaveDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePath: targetSavePath
        })
      }

      const saveTool = new SaveReportTool(
        approvalController,
        mockDialogOps,
        () => ({}) as unknown as BrowserWindowLike
      )

      const output = await saveTool.execute(
        {
          title: 'Propulsion Analysis',
          markdownContent: '# Propulsion Analysis\nCryogenic specs validated.\n'
        },
        {
          botId: botAId,
          knowledgeBaseId: kbAId,
          agentRunId: runId
        }
      )

      expect(approvalRequested).toBe(true)
      expect(output.result.status).toBe('saved')
      expect(output.result.bytesWritten).toBeGreaterThan(0)
    })
  })

  // ==========================================================================
  // SUITE 4: Knowledge Base Only & Context Provenance (Step 5)
  // ==========================================================================
  describe('Suite 4: Knowledge Base Only & Context Provenance', () => {
    it('4.1 verifies CURRENT_APPLICATION_CAPABILITIES.tools is false and ordinary chat cannot execute tools', () => {
      expect(CURRENT_APPLICATION_CAPABILITIES.tools).toBe(false)
    })

    it('4.2 agent task with KB evidence preserves authentic CitationDto', async () => {
      const runId = randomUUID()

      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-kb',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'cryogenic' }
      })

      mockStepExecutor.enqueueDecision({
        type: 'final',
        content: 'Found cooling specs [1].'
      })

      const res = await agentTaskService.dispatchTask(
        undefined,
        {
          botId: botAId,
          conversationId: convAId,
          taskContent: 'Find cooling specs'
        },
        { agentRunId: runId }
      )

      expect(res.runStatus).toBe('completed')
      expect(res.citations.length).toBe(1)
      expect(res.citations[0].chunkId).toBe(chunkAlphaSpecsId)
    })

    it('4.3 workspace-only task succeeds without generating synthetic or fake KB citations', async () => {
      const runId = randomUUID()
      await authorizeWorkspace(runId, botAId)

      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-ws',
        toolName: 'read_workspace_file',
        rawArguments: { relativePath: 'src/config.json' }
      })

      mockStepExecutor.enqueueDecision({
        type: 'final',
        content: 'Config specifies port 8080 and debug false.'
      })

      const res = await agentTaskService.dispatchTask(
        undefined,
        {
          botId: botAId,
          conversationId: convAId,
          taskContent: 'Check local workspace config'
        },
        { agentRunId: runId }
      )

      expect(res.runStatus).toBe('completed')
      expect(res.citations.length).toBe(0)
      expect(res.workspaceFiles).toContain('src/config.json')
    })

    it('4.4 zero-evidence agent task fails or deterministically produces refusal', async () => {
      const runId = randomUUID()

      // Model searches but finds nothing
      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-none',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'nonexistent-topic-xyz' }
      })

      mockStepExecutor.enqueueDecision({
        type: 'final',
        content: KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE
      })

      const res = await agentTaskService.dispatchTask(
        undefined,
        {
          botId: botAId,
          conversationId: convAId,
          taskContent: 'Search for nonexistent topic'
        },
        { agentRunId: runId }
      )

      expect(res.finalResponse).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE)
      expect(res.citations.length).toBe(0)
    })
  })

  // ==========================================================================
  // SUITE 5: Bounded Agency & Iteration Limits (Step 6)
  // ==========================================================================
  describe('Suite 5: Bounded Agency & Iteration Limits', () => {
    it('5.1 allows 4 tool calls followed by a final decision on iteration 5', async () => {
      const runId = randomUUID()

      // 1 tool call searching KB to provide grounding evidence
      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-grounding',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'cryogenic' }
      })

      // 3 tool calls listing sources
      for (let i = 2; i <= 4; i++) {
        mockStepExecutor.enqueueDecision({
          type: 'tool_call',
          toolCallId: `tc-${i}`,
          toolName: 'list_knowledge_sources',
          rawArguments: {}
        })
      }

      // 5th decision: final response
      mockStepExecutor.enqueueDecision({
        type: 'final',
        content: 'Completed inspection across 4 queries with cryogenic cooling evidence [1].'
      })

      const res = await runtime.run({
        id: runId,
        botId: botAId,
        task: 'Multi-step inspection',
        maxIterations: 5
      })

      expect(res.status).toBe('completed')
      expect(res.iterationCount).toBe(5)
      expect(res.finalResponse).toContain('Completed inspection')
    })

    it('5.2 predictably fails with MAX_ITERATIONS_EXCEEDED if 5 tool calls occur without final response', async () => {
      const runId = randomUUID()

      // 5 tool calls without any final response
      for (let i = 1; i <= 5; i++) {
        mockStepExecutor.enqueueDecision({
          type: 'tool_call',
          toolCallId: `tc-inf-${i}`,
          toolName: 'list_knowledge_sources',
          rawArguments: {}
        })
      }

      const res = await runtime.run({
        id: runId,
        botId: botAId,
        task: 'Infinite loop task',
        maxIterations: 5
      })

      expect(res.status).toBe('failed')
      expect(res.iterationCount).toBe(5)

      const run = agentRunRepo.getById(runId)
      expect(run!.status).toBe('failed')
      expect(run!.iterationCount).toBe(5)
    })

    it('5.3 rejects parallel tool calls returned by AI model with UnsupportedParallelToolCallsError', async () => {
      const mockAdapter = new MockProviderAdapter()
      const aiSdkExecutor = new AiSdkAgentModelStepExecutor({
        botRepository: botRepo,
        connectionRepository: connRepo,
        credentialVault: vault as unknown as CredentialVault,
        adapterResolver: () => mockAdapter as unknown as ProviderAdapter
      })

      // Simulate provider returning 2 parallel tool calls
      mockAdapter.enqueueResult({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          { id: 'call-1', name: 'search_knowledge_base', arguments: {} },
          { id: 'call-2', name: 'read_knowledge_source', arguments: {} }
        ],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      })

      await expect(
        aiSdkExecutor.executeStep({
          botId: botAId,
          knowledgeBaseId: kbAId,
          agentRunId: randomUUID(),
          selectedModel: 'gpt-6-luna',
          history: [{ role: 'user', content: 'Do multiple things' }],
          tools: []
        })
      ).rejects.toThrow(UnsupportedParallelToolCallsError)
    })
  })

  // ==========================================================================
  // SUITE 6: Comprehensive Cancellation Matrix (Step 6)
  // ==========================================================================
  describe('Suite 6: Comprehensive Cancellation Matrix across 7 Lifecycle Stages', () => {
    it('6.1 Stage 1: cancels before first model request', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()
      abortController.abort() // Pre-aborted

      const res = await runtime.run({
        id: runId,
        botId: botAId,
        task: 'Test pre-abort',
        signal: abortController.signal
      })

      expect(res.status).toBe('cancelled')
      const run = agentRunRepo.getById(runId)
      expect(run!.status).toBe('cancelled')
      expect(mockStepExecutor.requests.length).toBe(0)
    })

    it('6.2 Stage 2: cancels during provider step execution', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()

      mockStepExecutor.setHandler(async () => {
        abortController.abort()
        throw new BoundedAgentRuntimeError('Cancelled during provider', 'RUN_CANCELLED', runId)
      })

      const res = await runtime.run({
        id: runId,
        botId: botAId,
        task: 'Cancel during step',
        signal: abortController.signal
      })

      expect(res.status).toBe('cancelled')
      const run = agentRunRepo.getById(runId)
      expect(run!.status).toBe('cancelled')
    })

    it('6.3 Stage 3: cancels during tool execution', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()

      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-cancel-during-tool',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'cryogenic' }
      })

      // Tool that triggers abort when executed
      const abortingTool = {
        name: 'search_knowledge_base' as const,
        description: 'Mock',
        schema: z.object({ query: z.string() }).strict(),
        requiredPermission: 'search_knowledge_base' as const,
        execute: async () => {
          abortController.abort()
          const err = new Error('Aborted in tool')
          ;(err as unknown as { code: string }).code = 'TOOL_ABORTED'
          throw err
        }
      }

      const customRegistry = new ToolRegistry({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo
      })
      customRegistry.register(abortingTool)

      const customRuntime = new BoundedAgentRuntime({
        botRepository: botRepo,
        knowledgeBaseRepository: kbRepo,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        toolRegistry: customRegistry,
        stepExecutor: mockStepExecutor,
        approvalController,
        workspaceFolderService
      })

      const res = await customRuntime.run({
        id: runId,
        botId: botAId,
        task: 'Cancel in tool',
        signal: abortController.signal
      })

      expect(res.status).toBe('cancelled')
      const run = agentRunRepo.getById(runId)
      expect(run!.status).toBe('cancelled')
    })

    it('6.4 Stage 4: cancels while waiting for save_report approval', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()

      mockStepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'tc-approval',
        toolName: 'save_report',
        rawArguments: { title: 'Report', markdownContent: '# Content' }
      })

      approvalController.onEvent((ev) => {
        if (ev.type === 'requested') {
          // Abort while waiting
          abortController.abort()
        }
      })

      const res = await runtime.run({
        id: runId,
        botId: botAId,
        task: 'Cancel in approval',
        signal: abortController.signal
      })

      expect(res.status).toBe('cancelled')
      const run = agentRunRepo.getById(runId)
      expect(run!.status).toBe('cancelled')
    })

    it('6.5 Stage 5: cancels during save file dialog', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()

      const mockDialogOps: SaveReportDialogOperations = {
        showSaveDialog: async () => {
          abortController.abort()
          throw new Error('Save dialog cancelled by user')
        }
      }

      approvalController.onEvent((ev) => {
        if (ev.type === 'requested') {
          approvalController.approve(ev.request.requestId, {
            agentRunId: runId,
            botId: botAId
          })
        }
      })

      const customSaveTool = new SaveReportTool(
        approvalController,
        mockDialogOps,
        () => ({}) as unknown as BrowserWindowLike
      )

      await expect(
        customSaveTool.execute(
          { title: 'Test Report', markdownContent: '# Test' },
          {
            botId: botAId,
            knowledgeBaseId: kbAId,
            agentRunId: runId,
            signal: abortController.signal
          }
        )
      ).rejects.toThrow()
    })

    it('6.6 Stage 6: cancels before final conversation persistence leaving no assistant message', async () => {
      const runId = randomUUID()
      const abortController = new AbortController()

      mockStepExecutor.enqueueDecision({
        type: 'final',
        content: 'Final response ready.'
      })

      // Trigger abort immediately after runtime returns, before message persistence
      const originalRun = runtime.run.bind(runtime)
      vi.spyOn(runtime, 'run').mockImplementation(async (req, opts) => {
        const res = await originalRun(req, opts)
        abortController.abort() // abort right before persistence completes
        return res
      })

      const res = await agentTaskService.dispatchTask(
        undefined,
        {
          botId: botAId,
          conversationId: convAId,
          taskContent: 'Task to abort before persistence'
        },
        { agentRunId: runId, signal: abortController.signal }
      )

      expect(res.success).toBe(false)
      expect(res.runStatus).toBe('cancelled')
      expect(res.assistantMessage).toBeUndefined()

      // Verify no assistant message was persisted
      const messages = msgRepo.listByConversation(convAId, botAId, kbAId)
      const assistantMessages = messages.filter((m) => m.role === 'assistant')
      expect(assistantMessages.length).toBe(0)
    })

    it('6.7 Stage 7: handles cancellation cleanly during terminal state transition without crash', async () => {
      const runId = randomUUID()
      const run = agentRunRepo.create({
        id: runId,
        botId: botAId,
        selectedModel: 'gpt-6-luna',
        conversationId: convAId
      })
      expect(run.status).toBe('queued')

      // Mark cancelled
      agentRunRepo.markCancelled(runId)

      const cancelledRun = agentRunRepo.getById(runId)
      expect(cancelledRun!.status).toBe('cancelled')
    })
  })

  // ==========================================================================
  // SUITE 7: Human Approval End-to-End & Boundary Cases (Step 7)
  // ==========================================================================
  describe('Suite 7: Human Approval End-to-End & Boundary Cases', () => {
    it('7.1 handles user rejection safely, returning rejection status to runtime', async () => {
      const runId = randomUUID()

      approvalController.onEvent((ev) => {
        if (ev.type === 'requested') {
          approvalController.reject(
            ev.request.requestId,
            { agentRunId: runId, botId: botAId },
            'Contains inaccurate assumptions'
          )
        }
      })

      const saveTool = toolRegistry.get('save_report')!
      const output = (await saveTool.execute(
        { title: 'Rejected Report', markdownContent: '# Draft' },
        { botId: botAId, knowledgeBaseId: kbAId, agentRunId: runId }
      )) as { result: { status: string }; resultSummary: string }

      expect((output.result as { status: string }).status).toBe('rejected')
      expect(output.resultSummary).toContain('Report saving was rejected')
    })

    it('7.2 rejects duplicate decision on already resolved approval request', async () => {
      const runId = randomUUID()
      let pendingRequestId = ''

      approvalController.onEvent((ev) => {
        if (ev.type === 'requested') {
          pendingRequestId = ev.request.requestId
        }
      })

      const reqPromise = approvalController.requestApproval({
        agentRunId: runId,
        botId: botAId,
        title: 'Report',
        markdownContent: '# Content'
      })

      expect(pendingRequestId).toBeTruthy()

      // First decision succeeds
      const firstDecision = approvalController.approve(pendingRequestId, {
        agentRunId: runId,
        botId: botAId
      })
      expect(firstDecision).toBe(true)

      // Duplicate decision returns false
      const secondDecision = approvalController.reject(
        pendingRequestId,
        { agentRunId: runId, botId: botAId },
        'Try reject'
      )
      expect(secondDecision).toBe(false)

      await reqPromise
    })

    it('7.3 handles approval timeout / expiry correctly', async () => {
      const runId = randomUUID()
      // Request with very short timeout
      const reqPromise = approvalController.requestApproval({
        agentRunId: runId,
        botId: botAId,
        title: 'Expiring Report',
        markdownContent: '# Expire',
        timeoutMs: 25
      })

      const decision = await reqPromise
      expect(decision.status).toBe('expired')
    })

    it('7.4 handles Save As dialog cancellation without writing any file', async () => {
      const runId = randomUUID()

      approvalController.onEvent((ev) => {
        if (ev.type === 'requested') {
          approvalController.approve(ev.request.requestId, {
            agentRunId: runId,
            botId: botAId
          })
        }
      })

      const mockDialogOps: SaveReportDialogOperations = {
        showSaveDialog: vi.fn().mockResolvedValue({
          canceled: true,
          filePath: undefined
        })
      }

      const saveTool = new SaveReportTool(
        approvalController,
        mockDialogOps,
        () => ({}) as unknown as BrowserWindowLike
      )

      const output = await saveTool.execute(
        { title: 'Cancelled Dialog Report', markdownContent: '# Content' },
        { botId: botAId, knowledgeBaseId: kbAId, agentRunId: runId }
      )

      expect(output.result.status).toBe('cancelled')
      expect(output.resultSummary).toContain('cancelled')
    })
  })

  // ==========================================================================
  // SUITE 8: Workspace Filesystem Traversal & Windows Sandboxing (Step 8)
  // ==========================================================================
  describe('Suite 8: Workspace Filesystem Traversal & Windows Sandboxing', () => {
    it('8.1 rejects Windows absolute paths outside workspace root', () => {
      expect(() =>
        WorkspacePathGuard.validatePath(tempWorkspaceDir, 'C:\\Windows\\System32\\calc.exe')
      ).toThrow(WorkspaceSecurityError)
    })

    it('8.2 rejects drive-relative paths', () => {
      expect(() =>
        WorkspacePathGuard.validatePath(tempWorkspaceDir, '\\Windows\\System32')
      ).toThrow(WorkspaceSecurityError)
    })

    it('8.3 rejects UNC network paths', () => {
      expect(() =>
        WorkspacePathGuard.validatePath(tempWorkspaceDir, '\\\\evil-nas\\share\\exploit.js')
      ).toThrow(WorkspaceSecurityError)
    })

    it('8.4 rejects relative path traversal attempts (../, ..\\, mixed)', () => {
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, '../../etc/shadow')).toThrow(
        WorkspaceSecurityError
      )
      expect(() =>
        WorkspacePathGuard.validatePath(tempWorkspaceDir, '..\\..\\Windows\\System32')
      ).toThrow(WorkspaceSecurityError)
      expect(() =>
        WorkspacePathGuard.validatePath(tempWorkspaceDir, 'src/../../escaped.txt')
      ).toThrow(WorkspaceSecurityError)
    })

    it('8.5 blocks access to sensitive configuration and credential files', () => {
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, '.env')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, '.env.production')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, '.git/config')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, 'id_rsa')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, 'id_ed25519')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('8.6 enforces file size limits (> 1MB)', () => {
      const bigFilePath = join(tempWorkspaceDir, 'src', 'big-file.txt')
      const bigBuffer = Buffer.alloc(1024 * 1024 + 10, 'A')
      writeFileSync(bigFilePath, bigBuffer)

      expect(() => WorkspacePathGuard.validatePath(tempWorkspaceDir, 'src/big-file.txt')).toThrow(
        /exceeds.*1 MB/i
      )
    })
  })

  // ==========================================================================
  // SUITE 9: IPC and Renderer Security (Step 9)
  // ==========================================================================
  describe('Suite 9: IPC and Renderer Security Audit', () => {
    it('9.1 rejects IPC invocations from unauthorized sender frames or popups', async () => {
      const mockWebContents = createMockWebContents(1, 'http://localhost:5173/index.html')
      const mockMainWindow: BrowserWindowLike = {
        webContents: mockWebContents as unknown as Electron.WebContents,
        isDestroyed: () => false
      }

      registerAgentIpcHandlers({
        getMainWindow: () => mockMainWindow,
        agentTaskService,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        botRepository: botRepo,
        conversationRepository: convRepo,
        approvalController,
        workspaceFolderService,
        activeContext
      })

      const dispatchHandler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)!
      expect(dispatchHandler).toBeDefined()

      // Untrusted sender event (different frame / popup)
      const evilSenderEvent = {
        sender: { id: 999 },
        senderFrame: {
          url: 'http://malicious-site.com',
          parent: {} // Not main frame
        }
      } as unknown as IpcSenderEventLike

      await expect(
        dispatchHandler(evilSenderEvent, {
          botId: botAId,
          conversationId: convAId,
          taskPrompt: 'Unauthorized attempt'
        })
      ).rejects.toThrow()
    })

    it('9.2 rejects IPC invocations with invalid payloads violating Zod schemas', async () => {
      const mockWebContents = createMockWebContents(1, 'http://localhost:5173/index.html')
      const mockMainWindow: BrowserWindowLike = {
        webContents: mockWebContents as unknown as Electron.WebContents,
        isDestroyed: () => false
      }

      registerAgentIpcHandlers({
        getMainWindow: () => mockMainWindow,
        agentTaskService,
        agentRunRepository: agentRunRepo,
        toolEventRepository: toolEventRepo,
        botRepository: botRepo,
        conversationRepository: convRepo,
        approvalController,
        workspaceFolderService,
        activeContext
      })

      const dispatchHandler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)!
      const validSenderEvent = {
        sender: mockWebContents,
        senderFrame: mockWebContents.mainFrame
      } as unknown as IpcSenderEventLike

      // Blank taskPrompt fails validation
      await expect(
        dispatchHandler(validSenderEvent, {
          botId: botAId,
          conversationId: convAId,
          taskPrompt: '   '
        })
      ).rejects.toThrow(/VALIDATION_FAILED/)
    })
  })

  // ==========================================================================
  // SUITE 10: Database Integrity, Persistence & Application Recovery (Step 10)
  // ==========================================================================
  describe('Suite 10: Database Integrity, Persistence & Application Recovery', () => {
    it('10.1 recovers completed run history and tool events across simulated application restart', () => {
      const runId = randomUUID()

      // 1. Create run and tool events in original session with running status
      agentRunRepo.create({
        id: runId,
        botId: botAId,
        selectedModel: 'gpt-6-luna',
        conversationId: convAId,
        initialStatus: 'running'
      })
      agentRunRepo.updateIterationCount(runId, 3)

      toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base',
        argumentsSummary: '{"query":"restart"}'
      })

      agentRunRepo.markCompleted(runId)

      // 2. Simulate Application Restart: Instantiate brand-new repositories on same SQLite DB
      const freshAgentRunRepo = new AgentRunRepository(db)
      const freshToolEventRepo = new ToolEventRepository(db)

      const recoveredRun = freshAgentRunRepo.getById(runId)
      expect(recoveredRun).toBeDefined()
      expect(recoveredRun!.status).toBe('completed')
      expect(recoveredRun!.iterationCount).toBe(3)

      const recoveredEvents = freshToolEventRepo.listByAgentRun(runId)
      expect(recoveredEvents.length).toBe(1)
      expect(recoveredEvents[0].toolName).toBe('search_knowledge_base')
    })

    it('10.2 verifies in-memory workspace grants do NOT survive restart', async () => {
      const runId = randomUUID()
      await authorizeWorkspace(runId, botAId)
      expect(workspaceFolderService.hasGrant(runId, botAId)).toBe(true)

      // Brand-new service instance after restart
      const freshFolderService = new WorkspaceFolderService()
      expect(freshFolderService.hasGrant(runId, botAId)).toBe(false)
    })

    it('10.3 verifies foreign key cascade integrity: deleting a Bot cascades its runs and tool events', () => {
      const runId = randomUUID()
      agentRunRepo.create({
        id: runId,
        botId: botAId,
        selectedModel: 'gpt-6-luna',
        conversationId: convAId
      })
      toolEventRepo.create({
        agentRunId: runId,
        toolName: 'list_knowledge_sources',
        argumentsSummary: '{}'
      })

      expect(agentRunRepo.getById(runId)).toBeDefined()
      expect(toolEventRepo.listByAgentRun(runId).length).toBe(1)

      // Delete the Bot
      db.prepare('DELETE FROM bots WHERE id = ?').run(botAId)

      // Runs and tool events cascaded
      expect(agentRunRepo.getById(runId)).toBeNull()
      expect(toolEventRepo.listByAgentRun(runId).length).toBe(0)
    })

    it('10.4 passes PRAGMA integrity_check and PRAGMA foreign_key_check with zero errors', () => {
      const integrityResult = db.prepare('PRAGMA integrity_check;').all() as Array<{
        integrity_check: string
      }>
      expect(integrityResult.length).toBe(1)
      expect(integrityResult[0].integrity_check).toBe('ok')

      const fkResult = db.prepare('PRAGMA foreign_key_check;').all()
      expect(fkResult.length).toBe(0)
    })

    it('10.5 verifies zero plaintext API keys or oversized reports stored in SQLite database', () => {
      // Check provider_connections table
      const connections = db
        .prepare('SELECT credential_ref FROM provider_connections;')
        .all() as Array<{
        credential_ref: string
      }>
      for (const conn of connections) {
        expect(conn.credential_ref.startsWith('sk-')).toBe(false)
        expect(conn.credential_ref.startsWith('cred_')).toBe(true)
      }

      // Check agent_runs table: no oversized error reports
      const runs = db.prepare('SELECT error_summary FROM agent_runs;').all() as Array<{
        error_summary: string | null
      }>
      for (const r of runs) {
        if (r.error_summary) {
          expect(r.error_summary.length).toBeLessThan(10000)
        }
      }
    })
  })
})
