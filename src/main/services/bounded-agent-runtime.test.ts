import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { ToolRegistry } from '../tools/tool-registry'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../tools/agent-tool'
import { ApprovalController } from './approval-controller'
import { WorkspaceFolderService } from './workspace-folder-service'
import { BoundedAgentRuntime } from './bounded-agent-runtime'
import {
  type AgentModelStepExecutor,
  type AgentModelStepRequest,
  type AgentModelStepResult
} from '../agents/agent-model-step-executor'
import { KNOWLEDGE_BASE_ONLY_RESPONSES } from './knowledge-base-only-policy'
import type { CitationDto } from '../../shared/conversations'

// ============================================================================
// Test Mock Step Executor
// ============================================================================

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

// ============================================================================
// Sample Tools for Testing
// ============================================================================

const sampleCitation1: CitationDto = {
  citationNumber: 1,
  sourceId: 'src-alpha',
  chunkId: 'chk-alpha-1',
  fileName: 'Falcon-Manual.pdf',
  fileType: 'pdf',
  pageNumber: 3,
  headingPath: ['Specifications', 'Avionics'],
  chunkIndex: 0
}

function createMockSearchKbTool(): AgentTool {
  return {
    name: 'search_knowledge_base',
    description: 'Searches the parent Knowledge Base.',
    schema: z.object({ query: z.string() }).strict(),
    requiredPermission: 'search_knowledge_base',
    execute: (args: unknown): ToolExecutionOutput => {
      const q = (args as { query: string }).query
      return {
        result: {
          status: 'SUCCESS',
          totalResults: 1,
          excerpts: [
            {
              citationNumber: 1,
              documentName: 'Falcon-Manual.pdf',
              chunkIndex: 0,
              content: 'Alpha falcon flight speed is Mach 3.2.'
            }
          ],
          citations: [sampleCitation1]
        },
        resultSummary: `Found 1 excerpt(s) for query: "${q}"`
      }
    }
  }
}

function createMockSearchWorkspaceTool(): AgentTool {
  return {
    name: 'search_workspace_files',
    description: 'Searches user workspace files.',
    schema: z.object({ pattern: z.string() }).strict(),
    requiredPermission: 'search_workspace_files',
    execute: (): ToolExecutionOutput => {
      return {
        result: {
          matches: [{ relativePath: 'config/settings.json', line: 12, preview: '"debug": true' }],
          totalMatches: 1
        },
        resultSummary: 'Found 1 match in workspace'
      }
    }
  }
}

function createMockReadWorkspaceTool(): AgentTool {
  return {
    name: 'read_workspace_file',
    description: 'Reads user workspace file.',
    schema: z.object({ relativePath: z.string() }).strict(),
    requiredPermission: 'read_workspace_file',
    execute: (args: unknown): ToolExecutionOutput => {
      const rel = (args as { relativePath: string }).relativePath
      return {
        result: {
          relativePath: rel,
          lines: ['line 1: export const API_PORT = 8080'],
          totalLines: 1
        },
        resultSummary: `Read 1 lines from ${rel}`
      }
    }
  }
}

function createMockSaveReportTool(approvalController: ApprovalController): AgentTool {
  return {
    name: 'save_report',
    description: 'Saves an analytical markdown report.',
    schema: z.object({ title: z.string(), markdownContent: z.string() }).strict(),
    requiredPermission: 'save_report',
    execute: async (args: unknown, context: ToolExecutionContext): Promise<ToolExecutionOutput> => {
      const input = args as { title: string; markdownContent: string }
      const decision = await approvalController.requestApproval({
        agentRunId: context.agentRunId!,
        botId: context.botId,
        title: input.title,
        markdownContent: input.markdownContent,
        signal: context.signal
      })

      if (decision.status !== 'approved') {
        return {
          result: {
            status: decision.status,
            message: decision.reason ?? `Report saving ${decision.status}`
          },
          resultSummary: `Report saving was ${decision.status}: "${input.title}"`
        }
      }

      approvalController.consumeContent(decision.requestId)
      return {
        result: {
          status: 'saved',
          fileName: 'falcon-analysis.md',
          bytesWritten: 128
        },
        resultSummary: `Report saved as "falcon-analysis.md" (128 bytes)`
      }
    }
  }
}

// ============================================================================
// Test Suite: BoundedAgentRuntime
// ============================================================================

describe('BoundedAgentRuntime (Phase 8 Step 8.6)', () => {
  let ctx: MigratedTestDatabaseContext
  let agentRunRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let convRepo: ConversationRepository
  let toolRegistry: ToolRegistry
  let stepExecutor: DeterministicMockStepExecutor
  let approvalController: ApprovalController
  let workspaceFolderService: WorkspaceFolderService
  let runtime: BoundedAgentRuntime

  let kb1Id: string
  let bot1Id: string

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    agentRunRepo = new AgentRunRepository(ctx.db)
    toolEventRepo = new ToolEventRepository(ctx.db)
    convRepo = new ConversationRepository(ctx.db)
    approvalController = new ApprovalController()
    workspaceFolderService = new WorkspaceFolderService()

    toolRegistry = new ToolRegistry({
      botRepository: ctx.botRepo,
      knowledgeBaseRepository: ctx.kbRepo
    })

    toolRegistry.register(createMockSearchKbTool())
    toolRegistry.register(createMockSearchWorkspaceTool())
    toolRegistry.register(createMockReadWorkspaceTool())
    toolRegistry.register(createMockSaveReportTool(approvalController))

    stepExecutor = new DeterministicMockStepExecutor()

    runtime = new BoundedAgentRuntime({
      botRepository: ctx.botRepo,
      knowledgeBaseRepository: ctx.kbRepo,
      agentRunRepository: agentRunRepo,
      toolEventRepository: toolEventRepo,
      toolRegistry,
      stepExecutor,
      approvalController,
      workspaceFolderService,
      conversationRepository: convRepo
    })

    const kb = ctx.kbRepo.create({ name: 'Aviation Knowledge Base' })
    kb1Id = kb.id

    const bot = ctx.botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Falcon Bot',
      systemPrompt: 'You are an aeronautics specialist.',
      modelId: 'gpt-4o',
      toolPermissions: [
        'search_knowledge_base',
        'search_workspace_files',
        'read_workspace_file',
        'save_report'
      ]
    })
    bot1Id = bot.id
  })

  afterEach(() => {
    approvalController.clear()
    workspaceFolderService.clear()
    ctx.cleanup()
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // 1. Runtime Lifecycle & Model Step Orchestration
  // ==========================================================================

  describe('Runtime Lifecycle & Decisions', () => {
    it('1. successfully executes a 1-step final response when grounded in retrieved evidence', async () => {
      // Step 1: Tool search to gather citation
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'mach speed' }
      })

      // Step 2: Final response citing [1]
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'The Alpha falcon operates at Mach 3.2 [1].'
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'What is the top speed of the Alpha falcon?'
      })

      expect(result.status).toBe('completed')
      expect(result.iterationCount).toBe(2)
      expect(result.finalResponse).toBe('The Alpha falcon operates at Mach 3.2 [1].')
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0].citationNumber).toBe(1)

      // Verify AgentRun persisted in SQLite
      const runRecord = agentRunRepo.getById(result.agentRunId)
      expect(runRecord).not.toBeNull()
      expect(runRecord?.status).toBe('completed')
      expect(runRecord?.iterationCount).toBe(2)
      expect(runRecord?.completedAt).toBeGreaterThanOrEqual(runRecord?.startedAt ?? 0)
    })

    it('2. executes multiple tool calls across multiple iterations in sequence', async () => {
      // Iteration 1: search workspace
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'search_workspace_files',
        rawArguments: { pattern: 'config' }
      })

      // Iteration 2: read workspace file
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-2',
        toolName: 'read_workspace_file',
        rawArguments: { relativePath: 'config/settings.json' }
      })

      // Iteration 3: final response
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'The API port configured in the workspace is 8080.'
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Find the API port from the workspace.'
      })

      expect(result.status).toBe('completed')
      expect(result.iterationCount).toBe(3)
      expect(result.finalResponse).toBe('The API port configured in the workspace is 8080.')
      expect(result.workspaceFiles).toEqual(['config/settings.json'])

      // Verify tool events in SQLite
      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(2)
      expect(events[0].toolName).toBe('search_workspace_files')
      expect(events[0].sequenceNumber).toBe(1)
      expect(events[0].status).toBe('completed')
      expect(events[1].toolName).toBe('read_workspace_file')
      expect(events[1].sequenceNumber).toBe(2)
      expect(events[1].status).toBe('completed')
    })

    it('3. rejects empty or invalid model step results gracefully', async () => {
      stepExecutor.enqueueDecision({
        type: 'non_existent_type'
      } as unknown as AgentModelStepResult)

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Do something'
      })

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('Model step executor returned unknown decision type')

      const runRecord = agentRunRepo.getById(result.agentRunId)
      expect(runRecord?.status).toBe('failed')
    })
  })

  // ==========================================================================
  // 2. Iteration Limits (MAX_AGENT_ITERATIONS = 5) & Boundary Values
  // ==========================================================================

  describe('Iteration Limits & Boundaries', () => {
    it('4. enforces maximum 5 iterations and fails when limit is reached without final response', async () => {
      // Enqueue 5 consecutive tool calls
      for (let i = 1; i <= 5; i++) {
        stepExecutor.enqueueDecision({
          type: 'tool_call',
          toolCallId: `call-${i}`,
          toolName: 'search_workspace_files',
          rawArguments: { pattern: `query-${i}` }
        })
      }

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Search repeatedly'
      })

      expect(result.status).toBe('failed')
      expect(result.iterationCount).toBe(5)
      expect(result.errorSummary).toContain('Maximum agent iterations (5) exceeded')

      // Exactly 5 tool events persisted
      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(5)

      // Ensure SQLite DB check constraint is respected (iteration_count = 5)
      const dbRun = agentRunRepo.getById(result.agentRunId)
      expect(dbRun?.iterationCount).toBe(5)
      expect(dbRun?.status).toBe('failed')
    })

    it('5. respects boundary value maxIterations: 0', async () => {
      const result = await runtime.run({
        botId: bot1Id,
        task: 'Immediate termination',
        maxIterations: 0
      })

      expect(result.status).toBe('failed')
      expect(result.iterationCount).toBe(0)
      expect(result.errorSummary).toContain('Maximum agent iterations (0) exceeded')
      expect(stepExecutor.requests).toHaveLength(0)
    })

    it('6. respects boundary value maxIterations: 1', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'search_workspace_files',
        rawArguments: { pattern: 'test' }
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Single step only',
        maxIterations: 1
      })

      expect(result.status).toBe('failed')
      expect(result.iterationCount).toBe(1)
      expect(result.errorSummary).toContain('Maximum agent iterations (1) exceeded')
      expect(stepExecutor.requests).toHaveLength(1)
    })

    it('7. clamps attempted maxIterations > 5 to MAX_AGENT_RUN_ITERATIONS (5)', async () => {
      for (let i = 1; i <= 5; i++) {
        stepExecutor.enqueueDecision({
          type: 'tool_call',
          toolCallId: `call-${i}`,
          toolName: 'search_workspace_files',
          rawArguments: { pattern: `query-${i}` }
        })
      }

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Attempt 10 iterations',
        maxIterations: 10
      })

      // Clamped to 5 iterations
      expect(result.iterationCount).toBe(5)
      expect(result.status).toBe('failed')
      expect(stepExecutor.requests).toHaveLength(5)
    })
  })

  // ==========================================================================
  // 3. Security, Scoping & Permission Guarantees
  // ==========================================================================

  describe('Security & Scoping Guarantees', () => {
    it('8. prevents execution if Bot is archived', async () => {
      ctx.botRepo.update(bot1Id, kb1Id, { status: 'archived' })

      await expect(
        runtime.run({
          botId: bot1Id,
          task: 'Test task'
        })
      ).rejects.toThrow('archived')
    })

    it('9. prevents execution if parent Knowledge Base is archived', async () => {
      ctx.kbRepo.archive(kb1Id)

      await expect(
        runtime.run({
          botId: bot1Id,
          task: 'Test task'
        })
      ).rejects.toThrow('archived')
    })

    it('10. rejects execution when conversation does not belong to Bot/KB', async () => {
      // Create second KB and Bot
      const kb2 = ctx.kbRepo.create({ name: 'Other KB' })
      const bot2 = ctx.botRepo.create({
        knowledgeBaseId: kb2.id,
        name: 'Bot Beta',
        modelId: 'gpt-4o'
      })
      const conv2 = convRepo.create({
        botId: bot2.id,
        knowledgeBaseId: kb2.id,
        title: 'Other Thread'
      })

      await expect(
        runtime.run({
          botId: bot1Id,
          conversationId: conv2.id,
          task: 'Test task'
        })
      ).rejects.toThrow(/does not belong to Bot/i)
    })

    it('11. fails the run when model requests a tool not permitted for the Bot', async () => {
      // Create bot with zero permissions
      const restrictedBot = ctx.botRepo.create({
        knowledgeBaseId: kb1Id,
        name: 'Restricted Bot',
        modelId: 'gpt-4o',
        toolPermissions: []
      })

      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-unauthorized',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'test' }
      })

      const result = await runtime.run({
        botId: restrictedBot.id,
        task: 'Attempt unauthorized search'
      })

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain("Tool 'search_knowledge_base' failed")

      // Tool event in DB marked failed
      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('failed')
      expect(events[0].errorMessage).toContain('Permission denied')
    })

    it('12. fails the run when model provides malformed tool arguments', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-invalid-args',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 12345 } // Must be a string
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Search with bad args'
      })

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('Invalid arguments')

      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events[0].status).toBe('failed')
    })
  })

  // ==========================================================================
  // 4. Human Approval Workflow (save_report)
  // ==========================================================================

  describe('save_report Human Approval Pause & Resume', () => {
    it('13. transitions run to waiting_approval, pauses, and resumes upon user approval', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-save-1',
        toolName: 'save_report',
        rawArguments: {
          title: 'Falcon Avionics Review',
          markdownContent: '# Avionics Report\n\nAll systems operational.'
        }
      })

      // Following step after approval
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Report has been successfully saved to your chosen location.'
      })

      let runIdCaptured: string | undefined
      approvalController.onEvent((event) => {
        if (event.type === 'requested') {
          runIdCaptured = event.request.agentRunId
          // Verify agent run status is waiting_approval in database after runtime listener updates it
          setTimeout(() => {
            const currentRun = agentRunRepo.getById(event.request.agentRunId)
            expect(currentRun?.status).toBe('waiting_approval')

            // Approve out-of-band
            approvalController.approve(event.request.requestId, {
              agentRunId: event.request.agentRunId,
              botId: event.request.botId
            })
          }, 10)
        }
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Save report on falcon avionics'
      })

      expect(result.status).toBe('completed')
      expect(result.iterationCount).toBe(2)
      expect(runIdCaptured).toBe(result.agentRunId)

      // Verify tool event approval status
      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(1)
      expect(events[0].approvalStatus).toBe('user_approved')
      expect(events[0].status).toBe('completed')
    })

    it('14. handles human rejection safely: model sees rejection and can conclude without writing files', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-save-rejected',
        toolName: 'save_report',
        rawArguments: {
          title: 'Rejected Plan',
          markdownContent: '# Plan\n\nTo be rejected.'
        }
      })

      // Model acknowledges rejection in next step
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'I understand you declined to save the report. The operation was cancelled.'
      })

      approvalController.onEvent((event) => {
        if (event.type === 'requested') {
          setTimeout(() => {
            approvalController.reject(
              event.request.requestId,
              { agentRunId: event.request.agentRunId, botId: event.request.botId },
              'User decided not to save.'
            )
          }, 10)
        }
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Save the draft plan'
      })

      expect(result.status).toBe('completed')
      expect(result.iterationCount).toBe(2)

      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(1)
      expect(events[0].approvalStatus).toBe('user_rejected')
      expect(events[0].status).toBe('completed')
      expect(events[0].resultSummary).toContain('rejected')
    })
  })

  // ==========================================================================
  // 5. Cancellation & Resource Cleanup
  // ==========================================================================

  describe('Cancellation & Resource Cleanup', () => {
    it('15. cancels immediately when pre-aborted signal is passed', async () => {
      const abortController = new AbortController()
      abortController.abort('Pre-aborted test')

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Will not run',
        signal: abortController.signal
      })

      expect(result.status).toBe('cancelled')
      expect(result.iterationCount).toBe(0)
      expect(stepExecutor.requests).toHaveLength(0)

      const runRecord = agentRunRepo.getById(result.agentRunId)
      expect(runRecord?.status).toBe('cancelled')
    })

    it('16. cancels while awaiting approval and marks active run and event cancelled', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-save-cancel',
        toolName: 'save_report',
        rawArguments: {
          title: 'Pending Report',
          markdownContent: '# Pending\n\nContent'
        }
      })

      approvalController.onEvent((event) => {
        if (event.type === 'requested') {
          // Cancel active run via runtime API while waiting for approval
          setTimeout(() => {
            runtime.cancelRun(event.request.agentRunId, 'User clicked stop generation')
          }, 10)
        }
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Save report with cancel'
      })

      expect(result.status).toBe('cancelled')
      const runRecord = agentRunRepo.getById(result.agentRunId)
      expect(runRecord?.status).toBe('cancelled')

      // Ensure active run was cleared from memory
      expect(runtime.isRunActive(result.agentRunId)).toBe(false)
    })

    it('17. provides safe and idempotent cancelRun calls', () => {
      expect(runtime.cancelRun('non-existent-run-id')).toBe(false)
    })
  })

  // ==========================================================================
  // 6. Timeouts & Budget Limits
  // ==========================================================================

  describe('Timeouts & Context Budget Limits', () => {
    it('18. enforces step timeout when model executor takes too long', async () => {
      stepExecutor.setHandler(async () => {
        // Delay longer than step timeout
        await new Promise((r) => setTimeout(r, 100))
        return { type: 'final', content: 'Too late' }
      })

      const result = await runtime.run(
        {
          botId: bot1Id,
          task: 'Timeout test'
        },
        {
          stepTimeoutMs: 20 // 20ms timeout
        }
      )

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('Model step timed out')
    })

    it('19. enforces context budget limit before exceeding token ceiling', async () => {
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Final'
      })

      const result = await runtime.run(
        {
          botId: bot1Id,
          task: 'A'.repeat(5000) // Large prompt
        },
        {
          modelContextLimit: 1000, // Small limit
          reservedOutputTokens: 500
        }
      )

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('Context budget exceeded')
    })
  })

  // ==========================================================================
  // 7. Knowledge Base Only Grounding Policy
  // ==========================================================================

  describe('Knowledge Base Only Grounding Enforcement', () => {
    it('20. replaces answer with safe refusal if no KB evidence was gathered and general knowledge was attempted', async () => {
      // Model immediately attempts to answer from general training knowledge without searching KB
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'The capital of France is Paris and it was founded in the 3rd century.'
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'What is the capital of France?'
      })

      expect(result.status).toBe('completed')
      // Refusal from KnowledgeBaseOnlyPolicy returned because no KB evidence was gathered
      expect(result.finalResponse).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE)
      expect(result.citations).toHaveLength(0)
    })

    it('21. replaces response with ungrounded response if model hallucinated fake citation IDs', async () => {
      // Step 1: Real search gathers citation 1
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'search_knowledge_base',
        rawArguments: { query: 'mach speed' }
      })

      // Step 2: Final response attempts to cite fake citation [99]
      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'The Alpha falcon operates at Mach 3.2 [99].'
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'What is the speed?'
      })

      expect(result.status).toBe('completed')
      expect(result.finalResponse).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(result.citations).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 8. Advanced Scenarios: Unknown Tools, Timeouts & Resource Grants
  // ==========================================================================

  describe('Advanced Edge Cases & Robustness', () => {
    it('22. fails gracefully when model requests an unknown tool identifier', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-unknown',
        toolName: 'non_existent_tool',
        rawArguments: {}
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Execute phantom tool'
      })

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain("Invalid tool identifier: 'non_existent_tool'")

      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(0)
    })

    it('22b. records failed tool event when model requests recognized tool that is not registered in registry', async () => {
      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-unregistered',
        toolName: 'read_knowledge_base_document', // Recognized legacy alias but not registered in this registry
        rawArguments: { sourceId: 'src-1' }
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Execute unregistered tool'
      })

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('is not registered')

      const events = toolEventRepo.listByAgentRun(result.agentRunId)
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('failed')
    })

    it('23. enforces per-tool execution timeout', async () => {
      // Register a slow tool
      toolRegistry.register({
        name: 'list_knowledge_sources',
        description: 'Slow list tool',
        schema: z.object({}).strict(),
        requiredPermission: 'list_knowledge_sources',
        execute: async () => {
          await new Promise((r) => setTimeout(r, 100))
          return { result: [], resultSummary: 'Slow tool done' }
        }
      })

      // Update bot to have list_knowledge_sources permission
      ctx.botRepo.update(bot1Id, kb1Id, {
        toolPermissions: ['list_knowledge_sources']
      })

      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-slow',
        toolName: 'list_knowledge_sources',
        rawArguments: {}
      })

      const result = await runtime.run(
        {
          botId: bot1Id,
          task: 'Run slow tool'
        },
        {
          toolTimeoutMs: 20 // 20ms timeout
        }
      )

      expect(result.status).toBe('failed')
      expect(result.errorSummary).toContain('timed out')
    })

    it('24. enforces overall run timeout across multiple steps', async () => {
      stepExecutor.setHandler(async () => {
        await new Promise((r) => setTimeout(r, 80))
        return {
          type: 'final',
          content: 'Delayed response'
        }
      })

      const result = await runtime.run(
        {
          botId: bot1Id,
          task: 'Run exceeding run timeout'
        },
        {
          runTimeoutMs: 30 // 30ms run timeout
        }
      )

      expect(result.status).toBe('cancelled')
    })

    it('25. safely truncates tool outputs that exceed maxToolOutputBytes', async () => {
      // Tool returning oversized string
      toolRegistry.register({
        name: 'read_knowledge_source',
        description: 'Large content reader',
        schema: z.object({ sourceId: z.string() }).strict(),
        requiredPermission: 'read_knowledge_source',
        execute: () => {
          return {
            result: {
              sourceId: 'src-1',
              documentName: 'BigDoc.txt',
              chunks: [{ chunkIndex: 0, content: 'X'.repeat(5000) }]
            },
            resultSummary: 'Read 5000 chars'
          }
        }
      })

      ctx.botRepo.update(bot1Id, kb1Id, {
        toolPermissions: ['read_knowledge_source']
      })

      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-big',
        toolName: 'read_knowledge_source',
        rawArguments: { sourceId: 'src-1' }
      })

      stepExecutor.enqueueDecision({
        type: 'final',
        content: 'Acknowledged big tool output.'
      })

      const result = await runtime.run(
        {
          botId: bot1Id,
          task: 'Read large source'
        },
        {
          maxToolOutputBytes: 500 // Small 500 byte limit
        }
      )

      expect(result.status).toBe('completed')
      // Check that history message content was truncated
      const lastReq = stepExecutor.requests[1]
      const toolMsg = lastReq.history.find((m) => m.role === 'tool')
      expect(toolMsg?.content).toContain('truncated due to size')
    })

    it('26. revokes workspace folder grant in cleanup even on failure or cancellation', async () => {
      // Mock workspace folder grant for the run
      vi.spyOn(workspaceFolderService, 'revoke')

      stepExecutor.enqueueDecision({
        type: 'tool_call',
        toolCallId: 'call-fail',
        toolName: 'non_existent_tool',
        rawArguments: {}
      })

      const result = await runtime.run({
        botId: bot1Id,
        task: 'Trigger cleanup check'
      })

      expect(result.status).toBe('failed')
      expect(workspaceFolderService.revoke).toHaveBeenCalledWith(result.agentRunId)
    })
  })
})
