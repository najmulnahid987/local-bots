import { ReactElement, useState, useMemo, FormEvent, KeyboardEvent } from 'react'
import { X, Loader2, KeyRound } from 'lucide-react'
import type {
  ProviderConnectionSummary,
  ProviderCatalogDto,
  ModelDescriptorDto
} from '../../../../shared/providers'

export interface ReplaceProviderCredentialDialogProps {
  readonly isOpen?: boolean
  readonly connection: ProviderConnectionSummary | null
  readonly catalog: ProviderCatalogDto | null
  readonly onClose: () => void
  readonly onSuccess: (updated: ProviderConnectionSummary) => void
}

export function ReplaceProviderCredentialDialog({
  isOpen = true,
  connection,
  catalog,
  onClose,
  onSuccess
}: ReplaceProviderCredentialDialogProps): ReactElement | null {
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

  const [apiKey, setApiKey] = useState<string>('')
  const [selectedModelId, setSelectedModelId] = useState<string>(initialModelId)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !connection) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setErrorMessage(null)

    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      setErrorMessage('Please enter the replacement API key.')
      return
    }

    setIsSubmitting(true)

    try {
      const updated = await window.api.providers.replaceCredential({
        connectionId: connection.id,
        apiKey: trimmedKey,
        modelId: selectedModelId || undefined
      })

      onSuccess(updated)
      onClose()
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to replace credential. Existing key was preserved.'
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
      data-testid="replace-credential-dialog"
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replace-credential-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <KeyRound size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="replace-credential-title" className="modal-title">
              Replace Key: {connection.label}
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
            <p className="modal-description">
              Provide a new API key for this connection. The new key will be tested against the
              provider before your existing vault credential is replaced. If testing fails, your
              current working key remains untouched.
            </p>

            {errorMessage && (
              <div
                className="form-alert form-alert-error"
                role="alert"
                data-testid="replace-key-error"
              >
                <div>{errorMessage}</div>
                <div className="alert-footnote">
                  Your previously stored credential was preserved.
                </div>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="replace-model-select" className="form-label">
                Verification Model
              </label>
              {selectableModels.length > 0 ? (
                <select
                  id="replace-model-select"
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
                <p className="form-empty-note">No models available for verification.</p>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="replace-api-key-input" className="form-label">
                New API Key
              </label>
              <input
                id="replace-api-key-input"
                type="password"
                className="form-input"
                placeholder="Enter replacement secret API key"
                value={apiKey}
                disabled={isSubmitting}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                data-testid="replace-api-key-input"
              />
              <span className="form-helper">
                The replacement key will be validated and re-encrypted into the operating system
                vault.
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
              data-testid="submit-replace-button"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="inline-icon spinner" aria-hidden="true" />
                  Testing &amp; Replacing...
                </>
              ) : (
                'Verify & Replace'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
