import { randomUUID } from 'node:crypto'
import {
  type ToolEventDto,
  type ToolApprovalStatus,
  MAX_AGENT_RUN_ITERATIONS,
  MAX_ERROR_SUMMARY_LENGTH,
  isBotToolEnabled,
  normalizeToolName
} from '../../shared/agents'
import type { CitationDto } from '../../shared/conversations'
import type {
  AgentModelStepExecutor,
  AgentModelStepRequest,
  AgentModelStepResult,
  AgentMessage,
  AgentToolDescriptor
} from '../agents/agent-model-step-executor'
import type { AgentRunRepository } from '../database/repositories/agent-run-repository'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { ConversationRepository } from '../database/repositories/conversation-repository'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import type { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { estimateTokenCount } from '../documents/chunking/semantic-chunker'
import { type ToolRegistry, type ExecuteToolOptions } from '../tools/tool-registry'
import { ToolError, type ToolExecutionResult } from '../tools/agent-tool'
import type { ApprovalController } from './approval-controller'
import { KnowledgeBaseOnlyPolicy } from './knowledge-base-only-policy'
import { buildSystemInstruction } from './rag-prompt-builder'
import type { WorkspaceFolderService } from './workspace-folder-service'

// ============================================================================
// Constants & Defaults
// ============================================================================

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000 // 30 seconds
export const DEFAULT_STEP_TIMEOUT_MS = 60_000 // 60 seconds
export const DEFAULT_RUN_TIMEOUT_MS = 300_000 // 5 minutes
export const DEFAULT_APPROVAL_WAIT_TIMEOUT_MS = 300_000 // 5 minutes (matches ApprovalController)
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 256 * 1024 // 256 KB
export const DEFAULT_MODEL_CONTEXT_LIMIT = 128_000
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096
export const DEFAULT_SAFETY_MARGIN_TOKENS = 1000

// ============================================================================
// Error Hierarchy
// ============================================================================

export type BoundedAgentRuntimeErrorCode =
  | 'INVALID_REQUEST'
  | 'BOT_NOT_FOUND'
  | 'BOT_ARCHIVED'
  | 'KNOWLEDGE_BASE_NOT_FOUND'
  | 'KNOWLEDGE_BASE_ARCHIVED'
  | 'CONVERSATION_MISMATCH'
  | 'MODEL_NOT_FOUND'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_PERMISSION_DENIED'
  | 'TOOL_VALIDATION_FAILED'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_TIMEOUT'
  | 'MODEL_STEP_TIMEOUT'
  | 'RUN_TIMEOUT'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'MAX_ITERATIONS_EXCEEDED'
  | 'RUN_CANCELLED'
  | 'STEP_EXECUTOR_FAILED'
  | 'UNGROUNDED_RESPONSE'

export class BoundedAgentRuntimeError extends Error {
  public readonly code: BoundedAgentRuntimeErrorCode
  public readonly agentRunId?: string

  constructor(message: string, code: BoundedAgentRuntimeErrorCode, agentRunId?: string) {
    super(message)
    this.name = 'BoundedAgentRuntimeError'
    this.code = code
    this.agentRunId = agentRunId
    Object.setPrototypeOf(this, BoundedAgentRuntimeError.prototype)
  }
}

// ============================================================================
// Contracts & Options
// ============================================================================

export interface BoundedAgentRuntimeDependencies {
  readonly botRepository: BotRepository
  readonly knowledgeBaseRepository: KnowledgeBaseRepository
  readonly agentRunRepository: AgentRunRepository
  readonly toolEventRepository: ToolEventRepository
  readonly toolRegistry: ToolRegistry
  readonly stepExecutor: AgentModelStepExecutor
  readonly approvalController: ApprovalController
  readonly workspaceFolderService: WorkspaceFolderService
  readonly conversationRepository?: ConversationRepository
}

export interface BoundedAgentRunRequest {
  readonly botId: string
  readonly task: string
  readonly conversationId?: string | null
  readonly selectedModel?: string
  readonly maxIterations?: number
  readonly signal?: AbortSignal
}

export interface BoundedAgentRunOptions {
  readonly toolTimeoutMs?: number
  readonly stepTimeoutMs?: number
  readonly runTimeoutMs?: number
  readonly approvalTimeoutMs?: number
  readonly maxToolOutputBytes?: number
  readonly modelContextLimit?: number
  readonly reservedOutputTokens?: number
  readonly safetyMarginTokens?: number
}

export interface BoundedAgentRunResult {
  readonly agentRunId: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly conversationId: string | null
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly iterationCount: number
  readonly finalResponse?: string
  readonly errorSummary?: string
  readonly toolEvents: readonly ToolEventDto[]
  readonly citations: readonly CitationDto[]
  readonly workspaceFiles: readonly string[]
}

interface ActiveRun {
  readonly agentRunId: string
  readonly botId: string
  readonly abortController: AbortController
  readonly startedAt: number
  runTimer?: NodeJS.Timeout
}

// ============================================================================
// Helper Utilities
// ============================================================================

function safeTruncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, Math.max(0, maxLength - 3)) + '...'
}

function sanitizeErrorForStorage(err: unknown): string {
  const rawMessage = err instanceof Error ? err.message : String(err)
  // Strip potential stack traces or multi-line error traces
  const firstLine = rawMessage.split(/\r?\n/)[0].trim()
  return safeTruncate(firstLine, MAX_ERROR_SUMMARY_LENGTH)
}

// ============================================================================
// BoundedAgentRuntime Implementation
// ============================================================================

/**
 * Main-process orchestration runtime that drives multi-step agent execution
 * using injected provider-independent model step executors.
 *
 * Core Security & Operational Invariants:
 * 1. Hard-capped iteration loop (max 5 iterations per task).
 * 2. Strictly enforces application-level Bot tool permissions via ToolRegistry.
 * 3. Scopes all Knowledge Base actions to the Bot's authoritative parent Knowledge Base.
 * 4. Never exposes or accepts a caller-supplied knowledgeBaseId from model outputs.
 * 5. Requires explicit human approval for save_report actions via ApprovalController.
 * 6. Validates grounded final responses via KnowledgeBaseOnlyPolicy.
 * 7. Enforces independent timeouts per tool, per step, and per overall run.
 * 8. Guarantees complete cleanup of workspace grants, pending approvals, and locks in finally.
 */
export class BoundedAgentRuntime {
  private readonly botRepo: BotRepository
  private readonly kbRepo: KnowledgeBaseRepository
  private readonly agentRunRepo: AgentRunRepository
  private readonly toolEventRepo: ToolEventRepository
  private readonly toolRegistry: ToolRegistry
  private readonly stepExecutor: AgentModelStepExecutor
  private readonly approvalController: ApprovalController
  private readonly workspaceFolderService: WorkspaceFolderService
  private readonly convRepo?: ConversationRepository

  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(deps: BoundedAgentRuntimeDependencies) {
    if (
      !deps.botRepository ||
      !deps.knowledgeBaseRepository ||
      !deps.agentRunRepository ||
      !deps.toolEventRepository ||
      !deps.toolRegistry ||
      !deps.stepExecutor ||
      !deps.approvalController ||
      !deps.workspaceFolderService
    ) {
      throw new Error('All primary dependencies are required to initialize BoundedAgentRuntime.')
    }

    this.botRepo = deps.botRepository
    this.kbRepo = deps.knowledgeBaseRepository
    this.agentRunRepo = deps.agentRunRepository
    this.toolEventRepo = deps.toolEventRepository
    this.toolRegistry = deps.toolRegistry
    this.stepExecutor = deps.stepExecutor
    this.approvalController = deps.approvalController
    this.workspaceFolderService = deps.workspaceFolderService
    this.convRepo = deps.conversationRepository
  }

  /**
   * Initiates and orchestrates a bounded agent run to completion, failure, or cancellation.
   */
  public async run(
    request: BoundedAgentRunRequest,
    options?: BoundedAgentRunOptions
  ): Promise<BoundedAgentRunResult> {
    if (!request || typeof request !== 'object') {
      throw new BoundedAgentRuntimeError('Run request must be an object.', 'INVALID_REQUEST')
    }

    const trimmedBotId = typeof request.botId === 'string' ? request.botId.trim() : ''
    if (trimmedBotId.length === 0) {
      throw new BoundedAgentRuntimeError(
        'botId is required and cannot be empty.',
        'INVALID_REQUEST'
      )
    }

    const trimmedTask = typeof request.task === 'string' ? request.task.trim() : ''
    if (trimmedTask.length === 0) {
      throw new BoundedAgentRuntimeError(
        'task prompt is required and cannot be empty.',
        'INVALID_REQUEST'
      )
    }

    if (request.maxIterations !== undefined) {
      if (
        typeof request.maxIterations !== 'number' ||
        !Number.isInteger(request.maxIterations) ||
        request.maxIterations < 0
      ) {
        throw new BoundedAgentRuntimeError(
          `maxIterations must be an integer >= 0. Received: ${request.maxIterations}`,
          'INVALID_REQUEST'
        )
      }
    }

    const effectiveMaxIterations =
      request.maxIterations !== undefined
        ? Math.min(request.maxIterations, MAX_AGENT_RUN_ITERATIONS)
        : MAX_AGENT_RUN_ITERATIONS

    // 1. Authoritative Bot lookup
    const bot = this.botRepo.getByIdOnly(trimmedBotId)
    if (!bot) {
      throw new BoundedAgentRuntimeError(
        `Bot with ID '${trimmedBotId}' not found.`,
        'BOT_NOT_FOUND'
      )
    }
    if (bot.status !== 'active') {
      throw new BoundedAgentRuntimeError(
        `Bot '${trimmedBotId}' is archived and cannot execute runs.`,
        'BOT_ARCHIVED'
      )
    }

    // 2. Authoritative parent Knowledge Base lookup
    const kb = this.kbRepo.getById(bot.knowledgeBaseId)
    if (!kb) {
      throw new BoundedAgentRuntimeError(
        `Parent Knowledge Base '${bot.knowledgeBaseId}' for Bot '${trimmedBotId}' not found.`,
        'KNOWLEDGE_BASE_NOT_FOUND'
      )
    }
    if (kb.archived_at !== null) {
      throw new BoundedAgentRuntimeError(
        `Parent Knowledge Base '${bot.knowledgeBaseId}' for Bot '${trimmedBotId}' is archived.`,
        'KNOWLEDGE_BASE_ARCHIVED'
      )
    }

    // 3. Conversation validation if provided
    if (request.conversationId) {
      if (this.convRepo) {
        const conv = this.convRepo.getById(request.conversationId, bot.id, bot.knowledgeBaseId)
        if (!conv) {
          throw new BoundedAgentRuntimeError(
            `Conversation '${request.conversationId}' not found or does not belong to Bot '${bot.id}' and Knowledge Base '${bot.knowledgeBaseId}'.`,
            'CONVERSATION_MISMATCH'
          )
        }
      }
    }

    // 4. Resolve model
    const selectedModel = (request.selectedModel || bot.modelId || '').trim()
    if (selectedModel.length === 0) {
      throw new BoundedAgentRuntimeError(
        'No valid model identifier specified for run.',
        'MODEL_NOT_FOUND'
      )
    }

    // 5. Create persistent AgentRun in SQLite
    const agentRun = this.agentRunRepo.create({
      botId: bot.id,
      conversationId: request.conversationId ?? null,
      selectedModel,
      initialStatus: 'queued'
    })

    // If caller provided an already-aborted signal, cancel immediately
    if (request.signal?.aborted) {
      this.agentRunRepo.markCancelled(agentRun.id)
      return {
        agentRunId: agentRun.id,
        botId: bot.id,
        knowledgeBaseId: bot.knowledgeBaseId,
        conversationId: request.conversationId ?? null,
        status: 'cancelled',
        iterationCount: 0,
        errorSummary: 'Operation was cancelled prior to execution.',
        toolEvents: [],
        citations: [],
        workspaceFiles: []
      }
    }

    // Transition to 'running'
    this.agentRunRepo.updateStatus(agentRun.id, 'running')

    // 6. Setup ActiveRun controller and timeouts
    const runAbortController = new AbortController()
    const onCallerAbort = (): void => {
      runAbortController.abort(request.signal?.reason ?? 'Run aborted by caller signal.')
    }
    if (request.signal) {
      request.signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    const activeRun: ActiveRun = {
      agentRunId: agentRun.id,
      botId: bot.id,
      abortController: runAbortController,
      startedAt: Date.now()
    }
    this.activeRuns.set(agentRun.id, activeRun)

    const toolTimeoutMs = options?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const stepTimeoutMs = options?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    const runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    const approvalTimeoutMs = options?.approvalTimeoutMs ?? DEFAULT_APPROVAL_WAIT_TIMEOUT_MS
    const maxToolOutputBytes = options?.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES
    const modelContextLimit = options?.modelContextLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT
    const reservedOutputTokens = options?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS
    const safetyMarginTokens = options?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS

    // Setup overall run timeout timer
    if (runTimeoutMs > 0) {
      activeRun.runTimer = setTimeout(() => {
        runAbortController.abort(
          new BoundedAgentRuntimeError(
            `Agent run timed out after ${runTimeoutMs}ms.`,
            'RUN_TIMEOUT',
            agentRun.id
          )
        )
      }, runTimeoutMs)
    }

    // 7. Setup ApprovalController lifecycle listener
    let activeToolEventId: string | undefined
    const unsubscribeApproval = this.approvalController.onEvent((event) => {
      if (event.request.agentRunId !== agentRun.id) {
        return
      }

      if (event.type === 'requested') {
        // Run transitions to waiting_approval
        try {
          const currentRun = this.agentRunRepo.getById(agentRun.id)
          if (currentRun && currentRun.status === 'running') {
            this.agentRunRepo.updateStatus(agentRun.id, 'waiting_approval')
          }
        } catch {
          // Ignore state update failure if already transitioned
        }
      } else if (event.type === 'resolved') {
        // Update tool event approval status
        if (activeToolEventId) {
          const decisionStatus = event.decision.status
          if (decisionStatus === 'approved') {
            try {
              this.toolEventRepo.updateApprovalStatus(activeToolEventId, 'user_approved')
            } catch {
              // Ignore
            }
          } else if (decisionStatus === 'rejected') {
            try {
              this.toolEventRepo.updateApprovalStatus(activeToolEventId, 'user_rejected')
            } catch {
              // Ignore
            }
          }
        }

        // Return agent run from waiting_approval to running if not cancelled/completed
        try {
          const currentRun = this.agentRunRepo.getById(agentRun.id)
          if (
            currentRun &&
            currentRun.status === 'waiting_approval' &&
            !runAbortController.signal.aborted
          ) {
            this.agentRunRepo.updateStatus(agentRun.id, 'running')
          }
        } catch {
          // Ignore
        }
      }
    })

    // 8. Prepare tool descriptors allowed for this Bot
    const registeredTools = this.toolRegistry.list()
    const allowedTools = registeredTools.filter((t) =>
      isBotToolEnabled(bot.toolPermissions, t.requiredPermission)
    )
    const toolDescriptors: AgentToolDescriptor[] = allowedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema
    }))

    // 9. Initialize agent message history & provenance
    const systemPromptContent = buildSystemInstruction(bot.name, bot.systemPrompt, 'SUCCESS')

    const history: AgentMessage[] = [
      {
        role: 'system',
        content: systemPromptContent
      },
      {
        role: 'user',
        content: trimmedTask
      }
    ]

    const citationMap = new Map<number, CitationDto>()
    const workspaceFiles = new Set<string>()

    let iterationCount = 0
    let finalResponse: string | undefined
    let validatedCitations: readonly CitationDto[] = []
    let loopError: BoundedAgentRuntimeError | undefined

    try {
      // 10. Execution Loop
      while (iterationCount < effectiveMaxIterations) {
        if (runAbortController.signal.aborted) {
          break
        }

        // Check context budget
        const estimatedTokens = this.estimateHistoryTokens(history)
        if (estimatedTokens + reservedOutputTokens > modelContextLimit) {
          loopError = new BoundedAgentRuntimeError(
            `Context budget exceeded: estimated ${estimatedTokens} input tokens + ${reservedOutputTokens} reserved output exceeds limit ${modelContextLimit}.`,
            'CONTEXT_BUDGET_EXCEEDED',
            agentRun.id
          )
          break
        }

        // A. Request model step decision
        let stepResult: AgentModelStepResult
        try {
          stepResult = await this.executeStepWithTimeout(
            this.stepExecutor,
            {
              agentRunId: agentRun.id,
              botId: bot.id,
              knowledgeBaseId: bot.knowledgeBaseId,
              conversationId: request.conversationId ?? null,
              selectedModel,
              history: Object.freeze([...history]),
              tools: Object.freeze([...toolDescriptors]),
              signal: runAbortController.signal,
              contextBudget: {
                modelContextLimit,
                reservedOutputTokens,
                availableInputTokens: modelContextLimit - reservedOutputTokens - safetyMarginTokens,
                estimatedCurrentTokens: estimatedTokens
              }
            },
            stepTimeoutMs,
            runAbortController.signal
          )
        } catch (err) {
          if (runAbortController.signal.aborted) {
            break
          }
          if (err instanceof BoundedAgentRuntimeError) {
            loopError = err
          } else {
            loopError = new BoundedAgentRuntimeError(
              `Step executor failed: ${err instanceof Error ? err.message : String(err)}`,
              'STEP_EXECUTOR_FAILED',
              agentRun.id
            )
          }
          break
        }

        // Validate step result structure
        if (!stepResult || typeof stepResult !== 'object') {
          loopError = new BoundedAgentRuntimeError(
            'Model step executor returned invalid result: expected object.',
            'STEP_EXECUTOR_FAILED',
            agentRun.id
          )
          break
        }

        if (stepResult.type !== 'tool_call' && stepResult.type !== 'final') {
          loopError = new BoundedAgentRuntimeError(
            `Model step executor returned unknown decision type: '${(stepResult as { type?: unknown }).type}'.`,
            'STEP_EXECUTOR_FAILED',
            agentRun.id
          )
          break
        }

        // B. Increment iteration count and persist
        iterationCount++
        this.agentRunRepo.updateIterationCount(agentRun.id, iterationCount)

        // C. Process Final Response
        if (stepResult.type === 'final') {
          if (typeof stepResult.content !== 'string') {
            loopError = new BoundedAgentRuntimeError(
              'Final decision missing required content string.',
              'STEP_EXECUTOR_FAILED',
              agentRun.id
            )
            break
          }

          // Apply KnowledgeBaseOnlyPolicy Grounding Validation
          if (citationMap.size > 0) {
            const validation = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
              stepResult.content,
              citationMap,
              'SUCCESS'
            )
            finalResponse = validation.sanitizedContent
            validatedCitations = validation.isValid ? validation.validCitations : []
          } else if (workspaceFiles.size > 0) {
            // Workspace task: verify no fake KB citations were invented
            const hasInventedCitations = /\[\d+\]/.test(stepResult.content)
            if (hasInventedCitations) {
              finalResponse = KnowledgeBaseOnlyPolicy.getUngroundedResponse()
              validatedCitations = []
            } else {
              finalResponse = stepResult.content
              validatedCitations = []
            }
          } else {
            // Zero KB context and zero workspace files: cannot answer from general training knowledge
            finalResponse = KnowledgeBaseOnlyPolicy.getNoResultsResponse()
            validatedCitations = []
          }
          break
        }

        // D. Process Tool Call
        if (stepResult.type === 'tool_call') {
          const rawToolCall = stepResult
          const toolCallId =
            typeof rawToolCall.toolCallId === 'string' && rawToolCall.toolCallId.trim().length > 0
              ? rawToolCall.toolCallId.trim()
              : randomUUID()

          const toolName =
            typeof rawToolCall.toolName === 'string' ? rawToolCall.toolName.trim() : ''
          const rawArguments = rawToolCall.rawArguments

          if (toolName.length === 0) {
            loopError = new BoundedAgentRuntimeError(
              'Tool call decision missing required toolName.',
              'STEP_EXECUTOR_FAILED',
              agentRun.id
            )
            break
          }

          // Record assistant toolCall in history
          history.push({
            role: 'assistant',
            toolCall: {
              toolCallId,
              toolName,
              rawArguments
            }
          })

          // Build safe arguments summary
          const normalizedName = normalizeToolName(toolName)
          let safeArgumentsSummary = '{}'
          try {
            if (rawArguments && typeof rawArguments === 'object') {
              const str = JSON.stringify(rawArguments)
              safeArgumentsSummary = str.length > 1024 ? str.slice(0, 1021) + '...' : str
              JSON.parse(safeArgumentsSummary)
            }
          } catch {
            safeArgumentsSummary = JSON.stringify({ tool: toolName })
          }

          const initialApprovalStatus: ToolApprovalStatus =
            normalizedName === 'save_report' ? 'pending_approval' : 'auto_approved'

          // Create ToolEvent in SQLite (status: 'pending')
          let toolEvent: ToolEventDto
          try {
            toolEvent = this.toolEventRepo.create({
              agentRunId: agentRun.id,
              toolName: normalizedName || toolName,
              initialStatus: 'pending',
              initialApprovalStatus,
              argumentsSummary: safeArgumentsSummary
            })
          } catch (err) {
            loopError = new BoundedAgentRuntimeError(
              `Failed to create tool event: ${err instanceof Error ? err.message : String(err)}`,
              'TOOL_VALIDATION_FAILED',
              agentRun.id
            )
            break
          }

          // Mark running immediately before execution
          this.toolEventRepo.updateStatus(toolEvent.id, 'running')
          activeToolEventId = toolEvent.id

          // Execute tool with ToolRegistry
          const isSaveReport = normalizedName === 'save_report'
          const effectiveTimeoutMs = isSaveReport ? approvalTimeoutMs : toolTimeoutMs

          let execResult: ToolExecutionResult<unknown>
          try {
            execResult = await this.executeToolWithTimeout(
              this.toolRegistry,
              {
                toolName,
                botId: bot.id,
                rawArguments,
                agentRunId: agentRun.id,
                signal: runAbortController.signal
              },
              effectiveTimeoutMs,
              runAbortController.signal
            )

            // Mark tool completed
            this.toolEventRepo.markCompleted(toolEvent.id, execResult.resultSummary)
            activeToolEventId = undefined

            // Track provenance
            this.recordProvenance(
              execResult.toolName,
              execResult.result,
              citationMap,
              workspaceFiles
            )

            // Format bounded tool output for next model iteration
            const formattedContent = this.formatToolResult(
              execResult.toolName,
              execResult.result,
              maxToolOutputBytes
            )

            history.push({
              role: 'tool',
              toolCallId,
              toolName: execResult.toolName,
              content: formattedContent
            })
          } catch (err) {
            activeToolEventId = undefined

            if (runAbortController.signal.aborted) {
              this.toolEventRepo.markCancelled(toolEvent.id)
              break
            }

            const safeMsg = sanitizeErrorForStorage(err)
            this.toolEventRepo.markFailed(toolEvent.id, safeMsg)

            // Map error to BoundedAgentRuntimeError
            let errorCode: BoundedAgentRuntimeErrorCode = 'TOOL_EXECUTION_FAILED'
            if (err instanceof ToolError) {
              if (err.code === 'TOOL_NOT_FOUND') errorCode = 'TOOL_NOT_FOUND'
              else if (err.code === 'PERMISSION_DENIED') errorCode = 'TOOL_PERMISSION_DENIED'
              else if (err.code === 'VALIDATION_FAILED') errorCode = 'TOOL_VALIDATION_FAILED'
              else if (err.code === 'ABORTED') errorCode = 'RUN_CANCELLED'
            } else if (err instanceof BoundedAgentRuntimeError) {
              errorCode = err.code
            }

            loopError = new BoundedAgentRuntimeError(
              `Tool '${toolName}' failed: ${safeMsg}`,
              errorCode,
              agentRun.id
            )
            break
          }
        }
      }

      // Check if max iterations reached without final response
      if (!loopError && finalResponse === undefined && !runAbortController.signal.aborted) {
        loopError = new BoundedAgentRuntimeError(
          `Maximum agent iterations (${effectiveMaxIterations}) exceeded without producing a final response.`,
          'MAX_ITERATIONS_EXCEEDED',
          agentRun.id
        )
      }

      // 11. Determine terminal status and persist
      const finalToolEvents = this.toolEventRepo.listByAgentRun(agentRun.id)
      const authenticCitations = Array.from(citationMap.values())
      const uniqueWorkspaceFiles = Array.from(workspaceFiles)

      if (runAbortController.signal.aborted) {
        if (activeToolEventId) {
          try {
            this.toolEventRepo.markCancelled(activeToolEventId)
          } catch {
            // Ignore
          }
        }
        this.agentRunRepo.markCancelled(agentRun.id)
        return {
          agentRunId: agentRun.id,
          botId: bot.id,
          knowledgeBaseId: bot.knowledgeBaseId,
          conversationId: request.conversationId ?? null,
          status: 'cancelled',
          iterationCount,
          errorSummary: 'Agent run cancelled.',
          toolEvents: this.toolEventRepo.listByAgentRun(agentRun.id),
          citations: authenticCitations,
          workspaceFiles: uniqueWorkspaceFiles
        }
      }

      if (loopError) {
        const errorSummary = sanitizeErrorForStorage(loopError.message)
        this.agentRunRepo.markFailed(agentRun.id, errorSummary)
        return {
          agentRunId: agentRun.id,
          botId: bot.id,
          knowledgeBaseId: bot.knowledgeBaseId,
          conversationId: request.conversationId ?? null,
          status: 'failed',
          iterationCount,
          errorSummary,
          toolEvents: finalToolEvents,
          citations: authenticCitations,
          workspaceFiles: uniqueWorkspaceFiles
        }
      }

      // Successful completion
      this.agentRunRepo.markCompleted(agentRun.id)
      return {
        agentRunId: agentRun.id,
        botId: bot.id,
        knowledgeBaseId: bot.knowledgeBaseId,
        conversationId: request.conversationId ?? null,
        status: 'completed',
        iterationCount,
        finalResponse,
        toolEvents: finalToolEvents,
        citations: validatedCitations,
        workspaceFiles: uniqueWorkspaceFiles
      }
    } finally {
      // 12. Cleanup all run-scoped resources
      if (activeRun.runTimer) {
        clearTimeout(activeRun.runTimer)
      }
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort)
      }
      unsubscribeApproval()

      // Cancel any remaining pending approvals for this run
      this.approvalController.cancelForRun(agentRun.id, 'Agent run concluded.')

      // Revoke ephemeral workspace folder authorization
      this.workspaceFolderService.revoke(agentRun.id)

      // Unregister active run controller
      this.activeRuns.delete(agentRun.id)
    }
  }

  /**
   * Cancels an active agent run by agentRunId.
   * Safe and idempotent if the run is already finished or non-existent.
   */
  public cancelRun(agentRunId: string, reason?: string): boolean {
    const active = this.activeRuns.get(agentRunId)
    if (!active) {
      return false
    }

    active.abortController.abort(reason ?? 'Agent run cancelled by user.')
    return true
  }

  /**
   * Checks whether an agent run is currently executing in memory.
   */
  public isRunActive(agentRunId: string): boolean {
    return this.activeRuns.has(agentRunId)
  }

  // ==========================================================================
  // Private Orchestration Helpers
  // ==========================================================================

  private async executeStepWithTimeout(
    executor: AgentModelStepExecutor,
    request: AgentModelStepRequest,
    timeoutMs: number,
    parentSignal?: AbortSignal
  ): Promise<AgentModelStepResult> {
    const stepAbortController = new AbortController()

    const onParentAbort = (): void => {
      stepAbortController.abort(parentSignal?.reason ?? 'Parent operation aborted.')
    }

    if (parentSignal) {
      if (parentSignal.aborted) {
        stepAbortController.abort(parentSignal.reason)
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true })
      }
    }

    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          stepAbortController.abort('Model step timeout.')
          reject(
            new BoundedAgentRuntimeError(
              `Model step timed out after ${timeoutMs}ms.`,
              'MODEL_STEP_TIMEOUT',
              request.agentRunId
            )
          )
        }, timeoutMs)
      }
    })

    try {
      const stepRequest: AgentModelStepRequest = {
        ...request,
        signal: stepAbortController.signal
      }
      const result = await Promise.race([executor.executeStep(stepRequest), timeoutPromise])
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  private async executeToolWithTimeout(
    registry: ToolRegistry,
    options: ExecuteToolOptions,
    timeoutMs: number,
    parentSignal?: AbortSignal
  ): Promise<ToolExecutionResult<unknown>> {
    const toolAbortController = new AbortController()

    const onParentAbort = (): void => {
      toolAbortController.abort(parentSignal?.reason ?? 'Parent operation aborted.')
    }

    if (parentSignal) {
      if (parentSignal.aborted) {
        toolAbortController.abort(parentSignal.reason)
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true })
      }
    }

    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          toolAbortController.abort('Tool execution timeout.')
          reject(
            new BoundedAgentRuntimeError(
              `Tool '${options.toolName}' execution timed out after ${timeoutMs}ms.`,
              'TOOL_TIMEOUT',
              options.agentRunId
            )
          )
        }, timeoutMs)
      }
    })

    try {
      const execOptions: ExecuteToolOptions = {
        ...options,
        signal: toolAbortController.signal
      }
      const result = await Promise.race([registry.execute(execOptions), timeoutPromise])
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  private estimateHistoryTokens(history: readonly AgentMessage[]): number {
    let total = 0
    for (const msg of history) {
      total += 4 // Framing overhead per message
      if (msg.role === 'system' || msg.role === 'user') {
        total += estimateTokenCount(msg.content)
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          total += estimateTokenCount(msg.content)
        }
        if (msg.toolCall) {
          total += estimateTokenCount(msg.toolCall.toolName)
          try {
            total += estimateTokenCount(JSON.stringify(msg.toolCall.rawArguments))
          } catch {
            total += 10
          }
        }
      } else if (msg.role === 'tool') {
        total += estimateTokenCount(msg.content)
      }
    }
    return total
  }

  private recordProvenance(
    toolName: string,
    result: unknown,
    citationMap: Map<number, CitationDto>,
    workspaceFiles: Set<string>
  ): void {
    if (!result || typeof result !== 'object') {
      return
    }

    // 1. search_knowledge_base provenance
    if (toolName === 'search_knowledge_base') {
      const searchRes = result as { citations?: readonly CitationDto[] }
      if (Array.isArray(searchRes.citations)) {
        for (const citation of searchRes.citations) {
          if (citation && typeof citation.citationNumber === 'number') {
            citationMap.set(citation.citationNumber, citation)
          }
        }
      }
    }

    // 2. read_knowledge_source provenance
    if (toolName === 'read_knowledge_source') {
      const readRes = result as {
        sourceId?: string
        documentName?: string
        fileType?: string
        chunks?: readonly {
          chunkId: string
          chunkIndex: number
          pageNumber: number | null
          heading: string | null
          headingPath: readonly string[] | null
        }[]
      }

      if (readRes.sourceId && readRes.documentName && Array.isArray(readRes.chunks)) {
        for (const chunk of readRes.chunks) {
          // Assign next available citation index if not already present
          let existingNumber: number | undefined
          for (const [num, cit] of citationMap.entries()) {
            if (cit.sourceId === readRes.sourceId && cit.chunkId === chunk.chunkId) {
              existingNumber = num
              break
            }
          }

          if (existingNumber === undefined) {
            let nextIndex = 1
            while (citationMap.has(nextIndex)) {
              nextIndex++
            }
            citationMap.set(nextIndex, {
              citationNumber: nextIndex,
              sourceId: readRes.sourceId,
              chunkId: chunk.chunkId,
              fileName: readRes.documentName,
              fileType: (readRes.fileType === 'pdf' || readRes.fileType === 'md'
                ? readRes.fileType
                : 'txt') as 'txt' | 'md' | 'pdf',
              pageNumber: chunk.pageNumber ?? null,
              headingPath: chunk.headingPath ?? (chunk.heading ? [chunk.heading] : null),
              chunkIndex: chunk.chunkIndex
            })
          }
        }
      }
    }

    // 3. search_workspace_files provenance
    if (toolName === 'search_workspace_files') {
      const wsSearch = result as { matches?: readonly { relativePath: string }[] }
      if (Array.isArray(wsSearch.matches)) {
        for (const m of wsSearch.matches) {
          if (m && typeof m.relativePath === 'string') {
            workspaceFiles.add(m.relativePath)
          }
        }
      }
    }

    // 4. read_workspace_file provenance
    if (toolName === 'read_workspace_file') {
      const wsRead = result as { relativePath?: string }
      if (wsRead && typeof wsRead.relativePath === 'string') {
        workspaceFiles.add(wsRead.relativePath)
      }
    }
  }

  private formatToolResult(toolName: string, result: unknown, maxBytes: number): string {
    let formatted: string

    if (toolName === 'search_knowledge_base') {
      const searchRes = result as {
        status?: string
        totalResults?: number
        excerpts?: readonly {
          citationNumber: number
          documentName: string
          chunkIndex: number
          content: string
        }[]
      }

      if (searchRes.status === 'NO_RESULTS') {
        formatted = 'No matching excerpts found in the Knowledge Base.'
      } else if (Array.isArray(searchRes.excerpts) && searchRes.excerpts.length > 0) {
        const lines: string[] = [`Found ${searchRes.excerpts.length} excerpt(s) in Knowledge Base:`]
        for (const e of searchRes.excerpts) {
          lines.push(
            `\n[${e.citationNumber}] "${e.documentName}" (Chunk ${e.chunkIndex}):\n<retrieved_context>\n${e.content}\n</retrieved_context>`
          )
        }
        formatted = lines.join('\n')
      } else {
        formatted = JSON.stringify(result)
      }
    } else if (toolName === 'read_knowledge_source') {
      const readRes = result as {
        documentName?: string
        chunks?: readonly {
          chunkIndex: number
          content: string
        }[]
      }
      if (Array.isArray(readRes.chunks)) {
        const lines: string[] = [`Knowledge Source: "${readRes.documentName ?? 'Document'}"`]
        for (const c of readRes.chunks) {
          lines.push(
            `\nChunk ${c.chunkIndex}:\n<retrieved_context>\n${c.content}\n</retrieved_context>`
          )
        }
        formatted = lines.join('\n')
      } else {
        formatted = JSON.stringify(result)
      }
    } else {
      try {
        formatted = JSON.stringify(result, null, 2)
      } catch {
        formatted = String(result)
      }
    }

    if (Buffer.byteLength(formatted, 'utf-8') > maxBytes) {
      formatted =
        formatted.slice(0, Math.floor(maxBytes / 2)) + '\n... [Tool output truncated due to size]'
    }

    return formatted
  }
}
