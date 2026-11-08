import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Loader2, Trash2, AlertTriangle, Info } from 'lucide-react'
import type {
  ProviderConnectionSummary,
  RemoveConnectionResult
} from '../../../../shared/providers'

export interface RemoveProviderConnectionDialogProps {
  readonly isOpen?: boolean
  readonly connection: ProviderConnectionSummary | null
  readonly onClose: () => void
  readonly onSuccess: (result: RemoveConnectionResult) => void
}

export function RemoveProviderConnectionDialog({
  isOpen = true,
  connection,
  onClose,
  onSuccess
}: RemoveProviderConnectionDialogProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cleanupWarning, setCleanupWarning] = useState<string | null>(null)

  if (!isOpen || !connection) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleConfirmRemove = async (): Promise<void> => {
    setIsSubmitting(true)
    setErrorMessage(null)
    setCleanupWarning(null)

    try {
      const res = await window.api.providers.removeConnection({
        connectionId: connection.id
      })

      if (res.success) {
        if (!res.credentialCleaned) {
          // Metadata was deleted, but vault file removal is pending
          setCleanupWarning(
            'Connection metadata was removed. Operating system vault cleanup is pending.'
          )
        }
        onSuccess(res)
        onClose()
      } else {
        setErrorMessage('Failed to remove provider connection.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove provider connection.'
      setErrorMessage(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="remove-connection-dialog"
    >
      <div
        className="modal-dialog modal-dialog-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-connection-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Trash2 size={20} className="modal-title-icon text-danger" aria-hidden="true" />
            <h2 id="remove-connection-title" className="modal-title">
              Remove Provider Connection
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="removal-warning-box">
            <AlertTriangle size={24} className="warning-box-icon" aria-hidden="true" />
            <div>
              <p className="warning-box-heading">
                Are you sure you want to delete <strong>{connection.label}</strong>?
              </p>
              <p className="warning-box-text">
                This action permanently deletes this connection record from your local database and
                purges its encrypted credential file from the operating system vault.
              </p>
            </div>
          </div>

          <div className="removal-note">
            <Info size={14} className="inline-icon" aria-hidden="true" />
            <span>
              If any active AI Bot is configured to use this provider connection, deletion will be
              rejected by database foreign key constraints.
            </span>
          </div>

          {errorMessage && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              data-testid="remove-connection-error"
            >
              {errorMessage}
            </div>
          )}

          {cleanupWarning && (
            <div
              className="form-alert form-alert-warning"
              role="status"
              data-testid="remove-cleanup-warning"
            >
              {cleanupWarning}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleConfirmRemove}
            disabled={isSubmitting}
            data-testid="confirm-remove-button"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="inline-icon spinner" aria-hidden="true" />
                Removing...
              </>
            ) : (
              'Remove Connection'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
