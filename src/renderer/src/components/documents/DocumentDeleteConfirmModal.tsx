import { ReactElement, useState, useEffect } from 'react'
import { AlertTriangle, Trash2, X, Loader2, Info } from 'lucide-react'
import type { DeletionPreviewDto } from '../../../../shared/deletion'

export interface DocumentDeleteConfirmModalProps {
  readonly isOpen: boolean
  readonly documentName: string
  readonly sourceId?: string
  readonly isDeleting: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function DocumentDeleteConfirmModal({
  isOpen,
  documentName,
  sourceId,
  isDeleting,
  onConfirm,
  onCancel
}: DocumentDeleteConfirmModalProps): ReactElement | null {
  const [preview, setPreview] = useState<DeletionPreviewDto | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false)

  useEffect(() => {
    if (!isOpen || !sourceId) return

    let isCancelled = false
    const loadPreview = async (): Promise<void> => {
      setIsLoadingPreview(true)
      try {
        if (window.api?.deletion?.getPreview) {
          const res = await window.api.deletion.getPreview('knowledge_source', sourceId)
          if (!isCancelled) setPreview(res)
        } else if (window.api?.knowledgeDocuments?.getDeletionPreview) {
          const res = await window.api.knowledgeDocuments.getDeletionPreview(sourceId)
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
  }, [isOpen, sourceId])

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

  const isOperationBlocked = preview?.isBlocked ?? false

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

          {isLoadingPreview && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--color-text-secondary)',
                marginTop: '8px',
                marginBottom: '8px'
              }}
              data-testid="loading-document-preview"
            >
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
              <span>Analyzing document dependencies...</span>
            </div>
          )}

          {preview?.dependentCounts?.chunks !== undefined && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--color-text-secondary)',
                marginBottom: '10px'
              }}
              data-testid="document-chunks-count"
            >
              Extracted search chunks to delete:{' '}
              <strong style={{ color: 'var(--color-text-primary)' }}>
                {preview.dependentCounts.chunks}
              </strong>
            </div>
          )}

          <div
            className="section-alert section-alert-warning"
            role="note"
            style={{ marginTop: '10px' }}
          >
            <span>
              This operation safely removes the original managed file, all indexed text chunks, and
              all full-text search entries. Bots in this Knowledge Base will no longer have access
              to this content.
            </span>
          </div>

          <div
            className="section-alert section-alert-info"
            role="status"
            style={{ marginTop: '10px' }}
            data-testid="document-citation-safety-alert"
          >
            <Info size={16} className="inline-icon text-accent" aria-hidden="true" />
            <span>
              Historical conversation messages citing this document will remain, but citations
              referencing it will safely indicate the source file was removed.
            </span>
          </div>

          {preview?.isBlocked && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="delete-document-blocked-alert"
              style={{ marginTop: '10px' }}
            >
              <span>
                {preview.blockReason ?? 'Cannot delete document while indexing is in progress.'}
              </span>
            </div>
          )}
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
            disabled={isDeleting || isOperationBlocked}
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
