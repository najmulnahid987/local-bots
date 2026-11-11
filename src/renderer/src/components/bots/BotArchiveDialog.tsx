import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Loader2, Archive, AlertCircle, Info } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'

export interface BotArchiveDialogProps {
  readonly isOpen: boolean
  readonly bot: BotDto | null
  readonly onClose: () => void
  readonly onSuccess?: (archivedBot: BotDto) => void
  readonly onArchive?: (botId: string) => Promise<BotDto>
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

export function BotArchiveDialog({
  isOpen,
  bot,
  onClose,
  onSuccess,
  onArchive
}: BotArchiveDialogProps): ReactElement | null {
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
      const executeArchive = onArchive ?? window.api?.bots?.archive
      if (!executeArchive) {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      const archivedBot = await executeArchive(bot.id)

      if (onSuccess) {
        onSuccess(archivedBot)
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
      data-testid="archive-bot-dialog-backdrop"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-bot-title"
        data-testid="archive-bot-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Archive size={20} className="modal-title-icon text-muted" aria-hidden="true" />
            <h2 id="archive-bot-title" className="modal-title">
              Archive Bot: {bot.name}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-archive-bot-dialog-btn"
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
            Are you sure you want to archive <strong>{bot.name}</strong>?
          </p>

          <div
            style={{
              display: 'flex',
              gap: '10px',
              padding: '12px',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.45
            }}
          >
            <Info
              size={18}
              style={{ color: '#64748b', flexShrink: 0, marginTop: '2px' }}
              aria-hidden="true"
            />
            <div>
              <p style={{ margin: 0, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                Archive Details:
              </p>
              <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                <li>
                  This Bot will no longer be considered active or appear in active Bot listings.
                </li>
                <li>
                  Existing conversation history and messages remain stored and preserved in the
                  Knowledge Base.
                </li>
                <li>You can restore this Bot to active status at any time by unarchiving it.</li>
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
            data-testid="archive-bot-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={isSubmitting}
            data-testid="archive-bot-confirm-btn"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                Archiving...
              </>
            ) : (
              'Archive Bot'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
