/**
 * Shared provider types, DTOs, and interface contracts.
 * Strictly independent of Electron, Node.js, and Main-process persistence models.
 * Safe for import in Preload and Renderer codebases.
 */

export const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'google', 'xai', 'openrouter'] as const
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number]

export const FIRST_WAVE_PROVIDERS = ['openai', 'anthropic', 'google'] as const
export type FirstWaveProviderId = (typeof FIRST_WAVE_PROVIDERS)[number]

export const PROVIDER_CONNECTION_STATUSES = ['active', 'revoked', 'error'] as const
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number]

/**
 * Model capabilities supported natively by the provider's underlying model.
 */
export interface ProviderNativeCapabilities {
  readonly streaming: boolean
  readonly tools: boolean
  readonly imageInput: boolean
  readonly structuredOutput: boolean
}

/**
 * Capabilities supported by the local application implementation in the current development phase.
 */
export interface ApplicationCapabilities {
  readonly streaming: boolean
  readonly tools: boolean
  readonly imageInput: boolean
  readonly structuredOutput: boolean
}

/**
 * Authoritative capability baseline supported by the current Phase 3 application runtime.
 * Text generation and streaming are operational; tool calling, image input, and structured output
 * schemas are deferred to later phases.
 */
export const CURRENT_APPLICATION_CAPABILITIES: Readonly<ApplicationCapabilities> = Object.freeze({
  streaming: true,
  tools: false,
  imageInput: false,
  structuredOutput: false
})

/**
 * Computes effective capabilities by intersecting provider native capabilities
 * with actual application runtime capabilities.
 */
export function computeEffectiveCapabilities(
  providerNative: ProviderNativeCapabilities,
  applicationSupported: ApplicationCapabilities = CURRENT_APPLICATION_CAPABILITIES
): ModelCapabilityDto {
  return {
    streaming: Boolean(providerNative.streaming && applicationSupported.streaming),
    tools: Boolean(providerNative.tools && applicationSupported.tools),
    imageInput: Boolean(providerNative.imageInput && applicationSupported.imageInput),
    structuredOutput: Boolean(
      providerNative.structuredOutput && applicationSupported.structuredOutput
    )
  }
}

/**
 * Public, safe representation of model capabilities for UI and client inspection.
 * Represents the effective capabilities currently executable by the application.
 */
export interface ModelCapabilityDto {
  readonly streaming: boolean
  readonly tools: boolean
  readonly imageInput: boolean
  readonly structuredOutput: boolean
}

/**
 * Public descriptor for a supported model.
 */
export interface ModelDescriptorDto {
  readonly id: string
  readonly providerId: ProviderId
  readonly displayName: string
  readonly description: string
  readonly availability: string
  readonly contextWindow?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
  readonly providerCapabilities?: ProviderNativeCapabilities
  readonly applicationCapabilities?: ApplicationCapabilities
  readonly capabilities: ModelCapabilityDto
  readonly docUrl: string
}

/**
 * Public descriptor for a supported AI provider.
 */
export interface ProviderDescriptorDto {
  readonly id: ProviderId
  readonly displayName: string
  readonly description: string
  readonly docUrl: string
  readonly isSupported: boolean
  readonly defaultModelId: string
}

/**
 * Catalog of available providers and authorized models.
 */
export interface ProviderCatalogDto {
  readonly providers: readonly ProviderDescriptorDto[]
  readonly models: readonly ModelDescriptorDto[]
}

/**
 * Safe connection summary returned to Renderer.
 * Guarantees zero leakage of plaintext keys, ciphertexts, or credential_ref pointers.
 */
export interface ProviderConnectionSummary {
  readonly id: string
  readonly providerId: ProviderId
  readonly label: string
  readonly status: ProviderConnectionStatus
  readonly hasCredential: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly availableModels?: readonly string[]
}

/**
 * Sanitized, safe error representation across IPC and streaming.
 */
export interface ProviderErrorDto {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/**
 * Result of testing a draft or saved connection.
 */
export interface ConnectionTestResult {
  readonly ok: boolean
  readonly success: boolean
  readonly latencyMs: number
  readonly testedModelId: string
  readonly error?: ProviderErrorDto
  readonly availableModels?: readonly string[]
}

/**
 * Result of removing a provider connection.
 */
export interface RemoveConnectionResult {
  readonly success: boolean
  readonly connectionId: string
  readonly credentialCleaned: boolean
}

/**
 * Token usage metadata.
 */
export interface ProviderTokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/**
 * Single text generation response.
 */
export interface GenerateTextResult {
  readonly text: string
  readonly finishReason: string
  readonly usage: ProviderTokenUsage
}

/**
 * Stream event delivered through the dedicated stream channel.
 */
export type ProviderStreamEvent =
  | { readonly type: 'text-delta'; readonly textDelta: string }
  | { readonly type: 'finish'; readonly finishReason: string; readonly usage: ProviderTokenUsage }
  | { readonly type: 'error'; readonly error: ProviderErrorDto }

/**
 * Handle returned to Renderer for managing an active stream session.
 */
export interface ProviderStreamHandle {
  cancel(): void
}

/**
 * Normalized chat message for text generation.
 */
export interface ChatMessageDto {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/**
 * Tool parameter definition DTO.
 */
export interface ToolDefinitionDto {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/**
 * Generation options for single text or streaming inference.
 */
export interface GenerateTextOptionsDto {
  readonly messages: readonly ChatMessageDto[]
  readonly systemPrompt?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
  readonly tools?: unknown
  readonly jsonSchema?: unknown
  readonly abortSignal?: AbortSignal
}

// ==========================================
// IPC Input Payloads
// ==========================================

export interface TestDraftConnectionInput {
  readonly providerId: ProviderId
  readonly apiKey: string
  readonly modelId?: string
}

export interface CreateProviderConnectionInput {
  readonly providerId: ProviderId
  readonly label: string
  readonly apiKey: string
  readonly modelId?: string
}

export interface TestProviderConnectionInput {
  readonly connectionId: string
  readonly modelId?: string
}

export interface UpdateConnectionLabelInput {
  readonly connectionId: string
  readonly label: string
}

export interface ReplaceCredentialInput {
  readonly connectionId: string
  readonly apiKey: string
  readonly modelId?: string
}

export interface RemoveProviderConnectionInput {
  readonly connectionId: string
}

export interface GenerateTextInput {
  readonly connectionId: string
  readonly modelId: string
  readonly options: GenerateTextOptionsDto
}

export interface StreamTextInput {
  readonly connectionId: string
  readonly modelId: string
  readonly options: GenerateTextOptionsDto
}

/**
 * Internal IPC payload for initiating a stream session with a request UUID.
 */
export interface StreamStartIpcPayload extends StreamTextInput {
  readonly streamId: string
}

// ==========================================
// Typed Bridge Interface (window.api.providers)
// ==========================================

export interface ProviderApi {
  getCatalog(): Promise<ProviderCatalogDto>
  listConnections(): Promise<readonly ProviderConnectionSummary[]>
  getAvailableModels(input: { connectionId: string }): Promise<readonly ModelDescriptorDto[]>
  testDraftConnection(input: TestDraftConnectionInput): Promise<ConnectionTestResult>
  createConnection(input: CreateProviderConnectionInput): Promise<ProviderConnectionSummary>
  testConnection(input: TestProviderConnectionInput): Promise<ConnectionTestResult>
  updateConnectionLabel(input: UpdateConnectionLabelInput): Promise<ProviderConnectionSummary>
  replaceCredential(input: ReplaceCredentialInput): Promise<ProviderConnectionSummary>
  removeConnection(input: RemoveProviderConnectionInput): Promise<RemoveConnectionResult>
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>
  streamText(
    input: StreamTextInput,
    onEvent: (event: ProviderStreamEvent) => void
  ): Promise<ProviderStreamHandle>
}

/**
 * Normalized error class instantiated in Renderer/Preload when bridge calls reject.
 */
export class ProviderBridgeError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, code = 'PROVIDER_ERROR', retryable = false) {
    super(message)
    this.name = 'ProviderBridgeError'
    this.code = code
    this.retryable = retryable
  }
}
