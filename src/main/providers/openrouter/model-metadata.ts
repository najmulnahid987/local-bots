import {
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities,
  type ContextWindowMetadata,
  type ModelDescriptor,
  type ModelPricingDto,
  type ProviderNativeCapabilities
} from '../types'
import { ProviderAdapterError } from './errors'
import {
  OPENROUTER_DOCS_MODELS_URL,
  openRouterModelsResponseSchema,
  openRouterRawModelSchema,
  type OpenRouterRawModelEntry
} from './types'

/**
 * Scales a non-negative per-token decimal USD string by 1,000,000 using exact digit shifting
 * (zero IEEE-754 floating-point drift) and formats USD per 1M tokens for display.
 */
export function formatOpenRouterPerMillionUsd(rawPerToken?: string): string {
  if (!rawPerToken || rawPerToken.trim().length === 0) {
    return 'Unknown'
  }

  const trimmed = rawPerToken.trim()
  if (trimmed.startsWith('-')) {
    return 'Variable'
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) {
    return 'Unknown'
  }

  const intPart = match[1]
  const fracPart = match[2] ?? ''
  if (/^0+$/.test(intPart) && /^0*$/.test(fracPart)) {
    return 'Free'
  }

  // Multiply by 10^6 via string shifting
  const shiftedFrac = fracPart.padEnd(6, '0')
  const scaledWholeRaw = `${intPart}${shiftedFrac.slice(0, 6)}`.replace(/^0+/, '') || '0'
  const remainder = shiftedFrac.slice(6)
  const twoDecimals = remainder.slice(0, 2).padEnd(2, '0')
  const fourDecimals = remainder.slice(0, 4).padEnd(4, '0')

  if (scaledWholeRaw === '0') {
    if (/^0+$/.test(fourDecimals)) {
      return '<$0.0001 / 1M'
    }
    return `$0.${fourDecimals.replace(/0+$/, '').padEnd(2, '0')} / 1M`
  }

  return `$${scaledWholeRaw}.${twoDecimals} / 1M`
}

function normalizePriceString(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = typeof value === 'number' ? value.toString() : value.trim()
  if (!s) return undefined
  // Reject malformed non-numeric strings; permit '-' only for OpenRouter variable/auto sentinel '-1'
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
    return undefined
  }
  return s
}

export function extractOpenRouterPricing(
  pricing: OpenRouterRawModelEntry['pricing']
): ModelPricingDto | undefined {
  if (!pricing || typeof pricing !== 'object') {
    return undefined
  }

  const promptPerTokenUsd = normalizePriceString(pricing.prompt)
  const completionPerTokenUsd = normalizePriceString(pricing.completion)
  const requestUsd = normalizePriceString(pricing.request)
  const imageUsd = normalizePriceString(pricing.image)

  if (!promptPerTokenUsd && !completionPerTokenUsd && !requestUsd && !imageUsd) {
    return undefined
  }

  const isFree =
    promptPerTokenUsd !== undefined &&
    completionPerTokenUsd !== undefined &&
    /^0+(?:\.0+)?$/.test(promptPerTokenUsd) &&
    /^0+(?:\.0+)?$/.test(completionPerTokenUsd)

  return {
    ...(promptPerTokenUsd !== undefined ? { promptPerTokenUsd } : {}),
    ...(completionPerTokenUsd !== undefined ? { completionPerTokenUsd } : {}),
    ...(requestUsd !== undefined ? { requestUsd } : {}),
    ...(imageUsd !== undefined ? { imageUsd } : {}),
    isFree
  }
}

function resolveOpenRouterContextWindow(entry: OpenRouterRawModelEntry): ContextWindowMetadata {
  const candidateContext = entry.top_provider?.context_length ?? entry.context_length
  const inputTokens =
    typeof candidateContext === 'number' &&
    Number.isFinite(candidateContext) &&
    candidateContext >= 1024
      ? Math.min(2_000_000, Math.floor(candidateContext))
      : 32_768

  const candidateMaxOutput = entry.top_provider?.max_completion_tokens
  const outputTokens =
    typeof candidateMaxOutput === 'number' &&
    Number.isFinite(candidateMaxOutput) &&
    candidateMaxOutput >= 256
      ? Math.min(inputTokens, Math.floor(candidateMaxOutput))
      : Math.min(16_384, Math.floor(inputTokens / 4))

  return {
    inputTokens,
    outputTokens
  }
}

/**
 * Validates and converts a single OpenRouter model object into a safe ModelDescriptor.
 * Capabilities are derived strictly from authoritative `supported_parameters` and `architecture.input_modalities`,
 * NEVER guessed from model ID or display name.
 */
export function parseOpenRouterModelEntry(
  rawEntry: unknown,
  metadataSource: 'user_models' | 'public_catalog'
): ModelDescriptor | null {
  const parsed = openRouterRawModelSchema.safeParse(rawEntry)
  if (!parsed.success) {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Malformed OpenRouter model metadata entry encountered.',
      retryable: false
    })
  }

  const entry = parsed.data
  const inputModalities = Array.isArray(entry.architecture?.input_modalities)
    ? entry.architecture.input_modalities.filter((m): m is string => typeof m === 'string')
    : undefined
  const outputModalities = Array.isArray(entry.architecture?.output_modalities)
    ? entry.architecture.output_modalities.filter((m): m is string => typeof m === 'string')
    : undefined

  // Exclude non-text-generating models (e.g., pure image-gen or embeddings) from chat selection
  if (outputModalities && outputModalities.length > 0 && !outputModalities.includes('text')) {
    return null
  }

  const supportedParameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter((p): p is string => typeof p === 'string')
    : undefined

  const paramSet = new Set(supportedParameters ?? [])
  const providerCapabilities: ProviderNativeCapabilities = {
    streaming: true,
    tools: paramSet.has('tools'),
    imageInput: inputModalities ? inputModalities.includes('image') : false,
    structuredOutput: paramSet.has('structured_outputs') || paramSet.has('response_format'),
    reasoning: paramSet.has('reasoning') || paramSet.has('include_reasoning')
  }

  const applicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
  const capabilities = computeEffectiveCapabilities(providerCapabilities, applicationCapabilities)
  const contextWindow = resolveOpenRouterContextWindow(entry)
  const pricing = extractOpenRouterPricing(entry.pricing)

  const displayName = entry.name && entry.name.trim().length > 0 ? entry.name.trim() : entry.id
  const description =
    entry.description && entry.description.trim().length > 0
      ? entry.description.trim()
      : `OpenRouter routed model (${entry.id}).`

  return {
    id: entry.id,
    providerId: 'openrouter',
    displayName,
    description,
    availability: entry.id.includes(':free') || entry.id.includes(':beta') ? 'preview' : 'stable',
    ...(entry.canonical_slug ? { canonicalSlug: entry.canonical_slug } : {}),
    contextWindow,
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(pricing ? { pricing } : {}),
    metadataSource,
    providerCapabilities,
    applicationCapabilities,
    capabilities,
    docUrl: `${OPENROUTER_DOCS_MODELS_URL}/${entry.id}`
  }
}

/**
 * Validates and parses an OpenRouter `/models` or `/models/user` JSON response payload.
 * Rejects malformed top-level envelopes cleanly and preserves exact model identifiers.
 */
export function parseOpenRouterModelsResponse(
  rawPayload: unknown,
  metadataSource: 'user_models' | 'public_catalog'
): ModelDescriptor[] {
  const envelope = openRouterModelsResponseSchema.safeParse(rawPayload)
  if (!envelope.success) {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'Malformed OpenRouter models response payload: expected { data: [...] }.',
      retryable: false
    })
  }

  const seen = new Set<string>()
  const descriptors: ModelDescriptor[] = []
  let invalidCount = 0

  for (const item of envelope.data.data) {
    try {
      const descriptor = parseOpenRouterModelEntry(item, metadataSource)
      if (!descriptor || seen.has(descriptor.id)) continue
      seen.add(descriptor.id)
      descriptors.push(descriptor)
    } catch {
      invalidCount++
    }
  }

  if (envelope.data.data.length > 0 && descriptors.length === 0 && invalidCount > 0) {
    throw new ProviderAdapterError({
      code: 'INVALID_REQUEST',
      message: 'All OpenRouter model entries in response failed schema validation.',
      retryable: false
    })
  }

  return descriptors
}
