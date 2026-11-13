import { ReactElement, useState, useRef, KeyboardEvent } from 'react'
import { Send, Loader2, Square } from 'lucide-react'

export interface ConversationComposerProps {
  readonly onSend: (content: string) => Promise<void>
  readonly onStop?: () => Promise<void>
  readonly isGenerating: boolean
  readonly isCancelling?: boolean
  readonly disabled?: boolean
  readonly placeholder?: string
}

export function ConversationComposer({
  onSend,
  onStop,
  isGenerating,
  isCancelling = false,
  disabled = false,
  placeholder = 'Type a message... (Enter to send, Shift+Enter for newline)'
}: ConversationComposerProps): ReactElement {
  const [content, setContent] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const isBlank = !content.trim()
  const canSend = !disabled && !isGenerating && !isSubmitting && !isBlank

  const handleSubmit = async (): Promise<void> => {
    if (!canSend) {
      return
    }

    const trimmed = content.trim()
    setIsSubmitting(true)

    try {
      await onSend(trimmed)
      // Only clear composer after send operation is accepted
      setContent('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } catch {
      // Preserve content on failure so user does not lose input
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  // Auto-resize textarea as text grows
  const handleInput = (val: string): void => {
    setContent(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }

  return (
    <div
      className="chat-composer-container"
      data-testid="message-composer"
      style={{
        padding: '16px 20px',
        borderTop: '1px solid var(--color-border, #e2e8f0)',
        backgroundColor: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}
    >
      <div
        className="chat-composer-box"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '10px',
          padding: '8px 12px',
          border: '1px solid var(--color-border, #cbd5e1)',
          borderRadius: '10px',
          backgroundColor: disabled ? '#f8fafc' : '#ffffff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          transition: 'border-color 150ms ease, box-shadow 150ms ease'
        }}
      >
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          data-testid="message-input"
          aria-label="Message composer input"
          value={content}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isGenerating || isSubmitting}
          placeholder={disabled ? 'Conversation input disabled' : placeholder}
          rows={1}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: '13.5px',
            lineHeight: '1.5',
            maxHeight: '160px',
            minHeight: '24px',
            backgroundColor: 'transparent',
            color: 'var(--color-text-primary, #0f172a)',
            fontFamily: 'inherit',
            padding: '2px 0'
          }}
        />

        {isGenerating && onStop ? (
          <button
            type="button"
            className="btn btn-danger btn-sm chat-stop-btn"
            data-testid="stop-generation-btn"
            aria-label="Stop generation"
            onClick={() => void onStop()}
            disabled={isCancelling}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              flexShrink: 0,
              cursor: isCancelling ? 'not-allowed' : 'pointer'
            }}
          >
            {isCancelling ? (
              <Loader2 size={13} className="spinner inline-icon" aria-hidden="true" />
            ) : (
              <Square size={13} fill="currentColor" className="inline-icon" aria-hidden="true" />
            )}
            <span>{isCancelling ? 'Stopping...' : 'Stop'}</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm chat-send-btn"
            data-testid="send-message-btn"
            aria-label="Send message"
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              flexShrink: 0,
              cursor: canSend ? 'pointer' : 'not-allowed'
            }}
          >
            {isSubmitting ? (
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
            ) : (
              <Send size={14} className="inline-icon" aria-hidden="true" />
            )}
            <span>Send</span>
          </button>
        )}
      </div>

      <div
        className="chat-composer-hints"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          color: 'var(--color-text-secondary, #94a3b8)',
          padding: '0 2px'
        }}
      >
        <span>Press Enter to send, Shift+Enter for new line</span>
      </div>
    </div>
  )
}
