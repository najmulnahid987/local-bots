import { INITIAL_MODELS, INITIAL_PROVIDERS } from './model-catalog'
import { validateModelCapabilities } from './capability-validator'
import {
  type CapabilityValidationResult,
  type ModelCapabilities,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderNativeCapabilities,
  type RequestedCapabilities,
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
    contextWindow: model.contextWindow ? { ...model.contextWindow } : undefined,
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

/**
 * Authoritative provider and model registry.
 * Provides immutable metadata for provider adapters, Bot configuration, and capability validation.
 */
export class ProviderRegistry {
  private readonly providers: ReadonlyMap<ProviderId, ProviderDescriptor>
  private readonly modelsByProvider: ReadonlyMap<ProviderId, ReadonlyMap<string, ModelDescriptor>>

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
   * Retrieves all registered models, optionally filtered by a specific provider.
   * Returns an empty array if the requested provider is unknown.
   */
  getModels(providerId?: string): ModelDescriptor[] {
    if (providerId !== undefined) {
      if (!isValidProviderId(providerId)) {
        return []
      }
      const modelMap = this.modelsByProvider.get(providerId)
      if (!modelMap) {
        return []
      }
      return Array.from(modelMap.values()).map(cloneModelDescriptor)
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
   * Retrieves a specific model descriptor by provider ID and model ID.
   * Returns null if either provider or model is unknown.
   */
  getModel(providerId: string, modelId: string): ModelDescriptor | null {
    if (!isValidProviderId(providerId) || !modelId) {
      return null
    }
    const modelMap = this.modelsByProvider.get(providerId)
    if (!modelMap) {
      return null
    }
    const model = modelMap.get(modelId)
    return model ? cloneModelDescriptor(model) : null
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
    capability: keyof ModelCapabilities
  ): boolean {
    const model = this.getModel(providerId, modelId)
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
    capability: keyof ProviderNativeCapabilities
  ): boolean {
    const model = this.getModel(providerId, modelId)
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
}

/**
 * Singleton instance of ProviderRegistry initialized with authoritative catalogs.
 */
export const providerRegistry = new ProviderRegistry()
