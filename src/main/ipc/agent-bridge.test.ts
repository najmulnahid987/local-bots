import { describe, it, expect, beforeEach, vi } from 'vitest'
import nodeCrypto, { randomUUID } from 'node:crypto'
import {
  AGENT_IPC_CHANNELS,
  type AgentStreamEvent,
  AgentBridgeError,
  type DispatchAgentTaskResponse,
  type CancelAgentTaskResponse,
  type GetAgentRunResponse,
  type ListAgentRunsResponse,
  type ListToolEventsResponse,
  type ApprovalDetailsDto,
  type RespondToApprovalResponse
} from '../../shared/agents'
import { registerAgentIpcHandlers, registerFailingAgentIpcHandlers } from './agent-handlers'
import { AgentStreamManager } from './agent-stream-manager'
import { type MessagePortMainLike, type WebFrameWithPostMessage } from './provider-stream-manager'
import { createAgentsApi, normalizeAgentBridgeError } from '../../preload'
import { AgentTaskService } from '../services/agent-task-service'
import { BoundedAgentRuntime } from '../services/bounded-agent-runtime'
import { ToolRegistry } from '../tools/tool-registry'
import { ApprovalController } from '../services/approval-controller'
import { WorkspaceFolderService } from '../services/workspace-folder-service'
import { ConversationTurnService } from '../services/conversation-turn-service'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { CredentialVault } from '../security/credential-vault'
import type {
  ISafeStorageAdapter,
  SafeStorageDecryptionResult
} from '../security/credential-vault/types'
import { resetMonitoredSenders } from './bot-handlers'

class TestSafeStorageAdapter implements ISafeStorageAdapter {
  private key = nodeCrypto.randomBytes(32)
  public asyncAvailable = true

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.asyncAvailable
  }

  public async encryptStringAsync(plainText: string): Promise<Buffer> {
    const iv = nodeCrypto.randomBytes(12)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted])
  }

  public async decryptStringAsync(encrypted: Buffer): Promise<SafeStorageDecryptionResult> {
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const data = encrypted.subarray(28)
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    return { result: decrypted, shouldReEncrypt: false }
  }
}
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { type BrowserWindowLike, type IpcSenderEventLike, type WebContentsLike } from '../security'
import type {
  AgentModelStepExecutor,
  AgentModelStepResult
} from '../agents/agent-model-step-executor'
import { SearchWorkspaceFilesTool } from '../tools/workspace/search-workspace-files-tool'
import { ReadWorkspaceFileTool } from '../tools/workspace/read-workspace-file-tool'
import { SaveReportTool } from '../tools/report/save-report-tool'

type IpcListener = (event: unknown, ...args: unknown[]) => void

const { mockIpcHandlers, mockRendererListeners } = vi.hoisted(() => {
  return {
    mockIpcHandlers: new Map<
      string,
      (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
    >(),
    mockRendererListeners: new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  }
})

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
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        const handler = mockIpcHandlers.get(channel)
        if (!handler) {
          throw new Error(`No handler registered for channel '${channel}'`)
        }
        const defaultEvent: IpcSenderEventLike = {
          sender: defaultMockWebContents,
          senderFrame: defaultMockWebContents.mainFrame
        }
        return handler(defaultEvent, ...args)
      }),
      on: vi.fn((channel: string, listener: IpcListener) => {
        const list = mockRendererListeners.get(channel) ?? []
        list.push(listener)
        mockRendererListeners.set(channel, list)
      }),
      removeListener: vi.fn((channel: string, listener: IpcListener) => {
        const list = mockRendererListeners.get(channel) ?? []
        const idx = list.indexOf(listener)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
      })
    },
    dialog: {
      showOpenDialog: vi.fn()
    },
    BrowserWindow: vi.fn()
  }
})

let defaultMockWebContents: MockWebContentsWithEvents

class MockMessagePortMain implements MessagePortMainLike {
  public listeners = {
    message: [] as Array<(event: { data: unknown }) => void>,
    close: [] as Array<() => void>
  }
  public queue: unknown[] = []
  public remotePort: MockMessagePortMain | null = null
  public isClosed = false
  public isStarted = false

  public start(): void {
    this.isStarted = true
    this.flush()
  }

  public close(): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const listener of [...this.listeners.close]) {
      listener()
    }
  }

  public postMessage(message: unknown): void {
    if (this.remotePort && !this.remotePort.isClosed) {
      this.remotePort.queue.push(message)
      this.remotePort.flush()
    }
  }

  public flush(): void {
    if (!this.isStarted || this.listeners.message.length === 0) return
    while (this.queue.length > 0) {
      const msg = this.queue.shift()
      for (const listener of [...this.listeners.message]) {
        listener({ data: msg })
      }
    }
  }

  public on(
    event: 'message' | 'close',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (event === 'message') {
      this.listeners.message.push(listener as (event: { data: unknown }) => void)
      this.flush()
    } else if (event === 'close') {
      this.listeners.close.push(listener as () => void)
    }
  }

  public set onmessage(listener: ((event: { data: unknown }) => void) | null) {
    this.listeners.message = listener ? [listener] : []
    this.isStarted = true
    this.flush()
  }

  public get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.listeners.message[0] ?? null
  }
}

function createMockMessageChannel(): { port1: MockMessagePortMain; port2: MockMessagePortMain } {
  const port1 = new MockMessagePortMain()
  const port2 = new MockMessagePortMain()
  port1.remotePort = port2
  port2.remotePort = port1
  return { port1, port2 }
}

interface MockWebContentsWithEvents extends WebContentsLike {
  id: number
  mainFrame: WebFrameWithPostMessage
  eventListeners: Map<string, Array<() => void>>
  isDestroyed: () => boolean
  once: (event: string, listener: () => void) => void
  on: (event: string, listener: () => void) => void
  emit: (event: string) => void
}

function createMockWebContents(id = 1): MockWebContentsWithEvents {
  let destroyed = false
  const eventListeners = new Map<string, Array<() => void>>()

  const mainFrame: WebFrameWithPostMessage = {
    url: 'http://localhost:5173/index.html',
    postMessage: vi.fn((channel: string, payload: unknown, transfer?: unknown[]) => {
      const listeners = mockRendererListeners.get(channel) ?? []
      for (const listener of listeners) {
        listener({ ports: transfer }, payload)
      }
    })
  }

  const contents: MockWebContentsWithEvents = {
    id,
    mainFrame,
    eventListeners,
    isDestroyed: () => destroyed,
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
    emit: (event: string) => {
      if (event === 'destroyed') {
        destroyed = true
      }
      const list = eventListeners.get(event) ?? []
      eventListeners.delete(event)
      for (const listener of list) {
        listener()
      }
    }
  }

  return contents
}

describe('Agent IPC Bridge & Preload Integration (Phase 8 Step 8.9)', () => {
  let dbContext: MigratedTestDatabaseContext
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let runRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let connRepo: ProviderConnectionRepository
  let activeContext: ActiveWorkspaceContext
  let approvalController: ApprovalController
  let folderService: WorkspaceFolderService
  let toolRegistry: ToolRegistry
  let stepExecutor: AgentModelStepExecutor
  let runtime: BoundedAgentRuntime
  let taskService: AgentTaskService
  let streamManager: AgentStreamManager
  let turnService: ConversationTurnService
  let vault: CredentialVault

  const devOrigin = 'http://localhost:5173'
  let mockWebContents1: MockWebContentsWithEvents
  let mockWindow1: BrowserWindowLike
  let isWindow1Destroyed = false

  let kb1Id: string
  let kb2Id: string
  let bot1Id: string
  let bot2Id: string
  let conv1Id: string
  let conv2Id: string
  let connId: string

  beforeEach(async () => {
    resetMonitoredSenders()
    mockRendererListeners.clear()
    mockIpcHandlers.clear()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()

    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    convRepo = new ConversationRepository(dbContext.db)
    msgRepo = new MessageRepository(dbContext.db)
    runRepo = new AgentRunRepository(dbContext.db)
    toolEventRepo = new ToolEventRepository(dbContext.db)
    connRepo = new ProviderConnectionRepository(dbContext.db)
    activeContext = new ActiveWorkspaceContext(kbRepo)

    vault = new CredentialVault({
      vaultDir: dbContext.tempDir,
      safeStorage: new TestSafeStorageAdapter()
    })
    const credRef = await vault.store('sk-proj-test-mock-api-key-12345678')

    connId = randomUUID()
    const now = Date.now()
    dbContext.db
      .prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(connId, 'openai', 'OpenAI Work', credRef, 'active', now, now)

    // Two KBs
    const kb1 = kbRepo.create({ name: 'Alpha KB', description: 'Primary' })
    const kb2 = kbRepo.create({ name: 'Beta KB', description: 'Secondary' })
    kb1Id = kb1.id
    kb2Id = kb2.id

    // Two Bots with Phase 8 tools enabled
    const bot1 = botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Alpha Bot',
      description: 'Bot in KB1',
      systemPrompt: 'System prompt 1',
      providerConnectionId: connId,
      modelId: 'gpt-6-luna',
      toolPermissions: [
        'search_knowledge_base',
        'search_workspace_files',
        'read_workspace_file',
        'save_report'
      ]
    })
    bot1Id = bot1.id

    const bot2 = botRepo.create({
      knowledgeBaseId: kb2Id,
      name: 'Beta Bot',
      description: 'Bot in KB2',
      systemPrompt: 'System prompt 2',
      providerConnectionId: connId,
      modelId: 'gpt-6-luna',
      toolPermissions: ['search_knowledge_base']
    })
    bot2Id = bot2.id

    // Conversations
    const conv1 = convRepo.create({
      botId: bot1Id,
      knowledgeBaseId: kb1Id,
      title: 'Alpha Conversation'
    })
    conv1Id = conv1.id

    const conv2 = convRepo.create({
      botId: bot2Id,
      knowledgeBaseId: kb2Id,
      title: 'Beta Conversation'
    })
    conv2Id = conv2.id

    // Set Active KB for Session 1 to kb1Id
    activeContext.activateWorkspace(1, kb1Id)

    // Windows
    mockWebContents1 = createMockWebContents(1)
    defaultMockWebContents = mockWebContents1
    isWindow1Destroyed = false

    mockWindow1 = {
      isDestroyed: () => isWindow1Destroyed,
      webContents: mockWebContents1
    }

    approvalController = new ApprovalController()
    folderService = new WorkspaceFolderService({
      dialogOps: {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [dbContext.tempDir]
        })
      }
    })

    toolRegistry = new ToolRegistry({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo
    })
    toolRegistry.register(new SearchWorkspaceFilesTool(folderService))
    toolRegistry.register(new ReadWorkspaceFileTool(folderService))
    toolRegistry.register(new SaveReportTool(approvalController, undefined, () => mockWindow1))

    // Mock Step Executor returning a final response with evidence
    stepExecutor = {
      executeStep: vi.fn().mockImplementation(async () => {
        const res: AgentModelStepResult = {
          type: 'final',
          content: 'Here is the analysis based on workspace files.'
        }
        return res
      })
    }

    runtime = new BoundedAgentRuntime({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      agentRunRepository: runRepo,
      toolEventRepository: toolEventRepo,
      toolRegistry,
      stepExecutor,
      approvalController,
      workspaceFolderService: folderService,
      conversationRepository: convRepo
    })

    turnService = new ConversationTurnService({
      db: dbContext.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext,
      executionService: {
        executeTurn: vi.fn()
      } as unknown as NonNullable<
        ConstructorParameters<typeof ConversationTurnService>[0]['executionService']
      >,
      persistenceService: {
        persistUserMessage: vi.fn(),
        persistAssistantMessage: vi.fn()
      } as unknown as NonNullable<
        ConstructorParameters<typeof ConversationTurnService>[0]['persistenceService']
      >
    })

    taskService = new AgentTaskService({
      botRepository: botRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connRepo,
      credentialVault: vault,
      boundedAgentRuntime: runtime,
      toolRegistry,
      approvalController,
      workspaceFolderService: folderService,
      activeWorkspaceContext: activeContext,
      turnService
    })

    streamManager = new AgentStreamManager({
      channelFactory: createMockMessageChannel
    })

    registerAgentIpcHandlers({
      getMainWindow: () => mockWindow1,
      agentTaskService: taskService,
      agentStreamManager: streamManager,
      agentRunRepository: runRepo,
      toolEventRepository: toolEventRepo,
      botRepository: botRepo,
      conversationRepository: convRepo,
      approvalController,
      workspaceFolderService: folderService,
      activeContext,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connRepo
    })
  })

  // ==========================================================================
  // Suite 1: IPC Sender & Security Validation
  // ==========================================================================

  describe('Suite 1: IPC Sender & Security Validation', () => {
    it('1. allows invocations from trusted main frame of active BrowserWindow', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      expect(handler).toBeDefined()

      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run.id)

      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, { agentRunId: run.id })) as GetAgentRunResponse
      expect(res.run.id).toBe(run.id)
    })

    it('2. rejects untrusted or wrong BrowserWindow', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const otherWebContents = createMockWebContents(99)
      const event: IpcSenderEventLike = {
        sender: otherWebContents,
        senderFrame: otherWebContents.mainFrame
      }

      await expect(handler!(event, { agentRunId: randomUUID() })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('3. rejects destroyed BrowserWindow', async () => {
      isWindow1Destroyed = true
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(handler!(event, { agentRunId: randomUUID() })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('4. rejects child or popup frames', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const childFrame: WebFrameWithPostMessage = {
        url: 'http://localhost:5173/child.html',
        postMessage: vi.fn()
      }
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: childFrame
      }

      await expect(handler!(event, { agentRunId: randomUUID() })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('5. rejects untrusted frame URLs', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const untrustedFrame: WebFrameWithPostMessage = {
        url: 'https://malicious-site.example.com',
        postMessage: vi.fn()
      }
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: untrustedFrame
      }

      await expect(handler!(event, { agentRunId: randomUUID() })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('6. derives session identity from sender webContents (session 1)', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // Valid task dispatch on session 1 (active KB = kb1Id)
      const res = (await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Analyze files'
      })) as DispatchAgentTaskResponse

      expect(res.accepted).toBe(true)
      expect(res.status).toBe('running')
    })

    it('7. strictly rejects unexpected properties on dispatch request', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: bot1Id,
          conversationId: conv1Id,
          taskPrompt: 'Analyze files',
          sessionId: 'injected-session',
          workspacePath: 'C:\\secret'
        })
      ).rejects.toThrow(/VALIDATION_FAILED/)
    })
  })

  // ==========================================================================
  // Suite 2: Active Workspace & Cross-KB Isolation
  // ==========================================================================

  describe('Suite 2: Active Workspace & Cross-KB Isolation', () => {
    it('1. rejects dispatching task on Bot outside active Knowledge Base', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // bot2 belongs to kb2Id, active workspace is kb1Id
      await expect(
        handler!(event, {
          botId: bot2Id,
          conversationId: conv2Id,
          taskPrompt: 'Test task'
        })
      ).rejects.toThrow(/BOT_KB_MISMATCH/)
    })

    it('2. rejects dispatching task on Conversation from another Bot', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // conv2 belongs to bot2, but request specifies bot1
      await expect(
        handler!(event, {
          botId: bot1Id,
          conversationId: conv2Id,
          taskPrompt: 'Test task'
        })
      ).rejects.toThrow(/CONVERSATION_MISMATCH/)
    })

    it('3. rejects querying agent run belonging to another Knowledge Base', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // Create run under bot2 (KB2)
      const run2 = runRepo.create({
        botId: bot2Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run2.id)

      // Querying with sender 1 (active KB1) should return RUN_NOT_FOUND
      await expect(handler!(event, { agentRunId: run2.id })).rejects.toThrow(/RUN_NOT_FOUND/)
    })

    it('4. rejects listing tool events for run belonging to another Knowledge Base', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const run2 = runRepo.create({
        botId: bot2Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run2.id)

      await expect(handler!(event, { agentRunId: run2.id })).rejects.toThrow(/RUN_NOT_FOUND/)
    })
  })

  // ==========================================================================
  // Suite 3: Task Dispatch & Non-Blocking Lifecycle
  // ==========================================================================

  describe('Suite 3: Task Dispatch & Non-Blocking Lifecycle', () => {
    it('1. returns accepted response immediately without awaiting full task run', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Quick inspection'
      })) as DispatchAgentTaskResponse

      expect(res.accepted).toBe(true)
      expect(res.status).toBe('running')
      expect(typeof res.agentRunId).toBe('string')
      expect(res.conversationId).toBe(conv1Id)
    })

    it('2. rejects dispatch when Bot has no enabled Phase 8 tools', async () => {
      // Create bot with empty tool permissions
      const disabledBot = botRepo.create({
        knowledgeBaseId: kb1Id,
        name: 'Disabled Bot',
        systemPrompt: 'No tools',
        providerConnectionId: connId,
        modelId: 'gpt-6-luna',
        toolPermissions: []
      })
      const conv = convRepo.create({
        botId: disabledBot.id,
        knowledgeBaseId: kb1Id,
        title: 'Conv'
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: disabledBot.id,
          conversationId: conv.id,
          taskPrompt: 'Test'
        })
      ).rejects.toThrow(/NO_ENABLED_TOOLS/)
    })

    it('3. rejects dispatch when model does not support native tool calling', async () => {
      // Create bot with text-only model
      const textOnlyBot = botRepo.create({
        knowledgeBaseId: kb1Id,
        name: 'Text Only Bot',
        systemPrompt: 'Test',
        providerConnectionId: connId,
        modelId: 'gpt-6.1-terra', // tools: false model in provider-catalog
        toolPermissions: ['search_knowledge_base']
      })
      const conv = convRepo.create({
        botId: textOnlyBot.id,
        knowledgeBaseId: kb1Id,
        title: 'Conv'
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: textOnlyBot.id,
          conversationId: conv.id,
          taskPrompt: 'Test'
        })
      ).rejects.toThrow(/MODEL_NOT_SUPPORTED/)
    })

    it('4. prevents concurrent task dispatch on the same conversation', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // First task dispatch acquires lock
      await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Task 1'
      })

      // Immediate second dispatch on same conversation should reject
      await expect(
        handler!(event, {
          botId: bot1Id,
          conversationId: conv1Id,
          taskPrompt: 'Task 2'
        })
      ).rejects.toThrow(/CONCURRENT_TASK_ACTIVE/)
    })
  })

  // ==========================================================================
  // Suite 4: Workspace Folder Authorization Workflow
  // ==========================================================================

  describe('Suite 4: Workspace Folder Authorization Workflow', () => {
    it('1. prompts native folder dialog when workspaceAccessRequested is true', async () => {
      const showOpenDialogMock = vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [dbContext.tempDir]
      })
      folderService = new WorkspaceFolderService({
        dialogOps: { showOpenDialog: showOpenDialogMock }
      })

      registerAgentIpcHandlers({
        getMainWindow: () => mockWindow1,
        agentTaskService: taskService,
        agentStreamManager: streamManager,
        agentRunRepository: runRepo,
        toolEventRepository: toolEventRepo,
        botRepository: botRepo,
        conversationRepository: convRepo,
        approvalController,
        workspaceFolderService: folderService,
        activeContext,
        knowledgeBaseRepository: kbRepo,
        providerConnectionRepository: connRepo
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Inspect workspace files',
        workspaceAccessRequested: true
      })) as DispatchAgentTaskResponse

      expect(res.accepted).toBe(true)
      expect(showOpenDialogMock).toHaveBeenCalledOnce()
    })

    it('2. returns cancelled outcome without starting run when folder dialog is cancelled', async () => {
      const showOpenDialogMock = vi.fn().mockResolvedValue({
        canceled: true,
        filePaths: []
      })
      folderService = new WorkspaceFolderService({
        dialogOps: { showOpenDialog: showOpenDialogMock }
      })

      registerAgentIpcHandlers({
        getMainWindow: () => mockWindow1,
        agentTaskService: taskService,
        agentStreamManager: streamManager,
        agentRunRepository: runRepo,
        toolEventRepository: toolEventRepo,
        botRepository: botRepo,
        conversationRepository: convRepo,
        approvalController,
        workspaceFolderService: folderService,
        activeContext,
        knowledgeBaseRepository: kbRepo,
        providerConnectionRepository: connRepo
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Inspect workspace files',
        workspaceAccessRequested: true
      })) as DispatchAgentTaskResponse

      expect(res.accepted).toBe(false)
      expect(res.status).toBe('cancelled')
      expect(res.reason).toContain('cancelled by user')
    })

    it('3. rejects workspaceAccessRequested if bot has no workspace tools enabled', async () => {
      // bot2 only has search_knowledge_base
      activeContext.activateWorkspace(1, kb2Id)

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: bot2Id,
          conversationId: conv2Id,
          taskPrompt: 'Inspect workspace',
          workspaceAccessRequested: true
        })
      ).rejects.toThrow(/NO_WORKSPACE_TOOLS_ENABLED/)
    })

    it('4. does not prompt folder dialog when workspaceAccessRequested is false', async () => {
      const showOpenDialogMock = vi.fn()
      folderService = new WorkspaceFolderService({
        dialogOps: { showOpenDialog: showOpenDialogMock }
      })

      registerAgentIpcHandlers({
        getMainWindow: () => mockWindow1,
        agentTaskService: taskService,
        agentStreamManager: streamManager,
        agentRunRepository: runRepo,
        toolEventRepository: toolEventRepo,
        botRepository: botRepo,
        conversationRepository: convRepo,
        approvalController,
        workspaceFolderService: folderService,
        activeContext,
        knowledgeBaseRepository: kbRepo,
        providerConnectionRepository: connRepo
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'General task',
        workspaceAccessRequested: false
      })) as DispatchAgentTaskResponse

      expect(res.accepted).toBe(true)
      expect(showOpenDialogMock).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Suite 5: Run Retrieval & Tool Event Queries
  // ==========================================================================

  describe('Suite 5: Run Retrieval & Tool Event Queries', () => {
    it('1. retrieves authorized agent run record', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        conversationId: conv1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run.id)

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_RUN)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, { agentRunId: run.id })) as GetAgentRunResponse
      expect(res.run.id).toBe(run.id)
      expect(res.run.status).toBe('completed')
    })

    it('2. returns paginated tool events for authorized run', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })

      const evt1 = toolEventRepo.create({
        agentRunId: run.id,
        toolName: 'search_knowledge_base',
        initialStatus: 'running'
      })
      toolEventRepo.markCompleted(evt1.id, 'Result 1')

      const evt2 = toolEventRepo.create({
        agentRunId: run.id,
        toolName: 'read_workspace_file',
        initialStatus: 'running'
      })
      toolEventRepo.markCompleted(evt2.id, 'Result 2')

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        agentRunId: run.id,
        limit: 1,
        offset: 0
      })) as ListToolEventsResponse

      expect(res.events).toHaveLength(1)
      expect(res.total).toBe(2)
      expect(res.hasMore).toBe(true)
      expect(res.limit).toBe(1)
    })

    it('3. cancels active task safely and idempotently', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.CANCEL_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, { agentRunId: run.id })) as CancelAgentTaskResponse
      expect(res.success).toBe(true)
      expect(res.agentRunId).toBe(run.id)

      // Repeated cancellation should succeed safely
      const repeatRes = (await handler!(event, {
        agentRunId: run.id
      })) as CancelAgentTaskResponse
      expect(repeatRes.success).toBe(true)
    })

    it('4. lists agent runs for conversation with bounded pagination', async () => {
      const run1 = runRepo.create({
        botId: bot1Id,
        conversationId: conv1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run1.id)

      const run2 = runRepo.create({
        botId: bot1Id,
        conversationId: conv1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.markCompleted(run2.id)

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.LIST_RUNS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        conversationId: conv1Id,
        limit: 1,
        offset: 0
      })) as ListAgentRunsResponse

      expect(res.runs).toHaveLength(1)
      expect(res.total).toBe(2)
      expect(res.hasMore).toBe(true)
      expect(res.limit).toBe(1)
    })

    it('5. rejects listing runs for conversation in foreign Knowledge Base', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.LIST_RUNS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // conv2Id belongs to kb2Id, active workspace is kb1Id
      await expect(
        handler!(event, {
          conversationId: conv2Id
        })
      ).rejects.toThrow(/CONVERSATION_NOT_FOUND/)
    })

    it('6. rejects listing runs when botId does not match conversation bot', async () => {
      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.LIST_RUNS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          conversationId: conv1Id,
          botId: bot2Id
        })
      ).rejects.toThrow(/CONVERSATION_MISMATCH/)
    })
  })

  // ==========================================================================
  // Suite 6: Human Approval Workflow
  // ==========================================================================

  describe('Suite 6: Human Approval Workflow', () => {
    it('1. retrieves exact in-memory markdown content for authorized pending approval request', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.updateStatus(run.id, 'waiting_approval')

      const markdownReport = '# Annual Financial Analysis\n\nFull confidential report content.'
      const approvalPromise = approvalController.requestApproval({
        agentRunId: run.id,
        botId: bot1Id,
        title: 'Annual Financial Analysis',
        markdownContent: markdownReport
      })

      const pendingList = approvalController.listRequests(run.id)
      expect(pendingList).toHaveLength(1)
      const approvalReqId = pendingList[0].requestId

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const details = (await handler!(event, {
        agentRunId: run.id,
        approvalRequestId: approvalReqId
      })) as ApprovalDetailsDto

      expect(details.title).toBe('Annual Financial Analysis')
      expect(details.markdownContent).toBe(markdownReport)
      expect(details.contentSizeBytes).toBe(Buffer.byteLength(markdownReport, 'utf-8'))
      expect(details.status).toBe('pending')

      approvalController.cancel(approvalReqId)
      await approvalPromise
    })

    it('2. approves pending request and marks decision status', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.updateStatus(run.id, 'waiting_approval')

      const approvalPromise = approvalController.requestApproval({
        agentRunId: run.id,
        botId: bot1Id,
        title: 'Report',
        markdownContent: '# Report'
      })

      const approvalReqId = approvalController.listRequests(run.id)[0].requestId

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        agentRunId: run.id,
        approvalRequestId: approvalReqId,
        decision: 'approve'
      })) as RespondToApprovalResponse

      expect(res.success).toBe(true)
      expect(res.status).toBe('approved')

      const decision = await approvalPromise
      expect(decision.status).toBe('approved')
    })

    it('3. rejects pending request with user-facing reason', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.updateStatus(run.id, 'waiting_approval')

      const approvalPromise = approvalController.requestApproval({
        agentRunId: run.id,
        botId: bot1Id,
        title: 'Report',
        markdownContent: '# Report'
      })

      const approvalReqId = approvalController.listRequests(run.id)[0].requestId

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const res = (await handler!(event, {
        agentRunId: run.id,
        approvalRequestId: approvalReqId,
        decision: 'reject',
        reason: 'Report is incomplete.'
      })) as RespondToApprovalResponse

      expect(res.success).toBe(true)
      expect(res.status).toBe('rejected')

      const decision = await approvalPromise
      expect(decision.status).toBe('rejected')
      expect(decision.reason).toBe('Report is incomplete.')
    })

    it('4. rejects repeated approval decision on already resolved request', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.updateStatus(run.id, 'waiting_approval')

      approvalController.requestApproval({
        agentRunId: run.id,
        botId: bot1Id,
        title: 'Report',
        markdownContent: '# Report'
      })
      const approvalReqId = approvalController.listRequests(run.id)[0].requestId

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // First decision
      await handler!(event, {
        agentRunId: run.id,
        approvalRequestId: approvalReqId,
        decision: 'approve'
      })

      // Replay decision should reject
      await expect(
        handler!(event, {
          agentRunId: run.id,
          approvalRequestId: approvalReqId,
          decision: 'approve'
        })
      ).rejects.toThrow(/APPROVAL_ALREADY_RESOLVED/)
    })

    it('5. approval details become unavailable after resolution', async () => {
      const run = runRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-6-luna',
        initialStatus: 'running'
      })
      runRepo.updateStatus(run.id, 'waiting_approval')

      approvalController.requestApproval({
        agentRunId: run.id,
        botId: bot1Id,
        title: 'Report',
        markdownContent: '# Report'
      })
      const approvalReqId = approvalController.listRequests(run.id)[0].requestId

      approvalController.approve(approvalReqId, { agentRunId: run.id, botId: bot1Id })

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          agentRunId: run.id,
          approvalRequestId: approvalReqId
        })
      ).rejects.toThrow(/APPROVAL_NOT_FOUND/)
    })
  })

  // ==========================================================================
  // Suite 7: Real-Time MessageChannel Streaming
  // ==========================================================================

  describe('Suite 7: Real-Time MessageChannel Streaming', () => {
    it('1. transfers port2 to senderFrame on stream start', () => {
      const senderFrame = mockWebContents1.mainFrame
      const stream = streamManager.startStream(mockWindow1, senderFrame, randomUUID(), conv1Id)

      expect(senderFrame.postMessage).toHaveBeenCalledWith(
        AGENT_IPC_CHANNELS.STREAM_PORT,
        expect.objectContaining({ agentRunId: expect.any(String) }),
        expect.any(Array)
      )
      stream.close()
    })

    it('2. emits events with monotonically increasing sequence numbers', () => {
      const runId = randomUUID()
      const { port1, port2 } = createMockMessageChannel()
      const customManager = new AgentStreamManager({
        channelFactory: () => ({ port1, port2 })
      })

      const receivedEvents: AgentStreamEvent[] = []
      port2.on('message', (e) => {
        receivedEvents.push(e.data as AgentStreamEvent)
      })
      port2.start()

      const stream = customManager.startStream(
        mockWindow1,
        mockWebContents1.mainFrame,
        runId,
        conv1Id
      )

      stream.emitEvent({
        type: 'agent_run_started',
        botId: bot1Id,
        selectedModel: 'gpt-6-luna'
      })
      stream.emitEvent({
        type: 'agent_iteration_started',
        iteration: 1,
        maxIterations: 5
      })

      expect(receivedEvents).toHaveLength(2)
      expect(receivedEvents[0].sequenceNumber).toBe(1)
      expect(receivedEvents[1].sequenceNumber).toBe(2)
      expect(receivedEvents[0].type).toBe('agent_run_started')
      expect(receivedEvents[1].type).toBe('agent_iteration_started')

      stream.close()
    })

    it('3. closes port after terminal event is emitted', async () => {
      const runId = randomUUID()
      const { port1, port2 } = createMockMessageChannel()
      const customManager = new AgentStreamManager({
        channelFactory: () => ({ port1, port2 })
      })

      const stream = customManager.startStream(
        mockWindow1,
        mockWebContents1.mainFrame,
        runId,
        conv1Id
      )

      stream.emitEvent({
        type: 'agent_run_completed',
        finalResponse: 'Finished',
        iterations: 1,
        toolEventsCount: 0,
        citationsCount: 0,
        workspaceFilesCount: 0
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(customManager.hasStream(runId)).toBe(false)
    })

    it('4. cleans up all window streams when window closes', () => {
      const runId1 = randomUUID()
      const runId2 = randomUUID()

      streamManager.startStream(mockWindow1, mockWebContents1.mainFrame, runId1, conv1Id)
      streamManager.startStream(mockWindow1, mockWebContents1.mainFrame, runId2, conv1Id)

      expect(streamManager.getActiveStreamCount(mockWindow1)).toBe(2)

      streamManager.closeWindowStreams(mockWindow1)
      expect(streamManager.getActiveStreamCount(mockWindow1)).toBe(0)
    })
  })

  // ==========================================================================
  // Suite 8: Preload API & Bridge Error Normalization
  // ==========================================================================

  describe('Suite 8: Preload API & Bridge Error Normalization', () => {
    it('1. dispatches tasks and parses responses via createAgentsApi', async () => {
      const { ipcRenderer } = await import('electron')
      const agentsApi = createAgentsApi(ipcRenderer)

      const res = await agentsApi.dispatchTask({
        botId: bot1Id,
        conversationId: conv1Id,
        taskPrompt: 'Preload dispatch test'
      })

      expect(res.accepted).toBe(true)
      expect(res.status).toBe('running')
      expect(typeof res.agentRunId).toBe('string')
    })

    it('2. registers and unregisters stream event listeners via subscribeToTaskEvents', async () => {
      const electron = await import('electron')
      const agentsApi = createAgentsApi(electron.ipcRenderer)

      const received: AgentStreamEvent[] = []
      const unsubscribe = agentsApi.subscribeToTaskEvents('run-123', (evt) => {
        received.push(evt)
      })

      // Simulate stream port transfer to renderer
      const mockPort = new MockMessagePortMain()
      const listeners = mockRendererListeners.get(AGENT_IPC_CHANNELS.STREAM_PORT) ?? []
      for (const l of listeners) {
        l({ ports: [mockPort] }, { agentRunId: 'run-123' })
      }

      // Simulate event arriving on port
      const evt: AgentStreamEvent = {
        type: 'agent_run_started',
        agentRunId: 'run-123',
        conversationId: 'conv-123',
        executionMode: 'agent',
        stage: 'preparing',
        sequenceNumber: 1,
        timestamp: Date.now(),
        botId: bot1Id,
        selectedModel: 'gpt-6-luna'
      }

      if (mockPort.onmessage) {
        mockPort.onmessage({ data: evt } as MessageEvent)
      }

      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('agent_run_started')

      // Unsubscribe
      unsubscribe()

      if (mockPort.onmessage) {
        mockPort.onmessage({
          data: { ...evt, sequenceNumber: 2 }
        } as MessageEvent)
      }

      // Should not receive second event after unsubscribe
      expect(received).toHaveLength(1)
    })

    it('3. normalizes IPC errors into structured AgentBridgeError', () => {
      const rawError = new Error(
        JSON.stringify({
          code: 'BOT_NOT_FOUND',
          message: 'Requested bot does not exist.',
          retryable: false
        })
      )

      const normalized = normalizeAgentBridgeError(rawError)
      expect(normalized).toBeInstanceOf(AgentBridgeError)
      expect(normalized.code).toBe('BOT_NOT_FOUND')
      expect(normalized.message).toBe('Requested bot does not exist.')
      expect(normalized.retryable).toBe(false)
    })

    it('4. registers failing handlers when agent subsystem fails to initialize', async () => {
      registerFailingAgentIpcHandlers(() => mockWindow1, 'Agent engine failed')

      const handler = mockIpcHandlers.get(AGENT_IPC_CHANNELS.DISPATCH_TASK)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(handler!(event, {})).rejects.toThrow(/AGENT_SUBSYSTEM_DISABLED/)
    })
  })
})
