import { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import { House, Database, Activity, Settings, Box } from 'lucide-react'

export function Sidebar(): ReactElement {
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
