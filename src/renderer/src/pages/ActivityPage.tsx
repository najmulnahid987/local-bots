import { ReactElement } from 'react'

export function ActivityPage(): ReactElement {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Activity</h1>
        <p className="page-description">Keep track of work and activity across your workspace.</p>
      </header>

      <section className="empty-state-section" aria-label="Activity Status">
        <div className="empty-state-card">
          <h2 className="empty-state-heading">No activity yet</h2>
          <p className="empty-state-text">
            Your workspace activity will appear here when you start working with your Bots.
          </p>
        </div>
      </section>
    </div>
  )
}
