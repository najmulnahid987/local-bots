import { ReactElement, useState } from 'react'
import {
  Search,
  FileText,
  Layers,
  FolderSearch,
  FileCode,
  FileCheck,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock
} from 'lucide-react'
import type { CanonicalBotTool } from '../../../../shared/agents'

export interface ToolExecutionCardProps {
  readonly id: string
  readonly sequenceNumber: number
  readonly toolName: CanonicalBotTool
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval'
  readonly argumentsSummary?: string
  readonly resultSummary?: string
  readonly errorMessage?: string | null
  readonly durationMs?: number
  readonly defaultExpanded?: boolean
}

const TOOL_DISPLAY_CONFIG: Record<CanonicalBotTool, { label: string; icon: typeof Search }> = {
  search_knowledge_base: {
    label: 'Search Knowledge Base',
    icon: Search
  },
  read_knowledge_source: {
    label: 'Read Knowledge Source',
    icon: FileText
  },
  list_knowledge_sources: {
    label: 'List Knowledge Sources',
    icon: Layers
  },
  search_workspace_files: {
    label: 'Search Workspace Files',
    icon: FolderSearch
  },
  read_workspace_file: {
    label: 'Read Workspace File',
    icon: FileCode
  },
  save_report: {
    label: 'Save Report',
    icon: FileCheck
  }
}

function formatDuration(ms?: number): string | null {
  if (ms === undefined || ms === null || ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolExecutionCard({
  id,
  sequenceNumber,
  toolName,
  status,
  argumentsSummary,
  resultSummary,
  errorMessage,
  durationMs,
  defaultExpanded = false
}: ToolExecutionCardProps): ReactElement {
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded)

  const config = TOOL_DISPLAY_CONFIG[toolName] ?? {
    label: toolName,
    icon: FileText
  }
  const ToolIcon = config.icon

  const formattedDuration = formatDuration(durationMs)
  const hasDetails = Boolean(
    (argumentsSummary && argumentsSummary.trim()) ||
    (resultSummary && resultSummary.trim()) ||
    (errorMessage && errorMessage.trim())
  )

  const renderStatusBadge = (): ReactElement => {
    switch (status) {
      case 'running':
        return (
          <span
            className="status-badge status-badge-running"
            data-testid={`tool-status-${id}-running`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#eff6ff',
              color: '#1d4ed8',
              border: '1px solid #bfdbfe',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <Loader2 size={11} className="spinner inline-icon" aria-hidden="true" />
            <span>Running</span>
          </span>
        )
      case 'completed':
        return (
          <span
            className="status-badge status-badge-active"
            data-testid={`tool-status-${id}-completed`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f0fdf4',
              color: '#15803d',
              border: '1px solid #bbf7d0',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <CheckCircle2 size={11} className="inline-icon" aria-hidden="true" />
            <span>Completed</span>
          </span>
        )
      case 'failed':
        return (
          <span
            className="status-badge status-badge-revoked"
            data-testid={`tool-status-${id}-failed`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <XCircle size={11} className="inline-icon" aria-hidden="true" />
            <span>Failed</span>
          </span>
        )
      case 'waiting_approval':
        return (
          <span
            className="status-badge status-badge-pending"
            data-testid={`tool-status-${id}-waiting_approval`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#faf5ff',
              color: '#7e22ce',
              border: '1px solid #e9d5ff',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <AlertCircle size={11} className="inline-icon" aria-hidden="true" />
            <span>Awaiting Approval</span>
          </span>
        )
      case 'cancelled':
        return (
          <span
            className="status-badge status-badge-pending"
            data-testid={`tool-status-${id}-cancelled`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#fffbeb',
              color: '#b45309',
              border: '1px solid #fde68a',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <Clock size={11} className="inline-icon" aria-hidden="true" />
            <span>Cancelled</span>
          </span>
        )
      default:
        return (
          <span
            className="status-badge status-badge-pending"
            data-testid={`tool-status-${id}-pending`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f8fafc',
              color: '#64748b',
              border: '1px solid #cbd5e1',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 500
            }}
          >
            <span>Pending</span>
          </span>
        )
    }
  }

  return (
    <div
      className="tool-execution-card"
      data-testid={`tool-card-${id}`}
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        backgroundColor: '#ffffff',
        marginBottom: '8px',
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.03)'
      }}
    >
      {/* Header bar */}
      <div
        className="tool-card-header"
        data-testid={`tool-card-header-${id}`}
        onClick={() => hasDetails && setIsExpanded((prev) => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          backgroundColor: '#f8fafc',
          cursor: hasDetails ? 'pointer' : 'default',
          userSelect: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            className="tool-sequence-badge"
            data-testid={`tool-seq-${id}`}
            style={{
              fontSize: '10.5px',
              fontWeight: 600,
              color: '#64748b',
              backgroundColor: '#e2e8f0',
              padding: '1px 6px',
              borderRadius: '4px'
            }}
          >
            #{sequenceNumber}
          </span>

          <ToolIcon size={14} className="inline-icon text-muted" aria-hidden="true" />

          <span
            className="tool-name-label"
            data-testid={`tool-name-${id}`}
            style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b' }}
          >
            {config.label}
          </span>

          {formattedDuration && (
            <span
              className="tool-duration text-muted"
              data-testid={`tool-duration-${id}`}
              style={{ fontSize: '11px', color: '#64748b' }}
            >
              • {formattedDuration}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {renderStatusBadge()}
          {hasDetails && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              data-testid={`tool-toggle-btn-${id}`}
              aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
              style={{
                padding: '2px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            >
              {isExpanded ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {isExpanded && hasDetails && (
        <div
          className="tool-card-details"
          data-testid={`tool-details-${id}`}
          style={{
            padding: '10px 14px',
            borderTop: '1px solid #f1f5f9',
            fontSize: '12px',
            lineHeight: '1.5',
            backgroundColor: '#ffffff'
          }}
        >
          {argumentsSummary && (
            <div style={{ marginBottom: resultSummary || errorMessage ? '8px' : 0 }}>
              <strong style={{ color: '#475569', fontSize: '11px' }}>Input:</strong>
              <div
                data-testid={`tool-input-${id}`}
                style={{
                  color: '#334155',
                  marginTop: '2px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: '11.5px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  backgroundColor: '#f8fafc',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  border: '1px solid #f1f5f9'
                }}
              >
                {argumentsSummary}
              </div>
            </div>
          )}

          {resultSummary && (
            <div>
              <strong style={{ color: '#475569', fontSize: '11px' }}>Result:</strong>
              <div
                data-testid={`tool-result-${id}`}
                style={{
                  color: '#15803d',
                  marginTop: '2px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: '11.5px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  backgroundColor: '#f0fdf4',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  border: '1px solid #dcfce7'
                }}
              >
                {resultSummary}
              </div>
            </div>
          )}

          {errorMessage && (
            <div>
              <strong style={{ color: '#b91c1c', fontSize: '11px' }}>Error:</strong>
              <div
                data-testid={`tool-error-${id}`}
                style={{
                  color: '#b91c1c',
                  marginTop: '2px',
                  fontSize: '11.5px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  backgroundColor: '#fef2f2',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  border: '1px solid #fee2e2'
                }}
              >
                {errorMessage}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
