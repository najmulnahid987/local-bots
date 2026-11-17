import { ReactElement } from 'react'
import { ProviderConnectionsSection } from '../components/settings/ProviderConnectionsSection'
import { DatabaseHealthSection } from '../components/settings/DatabaseHealthSection'
import { PrivacyTransparencySection } from '../components/settings/PrivacyTransparencySection'

export function SettingsPage(): ReactElement {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-description">Manage your application preferences.</p>
      </header>

      <ProviderConnectionsSection />
      <DatabaseHealthSection />
      <PrivacyTransparencySection />
    </div>
  )
}
