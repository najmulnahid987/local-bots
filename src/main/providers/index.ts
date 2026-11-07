export * from './types'
export * from './model-catalog'
export * from './capability-validator'
export * from './provider-registry'

// Namespace exports for individual providers
export * as openai from './openai'
export * as anthropic from './anthropic'
export * as google from './google'

// Direct provider adapters and configuration
export {
  OpenAIAdapter,
  OPENAI_OFFICIAL_BASE_URL,
  type OpenAIAdapterOptions,
  sanitizeOpenAIError
} from './openai'

export {
  AnthropicAdapter,
  ANTHROPIC_OFFICIAL_BASE_URL,
  ANTHROPIC_DEFAULT_VERSION,
  type AnthropicAdapterOptions,
  sanitizeAnthropicError
} from './anthropic'

export {
  GoogleAdapter,
  GOOGLE_OFFICIAL_BASE_URL,
  type GoogleAdapterOptions,
  sanitizeGoogleError
} from './google'
