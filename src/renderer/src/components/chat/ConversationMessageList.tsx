import { ReactElement, useEffect, useRef, useMemo } from 'react'
import { Loader2, Bot, History } from 'lucide-react'
import {
  type MessageDto,
  type CitationDto,
  type ConversationSegmentDto,
  groupMessagesBySegments
} from '../../../../shared/conversations'
import { formatTimestamp } from '../../utils/formatters'
import { ConversationMessage } from './ConversationMessage'
import { ConversationEmptyState } from './ConversationEmptyState'
import { MarkdownMessageContent } from './MarkdownMessageContent'

export interface ConversationMessageListProps {
  readonly messages: readonly MessageDto[]
  readonly segments?: readonly ConversationSegmentDto[]
  readonly isLoading: boolean
  readonly isGenerating: boolean
  readonly streamingText: string
  readonly botName?: string
  readonly conversationId?: string | null
  readonly isArchived?: boolean
  readonly onCitationClick?: (citation: CitationDto, messageId?: string) => void
  readonly activeTaskElement?: ReactElement | null
  readonly onSaveAsMemory?: (content: string) => void
}

export function ConversationMessageList({
  messages,
  segments = [],
  isLoading,
  isGenerating,
  streamingText,
  botName = 'Assistant',
  conversationId,
  isArchived = false,
  onCitationClick,
  activeTaskElement,
  onSaveAsMemory
}: ConversationMessageListProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef<boolean>(true)
  const prevConvIdRef = useRef<string | null | undefined>(conversationId)

  const timelineGroups = useMemo(
    () => groupMessagesBySegments(segments, messages),
    [segments, messages]
  )
  const hasMultipleSegments = segments.length > 1

  // Track user scroll position: if within 120px from bottom, consider near bottom
  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isNearBottomRef.current = distanceFromBottom < 120
  }

  // Scroll to bottom when conversation changes
  useEffect(() => {
    if (conversationId !== prevConvIdRef.current) {
      prevConvIdRef.current = conversationId
      isNearBottomRef.current = true
      if (typeof bottomRef.current?.scrollIntoView === 'function') {
        bottomRef.current.scrollIntoView({ behavior: 'auto' })
      }
    }
  }, [conversationId])

  // Scroll to bottom as streaming text grows, messages arrive, or active task updates
  useEffect(() => {
    if (isNearBottomRef.current) {
      if (typeof bottomRef.current?.scrollIntoView === 'function') {
        bottomRef.current.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages.length, segments.length, streamingText, activeTaskElement])

  if (isLoading && messages.length === 0) {
    return (
      <div
        className="chat-messages-container"
        ref={containerRef}
        data-testid="messages-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px'
        }}
      >
        <div className="section-loading-state" role="status" data-testid="messages-loading">
          <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
          <span>Loading messages...</span>
        </div>
      </div>
    )
  }

  if (messages.length === 0 && !hasMultipleSegments && !streamingText && !activeTaskElement) {
    return (
      <div
        className="chat-messages-container"
        ref={containerRef}
        data-testid="messages-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <ConversationEmptyState botName={botName} isArchived={isArchived} />
      </div>
    )
  }

  return (
    <div
      className="chat-messages-container"
      ref={containerRef}
      onScroll={handleScroll}
      data-testid="messages-container"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Segment-grouped chronological message timeline (never interleaves overlapping threads) */}
      {timelineGroups.map((group) => {
        const seg = group.segment
        const showDivider = Boolean(hasMultipleSegments && seg)

        return (
          <section
            key={group.key}
            data-testid={
              seg ? `conversation-segment-${seg.id}` : 'conversation-segment-unsegmented'
            }
            aria-label={seg ? `Conversation segment: ${seg.title}` : 'Messages'}
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%'
            }}
          >
            {showDivider && seg && (
              <div
                className="conversation-segment-divider"
                data-testid={`conversation-segment-header-${seg.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  margin: '16px 0 12px 0',
                  padding: '6px 12px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '11.5px',
                  color: '#475569'
                }}
              >
                <History size={13} className="inline-icon text-muted" aria-hidden="true" />
                <span style={{ fontWeight: 600, color: '#1e293b' }}>{seg.title}</span>
                <span style={{ color: '#94a3b8' }}>•</span>
                <span>{formatTimestamp(seg.firstMessageCreatedAt ?? seg.createdAt)}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '11px',
                    color: '#64748b',
                    backgroundColor: '#e2e8f0',
                    padding: '1px 7px',
                    borderRadius: '10px'
                  }}
                >
                  {group.messages.length} {group.messages.length === 1 ? 'message' : 'messages'}
                </span>
              </div>
            )}

            {showDivider && seg && group.messages.length === 0 && (
              <div
                data-testid={`conversation-segment-empty-${seg.id}`}
                style={{
                  fontSize: '12px',
                  color: '#94a3b8',
                  fontStyle: 'italic',
                  padding: '4px 12px 12px 12px'
                }}
              >
                No messages recorded in this historical thread.
              </div>
            )}

            {group.messages.map((message) => (
              <ConversationMessage
                key={message.id}
                message={message}
                botName={botName}
                onCitationClick={onCitationClick}
                onSaveAsMemory={onSaveAsMemory}
              />
            ))}
          </section>
        )
      })}

      {/* Active Agent Task Activity Timeline (when running, waiting approval, or completed/failed) */}
      {activeTaskElement}

      {/* Temporary Assistant Streaming Bubble (for normal chat generation) */}
      {streamingText ? (
        <div
          className="chat-message-row chat-message-assistant"
          data-testid="streaming-text-preview"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            marginBottom: '16px',
            width: '100%'
          }}
        >
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
            <Bot size={13} className="inline-icon text-accent" aria-hidden="true" />
            <span style={{ fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
              {botName}
            </span>
            <span style={{ color: '#2563eb' }}>• Generating...</span>
          </div>

          <div
            className="chat-bubble chat-bubble-assistant chat-bubble-streaming"
            style={{
              maxWidth: '85%',
              padding: '12px 16px',
              borderRadius: '14px 14px 14px 2px',
              backgroundColor: '#ffffff',
              color: 'var(--color-text-primary, #0f172a)',
              border: '1px solid var(--color-border, #e2e8f0)',
              boxShadow: '0 1px 3px rgba(15, 23, 42, 0.05)',
              fontSize: '13.5px',
              lineHeight: '1.55',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
              position: 'relative'
            }}
          >
            <div className="chat-bubble-content">
              <MarkdownMessageContent
                content={streamingText}
                contentFormat="markdown"
                citations={[]}
                isGenerating={true}
              />
              <span
                className="chat-cursor-blink"
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '14px',
                  backgroundColor: 'var(--color-accent, #2563eb)',
                  marginLeft: '4px',
                  verticalAlign: 'middle',
                  animation: 'pulse 1s infinite'
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      ) : isGenerating ? (
        <div
          className="chat-message-row chat-message-assistant"
          data-testid="streaming-indicator"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 16px',
            borderRadius: '14px 14px 14px 2px',
            backgroundColor: '#f8fafc',
            border: '1px solid #e2e8f0',
            maxWidth: '180px',
            marginBottom: '16px',
            fontSize: '12px',
            color: '#64748b'
          }}
          role="status"
        >
          <Loader2 size={15} className="spinner text-accent inline-icon" aria-hidden="true" />
          <span>{botName} is thinking...</span>
        </div>
      ) : null}

      {/* Auto-scroll target anchor */}
      <div ref={bottomRef} style={{ height: '1px', flexShrink: 0 }} aria-hidden="true" />
    </div>
  )
}
