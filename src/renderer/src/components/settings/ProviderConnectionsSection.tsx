import { ReactElement, useState, useEffect, useCallback } from 'react'
import { Plus, RefreshCw, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'
import { ProviderConnectionCard } from './ProviderConnectionCard'
import { AddProviderConnectionDialog } from './AddProviderConnectionDialog'
import { TestProviderConnectionDialog } from './TestProviderConnectionDialog'
import { ReplaceProviderCredentialDialog } from './ReplaceProviderCredentialDialog'
import { EditProviderLabelDialog } from './EditProviderLabelDialog'
import { RemoveProviderConnectionDialog } from './RemoveProviderConnectionDialog'
import { ProviderPrivacyInformation } from './ProviderPrivacyInformation'

export function ProviderConnectionsSection(): ReactElement {
  const [catalog, setCatalog] = useState<ProviderCatalogDto | null>(null)
  const [connections, setConnections] = useState<readonly ProviderConnectionSummary[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notification, setNotification] = useState<{
    type: 'success' | 'info'
    message: string
  } | null>(null)

  // Modals state
  const [isAddOpen, setIsAddOpen] = useState<boolean>(false)
  const [testingConnection, setTestingConnection] = useState<ProviderConnectionSummary | null>(null)
  const [replacingConnection, setReplacingConnection] = useState<ProviderConnectionSummary | null>(
    null
  )
  const [editingConnection, setEditingConnection] = useState<ProviderConnectionSummary | null>(null)
  const [removingConnection, setRemovingConnection] = useState<ProviderConnectionSummary | null>(
    null
  )

  const showNotification = useCallback((message: string, type: 'success' | 'info' = 'success') => {
    setNotification({ type, message })
    const timer = setTimeout(() => {
      setNotification((curr) => (curr?.message === message ? null : curr))
    }, 4500)
    return () => clearTimeout(timer)
  }, [])

  const reloadAll = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setLoadError(null)

    try {
      if (!window.api?.providers) {
        throw new Error('AI provider service bridge is not available in this window.')
      }

      const [loadedCatalog, loadedConnections] = await Promise.all([
        window.api.providers.getCatalog(),
        window.api.providers.listConnections()
      ])

      setCatalog(loadedCatalog)
      setConnections(loadedConnections)
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to connect to the local provider manager.'
      setLoadError(msg)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const initializeData = async (): Promise<void> => {
      try {
        if (!window.api?.providers) {
          throw new Error('AI provider service bridge is not available in this window.')
        }

        const [loadedCatalog, loadedConnections] = await Promise.all([
          window.api.providers.getCatalog(),
          window.api.providers.listConnections()
        ])

        if (isMounted) {
          setCatalog(loadedCatalog)
          setConnections(loadedConnections)
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg =
            err instanceof Error ? err.message : 'Failed to connect to the local provider manager.'
          setLoadError(msg)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    void initializeData()

    return () => {
      isMounted = false
    }
  }, [])

  const refreshConnections = useCallback(async (): Promise<void> => {
    try {
      if (!window.api?.providers) return
      const updated = await window.api.providers.listConnections()
      setConnections(updated)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to refresh connection list.'
      setLoadError(msg)
    }
  }, [])

  return (
    <section className="settings-section" aria-labelledby="provider-connections-heading">
      <div className="settings-section-header">
        <div className="section-title-group">
          <h2 id="provider-connections-heading" className="section-title">
            AI Provider Connections
          </h2>
          <p className="section-description">
            Connect your own AI provider accounts. Your API credentials are encrypted and stored
            locally on this device.
          </p>
        </div>

        <div className="section-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={reloadAll}
            disabled={isLoading}
            aria-label="Refresh connections"
            title="Refresh connections"
          >
            <RefreshCw size={15} className={isLoading ? 'spinner' : ''} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAddOpen(true)}
            disabled={isLoading || Boolean(loadError && !catalog)}
            data-testid="add-connection-button"
          >
            <Plus size={16} className="inline-icon" aria-hidden="true" />
            Add Connection
          </button>
        </div>
      </div>

      {notification && (
        <div
          className={`section-notification section-notification-${notification.type}`}
          role="status"
          data-testid="section-notification"
        >
          <CheckCircle2 size={16} className="inline-icon" aria-hidden="true" />
          <span>{notification.message}</span>
        </div>
      )}

      {loadError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="provider-load-error"
        >
          <AlertCircle size={18} className="alert-icon" aria-hidden="true" />
          <div className="alert-body">
            <strong>Provider Service Unavailable</strong>
            <p>{loadError}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm retry-btn"
              onClick={reloadAll}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="section-content">
        {isLoading && connections.length === 0 ? (
          <div className="section-loading-state" data-testid="providers-loading">
            <Loader2 size={24} className="spinner text-accent" aria-hidden="true" />
            <span>Loading provider configurations...</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="empty-state-card" data-testid="no-connections-empty-state">
            <h3 className="empty-state-heading">No provider connections yet.</h3>
            <p className="empty-state-text">
              Add your own OpenAI, Anthropic, or Google API keys to get started. Credentials are
              encrypted using OS safeStorage and never leave your machine without direct TLS 1.3
              handshakes.
            </p>
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setIsAddOpen(true)}
                disabled={Boolean(loadError && !catalog)}
              >
                <Plus size={16} className="inline-icon" aria-hidden="true" />
                Add Connection
              </button>
            </div>
          </div>
        ) : (
          <div className="provider-connections-list" data-testid="provider-connections-list">
            {connections.map((conn) => (
              <ProviderConnectionCard
                key={conn.id}
                connection={conn}
                catalog={catalog}
                onTest={(c) => setTestingConnection(c)}
                onReplaceKey={(c) => setReplacingConnection(c)}
                onEditLabel={(c) => setEditingConnection(c)}
                onRemove={(c) => setRemovingConnection(c)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="section-footer">
        <ProviderPrivacyInformation />
      </div>

      {/* Dialog Modals */}
      {isAddOpen && (
        <AddProviderConnectionDialog
          isOpen={isAddOpen}
          catalog={catalog}
          onClose={() => setIsAddOpen(false)}
          onSuccess={(created) => {
            refreshConnections()
            showNotification(`Connection "${created.label}" added and verified successfully.`)
          }}
        />
      )}

      {testingConnection && (
        <TestProviderConnectionDialog
          isOpen={testingConnection !== null}
          connection={testingConnection}
          catalog={catalog}
          onClose={() => setTestingConnection(null)}
          onTested={() => {
            refreshConnections()
          }}
        />
      )}

      {replacingConnection && (
        <ReplaceProviderCredentialDialog
          isOpen={replacingConnection !== null}
          connection={replacingConnection}
          catalog={catalog}
          onClose={() => setReplacingConnection(null)}
          onSuccess={(updated) => {
            refreshConnections()
            showNotification(`API key for "${updated.label}" replaced and re-encrypted.`)
          }}
        />
      )}

      {editingConnection && (
        <EditProviderLabelDialog
          isOpen={editingConnection !== null}
          connection={editingConnection}
          onClose={() => setEditingConnection(null)}
          onSuccess={(updated) => {
            refreshConnections()
            showNotification(`Connection label updated to "${updated.label}".`)
          }}
        />
      )}

      {removingConnection && (
        <RemoveProviderConnectionDialog
          isOpen={removingConnection !== null}
          connection={removingConnection}
          onClose={() => setRemovingConnection(null)}
          onSuccess={(result) => {
            refreshConnections()
            if (!result.credentialCleaned) {
              showNotification('Connection record removed. Credential cleanup is pending.', 'info')
            } else {
              showNotification('Connection and vault credentials deleted successfully.')
            }
          }}
        />
      )}
    </section>
  )
}
