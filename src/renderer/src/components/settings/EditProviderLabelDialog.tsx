import { ReactElement, useState, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, Pencil } from 'lucide-react'
import type { ProviderConnectionSummary } from '../../../../shared/providers'

export interface EditProviderLabelDialogProps {
  readonly isOpen?: boolean
  readonly connection: ProviderConnectionSummary | null
  readonly onClose: () => void
  readonly onSuccess: (updated: ProviderConnectionSummary) => void
}

export function EditProviderLabelDialog({
  isOpen = true,
  connection,
  onClose,
  onSuccess
}: EditProviderLabelDialogProps): ReactElement | null {
  const [label, setLabel] = useState<string>(connection?.label ?? '')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !connection) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setErrorMessage(null)

    const trimmedLabel = label.trim()
    if (!trimmedLabel) {
      setErrorMessage('Connection label cannot be blank.')
      return
    }

    setIsSubmitting(true)

    try {
      const updated = await window.api.providers.updateConnectionLabel({
        connectionId: connection.id,
        label: trimmedLabel
      })

      onSuccess(updated)
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update connection label.'
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
      data-testid="edit-label-dialog"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-label-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Pencil size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="edit-label-title" className="modal-title">
              Edit Connection Label
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

        <form onSubmit={handleSubmit} noValidate>
          <div className="modal-body">
            {errorMessage && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                data-testid="edit-label-error"
              >
                {errorMessage}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="edit-connection-label" className="form-label">
                Connection Label
              </label>
              <input
                id="edit-connection-label"
                type="text"
                className="form-input"
                value={label}
                disabled={isSubmitting}
                onChange={(e) => setLabel(e.target.value)}
                autoComplete="off"
                data-testid="edit-label-input"
              />
              <span className="form-helper">
                Update the display name used for this connection across your workspace.
              </span>
            </div>
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
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
              data-testid="submit-edit-label-button"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="inline-icon spinner" aria-hidden="true" />
                  Saving...
                </>
              ) : (
                'Save Label'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
