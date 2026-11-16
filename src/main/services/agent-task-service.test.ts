import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  AgentTaskService,
  AgentTaskError,
  formatConversationHistory,
  trimHistoryToBudget
} from './agent-task-service'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import type { CredentialVault } from '../security/credential-vault'
import type { CredentialRef } from '../database/repositories/types'
import { BoundedAgentRuntime } from './bounded-agent-runtime'
import { ToolRegistry } from '../tools/tool-registry'
import { ApprovalController } from './approval-controller'
import { WorkspaceFolderService } from './workspace-folder-service'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { ConversationTurnService } from './conversation-turn-service'
import type {
  AgentModelStepExecutor,
  AgentModelStepRequest,
  AgentModelStepResult,
  AgentMessage
} from '../agents/agent-model-step-executor'
import type { AgentTool, ToolExecutionOutput } from '../tools/agent-tool'
import type { CitationDto, MessageDto } from '../../shared/conversations'
import { CURRENT_APPLICATION_CAPABILITIES } from '../../shared/providers'
import { KNOWLEDGE_BASE_ONLY_RESPONSES } from './knowledge-base-only-policy'
import type { ConversationExecutionService } from './conversation-execution-service'

// ============================================================================
// Test Mock Implementations
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
  private readonly decisionQueue: AgentModelStepResult[] = []
  private customHandler?: (request: AgentModelStepRequest) => Promise<AgentModelStepResult>

  public enqueueDecision(decision: AgentModelStepResult): void {
    this.decisionQueue.push(decision)
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
    const next = this.decisionQueue.shift()
    if (!next) {
      throw new Error('DeterministicMockStepExecutor decision queue is empty.')
    }
    return next
  }
}

const sampleCitation: CitationDto = {
  citationNumber: 1,
  sourceId: randomUUID(),
  chunkId: randomUUID(),
  fileName: 'Project-Spec.pdf',
  fileType: 'pdf',
  pageNumber: 2,
  headingPath: ['Architecture', 'Main Process'],
  chunkIndex: 0
}

function createMockSearchKbTool(): AgentTool {
  return {
    name: 'search_knowledge_base',
    description: 'Searches the Knowledge Base index.',
    schema: z.object({ query: z.string() }).strict(),
    requiredPermission: 'search_knowledge_base',
    execute: (args: unknown): ToolExecutionOutput => {
      const q = (args as { query: string }).query
      return {
        result: {
          status: 'SUCCESS',
          query: q,
          citations: [sampleCitation]
        },
        resultSummary: JSON.stringify({ query: q, count: 1 })
      }
    }
  }
}

function createMockReadFileTool(): AgentTool {
  return {
    name: 'read_workspace_file',
    description: 'Reads a file from the authorized workspace.',
    schema: z.object({ filePath: z.string() }).strict(),
    requiredPermission: 'read_workspace_file',
    execute: (args: unknown): ToolExecutionOutput => {
      const f = (args as { filePath: string }).filePath
      return {
        result: {
          relativePath: f,
          content: 'Workspace configuration data'
        },
        resultSummary: JSON.stringify({ file: f, bytes: 28 })
      }
    }
  }
}

// ============================================================================
// Main Test Suite
// ============================================================================

describe('AgentTaskService (Phase 8 Step 8.8)', () => {
  let ctx: MigratedTestDatabaseContext
  let botRepo: BotRepository
  let kbRepo: KnowledgeBaseRepository
  let convRepo: ConversationRepository
  let messageRepo: MessageRepository
  let connRepo: ProviderConnectionRepository
  let runRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let vault: MockCredentialVault
  let toolRegistry: ToolRegistry
  let approvalController: ApprovalController
  let folderService: WorkspaceFolderService
  let stepExecutor: DeterministicMockStepExecutor
  let runtime: BoundedAgentRuntime
  let activeWsContext: ActiveWorkspaceContext
  let turnService: ConversationTurnService
  let agentTaskService: AgentTaskService

  let defaultKbId: string
  let defaultBotId: string
  let defaultConvId: string
  let defaultConnId: string
  const defaultSessionId = 'session_test_1'

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    botRepo = ctx.botRepo
    kbRepo = ctx.kbRepo
    convRepo = new ConversationRepository(ctx.db)
    messageRepo = new MessageRepository(ctx.db)
    connRepo = new ProviderConnectionRepository(ctx.db)
    runRepo = new AgentRunRepository(ctx.db)
    toolEventRepo = new ToolEventRepository(ctx.db)
    vault = new MockCredentialVault()
    toolRegistry = new ToolRegistry({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo
    })
    approvalController = new ApprovalController()
    folderService = new WorkspaceFolderService()
    stepExecutor = new DeterministicMockStepExecutor()
    activeWsContext = new ActiveWorkspaceContext({ kbRepo })

    toolRegistry.register(createMockSearchKbTool())
    toolRegistry.register(createMockReadFileTool())

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

    const mockExecutionService = {
      streamPreparedTurn: vi.fn(),
      executePreparedTurn: vi.fn()
    }

    turnService = new ConversationTurnService({
      db: ctx.db,
      conversationRepo: convRepo,
      messageRepo,
      activeWorkspaceContext: activeWsContext,
      executionService: mockExecutionService as unknown as ConversationExecutionService
    })

    agentTaskService = new AgentTaskService({
      botRepository: botRepo,
      conversationRepository: convRepo,
      messageRepository: messageRepo,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connRepo,
      credentialVault: vault as unknown as CredentialVault,
      boundedAgentRuntime: runtime,
      toolRegistry,
      approvalController,
      workspaceFolderService: folderService,
      activeWorkspaceContext: activeWsContext,
      turnService
    })

    // Setup initial authorized hierarchy
    const kb = kbRepo.create({ name: 'Alpha Knowledge Base', description: 'Test KB' })
    defaultKbId = kb.id
    activeWsContext.activateWorkspace(defaultSessionId, defaultKbId)

    const credRef = `cred_${randomUUID()}` as CredentialRef
    vault.set(credRef, 'sk-openai-secret-key-12345')

    const conn = connRepo.create({
      providerId: 'openai',
      label: 'OpenAI Test Connection',
      credentialRef: credRef
    })
    defaultConnId = conn.id

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Researcher Bot',
      description: 'Test Bot',
      systemPrompt: 'You are an analytical researcher.',
      modelId: 'gpt-6-luna', // tools: true
      providerConnectionId: defaultConnId,
      toolPermissions: ['search_knowledge_base', 'read_workspace_file']
    })
    defaultBotId = bot.id

    const conv = convRepo.create({
      botId: defaultBotId,
      knowledgeBaseId: defaultKbId,
      title: 'Investigation Thread'
    })
    defaultConvId = conv.id
  })

  afterEach(() => {
    ctx.cleanup()
  })

  // ==========================================================================
  // Suite 1: Authorization & Input Validation
  // ==========================================================================

  describe('Authorization & Input Validation', () => {
    it('rejects invalid UUID formats or blank task content', async () => {
      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: 'invalid-uuid',
          conversationId: defaultConvId,
          taskContent: 'Do task'
        })
      ).rejects.toThrow(AgentTaskError)

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: 'invalid-conv',
          taskContent: 'Do task'
        })
      ).rejects.toThrow(AgentTaskError)

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: '   '
        })
      ).rejects.toThrow(AgentTaskError)
    })

    it('rejects when renderer session has no active workspace', async () => {
      await expect(
        agentTaskService.dispatchTask('unregistered_session', {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Investigate system'
        })
      ).rejects.toMatchObject({
        code: 'NO_ACTIVE_WORKSPACE'
      })
    })

    it('rejects when active workspace is archived', async () => {
      kbRepo.archive(defaultKbId)

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Investigate system'
        })
      ).rejects.toMatchObject({
        code: 'NO_ACTIVE_WORKSPACE'
      })
    })

    it('rejects when Bot belongs to a different Knowledge Base', async () => {
      const otherKb = kbRepo.create({ name: 'Beta KB' })
      const foreignBot = botRepo.create({
        knowledgeBaseId: otherKb.id,
        name: 'Foreign Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: defaultConnId,
        toolPermissions: ['search_knowledge_base']
      })
      const foreignConv = convRepo.create({
        botId: foreignBot.id,
        knowledgeBaseId: otherKb.id,
        title: 'Foreign Conv'
      })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: foreignBot.id,
          conversationId: foreignConv.id,
          taskContent: 'Cross KB task'
        })
      ).rejects.toMatchObject({
        code: 'BOT_KB_MISMATCH'
      })
    })

    it('rejects non-existent or archived Bot', async () => {
      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: randomUUID(),
          conversationId: defaultConvId,
          taskContent: 'Analyze'
        })
      ).rejects.toMatchObject({
        code: 'BOT_NOT_FOUND'
      })

      botRepo.update(defaultBotId, defaultKbId, { status: 'archived' })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Analyze'
        })
      ).rejects.toMatchObject({
        code: 'BOT_ARCHIVED'
      })
    })

    it('rejects non-existent or archived conversation', async () => {
      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: randomUUID(),
          taskContent: 'Task'
        })
      ).rejects.toMatchObject({
        code: 'CONVERSATION_NOT_FOUND'
      })

      ctx.db
        .prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
        .run(Date.now(), defaultConvId)

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Task'
        })
      ).rejects.toMatchObject({
        code: 'CONVERSATION_ARCHIVED'
      })
    })

    it('rejects conversation belonging to another Bot', async () => {
      const siblingBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Sibling Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: defaultConnId,
        toolPermissions: ['search_knowledge_base']
      })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: siblingBot.id,
          conversationId: defaultConvId,
          taskContent: 'Infiltrate conversation'
        })
      ).rejects.toMatchObject({
        code: 'CONVERSATION_MISMATCH'
      })
    })

    it('rejects when Bot has no provider connection or credentials are missing', async () => {
      const noConnBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'No Conn Bot',
        modelId: 'gpt-6-luna',
        toolPermissions: ['search_knowledge_base']
      })
      const noConnConv = convRepo.create({
        botId: noConnBot.id,
        knowledgeBaseId: defaultKbId,
        title: 'T1'
      })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: noConnBot.id,
          conversationId: noConnConv.id,
          taskContent: 'Run'
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_CONNECTION_NOT_FOUND'
      })
    })

    it('rejects models that lack native tool calling capabilities', async () => {
      const unsupportedBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Preview Model Bot',
        modelId: 'gpt-6.1-terra', // tools: false
        providerConnectionId: defaultConnId,
        toolPermissions: ['search_knowledge_base']
      })
      const unsupportedConv = convRepo.create({
        botId: unsupportedBot.id,
        knowledgeBaseId: defaultKbId,
        title: 'T2'
      })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: unsupportedBot.id,
          conversationId: unsupportedConv.id,
          taskContent: 'Analyze'
        })
      ).rejects.toMatchObject({
        code: 'MODEL_NOT_SUPPORTED'
      })
    })

    it('rejects when Bot has zero enabled Phase 8 tools', async () => {
      const toollessBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Toolless Bot',
        modelId: 'gpt-6-luna',
        providerConnectionId: defaultConnId,
        toolPermissions: [] // 0 tools enabled
      })
      const toollessConv = convRepo.create({
        botId: toollessBot.id,
        knowledgeBaseId: defaultKbId,
        title: 'T3'
      })

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: toollessBot.id,
          conversationId: toollessConv.id,
          taskContent: 'Run without tools'
        })
      ).rejects.toMatchObject({
        code: 'NO_ENABLED_TOOLS'
      })
    })
  })

  // ==========================================================================
  // Suite 2: Normal Chat Separation & Capabilities
  // ==========================================================================

  describe('Normal Chat Separation & Capabilities', () => {
    it('preserves CURRENT_APPLICATION_CAPABILITIES.tools as false', () => {
      expect(CURRENT_APPLICATION_CAPABILITIES.tools).toBe(false)
    })

    it('executes agent task through BoundedAgentRuntime while normal chat does not invoke it', async () => {
      const runtimeSpy = vi.spyOn(runtime, 'run')

      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Analysis completed.'
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Execute explicit task'
      })

      expect(runtimeSpy).toHaveBeenCalledTimes(1)
      expect(outcome.success).toBe(true)
      expect(outcome.runStatus).toBe('completed')
    })
  })

  // ==========================================================================
  // Suite 3: History & Context Budgeting
  // ==========================================================================

  describe('History & Context Budgeting', () => {
    it('correctly loads and formats conversation history into AgentMessage[] structure', () => {
      const historyMessages: MessageDto[] = [
        {
          id: randomUUID(),
          conversationId: defaultConvId,
          role: 'user',
          content: 'First question',
          contentFormat: 'markdown',
          metadata: {},
          createdAt: 1000
        },
        {
          id: randomUUID(),
          conversationId: defaultConvId,
          role: 'assistant',
          content: 'First answer',
          contentFormat: 'markdown',
          metadata: {},
          createdAt: 2000
        },
        {
          id: randomUUID(),
          conversationId: defaultConvId,
          role: 'assistant',
          content: 'Let me search.',
          contentFormat: 'markdown',
          metadata: {
            toolCalls: [
              {
                id: 'call_1',
                toolName: 'search_knowledge_base',
                status: 'completed',
                argumentsSummary: JSON.stringify({ query: 'quantum' }),
                resultSummary: JSON.stringify({ count: 1 })
              }
            ]
          },
          createdAt: 3000
        }
      ]

      const agentHistory = formatConversationHistory(historyMessages)
      expect(agentHistory).toHaveLength(4)
      expect(agentHistory[0]).toEqual({ role: 'user', content: 'First question' })
      expect(agentHistory[1]).toEqual({ role: 'assistant', content: 'First answer' })
      expect(agentHistory[2].role).toBe('assistant')
      const assistantWithTool = agentHistory[2] as {
        role: 'assistant'
        toolCall?: { toolName: string }
      }
      expect(assistantWithTool.toolCall?.toolName).toBe('search_knowledge_base')
      expect(agentHistory[3]).toEqual({
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'search_knowledge_base',
        content: JSON.stringify({ count: 1 }),
        isError: false
      })
    })

    it('trims oldest historical messages when token budget is exceeded', () => {
      const longMessage = 'A'.repeat(400)
      const msgs: AgentMessage[] = [
        { role: 'user', content: longMessage },
        { role: 'assistant', content: longMessage },
        { role: 'user', content: 'Short query' }
      ]

      const trimmed = trimHistoryToBudget(msgs, 50)
      expect(trimmed).toHaveLength(1)
      expect(trimmed[0].content).toBe('Short query')
    })
  })

  // ==========================================================================
  // Suite 4: Persistence & Lifecycle Coordination
  // ==========================================================================

  describe('Persistence & Lifecycle Coordination', () => {
    it('persists user task before runtime execution and assistant response after success', async () => {
      // Step 1: Tool call decision
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call_search_1',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'specifications' }
      })

      // Step 2: Final grounded response
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Based on the system specifications [1], the main process handles IPC.'
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Find specifications for the main process'
      })

      expect(outcome.success).toBe(true)
      expect(outcome.runStatus).toBe('completed')
      expect(outcome.userMessage).toBeDefined()
      expect(outcome.assistantMessage).toBeDefined()
      expect(outcome.assistantMessage?.metadata?.agentRunId).toBe(outcome.agentRunId)
      expect(outcome.assistantMessage?.metadata?.citations).toHaveLength(1)
      expect(outcome.assistantMessage?.metadata?.toolCalls).toHaveLength(1)

      // Verify in SQLite database directly
      const storedMessages = messageRepo.listByConversation(
        defaultConvId,
        defaultBotId,
        defaultKbId
      )
      expect(storedMessages).toHaveLength(2)
      expect(storedMessages[0].role).toBe('user')
      expect(storedMessages[0].content).toBe('Find specifications for the main process')
      expect(storedMessages[1].role).toBe('assistant')
      expect(storedMessages[1].metadata.agentRunId).toBe(outcome.agentRunId)
    })

    it('does not persist assistant response on failed run, but user task remains stored', async () => {
      stepExecutor.setHandler(async () => {
        throw new Error('Provider network crash mid-flight')
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Attempt doomed task'
      })

      expect(outcome.success).toBe(false)
      expect(outcome.runStatus).toBe('failed')
      expect(outcome.userMessage).toBeDefined()
      expect(outcome.assistantMessage).toBeUndefined()

      // SQLite check: only user message persisted
      const stored = messageRepo.listByConversation(defaultConvId, defaultBotId, defaultKbId)
      expect(stored).toHaveLength(1)
      expect(stored[0].role).toBe('user')
    })

    it('does not persist assistant response on cancelled run, but user task remains stored', async () => {
      stepExecutor.setHandler(async (req) => {
        // Cancel run during step
        agentTaskService.cancelTask(req.agentRunId, 'User clicked stop')
        return { type: 'final', content: 'Should not persist' }
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Task to be cancelled'
      })

      expect(outcome.success).toBe(false)
      expect(outcome.runStatus).toBe('cancelled')
      expect(outcome.userMessage).toBeDefined()
      expect(outcome.assistantMessage).toBeUndefined()

      const stored = messageRepo.listByConversation(defaultConvId, defaultBotId, defaultKbId)
      expect(stored).toHaveLength(1)
      expect(stored[0].role).toBe('user')
    })
  })

  // ==========================================================================
  // Suite 5: Evidence Provenance & Answering Policy
  // ==========================================================================

  describe('Evidence Provenance & Answering Policy', () => {
    it('returns deterministic refusal when task produces zero evidence from both KB and workspace', async () => {
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Invented answer based on internal AI knowledge without using tools.'
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Tell me general world facts'
      })

      expect(outcome.success).toBe(true)
      expect(outcome.finalResponse).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE)
      expect(outcome.evidence.hasEvidence).toBe(false)
      expect(outcome.evidence.kbEvidence).toHaveLength(0)
      expect(outcome.evidence.workspaceEvidence).toHaveLength(0)
    })

    it('rejects model responses that invent fake citations for workspace evidence', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call_read_file_1',
        toolName: 'read_workspace_file',
        rawArguments: { filePath: 'config.json' }
      })

      // Model attempts to invent [1] citation for a workspace file
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'According to the workspace configuration [1], the port is 8080.'
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Check workspace config file'
      })

      expect(outcome.success).toBe(true)
      // Must be replaced with ungrounded response refusal
      expect(outcome.finalResponse).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(outcome.evidence.workspaceEvidence).toHaveLength(1)
      expect(outcome.evidence.kbEvidence).toHaveLength(0)
    })

    it('accepts workspace-only summaries that do not invent fake citations', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call_read_file_2',
        toolName: 'read_workspace_file',
        rawArguments: { filePath: 'package.json' }
      })

      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'The workspace file contains configuration data.'
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Check workspace package file'
      })

      expect(outcome.success).toBe(true)
      expect(outcome.finalResponse).toBe('The workspace file contains configuration data.')
      expect(outcome.evidence.workspaceEvidence).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Suite 6: Concurrency & Lock Coordination
  // ==========================================================================

  describe('Concurrency & Lock Coordination', () => {
    it('blocks an agent task when chat generation is already active on the conversation', async () => {
      // Simulate active chat generation
      turnService.acquireAgentTaskLock(defaultConvId)

      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Concurrent task'
        })
      ).rejects.toMatchObject({
        code: 'CONCURRENT_TASK_ACTIVE'
      })

      turnService.releaseAgentTaskLock(defaultConvId)
    })

    it('blocks a second agent task on the same conversation while the first is active', async () => {
      let releaseFirstStep!: () => void
      const stepBlocker = new Promise<void>((resolve) => {
        releaseFirstStep = resolve
      })

      stepExecutor.setHandler(async () => {
        await stepBlocker
        return { type: 'final', content: 'Done' }
      })

      const task1Promise = agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'First task'
      })

      // Allow event loop to spin and task 1 to acquire lock
      await new Promise((r) => setTimeout(r, 10))

      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(true)

      // Attempting task 2 on same conversation must immediately reject
      await expect(
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Second task on same thread'
        })
      ).rejects.toMatchObject({
        code: 'CONCURRENT_TASK_ACTIVE'
      })

      releaseFirstStep()
      await task1Promise
      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(false)
    })

    it('allows different conversations to run agent tasks concurrently', async () => {
      const conv2 = convRepo.create({
        botId: defaultBotId,
        knowledgeBaseId: defaultKbId,
        title: 'Thread 2'
      })

      stepExecutor.enqueueDecision({ type: 'final', content: 'Answer 1' })
      stepExecutor.enqueueDecision({ type: 'final', content: 'Answer 2' })

      const [res1, res2] = await Promise.all([
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: defaultConvId,
          taskContent: 'Task 1'
        }),
        agentTaskService.dispatchTask(defaultSessionId, {
          botId: defaultBotId,
          conversationId: conv2.id,
          taskContent: 'Task 2'
        })
      ])

      expect(res1.success).toBe(true)
      expect(res2.success).toBe(true)
      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(false)
      expect(agentTaskService.isTaskActive(conv2.id)).toBe(false)
    })
  })

  // ==========================================================================
  // Suite 7: Cancellation & Cleanup
  // ==========================================================================

  describe('Cancellation & Cleanup', () => {
    it('cancels active task by agentRunId and releases all locks', async () => {
      let stepReached = false
      stepExecutor.setHandler(async (req) => {
        stepReached = true
        agentTaskService.cancelTask(req.agentRunId, 'Cancelled by user')
        return { type: 'final', content: 'Ignored' }
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Cancel me'
      })

      expect(stepReached).toBe(true)
      expect(outcome.success).toBe(false)
      expect(outcome.runStatus).toBe('cancelled')
      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(false)
    })

    it('cancels active task by conversationId', async () => {
      stepExecutor.setHandler(async () => {
        agentTaskService.cancelTaskByConversation(defaultConvId, 'Cancel via conv')
        return { type: 'final', content: 'Ignored' }
      })

      const outcome = await agentTaskService.dispatchTask(defaultSessionId, {
        botId: defaultBotId,
        conversationId: defaultConvId,
        taskContent: 'Cancel by conv'
      })

      expect(outcome.success).toBe(false)
      expect(outcome.runStatus).toBe('cancelled')
      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(false)
    })

    it('cancels early when caller provides an already-aborted signal', async () => {
      const abortCtrl = new AbortController()
      abortCtrl.abort()

      await expect(
        agentTaskService.dispatchTask(
          defaultSessionId,
          {
            botId: defaultBotId,
            conversationId: defaultConvId,
            taskContent: 'Abort early'
          },
          { signal: abortCtrl.signal }
        )
      ).rejects.toMatchObject({
        code: 'TASK_CANCELLED'
      })

      expect(agentTaskService.isTaskActive(defaultConvId)).toBe(false)
    })
  })
})
