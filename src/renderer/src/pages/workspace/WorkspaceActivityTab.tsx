import { ReactElement } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Activity, Info } from 'lucide-react'
import type { WorkspaceOutletContext } from './WorkspaceOverviewTab'

export function WorkspaceActivityTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()

  return (
    <div className="workspace-tab-panel" data-testid="workspace-activity-tab">
      <div className="workspace-panel-header">
        <h2 className="workspace-panel-title">Workspace Activity</h2>
        <p className="workspace-panel-subtitle">
          Recent actions and events within {knowledgeBase.name}.
        </p>
      </div>

      <div className="section-alert section-alert-info">
        <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
        <div className="alert-body">
          <strong>Scoped Activity Audit</strong>
          <span>
            Activity records shown here are strictly isolated to this Knowledge Base and distinct
            from global application events.
          </span>
        </div>
      </div>

      <div className="empty-state-section" data-testid="workspace-activity-empty">
        <div className="empty-state-card">
          <Activity
            size={44}
            style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
            aria-hidden="true"
          />
          <h3 className="empty-state-heading">No recent workspace activity</h3>
          <p className="empty-state-text">
            Audit logs for document ingestion, query executions, and Bot thread sessions will appear
            here as you work.
          </p>
        </div>
      </div>
    </div>
  )
}
