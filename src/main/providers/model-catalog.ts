import {
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderNativeCapabilities,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
} from './types'
import { getPerplexityCuratedCatalogModels } from './perplexity/model-metadata'

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
  }),
  Object.freeze({
    id: 'groq',
    displayName: 'Groq',
    description:
      'High-speed LPU inference platform hosting Llama, GPT-OSS, Qwen, and Kimi open models.',
    docUrl: 'https://console.groq.com/docs/models',
    isSupported: true,
    defaultModelId: 'llama-3.3-70b-versatile'
  }),
  Object.freeze({
    id: 'openrouter',
    displayName: 'OpenRouter',
    description:
      'Unified HTTPS routing API providing access to diverse foundation and open-weight models through one key.',
    docUrl: 'https://openrouter.ai/models',
    isSupported: true,
    defaultModelId: 'openrouter/auto'
  }),
  Object.freeze({
    id: 'perplexity',
    displayName: 'Perplexity',
    description:
      'Perplexity Agent API supporting native real-time web research, Sonar models, effort presets, and third-party routed models.',
    docUrl: 'https://docs.perplexity.ai/docs/agent-api/quickstart',
    isSupported: true,
    defaultModelId: 'perplexity/sonar'
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
  defineModel({
    id: 'claude-research-preview',
    providerId: 'anthropic',
    displayName: 'Claude Research Preview',
    description:
      'Frontier research preview model for pure text reasoning. Function and tool calling disabled.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 1000000,
      outputTokens: 128000
    },
    providerCapabilities: {
      streaming: false,
      tools: false,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://platform.claude.com/docs/en/models/overview'
  }),

  // --- Google Gemini Models ---
  defineModel({
    id: 'gemini-2.5-flash',
    providerId: 'google',
    displayName: 'Gemini 2.5 Flash',
    description: 'Ultra-fast, cost-efficient multimodal flagship model with 1M context window.',
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
  }),
  defineModel({
    id: 'gemini-deep-research',
    providerId: 'google',
    displayName: 'Gemini Deep Research (Preview)',
    description:
      'Long-horizon autonomous synthesis and deep reasoning preview model. Tool calling disabled.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 1048576,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: false,
      tools: false,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://ai.google.dev/gemini-api/docs/models'
  }),

  // --- Groq Models ---
  defineModel({
    id: 'llama-3.3-70b-versatile',
    providerId: 'groq',
    displayName: 'Llama 3.3 70B Versatile (Groq)',
    description: 'High-capability general-purpose Meta Llama 3.3 70B model on Groq LPU.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 32768
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'llama-3.1-8b-instant',
    providerId: 'groq',
    displayName: 'Llama 3.1 8B Instant (Groq)',
    description:
      'Ultra-low-latency 8B Meta Llama model for fast responses and lightweight tool calls.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 131072
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'openai/gpt-oss-120b',
    providerId: 'groq',
    displayName: 'GPT-OSS 120B (Groq)',
    description:
      'Open-weight 120B flagship reasoning model with native tool calling and JSON Schema support.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'openai/gpt-oss-20b',
    providerId: 'groq',
    displayName: 'GPT-OSS 20B (Groq)',
    description: 'Fast open-weight 20B reasoning model with tool calling and JSON Schema support.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 65536
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    providerId: 'groq',
    displayName: 'Llama 4 Scout 17B (Groq)',
    description: 'Multimodal Mixture-of-Experts Llama 4 Scout model with vision and tool use.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 8192
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    providerId: 'groq',
    displayName: 'Llama 4 Maverick 17B (Groq)',
    description: 'Multimodal Llama 4 Maverick model with vision and tool calling support.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 8192
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: false
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'qwen/qwen3-32b',
    providerId: 'groq',
    displayName: 'Qwen3 32B (Groq)',
    description: 'Qwen3 32B model with strong reasoning and tool use support.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 131072,
      outputTokens: 40960
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  defineModel({
    id: 'moonshotai/kimi-k2-instruct-0905',
    providerId: 'groq',
    displayName: 'Kimi K2 Instruct 0905 (Groq)',
    description: 'Long-context Moonshot Kimi K2 model with tool calling and structured outputs.',
    availability: 'preview',
    contextWindow: {
      inputTokens: 262144,
      outputTokens: 16384
    },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    },
    docUrl: 'https://console.groq.com/docs/models'
  }),
  // --- OpenRouter Baseline Router ---
  defineModel({
    id: 'openrouter/auto',
    providerId: 'openrouter',
    displayName: 'OpenRouter Auto Router',
    description:
      'OpenRouter dynamic automatic router. Discover your key-accessible catalog to view exact model pricing and tool support.',
    availability: 'stable',
    contextWindow: {
      inputTokens: 128000,
      outputTokens: 16384
    },
    providerCapabilities: {
      streaming: true,
      tools: false,
      imageInput: false,
      structuredOutput: false
    },
    docUrl: 'https://openrouter.ai/openrouter/auto'
  }),
  // --- Perplexity Agent API Curated Models & Presets ---
  ...getPerplexityCuratedCatalogModels()
])
