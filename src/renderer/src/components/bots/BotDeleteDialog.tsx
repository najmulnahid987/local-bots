import { ReactElement, useState, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, Trash2, AlertTriangle, ShieldCheck } from 'lucide-react'
import type { BotDto, DeleteBotResultDto } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'

export interface BotDeleteDialogProps {
  readonly isOpen: boolean
  readonly bot: BotDto | null
  readonly onClose: () => void
  readonly onSuccess?: (result: DeleteBotResultDto) => void
  readonly onDelete?: (botId: string) => Promise<DeleteBotResultDto>
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

  if (!isOpen || !bot) return null

  const isConfirmed = confirmName.trim() === bot.name.trim()

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleDelete = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isConfirmed || isSubmitting) return

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const executeDelete = onDelete ?? window.api?.bots?.delete
      if (!executeDelete) {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      const result = await executeDelete(bot.id)

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
            onClick={onClose}
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
                  <li>All conversation threads associated with this Bot.</li>
                  <li>All user prompts and assistant message histories.</li>
                  <li>All autonomous agent execution runs and recorded tool invocation events.</li>
                  <li>All persistent Bot memories and task state.</li>
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
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="delete-bot-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!isConfirmed || isSubmitting}
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
