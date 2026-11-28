import { ReactElement, useState, useEffect, useMemo, useRef, FormEvent, ChangeEvent } from 'react'
import { Loader2, AlertCircle, Wrench, BookOpen, Database } from 'lucide-react'
import type { ToolPermission, BotResponsePolicy } from '../../../../shared/bots'

function formatPerMillionPrice(rawPerToken?: string): string {
  if (!rawPerToken || rawPerToken.trim().length === 0) return 'Unavailable'
  const trimmed = rawPerToken.trim()
  if (trimmed.startsWith('-')) return 'Variable'
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) return 'Unavailable'
  const intPart = match[1]
  const fracPart = match[2] ?? ''
  if (/^0+$/.test(intPart) && /^0*$/.test(fracPart)) return 'Free'
  const shifted = fracPart.padEnd(6, '0')
  const whole = `${intPart}${shifted.slice(0, 6)}`.replace(/^0+/, '') || '0'
  const dec = shifted.slice(6, 10).padEnd(4, '0')
  if (whole === '0') {
    if (/^0+$/.test(dec)) return '<$0.0001/1M'
    return `$0.${dec.replace(/0+$/, '').padEnd(2, '0')}/1M`
  }
  return `$${whole}.${dec.slice(0, 2)}/1M`
}
import {
  APPROVED_BOT_TOOLS,
  BOT_RESPONSE_POLICIES,
  BOT_RESPONSE_POLICY_METADATA,
  DEFAULT_BOT_RESPONSE_POLICY
} from '../../../../shared/bots'
import type {
  ProviderCatalogDto,
  ProviderConnectionSummary,
  ModelDescriptorDto
} from '../../../../shared/providers'
import { BOT_TOOLS_METADATA } from './bot-tools-meta'

export interface BotFormValues {
  name: string
  description: string
  systemPrompt: string
  responsePolicy: BotResponsePolicy
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
  readonly knowledgeBaseName?: string
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
  catalog: propCatalog,
  knowledgeBaseName
}: BotConfigurationFormProps): ReactElement {
  const initialName = initialValues?.name ?? ''
  const initialDescription = initialValues?.description ?? ''
  const initialSystemPrompt = initialValues?.systemPrompt ?? ''
  const initialResponsePolicy = initialValues?.responsePolicy ?? DEFAULT_BOT_RESPONSE_POLICY
  const initialProviderConnectionId = initialValues?.providerConnectionId ?? null
  const initialModelId = initialValues?.modelId
  const initialEnabledTools = initialValues?.enabledTools

  const [internalConnections, setInternalConnections] = useState<
    readonly ProviderConnectionSummary[]
  >([])
  const [internalCatalog, setInternalCatalog] = useState<ProviderCatalogDto | null>(null)
  const [isLoadingMetadata, setIsLoadingMetadata] = useState<boolean>(
    !propConnections || !propCatalog
  )

  const connections = propConnections ?? internalConnections
  const catalog = propCatalog ?? internalCatalog

  // Form Fields State
  const [name, setName] = useState<string>(initialName)
  const [description, setDescription] = useState<string>(initialDescription)
  const [systemPrompt, setSystemPrompt] = useState<string>(initialSystemPrompt)
  const [providerConnectionId, setProviderConnectionId] = useState<string | null>(
    initialProviderConnectionId
  )
  const [discoveredModels, setDiscoveredModels] = useState<
    Record<string, readonly ModelDescriptorDto[]>
  >({})
  const [isDetectingModels, setIsDetectingModels] = useState<boolean>(false)

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

    // 1. If dynamically discovered models are available for this connection, use them
    if (
      discoveredModels[providerConnectionId] &&
      discoveredModels[providerConnectionId].length > 0
    ) {
      return discoveredModels[providerConnectionId]
    }

    // 2. If connection summary already carried availableModels
    if (connection.availableModels && connection.availableModels.length > 0) {
      const providerModels = allModels.filter((m) => m.providerId === connection.providerId)
      const byId = new Map(providerModels.map((m) => [m.id, m]))
      const resolved: ModelDescriptorDto[] = []
      for (const availableId of connection.availableModels) {
        const known = byId.get(availableId)
        if (known) {
          resolved.push(known)
        } else {
          resolved.push({
            id: availableId,
            providerId: connection.providerId,
            displayName: availableId,
            description: `Active model discovered for ${connection.providerId}`,
            availability: 'stable',
            capabilities: {
              streaming: true,
              tools: false,
              imageInput: false,
              structuredOutput: false
            },
            docUrl: ''
          })
        }
      }
      if (resolved.length > 0) {
        return resolved
      }
    }

    return nonDeprecated.filter((m) => m.providerId === connection.providerId)
  }, [catalog?.models, providerConnectionId, connections, discoveredModels])

  // Initial model resolution
  const initialModel = useMemo(() => {
    if (initialModelId) {
      return initialModelId
    }
    return selectableModels[0]?.id ?? ''
  }, [initialModelId, selectableModels])

  const [modelId, setModelId] = useState<string>(initialModel)
  const [modelSearchQuery, setModelSearchQuery] = useState<string>('')
  const fetchedConnectionsRef = useRef<Set<string>>(new Set())
  const [responsePolicy, setResponsePolicy] = useState<BotResponsePolicy>(initialResponsePolicy)

  const filteredModels = useMemo(() => {
    const q = modelSearchQuery.trim().toLowerCase()
    if (!q) return selectableModels
    return selectableModels.filter(
      (m) =>
        m.id === modelId ||
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q)
    )
  }, [selectableModels, modelSearchQuery, modelId])

  const selectedModelMeta = useMemo(
    () => selectableModels.find((m) => m.id === modelId),
    [selectableModels, modelId]
  )
  const [enabledTools, setEnabledTools] = useState<ToolPermission[]>(
    initialEnabledTools ?? [...DEFAULT_TOOLS]
  )
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

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
          setModelId((prev) => {
            if (prev) return prev
            const nonDep = (loadedCatalog?.models ?? []).filter(
              (m) => m.availability !== 'deprecated'
            )
            return nonDep[0]?.id ?? ''
          })
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

  // Discover and filter models dynamically for the selected provider connection
  useEffect(() => {
    let isCurrent = true
    if (!providerConnectionId || !window.api?.providers?.getAvailableModels) {
      return
    }

    if (fetchedConnectionsRef.current.has(providerConnectionId)) {
      return
    }
    fetchedConnectionsRef.current.add(providerConnectionId)

    setIsDetectingModels(true)
    window.api.providers
      .getAvailableModels({ connectionId: providerConnectionId })
      .then((models) => {
        if (isCurrent && models && models.length > 0) {
          setDiscoveredModels((prev) => ({
            ...prev,
            [providerConnectionId]: models
          }))
          setModelId((prevModelId) => {
            if (models.some((m) => m.id === prevModelId)) {
              return prevModelId
            }
            return models[0]?.id ?? prevModelId
          })
        }
      })
      .catch(() => {
        fetchedConnectionsRef.current.delete(providerConnectionId)
      })
      .finally(() => {
        if (isCurrent) {
          setIsDetectingModels(false)
        }
      })

    return () => {
      isCurrent = false
    }
  }, [providerConnectionId])

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
      responsePolicy,
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
          {selectableModels.length > 6 && (
            <input
              type="search"
              className="form-input"
              style={{ marginBottom: '6px' }}
              placeholder="Search models by name or author/slug..."
              value={modelSearchQuery}
              disabled={isSubmitting || isLoadingMetadata}
              onChange={(e) => setModelSearchQuery(e.target.value)}
              data-testid="bot-model-search-input"
              aria-label="Filter models"
            />
          )}
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
            {filteredModels.length === 0 ? (
              <option value="">No compatible models available</option>
            ) : (
              filteredModels.map((m) => {
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
          {selectedModelMeta && (
            <span className="form-helper" data-testid="selected-model-metadata">
              {selectedModelMeta.contextWindow
                ? `${Math.round(selectedModelMeta.contextWindow.inputTokens / 1000)}K ctx`
                : 'Context unknown'}
              {' · '}
              {selectedModelMeta.providerCapabilities?.tools ? 'Tools supported' : 'Chat only'}
              {selectedModelMeta.inputModalities && selectedModelMeta.inputModalities.length > 0
                ? ` · Inputs: ${selectedModelMeta.inputModalities.join(', ')}`
                : ''}
              {selectedModelMeta.pricing
                ? selectedModelMeta.pricing.isFree
                  ? ' · Pricing: Free'
                  : ` · Est. Pricing: ${formatPerMillionPrice(selectedModelMeta.pricing.promptPerTokenUsd)} in / ${formatPerMillionPrice(selectedModelMeta.pricing.completionPerTokenUsd)} out`
                : selectedModelMeta.providerId === 'openrouter'
                  ? ' · Pricing unavailable'
                  : ''}
            </span>
          )}
          <span className="form-helper">
            {isDetectingModels
              ? 'Detecting active models for this API key...'
              : providerConnectionId && discoveredModels[providerConnectionId]
                ? `✓ Showing ${selectableModels.length} models verified and active for this API key.`
                : 'Authoritative models available from the verified provider catalog.'}
          </span>
          {fieldErrors.modelId && (
            <span className="form-field-error" data-testid="bot-model-error">
              {fieldErrors.modelId}
            </span>
          )}
        </div>
      </div>

      {/* Knowledge and Response Behavior Section */}
      <div className="form-group bot-policy-section" data-testid="bot-response-policy-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <BookOpen size={14} className="text-muted" aria-hidden="true" />
          <label className="form-label" style={{ marginBottom: 0 }}>
            Knowledge and Response Behavior
          </label>
        </div>

        <div className="policy-kb-context" data-testid="parent-kb-indicator">
          <Database size={13} className="text-muted" aria-hidden="true" />
          <span>
            Parent Knowledge Base:{' '}
            <strong>
              {knowledgeBaseName ? knowledgeBaseName : 'Scoped to active Knowledge Base'}
            </strong>
          </span>
        </div>

        <span className="form-helper">
          Choose how this Bot prioritizes retrieved Knowledge Base documents when answering
          questions in chat. This setting is independent of Enabled Tools.
        </span>

        <div className="bot-policy-list" role="radiogroup" aria-label="Response Policy">
          {BOT_RESPONSE_POLICIES.map((policyId) => {
            const meta = BOT_RESPONSE_POLICY_METADATA[policyId]
            const isSelected = responsePolicy === policyId
            return (
              <label
                key={policyId}
                className={`bot-policy-card ${isSelected ? 'selected' : ''}`}
                data-testid={`policy-option-${policyId}`}
              >
                <input
                  type="radio"
                  name="bot-response-policy"
                  value={policyId}
                  checked={isSelected}
                  disabled={isSubmitting}
                  onChange={() => setResponsePolicy(policyId)}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div className="policy-card-header">
                    <span className="tool-card-title">{meta.label}</span>
                    {meta.recommended && (
                      <span
                        className="policy-recommended-badge"
                        data-testid="policy-recommended-badge"
                      >
                        Recommended
                      </span>
                    )}
                  </div>
                  <div className="tool-card-desc">{meta.description}</div>
                </div>
              </label>
            )
          })}
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
