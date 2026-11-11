import {
  type CapabilityValidationResult,
  type ModelCapabilities,
  type ModelDescriptor,
  type RequestedCapabilities,
  type ProviderId,
  isValidProviderId
} from './types'
import { providerRegistry, type ProviderRegistry } from './provider-registry'
import { ProviderManagerError, type ProviderManagerErrorCode } from './provider-manager/errors'
import { type ProviderConnection } from '../database/repositories/types'

const CAPABILITY_LABELS: Record<keyof ModelCapabilities, string> = {
  streaming: 'streaming output',
  tools: 'tool calling',
  imageInput: 'multimodal image input',
  structuredOutput: 'structured output schemas'
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validates requested workflow/bot capabilities against an authoritative model descriptor.
 * If any requested capability is unsupported, returns a typed failure with all missing capabilities.
 */
export function validateModelCapabilities(
  model: ModelDescriptor,
  requested: RequestedCapabilities
): CapabilityValidationResult {
  const missing: Array<keyof ModelCapabilities> = []

  if (requested.streaming === true && !model.capabilities.streaming) {
    missing.push('streaming')
  }

  if (requested.tools === true && !model.capabilities.tools) {
    missing.push('tools')
  }

  if (requested.imageInput === true && !model.capabilities.imageInput) {
    missing.push('imageInput')
  }

  if (requested.structuredOutput === true && !model.capabilities.structuredOutput) {
    missing.push('structuredOutput')
  }

  if (missing.length === 0) {
    return { valid: true }
  }

  const missingLabels = missing.map((cap) => CAPABILITY_LABELS[cap]).join(', ')
  const reason = `Model '${model.id}' from provider '${model.providerId}' does not support requested capability: ${missingLabels}.`

  return {
    valid: false,
    reason,
    unsupportedCapabilities: Object.freeze(missing)
  }
}

/**
 * Minimal abstraction for provider connection lookup.
 * Compatible with ProviderConnectionRepository or in-memory fixtures.
 */
export interface ProviderConnectionLookup {
  getById(id: string): ProviderConnection | null
}

export interface ValidateBotModelCompatibilityOptions {
  readonly providerConnectionId?: string | null
  readonly modelId: string
  readonly connectionRepo?: ProviderConnectionLookup
  readonly registry?: ProviderRegistry
}

export interface BotModelCompatibilityResult {
  readonly valid: boolean
  readonly error?: {
    readonly code: ProviderManagerErrorCode
    readonly message: string
  }
  readonly model?: ModelDescriptor
  readonly providerId?: ProviderId
  readonly connection?: ProviderConnection
}

/**
 * Validates compatibility between a Bot's requested model and optional provider connection:
 * 1. Validates that modelId is a non-empty string.
 * 2. If providerConnectionId is specified, verifies it exists and is a valid UUIDv4.
 * 3. Verifies that the modelId is present in the authoritative model catalog.
 * 4. Strictly prevents pairing a model from one provider with a connection belonging to another.
 * 5. If providerConnectionId is absent (null/undefined), verifies the model exists in the catalog.
 */
export function validateBotModelCompatibility(
  options: ValidateBotModelCompatibilityOptions
): BotModelCompatibilityResult {
  const { providerConnectionId, modelId, connectionRepo, registry = providerRegistry } = options

  // 1. Validate modelId string format
  if (!modelId || typeof modelId !== 'string' || modelId.trim().length === 0) {
    return {
      valid: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Model ID must be a non-empty string.'
      }
    }
  }

  const trimmedModelId = modelId.trim()

  // 2. Bound connection validation
  if (providerConnectionId !== null && providerConnectionId !== undefined) {
    if (typeof providerConnectionId !== 'string' || !UUID_REGEX.test(providerConnectionId)) {
      return {
        valid: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid provider connection ID: '${providerConnectionId}'. Must be a valid UUIDv4 string.`
        }
      }
    }

    if (!connectionRepo) {
      return {
        valid: false,
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'Connection repository lookup is required when providerConnectionId is specified.'
        }
      }
    }

    const connection = connectionRepo.getById(providerConnectionId)
    if (!connection) {
      return {
        valid: false,
        error: {
          code: 'CONNECTION_NOT_FOUND',
          message: `Referenced provider connection with ID '${providerConnectionId}' does not exist.`
        }
      }
    }

    const providerId = connection.providerId as ProviderId
    if (!isValidProviderId(providerId) || !registry.getProvider(providerId)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_PROVIDER_ID',
          message: `Provider connection references unsupported provider '${providerId}'.`
        }
      }
    }

    // Check if the model is registered under this connection's provider
    const model = registry.getModel(providerId, trimmedModelId)
    if (model) {
      return {
        valid: true,
        model,
        providerId,
        connection
      }
    }

    // Model not found under this provider. Check if it belongs to another provider.
    const crossProviderMatch = registry.getModels().find((m) => m.id === trimmedModelId)
    if (crossProviderMatch) {
      return {
        valid: false,
        error: {
          code: 'CROSS_PROVIDER_MODEL_MISMATCH',
          message: `Model '${trimmedModelId}' belongs to provider '${crossProviderMatch.providerId}' and cannot be paired with a connection for provider '${providerId}'.`
        }
      }
    }

    return {
      valid: false,
      error: {
        code: 'MODEL_NOT_FOUND',
        message: `Model '${trimmedModelId}' was not found in the catalog for provider '${providerId}'.`
      }
    }
  }

  // 3. Unbound connection validation (providerConnectionId is null or undefined)
  const foundModel = registry.getModels().find((m) => m.id === trimmedModelId)
  if (!foundModel) {
    return {
      valid: false,
      error: {
        code: 'MODEL_NOT_FOUND',
        message: `Model '${trimmedModelId}' is not recognized in any supported provider catalog.`
      }
    }
  }

  return {
    valid: true,
    model: foundModel,
    providerId: foundModel.providerId
  }
}

/**
 * Asserts compatibility between provider connection and model, throwing a typed
 * ProviderManagerError on failure.
 */
export function assertBotModelCompatibility(
  options: ValidateBotModelCompatibilityOptions
): BotModelCompatibilityResult {
  const result = validateBotModelCompatibility(options)
  if (!result.valid && result.error) {
    throw new ProviderManagerError(result.error.message, result.error.code)
  }
  return result
}
