import { ReactElement, useState } from 'react'
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  ShieldAlert,
  Brain
} from 'lucide-react'
import type { AgentRunStatus } from '../../../../shared/agents'
import { ToolExecutionCard } from './ToolExecutionCard'
import type { ReconciledToolActivity } from '../../hooks/useAgentTaskEvents'

export interface TaskActivityTimelineProps {
  readonly agentRunId: string
  readonly status: AgentRunStatus | 'idle'
  readonly iteration?: number
  readonly maxIterations?: number
  readonly toolActivities?: readonly ReconciledToolActivity[]
  readonly startedAt?: number
  readonly completedAt?: number | null
  readonly errorSummary?: string | null
  readonly isCollapsible?: boolean
  readonly defaultExpanded?: boolean
  readonly onStop?: () => void
  readonly onReviewApproval?: () => void
  readonly hasPendingApproval?: boolean
  readonly onSaveAsMemory?: () => void
}

function formatDuration(startedAt?: number, completedAt?: number | null): string | null {
  if (!startedAt) return null
  const end = completedAt ?? Date.now()
  const diffMs = end - startedAt
  if (diffMs < 0) return null
  if (diffMs < 1000) return `${diffMs}ms`
  const seconds = (diffMs / 1000).toFixed(1)
  return `${seconds}s`
}

export function TaskActivityTimeline({
  agentRunId,
  status,
  iteration = 0,
  maxIterations = 5,
  toolActivities = [],
  startedAt,
  completedAt,
  errorSummary,
  isCollapsible = true,
  defaultExpanded = true,
  onStop,
  onReviewApproval,
  hasPendingApproval = false,
  onSaveAsMemory
}: TaskActivityTimelineProps): ReactElement {
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded)

  const isLive = status === 'running' || status === 'queued' || status === 'waiting_approval'
  const duration = formatDuration(startedAt, completedAt)

  const renderStatusBadge = (): ReactElement => {
    switch (status) {
      case 'running':
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-running`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#eff6ff',
              color: '#1d4ed8',
              border: '1px solid #bfdbfe',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <Loader2 size={12} className="spinner inline-icon" aria-hidden="true" />
            <span>Running</span>
          </span>
        )
      case 'waiting_approval':
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-waiting_approval`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#faf5ff',
              color: '#7e22ce',
              border: '1px solid #e9d5ff',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <AlertCircle size={12} className="inline-icon" aria-hidden="true" />
            <span>Awaiting Approval</span>
          </span>
        )
      case 'completed':
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-completed`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f0fdf4',
              color: '#15803d',
              border: '1px solid #bbf7d0',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <CheckCircle2 size={12} className="inline-icon" aria-hidden="true" />
            <span>Completed</span>
          </span>
        )
      case 'failed':
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-failed`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <XCircle size={12} className="inline-icon" aria-hidden="true" />
            <span>Failed</span>
          </span>
        )
      case 'cancelled':
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-cancelled`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#fffbeb',
              color: '#b45309',
              border: '1px solid #fde68a',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <Clock size={12} className="inline-icon" aria-hidden="true" />
            <span>Cancelled</span>
          </span>
        )
      default:
        return (
          <span
            className="status-badge"
            data-testid={`timeline-status-${agentRunId}-queued`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f8fafc',
              color: '#64748b',
              border: '1px solid #cbd5e1',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11.5px',
              fontWeight: 600
            }}
          >
            <span>Queued</span>
          </span>
        )
    }
  }

  return (
    <div
      className="task-activity-timeline"
      data-testid={`task-timeline-${agentRunId}`}
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: '10px',
        backgroundColor: '#ffffff',
        margin: '12px 0',
        overflow: 'hidden',
        boxShadow: '0 1px 3px rgba(15, 23, 42, 0.05)'
      }}
    >
      {/* Top Header Summary */}
      <div
        className="task-timeline-header"
        onClick={() => isCollapsible && setIsExpanded((prev) => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          backgroundColor: '#f8fafc',
          borderBottom: isExpanded ? '1px solid #e2e8f0' : 'none',
          cursor: isCollapsible ? 'pointer' : 'default',
          userSelect: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={15} className="inline-icon text-accent" aria-hidden="true" />

          <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>
            Agent Task Activity
          </span>

          <span
            className="text-muted"
            data-testid={`timeline-iteration-${agentRunId}`}
            style={{ fontSize: '11.5px', color: '#64748b' }}
          >
            (Step {iteration}/{maxIterations})
          </span>

          {duration && (
            <span
              className="text-muted"
              data-testid={`timeline-duration-${agentRunId}`}
              style={{ fontSize: '11px', color: '#94a3b8' }}
            >
              • {duration}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {renderStatusBadge()}

          {isLive && onStop && (
            <button
              type="button"
              className="btn btn-danger btn-xs"
              data-testid={`stop-task-btn-${agentRunId}`}
              onClick={(e) => {
                e.stopPropagation()
                onStop()
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                fontSize: '11px'
              }}
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
              <span>Stop</span>
            </button>
          )}

          {isCollapsible && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              data-testid={`timeline-toggle-${agentRunId}`}
              aria-label={isExpanded ? 'Collapse timeline' : 'Expand timeline'}
              style={{
                padding: '2px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            >
              {isExpanded ? (
                <ChevronDown size={15} aria-hidden="true" />
              ) : (
                <ChevronRight size={15} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Pending Approval Action Banner */}
      {(status === 'waiting_approval' || hasPendingApproval) && (
        <div
          className="pending-approval-banner"
          data-testid={`pending-approval-banner-${agentRunId}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            backgroundColor: '#faf5ff',
            borderBottom: '1px solid #e9d5ff',
            fontSize: '12.5px',
            color: '#6b21a8'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={16} className="inline-icon text-accent" aria-hidden="true" />
            <span>
              <strong>Action Required:</strong> The agent has generated a report that requires your
              approval before saving.
            </span>
          </div>

          {onReviewApproval && (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              data-testid={`review-approval-btn-${agentRunId}`}
              onClick={(e) => {
                e.stopPropagation()
                onReviewApproval()
              }}
              style={{ padding: '4px 10px', fontSize: '11.5px', flexShrink: 0 }}
            >
              Review Report
            </button>
          )}
        </div>
      )}

      {/* Error Summary Banner */}
      {status === 'failed' && errorSummary && (
        <div
          className="timeline-error-banner"
          data-testid={`timeline-error-${agentRunId}`}
          style={{
            padding: '8px 14px',
            backgroundColor: '#fef2f2',
            borderBottom: '1px solid #fee2e2',
            fontSize: '12px',
            color: '#b91c1c'
          }}
        >
          <strong>Error:</strong> {errorSummary}
        </div>
      )}

      {/* Task Completed Action Banner (for saving key findings as Bot Memory) */}
      {status === 'completed' && onSaveAsMemory && (
        <div
          className="timeline-completed-memory-banner"
          data-testid={`timeline-save-memory-banner-${agentRunId}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 14px',
            backgroundColor: '#f5f3ff',
            borderBottom: isExpanded ? '1px solid #ede9fe' : 'none',
            fontSize: '12.5px',
            color: '#6d28d9'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Brain size={15} style={{ flexShrink: 0 }} aria-hidden="true" />
            <span>
              <strong>Task completed.</strong> Save key findings to this Bot&apos;s persistent
              memory?
            </span>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-xs"
            data-testid={`save-task-memory-btn-${agentRunId}`}
            onClick={(e) => {
              e.stopPropagation()
              onSaveAsMemory()
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 10px',
              fontSize: '11.5px',
              color: '#6d28d9',
              borderColor: '#ddd6fe',
              backgroundColor: '#ffffff'
            }}
          >
            <Brain size={12} aria-hidden="true" />
            <span>Save as Bot Memory</span>
          </button>
        </div>
      )}

      {/* Expanded Tool Activities List */}
      {isExpanded && (
        <div
          className="task-timeline-body"
          data-testid={`timeline-body-${agentRunId}`}
          style={{ padding: '12px 14px', backgroundColor: '#ffffff' }}
        >
          {toolActivities.length === 0 ? (
            <div
              className="text-muted"
              data-testid={`timeline-empty-${agentRunId}`}
              style={{
                fontSize: '12px',
                color: '#64748b',
                fontStyle: 'italic',
                padding: '6px 0'
              }}
            >
              {isLive
                ? 'Executing initial analysis...'
                : 'No tool operations were executed in this run.'}
            </div>
          ) : (
            <div className="tool-activities-list" data-testid={`tool-activities-${agentRunId}`}>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#64748b',
                  marginBottom: '8px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}
              >
                Executed Tool Actions ({toolActivities.length})
              </div>

              {toolActivities.map((tool) => (
                <ToolExecutionCard
                  key={tool.id}
                  id={tool.id}
                  sequenceNumber={tool.sequenceNumber}
                  toolName={tool.toolName}
                  status={tool.status}
                  argumentsSummary={tool.argumentsSummary}
                  resultSummary={tool.resultSummary}
                  errorMessage={tool.errorMessage}
                  durationMs={tool.durationMs}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
