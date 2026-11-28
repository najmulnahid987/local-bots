import * as fs from 'node:fs'
import * as path from 'node:path'
import { INITIAL_MODELS, INITIAL_PROVIDERS } from './model-catalog'
import { GROQ_CURATED_MODEL_PROFILES } from './groq/model-metadata'
import { PERPLEXITY_CURATED_MODEL_PROFILES } from './perplexity/model-metadata'
import { validateModelCapabilities } from './capability-validator'
import {
  type CapabilityValidationResult,
  type ModelCapabilities,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderNativeCapabilities,
  type RequestedCapabilities,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities,
  isValidProviderId
} from './types'

/**
 * Deep freezes an object or array to guarantee runtime immutability.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  // Freeze array elements or object properties recursively
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item)
    }
  } else {
    for (const key of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[key]
      if (val !== null && typeof val === 'object') {
        deepFreeze(val)
      }
    }
  }

  return Object.freeze(obj)
}

/**
 * Creates a defensive deep clone of a ModelDescriptor to isolate registry consumers.
 */
function cloneModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  return deepFreeze({
    id: model.id,
    providerId: model.providerId,
    displayName: model.displayName,
    description: model.description,
    availability: model.availability,
    ...(model.canonicalSlug ? { canonicalSlug: model.canonicalSlug } : {}),
    contextWindow: model.contextWindow ? { ...model.contextWindow } : undefined,
    ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.outputModalities ? { outputModalities: [...model.outputModalities] } : {}),
    ...(model.supportedParameters ? { supportedParameters: [...model.supportedParameters] } : {}),
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    ...(model.metadataSource ? { metadataSource: model.metadataSource } : {}),
    providerCapabilities: model.providerCapabilities
      ? { ...model.providerCapabilities }
      : undefined,
    applicationCapabilities: model.applicationCapabilities
      ? { ...model.applicationCapabilities }
      : undefined,
    capabilities: { ...model.capabilities },
    docUrl: model.docUrl
  })
}

/**
 * Creates a defensive deep clone of a ProviderDescriptor to isolate registry consumers.
 */
function cloneProviderDescriptor(provider: ProviderDescriptor): ProviderDescriptor {
  return deepFreeze({
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    docUrl: provider.docUrl,
    isSupported: provider.isSupported,
    defaultModelId: provider.defaultModelId
  })
}

interface PersistedDiscoveredEntry {
  readonly connectionId: string
  readonly providerId: ProviderId
  readonly models: ReadonlyArray<ModelDescriptor>
  readonly updatedAt: number
}

interface PersistedDiscoveredSnapshot {
  readonly version: 1
  readonly entries: ReadonlyArray<PersistedDiscoveredEntry>
}

const CONSERVATIVE_PROVIDER_CAPABILITIES: ProviderNativeCapabilities = {
  streaming: true,
  tools: false,
  imageInput: false,
  structuredOutput: false
}

/**
 * Authoritative provider and model registry.
 * Provides immutable metadata for provider adapters, Bot configuration, and capability validation,
 * plus connection-scoped persistence for validated dynamically discovered models.
 */
export class ProviderRegistry {
  private readonly providers: ReadonlyMap<ProviderId, ProviderDescriptor>
  private readonly modelsByProvider: ReadonlyMap<ProviderId, ReadonlyMap<string, ModelDescriptor>>
  private readonly discoveredByConnection = new Map<
    string,
    {
      readonly providerId: ProviderId
      readonly models: ReadonlyMap<string, ModelDescriptor>
      readonly updatedAt: number
    }
  >()
  private persistenceFilePath?: string

  constructor(
    customProviders: ReadonlyArray<ProviderDescriptor> = INITIAL_PROVIDERS,
    customModels: ReadonlyArray<ModelDescriptor> = INITIAL_MODELS
  ) {
    const providersMap = new Map<ProviderId, ProviderDescriptor>()
    const modelsByProviderMap = new Map<ProviderId, Map<string, ModelDescriptor>>()

    // 1. Register and validate providers
    for (const p of customProviders) {
      if (providersMap.has(p.id)) {
        throw new Error(`Duplicate provider ID registered: '${p.id}'.`)
      }
      providersMap.set(p.id, cloneProviderDescriptor(p))
      modelsByProviderMap.set(p.id, new Map<string, ModelDescriptor>())
    }

    // 2. Register and validate models
    for (const m of customModels) {
      if (!providersMap.has(m.providerId)) {
        throw new Error(`Model '${m.id}' references unregistered provider '${m.providerId}'.`)
      }

      const providerModelMap = modelsByProviderMap.get(m.providerId)!
      if (providerModelMap.has(m.id)) {
        throw new Error(`Duplicate model ID '${m.id}' registered for provider '${m.providerId}'.`)
      }

      providerModelMap.set(m.id, cloneModelDescriptor(m))
    }

    // 3. Verify each provider's defaultModelId exists in its model catalog
    for (const [providerId, provider] of providersMap.entries()) {
      const providerModelMap = modelsByProviderMap.get(providerId)!
      if (provider.defaultModelId && !providerModelMap.has(provider.defaultModelId)) {
        throw new Error(
          `Provider '${providerId}' specifies default model '${provider.defaultModelId}' which is not in its catalog.`
        )
      }
    }

    this.providers = deepFreeze(providersMap)
    this.modelsByProvider = deepFreeze(modelsByProviderMap)
  }

  /**
   * Retrieves provider descriptor by its ID.
   * Returns null if provider is unknown.
   */
  getProvider(providerId: string): ProviderDescriptor | null {
    if (!isValidProviderId(providerId)) {
      return null
    }
    const provider = this.providers.get(providerId)
    return provider ? cloneProviderDescriptor(provider) : null
  }

  /**
   * Returns an array of all registered provider descriptors.
   */
  getProviders(): ProviderDescriptor[] {
    return Array.from(this.providers.values()).map(cloneProviderDescriptor)
  }

  /**
   * Configures disk persistence for connection-scoped dynamically discovered models
   * and immediately restores any previously persisted entries.
   */
  configurePersistence(filePath: string): void {
    this.persistenceFilePath = filePath
    this.loadPersistedDiscoveredModels()
  }

  /**
   * Stores validated dynamically discovered models for a specific authenticated connection.
   * Preserves conservative capability defaults for unverified dynamic models.
   */
  setDiscoveredModels(
    connectionId: string,
    providerId: ProviderId,
    models: ReadonlyArray<ModelDescriptor>
  ): void {
    if (!connectionId || !isValidProviderId(providerId)) {
      return
    }

    const sanitizedMap = new Map<string, ModelDescriptor>()
    for (const raw of models) {
      if (!raw || raw.providerId !== providerId || typeof raw.id !== 'string') continue
      const cleanId = raw.id.trim()
      if (
        !cleanId ||
        cleanId.length > 200 ||
        !/^[a-zA-Z0-9._:/-]+$/.test(cleanId) ||
        cleanId.includes('..')
      ) {
        continue
      }

      const staticMatch = this.modelsByProvider.get(providerId)?.get(cleanId)
      if (staticMatch) {
        // Merge updated context window / pricing metadata if provided, while keeping authoritative static capabilities
        const merged: ModelDescriptor = {
          ...staticMatch,
          contextWindow: raw.contextWindow ?? staticMatch.contextWindow,
          ...(raw.pricing ? { pricing: raw.pricing } : {}),
          ...(raw.metadataSource ? { metadataSource: raw.metadataSource } : {})
        }
        sanitizedMap.set(cleanId, cloneModelDescriptor(merged))
        continue
      }

      const curatedGroq = providerId === 'groq' ? GROQ_CURATED_MODEL_PROFILES[cleanId] : undefined
      const curatedPerplexity =
        providerId === 'perplexity' ? PERPLEXITY_CURATED_MODEL_PROFILES[cleanId] : undefined
      let providerCapabilities: ProviderNativeCapabilities
      if (curatedGroq) {
        providerCapabilities = { ...curatedGroq.providerCapabilities }
      } else if (curatedPerplexity) {
        providerCapabilities = { ...curatedPerplexity.providerCapabilities }
      } else if (providerId === 'openrouter') {
        const params = Array.isArray(raw.supportedParameters) ? raw.supportedParameters : []
        const inputs = Array.isArray(raw.inputModalities) ? raw.inputModalities : []
        providerCapabilities = {
          streaming: true,
          tools: params.includes('tools'),
          imageInput: inputs.includes('image'),
          structuredOutput:
            params.includes('structured_outputs') || params.includes('response_format'),
          reasoning: params.includes('reasoning') || params.includes('include_reasoning')
        }
      } else if (
        raw.providerCapabilities &&
        providerId !== 'groq' &&
        typeof raw.providerCapabilities.tools === 'boolean'
      ) {
        providerCapabilities = {
          streaming: Boolean(raw.providerCapabilities.streaming),
          tools: Boolean(raw.providerCapabilities.tools),
          imageInput: Boolean(raw.providerCapabilities.imageInput),
          structuredOutput: Boolean(raw.providerCapabilities.structuredOutput)
        }
      } else {
        providerCapabilities = { ...CONSERVATIVE_PROVIDER_CAPABILITIES }
      }

      const applicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
      const capabilities = computeEffectiveCapabilities(
        providerCapabilities,
        applicationCapabilities
      )

      const safeContextWindow =
        raw.contextWindow &&
        typeof raw.contextWindow.inputTokens === 'number' &&
        Number.isFinite(raw.contextWindow.inputTokens) &&
        raw.contextWindow.inputTokens >= 1024 &&
        typeof raw.contextWindow.outputTokens === 'number' &&
        Number.isFinite(raw.contextWindow.outputTokens) &&
        raw.contextWindow.outputTokens >= 256
          ? {
              inputTokens: Math.min(2_000_000, Math.floor(raw.contextWindow.inputTokens)),
              outputTokens: Math.min(
                Math.floor(raw.contextWindow.inputTokens),
                Math.floor(raw.contextWindow.outputTokens)
              )
            }
          : { inputTokens: 32_768, outputTokens: 8_192 }

      sanitizedMap.set(
        cleanId,
        cloneModelDescriptor({
          id: cleanId,
          providerId,
          displayName: raw.displayName?.trim() || cleanId,
          description: raw.description?.trim() || `Discovered model for ${providerId}.`,
          availability: raw.availability ?? 'stable',
          ...(raw.canonicalSlug ? { canonicalSlug: raw.canonicalSlug } : {}),
          contextWindow: safeContextWindow,
          ...(Array.isArray(raw.inputModalities)
            ? { inputModalities: raw.inputModalities.filter((m) => typeof m === 'string') }
            : {}),
          ...(Array.isArray(raw.outputModalities)
            ? { outputModalities: raw.outputModalities.filter((m) => typeof m === 'string') }
            : {}),
          ...(Array.isArray(raw.supportedParameters)
            ? { supportedParameters: raw.supportedParameters.filter((p) => typeof p === 'string') }
            : {}),
          ...(raw.pricing ? { pricing: raw.pricing } : {}),
          ...(raw.metadataSource ? { metadataSource: raw.metadataSource } : {}),
          providerCapabilities,
          applicationCapabilities,
          capabilities,
          docUrl: raw.docUrl ?? ''
        })
      )
    }

    this.discoveredByConnection.set(connectionId, {
      providerId,
      models: sanitizedMap,
      updatedAt: Date.now()
    })

    this.savePersistedDiscoveredModels()
  }

  /**
   * Returns true if no discovered models are cached for this connection or the cache exceeded ttlMs.
   */
  isDiscoveredModelsStale(connectionId: string, ttlMs: number): boolean {
    const entry = this.discoveredByConnection.get(connectionId)
    if (!entry || entry.models.size === 0) {
      return true
    }
    return Date.now() - entry.updatedAt > ttlMs
  }

  /**
   * Removes persisted dynamic models for a deleted or revoked connection.
   */
  clearDiscoveredModels(connectionId: string): void {
    if (this.discoveredByConnection.delete(connectionId)) {
      this.savePersistedDiscoveredModels()
    }
  }

  /**
   * Returns discovered model descriptors cached for a connection.
   */
  getDiscoveredModels(connectionId: string, providerId?: string): ModelDescriptor[] {
    const entry = this.discoveredByConnection.get(connectionId)
    if (!entry) {
      return []
    }
    if (providerId !== undefined && entry.providerId !== providerId) {
      return []
    }
    return Array.from(entry.models.values()).map(cloneModelDescriptor)
  }

  /**
   * Retrieves all registered models, optionally filtered by a specific provider
   * and augmented with connection-scoped discovered models.
   * Returns an empty array if the requested provider is unknown.
   */
  getModels(providerId?: string, connectionId?: string): ModelDescriptor[] {
    if (providerId !== undefined) {
      if (!isValidProviderId(providerId)) {
        return []
      }
      const modelMap = this.modelsByProvider.get(providerId)
      const baseModels = modelMap ? Array.from(modelMap.values()).map(cloneModelDescriptor) : []

      if (connectionId) {
        const discoveredEntry = this.discoveredByConnection.get(connectionId)
        if (discoveredEntry && discoveredEntry.providerId === providerId) {
          const seen = new Set(baseModels.map((m) => m.id))
          for (const discoveredModel of discoveredEntry.models.values()) {
            if (!seen.has(discoveredModel.id)) {
              baseModels.push(cloneModelDescriptor(discoveredModel))
              seen.add(discoveredModel.id)
            }
          }
        }
      }

      return baseModels
    }

    const allModels: ModelDescriptor[] = []
    for (const modelMap of this.modelsByProvider.values()) {
      for (const model of modelMap.values()) {
        allModels.push(cloneModelDescriptor(model))
      }
    }
    return allModels
  }

  /**
   * Retrieves a specific model descriptor by provider ID and model ID,
   * optionally checking connection-scoped discovered models.
   * Returns null if either provider or model is unknown.
   */
  getModel(providerId: string, modelId: string, connectionId?: string): ModelDescriptor | null {
    if (!isValidProviderId(providerId) || !modelId) {
      return null
    }
    const modelMap = this.modelsByProvider.get(providerId)
    const staticModel = modelMap?.get(modelId)
    if (staticModel) {
      return cloneModelDescriptor(staticModel)
    }

    if (connectionId) {
      const discoveredEntry = this.discoveredByConnection.get(connectionId)
      if (discoveredEntry && discoveredEntry.providerId === providerId) {
        const discoveredModel = discoveredEntry.models.get(modelId)
        if (discoveredModel) {
          return cloneModelDescriptor(discoveredModel)
        }
      }
    }

    return null
  }

  /**
   * Retrieves the designated default model descriptor for a provider.
   * Returns null if the provider is unknown or has no default model.
   */
  getDefaultModel(providerId: string): ModelDescriptor | null {
    const provider = this.getProvider(providerId)
    if (!provider || !provider.defaultModelId) {
      return null
    }
    return this.getModel(providerId, provider.defaultModelId)
  }

  /**
   * Checks whether a specific model supports a required capability.
   * Unknown providers or unknown models always return false (never assumed to support capabilities).
   */
  supportsCapability(
    providerId: string,
    modelId: string,
    capability: keyof ModelCapabilities,
    connectionId?: string
  ): boolean {
    const model = this.getModel(providerId, modelId, connectionId)
    if (!model) {
      return false
    }
    return Boolean(model.capabilities[capability])
  }

  /**
   * Checks whether the underlying provider model natively supports a capability,
   * regardless of whether the application currently supports it in this phase.
   */
  supportsNativeCapability(
    providerId: string,
    modelId: string,
    capability: keyof ProviderNativeCapabilities,
    connectionId?: string
  ): boolean {
    const model = this.getModel(providerId, modelId, connectionId)
    if (!model || !model.providerCapabilities) {
      return false
    }
    return Boolean(model.providerCapabilities[capability])
  }

  /**
   * Validates requested capabilities against a model.
   * Returns a typed validation failure if unsupported features are requested.
   */
  validateCapabilities(
    model: ModelDescriptor,
    requested: RequestedCapabilities
  ): CapabilityValidationResult {
    return validateModelCapabilities(model, requested)
  }

  private loadPersistedDiscoveredModels(): void {
    if (!this.persistenceFilePath) return
    try {
      if (!fs.existsSync(this.persistenceFilePath)) return
      const raw = fs.readFileSync(this.persistenceFilePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedDiscoveredSnapshot>
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return

      for (const entry of parsed.entries) {
        if (
          !entry ||
          typeof entry.connectionId !== 'string' ||
          !isValidProviderId(entry.providerId) ||
          !Array.isArray(entry.models)
        ) {
          continue
        }
        this.setDiscoveredModelsWithoutPersist(
          entry.connectionId,
          entry.providerId,
          entry.models,
          entry.updatedAt
        )
      }
    } catch {
      // Ignore malformed cache files safely; discovery can repopulate cleanly on demand
    }
  }

  private setDiscoveredModelsWithoutPersist(
    connectionId: string,
    providerId: ProviderId,
    models: ReadonlyArray<ModelDescriptor>,
    updatedAt?: number
  ): void {
    const previousPath = this.persistenceFilePath
    this.persistenceFilePath = undefined
    try {
      this.setDiscoveredModels(connectionId, providerId, models)
      const stored = this.discoveredByConnection.get(connectionId)
      if (stored && typeof updatedAt === 'number') {
        this.discoveredByConnection.set(connectionId, { ...stored, updatedAt })
      }
    } finally {
      this.persistenceFilePath = previousPath
    }
  }

  private savePersistedDiscoveredModels(): void {
    if (!this.persistenceFilePath) return
    try {
      const dir = path.dirname(this.persistenceFilePath)
      fs.mkdirSync(dir, { recursive: true })
      const entries: PersistedDiscoveredEntry[] = []
      for (const [connectionId, entry] of this.discoveredByConnection.entries()) {
        entries.push({
          connectionId,
          providerId: entry.providerId,
          models: Array.from(entry.models.values()),
          updatedAt: entry.updatedAt
        })
      }
      const snapshot: PersistedDiscoveredSnapshot = { version: 1, entries }
      const tempPath = `${this.persistenceFilePath}.tmp`
      fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8')
      fs.renameSync(tempPath, this.persistenceFilePath)
    } catch {
      // Cache persistence is best-effort and must never crash core provider operations
    }
  }
}

/**
 * Singleton instance of ProviderRegistry initialized with authoritative catalogs.
 */
export const providerRegistry = new ProviderRegistry()
