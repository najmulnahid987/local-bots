import { ReactElement } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import {
  Sparkles,
  Bot,
  FileText,
  Activity,
  Layers,
  RotateCw,
  AlertCircle,
  Loader2
} from 'lucide-react'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'
import { useKnowledgeBaseOverview } from '../../hooks/useKnowledgeBaseOverview'
import { KnowledgeBaseRecentActivity } from '../../components/kb/KnowledgeBaseRecentActivity'
import { formatBytes, formatCount } from '../../utils/formatters'

export interface WorkspaceOutletContext {
  readonly knowledgeBase: KnowledgeBaseDto
}

export function WorkspaceOverviewTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()
  const { overview, loading, refreshing, error, refresh } = useKnowledgeBaseOverview(
    knowledgeBase.id
  )

  return (
    <div className="workspace-tab-panel" data-testid="workspace-overview-tab">
      {/* Welcome & Refresh Header */}
      <div className="workspace-overview-welcome">
        <div className="overview-welcome-header">
          <div className="overview-welcome-title-group">
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

          <div className="overview-welcome-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void refresh()}
              disabled={loading || refreshing}
              title="Refresh workspace overview"
              aria-label="Refresh workspace overview"
              data-testid="btn-overview-refresh"
            >
              <RotateCw
                size={14}
                className={`inline-icon ${refreshing ? 'spinner' : ''}`}
                aria-hidden="true"
              />
              <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            className="section-alert section-alert-error"
            role="alert"
            data-testid="overview-error-state"
          >
            <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
            <div className="alert-body">
              <strong>Failed to load overview</strong>
              <span>{error}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: '8px', alignSelf: 'flex-start' }}
                onClick={() => void refresh()}
                data-testid="btn-overview-retry"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Initial Loading State */}
      {loading && !overview && (
        <div className="section-loading-state" role="status" data-testid="overview-loading-state">
          <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
          <span>Loading workspace overview...</span>
        </div>
      )}

      {/* Metrics Cards Grid */}
      {overview && (
        <>
          <div className="workspace-overview-cards-grid" data-testid="overview-metrics-grid">
            {/* Card 1: Specialized Bots */}
            <div className="overview-summary-card" data-testid="card-bots-stats">
              <div className="overview-card-header">
                <Bot size={18} className="text-secondary" aria-hidden="true" />
                <h3 className="overview-card-title">Specialized Bots</h3>
              </div>

              {overview.bots.total === 0 ? (
                <p className="overview-card-empty" data-testid="bots-empty-state">
                  No bots created in this workspace yet.
                </p>
              ) : (
                <>
                  <div className="overview-metric-primary" data-testid="bots-total-count">
                    {formatCount(overview.bots.total)}
                  </div>
                  <div className="overview-metric-breakdown">
                    <span className="overview-metric-stat" data-testid="bots-active-count">
                      <strong>{overview.bots.active}</strong> active
                    </span>
                    <span className="overview-metric-stat" data-testid="bots-archived-count">
                      <strong>{overview.bots.archived}</strong> archived
                    </span>
                  </div>
                </>
              )}

              <Link
                to={`/knowledge-bases/${knowledgeBase.id}/bots`}
                className="overview-card-link"
                data-testid="link-view-bots"
              >
                View Bots &rarr;
              </Link>
            </div>

            {/* Card 2: Knowledge Documents */}
            <div className="overview-summary-card" data-testid="card-docs-stats">
              <div className="overview-card-header">
                <FileText size={18} className="text-secondary" aria-hidden="true" />
                <h3 className="overview-card-title">Knowledge Documents</h3>
              </div>

              {overview.documents.total === 0 ? (
                <p className="overview-card-empty" data-testid="docs-empty-state">
                  No documents added to this workspace yet.
                </p>
              ) : (
                <>
                  <div className="overview-metric-primary" data-testid="docs-total-count">
                    {formatCount(overview.documents.total)}
                  </div>
                  <div className="overview-metric-breakdown">
                    <span className="overview-metric-stat" data-testid="docs-ready-count">
                      <strong>{overview.documents.ready}</strong> ready
                    </span>
                    <span className="overview-metric-stat" data-testid="docs-processing-count">
                      <strong>{overview.documents.processing}</strong> processing
                    </span>
                    {overview.documents.failed > 0 && (
                      <span
                        className="overview-metric-stat text-danger"
                        data-testid="docs-failed-count"
                      >
                        <strong>{overview.documents.failed}</strong> failed
                      </span>
                    )}
                    <span className="overview-metric-stat" data-testid="docs-bytes-count">
                      {formatBytes(overview.documents.totalBytes)}
                    </span>
                  </div>
                </>
              )}

              <Link
                to={`/knowledge-bases/${knowledgeBase.id}/knowledge`}
                className="overview-card-link"
                data-testid="link-view-knowledge"
              >
                View Knowledge &rarr;
              </Link>
            </div>

            {/* Card 3: Indexing Summary */}
            <div className="overview-summary-card" data-testid="card-indexing-stats">
              <div className="overview-card-header">
                <Layers size={18} className="text-secondary" aria-hidden="true" />
                <h3 className="overview-card-title">Indexing Summary</h3>
              </div>

              {overview.indexing.totalChunks === 0 ? (
                <p className="overview-card-empty" data-testid="indexing-empty-state">
                  No chunks generated yet.
                </p>
              ) : (
                <>
                  <div className="overview-metric-primary" data-testid="indexing-chunks-count">
                    {formatCount(overview.indexing.totalChunks)} chunks
                  </div>
                  <div className="overview-metric-breakdown">
                    <span className="overview-metric-stat" data-testid="indexing-tokens-count">
                      <strong>{formatCount(overview.indexing.totalTokens)}</strong> tokens
                    </span>
                  </div>
                </>
              )}

              <div className="overview-card-text" data-testid="indexing-last-indexed">
                <strong>Last indexed:</strong>{' '}
                {overview.indexing.lastIndexedAt
                  ? new Date(overview.indexing.lastIndexedAt).toLocaleString()
                  : 'Not indexed yet'}
              </div>

              <p className="overview-note">
                Document processing and full-text search will become available in a later
                implementation phase.
              </p>
            </div>
          </div>

          {/* Activity Section */}
          <div className="overview-activity-card" data-testid="workspace-activity-card">
            <div className="overview-card-header">
              <Activity size={18} className="text-secondary" aria-hidden="true" />
              <h3 className="overview-card-title">Recent Workspace Activity</h3>
            </div>
            <KnowledgeBaseRecentActivity activity={overview.recentActivity} />
          </div>
        </>
      )}
    </div>
  )
}
