import { ReactElement, useState, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, Edit3 } from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

export interface EditKnowledgeBaseModalProps {
  readonly isOpen: boolean
  readonly knowledgeBase: KnowledgeBaseDto | null
  readonly onClose: () => void
  readonly onSuccess?: (kb: KnowledgeBaseDto) => void
}

export function EditKnowledgeBaseModal({
  isOpen,
  knowledgeBase,
  onClose,
  onSuccess
}: EditKnowledgeBaseModalProps): ReactElement | null {
  const { updateKnowledgeBase } = useKnowledgeBases()

  const [name, setName] = useState<string>(knowledgeBase?.name ?? '')
  const [description, setDescription] = useState<string>(knowledgeBase?.description ?? '')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !knowledgeBase) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (isSubmitting) return

    setErrorMessage(null)
    const trimmedName = name.trim()

    if (trimmedName.length === 0) {
      setErrorMessage('Knowledge Base name is required.')
      return
    }

    if (trimmedName.length > 255) {
      setErrorMessage('Knowledge Base name cannot exceed 255 characters.')
      return
    }

    if (description.length > 2000) {
      setErrorMessage('Description cannot exceed 2000 characters.')
      return
    }

    setIsSubmitting(true)

    try {
      const updated = await updateKnowledgeBase(knowledgeBase.id, {
        name: trimmedName,
        description: description.trim()
      })
      if (updated && onSuccess) {
        onSuccess(updated)
      }
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update Knowledge Base.'
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
      data-testid="edit-kb-modal-backdrop"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-kb-title"
        data-testid="edit-kb-modal"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Edit3 size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="edit-kb-title" className="modal-title">
              Edit Knowledge Base
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-edit-kb"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="modal-body">
            {errorMessage && (
              <div className="form-alert form-alert-error" role="alert" data-testid="edit-kb-error">
                {errorMessage}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="edit-kb-name" className="form-label">
                Name <span aria-hidden="true">*</span>
              </label>
              <input
                id="edit-kb-name"
                type="text"
                className="form-input"
                value={name}
                disabled={isSubmitting}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                required
                autoFocus
                autoComplete="off"
                data-testid="input-edit-kb-name"
              />
              <span className="form-helper">
                Renaming this Knowledge Base updates its display name without altering storage.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="edit-kb-description" className="form-label">
                Description (Optional)
              </label>
              <textarea
                id="edit-kb-description"
                className="form-input"
                value={description}
                disabled={isSubmitting}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={4}
                data-testid="input-edit-kb-description"
              />
              <span className="form-helper">{description.length} / 2000 characters</span>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="btn-cancel-edit-kb"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || name.trim().length === 0}
              data-testid="btn-submit-edit-kb"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" /> Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
