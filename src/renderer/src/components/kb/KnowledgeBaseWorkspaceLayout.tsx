import { ReactElement, useEffect, useRef } from 'react'
import { useParams, useLocation, NavLink, Link, Outlet, Navigate } from 'react-router-dom'
import {
  FolderOpen,
  Check,
  AlertCircle,
  Loader2,
  LayoutDashboard,
  FileText,
  Bot,
  Activity,
  Settings
} from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  knowledge: 'Knowledge',
  bots: 'Bots',
  activity: 'Activity',
  settings: 'Settings'
}

export function KnowledgeBaseWorkspaceLayout(): ReactElement {
  const { kbId } = useParams<{ kbId: string }>()
  const location = useLocation()

  const {
    knowledgeBases,
    activeKnowledgeBaseId,
    selectKnowledgeBase,
    loading,
    initialized,
    refresh
  } = useKnowledgeBases()

  const attemptedRefreshRef = useRef<boolean>(false)

  // 1. UUID Format Validation Guard
  const isValidUuid = Boolean(kbId && UUID_REGEX.test(kbId))

  // Find KB in authoritative context collection
  const kb = isValidUuid ? knowledgeBases.find((item) => item.id === kbId) : undefined

  // Attempt refresh if initialized but KB not found in memory (e.g. freshly created or deleted)
  useEffect(() => {
    if (isValidUuid && initialized && !kb && !attemptedRefreshRef.current) {
      attemptedRefreshRef.current = true
      void refresh()
    }
  }, [isValidUuid, initialized, kb, refresh])

  // Synchronize active workspace when valid and not archived
  useEffect(() => {
    if (kb && kb.archivedAt === null && activeKnowledgeBaseId !== kb.id) {
      selectKnowledgeBase(kb.id)
    }
  }, [kb, activeKnowledgeBaseId, selectKnowledgeBase])

  // Handle invalid UUID
  if (!isValidUuid) {
    return (
      <div className="workspace-container" data-testid="workspace-invalid-uuid">
        <div className="section-alert section-alert-error" role="alert">
          <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Invalid Workspace Identifier</strong>
            <span>The identifier &ldquo;{kbId}&rdquo; is not a valid UUID format.</span>
            <Link
              to="/knowledge-bases"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '8px', alignSelf: 'flex-start' }}
              data-testid="btn-invalid-uuid-return"
            >
              Return to Knowledge Bases
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Handle context loading
  if (loading && !initialized) {
    return (
      <div className="workspace-container" data-testid="workspace-loading-state">
        <div className="section-loading-state" role="status">
          <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
          <span>Loading workspace...</span>
        </div>
      </div>
    )
  }

  // Handle missing or deleted KB (after refresh attempt)
  if (!kb) {
    return (
      <div className="workspace-container" data-testid="workspace-not-found">
        <section className="empty-state-section" aria-label="Workspace Not Found">
          <div className="empty-state-card">
            <FolderOpen
              size={48}
              style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
              aria-hidden="true"
            />
            <h2 className="empty-state-heading">Workspace Not Found</h2>
            <p className="empty-state-text">
              The requested Knowledge Base does not exist or may have been deleted.
            </p>
            <div className="empty-state-actions">
              <Link to="/knowledge-bases" className="btn btn-primary" data-testid="btn-return-kbs">
                Return to Knowledge Bases
              </Link>
            </div>
          </div>
        </section>
      </div>
    )
  }

  // Handle archived KB: Archived KBs cannot be active workspaces
  if (kb.archivedAt !== null) {
    return (
      <Navigate
        to="/knowledge-bases"
        replace
        state={{
          archivedNotice: `Knowledge Base "${kb.name}" is archived and must be restored before opening.`
        }}
      />
    )
  }

  // Calculate current active tab for breadcrumbs
  const segments = location.pathname.split('/').filter(Boolean)
  const tabIndex = segments.indexOf(kb.id)
  const currentTabSegment =
    tabIndex !== -1 && segments[tabIndex + 1] ? segments[tabIndex + 1] : 'overview'
  const activeTabLabel = TAB_LABELS[currentTabSegment] || 'Overview'

  return (
    <div className="workspace-container" data-testid={`workspace-${kb.id}`}>
      {/* Breadcrumb Navigation */}
      <nav
        aria-label="Breadcrumb"
        className="kb-breadcrumb-nav"
        data-testid="workspace-breadcrumbs"
      >
        <ol className="kb-breadcrumb-list">
          <li className="kb-breadcrumb-item">
            <Link
              to="/knowledge-bases"
              className="kb-breadcrumb-link"
              data-testid="breadcrumb-link-kbs"
            >
              Knowledge Bases
            </Link>
          </li>
          <li className="kb-breadcrumb-separator" aria-hidden="true">
            /
          </li>
          <li className="kb-breadcrumb-item">
            <Link
              to={`/knowledge-bases/${kb.id}/overview`}
              className="kb-breadcrumb-link"
              data-testid="breadcrumb-link-workspace"
            >
              {kb.name}
            </Link>
          </li>
          <li className="kb-breadcrumb-separator" aria-hidden="true">
            /
          </li>
          <li
            className="kb-breadcrumb-item current"
            aria-current="page"
            data-testid="breadcrumb-current-tab"
          >
            {activeTabLabel}
          </li>
        </ol>
      </nav>

      {/* Workspace Header */}
      <header className="workspace-header">
        <div className="workspace-header-title-row">
          <div className="workspace-title-group">
            <h1 className="workspace-title" data-testid="workspace-title">
              {kb.name}
            </h1>
            <div className="kb-card-badges">
              <span
                className="status-badge status-badge-active"
                data-testid="workspace-badge-active"
              >
                Active
              </span>
              <span
                className="status-badge status-badge-active"
                data-testid="workspace-badge-current"
              >
                <Check size={12} className="inline-icon" aria-hidden="true" /> Current Workspace
              </span>
            </div>
          </div>
        </div>

        {kb.description && (
          <p className="workspace-description" data-testid="workspace-description">
            {kb.description}
          </p>
        )}

        {/* Tab Navigation */}
        <nav className="workspace-tab-bar" aria-label="Workspace tabs" role="tablist">
          <NavLink
            to={`/knowledge-bases/${kb.id}/overview`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={currentTabSegment === 'overview'}
            data-testid="tab-overview"
          >
            <LayoutDashboard size={15} className="inline-icon" aria-hidden="true" /> Overview
          </NavLink>
          <NavLink
            to={`/knowledge-bases/${kb.id}/knowledge`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={currentTabSegment === 'knowledge'}
            data-testid="tab-knowledge"
          >
            <FileText size={15} className="inline-icon" aria-hidden="true" /> Knowledge
          </NavLink>
          <NavLink
            to={`/knowledge-bases/${kb.id}/bots`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={currentTabSegment === 'bots'}
            data-testid="tab-bots"
          >
            <Bot size={15} className="inline-icon" aria-hidden="true" /> Bots
          </NavLink>
          <NavLink
            to={`/knowledge-bases/${kb.id}/activity`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={currentTabSegment === 'activity'}
            data-testid="tab-activity"
          >
            <Activity size={15} className="inline-icon" aria-hidden="true" /> Activity
          </NavLink>
          <NavLink
            to={`/knowledge-bases/${kb.id}/settings`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={currentTabSegment === 'settings'}
            data-testid="tab-settings"
          >
            <Settings size={15} className="inline-icon" aria-hidden="true" /> Settings
          </NavLink>
        </nav>
      </header>

      {/* Main Tab Content */}
      <main className="workspace-content" tabIndex={-1}>
        <Outlet context={{ knowledgeBase: kb }} />
      </main>
    </div>
  )
}
