import { ReactElement } from 'react'
import {
  ShieldCheck,
  AlertTriangle,
  Play,
  Key,
  Pencil,
  Trash2,
  Server,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import type {
  ProviderConnectionSummary,
  ProviderCatalogDto,
  ProviderConnectionStatus
} from '../../../../shared/providers'

export interface ProviderConnectionCardProps {
  readonly connection: ProviderConnectionSummary
  readonly catalog: ProviderCatalogDto | null
  readonly onTest: (connection: ProviderConnectionSummary) => void
  readonly onReplaceKey: (connection: ProviderConnectionSummary) => void
  readonly onEditLabel: (connection: ProviderConnectionSummary) => void
  readonly onRemove: (connection: ProviderConnectionSummary) => void
}

function getProviderDisplayName(providerId: string, catalog: ProviderCatalogDto | null): string {
  const match = catalog?.providers.find((p) => p.id === providerId)
  if (match) return match.displayName
  if (providerId === 'openai') return 'OpenAI'
  if (providerId === 'anthropic') return 'Anthropic'
  if (providerId === 'google') return 'Google Gemini'
  if (providerId === 'groq') return 'Groq'
  if (providerId === 'openrouter') return 'OpenRouter'
  if (providerId === 'perplexity') return 'Perplexity'
  return providerId
}

function renderStatusBadge(status: ProviderConnectionStatus): ReactElement {
  switch (status) {
    case 'active':
      return (
        <span
          className="status-badge status-badge-active"
          title="Connection is active and verified"
        >
          <CheckCircle2 size={13} className="inline-icon" aria-hidden="true" />
          Active
        </span>
      )
    case 'error':
      return (
        <span className="status-badge status-badge-error" title="Connection encountered an error">
          <AlertCircle size={13} className="inline-icon" aria-hidden="true" />
          Error
        </span>
      )
    case 'revoked':
      return (
        <span
          className="status-badge status-badge-revoked"
          title="Connection credential has been revoked or expired"
        >
          <AlertTriangle size={13} className="inline-icon" aria-hidden="true" />
          Revoked
        </span>
      )
    default:
      return <span className="status-badge status-badge-neutral">{status}</span>
  }
}

export function ProviderConnectionCard({
  connection,
  catalog,
  onTest,
  onReplaceKey,
  onEditLabel,
  onRemove
}: ProviderConnectionCardProps): ReactElement {
  const providerName = getProviderDisplayName(connection.providerId, catalog)

  return (
    <article
      className="provider-card"
      data-testid={`provider-connection-card-${connection.id}`}
      aria-label={`Connection ${connection.label} (${providerName})`}
    >
      <div className="provider-card-header">
        <div className="provider-card-identity">
          <div className="provider-card-avatar" aria-hidden="true">
            <Server size={20} className="provider-avatar-icon" />
          </div>
          <div>
            <div className="provider-card-title-row">
              <h3 className="provider-card-label">{connection.label}</h3>
              {renderStatusBadge(connection.status)}
            </div>
            <div className="provider-card-meta">
              <span className="provider-name-tag">{providerName}</span>
              <span className="meta-separator" aria-hidden="true">
                •
              </span>
              {connection.hasCredential ? (
                <span
                  className="credential-indicator credential-present"
                  title="Encrypted in operating system safeStorage vault"
                >
                  <ShieldCheck size={13} className="inline-icon" aria-hidden="true" />
                  Key Stored (OS Vault)
                </span>
              ) : (
                <span
                  className="credential-indicator credential-missing"
                  title="No credential found in safeStorage"
                >
                  <AlertTriangle size={13} className="inline-icon" aria-hidden="true" />
                  Missing Key
                </span>
              )}
              {connection.availableModels && connection.availableModels.length > 0 && (
                <>
                  <span className="meta-separator" aria-hidden="true">
                    •
                  </span>
                  <span
                    className="credential-indicator credential-present"
                    title={`${connection.availableModels.length} models verified for this key`}
                  >
                    {connection.availableModels.length} Models
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="provider-card-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onTest(connection)}
          aria-label={`Test connection ${connection.label}`}
        >
          <Play size={13} className="inline-icon" aria-hidden="true" />
          Test
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onReplaceKey(connection)}
          aria-label={`Replace API key for ${connection.label}`}
        >
          <Key size={13} className="inline-icon" aria-hidden="true" />
          Replace Key
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onEditLabel(connection)}
          aria-label={`Edit label for ${connection.label}`}
        >
          <Pencil size={13} className="inline-icon" aria-hidden="true" />
          Edit Label
        </button>

        <button
          type="button"
          className="btn btn-danger-outline btn-sm"
          onClick={() => onRemove(connection)}
          aria-label={`Remove connection ${connection.label}`}
        >
          <Trash2 size={13} className="inline-icon" aria-hidden="true" />
          Remove
        </button>
      </div>
    </article>
  )
}
