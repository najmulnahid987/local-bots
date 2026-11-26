import { ReactElement, useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Loader2, Square, MessageSquare, Bot, Sparkles, AlertCircle } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'
import { isBotToolEnabled } from '../../../../shared/agents'
import type { ExecutionMode } from '../../../../shared/conversations'

export interface ConversationComposerProps {
  readonly onSend: (content: string) => Promise<void>
  readonly onDispatchTask?: (content: string, workspaceAccessRequested: boolean) => Promise<void>
  readonly onStop?: () => Promise<void>
  readonly isGenerating: boolean
  readonly isTaskRunning?: boolean
  readonly isCancelling?: boolean
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly bot?: BotDto | null
  readonly mode?: ExecutionMode
  readonly onModeChange?: (mode: ExecutionMode) => void
}

export function ConversationComposer({
  onSend,
  onDispatchTask,
  onStop,
  isGenerating,
  isTaskRunning = false,
  isCancelling = false,
  disabled = false,
  placeholder = 'Type a message... (Enter to send, Shift+Enter for newline)',
  bot = null,
  mode: controlledMode,
  onModeChange
}: ConversationComposerProps): ReactElement {
  const [content, setContent] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [internalMode, setInternalMode] = useState<ExecutionMode>('chat')
  const [workspaceAccessRequested, setWorkspaceAccessRequested] = useState<boolean>(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const mode = controlledMode ?? internalMode

  // Reset mode to 'chat' whenever switching bots to prevent accidental carryover
  const lastBotIdRef = useRef<string | undefined>(bot?.id)
  useEffect(() => {
    if (bot?.id !== lastBotIdRef.current) {
      lastBotIdRef.current = bot?.id
      setInternalMode('chat')
      onModeChange?.('chat')
      setWorkspaceAccessRequested(false)
    }
  }, [bot?.id, onModeChange])

  const handleModeSelect = (newMode: ExecutionMode): void => {
    setInternalMode(newMode)
    onModeChange?.(newMode)
  }

  const enabledTools = bot?.enabledTools ?? []
  const hasTools = enabledTools.length > 0

  const isBusy = isGenerating || isTaskRunning || isSubmitting
  const isBlank = !content.trim()
  const canSend = !disabled && !isBusy && !isBlank && (mode !== 'agent' || hasTools)

  const hasWorkspaceTools = Boolean(
    bot &&
    (isBotToolEnabled(bot.enabledTools, 'search_workspace_files') ||
      isBotToolEnabled(bot.enabledTools, 'read_workspace_file'))
  )

  const handleSubmit = async (): Promise<void> => {
    if (!canSend) {
      return
    }

    const trimmed = content.trim()
    setIsSubmitting(true)

    try {
      if (mode === 'agent' && onDispatchTask) {
        await onDispatchTask(trimmed, workspaceAccessRequested)
      } else {
        await onSend(trimmed)
      }

      // Only clear composer after send/dispatch operation is accepted
      setContent('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } catch {
      // Preserve content on failure so user does not lose input
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  // Auto-resize textarea as text grows
  const handleInput = (val: string): void => {
    setContent(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }

  const activePlaceholder = disabled
    ? 'Conversation input disabled'
    : mode === 'agent'
      ? `Assign an agent task to ${bot?.name ?? 'bot'}... (Enter to dispatch)`
      : placeholder

  return (
    <div
      className="chat-composer-container"
      data-testid="message-composer"
      style={{
        padding: '16px 20px',
        borderTop: '1px solid var(--color-border, #e2e8f0)',
        backgroundColor: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}
    >
      {/* Mode Selector Toggle (Chat vs Agent Task) */}
      <div
        className="composer-mode-selector"
        data-testid="composer-mode-selector"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}
      >
        <button
          type="button"
          className={`btn btn-sm ${mode === 'chat' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="composer-mode-chat-btn"
          aria-pressed={mode === 'chat'}
          onClick={() => handleModeSelect('chat')}
          disabled={isBusy || disabled}
          style={{
            padding: '3px 10px',
            fontSize: '11.5px',
            borderRadius: '14px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          <MessageSquare size={12} className="inline-icon" aria-hidden="true" />
          <span>Chat</span>
        </button>

        <button
          type="button"
          className={`btn btn-sm ${mode === 'agent' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="composer-mode-agent-btn"
          aria-pressed={mode === 'agent'}
          onClick={() => handleModeSelect('agent')}
          disabled={isBusy || disabled}
          style={{
            padding: '3px 10px',
            fontSize: '11.5px',
            borderRadius: '14px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          <Bot size={12} className="inline-icon" aria-hidden="true" />
          <span>Agent Task</span>
        </button>
      </div>

      {/* Agent Mode Capability & Tool Context */}
      {mode === 'agent' && (
        <div
          className="agent-mode-context-panel"
          data-testid="agent-mode-context-panel"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px'
          }}
        >
          {hasTools ? (
            <div
              className="agent-tools-info"
              data-testid="agent-tools-info"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                color: '#334155',
                padding: '4px 8px',
                borderRadius: '6px',
                backgroundColor: '#f1f5f9'
              }}
            >
              <Sparkles size={13} className="inline-icon text-accent" aria-hidden="true" />
              <span data-testid="agent-tools-count-badge" style={{ fontWeight: 600 }}>
                {enabledTools.length} tool{enabledTools.length === 1 ? '' : 's'} enabled:
              </span>
              <span data-testid="agent-tools-list" style={{ color: '#475569' }}>
                {enabledTools.map((t) => t.replace(/_/g, ' ')).join(', ')}
              </span>
            </div>
          ) : (
            <div
              className="agent-no-tools-warning"
              data-testid="agent-no-tools-warning"
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 10px',
                borderRadius: '6px',
                backgroundColor: '#fffbeb',
                border: '1px solid #fef3c7',
                color: '#b45309',
                fontSize: '12px'
              }}
            >
              <AlertCircle size={14} className="inline-icon text-warning" aria-hidden="true" />
              <span>
                This Bot has no enabled tools. Configure tools in Bot settings to execute Agent
                tasks.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Agent Task Mode Option: Workspace Folder Authorization Toggle */}
      {mode === 'agent' && hasTools && (
        <div
          className="workspace-access-container"
          data-testid="workspace-access-container"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '8px 12px',
            borderRadius: '8px',
            backgroundColor: '#f8fafc',
            border: '1px solid #e2e8f0',
            fontSize: '12px'
          }}
        >
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              cursor: hasWorkspaceTools && !isBusy && !disabled ? 'pointer' : 'not-allowed',
              color: hasWorkspaceTools ? '#1e293b' : '#94a3b8'
            }}
            data-testid="workspace-access-label"
          >
            <input
              type="checkbox"
              data-testid="workspace-access-checkbox"
              checked={workspaceAccessRequested}
              onChange={(e) => setWorkspaceAccessRequested(e.target.checked)}
              disabled={!hasWorkspaceTools || isBusy || disabled}
            />
            <span style={{ fontWeight: 500 }}>Allow this task to inspect a selected folder</span>
          </label>
          {workspaceAccessRequested && hasWorkspaceTools ? (
            <span
              className="text-muted"
              data-testid="workspace-access-notice"
              style={{ fontSize: '11px', color: '#64748b', paddingLeft: '22px' }}
            >
              Opens native folder picker on your operating system. Access applies only to this agent
              task.
            </span>
          ) : !hasWorkspaceTools ? (
            <span
              className="text-muted"
              data-testid="workspace-tools-disabled-notice"
              style={{ fontSize: '11px', color: '#94a3b8', paddingLeft: '22px' }}
            >
              (Bot has no workspace filesystem tools enabled in its configuration)
            </span>
          ) : null}
        </div>
      )}

      {/* Input box */}
      <div
        className="chat-composer-box"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '10px',
          padding: '8px 12px',
          border: '1px solid var(--color-border, #cbd5e1)',
          borderRadius: '10px',
          backgroundColor: disabled ? '#f8fafc' : '#ffffff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          transition: 'border-color 150ms ease, box-shadow 150ms ease'
        }}
      >
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          data-testid="message-input"
          aria-label={mode === 'agent' ? 'Agent task composer input' : 'Message composer input'}
          value={content}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isBusy}
          placeholder={activePlaceholder}
          rows={1}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: '13.5px',
            lineHeight: '1.5',
            maxHeight: '160px',
            minHeight: '24px',
            backgroundColor: 'transparent',
            color: 'var(--color-text-primary, #0f172a)',
            fontFamily: 'inherit',
            padding: '2px 0'
          }}
        />

        {(isGenerating || isTaskRunning) && onStop ? (
          <button
            type="button"
            className="btn btn-danger btn-sm chat-stop-btn"
            data-testid="stop-generation-btn"
            aria-label={isTaskRunning ? 'Stop agent task' : 'Stop generation'}
            onClick={() => void onStop()}
            disabled={isCancelling}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              flexShrink: 0,
              cursor: isCancelling ? 'not-allowed' : 'pointer'
            }}
          >
            {isCancelling ? (
              <Loader2 size={13} className="spinner inline-icon" aria-hidden="true" />
            ) : (
              <Square size={13} fill="currentColor" className="inline-icon" aria-hidden="true" />
            )}
            <span>{isCancelling ? 'Stopping...' : 'Stop'}</span>
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-sm ${mode === 'agent' ? 'btn-primary' : 'btn-primary'} chat-send-btn`}
            data-testid={mode === 'agent' ? 'dispatch-task-btn' : 'send-message-btn'}
            aria-label={mode === 'agent' ? 'Dispatch agent task' : 'Send message'}
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              flexShrink: 0,
              cursor: canSend ? 'pointer' : 'not-allowed'
            }}
          >
            {isSubmitting ? (
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
            ) : mode === 'agent' ? (
              <Sparkles size={14} className="inline-icon" aria-hidden="true" />
            ) : (
              <Send size={14} className="inline-icon" aria-hidden="true" />
            )}
            <span>{mode === 'agent' ? 'Dispatch Task' : 'Send'}</span>
          </button>
        )}
      </div>

      <div
        className="chat-composer-hints"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          color: 'var(--color-text-secondary, #94a3b8)',
          padding: '0 2px'
        }}
      >
        <span>
          {mode === 'agent'
            ? 'Press Enter to dispatch agent task, Shift+Enter for new line'
            : 'Press Enter to send, Shift+Enter for new line'}
        </span>
      </div>
    </div>
  )
}
