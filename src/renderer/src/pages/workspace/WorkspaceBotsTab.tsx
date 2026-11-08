import { ReactElement } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Bot, Info } from 'lucide-react'
import type { WorkspaceOutletContext } from './WorkspaceOverviewTab'

export function WorkspaceBotsTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()

  return (
    <div className="workspace-tab-panel" data-testid="workspace-bots-tab">
      <div className="workspace-panel-header">
        <h2 className="workspace-panel-title">AI Bots</h2>
        <p className="workspace-panel-subtitle">
          Specialized AI Bots configured to work within {knowledgeBase.name}.
        </p>
      </div>

      <div className="section-alert section-alert-info">
        <Info size={18} className="inline-icon text-accent" aria-hidden="true" />
        <div className="alert-body">
          <strong>Bot Creation Scoped to Knowledge Base</strong>
          <span>
            Every Bot belongs strictly to this Knowledge Base. There is no global Bot collection.
            Bot creation and configuration interfaces will be implemented in subsequent steps.
          </span>
        </div>
      </div>

      <div className="empty-state-section" data-testid="workspace-bots-empty">
        <div className="empty-state-card">
          <Bot
            size={44}
            style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
            aria-hidden="true"
          />
          <h3 className="empty-state-heading">No Bots created yet</h3>
          <p className="empty-state-text">
            You will be able to create and deploy specialized Bots with custom prompts and tools
            inside this Knowledge Base.
          </p>
        </div>
      </div>
    </div>
  )
}
