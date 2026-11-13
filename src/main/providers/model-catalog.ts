import {
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderNativeCapabilities,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
} from './types'

/**
 * Curated registry of first-wave AI model providers.
 * Each provider has verified documentation and a confirmed default model.
 */
export const INITIAL_PROVIDERS: ReadonlyArray<ProviderDescriptor> = Object.freeze([
  Object.freeze({
    id: 'openai',
    displayName: 'OpenAI',
    description:
      'Frontier intelligence models including GPT-6 Luna, GPT-6.1 Sol, GPT-6 Astra, and reasoning models.',
    docUrl: 'https://developers.openai.com/api/docs/models',
    isSupported: true,
    defaultModelId: 'gpt-6-luna'
  }),
  Object.freeze({
    id: 'anthropic',
    displayName: 'Anthropic',
    description:
      'Safety-focused frontier intelligence models including Claude Sonnet 5.5, Claude Opus 5.5, and Claude Haiku 5.5.',
    docUrl: 'https://platform.claude.com/docs/en/models/overview',
    isSupported: true,
    defaultModelId: 'claude-sonnet-5-5'
  }),
  Object.freeze({
    id: 'google',
    displayName: 'Google Gemini',
    description:
      'Multimodal foundation models with massive context windows up to 1 million tokens.',
    docUrl: 'https://ai.google.dev/gemini-api/docs/models',
    isSupported: true,
    defaultModelId: 'gemini-3.8-flash'
  })
])

function defineModel(
  raw: Omit<ModelDescriptor, 'capabilities' | 'applicationCapabilities'> & {
    readonly providerCapabilities: ProviderNativeCapabilities
  }
): ModelDescriptor {
  const applicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
  const capabilities = computeEffectiveCapabilities(
    raw.providerCapabilities,
    applicationCapabilities
  )

  return Object.freeze({
    id: raw.id,
    providerId: raw.providerId,
    displayName: raw.displayName,
    description: raw.description,
    availability: raw.availability,
    contextWindow: raw.contextWindow ? Object.freeze(raw.contextWindow) : undefined,
    providerCapabilities: Object.freeze(raw.providerCapabilities),
    applicationCapabilities,
    capabilities: Object.freeze(capabilities),
    docUrl: raw.docUrl
  })
}

/**
 * Curated initial catalog of verified AI models across supported providers.
 *
 * Distinguishes:
 * 1. providerCapabilities: Native capabilities supported by vendor models according to documentation.
 * 2. applicationCapabilities: Capabilities currently supported by the local application in Phase 3.
 * 3. capabilities: Effective capabilities executable in the current runtime environment.
 */
export const INITIAL_MODELS: ReadonlyArray<ModelDescriptor> = Object.freeze([
  // --- OpenAI Models ---
  defineModel({
    id: 'gpt-6-luna',
    providerId: 'openai',
    displayName: 'GPT-6 Luna',
    description:
      'Cost-sensitive, high-speed multimodal model built for responsive workflows and lightweight reasoning.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 128000,
      outputTokens: 16384
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  defineModel({
    id: 'gpt-6.1-sol',
    providerId: 'openai',
    displayName: 'GPT-6.1 Sol',
    description:
      'Balanced flagship intelligence model for multi-step reasoning, coding, and general agentic workflows.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 256000,
      outputTokens: 32768
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  defineModel({
    id: 'gpt-6-astra',
    providerId: 'openai',
    displayName: 'GPT-6 Astra',
    description:
      'Advanced reasoning and frontier analytical model for deep multi-turn problem solving and synthesis.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 256000,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  defineModel({
    id: 'gpt-6.1-terra',
    providerId: 'openai',
    displayName: 'GPT-6.1 Terra',
    description:
      'Preview frontier scientific and mathematical reasoning model with rigorous self-verification.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 256000,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: false,
      tools: false,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),

  // --- Anthropic Models ---
  defineModel({
    id: 'claude-sonnet-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 5.5',
    description:
      'Anthropic flagship model balancing frontier intelligence with high execution speed and 1M context.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1000000,
      outputTokens: 128000
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),
  defineModel({
    id: 'claude-haiku-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 5.5',
    description:
      'Fastest and most cost-sensitive Claude model for high-frequency workflows and lightweight tasks. Text-only input.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1000000,
      outputTokens: 128000
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    },
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),
  defineModel({
    id: 'claude-opus-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Opus 5.5',
    description:
      'Most intelligent Claude model for open-ended analysis, extensive documentation synthesis, and deep research.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1000000,
      outputTokens: 128000
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),

  // --- Google Gemini Models ---
  defineModel({
    id: 'gemini-2.5-flash',
    providerId: 'google',
    displayName: 'Gemini 2.5 Flash',
    description:
      'Ultra-fast, cost-efficient multimodal flagship model with 1M context window.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-2.5-pro',
    providerId: 'google',
    displayName: 'Gemini 2.5 Pro',
    description:
      'Frontier multimodal reasoning model with exceptional coding and analysis capabilities.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 2097152,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-3.8-flash',
    providerId: 'google',
    displayName: 'Gemini 3.8 Flash',
    description:
      'Flagship multimodal model engineered for high-throughput reasoning, frontier code generation, and 1M context.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-3.7-flash',
    providerId: 'google',
    displayName: 'Gemini 3.7 Flash',
    description:
      'High-speed multimodal model combining responsive performance and reasoning efficiency with 1M context.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-3.6-flash',
    providerId: 'google',
    displayName: 'Gemini 3.6 Flash',
    description:
      'Balanced multimodal model optimized for lightweight tasks and cost-efficient processing.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-1.5-flash',
    providerId: 'google',
    displayName: 'Gemini 1.5 Flash',
    description:
      'Fast, versatile multimodal model for high-frequency workflows, document retrieval, and 1M context.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 8192
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-2.0-flash',
    providerId: 'google',
    displayName: 'Gemini 2.0 Flash',
    description:
      'Next-generation multimodal model with enhanced speed, multimodal reasoning, and 1M context.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 8192
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  defineModel({
    id: 'gemini-1.5-pro',
    providerId: 'google',
    displayName: 'Gemini 1.5 Pro (Legacy)',
    description:
      'Legacy multimodal model with 2M context window. Deprecated in favor of Gemini 3.x series.',
    availability: 'deprecated',
    contextWindow: {
      inputTokens: 2097152,
      outputTokens: 8192
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  })
])
