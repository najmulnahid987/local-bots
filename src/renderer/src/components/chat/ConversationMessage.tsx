import { ReactElement, useState } from 'react'
import { Bot, User, FileText, FolderSearch, Wrench, ChevronDown, ChevronRight } from 'lucide-react'
import type { MessageDto, CitationDto, MessageToolCallDto } from '../../../../shared/conversations'
import type { CanonicalBotTool } from '../../../../shared/agents'
import { formatTimestamp } from '../../utils/formatters'
import { MarkdownMessageContent } from './MarkdownMessageContent'
import { ToolExecutionCard } from '../agents/ToolExecutionCard'

export interface ConversationMessageProps {
  readonly message: MessageDto
  readonly botName?: string
  readonly onCitationClick?: (citation: CitationDto) => void
}

interface WorkspaceEvidenceItem {
  readonly id: string
  readonly toolName: string
  readonly target: string
  readonly summary: string
}

function extractWorkspaceEvidence(
  toolCalls?: readonly MessageToolCallDto[]
): readonly WorkspaceEvidenceItem[] {
  if (!toolCalls || toolCalls.length === 0) return []
  const evidence: WorkspaceEvidenceItem[] = []

  for (const tc of toolCalls) {
    if (tc.toolName === 'search_workspace_files' || tc.toolName === 'read_workspace_file') {
      let target = ''
      if (tc.argumentsSummary) {
        try {
          const parsed = JSON.parse(tc.argumentsSummary)
          if (typeof parsed === 'object' && parsed !== null) {
            target = String(parsed.targetPath ?? parsed.searchQuery ?? parsed.query ?? '')
          }
        } catch {
          target = tc.argumentsSummary
        }
      }
      evidence.push({
        id: tc.id,
        toolName: tc.toolName,
        target: target || (tc.toolName === 'read_workspace_file' ? 'file' : 'workspace query'),
        summary: tc.resultSummary ?? ''
      })
    }
  }

  return evidence
}

export function ConversationMessage({
  message,
  botName = 'Assistant',
  onCitationClick
}: ConversationMessageProps): ReactElement {
  const [showTaskActivity, setShowTaskActivity] = useState<boolean>(false)

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const citations = message.metadata?.citations ?? []
  const toolCalls = message.metadata?.toolCalls ?? []
  const workspaceEvidence = extractWorkspaceEvidence(toolCalls)

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

        {/* Citations Summary Badge & Interactive Fallback Chips (Knowledge Base) */}
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

        {/* Workspace Evidence Section — Distinct from Knowledge Base citations */}
        {isAssistant && workspaceEvidence.length > 0 && (
          <div
            className="chat-workspace-evidence-badge"
            data-testid={`workspace-evidence-${message.id}`}
            style={{
              marginTop: '8px',
              paddingTop: '8px',
              borderTop: '1px dashed #e2e8f0',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              fontSize: '11px',
              color: '#475569'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontWeight: 600,
                color: '#334155'
              }}
            >
              <FolderSearch size={12} className="inline-icon text-muted" aria-hidden="true" />
              <span>Workspace files inspected:</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {workspaceEvidence.map((item) => (
                <span
                  key={item.id}
                  className="workspace-evidence-chip"
                  data-testid={`workspace-evidence-chip-${item.id}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    backgroundColor: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    borderRadius: '4px',
                    padding: '2px 7px',
                    fontSize: '10.5px',
                    color: '#1e293b'
                  }}
                  title={item.summary}
                >
                  <strong>{item.toolName === 'read_workspace_file' ? 'read:' : 'search:'}</strong>
                  <span>{item.target}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Task Activity Section — Collapsible tool execution cards */}
        {isAssistant && toolCalls.length > 0 && (
          <div
            style={{
              marginTop: '10px',
              paddingTop: '8px',
              borderTop: '1px solid #f1f5f9'
            }}
          >
            <button
              type="button"
              className="btn-toggle-task-activity"
              data-testid={`toggle-task-activity-${message.id}`}
              onClick={() => setShowTaskActivity(!showTaskActivity)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '11.5px',
                color: '#2563eb',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                borderRadius: '4px',
                fontWeight: 500
              }}
            >
              <Wrench size={12} aria-hidden="true" />
              <span>
                {showTaskActivity ? 'Hide' : 'View'} Task Activity ({toolCalls.length} tool{' '}
                {toolCalls.length === 1 ? 'action' : 'actions'})
              </span>
              {showTaskActivity ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>

            {showTaskActivity && (
              <div
                className="message-tool-activities-list"
                data-testid={`task-activity-list-${message.id}`}
                style={{
                  marginTop: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                {toolCalls.map((tc, idx) => (
                  <ToolExecutionCard
                    key={tc.id || `tc-${idx}`}
                    id={tc.id || `tc-${idx}`}
                    toolName={tc.toolName as CanonicalBotTool}
                    status={tc.status}
                    sequenceNumber={idx + 1}
                    argumentsSummary={tc.argumentsSummary ?? '{}'}
                    resultSummary={tc.resultSummary ?? ''}
                    errorMessage={tc.errorMessage}
                    defaultExpanded={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
