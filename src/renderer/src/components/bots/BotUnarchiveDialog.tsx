import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Loader2, RotateCcw, AlertCircle, Info } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'

export interface BotUnarchiveDialogProps {
  readonly isOpen: boolean
  readonly bot: BotDto | null
  readonly onClose: () => void
  readonly onSuccess?: (unarchivedBot: BotDto) => void
  readonly onUnarchive?: (botId: string) => Promise<BotDto>
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

export function BotUnarchiveDialog({
  isOpen,
  bot,
  onClose,
  onSuccess,
  onUnarchive
}: BotUnarchiveDialogProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !bot) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const executeUnarchive = onUnarchive ?? window.api?.bots?.unarchive
      if (!executeUnarchive) {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      const unarchivedBot = await executeUnarchive(bot.id)

      if (onSuccess) {
        onSuccess(unarchivedBot)
      }
      onClose()
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
      data-testid="unarchive-bot-dialog-backdrop"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unarchive-bot-title"
        data-testid="unarchive-bot-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <RotateCcw size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="unarchive-bot-title" className="modal-title">
              Restore Bot: {bot.name}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-unarchive-bot-dialog-btn"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {errorMessage && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              style={{ marginBottom: '14px' }}
            >
              <div className="alert-content-row">
                <AlertCircle
                  size={16}
                  className="warning-box-icon text-danger"
                  aria-hidden="true"
                />
                <span>{errorMessage}</span>
              </div>
            </div>
          )}

          <p className="modal-description" style={{ marginBottom: '12px' }}>
            Are you sure you want to unarchive <strong>{bot.name}</strong> and restore it to active
            status?
          </p>

          <div
            style={{
              display: 'flex',
              gap: '10px',
              padding: '12px',
              backgroundColor: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              color: '#166534',
              lineHeight: 1.45
            }}
          >
            <Info
              size={18}
              style={{ color: '#16a34a', flexShrink: 0, marginTop: '2px' }}
              aria-hidden="true"
            />
            <div>
              <p style={{ margin: 0, fontWeight: 500, color: '#14532d' }}>Restoration Details:</p>
              <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                <li>
                  This Bot will return to active status and be immediately available in this
                  Knowledge Base.
                </li>
                <li>
                  Its system instructions, assigned model, provider connection, and tool permissions
                  remain unchanged.
                </li>
                <li>
                  All previous conversation threads and stored memories remain intact and
                  accessible.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="unarchive-bot-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={isSubmitting}
            data-testid="unarchive-bot-confirm-btn"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                Restoring...
              </>
            ) : (
              'Restore to Active'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
