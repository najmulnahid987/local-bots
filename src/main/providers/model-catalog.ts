import { type ModelDescriptor, type ProviderDescriptor } from './types'

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

/**
 * Curated initial catalog of verified AI models across supported providers.
 *
 * Verification Sources:
 * - OpenAI: https://developers.openai.com/api/docs/models
 * - Anthropic: https://platform.claude.com/docs/en/models/overview
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/models
 */
export const INITIAL_MODELS: ReadonlyArray<ModelDescriptor> = Object.freeze([
  // --- OpenAI Models ---
  Object.freeze({
    id: 'gpt-6-luna',
    providerId: 'openai',
    displayName: 'GPT-6 Luna',
    description:
      'Cost-sensitive, high-speed multimodal model built for responsive workflows and lightweight reasoning.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 128000,
      outputTokens: 16384
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  Object.freeze({
    id: 'gpt-6.1-sol',
    providerId: 'openai',
    displayName: 'GPT-6.1 Sol',
    description:
      'Balanced flagship intelligence model for multi-step reasoning, coding, and general agentic workflows.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 256000,
      outputTokens: 32768
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  Object.freeze({
    id: 'gpt-6-astra',
    providerId: 'openai',
    displayName: 'GPT-6 Astra',
    description:
      'Advanced reasoning and frontier analytical model for deep multi-turn problem solving and synthesis.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 256000,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  Object.freeze({
    id: 'gpt-6.1-terra',
    providerId: 'openai',
    displayName: 'GPT-6.1 Terra',
    description:
      'Preview frontier scientific and mathematical reasoning model with rigorous self-verification.',
    availability: 'preview',
    contextWindow: Object.freeze({
      inputTokens: 256000,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: false,
      tools: false,
      imageInput: false,
      structuredOutput: false
    }),
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),

  // --- Anthropic Models ---
  Object.freeze({
    id: 'claude-sonnet-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 5.5',
    description:
      'Anthropic flagship model balancing frontier intelligence with high execution speed and 1M context.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1000000,
      outputTokens: 128000
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),
  Object.freeze({
    id: 'claude-haiku-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 5.5',
    description:
      'Fastest and most cost-sensitive Claude model for high-frequency workflows and lightweight tasks. Text-only input.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1000000,
      outputTokens: 128000
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    }),
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),
  Object.freeze({
    id: 'claude-opus-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Opus 5.5',
    description:
      'Most intelligent Claude model for open-ended analysis, extensive documentation synthesis, and deep research.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1000000,
      outputTokens: 128000
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),

  // --- Google Gemini Models ---
  Object.freeze({
    id: 'gemini-3.8-flash',
    providerId: 'google',
    displayName: 'Gemini 3.8 Flash',
    description:
      'Flagship multimodal model engineered for high-throughput reasoning, frontier code generation, and 1M context.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1048576,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  Object.freeze({
    id: 'gemini-3.7-flash',
    providerId: 'google',
    displayName: 'Gemini 3.7 Flash',
    description:
      'High-speed multimodal model combining responsive performance and reasoning efficiency with 1M context.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1048576,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  Object.freeze({
    id: 'gemini-3.6-flash',
    providerId: 'google',
    displayName: 'Gemini 3.6 Flash',
    description:
      'Balanced multimodal model optimized for lightweight tasks and cost-efficient processing.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1048576,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),
  Object.freeze({
    id: 'gemini-1.5-pro',
    providerId: 'google',
    displayName: 'Gemini 1.5 Pro (Legacy)',
    description:
      'Legacy multimodal model with 2M context window. Deprecated in favor of Gemini 3.x series.',
    availability: 'deprecated',
    contextWindow: Object.freeze({
      inputTokens: 2097152,
      outputTokens: 8192
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }),
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  })
])
