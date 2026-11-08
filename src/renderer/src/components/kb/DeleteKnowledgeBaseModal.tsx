import { ReactElement, useState, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, Trash2, AlertTriangle, AlertCircle } from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'
import type {
  KnowledgeBaseDto,
  DeleteKnowledgeBaseResult
} from '../../../../shared/knowledge-bases'

export interface DeleteKnowledgeBaseModalProps {
  readonly isOpen: boolean
  readonly knowledgeBase: KnowledgeBaseDto | null
  readonly onClose: () => void
  readonly onSuccess?: (result: DeleteKnowledgeBaseResult, kbName: string) => void
}

export function DeleteKnowledgeBaseModal({
  isOpen,
  knowledgeBase,
  onClose,
  onSuccess
}: DeleteKnowledgeBaseModalProps): ReactElement | null {
  const { deleteKnowledgeBase } = useKnowledgeBases()

  const [confirmName, setConfirmName] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !knowledgeBase) return null

  const isNameMatching = confirmName.trim() === knowledgeBase.name.trim()

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleDelete = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isNameMatching || isSubmitting) return

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const result = await deleteKnowledgeBase(knowledgeBase.id)
      if (result.success) {
        if (onSuccess) {
          onSuccess(result, knowledgeBase.name)
        }
        onClose()
      } else {
        const errorDetail = result.error || 'Failed to delete Knowledge Base from database.'
        setErrorMessage(errorDetail)
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred during deletion.'
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
      data-testid="delete-kb-modal-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-kb-title"
        data-testid="delete-kb-modal"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Trash2 size={20} className="modal-title-icon text-danger" aria-hidden="true" />
            <h2 id="delete-kb-title" className="modal-title">
              Delete Knowledge Base Permanently
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-delete-kb"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleDelete} noValidate>
          <div className="modal-body">
            {errorMessage && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                data-testid="delete-kb-error"
              >
                {errorMessage}
              </div>
            )}

            <div className="removal-warning-box">
              <AlertTriangle size={24} className="warning-box-icon" aria-hidden="true" />
              <div>
                <p className="warning-box-heading">This action cannot be undone</p>
                <p className="warning-box-text">
                  Deleting <strong>{knowledgeBase.name}</strong> will permanently remove:
                </p>
                <ul
                  style={{
                    margin: '6px 0 0 16px',
                    padding: 0,
                    fontSize: '12px',
                    color: '#991b1b',
                    listStyleType: 'disc'
                  }}
                >
                  <li>This Knowledge Base and its configurations</li>
                  <li>All AI Bots assigned to this Knowledge Base</li>
                  <li>All conversation threads and messages</li>
                  <li>All stored files, parsed documents, and search indexes</li>
                  <li>All associated activity history and bot memories</li>
                </ul>
              </div>
            </div>

            <div
              className="removal-note"
              style={{
                backgroundColor: '#fffbeb',
                borderColor: '#fde68a',
                color: '#92400e'
              }}
              data-testid="export-warning-note"
            >
              <AlertCircle
                size={18}
                style={{ color: '#b45309', flexShrink: 0 }}
                aria-hidden="true"
              />
              <div>
                <p
                  style={{
                    margin: '0 0 2px 0',
                    fontWeight: 600,
                    color: '#b45309',
                    fontSize: '13px'
                  }}
                >
                  Recommendation: Back up or export data first
                </p>
                <p style={{ margin: 0, fontSize: '12px', color: '#92400e' }}>
                  We strongly recommend that you export or manually back up any important documents,
                  files, or notes before proceeding.
                </p>
              </div>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0 }}>
              Note: Global AI provider connections and encrypted API credentials will not be
              deleted.
            </p>

            <div className="delete-confirmation-prompt">
              <label
                htmlFor="confirm-delete-input"
                className="form-label"
                style={{ color: '#881337' }}
              >
                To confirm, please type{' '}
                <span className="delete-target-name">{knowledgeBase.name}</span> below:
              </label>
              <input
                id="confirm-delete-input"
                type="text"
                className="form-input"
                placeholder={knowledgeBase.name}
                value={confirmName}
                disabled={isSubmitting}
                onChange={(e) => setConfirmName(e.target.value)}
                autoFocus
                autoComplete="off"
                data-testid="input-confirm-delete-name"
              />
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="btn-cancel-delete-kb"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!isNameMatching || isSubmitting}
              data-testid="btn-confirm-delete-kb"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />{' '}
                  Deleting...
                </>
              ) : (
                'Delete Permanently'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
