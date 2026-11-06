import { ReactElement } from 'react'

export function KnowledgeBasesPage(): ReactElement {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Knowledge Bases</h1>
        <p className="page-description">
          Organize your documents and shared knowledge in independent workspaces.
        </p>
      </header>

      <section className="empty-state-section" aria-label="Knowledge Bases Status">
        <div className="empty-state-card">
          <h2 className="empty-state-heading">No Knowledge Bases yet</h2>
          <p className="empty-state-text">
            Your Knowledge Bases will appear here once you create them.
          </p>
        </div>
      </section>
    </div>
  )
}
