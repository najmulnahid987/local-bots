import { ReactElement, useEffect, useState } from 'react'
import { AlertTriangle, Trash2, X, Loader2, Pin, StickyNote } from 'lucide-react'
import type { BotMemoryDto } from '../../../../../shared/bot-memories'
import { formatTimestamp } from '../../../utils/formatters'

export interface BotMemoryDeleteDialogProps {
  readonly isOpen: boolean
  readonly memory: BotMemoryDto | null
  readonly onClose: () => void
  readonly onConfirm: (memoryId: string) => Promise<void>
  readonly isDeleting?: boolean
}

export function BotMemoryDeleteDialog({
  isOpen,
  memory,
  onClose,
  onConfirm,
  isDeleting = false
}: BotMemoryDeleteDialogProps): ReactElement | null {
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [prevTarget, setPrevTarget] = useState<string | null>(null)
  const currentTarget = isOpen && memory ? memory.id : null

  if (currentTarget !== prevTarget) {
    setPrevTarget(currentTarget)
    setDeleteError(null)
  }

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !isDeleting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isDeleting, onClose])

  if (!isOpen || !memory) return null

  const isPinned = memory.memoryType === 'pinned_instruction'
  const previewSnippet =
    memory.content.length > 250 ? `${memory.content.slice(0, 250)}…` : memory.content

  const handleConfirm = async (): Promise<void> => {
    setDeleteError(null)
    try {
      await onConfirm(memory.id)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete memory.'
      setDeleteError(msg)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-memory-modal-title"
      aria-describedby="delete-memory-modal-desc"
      data-testid="bot-memory-delete-modal"
    >
      <div
        className="modal-container"
        style={{ maxWidth: '520px', width: '100%', margin: '40px auto' }}
      >
        {/* Header */}
        <div className="modal-header">
          <div
            className="modal-title-group"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <AlertTriangle
              size={20}
              className="inline-icon"
              style={{ color: '#dc2626' }}
              aria-hidden="true"
            />
            <h3 id="delete-memory-modal-title" className="modal-title" style={{ color: '#dc2626' }}>
              Delete Bot Memory
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onClose}
            disabled={isDeleting}
            aria-label="Cancel deletion"
            data-testid="btn-close-delete-memory"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          <p
            id="delete-memory-modal-desc"
            className="modal-body-text"
            style={{ fontSize: '13.5px', color: '#334155', margin: 0 }}
          >
            Are you sure you want to permanently delete this saved memory?
          </p>

          {deleteError && (
            <div
              className="section-alert section-alert-danger"
              role="alert"
              data-testid="delete-memory-error"
              style={{
                padding: '8px 12px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '6px',
                color: '#991b1b',
                fontSize: '12.5px'
              }}
            >
              {deleteError}
            </div>
          )}

          {/* Memory preview card */}
          <div
            style={{
              padding: '12px 14px',
              backgroundColor: '#f8fafc',
              border: isPinned ? '1px solid #c7d2fe' : '1px solid #e2e8f0',
              borderLeft: isPinned ? '3px solid #6366f1' : '3px solid #94a3b8',
              borderRadius: '6px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              {isPinned ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#4f46e5',
                    backgroundColor: '#eef2ff',
                    padding: '2px 8px',
                    borderRadius: '12px'
                  }}
                >
                  <Pin size={11} aria-hidden="true" />
                  Pinned Instruction
                </span>
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11px',
                    fontWeight: 500,
                    color: '#475569',
                    backgroundColor: '#f1f5f9',
                    padding: '2px 8px',
                    borderRadius: '12px'
                  }}
                >
                  <StickyNote size={11} aria-hidden="true" />
                  User Note
                </span>
              )}
              {memory.updatedAt > 0 && (
                <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                  Updated {formatTimestamp(memory.updatedAt)}
                </span>
              )}
            </div>
            <p
              style={{
                fontSize: '12.5px',
                color: '#1e293b',
                lineHeight: 1.45,
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '120px',
                overflowY: 'auto'
              }}
              data-testid="delete-memory-preview"
            >
              {previewSnippet}
            </p>
          </div>

          <div
            style={{
              fontSize: '12px',
              color: '#64748b',
              backgroundColor: '#fffbeb',
              border: '1px solid #fef3c7',
              borderRadius: '6px',
              padding: '10px 12px'
            }}
          >
            <strong>Note:</strong> This action is immediate and cannot be undone. This memory will
            no longer be provided to the AI model during future conversations.
          </div>
        </div>

        {/* Footer */}
        <div
          className="modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            padding: '14px 20px',
            borderTop: '1px solid #e2e8f0'
          }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isDeleting}
            data-testid="btn-cancel-delete-memory"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleConfirm}
            disabled={isDeleting}
            data-testid="btn-confirm-delete-memory"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {isDeleting ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}
            <span>{isDeleting ? 'Deleting...' : 'Delete Memory'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
