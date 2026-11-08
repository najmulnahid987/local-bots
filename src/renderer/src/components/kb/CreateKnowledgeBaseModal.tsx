import { ReactElement, useState, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, FolderPlus } from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

export interface CreateKnowledgeBaseModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onSuccess?: (kb: KnowledgeBaseDto) => void
}

export function CreateKnowledgeBaseModal({
  isOpen,
  onClose,
  onSuccess
}: CreateKnowledgeBaseModalProps): ReactElement | null {
  const { createKnowledgeBase } = useKnowledgeBases()

  const [name, setName] = useState<string>('')
  const [description, setDescription] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen) return null

  const handleClose = (): void => {
    setName('')
    setDescription('')
    setErrorMessage(null)
    setIsSubmitting(false)
    onClose()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      handleClose()
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
      const created = await createKnowledgeBase({
        name: trimmedName,
        description: description.trim() || undefined
      })
      if (onSuccess) {
        onSuccess(created)
      }
      handleClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create Knowledge Base.'
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
      data-testid="create-kb-modal-backdrop"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-kb-title"
        data-testid="create-kb-modal"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <FolderPlus size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="create-kb-title" className="modal-title">
              Create Knowledge Base
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-create-kb"
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
                data-testid="create-kb-error"
              >
                {errorMessage}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="create-kb-name" className="form-label">
                Name <span aria-hidden="true">*</span>
              </label>
              <input
                id="create-kb-name"
                type="text"
                className="form-input"
                placeholder="e.g. Research Papers & Notes"
                value={name}
                disabled={isSubmitting}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                required
                autoFocus
                autoComplete="off"
                data-testid="input-create-kb-name"
              />
              <span className="form-helper">
                A unique, descriptive name for this Knowledge Base workspace (1–255 characters).
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="create-kb-description" className="form-label">
                Description (Optional)
              </label>
              <textarea
                id="create-kb-description"
                className="form-input"
                placeholder="What documents, topics, or workflows belong in this workspace?"
                value={description}
                disabled={isSubmitting}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={4}
                data-testid="input-create-kb-description"
              />
              <span className="form-helper">{description.length} / 2000 characters</span>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              disabled={isSubmitting}
              data-testid="btn-cancel-create-kb"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || name.trim().length === 0}
              data-testid="btn-submit-create-kb"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />{' '}
                  Creating...
                </>
              ) : (
                'Create Knowledge Base'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
