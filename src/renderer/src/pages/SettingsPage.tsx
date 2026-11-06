import { ReactElement } from 'react'

export function SettingsPage(): ReactElement {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-description">Manage your application preferences.</p>
      </header>

      <section className="empty-state-section" aria-label="Settings Status">
        <div className="empty-state-card">
          <h2 className="empty-state-heading">Settings are not available yet</h2>
          <p className="empty-state-text">
            Application preferences will be introduced in a later development phase.
          </p>
        </div>
      </section>
    </div>
  )
}
