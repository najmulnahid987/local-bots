import { ReactElement, useState, useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  House,
  Database,
  Activity,
  Settings,
  Box,
  Folder,
  ChevronsUpDown,
  Check,
  ChevronRight
} from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'

export function Sidebar(): ReactElement {
  const { knowledgeBases, activeKnowledgeBase, selectKnowledgeBase } = useKnowledgeBases()
  const [isSwitcherOpen, setIsSwitcherOpen] = useState<boolean>(false)
  const switcherRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Only non-archived Knowledge Bases can be switched to
  const activeKbs = knowledgeBases.filter((kb) => kb.archivedAt === null)

  // Close dropdown on outside click or Escape key
  useEffect(() => {
    if (!isSwitcherOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setIsSwitcherOpen(false)
      }
    }

    const handleClickOutside = (e: MouseEvent): void => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setIsSwitcherOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isSwitcherOpen])

  return (
    <aside className="app-sidebar" aria-label="Main Navigation">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark" aria-hidden="true">
          <Box size={20} strokeWidth={2.2} />
        </div>
        <div className="sidebar-brand-info">
          <span className="sidebar-brand-name">Local AI Workspace</span>
        </div>
      </div>

      {/* Workspace Indicator & Quick-Switcher */}
      <div
        className="sidebar-workspace-section"
        ref={switcherRef}
        data-testid="sidebar-workspace-section"
      >
        <div className="sidebar-workspace-header">
          <span className="sidebar-workspace-label">Current Workspace</span>
        </div>

        {activeKnowledgeBase ? (
          <div className="sidebar-workspace-card" data-testid="sidebar-active-workspace-card">
            <NavLink
              to={`/knowledge-bases/${activeKnowledgeBase.id}/overview`}
              className="sidebar-workspace-link"
              title={`Open ${activeKnowledgeBase.name} overview`}
              data-testid="sidebar-active-workspace-link"
            >
              <Folder size={15} className="text-accent flex-shrink-0" aria-hidden="true" />
              <span className="sidebar-workspace-name">{activeKnowledgeBase.name}</span>
            </NavLink>

            <button
              type="button"
              className="sidebar-workspace-switcher-trigger"
              onClick={() => setIsSwitcherOpen((prev) => !prev)}
              aria-label="Switch workspace"
              aria-expanded={isSwitcherOpen}
              aria-haspopup="menu"
              data-testid="btn-sidebar-workspace-switcher"
              title="Switch workspace"
            >
              <ChevronsUpDown size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="sidebar-workspace-empty" data-testid="sidebar-workspace-empty">
            <span className="sidebar-workspace-empty-text">No workspace selected</span>
            <NavLink
              to="/knowledge-bases"
              className="sidebar-workspace-empty-link"
              data-testid="sidebar-link-choose-kb"
            >
              <span>Choose workspace</span>
              <ChevronRight size={12} aria-hidden="true" />
            </NavLink>
          </div>
        )}

        {/* Quick-Switcher Dropdown */}
        {isSwitcherOpen && (
          <div
            className="workspace-switcher-dropdown"
            role="menu"
            aria-label="Available workspaces"
            data-testid="workspace-switcher-dropdown"
          >
            <div className="workspace-switcher-list">
              {activeKbs.length === 0 ? (
                <div className="workspace-switcher-empty">No active workspaces</div>
              ) : (
                activeKbs.map((kb) => {
                  const isCurrent = activeKnowledgeBase?.id === kb.id
                  return (
                    <button
                      key={kb.id}
                      type="button"
                      className={`workspace-switcher-item ${isCurrent ? 'active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        selectKnowledgeBase(kb.id)
                        navigate(`/knowledge-bases/${kb.id}/overview`)
                        setIsSwitcherOpen(false)
                      }}
                      data-testid={`switcher-item-${kb.id}`}
                    >
                      <span className="workspace-switcher-item-name" title={kb.name}>
                        {kb.name}
                      </span>
                      {isCurrent && (
                        <Check size={14} className="text-accent flex-shrink-0" aria-hidden="true" />
                      )}
                    </button>
                  )
                })
              )}
            </div>

            <div className="workspace-switcher-footer">
              <NavLink
                to="/knowledge-bases"
                className="workspace-switcher-manage-link"
                onClick={() => setIsSwitcherOpen(false)}
                data-testid="switcher-manage-kbs-link"
              >
                <Database size={13} aria-hidden="true" />
                <span>Manage Knowledge Bases</span>
              </NavLink>
            </div>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        <NavLink
          to="/home"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          aria-label="Home"
        >
          <House size={18} strokeWidth={2} className="nav-icon" />
          <span className="nav-label">Home</span>
        </NavLink>

        <NavLink
          to="/knowledge-bases"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          aria-label="Knowledge Bases"
        >
          <Database size={18} strokeWidth={2} className="nav-icon" />
          <span className="nav-label">Knowledge Bases</span>
        </NavLink>

        <NavLink
          to="/activity"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          aria-label="Activity"
        >
          <Activity size={18} strokeWidth={2} className="nav-icon" />
          <span className="nav-label">Activity</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          aria-label="Settings"
        >
          <Settings size={18} strokeWidth={2} className="nav-icon" />
          <span className="nav-label">Settings</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <span className="footer-tag">Local-first workspace</span>
      </div>
    </aside>
  )
}
