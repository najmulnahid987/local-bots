import { ReactElement } from 'react'
import { Link } from 'react-router-dom'

export function HomePage(): ReactElement {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Welcome to your AI workspace</h1>
        <p className="page-description">
          A focused space for your knowledge, AI teammates, and work.
        </p>
      </header>

      <section className="empty-state-section" aria-label="Workspace Status">
        <div className="empty-state-card">
          <h2 className="empty-state-heading">Your workspace is ready</h2>
          <p className="empty-state-text">
            Your Knowledge Bases and Bots will appear here as you build your workspace.
          </p>
          <div className="empty-state-actions">
            <Link to="/knowledge-bases" className="btn-primary-link">
              Explore Knowledge Bases
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
