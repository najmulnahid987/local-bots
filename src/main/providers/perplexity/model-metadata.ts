import {
  type ContextWindowMetadata,
  type ModelAvailability,
  type ModelDescriptor,
  type ProviderNativeCapabilities,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
} from '../types'
import type { PerplexityCatalogKind } from './types'

export const PERPLEXITY_AGENT_API_DOCS_URL = 'https://docs.perplexity.ai/docs/agent-api/quickstart'
export const PERPLEXITY_MODELS_DOCS_URL = 'https://docs.perplexity.ai/docs/agent-api/models'
export const PERPLEXITY_PRESETS_DOCS_URL = 'https://docs.perplexity.ai/docs/agent-api/presets'

export interface CuratedPerplexityModelProfile {
  readonly id: string
  readonly kind: PerplexityCatalogKind
  readonly displayName: string
  readonly description: string
  readonly availability: ModelAvailability
  readonly contextWindow: ContextWindowMetadata
  readonly providerCapabilities: ProviderNativeCapabilities
  readonly supportedParameters: readonly string[]
  readonly docUrl: string
}

/**
 * Curated official Perplexity Agent API direct models, effort presets, and documented third-party models.
 * Presets (`fast`, `low`, `medium`, `high`, `xhigh`) route dynamically per Perplexity's Agent API preset table,
 * whereas model IDs (`provider/model`) invoke a specific Agent API model directly.
 * Native binary PDF file uploads are not supported through Local Bots text adapters; PDF ingestion remains local.
 */
export const PERPLEXITY_CURATED_MODEL_PROFILES: Readonly<
  Record<string, CuratedPerplexityModelProfile>
> = Object.freeze({
  'perplexity/sonar': {
    id: 'perplexity/sonar',
    kind: 'direct_model',
    displayName: 'Perplexity Sonar (Direct Model)',
    description:
      'Direct Perplexity Agent API model grounded in real-time web search without preset dynamic routing.',
    availability: 'stable',
    contextWindow: { inputTokens: 127_072, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: false,
      imageInput: true,
      structuredOutput: true,
      reasoning: false
    },
    supportedParameters: ['agent_api_direct_model', 'web_search', 'structured_outputs'],
    docUrl: PERPLEXITY_MODELS_DOCS_URL
  },
  fast: {
    id: 'fast',
    kind: 'agent_preset',
    displayName: 'Fast (Agent Preset)',
    description:
      'Perplexity Agent API preset optimized for rapid web-grounded answers with low latency.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_preset', 'web_search', 'tools', 'structured_outputs'],
    docUrl: PERPLEXITY_PRESETS_DOCS_URL
  },
  low: {
    id: 'low',
    kind: 'agent_preset',
    displayName: 'Low Effort (Agent Preset)',
    description:
      'Perplexity Agent API preset balancing fast search grounding with light step reasoning.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_preset', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_PRESETS_DOCS_URL
  },
  medium: {
    id: 'medium',
    kind: 'agent_preset',
    displayName: 'Medium Effort (Agent Preset)',
    description:
      'Perplexity Agent API preset for multi-step web research, synthesis, and tool execution.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_preset', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_PRESETS_DOCS_URL
  },
  high: {
    id: 'high',
    kind: 'agent_preset',
    displayName: 'High Effort (Agent Preset)',
    description:
      'Perplexity Agent API preset for deeper research synthesis and multi-query verification.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 32_768 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_preset', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_PRESETS_DOCS_URL
  },
  xhigh: {
    id: 'xhigh',
    kind: 'agent_preset',
    displayName: 'Extra High Effort (Agent Preset)',
    description:
      'Perplexity Agent API maximum-effort reasoning preset for exhaustive web-grounded analysis.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 32_768 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_preset', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_PRESETS_DOCS_URL
  },
  'openai/gpt-4o': {
    id: 'openai/gpt-4o',
    kind: 'third_party_routed',
    displayName: 'GPT-4o (via Perplexity Agent API)',
    description:
      'Third-party OpenAI GPT-4o model executed via Perplexity Agent API routing with Perplexity web search.',
    availability: 'stable',
    contextWindow: { inputTokens: 128_000, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: false
    },
    supportedParameters: ['agent_api_third_party_model', 'web_search', 'tools'],
    docUrl: PERPLEXITY_MODELS_DOCS_URL
  },
  'anthropic/claude-sonnet-4-5': {
    id: 'anthropic/claude-sonnet-4-5',
    kind: 'third_party_routed',
    displayName: 'Claude Sonnet 4.5 (via Perplexity Agent API)',
    description:
      'Third-party Anthropic Claude Sonnet 4.5 model executed via Perplexity Agent API routing with web search.',
    availability: 'stable',
    contextWindow: { inputTokens: 200_000, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_third_party_model', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_MODELS_DOCS_URL
  },
  'google/gemini-2.5-pro': {
    id: 'google/gemini-2.5-pro',
    kind: 'third_party_routed',
    displayName: 'Gemini 2.5 Pro (via Perplexity Agent API)',
    description:
      'Third-party Google Gemini 2.5 Pro model executed via Perplexity Agent API routing with web search.',
    availability: 'stable',
    contextWindow: { inputTokens: 1_000_000, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true,
      reasoning: true
    },
    supportedParameters: ['agent_api_third_party_model', 'web_search', 'tools', 'reasoning'],
    docUrl: PERPLEXITY_MODELS_DOCS_URL
  }
})

export const PERPLEXITY_EFFORT_PRESETS = new Set<string>(['fast', 'low', 'medium', 'high', 'xhigh'])

export function isPerplexityEffortPreset(modelId: string): boolean {
  return PERPLEXITY_EFFORT_PRESETS.has(modelId)
}

export function getCuratedPerplexityModelProfile(
  modelId: string
): CuratedPerplexityModelProfile | undefined {
  return PERPLEXITY_CURATED_MODEL_PROFILES[modelId]
}

export function getPerplexityCuratedCatalogModels(): ReadonlyArray<ModelDescriptor> {
  const applicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
  return Object.values(PERPLEXITY_CURATED_MODEL_PROFILES).map((profile) =>
    Object.freeze({
      id: profile.id,
      providerId: 'perplexity' as const,
      displayName: profile.displayName,
      description: profile.description,
      availability: profile.availability,
      contextWindow: Object.freeze({ ...profile.contextWindow }),
      supportedParameters: Object.freeze([...profile.supportedParameters]),
      metadataSource: 'catalog' as const,
      providerCapabilities: Object.freeze({ ...profile.providerCapabilities }),
      applicationCapabilities,
      capabilities: Object.freeze(
        computeEffectiveCapabilities(profile.providerCapabilities, applicationCapabilities)
      ),
      docUrl: profile.docUrl
    })
  )
}
