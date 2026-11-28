import { ReactElement, useState, memo } from 'react'
import {
  Bot,
  User,
  FileText,
  FolderSearch,
  Wrench,
  ChevronDown,
  ChevronRight,
  Brain,
  ShieldCheck,
  Globe,
  ExternalLink
} from 'lucide-react'
import {
  isSafeHttpUrl,
  type MessageDto,
  type CitationDto,
  type MessageToolCallDto,
  type MessageGroundingMode,
  type ClaimProvenance,
  type ClaimValidationStatus
} from '../../../../shared/conversations'
import type { CanonicalBotTool } from '../../../../shared/agents'
import { formatTimestamp } from '../../utils/formatters'
import { MarkdownMessageContent } from './MarkdownMessageContent'
import { ToolExecutionCard } from '../agents/ToolExecutionCard'

export interface ConversationMessageProps {
  readonly message: MessageDto
  readonly botName?: string
  readonly onCitationClick?: (citation: CitationDto, messageId?: string) => void
  readonly onSaveAsMemory?: (content: string) => void
}

interface WorkspaceEvidenceItem {
  readonly id: string
  readonly toolName: string
  readonly target: string
  readonly summary: string
}

interface GroundingBadgeMeta {
  readonly label: string
  readonly title: string
  readonly backgroundColor: string
  readonly color: string
  readonly borderColor: string
}

function getGroundingBadgeMeta(mode?: MessageGroundingMode): GroundingBadgeMeta | null {
  switch (mode) {
    case 'kb_grounded':
      return {
        label: 'KB Evidence',
        title: 'Response prioritized evidence from the assigned Knowledge Base.',
        backgroundColor: '#eff6ff',
        color: '#1d4ed8',
        borderColor: '#bfdbfe'
      }
    case 'kb_partial_with_general_fallback':
      return {
        label: 'Partial KB + General AI',
        title:
          'Assigned Knowledge Base partially covered this question; remaining gaps supplemented using general AI knowledge.',
        backgroundColor: '#fffbeb',
        color: '#b45309',
        borderColor: '#fde68a'
      }
    case 'general_fallback_no_kb_evidence':
      return {
        label: 'General AI Fallback',
        title:
          'No relevant information was found in the assigned Knowledge Base; answered using general AI knowledge.',
        backgroundColor: '#f8fafc',
        color: '#475569',
        borderColor: '#cbd5e1'
      }
    case 'general_fallback_no_usable_kb':
      return {
        label: 'General AI (No KB Docs)',
        title:
          'Assigned Knowledge Base currently has no indexed documents; answered using general AI knowledge.',
        backgroundColor: '#f8fafc',
        color: '#475569',
        borderColor: '#cbd5e1'
      }
    default:
      return null
  }
}

interface ClaimBadgeMeta {
  readonly label: string
  readonly color: string
  readonly backgroundColor: string
  readonly borderColor: string
}

function getClaimStatusBadgeMeta(
  provenance: ClaimProvenance,
  validationStatus: ClaimValidationStatus
): ClaimBadgeMeta {
  if (validationStatus === 'invalid_reference') {
    return {
      label: 'Unverified Reference',
      color: '#b91c1c',
      backgroundColor: '#fef2f2',
      borderColor: '#fecaca'
    }
  }
  switch (provenance) {
    case 'kb_supported':
      return {
        label: 'KB Supported',
        color: '#1d4ed8',
        backgroundColor: '#eff6ff',
        borderColor: '#bfdbfe'
      }
    case 'kb_partially_supported':
      return {
        label: 'Partial KB Support',
        color: '#b45309',
        backgroundColor: '#fffbeb',
        borderColor: '#fde68a'
      }
    case 'general_knowledge':
      return {
        label: 'General AI',
        color: '#475569',
        backgroundColor: '#f8fafc',
        borderColor: '#cbd5e1'
      }
    case 'unsupported':
      return {
        label: 'Unsupported',
        color: '#b91c1c',
        backgroundColor: '#fef2f2',
        borderColor: '#fecaca'
      }
    case 'uncertain':
    default:
      return {
        label: 'Uncertain',
        color: '#7c2d12',
        backgroundColor: '#fff7ed',
        borderColor: '#fed7aa'
      }
  }
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

export const ConversationMessage = memo(function ConversationMessage({
  message,
  botName = 'Assistant',
  onCitationClick,
  onSaveAsMemory
}: ConversationMessageProps): ReactElement {
  const [showTaskActivity, setShowTaskActivity] = useState<boolean>(false)
  const [showClaimProvenance, setShowClaimProvenance] = useState<boolean>(false)

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const citations = message.metadata?.citations ?? []
  const webSources = (message.metadata?.webSources ?? []).filter((ws) => isSafeHttpUrl(ws.url))
  const claims = message.metadata?.claims ?? []
  const toolCalls = message.metadata?.toolCalls ?? []
  const workspaceEvidence = extractWorkspaceEvidence(toolCalls)

  const validCitationKeys = new Set(citations.map((c) => `${c.citationNumber}:${c.chunkId}`))

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
            {(message.metadata?.executionMode === 'agent' ||
              Boolean(message.metadata?.agentRunId)) && (
              <span
                className="chat-execution-mode-pill"
                data-testid={`message-execution-mode-${message.id}`}
                title="Executed via explicit Agent Task mode"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  fontSize: '10px',
                  fontWeight: 500,
                  backgroundColor: '#f1f5f9',
                  color: '#475569',
                  border: '1px solid #cbd5e1'
                }}
              >
                <span>Agent Task</span>
              </span>
            )}
            {(() => {
              const badge = getGroundingBadgeMeta(message.metadata?.groundingMode)
              if (!badge) return null
              return (
                <span
                  className="chat-grounding-pill"
                  data-testid={`message-grounding-badge-${message.id}`}
                  title={badge.title}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '1px 6px',
                    borderRadius: '999px',
                    fontSize: '10px',
                    fontWeight: 500,
                    backgroundColor: badge.backgroundColor,
                    color: badge.color,
                    border: `1px solid ${badge.borderColor}`
                  }}
                >
                  {badge.label}
                </span>
              )
            })()}
            {message.metadata?.isPartial && (
              <span
                className="chat-partial-pill"
                data-testid={`message-partial-badge-${message.id}`}
                title={message.metadata?.interruptedReason ?? 'Response generation was interrupted'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  fontSize: '10px',
                  fontWeight: 500,
                  backgroundColor: '#fef2f2',
                  color: '#991b1b',
                  border: '1px solid #fecaca'
                }}
              >
                <span>{message.metadata.status === 'cancelled' ? 'Cancelled' : 'Interrupted'}</span>
              </span>
            )}
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
                onClick={() => onCitationClick?.(c, message.id)}
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

        {/* Claim-Level Provenance Inspector — Collapsible trace from claims to sources */}
        {isAssistant && claims.length > 0 && (
          <div
            className="chat-claim-provenance-section"
            data-testid={`claim-provenance-section-${message.id}`}
            style={{
              marginTop: '8px',
              paddingTop: '6px',
              borderTop: '1px solid #f1f5f9'
            }}
          >
            <button
              type="button"
              className="btn-toggle-claim-provenance"
              data-testid={`toggle-claim-provenance-${message.id}`}
              onClick={() => setShowClaimProvenance(!showClaimProvenance)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                color: '#475569',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                borderRadius: '4px',
                fontWeight: 500
              }}
            >
              <ShieldCheck size={12} aria-hidden="true" />
              <span>
                Claim Provenance ({claims.length} {claims.length === 1 ? 'claim' : 'claims'})
              </span>
              {showClaimProvenance ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>

            {showClaimProvenance && (
              <div
                className="claim-provenance-list"
                data-testid={`claim-provenance-list-${message.id}`}
                style={{
                  marginTop: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                {claims.map((claim) => {
                  const statusBadge = getClaimStatusBadgeMeta(
                    claim.provenance,
                    claim.validationStatus
                  )
                  const validatedRefs = claim.evidenceReferences.filter((ref) =>
                    validCitationKeys.has(`${ref.citationNumber}:${ref.chunkId}`)
                  )
                  return (
                    <div
                      key={claim.claimId}
                      data-testid={`claim-provenance-item-${message.id}-${claim.claimId}`}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '6px',
                        backgroundColor: '#f8fafc',
                        border: '1px solid #e2e8f0',
                        fontSize: '11.5px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px'
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '6px'
                        }}
                      >
                        <span
                          data-testid={`claim-status-badge-${message.id}-${claim.claimId}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            fontSize: '10px',
                            fontWeight: 600,
                            color: statusBadge.color,
                            backgroundColor: statusBadge.backgroundColor,
                            border: `1px solid ${statusBadge.borderColor}`
                          }}
                        >
                          {statusBadge.label}
                        </span>
                        {validatedRefs.map((ref) => (
                          <button
                            key={`${claim.claimId}-${ref.chunkId}-${ref.citationNumber}`}
                            type="button"
                            data-testid={`claim-ref-btn-${message.id}-${claim.claimId}-${ref.citationNumber}`}
                            onClick={() =>
                              onCitationClick?.(
                                {
                                  citationNumber: ref.citationNumber,
                                  sourceId: ref.sourceId,
                                  chunkId: ref.chunkId,
                                  fileName: ref.fileName,
                                  fileType: ref.fileType,
                                  pageNumber: ref.pageNumber,
                                  headingPath: ref.headingPath,
                                  chunkIndex: ref.chunkIndex
                                },
                                message.id
                              )
                            }
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              fontSize: '10px',
                              backgroundColor: '#ffffff',
                              color: '#1e40af',
                              border: '1px solid #cbd5e1',
                              cursor: onCitationClick ? 'pointer' : 'default'
                            }}
                          >
                            <strong>[{ref.citationNumber}]</strong> {ref.fileName}
                            {ref.pageNumber ? ` p.${ref.pageNumber}` : ''}
                          </button>
                        ))}
                      </div>
                      <span style={{ color: '#334155', lineHeight: 1.4 }}>{claim.claimText}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* External Web Sources Section — Strictly separate from Knowledge Base Citations */}
        {isAssistant && webSources.length > 0 && (
          <div
            className="chat-web-sources-section"
            data-testid={`web-sources-${message.id}`}
            style={{
              marginTop: '10px',
              paddingTop: '8px',
              borderTop: '1px dashed #cbd5e1',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 600,
                color: '#0f766e'
              }}
            >
              <Globe size={12} aria-hidden="true" />
              <span>Web Sources (External Research — Not Local KB Evidence):</span>
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px'
              }}
            >
              {webSources.map((src, idx) => (
                <a
                  key={src.id || `web-src-${idx}`}
                  href={src.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="chat-web-source-chip"
                  data-testid={`web-source-link-${message.id}-${idx}`}
                  title={src.snippet ? `${src.title} — ${src.snippet}` : src.url}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: '#0f766e',
                    backgroundColor: '#f0fdfa',
                    border: '1px solid #99f6e4',
                    textDecoration: 'none'
                  }}
                >
                  <span>{src.title}</span>
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              ))}
            </div>
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

        {/* Action: Save Assistant Response/Findings as Bot Memory */}
        {isAssistant && message.content && onSaveAsMemory && (
          <div
            style={{
              marginTop: '8px',
              display: 'flex',
              justifyContent: 'flex-end'
            }}
          >
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              data-testid={`save-memory-btn-${message.id}`}
              onClick={() => onSaveAsMemory(message.content)}
              title="Save key findings from this response as Bot Memory"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                color: '#64748b',
                padding: '2px 6px',
                borderRadius: '4px',
                border: '1px solid transparent',
                cursor: 'pointer'
              }}
            >
              <Brain size={12} aria-hidden="true" />
              <span>Save as Memory</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
