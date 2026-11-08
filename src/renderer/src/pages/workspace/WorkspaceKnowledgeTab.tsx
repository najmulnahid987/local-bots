import { ReactElement } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FolderOpen, Info } from 'lucide-react'
import type { WorkspaceOutletContext } from './WorkspaceOverviewTab'

export function WorkspaceKnowledgeTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()

  return (
    <div className="workspace-tab-panel" data-testid="workspace-knowledge-tab">
      <div className="workspace-panel-header">
        <h2 className="workspace-panel-title">Knowledge Documents</h2>
        <p className="workspace-panel-subtitle">
          Manage shared documents, notes, and sources for {knowledgeBase.name}.
        </p>
      </div>

      <div className="section-alert section-alert-info">
        <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
        <div className="alert-body">
          <strong>Document Management Coming in Later Phase</strong>
          <span>
            Document upload, PDF/text parsing, and SQLite FTS5 search indexing are planned for Phase
            5.
          </span>
        </div>
      </div>

      <div className="empty-state-section" data-testid="workspace-knowledge-empty">
        <div className="empty-state-card">
          <FolderOpen
            size={44}
            style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
            aria-hidden="true"
          />
          <h3 className="empty-state-heading">No documents uploaded yet</h3>
          <p className="empty-state-text">
            Documents uploaded to this Knowledge Base will be shared across all Bots inside this
            workspace.
          </p>
        </div>
      </div>
    </div>
  )
}
