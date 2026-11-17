import { ReactElement, useState, useEffect, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, Trash2, AlertTriangle, ShieldCheck } from 'lucide-react'
import type { BotDto, DeleteBotResultDto } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'
import type { DeletionPreviewDto } from '../../../../shared/deletion'

export interface BotDeleteDialogProps {
  readonly isOpen: boolean
  readonly bot: BotDto | null
  readonly onClose: () => void
  readonly onSuccess?: (result: DeleteBotResultDto) => void
  readonly onDelete?: (botId: string, confirmName?: string) => Promise<DeleteBotResultDto>
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof BotBridgeError) {
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

export function BotDeleteDialog({
  isOpen,
  bot,
  onClose,
  onSuccess,
  onDelete
}: BotDeleteDialogProps): ReactElement | null {
  const [confirmName, setConfirmName] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<DeletionPreviewDto | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false)

  useEffect(() => {
    if (!isOpen || !bot) return

    let isCancelled = false
    const loadPreview = async (): Promise<void> => {
      setIsLoadingPreview(true)
      try {
        if (window.api?.deletion?.getPreview) {
          const res = await window.api.deletion.getPreview('bot', bot.id)
          if (!isCancelled) setPreview(res)
        } else if (window.api?.bots?.getDeletionPreview) {
          const res = await window.api.bots.getDeletionPreview(bot.id)
          if (!isCancelled) setPreview(res)
        }
      } catch {
        // Fall back gracefully
      } finally {
        if (!isCancelled) setIsLoadingPreview(false)
      }
    }

    void loadPreview()
    return () => {
      isCancelled = true
    }
  }, [isOpen, bot])

  if (!isOpen || !bot) return null

  const isConfirmed = confirmName.trim() === bot.name.trim()
  const isOperationBlocked = preview?.isBlocked ?? false

  const handleClose = (): void => {
    if (isSubmitting) return
    setConfirmName('')
    setErrorMessage(null)
    setPreview(null)
    onClose()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      handleClose()
    }
  }

  const handleDelete = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isConfirmed || isSubmitting || isOperationBlocked) return

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      let result: DeleteBotResultDto
      if (onDelete) {
        result = await onDelete(bot.id)
      } else if (window.api?.deletion?.deleteEntity) {
        const res = await window.api.deletion.deleteEntity({
          entityType: 'bot',
          entityId: bot.id,
          confirmName
        })
        result = { success: res.success, botId: res.entityId }
      } else if (window.api?.bots?.delete) {
        result = await window.api.bots.delete(bot.id)
      } else {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      if (result.success) {
        if (onSuccess) {
          onSuccess(result)
        }
        onClose()
      } else {
        setErrorMessage('Failed to delete Bot from database.')
      }
    } catch (err: unknown) {
      const sanitized = sanitizeErrorMessage(err)
      setErrorMessage(sanitized)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="delete-bot-dialog-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-danger modal-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-bot-title"
        data-testid="delete-bot-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Trash2 size={20} className="modal-title-icon text-danger" aria-hidden="true" />
            <h2 id="delete-bot-title" className="modal-title">
              Delete Bot Permanently
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-delete-bot-dialog-btn"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleDelete} noValidate>
          <div
            className="modal-body"
            style={{ overflowY: 'auto', maxHeight: 'calc(90vh - 130px)' }}
          >
            {errorMessage && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                style={{ marginBottom: '14px' }}
              >
                <span data-testid="delete-bot-error">{errorMessage}</span>
              </div>
            )}

            {isLoadingPreview && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  color: 'var(--color-text-secondary)',
                  marginBottom: '14px'
                }}
              >
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                <span>Analyzing Bot dependencies...</span>
              </div>
            )}

            {preview?.isBlocked && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                data-testid="delete-bot-blocked-alert"
                style={{ marginBottom: '14px' }}
              >
                <span>
                  {preview.blockReason ??
                    'Cannot delete Bot while active operations or generations are running.'}
                </span>
              </div>
            )}

            {/* Permanent CASCADE Deletion Warning Box */}
            <div className="removal-warning-box" style={{ marginBottom: '14px' }}>
              <AlertTriangle size={24} className="warning-box-icon" aria-hidden="true" />
              <div>
                <p className="warning-box-heading">
                  Irreversible Cascade Deletion: <strong>{bot.name}</strong>
                </p>
                <p className="warning-box-text">
                  Deleting this Bot invokes an unrecoverable database cascade. The following data
                  will be permanently deleted:
                </p>
                <ul className="delete-scope-list" style={{ color: '#991b1b', marginTop: '6px' }}>
                  <li>
                    All conversation threads associated with this Bot
                    {preview?.dependentCounts.conversations !== undefined
                      ? ` (${preview.dependentCounts.conversations} threads)`
                      : ''}
                    .
                  </li>
                  <li>
                    All user prompts and assistant message histories
                    {preview?.dependentCounts.messages !== undefined
                      ? ` (${preview.dependentCounts.messages} messages)`
                      : ''}
                    .
                  </li>
                  <li>
                    All autonomous agent execution runs and recorded tool invocation events
                    {preview?.dependentCounts.agentRuns !== undefined
                      ? ` (${preview.dependentCounts.agentRuns} runs, ${preview.dependentCounts.toolEvents ?? 0} events)`
                      : ''}
                    .
                  </li>
                  <li>
                    All persistent Bot memories and task state
                    {preview?.dependentCounts.memories !== undefined
                      ? ` (${preview.dependentCounts.memories} memories)`
                      : ''}
                    .
                  </li>
                </ul>
              </div>
            </div>

            {/* Explicit Knowledge Base Preservation Guarantee */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                padding: '12px 14px',
                backgroundColor: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: 'var(--radius-md)',
                fontSize: '12px',
                color: '#166534',
                lineHeight: 1.45,
                marginBottom: '16px'
              }}
            >
              <ShieldCheck
                size={22}
                style={{ color: '#16a34a', flexShrink: 0, marginTop: '2px' }}
                aria-hidden="true"
              />
              <div>
                <strong style={{ color: '#14532d', display: 'block', marginBottom: '2px' }}>
                  Protected Workspace Assets (Will NOT Be Deleted):
                </strong>
                <ul
                  className="delete-scope-list"
                  style={{ color: '#15803d', margin: '4px 0 0 16px', padding: 0 }}
                >
                  <li>The parent Knowledge Base itself remains untouched.</li>
                  <li>
                    All ingested document sources, extracted chunks, and FTS5 search indexes remain
                    intact.
                  </li>
                  <li>All sibling Bots and configured provider API connections are unaffected.</li>
                </ul>
              </div>
            </div>

            {/* Confirmation Input */}
            <div className="form-group">
              <label htmlFor="confirm-delete-bot-input" className="form-label">
                To confirm permanent deletion, type <strong>{bot.name}</strong> below:
              </label>
              <input
                id="confirm-delete-bot-input"
                data-testid="confirm-delete-bot-input"
                type="text"
                className="form-input"
                placeholder={bot.name}
                value={confirmName}
                disabled={isSubmitting}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              disabled={isSubmitting}
              data-testid="delete-bot-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!isConfirmed || isSubmitting || isOperationBlocked}
              data-testid="delete-bot-confirm-btn"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                  Deleting Permanently...
                </>
              ) : (
                'Delete Bot Permanently'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
