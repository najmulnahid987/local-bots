import { ReactElement, useEffect } from 'react'
import { Copy, AlertCircle, X, Loader2 } from 'lucide-react'
import { formatBytes } from '../../utils/formatters'

export interface DocumentDuplicateModalProps {
  readonly isOpen: boolean
  readonly existingFileName?: string
  readonly existingFileSize?: number
  readonly isImporting: boolean
  readonly onConfirmDuplicate: () => void
  readonly onCancel: () => void
}

export function DocumentDuplicateModal({
  isOpen,
  existingFileName,
  existingFileSize,
  isImporting,
  onConfirmDuplicate,
  onCancel
}: DocumentDuplicateModalProps): ReactElement | null {
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isImporting) {
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isImporting, onCancel])

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-modal-title"
      data-testid="document-duplicate-modal"
    >
      <div className="modal-container">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <Copy size={20} className="inline-icon text-accent" aria-hidden="true" />
            <h3 id="duplicate-modal-title" className="modal-title">
              Duplicate Document Detected
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onCancel}
            disabled={isImporting}
            aria-label="Close duplicate notice"
            data-testid="btn-cancel-duplicate-x"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <div className="section-alert section-alert-info">
            <AlertCircle size={18} className="inline-icon text-accent" aria-hidden="true" />
            <div className="alert-body">
              <strong>Identical Document Already Exists</strong>
              <span>
                A document with identical content (
                <strong data-testid="duplicate-existing-filename">
                  {existingFileName || 'Existing file'}
                </strong>
                {existingFileSize !== undefined && ` • ${formatBytes(existingFileSize)}`}) is
                already indexed in this Knowledge Base.
              </span>
            </div>
          </div>
          <p className="modal-body-text" style={{ marginTop: '12px' }}>
            Would you like to import another copy anyway, or cancel?
          </p>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isImporting}
            data-testid="btn-cancel-duplicate"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirmDuplicate}
            disabled={isImporting}
            data-testid="btn-confirm-duplicate"
          >
            {isImporting ? (
              <>
                <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />
                <span>Importing Copy...</span>
              </>
            ) : (
              <span>Import Duplicate Copy</span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
