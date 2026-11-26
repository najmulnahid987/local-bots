import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
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
import { ConversationTurnService, type ConversationTurnEvent } from './conversation-turn-service'
import {
  ConversationExecutionService,
  type ConversationExecutionStream,
  type ConversationExecutionResult,
  type ConversationExecutionEvent
} from './conversation-execution-service'
import { ConversationService } from './conversation-service'
import { ConversationPersistenceService } from './conversation-persistence-service'
import { AgentTaskService } from './agent-task-service'
import type {
  AgentModelStepExecutor,
  AgentModelStepRequest,
  AgentModelStepResult
} from '../agents/agent-model-step-executor'
import type { AgentTool, ToolExecuteReturn } from '../tools/agent-tool'
import {
  sendMessageRequestSchema,
  sendMessageIpcRequestSchema,
  type SendMessageRequest,
  type CitationDto
} from '../../shared/conversations'
import { dispatchAgentTaskRequestSchema } from '../../shared/agents'

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

  public enqueueDecision(decision: AgentModelStepResult): void {
    this.decisionQueue.push(decision)
  }

  public async executeStep(request: AgentModelStepRequest): Promise<AgentModelStepResult> {
    this.requests.push(request)
    const next = this.decisionQueue.shift()
    if (!next) {
      return {
        type: 'final',
        content: 'Fallback completed response.'
      }
    }
    return next
  }
}

class TestCalculationTool implements AgentTool<{ a: number; b: number }, { sum: number }> {
  public readonly name = 'search_knowledge_base' as const
  public readonly requiredPermission = 'search_knowledge_base' as const
  public readonly description = 'Performs arithmetic calculation.'
  public readonly schema = z.object({
    a: z.number().int(),
    b: z.number().int()
  })

  public async execute(args: {
    a: number
    b: number
  }): Promise<ToolExecuteReturn<{ sum: number }>> {
    return {
      result: { sum: args.a + args.b },
      resultSummary: `Sum is ${args.a + args.b}`
    }
  }
}

class TestFailingTool implements AgentTool<{ reason: string }, never> {
  public readonly name = 'read_knowledge_source' as const
  public readonly requiredPermission = 'read_knowledge_source' as const
  public readonly description = 'Tool designed to fail deterministically.'
  public readonly schema = z.object({
    reason: z.string().min(1)
  })

  public async execute(args: { reason: string }): Promise<never> {
    throw new Error(`Deterministic tool failure: ${args.reason}`)
  }
}

class TestSaveReportTool implements AgentTool<
  { reportTitle: string; markdownContent: string },
  { saved: boolean }
> {
  public readonly name = 'save_report' as const
  public readonly requiredPermission = 'save_report' as const
  public readonly description = 'Saves a report to disk.'
  public readonly schema = z.object({
    reportTitle: z.string(),
    markdownContent: z.string()
  })

  public async execute(): Promise<ToolExecuteReturn<{ saved: boolean }>> {
    return {
      result: { saved: true },
      resultSummary: 'Report saved successfully'
    }
  }
}

function createMockExecutionStream(options?: {
  resultText?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  durationMs?: number
  events?: ConversationExecutionEvent[]
  botId?: string
  conversationId?: string
  citationMap?: ReadonlyMap<number, CitationDto>
}): ConversationExecutionStream {
  const resultText = options?.resultText ?? 'Helpful chat assistant answer.'
  const finishReason = options?.finishReason ?? 'stop'
  const durationMs = options?.durationMs ?? 150

  const events: ConversationExecutionEvent[] = options?.events ?? [
    { type: 'text_delta', textDelta: resultText },
    {
      type: 'finish',
      finishReason,
      totalTextLength: resultText.length,
      durationMs,
      usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 }
    }
  ]

  let resolveResult!: (res: ConversationExecutionResult) => void
  const resultPromise = new Promise<ConversationExecutionResult>((resolve) => {
    resolveResult = resolve
  })

  async function* generator(): AsyncGenerator<ConversationExecutionEvent> {
    for (const evt of events) {
      yield evt
    }
    resolveResult({
      assistantText: resultText,
      finishReason,
      durationMs,
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      botId: options?.botId ?? 'test-bot-id',
      conversationId: options?.conversationId ?? 'test-conv-id',
      citationCandidates: [],
      citationMap: options?.citationMap ? new Map(options.citationMap) : new Map(),
      usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 }
    })
  }

  return {
    [Symbol.asyncIterator]: generator,
    getResult: () => resultPromise
  }
}

// ============================================================================
// Step 12.6 Test Suite: Explicit Chat and Agent Mode Separation
// ============================================================================

describe('Phase 12 — Step 12.6: Explicit Chat and Agent Mode Separation', () => {
  let dbContext: MigratedTestDatabaseContext
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let runRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let connRepo: ProviderConnectionRepository
  let vault: MockCredentialVault
  let toolRegistry: ToolRegistry
  let stepExecutor: DeterministicMockStepExecutor
  let approvalController: ApprovalController
  let folderService: WorkspaceFolderService
  let activeContext: ActiveWorkspaceContext
  let runtime: BoundedAgentRuntime
  let agentTaskService: AgentTaskService
  let turnService: ConversationTurnService
  let conversationService: ConversationService
  let mockExecService: ConversationExecutionService

  let kbAId: string
  let botAId: string
  let botWithToolsId: string
  let canonicalConvA: { id: string }
  let canonicalConvWithTools: { id: string }
  let connectionId: string
  const sessionId = 'test-session-12-6'

  beforeEach(() => {
    dbContext = createMigratedTestDatabase()
    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    convRepo = new ConversationRepository(dbContext.db)
    msgRepo = new MessageRepository(dbContext.db)
    runRepo = new AgentRunRepository(dbContext.db)
    toolEventRepo = new ToolEventRepository(dbContext.db)
    connRepo = new ProviderConnectionRepository(dbContext.db)
    vault = new MockCredentialVault()
    activeContext = new ActiveWorkspaceContext(kbRepo)

    // Create Knowledge Base
    const kbA = kbRepo.create({
      name: 'KB Alpha',
      description: 'Primary workspace knowledge base'
    })
    kbAId = kbA.id
    activeContext.activateWorkspace(sessionId, kbAId)

    // Create Provider Connection
    const credRef = `cred_${randomUUID()}` as CredentialRef
    vault.set(credRef, 'sk-proj-mock-secret-key-123456789012345')
    const conn = connRepo.create({
      providerId: 'openai',
      label: 'OpenAI Test Connection',
      credentialRef: credRef
    })
    connectionId = conn.id

    // Create Bot A: No Tools Enabled
    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Conversational Chat Bot',
      description: 'Strictly conversational assistant with no enabled tools',
      systemPrompt: 'You are a conversational bot.',
      providerConnectionId: connectionId,
      modelId: 'gpt-6-luna',
      responsePolicy: 'balanced_kb_first',
      toolPermissions: []
    })
    botAId = botA.id
    canonicalConvA = convRepo.getOrCreate({ botId: botAId, knowledgeBaseId: kbAId })

    // Create Bot With Tools: Has Enabled Tools
    const botWithTools = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Analyst Agent Bot',
      description: 'Bot with enabled calculation and reading tools',
      systemPrompt: 'You are an analytical agent bot.',
      providerConnectionId: connectionId,
      modelId: 'gpt-6-luna',
      responsePolicy: 'balanced_kb_first',
      toolPermissions: ['search_knowledge_base', 'read_knowledge_source']
    })
    botWithToolsId = botWithTools.id
    canonicalConvWithTools = convRepo.getOrCreate({ botId: botWithToolsId, knowledgeBaseId: kbAId })

    // Initialize Tool Registry & Bounded Runtime
    toolRegistry = new ToolRegistry({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo
    })
    toolRegistry.register(new TestCalculationTool())
    toolRegistry.register(new TestFailingTool())
    toolRegistry.register(new TestSaveReportTool())

    stepExecutor = new DeterministicMockStepExecutor()
    approvalController = new ApprovalController()
    folderService = new WorkspaceFolderService()

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

    // Mock Execution Service for Chat turns
    mockExecService = {
      streamPreparedTurn: vi.fn().mockImplementation((preparedTurn) => {
        return createMockExecutionStream({
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          resultText: 'Authentic chat conversational response.'
        })
      })
    } as unknown as ConversationExecutionService

    const persistenceService = new ConversationPersistenceService({
      db: dbContext.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo
    })

    conversationService = new ConversationService({
      db: dbContext.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      activeWorkspaceContext: activeContext
    })

    turnService = new ConversationTurnService({
      db: dbContext.db,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      conversationService,
      executionService: mockExecService,
      persistenceService,
      activeWorkspaceContext: activeContext
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
      workspaceFolderService: folderService,
      activeWorkspaceContext: activeContext,
      turnService
    })
  })

  afterEach(() => {
    dbContext.cleanup()
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // Section 1: Chat No-Tool-Execution Tests (Scenarios 1 - 10)
  // ==========================================================================

  describe('Section 1: Chat No-Tool-Execution Tests', () => {
    it('1. Chat works normally with no enabled tools', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvA.id,
        content: 'Tell me about the workspace.'
      })

      const events: ConversationTurnEvent[] = []
      for await (const evt of stream) {
        events.push(evt)
      }

      const result = await stream.getResult()
      expect(result.userMessage.content).toBe('Tell me about the workspace.')
      expect(result.userMessage.metadata.executionMode).toBe('chat')
      expect(result.assistantMessage.content).toBe('Authentic chat conversational response.')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
      expect(result.assistantMessage.metadata.toolCalls).toBeUndefined()
    })

    it('2. Chat remains tool-free when the Bot has enabled tools', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'What is 5 + 7?'
      })

      for await (const evt of stream) {
        void evt
      }

      const result = await stream.getResult()
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
      expect(result.assistantMessage.metadata.toolCalls).toBeUndefined()

      // Verify zero tool executions and zero agent runs
      const runCount = dbContext.db.prepare('SELECT COUNT(*) as count FROM agent_runs').get() as {
        count: number
      }
      const toolEventCount = dbContext.db
        .prepare('SELECT COUNT(*) as count FROM tool_events')
        .get() as { count: number }
      expect(runCount.count).toBe(0)
      expect(toolEventCount.count).toBe(0)
    })

    it('3. A model-generated tool call in Chat does not execute', async () => {
      // Mock provider returning finishReason: 'tool_calls' with pseudo-tool JSON
      vi.mocked(mockExecService.streamPreparedTurn).mockImplementationOnce((preparedTurn) => {
        return createMockExecutionStream({
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          resultText: '{"tool": "search_knowledge_base", "args": {"a": 1, "b": 2}}',
          finishReason: 'tool_calls'
        })
      })

      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'Calculate something for me.'
      })

      for await (const evt of stream) {
        void evt
      }

      const result = await stream.getResult()
      expect(result.finishReason).toBe('tool_calls')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')

      // Main process strictly did NOT invoke ToolRegistry or dispatch Agent tasks
      const toolEvents = dbContext.db
        .prepare('SELECT COUNT(*) as count FROM tool_events')
        .get() as { count: number }
      expect(toolEvents.count).toBe(0)
    })

    it('4. Chat does not create an Agent run', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'Conversation query'
      })
      for await (const evt of stream) {
        void evt
      }
      await stream.getResult()

      const runs = runRepo.listByConversation(canonicalConvWithTools.id)
      expect(runs).toHaveLength(0)
    })

    it('5. Chat does not create Agent tool events', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'Another query'
      })
      for await (const evt of stream) {
        void evt
      }
      await stream.getResult()

      const events = dbContext.db
        .prepare(
          `
          SELECT te.* FROM tool_events te
          JOIN agent_runs ar ON te.agent_run_id = ar.id
          WHERE ar.bot_id = ?
        `
        )
        .all(botWithToolsId)
      expect(events).toHaveLength(0)
    })

    it('6. A forged Agent mode cannot be introduced through untrusted Chat request data', () => {
      // Direct Zod schema parse rejection
      const invalidPayload = {
        conversationId: canonicalConvA.id,
        content: 'Attempting to inject agent mode',
        executionMode: 'agent'
      }

      const schemaResult = sendMessageRequestSchema.safeParse(invalidPayload)
      expect(schemaResult.success).toBe(false)
      if (!schemaResult.success) {
        expect(schemaResult.error.issues[0].message).toContain(
          'Chat endpoint does not permit agent execution mode'
        )
      }

      // IPC Schema rejection
      const ipcResult = sendMessageIpcRequestSchema.safeParse({
        requestId: randomUUID(),
        ...invalidPayload
      })
      expect(ipcResult.success).toBe(false)

      // Service runtime rejection
      expect(() => {
        turnService.sendMessage(sessionId, invalidPayload as unknown as SendMessageRequest)
      }).toThrowError(/Invalid send message request/i)
    })

    it('7. Chat continues respecting Strict KB-only behavior', async () => {
      const strictBot = botRepo.create({
        knowledgeBaseId: kbAId,
        name: 'Strict Bot',
        description: 'Strict KB only bot',
        systemPrompt: 'Strict.',
        providerConnectionId: connectionId,
        modelId: 'gpt-6-luna',
        responsePolicy: 'strict_kb_only',
        toolPermissions: ['search_knowledge_base']
      })
      const strictConv = convRepo.getOrCreate({ botId: strictBot.id, knowledgeBaseId: kbAId })

      const stream = turnService.sendMessage(sessionId, {
        conversationId: strictConv.id,
        content: 'Query with no matching documents'
      })

      const deltas: string[] = []
      for await (const evt of stream) {
        if (evt.type === 'text_delta') {
          deltas.push(evt.textDelta)
        }
      }

      const result = await stream.getResult()
      expect(deltas.join('')).toContain('operates strictly in Knowledge Base Only mode')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
      // Provider stream was not even called
      expect(mockExecService.streamPreparedTurn).not.toHaveBeenCalled()
    })

    it('8. Chat continues respecting Balanced retrieval and fallback', async () => {
      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvA.id,
        content: 'Query with general fallback in balanced mode'
      })

      for await (const evt of stream) {
        void evt
      }
      const result = await stream.getResult()
      expect(result.assistantMessage.metadata.groundingMode).toBe('general_fallback_no_usable_kb')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
    })

    it('9. Chat continues respecting General AI behavior', async () => {
      const generalBot = botRepo.create({
        knowledgeBaseId: kbAId,
        name: 'General Chat Bot',
        description: 'General AI mode bot',
        systemPrompt: 'General.',
        providerConnectionId: connectionId,
        modelId: 'gpt-6-luna',
        responsePolicy: 'general_ai_chat',
        toolPermissions: []
      })
      const generalConv = convRepo.getOrCreate({ botId: generalBot.id, knowledgeBaseId: kbAId })

      const stream = turnService.sendMessage(sessionId, {
        conversationId: generalConv.id,
        content: 'Write a poem about space'
      })

      for await (const evt of stream) {
        void evt
      }
      const result = await stream.getResult()
      expect(result.assistantMessage.metadata.groundingMode).toBe('general_chat')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
    })

    it('10. Existing provenance and citation validation still works in Chat', async () => {
      const sampleCitation: CitationDto = {
        citationNumber: 1,
        sourceId: randomUUID(),
        chunkId: randomUUID(),
        fileName: 'protocol.pdf',
        fileType: 'pdf',
        pageNumber: 3,
        headingPath: ['Chapter 1'],
        chunkIndex: 0
      }

      const origPrepare = conversationService.prepareTurn.bind(conversationService)
      vi.spyOn(conversationService, 'prepareTurn').mockImplementation((sId, req) => {
        const turn = origPrepare(sId, req)
        const citationMap = new Map<number, CitationDto>([[1, sampleCitation]])
        return {
          ...turn,
          citationCandidates: [sampleCitation],
          citationMap
        }
      })

      vi.mocked(mockExecService.streamPreparedTurn).mockImplementationOnce((preparedTurn) => {
        return createMockExecutionStream({
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          resultText: 'According to the protocol [1], the experiment succeeded.',
          citationMap: preparedTurn.citationMap
        })
      })

      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvA.id,
        content: 'Cite the protocol'
      })

      for await (const evt of stream) {
        void evt
      }
      const result = await stream.getResult()
      expect(result.assistantMessage.metadata.citations).toHaveLength(1)
      expect(result.assistantMessage.metadata.citations![0].fileName).toBe('protocol.pdf')
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
    })
  })

  // ==========================================================================
  // Section 2: Agent Execution Tests (Scenarios 11 - 20)
  // ==========================================================================

  describe('Section 2: Agent Execution Tests', () => {
    it('11. Explicit Agent mode reaches the existing Agent execution pipeline', async () => {
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Agent task completed successfully.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Analyze project workspace'
      })

      expect(outcome.success).toBe(true)
      expect(outcome.runStatus).toBe('completed')
      expect(outcome.userMessage?.metadata.executionMode).toBe('agent')
      expect(outcome.assistantMessage?.metadata.executionMode).toBe('agent')
      expect(outcome.assistantMessage?.metadata.agentRunId).toBe(outcome.agentRunId)
    })

    it('12. Agent mode loads authoritative Bot permissions from Main process', async () => {
      // Bot A has 0 enabled tools in database
      await expect(
        agentTaskService.dispatchTask(sessionId, {
          botId: botAId,
          conversationId: canonicalConvA.id,
          taskContent: 'Attempt task on toolless bot'
        })
      ).rejects.toThrowError(/has no enabled Phase 8 tools/i)
    })

    it('13. Enabled tools can execute through the authorized path', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'search_knowledge_base',
        rawArguments: { a: 10, b: 20 }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Calculated 10 + 20 = 30.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Add 10 and 20'
      })

      expect(outcome.success).toBe(true)
      expect(outcome.toolEvents).toHaveLength(1)
      expect(outcome.toolEvents[0].toolName).toBe('search_knowledge_base')
      expect(outcome.toolEvents[0].status).toBe('completed')
      expect(outcome.toolEvents[0].resultSummary).toContain('30')
    })

    it('14. Disabled tools cannot execute', async () => {
      // Bot only has search_knowledge_base and read_knowledge_source; save_report is disabled
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-unauthorized',
        toolName: 'save_report',
        rawArguments: { reportTitle: 'Hacked', markdownContent: 'Content' }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Stopped after rejection.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Try to save a report'
      })

      expect(outcome.runStatus).toBe('failed')
      expect(outcome.toolEvents).toHaveLength(1)
      expect(outcome.toolEvents[0].status).toBe('failed')
      expect(outcome.toolEvents[0].errorMessage).toContain('not enabled for Bot')
    })

    it('15. Unknown tools cannot execute', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-unknown',
        toolName: 'unregistered_tool_xyz',
        rawArguments: {}
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Stopped after unknown tool.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Execute unknown tool'
      })

      expect(outcome.runStatus).toBe('failed')
      expect(outcome.errorMessage).toContain('Invalid tool identifier')
    })

    it('16. Malformed arguments are rejected gracefully without crashing', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-malformed',
        toolName: 'search_knowledge_base',
        rawArguments: { a: 'not-a-number', b: true }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Recovered from malformed arguments.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Send bad arguments'
      })

      expect(outcome.runStatus).toBe('failed')
      expect(outcome.toolEvents[0].status).toBe('failed')
      expect(outcome.toolEvents[0].errorMessage).toContain('Invalid arguments for tool')
    })

    it('17. Agent runs are associated with the correct Bot and canonical conversation', async () => {
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Audit completed.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Audit run associations'
      })

      const run = runRepo.getById(outcome.agentRunId)
      expect(run).toBeDefined()
      expect(run!.botId).toBe(botWithToolsId)
      expect(run!.conversationId).toBe(canonicalConvWithTools.id)
    })

    it('18. Tool events are associated with the correct Agent run', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-assoc',
        toolName: 'search_knowledge_base',
        rawArguments: { a: 1, b: 2 }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Done'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Verify tool event run association'
      })

      const events = toolEventRepo.listByAgentRun(outcome.agentRunId)
      expect(events).toHaveLength(1)
      expect(events[0].agentRunId).toBe(outcome.agentRunId)
      const run = runRepo.getById(events[0].agentRunId)
      expect(run?.botId).toBe(botWithToolsId)
    })

    it('19. Failed tool execution is not reported as successful', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-fail',
        toolName: 'read_knowledge_source',
        rawArguments: { reason: 'disk offline' }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Failed gracefully.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Execute failing tool'
      })

      expect(outcome.toolEvents[0].status).toBe('failed')
      expect(outcome.toolEvents[0].errorMessage).toContain(
        'Deterministic tool failure: disk offline'
      )
    })

    it('20. Agent result persistence retains the existing execution and audit data', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-persist',
        toolName: 'search_knowledge_base',
        rawArguments: { a: 4, b: 5 }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Summary of 4 + 5 is 9.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Persist task'
      })

      expect(outcome.assistantMessage).toBeDefined()
      const assistantMsg = outcome.assistantMessage!
      expect(assistantMsg.metadata.agentRunId).toBe(outcome.agentRunId)
      expect(assistantMsg.metadata.executionMode).toBe('agent')
      expect(assistantMsg.metadata.toolCalls).toHaveLength(1)
      expect(assistantMsg.metadata.toolCalls![0].toolName).toBe('search_knowledge_base')
      expect(assistantMsg.metadata.toolCalls![0].status).toBe('completed')
    })
  })

  // ==========================================================================
  // Section 3: Cross-Mode Isolation and Security Tests (Scenarios 21 - 28)
  // ==========================================================================

  describe('Section 3: Cross-Mode Isolation and Security Tests', () => {
    it('21. Chat cannot call Agent-only IPC operations', () => {
      // Trying to pass executionMode: 'chat' to dispatchAgentTaskRequestSchema fails
      const invalidAgentPayload = {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskPrompt: 'Try to pass chat mode into agent dispatch',
        executionMode: 'chat'
      }

      const parsed = dispatchAgentTaskRequestSchema.safeParse(invalidAgentPayload)
      expect(parsed.success).toBe(false)
    })

    it('22. Renderer cannot override Main-process tool permissions', async () => {
      // Bot A has 0 enabled tools. Client attempting to pass tool instructions in task
      await expect(
        agentTaskService.dispatchTask(sessionId, {
          botId: botAId,
          conversationId: canonicalConvA.id,
          taskContent: 'Please use search_knowledge_base tool'
        })
      ).rejects.toThrowError(/has no enabled Phase 8 tools/i)
    })

    it('23. An Agent cannot access another Bot tools or KB', async () => {
      // Create KB B with Bot B
      const kbB = kbRepo.create({ name: 'KB Beta', description: 'Foreign KB' })
      const botB = botRepo.create({
        knowledgeBaseId: kbB.id,
        name: 'Bot in Beta',
        description: 'Foreign bot',
        systemPrompt: 'Beta',
        providerConnectionId: connectionId,
        modelId: 'gpt-6-luna',
        responsePolicy: 'balanced_kb_first',
        toolPermissions: ['search_knowledge_base']
      })
      const convB = convRepo.getOrCreate({ botId: botB.id, knowledgeBaseId: kbB.id })

      // Active workspace is KB A; dispatching Bot B from KB B is rejected
      await expect(
        agentTaskService.dispatchTask(sessionId, {
          botId: botB.id,
          conversationId: convB.id,
          taskContent: 'Cross KB query'
        })
      ).rejects.toThrowError(/does not belong to the active Knowledge Base/i)
    })

    it('24. Switching Bots does not leak Agent state or events', async () => {
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Bot With Tools done.'
      })

      const outcome = await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Run task on bot 1'
      })

      // Querying runs for Bot A returns 0
      const runsBotA = runRepo.listByConversation(canonicalConvA.id)
      expect(runsBotA).toHaveLength(0)

      // Querying tool events for Bot A returns 0
      const eventsBotA = dbContext.db
        .prepare(
          `
          SELECT te.* FROM tool_events te
          JOIN agent_runs ar ON te.agent_run_id = ar.id
          WHERE ar.bot_id = ?
        `
        )
        .all(botAId)
      expect(eventsBotA).toHaveLength(0)

      // Only Bot With Tools has the run
      const runsWithTools = runRepo.listByConversation(canonicalConvWithTools.id)
      expect(runsWithTools).toHaveLength(1)
      expect(runsWithTools[0].id).toBe(outcome.agentRunId)
    })

    it('25. Switching from Agent to Chat does not carry over Agent permissions', async () => {
      // First run an Agent task on botWithTools
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-prior',
        toolName: 'search_knowledge_base',
        rawArguments: { a: 1, b: 1 }
      })
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Task completed.'
      })

      await agentTaskService.dispatchTask(sessionId, {
        botId: botWithToolsId,
        conversationId: canonicalConvWithTools.id,
        taskContent: 'Prior task'
      })

      // Immediately execute a Chat turn on the same canonical conversation
      const chatStream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'Subsequent chat message'
      })
      for await (const evt of chatStream) {
        void evt
      }
      const chatResult = await chatStream.getResult()

      expect(chatResult.assistantMessage.metadata.executionMode).toBe('chat')
      expect(chatResult.assistantMessage.metadata.toolCalls).toBeUndefined()
      expect(chatResult.assistantMessage.metadata.agentRunId).toBeUndefined()
    })

    it('26. A model-generated request cannot change the selected execution mode', async () => {
      vi.mocked(mockExecService.streamPreparedTurn).mockImplementationOnce((preparedTurn) => {
        return createMockExecutionStream({
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          resultText: 'I would like to switch to agent mode now and execute tools.'
        })
      })

      const stream = turnService.sendMessage(sessionId, {
        conversationId: canonicalConvWithTools.id,
        content: 'Can you run tools?'
      })
      for await (const evt of stream) {
        void evt
      }
      const result = await stream.getResult()

      // Model's text cannot change executionMode or execute tools
      expect(result.assistantMessage.metadata.executionMode).toBe('chat')
      expect(result.assistantMessage.metadata.toolCalls).toBeUndefined()
    })

    it('27. Archived or unavailable Bots cannot execute Agent tasks', async () => {
      botRepo.update(botWithToolsId, kbAId, { status: 'archived' })

      await expect(
        agentTaskService.dispatchTask(sessionId, {
          botId: botWithToolsId,
          conversationId: canonicalConvWithTools.id,
          taskContent: 'Run on archived bot'
        })
      ).rejects.toThrowError(/is archived/i)
    })

    it('28. Conversation/Bot mismatches are rejected', async () => {
      // Try to dispatch an Agent task using BotWithTools against Bot A's conversation
      await expect(
        agentTaskService.dispatchTask(sessionId, {
          botId: botWithToolsId,
          conversationId: canonicalConvA.id,
          taskContent: 'Mismatched conversation task'
        })
      ).rejects.toThrowError(/belongs to Bot/i)

      // Try to dispatch a Chat turn with mismatch
      expect(() => {
        turnService.sendMessage(sessionId, {
          conversationId: canonicalConvA.id,
          content: 'Mismatch test'
        })
      }).not.toThrow() // canonicalConvA matches Bot A
    })
  })
})
