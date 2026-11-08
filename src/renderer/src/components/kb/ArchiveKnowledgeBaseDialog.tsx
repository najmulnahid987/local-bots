import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Loader2, Archive, AlertTriangle, Info } from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

export interface ArchiveKnowledgeBaseDialogProps {
  readonly isOpen: boolean
  readonly knowledgeBase: KnowledgeBaseDto | null
  readonly isActiveWorkspace: boolean
  readonly onClose: () => void
  readonly onSuccess?: (kb: KnowledgeBaseDto) => void
}

export function ArchiveKnowledgeBaseDialog({
  isOpen,
  knowledgeBase,
  isActiveWorkspace,
  onClose,
  onSuccess
}: ArchiveKnowledgeBaseDialogProps): ReactElement | null {
  const { archiveKnowledgeBase } = useKnowledgeBases()

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !knowledgeBase) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleConfirmArchive = async (): Promise<void> => {
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const updated = await archiveKnowledgeBase(knowledgeBase.id)
      if (updated && onSuccess) {
        onSuccess(updated)
      }
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to archive Knowledge Base.'
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
      data-testid="archive-kb-dialog-backdrop"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-kb-title"
        data-testid="archive-kb-dialog"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Archive size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="archive-kb-title" className="modal-title">
              Archive Knowledge Base
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-archive-kb"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {errorMessage && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              data-testid="archive-kb-error"
            >
              {errorMessage}
            </div>
          )}

          <p className="modal-description">
            Are you sure you want to archive <strong>{knowledgeBase.name}</strong>?
          </p>

          <div className="removal-note">
            <Info
              size={18}
              className="text-secondary"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            />
            <div>
              <p
                style={{ margin: '0 0 4px 0', fontWeight: 600, color: 'var(--color-text-primary)' }}
              >
                Data is preserved
              </p>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                Archiving hides this Knowledge Base from active workspace selection and stops active
                queries. All documents, bots, and conversation histories remain safely preserved and
                can be restored at any time.
              </p>
            </div>
          </div>

          {isActiveWorkspace && (
            <div className="removal-warning-box">
              <AlertTriangle size={20} className="warning-box-icon" aria-hidden="true" />
              <div>
                <p className="warning-box-heading">Active Workspace Warning</p>
                <p className="warning-box-text">
                  This Knowledge Base is currently your <strong>active workspace</strong>. Archiving
                  it will immediately clear your active workspace selection.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="btn-cancel-archive-kb"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleConfirmArchive()}
            disabled={isSubmitting}
            data-testid="btn-confirm-archive-kb"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />{' '}
                Archiving...
              </>
            ) : (
              'Archive Knowledge Base'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
