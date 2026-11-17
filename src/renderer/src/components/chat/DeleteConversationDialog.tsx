import { ReactElement, useState, useEffect, KeyboardEvent } from 'react'
import { X, Loader2, Trash2, AlertTriangle, Info } from 'lucide-react'
import type { ConversationDto } from '../../../../shared/conversations'
import { ConversationBridgeError } from '../../../../shared/conversations'
import type { DeletionPreviewDto } from '../../../../shared/deletion'

export interface DeleteConversationDialogProps {
  readonly isOpen: boolean
  readonly conversation: ConversationDto | null
  readonly isGenerating?: boolean
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

export function DeleteConversationDialog({
  isOpen,
  conversation,
  isGenerating = false,
  onClose,
  onConfirm
}: DeleteConversationDialogProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<DeletionPreviewDto | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false)

  useEffect(() => {
    if (!isOpen || !conversation) return

    let isCancelled = false
    const loadPreview = async (): Promise<void> => {
      setIsLoadingPreview(true)
      try {
        if (window.api?.deletion?.getPreview) {
          const res = await window.api.deletion.getPreview('conversation', conversation.id)
          if (!isCancelled) setPreview(res)
        } else if (window.api?.conversations?.getDeletionPreview) {
          const res = await window.api.conversations.getDeletionPreview(conversation.id)
          if (!isCancelled) setPreview(res)
        }
      } catch {
        // Fall back gracefully to static dialog
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

  const isOperationBlocked = isGenerating || (preview?.isBlocked ?? false)
  const effectiveBlockReason =
    preview?.blockReason ??
    (isGenerating
      ? 'Generation is currently active for this conversation. You must stop generation before deleting.'
      : undefined)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleDelete = async (): Promise<void> => {
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
      data-testid="delete-conversation-dialog-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-conversation-title"
        aria-describedby="delete-conversation-desc"
        data-testid="delete-conversation-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Trash2 size={20} className="modal-title-icon text-danger" aria-hidden="true" />
            <h2 id="delete-conversation-title" className="modal-title">
              Delete Conversation
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-delete-dialog-btn"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <p id="delete-conversation-desc" style={{ marginBottom: '16px' }}>
            Are you sure you want to permanently delete{' '}
            <strong data-testid="delete-conversation-target-title">{conversation.title}</strong>?
          </p>

          <div
            className="section-alert section-alert-warning"
            role="status"
            style={{ marginBottom: '12px' }}
          >
            <AlertTriangle size={18} className="inline-icon text-warning" aria-hidden="true" />
            <div className="alert-body">
              <strong>Permanent Deletion</strong>
              <span>
                All messages and message history in this conversation thread will be permanently
                deleted and cannot be recovered.
              </span>
            </div>
          </div>

          <div className="section-alert section-alert-info" role="status">
            <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
            <div className="alert-body">
              <strong>Knowledge Base Preserved</strong>
              <span>
                Knowledge Base documents, search indexes, and Bot instructions are not deleted by
                this operation.
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
              data-testid="loading-preview-indicator"
            >
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
              <span>Analyzing conversation dependencies...</span>
            </div>
          )}

          {preview && (
            <div
              className="deletion-preview-card"
              data-testid="deletion-preview-summary"
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
                Affected Items:
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--color-text-secondary)' }}>
                <li>
                  Messages: <strong>{preview.dependentCounts.messages ?? 0}</strong>
                </li>
                {(preview.dependentCounts.agentRuns ?? 0) > 0 && (
                  <li>
                    Autonomous Agent Tasks: <strong>{preview.dependentCounts.agentRuns}</strong>
                  </li>
                )}
                {(preview.dependentCounts.toolEvents ?? 0) > 0 && (
                  <li>
                    Recorded Tool Events: <strong>{preview.dependentCounts.toolEvents}</strong>
                  </li>
                )}
              </ul>
            </div>
          )}

          {isOperationBlocked && effectiveBlockReason && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="delete-generating-warning"
              style={{ marginTop: '12px' }}
            >
              <span>{effectiveBlockReason}</span>
            </div>
          )}

          {errorMessage && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="delete-conversation-error"
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
            data-testid="cancel-delete-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void handleDelete()}
            disabled={isSubmitting || isOperationBlocked}
            data-testid="confirm-delete-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                <span>Deleting...</span>
              </>
            ) : (
              <>
                <Trash2 size={14} className="inline-icon" aria-hidden="true" />
                <span>Delete Conversation</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
