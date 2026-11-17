import { ReactElement, useState, useEffect } from 'react'
import { X, Pin, StickyNote, AlertCircle, Loader2, Info } from 'lucide-react'
import type { BotMemoryDto, BotMemoryType } from '../../../../../shared/bot-memories'
import {
  MAX_BOT_MEMORY_CONTENT_LENGTH,
  estimateTokenCount
} from '../../../../../shared/bot-memories'

export interface BotMemoryEditorProps {
  readonly isOpen: boolean
  readonly botId: string
  readonly memory?: BotMemoryDto | null
  readonly onClose: () => void
  readonly onSave: (values: { memoryType: BotMemoryType; content: string }) => Promise<void>
  readonly isSubmitting?: boolean
}

export function BotMemoryEditor({
  isOpen,
  memory,
  onClose,
  onSave,
  isSubmitting = false
}: BotMemoryEditorProps): ReactElement | null {
  const isEditing = Boolean(memory)
  const [memoryType, setMemoryType] = useState<BotMemoryType>(memory?.memoryType ?? 'user_note')
  const [content, setContent] = useState<string>(memory?.content ?? '')
  const [formError, setFormError] = useState<string | null>(null)

  // Sync state when memory prop or isOpen changes
  const [prevSyncTarget, setPrevSyncTarget] = useState<string | null>(null)
  const currentSyncTarget = isOpen
    ? memory
      ? `edit:${memory.id}:${memory.updatedAt}`
      : 'create'
    : null

  if (currentSyncTarget !== prevSyncTarget) {
    setPrevSyncTarget(currentSyncTarget)
    setMemoryType(memory?.memoryType ?? 'user_note')
    setContent(memory?.content ?? '')
    setFormError(null)
  }

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isSubmitting, onClose])

  if (!isOpen) return null

  const trimmedContent = content.trim()
  const isContentEmpty = trimmedContent.length === 0
  const isContentTooLong = content.length > MAX_BOT_MEMORY_CONTENT_LENGTH
  const estimatedTokens = estimateTokenCount(content)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (isSubmitting) return

    if (isContentEmpty) {
      setFormError('Memory content cannot be empty.')
      return
    }

    if (isContentTooLong) {
      setFormError(
        `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH.toLocaleString()} characters.`
      )
      return
    }

    setFormError(null)
    try {
      await onSave({
        memoryType,
        content: trimmedContent
      })
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save memory.'
      setFormError(msg)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-memory-editor-title"
      data-testid="bot-memory-editor-modal"
    >
      <div
        className="modal-container"
        style={{ maxWidth: '640px', width: '100%', margin: '24px auto' }}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            {memoryType === 'pinned_instruction' ? (
              <Pin size={20} className="inline-icon text-primary" aria-hidden="true" />
            ) : (
              <StickyNote size={20} className="inline-icon text-secondary" aria-hidden="true" />
            )}
            <h3 id="bot-memory-editor-title" className="modal-title">
              {isEditing ? 'Edit Bot Memory' : 'Add Bot Memory'}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-memory-editor"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Modal Body / Form */}
        <form onSubmit={handleSubmit}>
          <div
            className="modal-body"
            style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}
          >
            {formError && (
              <div
                className="section-alert section-alert-danger"
                role="alert"
                data-testid="memory-editor-error"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 14px',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '6px',
                  color: '#991b1b',
                  fontSize: '13px'
                }}
              >
                <AlertCircle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                <span>{formError}</span>
              </div>
            )}

            {/* Memory Type Selection */}
            <div className="form-group">
              <label
                className="form-label"
                style={{ fontWeight: 600, marginBottom: '8px', display: 'block' }}
              >
                Memory Type
              </label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '12px'
                }}
              >
                {/* User Note Option */}
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '12px',
                    borderRadius: '8px',
                    border: memoryType === 'user_note' ? '2px solid #6366f1' : '1px solid #e2e8f0',
                    backgroundColor: memoryType === 'user_note' ? '#f5f7ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  data-testid="label-memory-type-note"
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '4px'
                    }}
                  >
                    <input
                      type="radio"
                      name="memoryType"
                      value="user_note"
                      checked={memoryType === 'user_note'}
                      onChange={() => setMemoryType('user_note')}
                      disabled={isSubmitting}
                      data-testid="input-memory-type-note"
                      style={{ cursor: 'pointer' }}
                    />
                    <StickyNote size={15} style={{ color: '#64748b' }} aria-hidden="true" />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#1e293b' }}>
                      User Note
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '11px',
                      color: '#64748b',
                      paddingLeft: '24px',
                      lineHeight: 1.4
                    }}
                  >
                    General context, facts, or preferences. Included as budget allows.
                  </span>
                </label>

                {/* Pinned Instruction Option */}
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '12px',
                    borderRadius: '8px',
                    border:
                      memoryType === 'pinned_instruction'
                        ? '2px solid #6366f1'
                        : '1px solid #e2e8f0',
                    backgroundColor: memoryType === 'pinned_instruction' ? '#f5f7ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  data-testid="label-memory-type-pinned"
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '4px'
                    }}
                  >
                    <input
                      type="radio"
                      name="memoryType"
                      value="pinned_instruction"
                      checked={memoryType === 'pinned_instruction'}
                      onChange={() => setMemoryType('pinned_instruction')}
                      disabled={isSubmitting}
                      data-testid="input-memory-type-pinned"
                      style={{ cursor: 'pointer' }}
                    />
                    <Pin size={15} style={{ color: '#4f46e5' }} aria-hidden="true" />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#1e293b' }}>
                      Pinned Instruction
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '11px',
                      color: '#64748b',
                      paddingLeft: '24px',
                      lineHeight: 1.4
                    }}
                  >
                    High-priority guideline. Always budgeted before general notes.
                  </span>
                </label>
              </div>
            </div>

            {/* Memory Content Textarea */}
            <div className="form-group">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: '6px'
                }}
              >
                <label
                  htmlFor="bot-memory-content-input"
                  className="form-label"
                  style={{ fontWeight: 600, marginBottom: 0 }}
                >
                  Memory Content
                </label>
                <div style={{ display: 'flex', gap: '10px', fontSize: '12px', color: '#64748b' }}>
                  <span
                    style={{
                      color: isContentTooLong
                        ? '#dc2626'
                        : content.length > 9000
                          ? '#d97706'
                          : '#64748b',
                      fontWeight: isContentTooLong ? 600 : 400
                    }}
                    data-testid="memory-char-counter"
                  >
                    {content.length.toLocaleString()} /{' '}
                    {MAX_BOT_MEMORY_CONTENT_LENGTH.toLocaleString()} chars
                  </span>
                  <span>•</span>
                  <span data-testid="memory-token-estimate">
                    ~{estimatedTokens.toLocaleString()} tokens
                  </span>
                </div>
              </div>
              <textarea
                id="bot-memory-content-input"
                className="form-textarea"
                rows={7}
                placeholder="Enter context, user preferences, domain knowledge, or guidelines for this Bot..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={isSubmitting}
                maxLength={MAX_BOT_MEMORY_CONTENT_LENGTH + 100} // slight buffer so counter turns red if pasted
                data-testid="textarea-memory-content"
                style={{
                  width: '100%',
                  fontFamily: 'inherit',
                  fontSize: '13px',
                  lineHeight: '1.5',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: isContentTooLong ? '1px solid #ef4444' : '1px solid #cbd5e1',
                  boxSizing: 'border-box'
                }}
              />
              <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#64748b' }}>
                Tip: Keep memories clear and factual. Memories will be bounded by the Bot&apos;s
                1,500-token memory budget.
              </p>
            </div>

            {/* Transparency Note */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '10px 12px',
                backgroundColor: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '6px',
                fontSize: '11.5px',
                color: '#475569',
                lineHeight: 1.45
              }}
            >
              <Info
                size={15}
                style={{ color: '#64748b', flexShrink: 0, marginTop: '2px' }}
                aria-hidden="true"
              />
              <span>
                <strong>Privacy disclosure:</strong> Memories are stored locally on your device in
                SQLite. When you converse with this Bot, active memories are included in prompt
                context sent to your chosen AI provider.
              </span>
            </div>
          </div>

          {/* Modal Footer */}
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
              disabled={isSubmitting}
              data-testid="btn-cancel-memory"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || isContentEmpty || isContentTooLong}
              data-testid="btn-save-memory"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {isSubmitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
              <span>{isEditing ? 'Update Memory' : 'Save Memory'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
