import {
  type ContextWindowMetadata,
  type ModelAvailability,
  type ModelDescriptor,
  type ProviderNativeCapabilities,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
} from '../types'
import type { GroqApiModelEntry } from './types'

export const GROQ_DOCS_MODELS_URL = 'https://console.groq.com/docs/models'

export interface CuratedGroqModelProfile {
  readonly displayName: string
  readonly description: string
  readonly availability: ModelAvailability
  readonly contextWindow: ContextWindowMetadata
  readonly providerCapabilities: ProviderNativeCapabilities
}

/**
 * Authoritative verified capabilities and limits for documented Groq chat models.
 * Unknown dynamically discovered models fall back to safe conservative defaults.
 */
export const GROQ_CURATED_MODEL_PROFILES: Readonly<Record<string, CuratedGroqModelProfile>> = {
  'llama-3.3-70b-versatile': {
    displayName: 'Llama 3.3 70B Versatile',
    description:
      'Meta Llama 3.3 70B model on Groq LPU inference with strong reasoning and tool use.',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 32_768 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false
    }
  },
  'llama-3.1-8b-instant': {
    displayName: 'Llama 3.1 8B Instant',
    description:
      'Ultra-low-latency Llama 3.1 8B model optimized for rapid chat and lightweight tool calls.',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 131_072 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false
    }
  },
  'openai/gpt-oss-120b': {
    displayName: 'GPT-OSS 120B',
    description:
      'Open-weight 120B reasoning model on Groq supporting tool calling and structured outputs.',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 65_536 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    }
  },
  'openai/gpt-oss-20b': {
    displayName: 'GPT-OSS 20B',
    description:
      'Fast 20B open-weight model on Groq supporting tool calling and structured outputs.',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 65_536 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    }
  },
  'qwen/qwen3-32b': {
    displayName: 'Qwen3 32B',
    description: 'Qwen 3 32B model on Groq with strong multilingual reasoning and tool support.',
    availability: 'preview',
    contextWindow: { inputTokens: 131_072, outputTokens: 40_960 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: false
    }
  },
  'moonshotai/kimi-k2-instruct-0905': {
    displayName: 'Kimi K2 Instruct (0905)',
    description:
      'Moonshot AI Kimi K2 model on Groq with 256K context, tool use, and strict structured JSON outputs.',
    availability: 'stable',
    contextWindow: { inputTokens: 262_144, outputTokens: 16_384 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: false,
      structuredOutput: true
    }
  },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    displayName: 'Llama 4 Scout 17B',
    description: 'Multimodal Llama 4 Scout preview model on Groq with vision and tool support.',
    availability: 'preview',
    contextWindow: { inputTokens: 131_072, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }
  },
  'meta-llama/llama-4-maverick-17b-128e-instruct': {
    displayName: 'Llama 4 Maverick 17B',
    description: 'Multimodal Llama 4 Maverick preview model on Groq with vision and tool support.',
    availability: 'preview',
    contextWindow: { inputTokens: 131_072, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: true,
      imageInput: true,
      structuredOutput: true
    }
  },
  'groq/compound': {
    displayName: 'Groq Compound',
    description: 'Groq agentic compound system (standard user tool definitions are not supported).',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: false,
      imageInput: false,
      structuredOutput: false
    }
  },
  'groq/compound-mini': {
    displayName: 'Groq Compound Mini',
    description:
      'Lightweight Groq agentic compound system (standard user tool definitions are not supported).',
    availability: 'stable',
    contextWindow: { inputTokens: 131_072, outputTokens: 8_192 },
    providerCapabilities: {
      streaming: true,
      tools: false,
      imageInput: false,
      structuredOutput: false
    }
  }
}

const CONSERVATIVE_UNKNOWN_GROQ_CAPABILITIES: ProviderNativeCapabilities = {
  streaming: true,
  tools: false,
  imageInput: false,
  structuredOutput: false
}

const NON_CHAT_GROQ_MODEL_PATTERNS: readonly RegExp[] = [
  /\bwhisper\b/i,
  /^whisper-/i,
  /distil-whisper/i,
  /\bplayai-tts\b/i,
  /\borpheus\b/i,
  /-tts(?:-|$)/i,
  /llama-prompt-guard/i,
  /llama-guard/i
]

/**
 * Returns true if the Groq model ID represents an audio/TTS/safety-guard model
 * rather than a general conversational text generation model.
 */
export function isNonChatGroqModel(modelId: string): boolean {
  const normalized = modelId.trim()
  if (normalized.length === 0) {
    return true
  }
  return NON_CHAT_GROQ_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))
}

function formatFallbackDisplayName(modelId: string): string {
  const tail = modelId.includes('/') ? (modelId.split('/').pop() ?? modelId) : modelId
  return tail
    .split(/[-_]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (/^\d+(?:\.\d+)?[bm]?$/i.test(segment)) {
        return segment.toUpperCase()
      }
      return segment.charAt(0).toUpperCase() + segment.slice(1)
    })
    .join(' ')
}

function resolveSafeContextWindow(
  entry: GroqApiModelEntry,
  curated?: CuratedGroqModelProfile
): ContextWindowMetadata {
  const rawInput =
    typeof entry.context_window === 'number' &&
    Number.isFinite(entry.context_window) &&
    entry.context_window >= 1024
      ? Math.floor(entry.context_window)
      : (curated?.contextWindow.inputTokens ?? 32_768)

  const rawOutput =
    typeof entry.max_completion_tokens === 'number' &&
    Number.isFinite(entry.max_completion_tokens) &&
    entry.max_completion_tokens >= 256
      ? Math.min(Math.floor(entry.max_completion_tokens), rawInput)
      : Math.min(curated?.contextWindow.outputTokens ?? 8_192, rawInput)

  return {
    inputTokens: rawInput,
    outputTokens: rawOutput
  }
}

/**
 * Builds a validated ModelDescriptor from a Groq `/openai/v1/models` entry.
 * Uses authoritative curated capabilities when known and conservative defaults otherwise.
 */
export function buildGroqModelDescriptorFromApi(entry: GroqApiModelEntry): ModelDescriptor {
  const curated = GROQ_CURATED_MODEL_PROFILES[entry.id]
  const providerCapabilities = curated
    ? { ...curated.providerCapabilities }
    : { ...CONSERVATIVE_UNKNOWN_GROQ_CAPABILITIES }

  const applicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
  const capabilities = computeEffectiveCapabilities(providerCapabilities, applicationCapabilities)

  const availability: ModelAvailability =
    entry.active === false ? 'deprecated' : (curated?.availability ?? 'stable')

  return {
    id: entry.id,
    providerId: 'groq',
    displayName: curated?.displayName ?? formatFallbackDisplayName(entry.id),
    description:
      curated?.description ??
      `Dynamically discovered Groq model${entry.owned_by ? ` (${entry.owned_by})` : ''}.`,
    availability,
    contextWindow: resolveSafeContextWindow(entry, curated),
    providerCapabilities,
    applicationCapabilities,
    capabilities,
    docUrl: GROQ_DOCS_MODELS_URL
  }
}
