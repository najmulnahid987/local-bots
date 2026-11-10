import { ReactElement, useEffect } from 'react'
import { AlertTriangle, Trash2, X, Loader2 } from 'lucide-react'

export interface DocumentDeleteConfirmModalProps {
  readonly isOpen: boolean
  readonly documentName: string
  readonly isDeleting: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function DocumentDeleteConfirmModal({
  isOpen,
  documentName,
  isDeleting,
  onConfirm,
  onCancel
}: DocumentDeleteConfirmModalProps): ReactElement | null {
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isDeleting) {
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isDeleting, onCancel])

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      aria-describedby="delete-modal-desc"
      data-testid="document-delete-modal"
    >
      <div className="modal-container document-delete-modal-container">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <AlertTriangle size={20} className="inline-icon text-danger" aria-hidden="true" />
            <h3 id="delete-modal-title" className="modal-title text-danger">
              Delete Document
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onCancel}
            disabled={isDeleting}
            aria-label="Cancel deletion"
            data-testid="btn-cancel-delete-x"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <p id="delete-modal-desc" className="modal-body-text">
            Are you sure you want to permanently delete{' '}
            <strong data-testid="delete-document-name">&ldquo;{documentName}&rdquo;</strong>?
          </p>
          <div
            className="section-alert section-alert-warning"
            role="note"
            style={{ marginTop: '12px' }}
          >
            <span>
              This operation safely removes the original managed file, all indexed text chunks, and
              all full-text search entries. Bots in this Knowledge Base will no longer have access
              to this content.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isDeleting}
            data-testid="btn-cancel-delete"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={isDeleting}
            data-testid="btn-confirm-delete"
          >
            {isDeleting ? (
              <>
                <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />
                <span>Deleting...</span>
              </>
            ) : (
              <>
                <Trash2 size={16} className="inline-icon" aria-hidden="true" />
                <span>Delete Permanently</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
