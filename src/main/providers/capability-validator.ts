import {
  type CapabilityValidationResult,
  type ModelCapabilities,
  type ModelDescriptor,
  type RequestedCapabilities
} from './types'

const CAPABILITY_LABELS: Record<keyof ModelCapabilities, string> = {
  streaming: 'streaming output',
  tools: 'tool calling',
  imageInput: 'multimodal image input',
  structuredOutput: 'structured output schemas'
}

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
