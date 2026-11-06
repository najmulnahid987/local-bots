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
      'Frontier intelligence models including GPT-4o, reasoning models (o1), and structured output support.',
    docUrl: 'https://developers.openai.com/api/docs/models',
    isSupported: true,
    defaultModelId: 'gpt-4o'
  }),
  Object.freeze({
    id: 'anthropic',
    displayName: 'Anthropic',
    description:
      'Safety-focused frontier models including Claude 3.5 Sonnet, Claude 3.5 Haiku, and Claude 3 Opus.',
    docUrl: 'https://platform.claude.com/docs/en/models/overview',
    isSupported: true,
    defaultModelId: 'claude-3-5-sonnet-20241022'
  }),
  Object.freeze({
    id: 'google',
    displayName: 'Google Gemini',
    description:
      'Multimodal foundation models with massive context windows up to 2 million tokens.',
    docUrl: 'https://ai.google.dev/gemini-api/docs/models',
    isSupported: true,
    defaultModelId: 'gemini-1.5-pro'
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
    id: 'gpt-4o',
    providerId: 'openai',
    displayName: 'GPT-4o',
    description:
      'Flagship multimodal model designed for high-intelligence reasoning, tool use, and complex tasks.',
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
    id: 'gpt-4o-mini',
    providerId: 'openai',
    displayName: 'GPT-4o mini',
    description:
      'Fast, cost-efficient multimodal model for lightweight workflows, quick classification, and high volume.',
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
    id: 'o1-mini',
    providerId: 'openai',
    displayName: 'o1-mini',
    description:
      'Specialized reasoning model optimized for STEM, math, and code generation tasks without vision.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 128000,
      outputTokens: 65536
    }),
    capabilities: Object.freeze({
      streaming: true,
      tools: false,
      imageInput: false,
      structuredOutput: true
    }),
    docUrl: 'https://developers.openai.com/api/docs/models'
  }),
  Object.freeze({
    id: 'o1-preview',
    providerId: 'openai',
    displayName: 'o1-preview',
    description:
      'Early preview reasoning model for complex multi-step reasoning problems before response generation.',
    availability: 'preview',
    contextWindow: Object.freeze({
      inputTokens: 128000,
      outputTokens: 32768
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
    id: 'claude-3-5-sonnet-20241022',
    providerId: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    description:
      'Anthropic flagship model combining industry-leading reasoning, coding, and vision with fast execution.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 200000,
      outputTokens: 8192
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
    id: 'claude-3-5-haiku-20241022',
    providerId: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
    description:
      'Fastest Claude model for rapid responsiveness and high-volume text operations. Text-only input.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 200000,
      outputTokens: 8192
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
    id: 'claude-3-opus-20240229',
    providerId: 'anthropic',
    displayName: 'Claude 3 Opus',
    description:
      'High-intelligence Claude model for open-ended analysis, extensive documentation synthesis, and research.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 200000,
      outputTokens: 4096
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
    id: 'gemini-1.5-pro',
    providerId: 'google',
    displayName: 'Gemini 1.5 Pro',
    description:
      'Highly capable multimodal model with a 2-million-token context window for massive file and document analysis.',
    availability: 'stable',
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
  }),
  Object.freeze({
    id: 'gemini-1.5-flash',
    providerId: 'google',
    displayName: 'Gemini 1.5 Flash',
    description:
      'High-speed, low-latency multimodal model built for efficiency, cost-effective reasoning, and 1M context.',
    availability: 'stable',
    contextWindow: Object.freeze({
      inputTokens: 1048576,
      outputTokens: 8192
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
    id: 'gemini-2.0-flash-exp',
    providerId: 'google',
    displayName: 'Gemini 2.0 Flash Experimental',
    description:
      'Next-generation experimental multimodal model with upgraded real-time reasoning and lower latency.',
    availability: 'preview',
    contextWindow: Object.freeze({
      inputTokens: 1048576,
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
