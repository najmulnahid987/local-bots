import { ReactElement, useState, useEffect, useMemo, FormEvent, ChangeEvent } from 'react'
import { Loader2, AlertCircle, Wrench } from 'lucide-react'
import type { ToolPermission } from '../../../../shared/bots'
import { APPROVED_BOT_TOOLS } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'
import { BOT_TOOLS_METADATA } from './bot-tools-meta'

export interface BotFormValues {
  name: string
  description: string
  systemPrompt: string
  providerConnectionId: string | null
  modelId: string
  enabledTools: ToolPermission[]
}

export interface BotConfigurationFormProps {
  readonly initialValues?: Partial<BotFormValues>
  readonly isSubmitting?: boolean
  readonly submitLabel?: string
  readonly onSubmit: (values: BotFormValues) => Promise<void> | void
  readonly onCancel: () => void
  readonly error?: string | null
  readonly connections?: readonly ProviderConnectionSummary[]
  readonly catalog?: ProviderCatalogDto | null
}

const DEFAULT_TOOLS: readonly ToolPermission[] = [
  'search_knowledge_base',
  'read_knowledge_base_document'
]

export function BotConfigurationForm({
  initialValues,
  isSubmitting = false,
  submitLabel = 'Save Bot',
  onSubmit,
  onCancel,
  error = null,
  connections: propConnections,
  catalog: propCatalog
}: BotConfigurationFormProps): ReactElement {
  const [internalConnections, setInternalConnections] = useState<
    readonly ProviderConnectionSummary[]
  >([])
  const [internalCatalog, setInternalCatalog] = useState<ProviderCatalogDto | null>(null)
  const [isLoadingMetadata, setIsLoadingMetadata] = useState<boolean>(
    !propConnections || !propCatalog
  )

  const connections = propConnections ?? internalConnections
  const catalog = propCatalog ?? internalCatalog

  // Load provider connections and catalog from window.api if not provided as props
  useEffect(() => {
    let isCurrent = true

    if (propConnections && propCatalog) {
      return
    }

    const loadProvidersData = async (): Promise<void> => {
      try {
        if (!window.api?.providers) return

        const [loadedCatalog, loadedConns] = await Promise.all([
          propCatalog ? Promise.resolve(propCatalog) : window.api.providers.getCatalog(),
          propConnections
            ? Promise.resolve(propConnections)
            : window.api.providers.listConnections()
        ])

        if (isCurrent) {
          setInternalCatalog(loadedCatalog)
          setInternalConnections(loadedConns)
        }
      } catch {
        // Fallback: Continue with loaded or empty metadata
      } finally {
        if (isCurrent) {
          setIsLoadingMetadata(false)
        }
      }
    }

    void loadProvidersData()

    return () => {
      isCurrent = false
    }
  }, [propConnections, propCatalog])

  const initialName = initialValues?.name ?? ''
  const initialDescription = initialValues?.description ?? ''
  const initialSystemPrompt = initialValues?.systemPrompt ?? ''
  const initialProviderConnectionId = initialValues?.providerConnectionId ?? null
  const initialModelId = initialValues?.modelId
  const initialEnabledTools = initialValues?.enabledTools

  // Form Fields State
  const [name, setName] = useState<string>(initialName)
  const [description, setDescription] = useState<string>(initialDescription)
  const [systemPrompt, setSystemPrompt] = useState<string>(initialSystemPrompt)
  const [providerConnectionId, setProviderConnectionId] = useState<string | null>(
    initialProviderConnectionId
  )

  // Derive selectable models based on selected provider connection
  const selectableModels = useMemo(() => {
    const allModels = catalog?.models ?? []
    const nonDeprecated = allModels.filter((m) => m.availability !== 'deprecated')

    if (!providerConnectionId) {
      // Unassigned: allow any non-deprecated model from the catalog
      return nonDeprecated
    }

    const connection = connections.find((c) => c.id === providerConnectionId)
    if (!connection) {
      return nonDeprecated
    }

    return nonDeprecated.filter((m) => m.providerId === connection.providerId)
  }, [catalog?.models, providerConnectionId, connections])

  // Initial model resolution
  const initialModel = useMemo(() => {
    if (initialModelId) {
      return initialModelId
    }
    return selectableModels[0]?.id ?? ''
  }, [initialModelId, selectableModels])

  const [modelId, setModelId] = useState<string>(initialModel)
  const [enabledTools, setEnabledTools] = useState<ToolPermission[]>(
    initialEnabledTools ?? [...DEFAULT_TOOLS]
  )
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Handle provider connection selection changes
  const handleConnectionChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const val = e.target.value
    const newConnectionId = val === '' ? null : val
    setProviderConnectionId(newConnectionId)

    // Compute models for newly selected connection
    const allModels = catalog?.models ?? []
    const nonDeprecated = allModels.filter((m) => m.availability !== 'deprecated')
    let newSelectable = nonDeprecated

    if (newConnectionId) {
      const conn = connections.find((c) => c.id === newConnectionId)
      if (conn) {
        newSelectable = nonDeprecated.filter((m) => m.providerId === conn.providerId)
      }
    }

    // Check if current modelId is valid in newly selectable models
    const isCurrentModelValid = newSelectable.some((m) => m.id === modelId)
    if (!isCurrentModelValid) {
      if (newConnectionId) {
        const conn = connections.find((c) => c.id === newConnectionId)
        const providerDesc = catalog?.providers.find((p) => p.id === conn?.providerId)
        const defaultMod = providerDesc?.defaultModelId
        if (defaultMod && newSelectable.some((m) => m.id === defaultMod)) {
          setModelId(defaultMod)
        } else {
          setModelId(newSelectable[0]?.id ?? '')
        }
      } else {
        setModelId(newSelectable[0]?.id ?? '')
      }
    }

    // Clear connection/model error if any
    setFieldErrors((prev) => {
      const updated = { ...prev }
      delete updated.providerConnectionId
      delete updated.modelId
      return updated
    })
  }

  // Toggle tool permissions
  const handleToggleTool = (toolId: ToolPermission): void => {
    setEnabledTools((prev) => {
      let updated: ToolPermission[]
      if (prev.includes(toolId)) {
        updated = prev.filter((t) => t !== toolId)
      } else {
        updated = [...prev, toolId]
      }
      // Preserve canonical ordering
      return APPROVED_BOT_TOOLS.filter((t) => updated.includes(t))
    })
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    const trimmedName = name.trim()

    if (trimmedName.length === 0) {
      errors.name = 'Bot name cannot be blank.'
    } else if (trimmedName.length > 100) {
      errors.name = 'Bot name cannot exceed 100 characters.'
    }

    if (description.length > 2000) {
      errors.description = 'Description cannot exceed 2000 characters.'
    }

    if (systemPrompt.length > 10000) {
      errors.systemPrompt = 'System instructions cannot exceed 10000 characters.'
    }

    if (!modelId || modelId.trim().length === 0) {
      errors.modelId = 'Model selection is required.'
    } else {
      const isModelCompatible = selectableModels.some((m) => m.id === modelId)
      if (!isModelCompatible) {
        errors.modelId = 'Selected model is not compatible with the chosen provider connection.'
      }
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (isSubmitting) return

    if (!validateForm()) {
      return
    }

    await onSubmit({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      providerConnectionId,
      modelId,
      enabledTools
    })
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="bot-configuration-form">
      {error && (
        <div className="form-alert form-alert-error" role="alert" data-testid="bot-form-error">
          <div className="alert-content-row">
            <AlertCircle size={18} className="warning-box-icon text-danger" aria-hidden="true" />
            <div>
              <strong>Error saving Bot</strong>
              <div className="alert-subtext">{error}</div>
            </div>
          </div>
        </div>
      )}

      {/* Bot Name */}
      <div className="form-group" style={{ marginTop: error ? '16px' : '0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="bot-name-input" className="form-label">
            Bot Name <span className="text-danger">*</span>
          </label>
          <span className="form-char-count">{name.length}/100</span>
        </div>
        <input
          id="bot-name-input"
          data-testid="bot-name-input"
          type="text"
          className="form-input"
          placeholder="e.g. Technical Research Assistant"
          value={name}
          maxLength={100}
          disabled={isSubmitting}
          onChange={(e) => {
            setName(e.target.value)
            if (fieldErrors.name) {
              setFieldErrors((prev) => {
                const u = { ...prev }
                delete u.name
                return u
              })
            }
          }}
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={fieldErrors.name ? 'bot-name-error' : undefined}
          required
        />
        {fieldErrors.name && (
          <span id="bot-name-error" className="form-field-error" data-testid="bot-name-error">
            {fieldErrors.name}
          </span>
        )}
      </div>

      {/* Description */}
      <div className="form-group" style={{ marginTop: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="bot-description-input" className="form-label">
            Description
          </label>
          <span className="form-char-count">{description.length}/2000</span>
        </div>
        <input
          id="bot-description-input"
          data-testid="bot-description-input"
          type="text"
          className="form-input"
          placeholder="e.g. Analyzes quarterly PDF briefs and summarizes key findings"
          value={description}
          maxLength={2000}
          disabled={isSubmitting}
          onChange={(e) => {
            setDescription(e.target.value)
            if (fieldErrors.description) {
              setFieldErrors((prev) => {
                const u = { ...prev }
                delete u.description
                return u
              })
            }
          }}
        />
        {fieldErrors.description && (
          <span className="form-field-error" data-testid="bot-description-error">
            {fieldErrors.description}
          </span>
        )}
      </div>

      {/* System Instructions */}
      <div className="form-group" style={{ marginTop: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="bot-system-prompt-input" className="form-label">
            System Instructions
          </label>
          <span className="form-char-count">{systemPrompt.length}/10000</span>
        </div>
        <textarea
          id="bot-system-prompt-input"
          data-testid="bot-system-prompt-input"
          className="form-input"
          rows={4}
          placeholder="Define this Bot's persona, specialized knowledge, reasoning rules, boundaries, and task objectives..."
          value={systemPrompt}
          maxLength={10000}
          disabled={isSubmitting}
          style={{ resize: 'vertical', minHeight: '80px' }}
          onChange={(e) => {
            setSystemPrompt(e.target.value)
            if (fieldErrors.systemPrompt) {
              setFieldErrors((prev) => {
                const u = { ...prev }
                delete u.systemPrompt
                return u
              })
            }
          }}
        />
        <span className="form-helper">
          These instructions govern how the model interprets questions and coordinates read-only
          tools.
        </span>
        {fieldErrors.systemPrompt && (
          <span className="form-field-error" data-testid="bot-system-prompt-error">
            {fieldErrors.systemPrompt}
          </span>
        )}
      </div>

      {/* Provider Connection & Model Selection Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '14px',
          marginTop: '16px'
        }}
      >
        {/* Provider Connection */}
        <div className="form-group">
          <label htmlFor="bot-provider-select" className="form-label">
            Provider Connection
          </label>
          <select
            id="bot-provider-select"
            data-testid="bot-provider-select"
            className="form-select"
            value={providerConnectionId ?? ''}
            disabled={isSubmitting || isLoadingMetadata}
            onChange={handleConnectionChange}
          >
            <option value="">None (Unassigned / Draft)</option>
            {connections.map((conn) => {
              const prov = catalog?.providers.find((p) => p.id === conn.providerId)
              const provLabel = prov?.displayName ?? conn.providerId
              const statusSuffix = conn.status !== 'active' ? ` [${conn.status}]` : ''
              return (
                <option key={conn.id} value={conn.id}>
                  {conn.label} ({provLabel}){statusSuffix}
                </option>
              )
            })}
          </select>
          <span className="form-helper">
            {providerConnectionId
              ? 'Uses encrypted credentials from your selected provider connection.'
              : 'Unassigned draft mode. Assign a connection to execute live AI requests.'}
          </span>
          {fieldErrors.providerConnectionId && (
            <span className="form-field-error">{fieldErrors.providerConnectionId}</span>
          )}
        </div>

        {/* Model Selection */}
        <div className="form-group">
          <label htmlFor="bot-model-select" className="form-label">
            Model Selection <span className="text-danger">*</span>
          </label>
          <select
            id="bot-model-select"
            data-testid="bot-model-select"
            className="form-select"
            value={modelId}
            disabled={isSubmitting || isLoadingMetadata || selectableModels.length === 0}
            onChange={(e) => {
              setModelId(e.target.value)
              if (fieldErrors.modelId) {
                setFieldErrors((prev) => {
                  const u = { ...prev }
                  delete u.modelId
                  return u
                })
              }
            }}
            aria-invalid={Boolean(fieldErrors.modelId)}
            required
          >
            {selectableModels.length === 0 ? (
              <option value="">No compatible models available</option>
            ) : (
              selectableModels.map((m) => {
                const prov = catalog?.providers.find((p) => p.id === m.providerId)
                return (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.id}){' '}
                    {!providerConnectionId ? `— ${prov?.displayName ?? m.providerId}` : ''}
                  </option>
                )
              })
            )}
          </select>
          <span className="form-helper">
            Authoritative models available from the verified provider catalog.
          </span>
          {fieldErrors.modelId && (
            <span className="form-field-error" data-testid="bot-model-error">
              {fieldErrors.modelId}
            </span>
          )}
        </div>
      </div>

      {/* Enabled Tools Section */}
      <div className="form-group" style={{ marginTop: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Wrench size={14} className="text-muted" aria-hidden="true" />
          <label className="form-label" style={{ marginBottom: 0 }}>
            Enabled Tools
          </label>
        </div>
        <span className="form-helper">
          Select the bounded, read-only analytical tools this Bot can invoke during reasoning.
        </span>

        <div className="bot-tools-grid" role="group" aria-label="Tool Permissions">
          {BOT_TOOLS_METADATA.map((tool) => {
            const isChecked = enabledTools.includes(tool.id)
            return (
              <label
                key={tool.id}
                className={`bot-tool-checkbox-card ${isChecked ? 'selected' : ''}`}
                data-testid={`tool-checkbox-${tool.id}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isSubmitting}
                  onChange={() => handleToggleTool(tool.id)}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div className="tool-card-title">{tool.label}</div>
                  <div className="tool-card-desc">{tool.description}</div>
                </div>
              </label>
            )
          })}
        </div>
      </div>

      {/* Action Footer */}
      <div
        className="modal-footer"
        style={{ marginTop: '24px', marginInline: '-24px', marginBottom: '-24px' }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="bot-form-cancel-btn"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSubmitting}
          data-testid="bot-form-submit-btn"
        >
          {isSubmitting ? (
            <>
              <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
              Saving...
            </>
          ) : (
            submitLabel
          )}
        </button>
      </div>
    </form>
  )
}
