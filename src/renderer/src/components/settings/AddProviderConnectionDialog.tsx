import { ReactElement, useState, useMemo, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, KeyRound } from 'lucide-react'
import type {
  ProviderCatalogDto,
  ProviderId,
  ModelDescriptorDto,
  ProviderConnectionSummary
} from '../../../../shared/providers'

export interface AddProviderConnectionDialogProps {
  readonly isOpen?: boolean
  readonly catalog: ProviderCatalogDto | null
  readonly onClose: () => void
  readonly onSuccess: (connection: ProviderConnectionSummary) => void
}

export function AddProviderConnectionDialog({
  isOpen = true,
  catalog,
  onClose,
  onSuccess
}: AddProviderConnectionDialogProps): ReactElement | null {
  const providers = useMemo(() => catalog?.providers ?? [], [catalog?.providers])

  const initialProviderId: ProviderId = providers[0]?.id ?? 'openai'
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>(initialProviderId)

  // Non-deprecated models for the initially selected provider
  const initialSelectableModels = useMemo(() => {
    return (catalog?.models ?? []).filter(
      (m) => m.providerId === initialProviderId && m.availability !== 'deprecated'
    )
  }, [catalog?.models, initialProviderId])

  const initialDefaultModel = useMemo(() => {
    const prov = providers.find((p) => p.id === initialProviderId)
    const def = prov?.defaultModelId
    if (def && initialSelectableModels.some((m) => m.id === def)) {
      return def
    }
    return initialSelectableModels[0]?.id ?? ''
  }, [providers, initialProviderId, initialSelectableModels])

  const [selectedModelId, setSelectedModelId] = useState<string>(initialDefaultModel)
  const [label, setLabel] = useState<string>('')
  const [apiKey, setApiKey] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Selectable models for currently selected provider
  const selectableModels = useMemo(() => {
    return (catalog?.models ?? []).filter(
      (m) => m.providerId === selectedProviderId && m.availability !== 'deprecated'
    )
  }, [catalog?.models, selectedProviderId])

  if (!isOpen) return null

  const handleProviderChange = (newProviderId: ProviderId): void => {
    setSelectedProviderId(newProviderId)
    const prov = providers.find((p) => p.id === newProviderId)
    const newModels = (catalog?.models ?? []).filter(
      (m) => m.providerId === newProviderId && m.availability !== 'deprecated'
    )
    const newDefault =
      prov?.defaultModelId && newModels.some((m) => m.id === prov.defaultModelId)
        ? prov.defaultModelId
        : (newModels[0]?.id ?? '')
    setSelectedModelId(newDefault)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setErrorMessage(null)

    const trimmedLabel = label.trim()
    const trimmedKey = apiKey.trim()

    if (!trimmedLabel) {
      setErrorMessage('Please provide a connection label.')
      return
    }

    if (!trimmedKey) {
      setErrorMessage('Please enter an API key.')
      return
    }

    setIsSubmitting(true)

    try {
      const created = await window.api.providers.createConnection({
        providerId: selectedProviderId,
        label: trimmedLabel,
        apiKey: trimmedKey,
        modelId: selectedModelId || undefined
      })

      onSuccess(created)
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create provider connection.'
      setErrorMessage(msg)
    } finally {
      // CRITICAL SECURITY INVARIANT: Clear the key field immediately in finally
      setApiKey('')
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="add-connection-dialog"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-connection-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <KeyRound size={20} className="modal-title-icon" aria-hidden="true" />
            <h2 id="add-connection-title" className="modal-title">
              Add AI Provider Connection
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="modal-body">
            {errorMessage && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                data-testid="add-connection-error"
              >
                {errorMessage}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="provider-select" className="form-label">
                Provider
              </label>
              <select
                id="provider-select"
                className="form-select"
                value={selectedProviderId}
                disabled={isSubmitting}
                onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="model-select" className="form-label">
                Default Test Model
              </label>
              {selectableModels.length > 0 ? (
                <select
                  id="model-select"
                  className="form-select"
                  value={selectedModelId}
                  disabled={isSubmitting}
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
                <p className="form-empty-note" data-testid="no-models-available-note">
                  No usable models available for this provider.
                </p>
              )}
              <span className="form-helper">
                This model will be used to verify your credentials upon connection.
                {selectedProviderId === 'perplexity' &&
                  ' Perplexity verification executes a minimal Agent API request (with native tools disabled) and may incur a small usage charge.'}
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="connection-label" className="form-label">
                Connection Label
              </label>
              <input
                id="connection-label"
                type="text"
                className="form-input"
                placeholder="e.g. Primary OpenAI Account"
                value={label}
                disabled={isSubmitting}
                onChange={(e) => setLabel(e.target.value)}
                autoComplete="off"
              />
              <span className="form-helper">
                A descriptive name to distinguish this connection across your workspace.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="api-key-input" className="form-label">
                API Key
              </label>
              <input
                id="api-key-input"
                type="password"
                className="form-input"
                placeholder={
                  selectedProviderId === 'groq'
                    ? 'Enter Groq API key (gsk_...)'
                    : selectedProviderId === 'openrouter'
                      ? 'Enter OpenRouter API key (sk-or-v1-...)'
                      : selectedProviderId === 'perplexity'
                        ? 'Enter Perplexity API key (pplx-...)'
                        : 'Enter secret API key'
                }
                value={apiKey}
                disabled={isSubmitting}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                data-testid="api-key-input"
              />
              <span className="form-helper">
                Encrypted at rest using your operating system&apos;s credential vault. Never
                transmitted across unencrypted channels.
              </span>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
              data-testid="submit-connection-button"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="inline-icon spinner" aria-hidden="true" />
                  Connecting &amp; Saving...
                </>
              ) : (
                'Connect & Save'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
