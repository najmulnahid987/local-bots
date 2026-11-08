import { ReactElement } from 'react'
import { Bot, FileText, CheckCircle2, AlertCircle, Sparkles, Clock, Activity } from 'lucide-react'
import type {
  KnowledgeBaseActivityItemDto,
  KnowledgeBaseActivityType
} from '../../../../shared/knowledge-bases'

export interface KnowledgeBaseRecentActivityProps {
  readonly activity: readonly KnowledgeBaseActivityItemDto[]
}

interface ActivityMeta {
  readonly icon: ReactElement
  readonly typeLabel: string
  readonly iconClassName: string
}

function getActivityMeta(type: KnowledgeBaseActivityType): ActivityMeta {
  switch (type) {
    case 'bot_created':
      return {
        icon: <Bot size={16} aria-hidden="true" />,
        typeLabel: 'Bot created',
        iconClassName: 'activity-icon-bot'
      }
    case 'bot_updated':
      return {
        icon: <Bot size={16} aria-hidden="true" />,
        typeLabel: 'Bot updated',
        iconClassName: 'activity-icon-bot'
      }
    case 'document_registered':
      return {
        icon: <FileText size={16} aria-hidden="true" />,
        typeLabel: 'Document registered',
        iconClassName: 'activity-icon-doc'
      }
    case 'document_indexed':
      return {
        icon: <CheckCircle2 size={16} aria-hidden="true" />,
        typeLabel: 'Document indexed',
        iconClassName: 'activity-icon-success'
      }
    case 'document_failed':
      return {
        icon: <AlertCircle size={16} aria-hidden="true" />,
        typeLabel: 'Document processing failed',
        iconClassName: 'activity-icon-error'
      }
    case 'agent_run':
      return {
        icon: <Sparkles size={16} aria-hidden="true" />,
        typeLabel: 'AI agent execution',
        iconClassName: 'activity-icon-agent'
      }
    default:
      return {
        icon: <Activity size={16} aria-hidden="true" />,
        typeLabel: 'Activity',
        iconClassName: 'activity-icon-default'
      }
  }
}

function formatActivityTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return String(timestamp)
  }
}

function sanitizeDetail(detail?: string): string | undefined {
  if (!detail) return undefined
  return detail.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
}

export function KnowledgeBaseRecentActivity({
  activity
}: KnowledgeBaseRecentActivityProps): ReactElement {
  if (!activity || activity.length === 0) {
    return (
      <div className="overview-activity-empty" data-testid="activity-empty-state">
        <Activity
          size={24}
          className="text-secondary"
          style={{ opacity: 0.5, marginBottom: '6px' }}
          aria-hidden="true"
        />
        <p>No recent workspace activity.</p>
      </div>
    )
  }

  return (
    <ul className="overview-activity-list" data-testid="activity-list">
      {activity.map((item) => {
        const meta = getActivityMeta(item.type)
        const formattedTime = formatActivityTime(item.timestamp)
        const safeDetail = sanitizeDetail(item.detail)

        return (
          <li
            key={item.id}
            className="overview-activity-item"
            data-testid={`activity-item-${item.id}`}
          >
            <div className={`overview-activity-icon ${meta.iconClassName}`}>{meta.icon}</div>
            <div className="overview-activity-content">
              <div className="overview-activity-top-row">
                <span className="overview-activity-type">{meta.typeLabel}</span>
                <time
                  className="overview-activity-time"
                  dateTime={new Date(item.timestamp).toISOString()}
                >
                  <Clock size={11} aria-hidden="true" />
                  {formattedTime}
                </time>
              </div>
              <div className="overview-activity-title" title={item.title}>
                {item.title}
              </div>
              {safeDetail && (
                <div className="overview-activity-detail" title={safeDetail}>
                  {safeDetail}
                </div>
              )}
            </div>
            {item.status && (
              <span
                className={`overview-activity-status status-${item.status}`}
                data-testid={`activity-status-${item.status}`}
              >
                {item.status}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
