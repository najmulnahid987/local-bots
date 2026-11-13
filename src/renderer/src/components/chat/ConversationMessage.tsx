import { ReactElement } from 'react'
import { Bot, User, FileText } from 'lucide-react'
import type { MessageDto, CitationDto } from '../../../../shared/conversations'
import { formatTimestamp } from '../../utils/formatters'
import { MarkdownMessageContent } from './MarkdownMessageContent'

export interface ConversationMessageProps {
  readonly message: MessageDto
  readonly botName?: string
  readonly onCitationClick?: (citation: CitationDto) => void
}

export function ConversationMessage({
  message,
  botName = 'Assistant',
  onCitationClick
}: ConversationMessageProps): ReactElement {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const citations = message.metadata?.citations ?? []

  const formattedTime = message.createdAt ? formatTimestamp(message.createdAt) : ''

  return (
    <div
      className={`chat-message-row ${isUser ? 'chat-message-user' : 'chat-message-assistant'}`}
      data-testid={`message-item-${message.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '16px',
        width: '100%'
      }}
    >
      {/* Header with sender role & timestamp */}
      <div
        className="chat-message-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '4px',
          fontSize: '11px',
          fontWeight: 500,
          color: 'var(--color-text-secondary, #64748b)'
        }}
      >
        {isUser ? (
          <>
            <span>{formattedTime}</span>
            <span style={{ fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
              You
            </span>
            <User size={12} className="inline-icon" aria-hidden="true" />
          </>
        ) : (
          <>
            <Bot size={13} className="inline-icon text-accent" aria-hidden="true" />
            <span style={{ fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
              {botName}
            </span>
            {formattedTime && <span>• {formattedTime}</span>}
          </>
        )}
      </div>

      {/* Message Bubble */}
      <div
        className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}
        style={{
          maxWidth: isUser ? '80%' : '85%',
          padding: '12px 16px',
          borderRadius: isUser ? '14px 14px 2px 14px' : '14px 14px 14px 2px',
          backgroundColor: isUser ? 'var(--color-accent, #2563eb)' : '#ffffff',
          color: isUser ? '#ffffff' : 'var(--color-text-primary, #0f172a)',
          border: isUser ? 'none' : '1px solid var(--color-border, #e2e8f0)',
          boxShadow: isUser
            ? '0 1px 2px rgba(37, 99, 235, 0.2)'
            : '0 1px 3px rgba(15, 23, 42, 0.05)',
          fontSize: '13.5px',
          lineHeight: '1.55',
          overflowWrap: 'break-word',
          wordBreak: 'break-word'
        }}
      >
        <div className="chat-bubble-content">
          <MarkdownMessageContent
            content={message.content}
            contentFormat={message.contentFormat}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        </div>

        {/* Citations Summary Badge & Interactive Fallback Chips */}
        {isAssistant && citations.length > 0 && (
          <div
            className="chat-citations-badge"
            data-testid={`citations-list-${message.id}`}
            style={{
              marginTop: '10px',
              paddingTop: '8px',
              borderTop: '1px solid #f1f5f9',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              color: '#64748b'
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontWeight: 500
              }}
            >
              <FileText size={11} aria-hidden="true" />
              {citations.length} {citations.length === 1 ? 'source cited' : 'sources cited'}:
            </span>
            {citations.map((c) => (
              <button
                key={`${c.sourceId}-${c.chunkId}-${c.citationNumber}`}
                type="button"
                className="citation-chip-btn"
                data-testid={`citation-chip-${message.id}-${c.citationNumber}`}
                onClick={() => onCitationClick?.(c)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: '#f1f5f9',
                  color: '#1e40af',
                  border: '1px solid #cbd5e1',
                  borderRadius: '4px',
                  padding: '2px 7px',
                  fontSize: '10.5px',
                  cursor: onCitationClick ? 'pointer' : 'default',
                  transition: 'background-color 120ms ease, border-color 120ms ease'
                }}
                title={`View excerpt from ${c.fileName}`}
              >
                <strong>[{c.citationNumber}]</strong> {c.fileName}
                {c.pageNumber ? ` p.${c.pageNumber}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
