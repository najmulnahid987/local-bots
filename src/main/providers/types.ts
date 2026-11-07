/**
 * Supported first-wave provider IDs for application-level operations in Phase 3.
 */
export const SUPPORTED_PROVIDER_IDS = ['openai', 'anthropic', 'google'] as const
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

/**
 * Model capability flags.
 * Each capability must be explicitly declared per model based on verified documentation.
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
  readonly contextWindow?: ContextWindowMetadata
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
}

/**
 * Tool parameter schema following JSON Schema subset approved for LLM function calling.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
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
 * Result of a non-streaming text generation request.
 */
export interface GenerateTextResult {
  readonly text: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly usage: TokenUsage
}

/**
 * Event chunks emitted during a streaming generation request.
 */
export type StreamTextChunk =
  | { readonly type: 'text-delta'; readonly textDelta: string }
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
}
