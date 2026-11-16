import { ReactElement, useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Bot, AlertCircle, Loader2, Cpu, RotateCw, RotateCcw, X } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'
import type {
  CitationDto,
  ResolvedCitationTargetDto,
  DeleteConversationResultDto
} from '../../../../shared/conversations'
import { useConversations } from '../../hooks/useConversations'
import { useConversationMessages } from '../../hooks/useConversationMessages'
import { useConversationTurn } from '../../hooks/useConversationTurn'
import { useAgentTask } from '../../hooks/useAgentTask'
import { useAgentTaskEvents } from '../../hooks/useAgentTaskEvents'
import { useAgentRuns } from '../../hooks/useAgentRuns'
import { ConversationSidebar } from '../../components/chat/ConversationSidebar'
import { ConversationMessageList } from '../../components/chat/ConversationMessageList'
import { ConversationComposer } from '../../components/chat/ConversationComposer'
import { ConversationEmptyState } from '../../components/chat/ConversationEmptyState'
import { DocumentPreviewModal } from '../../components/documents/DocumentPreviewModal'
import { TaskActivityTimeline } from '../../components/agents/TaskActivityTimeline'
import { SaveReportApprovalModal } from '../../components/agents/SaveReportApprovalModal'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function BotConversationsWorkspacePage(): ReactElement {
  const { kbId, botId } = useParams<{ kbId: string; botId: string }>()

  const isValidKbId = Boolean(kbId && UUID_REGEX.test(kbId))
  const isValidBotId = Boolean(botId && UUID_REGEX.test(botId))

  const [bot, setBot] = useState<BotDto | null>(null)
  const [botLoading, setBotLoading] = useState<boolean>(Boolean(isValidBotId && botId))
  const [botError, setBotError] = useState<string | null>(null)

  const [prevBotId, setPrevBotId] = useState<string | undefined>(botId)
  if (botId !== prevBotId) {
    setPrevBotId(botId)
    setBotLoading(Boolean(isValidBotId && botId))
    setBotError(null)
  }

  // Fetch Bot details
  useEffect(() => {
    if (!isValidBotId || !botId) {
      return
    }

    let isCurrent = true

    const loadBot = async (): Promise<void> => {
      try {
        if (window.api?.bots?.get) {
          const fetched = await window.api.bots.get(botId)
          if (isCurrent) {
            setBot(fetched)
            if (!fetched) {
              setBotError('The requested Bot does not exist or has been deleted.')
            }
          }
        } else {
          if (isCurrent) {
            setBotError('Bot API is unavailable.')
          }
        }
      } catch (err) {
        if (isCurrent) {
          setBotError(err instanceof Error ? err.message : 'Failed to load Bot details.')
        }
      } finally {
        if (isCurrent) {
          setBotLoading(false)
        }
      }
    }

    void loadBot()

    return () => {
      isCurrent = false
    }
  }, [botId, isValidBotId])

  // Conversations state for this Bot
  const {
    conversations,
    selectedConversationId,
    selectedConversation,
    isLoading: conversationsLoading,
    isRefreshing: conversationsRefreshing,
    isMutating: conversationsMutating,
    error: conversationsError,
    refresh: refreshConversations,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation
  } = useConversations({
    botId: bot?.id ?? null,
    enabled: Boolean(bot && bot.status !== 'archived')
  })

  // Messages state for the selected conversation
  const {
    messages,
    isLoading: messagesLoading,
    refresh: refreshMessages,
    error: messagesError
  } = useConversationMessages({
    conversationId: selectedConversationId,
    enabled: Boolean(selectedConversationId)
  })

  // Historical Agent Runs for the selected conversation
  const agentRuns = useAgentRuns({
    conversationId: selectedConversationId,
    enabled: Boolean(selectedConversationId)
  })

  // Generation / Turn state for the selected conversation (normal chat)
  const {
    isGenerating,
    isCancelling,
    streamingText,
    error: turnError,
    sendMessage,
    retryLastUserMessage,
    cancelGeneration
  } = useConversationTurn({
    conversationId: selectedConversationId,
    onFinish: () => {
      void refreshMessages()
      void refreshConversations()
    }
  })

  // Agent Task state for explicit task dispatch
  const agentTask = useAgentTask({
    conversationId: selectedConversationId,
    botId: bot?.id,
    onTaskCompleted: async () => {
      await refreshMessages()
      await refreshConversations()
      await agentRuns.refresh()
    },
    onTaskCancelled: async () => {
      setCancellationNotice('Agent task cancelled.')
      await refreshMessages()
      await refreshConversations()
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

  // Clear citation and notice state when switching conversations
  const [prevConvId, setPrevConvId] = useState<string | null>(selectedConversationId)
  if (selectedConversationId !== prevConvId) {
    setPrevConvId(selectedConversationId)
    setCitationTarget(null)
    setCitationError(null)
    setCancellationNotice(null)
    agentTask.reset()
    setActiveApprovalTarget(null)
    setIsApprovalModalOpen(false)
  }

  const handleDeleteConversation = useCallback(
    async (conversationId: string): Promise<DeleteConversationResultDto> => {
      if ((isGenerating || isTaskActive) && selectedConversationId === conversationId) {
        throw new Error(
          'Cannot delete conversation while generation or task is in progress. Please stop it first.'
        )
      }
      return deleteConversation(conversationId)
    },
    [isGenerating, isTaskActive, selectedConversationId, deleteConversation]
  )

  const handleStopGeneration = useCallback(async (): Promise<void> => {
    try {
      if (isGenerating) {
        await cancelGeneration()
        setCancellationNotice('Generation stopped.')
        await refreshMessages()
        await refreshConversations()
      } else if (isTaskActive && agentTask.activeRunId) {
        await agentTask.cancelTask()
        setCancellationNotice('Agent task stopped.')
        await refreshMessages()
        await refreshConversations()
      }
    } catch {
      // Handled safely
    }
  }, [
    isGenerating,
    isTaskActive,
    agentTask,
    cancelGeneration,
    refreshMessages,
    refreshConversations
  ])

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
    async (citation: CitationDto): Promise<void> => {
      if (!selectedConversationId) return
      setCitationError(null)

      try {
        if (!window.api?.conversation?.resolveCitation) {
          throw new Error('Citation resolution API is not available.')
        }

        const msg = messages.find((m) =>
          m.metadata?.citations?.some((c) => c.citationNumber === citation.citationNumber)
        )
        if (!msg) {
          throw new Error(`Message containing citation #${citation.citationNumber} not found.`)
        }

        const target = await window.api.conversation.resolveCitation({
          conversationId: selectedConversationId,
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
    [selectedConversationId, messages, setCitationError, setCitationTarget]
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
      </div>

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
              This Bot is archived. Restore the Bot from the Bots tab to send new messages or create
              conversations.
            </span>
          </div>
        </div>
      )}

      {/* Main Two-Panel Chat Workspace */}
      <div
        className="chat-workspace-body"
        data-testid="bot-conversations-layout"
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
          backgroundColor: '#f8fafc'
        }}
      >
        {/* Left Panel: Conversation Sidebar */}
        <ConversationSidebar
          bot={bot}
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          onSelectConversation={selectConversation}
          onCreateConversation={createConversation}
          onRenameConversation={renameConversation}
          onDeleteConversation={handleDeleteConversation}
          isGenerating={isGenerating || isTaskActive}
          isLoading={conversationsLoading}
          isRefreshing={conversationsRefreshing}
          isMutating={conversationsMutating}
          error={conversationsError}
          onRefresh={() => void refreshConversations()}
        />

        {/* Right Panel: Chat Area */}
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
          {selectedConversation ? (
            <>
              {/* Compact Active Conversation Header */}
              <div
                className="chat-header"
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
                    {selectedConversation.title}
                  </h3>
                  <span
                    className="text-muted"
                    data-testid="messages-count"
                    style={{ fontSize: '11.5px', color: '#64748b' }}
                  >
                    {messagesLoading ? 'Loading messages...' : `${messages.length} message(s)`}
                  </span>
                </div>

                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void refreshMessages()
                    void agentRuns.refresh()
                  }}
                  disabled={messagesLoading}
                  data-testid="refresh-messages-btn"
                  title="Refresh messages and agent runs"
                  aria-label="Refresh messages"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <RotateCw
                    size={12}
                    className={`inline-icon ${messagesLoading ? 'spinner' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Refresh</span>
                </button>
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

              {/* Message Loading Error Alert */}
              {messagesError && (
                <div
                  className="section-alert section-alert-error"
                  role="alert"
                  data-testid="messages-error-alert"
                  style={{ margin: '8px 20px 0 20px', fontSize: '12px' }}
                >
                  <span>{messagesError}</span>
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

              {/* Scrollable Message Timeline with Active Agent Task Elements */}
              <ConversationMessageList
                messages={messages}
                isLoading={messagesLoading}
                isGenerating={isGenerating}
                streamingText={streamingText}
                botName={bot.name}
                conversationId={selectedConversationId}
                isArchived={isArchived}
                onCitationClick={handleCitationClick}
                activeTaskElement={activeTaskElement}
              />

              {/* Fixed Bottom Message Composer */}
              <ConversationComposer
                bot={bot}
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
          ) : (
            <ConversationEmptyState
              variant="no-selection"
              botName={bot.name}
              onNewConversation={() => void createConversation()}
              isArchived={isArchived}
            />
          )}
        </main>
      </div>

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
            await refreshMessages()
          }}
        />
      )}
    </div>
  )
}
