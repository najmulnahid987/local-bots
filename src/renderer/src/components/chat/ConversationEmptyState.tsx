import { ReactElement } from 'react'
import { Sparkles, Bot, Archive } from 'lucide-react'

export interface ConversationEmptyStateProps {
  readonly botName?: string
  readonly isArchived?: boolean
}

export function ConversationEmptyState({
  botName = 'Assistant',
  isArchived = false
}: ConversationEmptyStateProps): ReactElement {
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
          backgroundColor: isArchived ? '#f1f5f9' : '#eff6ff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '16px'
        }}
      >
        {isArchived ? (
          <Archive size={28} style={{ color: '#64748b' }} aria-hidden="true" />
        ) : (
          <Bot size={28} style={{ color: '#3b82f6' }} aria-hidden="true" />
        )}
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
        {isArchived
          ? 'This Bot is archived and has no recorded messages. Restore the Bot from the Bots tab to start chatting.'
          : 'Ask questions, request summaries, or synthesize knowledge across documents in this Knowledge Base.'}
      </p>
      {!isArchived && (
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
      )}
    </div>
  )
}
