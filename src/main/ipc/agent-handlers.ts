import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  AGENT_IPC_CHANNELS,
  isBotToolEnabled,
  CANONICAL_BOT_TOOLS,
  type DispatchAgentTaskResponse,
  type CancelAgentTaskResponse,
  type GetAgentRunResponse,
  type ListAgentRunsResponse,
  type ListToolEventsResponse,
  type ApprovalDetailsDto,
  type RespondToApprovalResponse
} from '../../shared/agents'
import { AgentTaskService, AgentTaskError } from '../services/agent-task-service'
import { AgentStreamManager } from './agent-stream-manager'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import { providerRegistry } from '../providers/provider-registry'
import {
  validateAgentIpcPayload,
  formatAgentIpcError,
  sanitizeAgentErrorMessage,
  dispatchAgentTaskRequestSchema,
  cancelAgentTaskRequestSchema,
  getAgentRunRequestSchema,
  listAgentRunsRequestSchema,
  listToolEventsRequestSchema,
  getApprovalDetailsRequestSchema,
  respondToApprovalRequestSchema
} from './agent-validation'
import { attachSessionCleanup, type DestroyableSenderLike } from './bot-handlers'
import { type WebFrameWithPostMessage } from './provider-stream-manager'
import type { AgentRunRepository } from '../database/repositories/agent-run-repository'
import type { ToolEventRepository } from '../database/repositories/tool-event-repository'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { ConversationRepository } from '../database/repositories/conversation-repository'
import type { ApprovalController } from '../services/approval-controller'
import type { WorkspaceFolderService } from '../services/workspace-folder-service'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import type { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'

export interface AgentIpcHandlerOptions {
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  agentTaskService: AgentTaskService
  agentStreamManager?: AgentStreamManager
  agentRunRepository: AgentRunRepository
  toolEventRepository: ToolEventRepository
  botRepository: BotRepository
  conversationRepository: ConversationRepository
  approvalController: ApprovalController
  workspaceFolderService: WorkspaceFolderService
  activeContext?: ActiveWorkspaceContext
  knowledgeBaseRepository?: KnowledgeBaseRepository
  providerConnectionRepository?: ProviderConnectionRepository
}

/**
 * Registers secure, type-safe Main process IPC handlers for agent task dispatch,
 * cancellation, execution monitoring, tool event queries, approvals, and streaming.
 *
 * Invariants enforced on every invocation:
 * 1. IPC sender and frame validation (rejects untrusted windows, child frames, popups).
 * 2. Active workspace resolution strictly from sender session (rejects client-provided KB IDs).
 * 3. Strict schema validation rejecting unauthorized fields and mutations.
 * 4. Scoped cancellation restricted strictly to the requesting window.
 * 5. Native folder authorization controlled exclusively by Main process.
 */
export function registerAgentIpcHandlers(options: AgentIpcHandlerOptions): void {
  const {
    getMainWindow,
    agentTaskService,
    agentRunRepository,
    toolEventRepository,
    botRepository,
    conversationRepository,
    approvalController,
    workspaceFolderService,
    activeContext
  } = options

  const streamManager = options.agentStreamManager ?? new AgentStreamManager()

  const assertAuthorizedSender = (
    event: IpcSenderEventLike
  ): { mainWindow: BrowserWindowLike; sessionId: number | string } => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }

    const sender = event.sender as DestroyableSenderLike
    attachSessionCleanup(sender, activeContext)

    const sessionId = sender?.id ?? 1
    return { mainWindow: mainWindow!, sessionId }
  }

  // 1. Dispatch Agent Task
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.DISPATCH_TASK)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DISPATCH_TASK,
    async (event, rawPayload: unknown): Promise<DispatchAgentTaskResponse> => {
      try {
        const { mainWindow, sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(dispatchAgentTaskRequestSchema, rawPayload)

        // Resolve active Knowledge Base
        let activeKbId: string | undefined
        if (activeContext) {
          activeKbId = activeContext.getActiveWorkspaceId(sessionId)
        }

        // Authoritative Bot Resolution
        const bot = botRepository.getByIdOnly(payload.botId)
        if (!bot) {
          throw new Error(
            JSON.stringify({
              code: 'BOT_NOT_FOUND',
              message: `Bot with ID '${payload.botId}' not found.`
            })
          )
        }
        if (bot.status === 'archived') {
          throw new Error(
            JSON.stringify({
              code: 'BOT_ARCHIVED',
              message: `Bot '${bot.name}' is archived.`
            })
          )
        }
        if (activeKbId && bot.knowledgeBaseId !== activeKbId) {
          throw new Error(
            JSON.stringify({
              code: 'BOT_KB_MISMATCH',
              message: `Bot '${bot.id}' does not belong to active Knowledge Base.`
            })
          )
        }

        // Authoritative Conversation Resolution
        const conversation = conversationRepository.getByIdOnly(payload.conversationId)
        if (!conversation) {
          throw new Error(
            JSON.stringify({
              code: 'CONVERSATION_NOT_FOUND',
              message: `Conversation '${payload.conversationId}' not found.`
            })
          )
        }
        if (conversation.archivedAt !== null) {
          throw new Error(
            JSON.stringify({
              code: 'CONVERSATION_ARCHIVED',
              message: `Conversation '${conversation.title}' is archived.`
            })
          )
        }
        if (conversation.botId !== bot.id || conversation.knowledgeBaseId !== bot.knowledgeBaseId) {
          throw new Error(
            JSON.stringify({
              code: 'CONVERSATION_MISMATCH',
              message: `Conversation does not match requested Bot '${bot.name}'.`
            })
          )
        }

        // Pre-flight check: Enabled Phase 8 Bot Tools
        const enabledCanonical = CANONICAL_BOT_TOOLS.filter((t) =>
          isBotToolEnabled(bot.toolPermissions, t)
        )
        if (enabledCanonical.length === 0) {
          throw new Error(
            JSON.stringify({
              code: 'NO_ENABLED_TOOLS',
              message: `Bot '${bot.name}' has no enabled Phase 8 tools. Cannot dispatch an agent task.`
            })
          )
        }

        // Pre-flight check: Model Native Tool Calling Capability
        if (bot.providerConnectionId) {
          let providerId = 'openai'
          if (options.providerConnectionRepository) {
            const conn = options.providerConnectionRepository.getById(bot.providerConnectionId)
            if (conn) {
              providerId = conn.providerId
            }
          }
          const targetModelId = bot.modelId ?? providerId
          const modelMeta = providerRegistry.getModel(providerId, targetModelId)
          if (!modelMeta || modelMeta.providerCapabilities?.tools !== true) {
            throw new Error(
              JSON.stringify({
                code: 'MODEL_NOT_SUPPORTED',
                message: `Model '${targetModelId}' on provider '${providerId}' does not support native tool calling.`
              })
            )
          }
        }

        // Pre-flight check: Active concurrency guard on conversation
        if (agentTaskService.isTaskActive(conversation.id)) {
          throw new Error(
            JSON.stringify({
              code: 'CONCURRENT_TASK_ACTIVE',
              message: `An agent task is already in progress for conversation '${conversation.id}'.`
            })
          )
        }

        // Allocate Run ID before any workspace authorization
        const agentRunId = randomUUID()

        // Workspace Folder Authorization if explicitly requested by user intent
        if (payload.workspaceAccessRequested) {
          const hasWorkspaceTool =
            isBotToolEnabled(bot.toolPermissions, 'search_workspace_files') ||
            isBotToolEnabled(bot.toolPermissions, 'read_workspace_file')

          if (!hasWorkspaceTool) {
            throw new Error(
              JSON.stringify({
                code: 'NO_WORKSPACE_TOOLS_ENABLED',
                message: `Bot '${bot.name}' has no enabled workspace filesystem tools.`
              })
            )
          }

          const authResult = await workspaceFolderService.requestWorkspaceAuthorization(
            mainWindow,
            agentRunId,
            bot.id
          )

          if (authResult.status === 'cancelled') {
            return {
              accepted: false,
              agentRunId,
              conversationId: conversation.id,
              status: 'cancelled',
              reason: 'Workspace folder selection was cancelled by user.'
            }
          }
        }

        // Establish real-time MessagePort stream
        const senderFrame = event.senderFrame as unknown as WebFrameWithPostMessage
        const stream = streamManager.startStream(
          mainWindow,
          senderFrame,
          agentRunId,
          conversation.id,
          (cancelledRunId) => {
            agentTaskService.cancelTask(cancelledRunId, 'Task stream cancelled by client port.')
          }
        )

        // Setup approval notification listener for this run
        const unsubscribeApproval = approvalController.onEvent((approvalEvt) => {
          if (approvalEvt.request.agentRunId !== agentRunId) {
            return
          }
          if (approvalEvt.type === 'requested') {
            stream.emitEvent({
              type: 'approval_requested',
              approvalRequestId: approvalEvt.request.requestId,
              title: approvalEvt.request.title,
              contentPreview: approvalEvt.request.contentPreview,
              contentSizeBytes: approvalEvt.request.contentSizeBytes,
              expiresAt: approvalEvt.request.expiresAt
            })
          } else if (approvalEvt.type === 'resolved') {
            stream.emitEvent({
              type: 'approval_resolved',
              approvalRequestId: approvalEvt.request.requestId,
              status: approvalEvt.decision.status,
              reason: approvalEvt.decision.reason
            })
          }
        })

        // Execute background agent task without blocking IPC invoke
        agentTaskService
          .dispatchTask(
            sessionId,
            {
              botId: bot.id,
              conversationId: conversation.id,
              taskContent: payload.taskPrompt
            },
            {
              agentRunId,
              signal: stream.abortSignal,
              onEvent: (runtimeEvt) => {
                stream.emitEvent(runtimeEvt)
              }
            }
          )
          .catch((dispatchError: unknown) => {
            const errCode =
              dispatchError instanceof AgentTaskError ? dispatchError.code : 'TASK_EXECUTION_FAILED'
            const rawErrMsg =
              dispatchError instanceof Error ? dispatchError.message : String(dispatchError)
            stream.emitEvent({
              type: 'agent_run_failed',
              error: {
                code: errCode,
                message: sanitizeAgentErrorMessage(rawErrMsg)
              }
            })
          })
          .finally(() => {
            unsubscribeApproval()
          })

        return {
          accepted: true,
          agentRunId,
          conversationId: conversation.id,
          status: 'running'
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 2. Cancel Agent Task
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.CANCEL_TASK)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CANCEL_TASK,
    async (event, rawPayload: unknown): Promise<CancelAgentTaskResponse> => {
      try {
        const { mainWindow, sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(cancelAgentTaskRequestSchema, rawPayload)

        const run = agentRunRepository.getById(payload.agentRunId)
        if (!run) {
          throw new Error(
            JSON.stringify({
              code: 'RUN_NOT_FOUND',
              message: `Agent run '${payload.agentRunId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          const bot = botRepository.getByIdOnly(run.botId)
          if (!bot || bot.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'RUN_NOT_FOUND',
                message: `Agent run '${payload.agentRunId}' not found in active workspace.`
              })
            )
          }
        }

        streamManager.cancelStream(payload.agentRunId, mainWindow, 'Cancelled by user.')
        agentTaskService.cancelTask(payload.agentRunId, 'Cancelled by user.')

        return {
          success: true,
          agentRunId: payload.agentRunId
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 3. Get Agent Run
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.GET_RUN)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_RUN,
    async (event, rawPayload: unknown): Promise<GetAgentRunResponse> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(getAgentRunRequestSchema, rawPayload)

        const run = agentRunRepository.getById(payload.agentRunId)
        if (!run) {
          throw new Error(
            JSON.stringify({
              code: 'RUN_NOT_FOUND',
              message: `Agent run '${payload.agentRunId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          const bot = botRepository.getByIdOnly(run.botId)
          if (!bot || bot.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'RUN_NOT_FOUND',
                message: `Agent run '${payload.agentRunId}' not found in active workspace.`
              })
            )
          }
        }

        return { run }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 4. List Agent Runs (conversation-scoped)
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.LIST_RUNS)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_RUNS,
    async (event, rawPayload: unknown): Promise<ListAgentRunsResponse> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(listAgentRunsRequestSchema, rawPayload)

        const conversation = conversationRepository.getByIdOnly(payload.conversationId)
        if (!conversation) {
          throw new Error(
            JSON.stringify({
              code: 'CONVERSATION_NOT_FOUND',
              message: `Conversation '${payload.conversationId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          if (conversation.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'CONVERSATION_NOT_FOUND',
                message: `Conversation '${payload.conversationId}' not found in active workspace.`
              })
            )
          }
        }

        if (payload.botId && conversation.botId !== payload.botId) {
          throw new Error(
            JSON.stringify({
              code: 'CONVERSATION_MISMATCH',
              message: `Conversation '${payload.conversationId}' does not belong to Bot '${payload.botId}'.`
            })
          )
        }

        const allRuns = agentRunRepository.listByConversation(payload.conversationId)
        const offset = payload.offset ?? 0
        const limit = Math.min(payload.limit ?? 50, 100)
        const paginatedRuns = allRuns.slice(offset, offset + limit)

        return {
          runs: paginatedRuns,
          total: allRuns.length,
          hasMore: offset + paginatedRuns.length < allRuns.length,
          limit,
          offset
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 4. List Tool Events
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS,
    async (event, rawPayload: unknown): Promise<ListToolEventsResponse> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(listToolEventsRequestSchema, rawPayload)

        const run = agentRunRepository.getById(payload.agentRunId)
        if (!run) {
          throw new Error(
            JSON.stringify({
              code: 'RUN_NOT_FOUND',
              message: `Agent run '${payload.agentRunId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          const bot = botRepository.getByIdOnly(run.botId)
          if (!bot || bot.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'RUN_NOT_FOUND',
                message: `Agent run '${payload.agentRunId}' not found in active workspace.`
              })
            )
          }
        }

        const allEvents = toolEventRepository.listByAgentRun(payload.agentRunId)
        const offset = payload.offset ?? 0
        const limit = Math.min(payload.limit ?? 50, 100)
        const paginatedEvents = allEvents.slice(offset, offset + limit)

        return {
          events: paginatedEvents,
          total: allEvents.length,
          hasMore: offset + paginatedEvents.length < allEvents.length,
          limit,
          offset
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 5. Get Approval Details
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS,
    async (event, rawPayload: unknown): Promise<ApprovalDetailsDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(getApprovalDetailsRequestSchema, rawPayload)

        const run = agentRunRepository.getById(payload.agentRunId)
        if (!run) {
          throw new Error(
            JSON.stringify({
              code: 'RUN_NOT_FOUND',
              message: `Agent run '${payload.agentRunId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          const bot = botRepository.getByIdOnly(run.botId)
          if (!bot || bot.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'RUN_NOT_FOUND',
                message: `Agent run '${payload.agentRunId}' not found in active workspace.`
              })
            )
          }
        }

        const pending = approvalController.getPendingDetails(payload.approvalRequestId, {
          agentRunId: payload.agentRunId,
          botId: run.botId
        })

        if (!pending) {
          throw new Error(
            JSON.stringify({
              code: 'APPROVAL_NOT_FOUND',
              message: `Pending approval request '${payload.approvalRequestId}' not found or no longer pending.`
            })
          )
        }

        return {
          requestId: payload.approvalRequestId,
          agentRunId: payload.agentRunId,
          botId: run.botId,
          title: pending.title,
          markdownContent: pending.content,
          contentSizeBytes: pending.contentSizeBytes,
          createdAt: pending.createdAt,
          expiresAt: pending.expiresAt,
          status: 'pending'
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )

  // 6. Respond to Approval
  ipcMain.removeHandler(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL)
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL,
    async (event, rawPayload: unknown): Promise<RespondToApprovalResponse> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateAgentIpcPayload(respondToApprovalRequestSchema, rawPayload)

        const run = agentRunRepository.getById(payload.agentRunId)
        if (!run) {
          throw new Error(
            JSON.stringify({
              code: 'RUN_NOT_FOUND',
              message: `Agent run '${payload.agentRunId}' not found.`
            })
          )
        }

        if (activeContext) {
          const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
          const bot = botRepository.getByIdOnly(run.botId)
          if (!bot || bot.knowledgeBaseId !== activeKbId) {
            throw new Error(
              JSON.stringify({
                code: 'RUN_NOT_FOUND',
                message: `Agent run '${payload.agentRunId}' not found in active workspace.`
              })
            )
          }
        }

        const context = {
          agentRunId: payload.agentRunId,
          botId: run.botId
        }

        let success = false
        if (payload.decision === 'approve') {
          success = approvalController.approve(payload.approvalRequestId, context)
        } else {
          success = approvalController.reject(payload.approvalRequestId, context, payload.reason)
        }

        if (!success) {
          throw new Error(
            JSON.stringify({
              code: 'APPROVAL_ALREADY_RESOLVED',
              message: `Approval request '${payload.approvalRequestId}' is not pending or has already been resolved.`
            })
          )
        }

        return {
          success: true,
          requestId: payload.approvalRequestId,
          status: payload.decision === 'approve' ? 'approved' : 'rejected'
        }
      } catch (err) {
        throw formatAgentIpcError(err)
      }
    }
  )
}

/**
 * Registers safe fallback handlers that reject all incoming agent IPC requests
 * when the Agent subsystem fails to initialize during application startup.
 */
export function registerFailingAgentIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  failureMessage: string
): void {
  const assertSender = (event: IpcSenderEventLike): void => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation.'
        })
      )
    }
  }

  const throwFailure = (): never => {
    throw new Error(
      JSON.stringify({
        code: 'AGENT_SUBSYSTEM_DISABLED',
        message: sanitizeAgentErrorMessage(failureMessage),
        retryable: false
      })
    )
  }

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.DISPATCH_TASK)
  ipcMain.handle(AGENT_IPC_CHANNELS.DISPATCH_TASK, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.CANCEL_TASK)
  ipcMain.handle(AGENT_IPC_CHANNELS.CANCEL_TASK, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.GET_RUN)
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_RUN, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.LIST_RUNS)
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_RUNS, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS)
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS)
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS, async (event) => {
    assertSender(event)
    throwFailure()
  })

  ipcMain.removeHandler(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL)
  ipcMain.handle(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL, async (event) => {
    assertSender(event)
    throwFailure()
  })
}
