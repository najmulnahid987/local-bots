/**
 * Supported first-wave provider IDs for application-level operations in Phase 3.
 */
export const SUPPORTED_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'perplexity'
] as const
export type ProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number]

/**
 * Type guard for verifying whether an unknown string matches a supported ProviderId.
 */
export function isValidProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Model lifecycle and availability classification.
 */
export type ModelAvailability = 'stable' | 'preview' | 'deprecated'

import type { z } from 'zod'

import {
  type ProviderNativeCapabilities,
  type ApplicationCapabilities,
  type ModelPricingDto,
  type OpenRouterRoutingPreferences,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
} from '../../shared/providers'

export {
  type ProviderNativeCapabilities,
  type ApplicationCapabilities,
  type ModelPricingDto,
  type OpenRouterRoutingPreferences,
  CURRENT_APPLICATION_CAPABILITIES,
  computeEffectiveCapabilities
}

/**
 * Model capability flags (effective capabilities executable by the application).
 * Each capability must be explicitly evaluated based on model support and application readiness.
 * Unknown or unsupported capabilities must never silently default to true.
 */
export interface ModelCapabilities {
  readonly streaming: boolean
  readonly tools: boolean
  readonly imageInput: boolean
  readonly structuredOutput: boolean
}

/**
 * Verified context window token limits.
 */
export interface ContextWindowMetadata {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * Authoritative metadata descriptor for an AI model.
 */
export interface ModelDescriptor {
  readonly id: string
  readonly providerId: ProviderId
  readonly displayName: string
  readonly description: string
  readonly availability: ModelAvailability
  readonly canonicalSlug?: string
  readonly contextWindow?: ContextWindowMetadata
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
  readonly supportedParameters?: readonly string[]
  readonly pricing?: ModelPricingDto
  readonly metadataSource?: 'catalog' | 'user_models' | 'public_catalog'
  readonly providerCapabilities?: ProviderNativeCapabilities
  readonly applicationCapabilities?: ApplicationCapabilities
  readonly capabilities: ModelCapabilities
  readonly docUrl: string
}

/**
 * Authoritative metadata descriptor for an AI provider.
 */
export interface ProviderDescriptor {
  readonly id: ProviderId
  readonly displayName: string
  readonly description: string
  readonly docUrl: string
  readonly isSupported: boolean
  readonly defaultModelId: string
}

/**
 * Capabilities requested by a client or workflow for validation before request execution.
 */
export interface RequestedCapabilities {
  readonly streaming?: boolean
  readonly tools?: boolean
  readonly imageInput?: boolean
  readonly structuredOutput?: boolean
}

/**
 * Result of capability validation against a model descriptor.
 */
export type CapabilityValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false
      readonly reason: string
      readonly unsupportedCapabilities: ReadonlyArray<keyof ModelCapabilities>
    }

/**
 * Error classifications for provider communication and adapter operations.
 */
export type ProviderErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'SERVER_ERROR'
  | 'UNSUPPORTED_CAPABILITY'
  | 'OPERATION_ABORTED'
  | 'UNKNOWN_ERROR'

/**
 * Sanitized, provider-independent error structure.
 * Guaranteed never to contain plaintext API keys, secret tokens, or sensitive headers.
 */
export interface ProviderError {
  readonly code: ProviderErrorCode
  readonly message: string
  readonly statusCode?: number
  readonly retryable: boolean
  readonly details?: string
}

/**
 * Standard Error class wrapping a sanitized, typed ProviderError.
 */
export class ProviderAdapterError extends Error {
  readonly error: ProviderError

  constructor(error: ProviderError) {
    super(error.message)
    this.name = 'ProviderAdapterError'
    this.error = error
    Object.setPrototypeOf(this, ProviderAdapterError.prototype)
  }
}

/**
 * Unified multimodal message content part.
 */
export type MessageContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      readonly data: string
    }

/**
 * Unified chat message structure across all providers.
 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | ReadonlyArray<MessageContentPart>
  readonly name?: string
  readonly toolCallId?: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
}

/**
 * Tool parameter schema following JSON Schema subset approved for LLM function calling
 * or a raw Zod schema.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown> | z.ZodTypeAny
}

/**
 * Model-generated tool call invocation.
 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/**
 * Execution result of a tool invocation returned to the model.
 */
export interface ToolResult {
  readonly toolCallId: string
  readonly result: unknown
  readonly isError?: boolean
}

/**
 * Options for single-turn or multi-turn text generation.
 */
export interface GenerateTextOptions {
  readonly modelId: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly systemPrompt?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly jsonSchema?: Record<string, unknown>
  readonly openrouterRouting?: OpenRouterRoutingPreferences
  /** Internal Main-process connection scope for resolving dynamically discovered models. Never accepted from IPC. */
  readonly connectionId?: string
  readonly abortSignal?: AbortSignal
}

/**
 * Token usage accounting.
 */
export interface TokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/**
 * Verified external web source reported by a provider (strictly distinct from KB citations).
 */
export interface ProviderWebSource {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly snippet?: string
  readonly publishedDate?: string
  readonly lastUpdated?: string
  readonly sourceType?: 'web' | 'search'
  readonly originLabel?: string
}

/**
 * Optional provider-reported financial cost breakdown metadata.
 */
export interface ProviderCostMetadata {
  readonly inputTokensCost?: number | null
  readonly outputTokensCost?: number | null
  readonly totalCost?: number | null
  readonly toolCallsCost?: number | null
  readonly currency?: string | null
}

/**
 * Result of a non-streaming text generation request.
 */
export interface GenerateTextResult {
  readonly text: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly usage: TokenUsage
  readonly webSources?: ReadonlyArray<ProviderWebSource>
  readonly providerCost?: ProviderCostMetadata
}

/**
 * Event chunks emitted during a streaming generation request.
 */
export type StreamTextChunk =
  | { readonly type: 'text-delta'; readonly textDelta: string }
  | { readonly type: 'source'; readonly source: ProviderWebSource }
  | {
      readonly type: 'tool-call-delta'
      readonly toolCallId: string
      readonly toolName?: string
      readonly argsDelta: string
    }
  | { readonly type: 'tool-call'; readonly toolCall: ToolCall }
  | {
      readonly type: 'finish'
      readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
      readonly usage?: TokenUsage
      readonly webSources?: ReadonlyArray<ProviderWebSource>
      readonly providerCost?: ProviderCostMetadata
    }
  | { readonly type: 'error'; readonly error: ProviderError }

/**
 * Result of connection testing during BYOK setup or verification.
 */
export interface ConnectionTestResult {
  readonly success: boolean
  readonly latencyMs: number
  readonly testedModelId: string
  readonly error?: ProviderError
  readonly availableModels?: readonly string[]
  readonly discoveredModels?: ReadonlyArray<ModelDescriptor>
}

/**
 * Provider-independent adapter interface for future model execution services.
 * Real adapter classes will implement this contract in Step 3.4+.
 */
export interface ProviderAdapter {
  readonly providerId: ProviderId
  testConnection(
    apiKey: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<ConnectionTestResult>
  generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult>
  streamText(apiKey: string, options: GenerateTextOptions): AsyncIterable<StreamTextChunk>
  discoverAvailableModels?(apiKey: string, signal?: AbortSignal): Promise<readonly string[]>
  discoverModelMetadata?(
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<ModelDescriptor>>
}
