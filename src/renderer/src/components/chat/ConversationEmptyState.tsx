import { ReactElement } from 'react'
import { MessageSquare, Sparkles, Plus, Bot } from 'lucide-react'

export interface ConversationEmptyStateProps {
  readonly variant: 'no-selection' | 'empty-conversation'
  readonly botName?: string
  readonly onNewConversation?: () => void
  readonly isArchived?: boolean
}

export function ConversationEmptyState({
  variant,
  botName = 'Assistant',
  onNewConversation,
  isArchived = false
}: ConversationEmptyStateProps): ReactElement {
  if (variant === 'no-selection') {
    return (
      <div
        className="chat-empty-state"
        data-testid="no-conversation-selected"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          textAlign: 'center',
          padding: '48px 24px',
          color: 'var(--color-text-secondary, #64748b)'
        }}
      >
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '16px',
            backgroundColor: '#f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px'
          }}
        >
          <MessageSquare size={28} style={{ color: '#94a3b8' }} aria-hidden="true" />
        </div>
        <h3
          style={{
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--color-text-primary, #0f172a)',
            margin: '0 0 6px 0'
          }}
        >
          No Conversation Selected
        </h3>
        <p style={{ fontSize: '13px', margin: '0 0 20px 0', maxWidth: '360px', lineHeight: 1.5 }}>
          Select an existing conversation thread from the sidebar, or start a new thread to explore
          documents with <strong>{botName}</strong>.
        </p>
        {onNewConversation && !isArchived && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onNewConversation}
            data-testid="empty-state-new-conv-btn"
          >
            <Plus size={14} className="inline-icon" aria-hidden="true" />
            New Conversation
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="chat-empty-state"
      data-testid="messages-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        textAlign: 'center',
        padding: '48px 24px',
        color: 'var(--color-text-secondary, #64748b)'
      }}
    >
      <div
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          backgroundColor: '#eff6ff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '16px'
        }}
      >
        <Bot size={28} style={{ color: '#3b82f6' }} aria-hidden="true" />
      </div>
      <h3
        style={{
          fontSize: '16px',
          fontWeight: 600,
          color: 'var(--color-text-primary, #0f172a)',
          margin: '0 0 6px 0'
        }}
      >
        Chat with {botName}
      </h3>
      <p style={{ fontSize: '13px', margin: '0 0 16px 0', maxWidth: '400px', lineHeight: 1.5 }}>
        Ask questions, request summaries, or synthesize knowledge across documents in this Knowledge
        Base.
      </p>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          color: '#64748b',
          backgroundColor: '#f8fafc',
          padding: '6px 12px',
          borderRadius: '20px',
          border: '1px solid #e2e8f0'
        }}
      >
        <Sparkles size={14} style={{ color: '#3b82f6' }} aria-hidden="true" />
        <span>Type a message below to begin this conversation.</span>
      </div>
    </div>
  )
}
