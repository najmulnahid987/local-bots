import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { idSchema } from '../database/repositories/types'
import {
  type MessageDto,
  type CitationDto,
  type MessageToolCallDto,
  MAX_MESSAGE_CONTENT_LENGTH
} from '../../shared/conversations'
import { type ToolEventDto, CANONICAL_BOT_TOOLS, isBotToolEnabled } from '../../shared/agents'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { ConversationRepository } from '../database/repositories/conversation-repository'
import type { MessageRepository } from '../database/repositories/message-repository'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import type { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import type { CredentialVault } from '../security/credential-vault'
import {
  BoundedAgentRuntime,
  type BoundedAgentRunOptions,
  type BoundedAgentRunResult
} from './bounded-agent-runtime'
import type { AgentMessage } from '../agents/agent-model-step-executor'
import type { ToolRegistry } from '../tools/tool-registry'
import type { ApprovalController } from './approval-controller'
import type { WorkspaceFolderService, BrowserWindowLike } from './workspace-folder-service'
import type { BrowserWindow } from 'electron'
import type { ActiveWorkspaceContext, SessionId } from './active-workspace-context'
import type { ConversationTurnService } from './conversation-turn-service'
import { providerRegistry } from '../providers/provider-registry'
import { KnowledgeBaseOnlyPolicy } from './knowledge-base-only-policy'
import { estimateTokenCount } from '../documents/chunking/semantic-chunker'

// ============================================================================
// Error Hierarchy
// ============================================================================

export type AgentTaskErrorCode =
  | 'INVALID_INPUT'
  | 'NO_ACTIVE_WORKSPACE'
  | 'KB_NOT_FOUND'
  | 'KB_ARCHIVED'
  | 'BOT_NOT_FOUND'
  | 'BOT_ARCHIVED'
  | 'BOT_KB_MISMATCH'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ARCHIVED'
  | 'CONVERSATION_MISMATCH'
  | 'PROVIDER_CONNECTION_NOT_FOUND'
  | 'CREDENTIALS_NOT_FOUND'
  | 'MODEL_NOT_SUPPORTED'
  | 'NO_ENABLED_TOOLS'
  | 'CONCURRENT_TASK_ACTIVE'
  | 'TASK_CANCELLED'
  | 'TASK_EXECUTION_FAILED'
  | 'PERSISTENCE_FAILED'

export class AgentTaskError extends Error {
  public readonly code: AgentTaskErrorCode
  public readonly agentRunId?: string

  constructor(message: string, code: AgentTaskErrorCode, agentRunId?: string) {
    super(message)
    this.name = 'AgentTaskError'
    this.code = code
    this.agentRunId = agentRunId
    Object.setPrototypeOf(this, AgentTaskError.prototype)
  }
}

// ============================================================================
// Request & Outcome Contracts
// ============================================================================

export interface AgentTaskRequest {
  readonly botId: string
  readonly conversationId: string
  readonly taskContent: string
  readonly executionMode?: 'agent'
}

export const agentTaskRequestSchema = z
  .object({
    botId: idSchema,
    conversationId: idSchema,
    taskContent: z
      .string()
      .trim()
      .min(1, { message: 'Task content cannot be blank.' })
      .max(MAX_MESSAGE_CONTENT_LENGTH, {
        message: `Task content cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`
      }),
    executionMode: z.literal('agent').optional().default('agent')
  })
  .strict()

export interface AgentTaskExecutionOptions {
  readonly agentRunId?: string
  readonly signal?: AbortSignal
  readonly maxIterations?: number
  readonly workspaceWindow?: BrowserWindowLike | BrowserWindow
  readonly onEvent?: (event: import('./bounded-agent-runtime').AgentRuntimeEvent) => void
  readonly runtimeOptions?: BoundedAgentRunOptions
}

export interface KnowledgeBaseEvidenceItem {
  readonly knowledgeBaseId: string
  readonly sourceId: string
  readonly chunkId: string
  readonly citationNumber: number
  readonly fileName: string
  readonly pageNumber: number | null
  readonly chunkIndex: number
}

export interface WorkspaceEvidenceItem {
  readonly relativePath: string
  readonly toolName: 'search_workspace_files' | 'read_workspace_file'
  readonly toolEventId?: string
}

export interface AgentTaskEvidence {
  readonly agentRunId: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly kbEvidence: readonly KnowledgeBaseEvidenceItem[]
  readonly workspaceEvidence: readonly WorkspaceEvidenceItem[]
  readonly toolEventIds: readonly string[]
  readonly hasEvidence: boolean
}

export interface AgentTaskOutcome {
  readonly success: boolean
  readonly agentRunId: string
  readonly conversationId: string
  readonly runStatus: 'completed' | 'failed' | 'cancelled'
  readonly userMessage?: MessageDto
  readonly assistantMessage?: MessageDto
  readonly finalResponse?: string
  readonly toolEvents: readonly ToolEventDto[]
  readonly citations: readonly CitationDto[]
  readonly workspaceFiles: readonly string[]
  readonly evidence: AgentTaskEvidence
  readonly errorCode?: AgentTaskErrorCode
  readonly errorMessage?: string
}

interface ActiveTask {
  readonly agentRunId: string
  readonly botId: string
  readonly conversationId: string
  readonly abortController: AbortController
  readonly startedAt: number
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface AgentTaskServiceDependencies {
  readonly botRepository: BotRepository
  readonly conversationRepository: ConversationRepository
  readonly messageRepository: MessageRepository
  readonly knowledgeBaseRepository: KnowledgeBaseRepository
  readonly providerConnectionRepository: ProviderConnectionRepository
  readonly credentialVault: CredentialVault
  readonly boundedAgentRuntime: BoundedAgentRuntime
  readonly toolRegistry: ToolRegistry
  readonly approvalController: ApprovalController
  readonly workspaceFolderService: WorkspaceFolderService
  readonly activeWorkspaceContext?: ActiveWorkspaceContext
  readonly turnService?: ConversationTurnService
}

// ============================================================================
// Helper Utilities
// ============================================================================

export function mapToolEventsToMessageToolCalls(
  events: readonly ToolEventDto[]
): MessageToolCallDto[] {
  return events.map((e) => ({
    id: e.id,
    toolName: e.toolName,
    status: e.status,
    argumentsSummary: e.argumentsSummary,
    resultSummary: e.resultSummary,
    errorMessage: e.errorMessage
  }))
}

export function formatConversationHistory(messages: readonly MessageDto[]): AgentMessage[] {
  const result: AgentMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      result.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.metadata?.toolCalls && m.metadata.toolCalls.length > 0) {
        const firstTc = m.metadata.toolCalls[0]
        let rawArgs: unknown
        try {
          rawArgs = firstTc.argumentsSummary ? JSON.parse(firstTc.argumentsSummary) : {}
        } catch {
          rawArgs = {}
        }
        result.push({
          role: 'assistant',
          content: m.content || undefined,
          toolCall: {
            toolCallId: firstTc.id,
            toolName: firstTc.toolName,
            rawArguments: rawArgs
          }
        })
        result.push({
          role: 'tool',
          toolCallId: firstTc.id,
          toolName: firstTc.toolName,
          content: firstTc.resultSummary ?? '',
          isError: firstTc.status === 'failed'
        })
      } else {
        result.push({ role: 'assistant', content: m.content })
      }
    }
  }
  return result
}

export function trimHistoryToBudget(
  history: readonly AgentMessage[],
  maxTokens: number
): AgentMessage[] {
  if (history.length === 0) return []
  let totalTokens = 0
  for (const msg of history) {
    totalTokens += estimateTokenCount(msg.content ?? '')
  }
  if (totalTokens <= maxTokens) {
    return [...history]
  }
  const trimmed = [...history]
  while (trimmed.length > 0 && totalTokens > maxTokens) {
    const removed = trimmed.shift()
    if (removed) {
      totalTokens -= estimateTokenCount(removed.content ?? '')
    }
  }
  return trimmed
}

// ============================================================================
// AgentTaskService Implementation
// ============================================================================

/**
 * Privileged Main-process service orchestrating explicit user agent tasks:
 * - Authoritative Bot and Conversation resolution
 * - Strict separation from normal chat turns
 * - Pre-flight capability and tool permission checks
 * - In-memory conversation locking & concurrency guard
 * - User task and final assistant message persistence
 * - Distinct KB vs. workspace evidence provenance tracking
 * - Bounded multi-step runtime execution
 * - Clean cancellation and resource cleanup
 */
export class AgentTaskService {
  private readonly botRepo: BotRepository
  private readonly convRepo: ConversationRepository
  private readonly messageRepo: MessageRepository
  private readonly kbRepo: KnowledgeBaseRepository
  private readonly providerConnRepo: ProviderConnectionRepository
  private readonly credentialVault: CredentialVault
  private readonly runtime: BoundedAgentRuntime
  private readonly toolRegistry: ToolRegistry
  private readonly approvalController: ApprovalController
  private readonly workspaceFolderService: WorkspaceFolderService
  private readonly activeWorkspaceContext?: ActiveWorkspaceContext
  private readonly turnService?: ConversationTurnService

  private readonly activeTasks = new Map<string, ActiveTask>() // keyed by agentRunId
  private readonly activeTasksByConversation = new Map<string, string>() // conversationId -> agentRunId

  constructor(deps: AgentTaskServiceDependencies) {
    if (
      !deps ||
      !deps.botRepository ||
      !deps.conversationRepository ||
      !deps.messageRepository ||
      !deps.knowledgeBaseRepository ||
      !deps.providerConnectionRepository ||
      !deps.credentialVault ||
      !deps.boundedAgentRuntime ||
      !deps.toolRegistry ||
      !deps.approvalController ||
      !deps.workspaceFolderService
    ) {
      throw new AgentTaskError(
        'All primary repositories and services are required for AgentTaskService.',
        'INVALID_INPUT'
      )
    }

    this.botRepo = deps.botRepository
    this.convRepo = deps.conversationRepository
    this.messageRepo = deps.messageRepository
    this.kbRepo = deps.knowledgeBaseRepository
    this.providerConnRepo = deps.providerConnectionRepository
    this.credentialVault = deps.credentialVault
    this.runtime = deps.boundedAgentRuntime
    this.toolRegistry = deps.toolRegistry
    this.approvalController = deps.approvalController
    this.workspaceFolderService = deps.workspaceFolderService
    this.activeWorkspaceContext = deps.activeWorkspaceContext
    this.turnService = deps.turnService
  }

  /**
   * Dispatches an explicitly requested agent task on an authorized Bot and conversation.
   */
  public async dispatchTask(
    sessionId: SessionId | undefined,
    request: AgentTaskRequest,
    options?: AgentTaskExecutionOptions
  ): Promise<AgentTaskOutcome> {
    // 1. Validate request shape
    const parsed = agentTaskRequestSchema.safeParse(request)
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join('; ')
      throw new AgentTaskError(`Invalid task request: ${msg}`, 'INVALID_INPUT')
    }
    const validatedRequest = parsed.data

    // 2. Early cancellation check
    if (options?.signal?.aborted) {
      throw new AgentTaskError('Task dispatch cancelled by caller.', 'TASK_CANCELLED')
    }

    // 3. Authoritative active KB check if session is provided
    let activeKbId: string | undefined
    if (this.activeWorkspaceContext && sessionId !== undefined) {
      try {
        activeKbId = this.activeWorkspaceContext.getActiveWorkspaceId(sessionId)
      } catch (err) {
        throw new AgentTaskError(
          `No active workspace for session: ${err instanceof Error ? err.message : String(err)}`,
          'NO_ACTIVE_WORKSPACE'
        )
      }

      const activeKb = this.kbRepo.getById(activeKbId)
      if (!activeKb) {
        throw new AgentTaskError(`Active Knowledge Base '${activeKbId}' not found.`, 'KB_NOT_FOUND')
      }
      if (activeKb.archived_at !== null) {
        throw new AgentTaskError(
          `Active Knowledge Base '${activeKb.name}' is archived.`,
          'KB_ARCHIVED'
        )
      }
    }

    // 4. Resolve Bot
    const bot = this.botRepo.getByIdOnly(validatedRequest.botId)
    if (!bot) {
      throw new AgentTaskError(
        `Bot with ID '${validatedRequest.botId}' not found.`,
        'BOT_NOT_FOUND'
      )
    }
    if (bot.status === 'archived') {
      throw new AgentTaskError(`Bot '${bot.name}' is archived.`, 'BOT_ARCHIVED')
    }
    if (activeKbId && bot.knowledgeBaseId !== activeKbId) {
      throw new AgentTaskError(
        `Bot '${bot.id}' does not belong to the active Knowledge Base '${activeKbId}'.`,
        'BOT_KB_MISMATCH'
      )
    }

    // 5. Verify parent Knowledge Base
    const parentKb = this.kbRepo.getById(bot.knowledgeBaseId)
    if (!parentKb) {
      throw new AgentTaskError(
        `Parent Knowledge Base '${bot.knowledgeBaseId}' not found for Bot '${bot.name}'.`,
        'KB_NOT_FOUND'
      )
    }
    if (parentKb.archived_at !== null) {
      throw new AgentTaskError(
        `Parent Knowledge Base '${parentKb.name}' is archived.`,
        'KB_ARCHIVED'
      )
    }

    // 6. Resolve Conversation
    const conversation = this.convRepo.getByIdOnly(validatedRequest.conversationId)
    if (!conversation) {
      throw new AgentTaskError(
        `Conversation '${validatedRequest.conversationId}' not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }
    if (conversation.archivedAt !== null) {
      throw new AgentTaskError(
        `Conversation '${conversation.title}' is archived and cannot receive tasks.`,
        'CONVERSATION_ARCHIVED'
      )
    }
    if (conversation.botId !== bot.id) {
      throw new AgentTaskError(
        `Conversation '${conversation.id}' belongs to Bot '${conversation.botId}', not requested Bot '${bot.id}'.`,
        'CONVERSATION_MISMATCH'
      )
    }
    if (conversation.knowledgeBaseId !== bot.knowledgeBaseId) {
      throw new AgentTaskError(
        `Conversation '${conversation.id}' belongs to Knowledge Base '${conversation.knowledgeBaseId}', not Bot parent KB '${bot.knowledgeBaseId}'.`,
        'CONVERSATION_MISMATCH'
      )
    }

    // 7. Verify Bot Tool Permissions
    const enabledCanonical = CANONICAL_BOT_TOOLS.filter((t) =>
      isBotToolEnabled(bot.toolPermissions, t)
    )
    if (enabledCanonical.length === 0) {
      throw new AgentTaskError(
        `Bot '${bot.name}' has no enabled Phase 8 tools. Cannot dispatch an agent task.`,
        'NO_ENABLED_TOOLS'
      )
    }

    // 8. Verify Provider Connection & Model Native Tool Calling Capability
    if (!bot.providerConnectionId) {
      throw new AgentTaskError(
        `Bot '${bot.name}' has no configured provider connection.`,
        'PROVIDER_CONNECTION_NOT_FOUND'
      )
    }
    const connection = this.providerConnRepo.getById(bot.providerConnectionId)
    if (!connection) {
      throw new AgentTaskError(
        `Provider connection '${bot.providerConnectionId}' not found for Bot '${bot.name}'.`,
        'PROVIDER_CONNECTION_NOT_FOUND'
      )
    }
    if (!connection.credentialRef) {
      throw new AgentTaskError(
        `Provider connection '${connection.id}' has no stored credential reference.`,
        'CREDENTIALS_NOT_FOUND'
      )
    }

    const targetModelId = bot.modelId ?? connection.providerId
    const modelMeta = providerRegistry.getModel(connection.providerId, targetModelId)
    if (!modelMeta || modelMeta.providerCapabilities?.tools !== true) {
      throw new AgentTaskError(
        `Model '${targetModelId}' on provider '${connection.providerId}' does not support native tool calling.`,
        'MODEL_NOT_SUPPORTED'
      )
    }

    // 9. Concurrency Lock Acquisition (synchronous before any async operation)
    if (this.turnService) {
      try {
        this.turnService.acquireAgentTaskLock(conversation.id)
      } catch (err) {
        throw new AgentTaskError(
          `Conversation '${conversation.id}' is busy with active generation or deletion: ${err instanceof Error ? err.message : String(err)}`,
          'CONCURRENT_TASK_ACTIVE'
        )
      }
    } else {
      if (this.activeTasksByConversation.has(conversation.id)) {
        throw new AgentTaskError(
          `An agent task is already in progress for conversation '${conversation.id}'.`,
          'CONCURRENT_TASK_ACTIVE'
        )
      }
      this.activeTasksByConversation.set(conversation.id, 'pending')
    }

    const agentRunId = options?.agentRunId ?? randomUUID()
    const taskAbortController = new AbortController()

    let onCallerAbort: (() => void) | undefined
    if (options?.signal) {
      onCallerAbort = (): void => {
        taskAbortController.abort('Task cancelled by client signal.')
      }
      options.signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    this.activeTasks.set(agentRunId, {
      agentRunId,
      botId: bot.id,
      conversationId: conversation.id,
      abortController: taskAbortController,
      startedAt: Date.now()
    })
    this.activeTasksByConversation.set(conversation.id, agentRunId)

    let userMessage: MessageDto | undefined

    try {
      if (taskAbortController.signal.aborted) {
        throw new AgentTaskError('Task cancelled before execution.', 'TASK_CANCELLED', agentRunId)
      }

      // 10. Verify Stored Credentials
      try {
        await this.credentialVault.retrieve(connection.credentialRef)
      } catch {
        throw new AgentTaskError(
          `API key credentials not found or unreadable for provider connection '${connection.id}'.`,
          'CREDENTIALS_NOT_FOUND'
        )
      }

      // 11. Prepare Conversation History
      const existingHistory = this.messageRepo.listByConversation(
        conversation.id,
        bot.id,
        bot.knowledgeBaseId
      )
      const formattedHistory = formatConversationHistory(existingHistory)
      const contextBudgetTokens = 32_000 // history limit budget
      const initialHistory = trimHistoryToBudget(formattedHistory, contextBudgetTokens)

      // 12. Persist User Task Message in SQLite before calling runtime
      try {
        userMessage = this.messageRepo.create({
          conversationId: conversation.id,
          botId: bot.id,
          knowledgeBaseId: bot.knowledgeBaseId,
          role: 'user',
          content: validatedRequest.taskContent,
          contentFormat: 'markdown',
          metadata: {
            executionMode: 'agent'
          }
        })
      } catch (persistErr) {
        throw new AgentTaskError(
          `Failed to persist user task: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          'PERSISTENCE_FAILED',
          agentRunId
        )
      }

      if (taskAbortController.signal.aborted) {
        throw new AgentTaskError(
          'Task cancelled after user persistence.',
          'TASK_CANCELLED',
          agentRunId
        )
      }

      // 13. Workspace Folder Authorization Prompt if requested and not already granted
      if (options?.workspaceWindow && !this.workspaceFolderService.hasGrant(agentRunId, bot.id)) {
        try {
          await this.workspaceFolderService.requestWorkspaceAuthorization(
            options.workspaceWindow,
            agentRunId,
            bot.id
          )
        } catch {
          // If prompt cancelled or fails, proceed without grant; workspace tools will safely reject
        }
      }

      // 14. Execute BoundedAgentRuntime
      const effectiveRuntimeOptions: BoundedAgentRunOptions = {
        ...options?.runtimeOptions,
        onEvent: options?.onEvent ?? options?.runtimeOptions?.onEvent
      }

      const runResult = await this.runtime.run(
        {
          id: agentRunId,
          botId: bot.id,
          conversationId: conversation.id,
          task: validatedRequest.taskContent,
          selectedModel: targetModelId,
          signal: taskAbortController.signal,
          maxIterations: options?.maxIterations,
          initialHistory
        },
        effectiveRuntimeOptions
      )

      // 15. Build Evidence Provenance
      const evidence = this.buildEvidence(runResult, bot.id, bot.knowledgeBaseId)

      // 16. Process Outcomes
      if (taskAbortController.signal.aborted || runResult.status === 'cancelled') {
        return {
          success: false,
          agentRunId: runResult.agentRunId,
          conversationId: conversation.id,
          runStatus: 'cancelled',
          userMessage,
          errorCode: 'TASK_CANCELLED',
          errorMessage: runResult.errorSummary ?? 'Agent task was cancelled.',
          toolEvents: runResult.toolEvents,
          citations: runResult.citations,
          workspaceFiles: runResult.workspaceFiles,
          evidence
        }
      }

      if (runResult.status === 'completed') {
        const finalContent = this.validateAndSanitizeResponse(
          runResult.finalResponse ?? '',
          evidence
        )

        // Persist final assistant response
        let assistantMessage: MessageDto
        try {
          assistantMessage = this.messageRepo.create({
            conversationId: conversation.id,
            botId: bot.id,
            knowledgeBaseId: bot.knowledgeBaseId,
            role: 'assistant',
            content: finalContent,
            contentFormat: 'markdown',
            metadata: {
              providerId: connection.providerId,
              modelId: targetModelId,
              citations: runResult.citations,
              toolCalls: mapToolEventsToMessageToolCalls(runResult.toolEvents),
              agentRunId: runResult.agentRunId,
              executionMode: 'agent',
              generation: {
                finishReason: 'stop'
              }
            }
          })
        } catch (persistErr) {
          throw new AgentTaskError(
            `Failed to persist assistant response: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            'PERSISTENCE_FAILED',
            agentRunId
          )
        }

        return {
          success: true,
          agentRunId: runResult.agentRunId,
          conversationId: conversation.id,
          runStatus: 'completed',
          userMessage,
          assistantMessage,
          finalResponse: finalContent,
          toolEvents: runResult.toolEvents,
          citations: runResult.citations,
          workspaceFiles: runResult.workspaceFiles,
          evidence
        }
      } else {
        return {
          success: false,
          agentRunId: runResult.agentRunId,
          conversationId: conversation.id,
          runStatus: 'failed',
          userMessage,
          errorCode: 'TASK_EXECUTION_FAILED',
          errorMessage: runResult.errorSummary ?? 'Agent task execution failed.',
          toolEvents: runResult.toolEvents,
          citations: runResult.citations,
          workspaceFiles: runResult.workspaceFiles,
          evidence
        }
      }
    } finally {
      if (options?.signal && onCallerAbort) {
        options.signal.removeEventListener('abort', onCallerAbort)
      }
      this.activeTasks.delete(agentRunId)
      this.activeTasksByConversation.delete(conversation.id)

      if (this.turnService) {
        this.turnService.releaseAgentTaskLock(conversation.id)
      }

      this.workspaceFolderService.revoke(agentRunId)
    }
  }

  /**
   * Returns the ToolRegistry instance.
   */
  public getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  /**
   * Cancels an active agent task by its agentRunId.
   */
  public cancelTask(agentRunId: string, reason?: string): boolean {
    const active = this.activeTasks.get(agentRunId)
    if (!active) {
      return false
    }

    active.abortController.abort(reason ?? 'Agent task cancelled by user.')
    this.runtime.cancelRun(agentRunId, reason)
    this.approvalController.cancelForRun(agentRunId, reason)
    this.workspaceFolderService.revoke(agentRunId)
    return true
  }

  /**
   * Cancels an active agent task by its conversationId.
   */
  public cancelTaskByConversation(conversationId: string, reason?: string): boolean {
    const runId = this.activeTasksByConversation.get(conversationId)
    if (!runId) {
      return false
    }
    return this.cancelTask(runId, reason)
  }

  /**
   * Checks whether a conversation currently has an active agent task running.
   */
  public isTaskActive(conversationId: string): boolean {
    return this.activeTasksByConversation.has(conversationId)
  }

  /**
   * Checks whether an agent run is currently executing.
   */
  public isRunActive(agentRunId: string): boolean {
    return this.activeTasks.has(agentRunId)
  }

  /**
   * Returns the active agentRunId for a conversation, if any.
   */
  public getActiveRunId(conversationId: string): string | undefined {
    return this.activeTasksByConversation.get(conversationId)
  }

  // ==========================================================================
  // Private Evidence & Response Validation
  // ==========================================================================

  private buildEvidence(
    runResult: BoundedAgentRunResult,
    botId: string,
    knowledgeBaseId: string
  ): AgentTaskEvidence {
    const kbEvidence: KnowledgeBaseEvidenceItem[] = runResult.citations.map((c) => ({
      knowledgeBaseId,
      sourceId: c.sourceId,
      chunkId: c.chunkId,
      citationNumber: c.citationNumber,
      fileName: c.fileName,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex
    }))

    const workspaceEvidence: WorkspaceEvidenceItem[] = []
    for (const evt of runResult.toolEvents) {
      if (evt.toolName === 'search_workspace_files' || evt.toolName === 'read_workspace_file') {
        workspaceEvidence.push({
          relativePath: evt.argumentsSummary,
          toolName: evt.toolName as 'search_workspace_files' | 'read_workspace_file',
          toolEventId: evt.id
        })
      }
    }

    const hasEvidence = kbEvidence.length > 0 || runResult.workspaceFiles.length > 0

    return {
      agentRunId: runResult.agentRunId,
      botId,
      knowledgeBaseId,
      kbEvidence,
      workspaceEvidence,
      toolEventIds: runResult.toolEvents.map((e) => e.id),
      hasEvidence
    }
  }

  private validateAndSanitizeResponse(response: string, evidence: AgentTaskEvidence): string {
    // 1. Zero evidence: cannot answer from general training knowledge
    if (!evidence.hasEvidence) {
      return KnowledgeBaseOnlyPolicy.getNoResultsResponse()
    }

    // 2. Workspace evidence only (0 KB evidence):
    // Must not contain fake KB citation markers (e.g. [1], [2])
    if (evidence.kbEvidence.length === 0 && evidence.workspaceEvidence.length > 0) {
      if (/\[\d+\]/.test(response)) {
        return KnowledgeBaseOnlyPolicy.getUngroundedResponse()
      }
      return response
    }

    // 3. Knowledge Base evidence present:
    // Validate grounded response against authentic citationMap
    if (evidence.kbEvidence.length > 0) {
      const citationMap = new Map<number, CitationDto>()
      for (const item of evidence.kbEvidence) {
        citationMap.set(item.citationNumber, {
          citationNumber: item.citationNumber,
          sourceId: item.sourceId,
          chunkId: item.chunkId,
          fileName: item.fileName,
          fileType: 'txt',
          pageNumber: item.pageNumber,
          headingPath: null,
          chunkIndex: item.chunkIndex
        })
      }
      const validation = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        response,
        citationMap,
        'SUCCESS'
      )
      return validation.sanitizedContent
    }

    return response
  }
}
