import { ReactElement } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Sparkles, Info, Bot, FileText, Activity } from 'lucide-react'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

export interface WorkspaceOutletContext {
  readonly knowledgeBase: KnowledgeBaseDto
}

export function WorkspaceOverviewTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()

  return (
    <div className="workspace-tab-panel" data-testid="workspace-overview-tab">
      <div className="workspace-overview-welcome">
        <div className="overview-welcome-header">
          <div className="overview-welcome-icon" aria-hidden="true">
            <Sparkles size={24} />
          </div>
          <div>
            <h2 className="overview-welcome-title">Welcome to {knowledgeBase.name}</h2>
            <p className="overview-welcome-subtitle">
              {knowledgeBase.description || 'Dedicated workspace for your documents and AI Bots.'}
            </p>
          </div>
        </div>

        <div className="section-alert section-alert-info">
          <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
          <div className="alert-body">
            <strong>Workspace Shell Ready</strong>
            <span>
              Detailed summaries, indexing progress, and bot activity metrics will be implemented in
              Step 4.6. All data within this workspace remains strictly isolated to this Knowledge
              Base.
            </span>
          </div>
        </div>
      </div>

      <div className="workspace-overview-cards-grid">
        <div className="overview-summary-card">
          <div className="overview-card-header">
            <FileText size={18} className="text-secondary" aria-hidden="true" />
            <h3 className="overview-card-title">Knowledge Documents</h3>
          </div>
          <p className="overview-card-text">
            Shared document collection for this workspace. Ingestion and FTS5 indexing will be
            available in later phases.
          </p>
        </div>

        <div className="overview-summary-card">
          <div className="overview-card-header">
            <Bot size={18} className="text-secondary" aria-hidden="true" />
            <h3 className="overview-card-title">Specialized Bots</h3>
          </div>
          <p className="overview-card-text">
            Autonomous AI Bots scoped exclusively to this Knowledge Base. Cross-Knowledge-Base data
            access is prevented at all layers.
          </p>
        </div>

        <div className="overview-summary-card">
          <div className="overview-card-header">
            <Activity size={18} className="text-secondary" aria-hidden="true" />
            <h3 className="overview-card-title">Workspace Activity</h3>
          </div>
          <p className="overview-card-text">
            Workspace-specific audit log and interaction history will be displayed here.
          </p>
        </div>
      </div>
    </div>
  )
}
