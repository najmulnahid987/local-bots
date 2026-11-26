import { ReactElement, useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Bot,
  AlertCircle,
  Loader2,
  Cpu,
  RotateCw,
  RotateCcw,
  Eraser,
  X,
  Brain,
  MessageSquare,
  CheckCircle2
} from 'lucide-react'
import {
  getBotResponsePolicyMeta,
  resolveBotResponsePolicy,
  type BotDto
} from '../../../../shared/bots'
import type {
  CitationDto,
  ResolvedCitationTargetDto,
  ExecutionMode
} from '../../../../shared/conversations'
import { useBotConversation } from '../../hooks/useBotConversation'
import { useConversationTurn } from '../../hooks/useConversationTurn'
import { useAgentTask } from '../../hooks/useAgentTask'
import { useAgentTaskEvents } from '../../hooks/useAgentTaskEvents'
import { useAgentRuns } from '../../hooks/useAgentRuns'
import { ConversationMessageList } from '../../components/chat/ConversationMessageList'
import { ConversationComposer } from '../../components/chat/ConversationComposer'
import { ClearConversationDialog } from '../../components/chat/ClearConversationDialog'
import { DocumentPreviewModal } from '../../components/documents/DocumentPreviewModal'
import { TaskActivityTimeline } from '../../components/agents/TaskActivityTimeline'
import { SaveReportApprovalModal } from '../../components/agents/SaveReportApprovalModal'
import { BotMemorySection } from '../../components/bots/memory/BotMemorySection'
import { TaskSummaryMemoryProposalModal } from '../../components/agents/TaskSummaryMemoryProposalModal'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function BotConversationsWorkspacePage(): ReactElement {
  const { kbId, botId } = useParams<{ kbId: string; botId: string }>()

  const isValidKbId = Boolean(kbId && UUID_REGEX.test(kbId))
  const isValidBotId = Boolean(botId && UUID_REGEX.test(botId))

  const [bot, setBot] = useState<BotDto | null>(null)
  const [botLoading, setBotLoading] = useState<boolean>(Boolean(isValidBotId && botId))
  const [botError, setBotError] = useState<string | null>(null)
  const [isClearDialogOpen, setIsClearDialogOpen] = useState<boolean>(false)

  const botRequestIdRef = useRef<number>(0)

  const [prevBotId, setPrevBotId] = useState<string | undefined>(botId)
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('chat')
  if (botId !== prevBotId) {
    setPrevBotId(botId)
    setBot(null)
    setBotLoading(Boolean(isValidBotId && botId))
    setBotError(null)
    setIsClearDialogOpen(false)
    setExecutionMode('chat')
  }

  // Fetch Bot details with strict sequencing to guard against rapid switching races
  useEffect(() => {
    if (!isValidBotId || !botId) {
      return
    }

    let isCurrent = true
    const reqId = ++botRequestIdRef.current

    const loadBot = async (): Promise<void> => {
      try {
        if (window.api?.bots?.get) {
          const fetched = await window.api.bots.get(botId)
          if (isCurrent && reqId === botRequestIdRef.current) {
            setBot(fetched)
            if (!fetched) {
              setBotError('The requested Bot does not exist or has been deleted.')
            }
          }
        } else {
          if (isCurrent && reqId === botRequestIdRef.current) {
            setBotError('Bot API is unavailable.')
          }
        }
      } catch (err) {
        if (isCurrent && reqId === botRequestIdRef.current) {
          setBotError(err instanceof Error ? err.message : 'Failed to load Bot details.')
        }
      } finally {
        if (isCurrent && reqId === botRequestIdRef.current) {
          setBotLoading(false)
        }
      }
    }

    void loadBot()

    return () => {
      isCurrent = false
    }
  }, [botId, isValidBotId])

  // Single canonical conversation, segments, and messages for this Bot (1:1 invariant)
  const {
    conversation,
    segments,
    messages,
    isLoading: conversationLoading,
    isRefreshing: conversationRefreshing,
    isClearing: conversationClearing,
    error: conversationError,
    refresh: refreshConversation,
    clearConversation
  } = useBotConversation({
    botId: bot?.id ?? null,
    enabled: Boolean(bot)
  })

  const canonicalConversationId = conversation?.id ?? null

  // Historical Agent Runs for the canonical conversation
  const agentRuns = useAgentRuns({
    conversationId: canonicalConversationId,
    botId: bot?.id ?? null,
    enabled: Boolean(canonicalConversationId)
  })

  // Generation / Turn state for the canonical conversation (normal chat)
  const {
    isGenerating,
    isCancelling,
    streamingText,
    error: turnError,
    sendMessage,
    retryLastUserMessage,
    cancelGeneration,
    resetTurn
  } = useConversationTurn({
    conversationId: canonicalConversationId,
    onFinish: () => {
      void refreshConversation()
    },
    onError: () => {
      void refreshConversation()
    }
  })

  // Agent Task state for explicit task dispatch into the same canonical conversation
  const agentTask = useAgentTask({
    conversationId: canonicalConversationId,
    botId: bot?.id,
    onTaskAccepted: () => {
      void refreshConversation()
    },
    onTaskCompleted: async () => {
      await refreshConversation()
      await agentRuns.refresh()
    },
    onTaskCancelled: async () => {
      setCancellationNotice('Agent task cancelled.')
      await refreshConversation()
      await agentRuns.refresh()
    }
  })

  const isTaskActive =
    agentTask.status === 'running' ||
    agentTask.status === 'queued' ||
    agentTask.status === 'waiting_approval'

  // Report approval modal state
  const [activeApprovalTarget, setActiveApprovalTarget] = useState<{
    agentRunId: string
    approvalRequestId: string
  } | null>(null)
  const [isApprovalModalOpen, setIsApprovalModalOpen] = useState<boolean>(false)

  // Real-time task event streaming
  const agentTaskEvents = useAgentTaskEvents({
    agentRunId: agentTask.activeRunId,
    botId: bot?.id ?? null,
    onApprovalRequested: (approval) => {
      setActiveApprovalTarget({
        agentRunId: approval.agentRunId,
        approvalRequestId: approval.requestId
      })
      setIsApprovalModalOpen(true)
    }
  })

  // Citation preview and resolution state
  const [citationTarget, setCitationTarget] = useState<ResolvedCitationTargetDto | null>(null)
  const [citationError, setCitationError] = useState<string | null>(null)
  const [cancellationNotice, setCancellationNotice] = useState<string | null>(null)

  // View mode tab state (Chat vs Memories)
  const [searchParams, setSearchParams] = useSearchParams()
  const viewParam = searchParams.get('tab') ?? searchParams.get('view')
  const viewMode = viewParam === 'memories' ? 'memories' : 'chat'

  const handleSetViewMode = useCallback(
    (mode: 'chat' | 'memories') => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (mode === 'memories') {
          next.set('tab', 'memories')
        } else {
          next.delete('tab')
          next.delete('view')
        }
        return next
      })
    },
    [setSearchParams]
  )

  // Task summary proposal modal state
  const [taskSummaryModal, setTaskSummaryModal] = useState<{
    isOpen: boolean
    content: string
    taskTitle?: string
  }>({
    isOpen: false,
    content: '',
    taskTitle: undefined
  })
  const [memoryNotification, setMemoryNotification] = useState<string | null>(null)

  // Clear citation, approval, and notice state when canonical conversation changes (Bot switch)
  const [prevConvId, setPrevConvId] = useState<string | null>(canonicalConversationId)
  if (canonicalConversationId !== prevConvId) {
    setPrevConvId(canonicalConversationId)
    setCitationTarget(null)
    setCitationError(null)
    setCancellationNotice(null)
    agentTask.reset()
    setActiveApprovalTarget(null)
    setIsApprovalModalOpen(false)
    setIsClearDialogOpen(false)
  }

  const handleClearConversation = useCallback(async (): Promise<void> => {
    if (isGenerating || isTaskActive) {
      throw new Error(
        'Cannot clear conversation while generation or an agent task is in progress. Please stop it first.'
      )
    }
    await clearConversation()
    setCitationTarget(null)
    setCitationError(null)
    setCancellationNotice(null)
    resetTurn()
    agentTask.reset()
    await agentRuns.refresh()
  }, [isGenerating, isTaskActive, clearConversation, resetTurn, agentTask, agentRuns])

  const handleStopGeneration = useCallback(async (): Promise<void> => {
    try {
      if (isGenerating) {
        await cancelGeneration()
        setCancellationNotice('Generation stopped.')
        await refreshConversation()
      } else if (isTaskActive && agentTask.activeRunId) {
        await agentTask.cancelTask()
        setCancellationNotice('Agent task stopped.')
        await refreshConversation()
      }
    } catch {
      // Handled safely
    }
  }, [isGenerating, isTaskActive, agentTask, cancelGeneration, refreshConversation])

  const isLastMessageUnansweredUser =
    messages.length > 0 && messages[messages.length - 1].role === 'user'

  const canRetry =
    Boolean(turnError?.retryable) &&
    isLastMessageUnansweredUser &&
    !isGenerating &&
    !isTaskActive &&
    Boolean(bot && bot.status !== 'archived')

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!canRetry) return
    const lastUserMessage = messages[messages.length - 1]
    setCancellationNotice(null)
    try {
      await retryLastUserMessage({ messageId: lastUserMessage.id })
    } catch {
      // Retained in turnError
    }
  }, [canRetry, messages, retryLastUserMessage])

  const handleCitationClick = useCallback(
    async (citation: CitationDto, targetMessageId?: string): Promise<void> => {
      if (!canonicalConversationId) return
      setCitationError(null)

      try {
        if (!window.api?.conversation?.resolveCitation) {
          throw new Error('Citation resolution API is not available.')
        }

        const msg =
          (targetMessageId ? messages.find((m) => m.id === targetMessageId) : undefined) ??
          messages.find((m) =>
            m.metadata?.citations?.some((c) => c.citationNumber === citation.citationNumber)
          )
        if (!msg) {
          throw new Error(`Message containing citation #${citation.citationNumber} not found.`)
        }

        const target = await window.api.conversation.resolveCitation({
          conversationId: canonicalConversationId,
          messageId: msg.id,
          citationNumber: citation.citationNumber
        })
        setCitationTarget(target)
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        setCitationError(
          rawMsg
            .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
            .replace(/(?:^|\s)(?:\/[a-zA-Z0-9_.-]+){2,}/g, ' [REDACTED_PATH]')
        )
      }
    },
    [canonicalConversationId, messages, setCitationError, setCitationTarget]
  )

  // 1. Invalid Identifier validation guard
  if (!isValidKbId || !isValidBotId) {
    return (
      <div className="workspace-tab-panel" data-testid="bot-conversations-invalid-route">
        <div className="section-alert section-alert-error" role="alert">
          <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Invalid Workspace or Bot Identifier</strong>
            <span>
              The specified Knowledge Base ID ({kbId}) or Bot ID ({botId}) is not a valid UUID
              format.
            </span>
            <Link
              to={`/knowledge-bases/${kbId ?? ''}/bots`}
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '8px', alignSelf: 'flex-start' }}
              data-testid="return-to-bots-btn"
            >
              <ArrowLeft size={14} className="inline-icon" aria-hidden="true" />
              Return to Bots
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // 2. Loading Bot State
  if (botLoading) {
    return (
      <div className="section-loading-state" role="status" data-testid="bot-conversations-loading">
        <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
        <span>Loading Bot workspace...</span>
      </div>
    )
  }

  // 3. Bot Not Found or Error State
  if (botError || !bot) {
    return (
      <div className="workspace-tab-panel" data-testid="bot-not-found-state">
        <div className="section-alert section-alert-error" role="alert">
          <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Bot Not Found</strong>
            <span>{botError ?? 'The requested Bot could not be loaded.'}</span>
            <Link
              to={`/knowledge-bases/${kbId}/bots`}
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '8px', alignSelf: 'flex-start' }}
              data-testid="return-to-bots-btn"
            >
              <ArrowLeft size={14} className="inline-icon" aria-hidden="true" />
              Return to Bots
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isArchived = bot.status === 'archived'

  const handleSendMessage = async (content: string): Promise<void> => {
    setCancellationNotice(null)
    await sendMessage(content)
  }

  const handleDispatchTask = async (
    taskPrompt: string,
    workspaceAccessRequested?: boolean
  ): Promise<void> => {
    setCancellationNotice(null)
    await agentTask.dispatchTask(taskPrompt, workspaceAccessRequested)
  }

  // Construct active or recent session task timeline element
  const activeTaskElement = agentTask.activeRunId ? (
    <div
      style={{
        marginBottom: '16px',
        width: '100%'
      }}
      data-testid="active-task-timeline-container"
    >
      <TaskActivityTimeline
        agentRunId={agentTask.activeRunId}
        status={agentTaskEvents.runStatus ?? agentTask.status}
        iteration={agentTaskEvents.iteration}
        maxIterations={agentTaskEvents.maxIterations}
        toolActivities={agentTaskEvents.toolActivities}
        errorSummary={agentTaskEvents.error?.message ?? agentTask.error}
        onStop={isTaskActive ? () => void agentTask.cancelTask() : undefined}
        onReviewApproval={
          agentTaskEvents.pendingApproval
            ? () => {
                setActiveApprovalTarget({
                  agentRunId: agentTaskEvents.pendingApproval!.agentRunId,
                  approvalRequestId: agentTaskEvents.pendingApproval!.requestId
                })
                setIsApprovalModalOpen(true)
              }
            : undefined
        }
        hasPendingApproval={Boolean(agentTaskEvents.pendingApproval)}
        onSaveAsMemory={
          (agentTaskEvents.runStatus ?? agentTask.status) === 'completed'
            ? () => {
                const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
                setTaskSummaryModal({
                  isOpen: true,
                  content: lastAssistant?.content ?? 'Task completed successfully with findings.',
                  taskTitle: 'Completed Agent Task'
                })
              }
            : undefined
        }
      />
    </div>
  ) : null

  return (
    <div
      className="workspace-tab-panel chat-workspace-panel"
      data-testid="bot-conversations-workspace"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '520px',
        padding: 0
      }}
    >
      {/* Top Header & Breadcrumbs Bar */}
      <div
        className="chat-workspace-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border, #e2e8f0)',
          backgroundColor: '#ffffff'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Link
            to={`/knowledge-bases/${kbId}/bots`}
            className="btn btn-secondary btn-sm"
            data-testid="back-to-bots-link"
            title="Return to Bots list"
          >
            <ArrowLeft size={14} className="inline-icon" aria-hidden="true" />
            <span>Back to Bots</span>
          </Link>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2
                className="workspace-panel-title"
                data-testid="bot-conversations-title"
                style={{ margin: 0, fontSize: '16px' }}
              >
                {bot.name}
              </h2>
              <span
                className={`status-badge ${isArchived ? 'status-badge-revoked' : 'status-badge-active'}`}
                data-testid="bot-status-badge"
              >
                {isArchived ? 'Archived' : 'Active'}
              </span>
              {(() => {
                const effectivePolicy = resolveBotResponsePolicy(bot.responsePolicy)
                const policyMeta = getBotResponsePolicyMeta(effectivePolicy)
                return (
                  <span
                    className={`bot-policy-badge policy-${effectivePolicy}`}
                    data-testid="bot-response-policy"
                    title={policyMeta.description}
                  >
                    {policyMeta.label}
                  </span>
                )
              })()}
            </div>
            <p
              className="workspace-panel-subtitle"
              style={{ margin: '2px 0 0 0', fontSize: '12px' }}
            >
              <span
                className="bot-meta-item"
                data-testid="bot-model"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Cpu size={12} className="inline-icon" aria-hidden="true" />
                <code className="bot-model-code">{bot.modelId}</code>
              </span>
              {bot.description ? ` — ${bot.description}` : ''}
            </p>
          </div>
        </div>

        {/* View Switcher: Chat vs Memories */}
        <div
          className="tab-group"
          role="tablist"
          aria-label="Bot workspace views"
          style={{
            display: 'inline-flex',
            backgroundColor: '#f1f5f9',
            padding: '3px',
            borderRadius: '8px',
            gap: '2px'
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'chat'}
            onClick={() => handleSetViewMode('chat')}
            className={`tab-btn ${viewMode === 'chat' ? 'active' : ''}`}
            data-testid="tab-view-chat"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 12px',
              fontSize: '12.5px',
              fontWeight: viewMode === 'chat' ? 600 : 500,
              borderRadius: '6px',
              border: 'none',
              backgroundColor: viewMode === 'chat' ? '#ffffff' : 'transparent',
              color: viewMode === 'chat' ? '#0f172a' : '#64748b',
              boxShadow: viewMode === 'chat' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <MessageSquare size={13} aria-hidden="true" />
            <span>Chat</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'memories'}
            onClick={() => handleSetViewMode('memories')}
            className={`tab-btn ${viewMode === 'memories' ? 'active' : ''}`}
            data-testid="tab-view-memories"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 12px',
              fontSize: '12.5px',
              fontWeight: viewMode === 'memories' ? 600 : 500,
              borderRadius: '6px',
              border: 'none',
              backgroundColor: viewMode === 'memories' ? '#ffffff' : 'transparent',
              color: viewMode === 'memories' ? '#4f46e5' : '#64748b',
              boxShadow: viewMode === 'memories' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <Brain size={13} aria-hidden="true" />
            <span>Memories</span>
          </button>
        </div>
      </div>

      {/* Memory Notification Banner */}
      {memoryNotification && (
        <div
          className="section-alert section-alert-success"
          role="status"
          data-testid="memory-save-success-notification"
          style={{
            margin: '8px 20px 0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            color: '#166534',
            padding: '8px 14px',
            borderRadius: '6px',
            fontSize: '12.5px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} style={{ color: '#16a34a' }} aria-hidden="true" />
            <span>{memoryNotification}</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => handleSetViewMode('memories')}
            data-testid="btn-view-saved-memory"
            style={{ padding: '2px 8px', fontSize: '11px' }}
          >
            View Memories
          </button>
        </div>
      )}

      {/* Archived Notice Banner */}
      {isArchived && (
        <div
          className="section-alert section-alert-info"
          role="status"
          data-testid="bot-archived-notice"
          style={{ margin: '8px 20px 0 20px' }}
        >
          <Bot size={18} className="inline-icon text-muted" aria-hidden="true" />
          <div className="alert-body">
            <strong>Bot is Archived</strong>
            <span>
              This Bot is archived. Restore the Bot from the Bots tab to send new messages or run
              agent tasks.
            </span>
          </div>
        </div>
      )}

      {/* Bot Memories Workspace View */}
      {viewMode === 'memories' && (
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            backgroundColor: '#ffffff'
          }}
          data-testid="bot-memories-view-container"
        >
          <BotMemorySection bot={bot} isArchived={isArchived} />
        </div>
      )}

      {/* Unified Single-Conversation Chat Workspace (Knowledge Base -> Bot -> Persistent Conversation) */}
      <div
        className="chat-workspace-body"
        data-testid="bot-conversations-layout"
        style={{
          display: viewMode === 'chat' ? 'flex' : 'none',
          flex: 1,
          overflow: 'hidden',
          backgroundColor: '#ffffff'
        }}
      >
        <main
          className="chat-main"
          data-testid="conversation-workspace-main"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: '#ffffff'
          }}
        >
          {conversationLoading && !conversation ? (
            <div
              className="section-loading-state"
              role="status"
              data-testid="conversation-loading"
              style={{ flex: 1 }}
            >
              <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
              <span>Loading conversation history...</span>
            </div>
          ) : conversationError && !conversation ? (
            <div
              style={{ padding: '24px', flex: 1, display: 'flex', alignItems: 'flex-start' }}
              data-testid="conversation-error-container"
            >
              <div
                className="section-alert section-alert-error"
                role="alert"
                data-testid="conversation-error-alert"
                style={{ width: '100%' }}
              >
                <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
                <div className="alert-body">
                  <strong>Unable to Load Conversation</strong>
                  <span>{conversationError}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void refreshConversation()}
                    disabled={conversationRefreshing}
                    data-testid="retry-load-conversation-btn"
                    style={{ marginTop: '8px', alignSelf: 'flex-start' }}
                  >
                    <RotateCw
                      size={12}
                      className={`inline-icon ${conversationRefreshing ? 'spinner' : ''}`}
                      aria-hidden="true"
                    />
                    <span>Retry</span>
                  </button>
                </div>
              </div>
            </div>
          ) : conversation ? (
            <>
              {/* Unified Persistent Conversation Subheader */}
              <div
                className="chat-header"
                data-testid="conversation-toolbar"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 20px',
                  borderBottom: '1px solid var(--color-border, #e2e8f0)',
                  backgroundColor: '#ffffff'
                }}
              >
                <div>
                  <h3
                    data-testid="selected-conversation-title"
                    style={{
                      margin: 0,
                      fontSize: '14.5px',
                      fontWeight: 600,
                      color: 'var(--color-text-primary, #0f172a)'
                    }}
                  >
                    {conversation.title}
                  </h3>
                  <span
                    className="text-muted"
                    data-testid="messages-count"
                    style={{ fontSize: '11.5px', color: '#64748b' }}
                  >
                    {conversationLoading || conversationRefreshing
                      ? 'Loading messages...'
                      : segments.length > 1
                        ? `${messages.length} message(s) across ${segments.length} threads`
                        : `${messages.length} message(s)`}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      void refreshConversation()
                      void agentRuns.refresh()
                    }}
                    disabled={conversationLoading || conversationRefreshing || conversationClearing}
                    data-testid="refresh-messages-btn"
                    title="Refresh messages and agent runs"
                    aria-label="Refresh messages"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <RotateCw
                      size={12}
                      className={`inline-icon ${conversationRefreshing ? 'spinner' : ''}`}
                      aria-hidden="true"
                    />
                    <span>Refresh</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm text-danger"
                    onClick={() => setIsClearDialogOpen(true)}
                    disabled={
                      isArchived ||
                      isGenerating ||
                      isTaskActive ||
                      conversationClearing ||
                      (messages.length === 0 && segments.length <= 1)
                    }
                    data-testid="clear-conversation-btn"
                    title={
                      isGenerating || isTaskActive
                        ? 'Stop active generation before clearing conversation'
                        : isArchived
                          ? 'Restore Bot before clearing conversation'
                          : 'Clear conversation history'
                    }
                    aria-label="Clear Conversation"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <Eraser size={12} className="inline-icon" aria-hidden="true" />
                    <span>Clear Conversation</span>
                  </button>
                </div>
              </div>

              {/* Cancellation Notice Banner */}
              {cancellationNotice && (
                <div
                  className="section-alert section-alert-info"
                  role="status"
                  data-testid="cancellation-notice"
                  style={{
                    margin: '8px 20px 0 20px',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <span>{cancellationNotice}</span>
                  <button
                    type="button"
                    onClick={() => setCancellationNotice(null)}
                    aria-label="Dismiss notice"
                    data-testid="dismiss-cancellation-notice-btn"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: '2px',
                      display: 'inline-flex',
                      alignItems: 'center'
                    }}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              )}

              {/* Conversation / Message Error Alert */}
              {conversationError && (
                <div
                  className="section-alert section-alert-error"
                  role="alert"
                  data-testid="messages-error-alert"
                  style={{ margin: '8px 20px 0 20px', fontSize: '12px' }}
                >
                  <span>{conversationError}</span>
                </div>
              )}

              {/* Generation Error Alert with Retry Action */}
              {turnError && (
                <div
                  className="section-alert section-alert-error"
                  role="alert"
                  data-testid="turn-error-alert"
                  style={{
                    margin: '8px 20px 0 20px',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px'
                  }}
                >
                  <span>
                    Generation Error: {turnError.message}
                    {turnError.retryable ? ' (Retryable)' : ''}
                  </span>

                  {canRetry && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="retry-turn-btn"
                      aria-label="Retry generation"
                      onClick={() => void handleRetry()}
                      disabled={isGenerating || isTaskActive || isArchived}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        flexShrink: 0,
                        padding: '3px 8px',
                        fontSize: '11.5px'
                      }}
                    >
                      <RotateCcw size={12} className="inline-icon" aria-hidden="true" />
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              )}

              {/* Agent Task Error Alert */}
              {agentTask.error && (
                <div
                  className="section-alert section-alert-error"
                  role="alert"
                  data-testid="agent-task-error-alert"
                  style={{ margin: '8px 20px 0 20px', fontSize: '12px' }}
                >
                  <span>Agent Task Error: {agentTask.error}</span>
                </div>
              )}

              {/* Citation Resolution Error Alert */}
              {citationError && (
                <div
                  className="section-alert section-alert-error"
                  role="alert"
                  data-testid="citation-error-alert"
                  style={{ margin: '8px 20px 0 20px', fontSize: '12px' }}
                >
                  <span>{citationError}</span>
                </div>
              )}

              {/* Scrollable Segment-Aware Message Timeline with Active Agent Task Elements */}
              <ConversationMessageList
                messages={messages}
                segments={segments}
                isLoading={conversationLoading}
                isGenerating={isGenerating}
                streamingText={streamingText}
                botName={bot.name}
                conversationId={canonicalConversationId}
                isArchived={isArchived}
                onCitationClick={handleCitationClick}
                activeTaskElement={activeTaskElement}
                onSaveAsMemory={(content) =>
                  setTaskSummaryModal({
                    isOpen: true,
                    content,
                    taskTitle: 'Assistant Response'
                  })
                }
              />

              {/* Fixed Bottom Message Composer */}
              <ConversationComposer
                bot={bot}
                mode={executionMode}
                onModeChange={setExecutionMode}
                onSend={handleSendMessage}
                onDispatchTask={handleDispatchTask}
                onStop={handleStopGeneration}
                isGenerating={isGenerating}
                isCancelling={isCancelling || agentTask.isCancelling}
                isTaskRunning={isTaskActive}
                disabled={isArchived}
                placeholder={
                  isArchived
                    ? 'Bot is archived — restore bot to send messages'
                    : `Message ${bot.name}... (Enter to send, Shift+Enter for new line)`
                }
              />
            </>
          ) : null}
        </main>
      </div>

      {/* Clear Conversation Confirmation Dialog */}
      <ClearConversationDialog
        isOpen={isClearDialogOpen}
        conversation={conversation}
        botName={bot.name}
        isGenerating={isGenerating}
        isTaskActive={isTaskActive}
        onClose={() => setIsClearDialogOpen(false)}
        onConfirm={async () => {
          await handleClearConversation()
        }}
      />

      {/* Verified Document Preview Modal for Cited Location */}
      {citationTarget && (
        <DocumentPreviewModal
          isOpen={Boolean(citationTarget)}
          sourceId={citationTarget.sourceId}
          knowledgeBaseId={citationTarget.knowledgeBaseId}
          targetChunkId={citationTarget.chunkId}
          targetPageNumber={citationTarget.pageNumber}
          targetHeadingPath={citationTarget.headingPath}
          citationNumber={citationTarget.citationNumber}
          onClose={() => setCitationTarget(null)}
        />
      )}

      {/* Human-in-the-loop Report Save Approval Modal */}
      {activeApprovalTarget && (
        <SaveReportApprovalModal
          isOpen={isApprovalModalOpen}
          agentRunId={activeApprovalTarget.agentRunId}
          approvalRequestId={activeApprovalTarget.approvalRequestId}
          onClose={() => setIsApprovalModalOpen(false)}
          onDecisionSubmitted={async () => {
            setIsApprovalModalOpen(false)
            await agentTaskEvents.refreshState()
            await refreshConversation()
          }}
        />
      )}

      {/* Task Summary / Findings Memory Proposal Modal */}
      <TaskSummaryMemoryProposalModal
        isOpen={taskSummaryModal.isOpen}
        botId={bot.id}
        botName={bot.name}
        defaultContent={taskSummaryModal.content}
        taskTitle={taskSummaryModal.taskTitle}
        onClose={() => setTaskSummaryModal({ isOpen: false, content: '', taskTitle: undefined })}
        onSaveSuccess={() => {
          setMemoryNotification('Task findings saved to Bot Memory.')
          setTimeout(() => setMemoryNotification(null), 4000)
        }}
      />
    </div>
  )
}
