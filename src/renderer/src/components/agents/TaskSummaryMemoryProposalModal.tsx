import { ReactElement, useState, useEffect } from 'react'
import { Brain, X, Pin, StickyNote, AlertCircle, Loader2, Sparkles, Info } from 'lucide-react'
import type { BotMemoryDto, BotMemoryType } from '../../../../shared/bot-memories'
import {
  MAX_BOT_MEMORY_CONTENT_LENGTH,
  estimateTokenCount,
  BotMemoryBridgeError
} from '../../../../shared/bot-memories'

export interface TaskSummaryMemoryProposalModalProps {
  readonly isOpen: boolean
  readonly botId: string
  readonly botName: string
  readonly defaultContent: string
  readonly taskTitle?: string
  readonly onClose: () => void
  readonly onSaveSuccess?: (savedMemory: BotMemoryDto) => void
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof BotMemoryBridgeError) {
    return err.message
  }
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
}

export function TaskSummaryMemoryProposalModal({
  isOpen,
  botId,
  botName,
  defaultContent,
  taskTitle,
  onClose,
  onSaveSuccess
}: TaskSummaryMemoryProposalModalProps): ReactElement | null {
  const [memoryType, setMemoryType] = useState<BotMemoryType>('user_note')
  const [content, setContent] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Initialize or reset content when modal opens or target changes
  const [prevTarget, setPrevTarget] = useState<string | null>(null)
  const currentTarget = isOpen ? `${botId}:${defaultContent.slice(0, 100)}` : null

  if (currentTarget !== prevTarget) {
    setPrevTarget(currentTarget)
    const initial = defaultContent.slice(0, MAX_BOT_MEMORY_CONTENT_LENGTH).trim()
    setContent(initial)
    setMemoryType('user_note')
    setErrorMessage(null)
    setIsSubmitting(false)
  }

  // Escape key handling
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

  const trimmed = content.trim()
  const isContentEmpty = trimmed.length === 0
  const isContentTooLong = content.length > MAX_BOT_MEMORY_CONTENT_LENGTH
  const estimatedTokens = estimateTokenCount(content)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (isSubmitting) return

    if (isContentEmpty) {
      setErrorMessage('Memory content cannot be empty.')
      return
    }

    if (isContentTooLong) {
      setErrorMessage(
        `Memory content cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH.toLocaleString()} characters.`
      )
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      if (!window.api?.botMemories?.create) {
        throw new BotMemoryBridgeError('Bot memory API is unavailable.', 'API_UNAVAILABLE')
      }

      const created = await window.api.botMemories.create({
        botId,
        memoryType,
        content: trimmed
      })

      onSaveSuccess?.(created)
      onClose()
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err)
      setErrorMessage(sanitized)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-summary-memory-title"
      data-testid="task-summary-memory-modal"
    >
      <div
        className="modal-container"
        style={{ maxWidth: '640px', width: '100%', margin: '24px auto' }}
      >
        {/* Header */}
        <div className="modal-header">
          <div
            className="modal-title-group"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '6px',
                backgroundColor: '#ede9fe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#7c3aed'
              }}
            >
              <Sparkles size={18} aria-hidden="true" />
            </div>
            <div>
              <h3
                id="task-summary-memory-title"
                className="modal-title"
                style={{ margin: 0, fontSize: '16px' }}
              >
                Save Task Findings as Bot Memory
              </h3>
              <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#64748b' }}>
                Bot: <strong>{botName}</strong>
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="btn-close-task-summary-modal"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit}>
          <div
            className="modal-body"
            style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '18px 20px' }}
          >
            {/* Context Info Banner */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '10px 14px',
                backgroundColor: '#f5f3ff',
                border: '1px solid #ddd6fe',
                borderRadius: '8px',
                fontSize: '12.5px',
                color: '#5b21b6',
                lineHeight: 1.45
              }}
            >
              <Brain size={18} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <div>
                {taskTitle && (
                  <div style={{ fontWeight: 600, marginBottom: '2px' }}>Source: {taskTitle}</div>
                )}
                <span>
                  Review and edit the key findings or summary below before saving. Once saved, this
                  memory will be recalled automatically during future conversations with {botName}.
                </span>
              </div>
            </div>

            {/* Error banner */}
            {errorMessage && (
              <div
                className="section-alert section-alert-danger"
                role="alert"
                data-testid="task-summary-error"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 12px',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '6px',
                  color: '#991b1b',
                  fontSize: '13px'
                }}
              >
                <AlertCircle size={16} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>{errorMessage}</span>
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
                  gap: '10px'
                }}
              >
                {/* User Note Option */}
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: memoryType === 'user_note' ? '2px solid #7c3aed' : '1px solid #e2e8f0',
                    backgroundColor: memoryType === 'user_note' ? '#faf5ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  data-testid="label-summary-type-note"
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '2px'
                    }}
                  >
                    <input
                      type="radio"
                      name="summaryMemoryType"
                      value="user_note"
                      checked={memoryType === 'user_note'}
                      onChange={() => setMemoryType('user_note')}
                      disabled={isSubmitting}
                      data-testid="input-summary-type-note"
                      style={{ cursor: 'pointer' }}
                    />
                    <StickyNote size={14} style={{ color: '#64748b' }} aria-hidden="true" />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#1e293b' }}>
                      User Note (Recommended)
                    </span>
                  </div>
                  <span style={{ fontSize: '11px', color: '#64748b', paddingLeft: '22px' }}>
                    General finding or reference note. Included as budget allows.
                  </span>
                </label>

                {/* Pinned Instruction Option */}
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border:
                      memoryType === 'pinned_instruction'
                        ? '2px solid #7c3aed'
                        : '1px solid #e2e8f0',
                    backgroundColor: memoryType === 'pinned_instruction' ? '#faf5ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  data-testid="label-summary-type-pinned"
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '2px'
                    }}
                  >
                    <input
                      type="radio"
                      name="summaryMemoryType"
                      value="pinned_instruction"
                      checked={memoryType === 'pinned_instruction'}
                      onChange={() => setMemoryType('pinned_instruction')}
                      disabled={isSubmitting}
                      data-testid="input-summary-type-pinned"
                      style={{ cursor: 'pointer' }}
                    />
                    <Pin size={14} style={{ color: '#7c3aed' }} aria-hidden="true" />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#1e293b' }}>
                      Pinned Instruction
                    </span>
                  </div>
                  <span style={{ fontSize: '11px', color: '#64748b', paddingLeft: '22px' }}>
                    High-priority rule or standing directive. Budgeted first.
                  </span>
                </label>
              </div>
            </div>

            {/* Editable Content */}
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
                  htmlFor="task-summary-content-input"
                  className="form-label"
                  style={{ fontWeight: 600, marginBottom: 0 }}
                >
                  Proposed Memory Content
                </label>
                <div style={{ display: 'flex', gap: '8px', fontSize: '12px', color: '#64748b' }}>
                  <span
                    style={{
                      color: isContentTooLong
                        ? '#dc2626'
                        : content.length > 9000
                          ? '#d97706'
                          : '#64748b',
                      fontWeight: isContentTooLong ? 600 : 400
                    }}
                    data-testid="task-summary-char-counter"
                  >
                    {content.length.toLocaleString()} /{' '}
                    {MAX_BOT_MEMORY_CONTENT_LENGTH.toLocaleString()} chars
                  </span>
                  <span>•</span>
                  <span data-testid="task-summary-token-estimate">
                    ~{estimatedTokens.toLocaleString()} tokens
                  </span>
                </div>
              </div>
              <textarea
                id="task-summary-content-input"
                className="form-textarea"
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={isSubmitting}
                data-testid="textarea-task-summary-content"
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
            </div>

            {/* Privacy notice */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                backgroundColor: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '6px',
                fontSize: '11.5px',
                color: '#64748b'
              }}
            >
              <Info size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
              <span>
                Memories are stored locally. They are never sent to external servers except as
                context when prompting the AI model.
              </span>
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
              disabled={isSubmitting}
              data-testid="btn-cancel-task-summary"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || isContentEmpty || isContentTooLong}
              data-testid="btn-save-task-summary"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: '#7c3aed',
                borderColor: '#7c3aed'
              }}
            >
              {isSubmitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
              <span>Save as Bot Memory</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
