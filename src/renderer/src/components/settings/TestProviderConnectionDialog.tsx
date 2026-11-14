import { ReactElement, useState, useMemo, KeyboardEvent } from 'react'
import { X, Loader2, Play, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import type {
  ProviderConnectionSummary,
  ProviderCatalogDto,
  ConnectionTestResult,
  ModelDescriptorDto
} from '../../../../shared/providers'

export interface TestProviderConnectionDialogProps {
  readonly isOpen?: boolean
  readonly connection: ProviderConnectionSummary | null
  readonly catalog: ProviderCatalogDto | null
  readonly onClose: () => void
  readonly onTested: () => void
}

export function TestProviderConnectionDialog({
  isOpen = true,
  connection,
  catalog,
  onClose,
  onTested
}: TestProviderConnectionDialogProps): ReactElement | null {
  const selectableModels = useMemo(() => {
    return (catalog?.models ?? []).filter(
      (m) => m.providerId === connection?.providerId && m.availability !== 'deprecated'
    )
  }, [catalog?.models, connection?.providerId])

  const initialModelId = useMemo(() => {
    const provider = catalog?.providers.find((p) => p.id === connection?.providerId)
    const defaultModel = provider?.defaultModelId
    if (defaultModel && selectableModels.some((m) => m.id === defaultModel)) {
      return defaultModel
    }
    return selectableModels[0]?.id ?? ''
  }, [catalog?.providers, connection?.providerId, selectableModels])

  const [selectedModelId, setSelectedModelId] = useState<string>(initialModelId)
  const [isTesting, setIsTesting] = useState<boolean>(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  if (!isOpen || !connection) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isTesting) {
      onClose()
    }
  }

  const handleRunTest = async (): Promise<void> => {
    setIsTesting(true)
    setTestResult(null)
    setTestError(null)

    try {
      const res = await window.api.providers.testConnection({
        connectionId: connection.id,
        modelId: selectedModelId || undefined
      })

      setTestResult(res)
      // Refresh connection status in parent (e.g. from error -> active or vice-versa)
      onTested()

      if (!res.ok || !res.success) {
        setTestError(res.error?.message || 'Connection test failed.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to execute connection test.'
      setTestError(msg)
      onTested()
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="test-connection-dialog"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="test-connection-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Play size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="test-connection-title" className="modal-title">
              Test Connection: {connection.label}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isTesting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            Send a zero-token or minimal handshake request directly to the provider endpoint to
            verify credentials and API health.
          </p>

          <div className="form-group">
            <label htmlFor="test-model-select" className="form-label">
              Model to Test
            </label>
            {selectableModels.length > 0 ? (
              <select
                id="test-model-select"
                className="form-select"
                value={selectedModelId}
                disabled={isTesting}
                onChange={(e) => setSelectedModelId(e.target.value)}
              >
                {selectableModels.map((m: ModelDescriptorDto) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.availability === 'preview' ? ' (Preview)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="form-empty-note">No models available for testing.</p>
            )}
            <span className="form-helper">
              Provider testing will issue a live request using model{' '}
              <code>{selectedModelId || 'default'}</code>.
            </span>
          </div>

          {testResult && testResult.ok && testResult.success && (
            <div
              className="form-alert form-alert-success"
              role="status"
              data-testid="test-success-banner"
            >
              <div className="alert-content-row">
                <CheckCircle2 size={18} className="alert-icon" aria-hidden="true" />
                <div>
                  <strong>Connection Verified!</strong>
                  <p className="alert-subtext">
                    Successfully authenticated with {connection.providerId} using{' '}
                    <code>{testResult.testedModelId}</code>. Latency: {testResult.latencyMs}ms.
                  </p>
                  {testResult.availableModels && testResult.availableModels.length > 0 && (
                    <p
                      className="alert-subtext font-medium"
                      style={{ color: 'var(--color-accent, #6366f1)', marginTop: '4px' }}
                    >
                      ✓ {testResult.availableModels.length} models detected and available for this
                      key.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {testError && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              data-testid="test-error-banner"
            >
              <div className="alert-content-row">
                <AlertCircle size={18} className="alert-icon" aria-hidden="true" />
                <div>
                  <strong>Connection Test Failed</strong>
                  <p className="alert-subtext">{testError}</p>
                  <p className="alert-footnote">
                    <Info size={12} className="inline-icon" aria-hidden="true" />
                    Note: A temporary network timeout or offline state does not necessarily mean
                    your API key is invalid.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isTesting}
          >
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRunTest}
            disabled={isTesting}
            data-testid="run-test-button"
          >
            {isTesting ? (
              <>
                <Loader2 size={16} className="inline-icon spinner" aria-hidden="true" />
                Testing Handshake...
              </>
            ) : (
              'Run Test'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
