import { ReactElement, useState, useEffect, KeyboardEvent } from 'react'
import { X, Loader2, Eraser, AlertTriangle, Info } from 'lucide-react'
import {
  type ConversationDto,
  type ClearConversationPreviewDto,
  ConversationBridgeError
} from '../../../../shared/conversations'

export interface ClearConversationDialogProps {
  readonly isOpen: boolean
  readonly conversation: ConversationDto | null
  readonly botName?: string
  readonly isGenerating?: boolean
  readonly isTaskActive?: boolean
  readonly onClose: () => void
  readonly onConfirm: (conversationId: string) => Promise<void>
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof ConversationBridgeError) {
    return err.message
  }
  const rawMsg = err instanceof Error ? err.message : String(err)
  return rawMsg
    .replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

export function ClearConversationDialog({
  isOpen,
  conversation,
  botName,
  isGenerating = false,
  isTaskActive = false,
  onClose,
  onConfirm
}: ClearConversationDialogProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<ClearConversationPreviewDto | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(Boolean(isOpen && conversation))

  const dialogKey = `${String(isOpen)}::${conversation?.id ?? ''}`
  const [prevDialogKey, setPrevDialogKey] = useState<string>(dialogKey)
  if (dialogKey !== prevDialogKey) {
    setPrevDialogKey(dialogKey)
    setPreview(null)
    setErrorMessage(null)
    setIsLoadingPreview(Boolean(isOpen && conversation))
  }

  useEffect(() => {
    if (!isOpen || !conversation) {
      return
    }

    let isCancelled = false
    const loadPreview = async (): Promise<void> => {
      try {
        const api = window.api?.conversation ?? window.api?.conversations
        if (api?.getClearPreview) {
          const res = await api.getClearPreview(conversation.id)
          if (!isCancelled) setPreview(res)
        }
      } catch {
        // Fall back gracefully to static confirmation summary
      } finally {
        if (!isCancelled) setIsLoadingPreview(false)
      }
    }

    void loadPreview()
    return () => {
      isCancelled = true
    }
  }, [isOpen, conversation])

  if (!isOpen || !conversation) return null

  const isOperationBlocked = isGenerating || isTaskActive || (preview?.isBlocked ?? false)
  const effectiveBlockReason =
    preview?.blockReason ??
    (isTaskActive
      ? 'An Agent Task is currently running. Stop the task before clearing this conversation.'
      : isGenerating
        ? 'Generation is currently active for this conversation. Stop generation before clearing.'
        : undefined)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleClear = async (): Promise<void> => {
    if (isSubmitting || isOperationBlocked) return

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      await onConfirm(conversation.id)
      onClose()
    } catch (err: unknown) {
      setErrorMessage(sanitizeErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="clear-conversation-dialog-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-conversation-title"
        aria-describedby="clear-conversation-desc"
        data-testid="clear-conversation-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Eraser size={20} className="modal-title-icon text-danger" aria-hidden="true" />
            <h2 id="clear-conversation-title" className="modal-title">
              Clear Conversation
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-clear-dialog-btn"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <p id="clear-conversation-desc" style={{ marginBottom: '16px' }}>
            Are you sure you want to clear all messages in{' '}
            <strong data-testid="clear-conversation-target-title">
              {botName ?? conversation.title}
            </strong>
            ?
          </p>

          <div
            className="section-alert section-alert-warning"
            role="status"
            style={{ marginBottom: '12px' }}
          >
            <AlertTriangle size={18} className="inline-icon text-warning" aria-hidden="true" />
            <div className="alert-body">
              <strong>Permanent Message Clearing</strong>
              <span>
                All messages and historical conversation segment markers in this conversation will
                be permanently removed and cannot be recovered.
              </span>
            </div>
          </div>

          <div className="section-alert section-alert-info" role="status">
            <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
            <div className="alert-body">
              <strong>Preserved Workspace &amp; Audit Data</strong>
              <span>
                This Bot&apos;s persistent conversation workspace, Knowledge Base documents, saved
                Bot Memories, instructions, and Agent Task audit logs remain preserved.
              </span>
            </div>
          </div>

          {isLoadingPreview && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--color-text-secondary)',
                marginTop: '12px'
              }}
              data-testid="loading-clear-preview-indicator"
            >
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
              <span>Checking conversation history...</span>
            </div>
          )}

          {preview && (
            <div
              className="deletion-preview-card"
              data-testid="clear-preview-summary"
              style={{
                padding: '10px 12px',
                backgroundColor: 'var(--color-bg-secondary, #f8fafc)',
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 'var(--radius-md, 6px)',
                marginTop: '12px',
                fontSize: '12px'
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: '4px',
                  color: 'var(--color-text-primary)'
                }}
              >
                Summary:
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--color-text-secondary)' }}>
                <li>
                  Messages to clear: <strong>{preview.messageCount}</strong>
                </li>
                {preview.segmentCount > 1 && (
                  <li>
                    Historical threads to reset: <strong>{preview.segmentCount}</strong>
                  </li>
                )}
                {preview.agentRunCount > 0 && (
                  <li>
                    Agent Task audit runs preserved: <strong>{preview.agentRunCount}</strong>
                  </li>
                )}
                {preview.toolEventCount > 0 && (
                  <li>
                    Tool audit events preserved: <strong>{preview.toolEventCount}</strong>
                  </li>
                )}
              </ul>
            </div>
          )}

          {isOperationBlocked && effectiveBlockReason && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="clear-generating-warning"
              style={{ marginTop: '12px' }}
            >
              <span>{effectiveBlockReason}</span>
            </div>
          )}

          {errorMessage && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="clear-conversation-error"
              style={{ marginTop: '12px' }}
            >
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="cancel-clear-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void handleClear()}
            disabled={isSubmitting || isOperationBlocked}
            data-testid="confirm-clear-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                <span>Clearing...</span>
              </>
            ) : (
              <>
                <Eraser size={14} className="inline-icon" aria-hidden="true" />
                <span>Clear Conversation</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
