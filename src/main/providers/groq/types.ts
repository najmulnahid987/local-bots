/**
 * Configuration constants and wire types for Groq API provider adapter.
 * Uses direct HTTPS connections to the official Groq OpenAI-compatible endpoint.
 */

export const GROQ_OFFICIAL_BASE_URL = 'https://api.groq.com/openai/v1'

export const GROQ_DEFAULT_TEST_MODEL = 'llama-3.1-8b-instant'

export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000

export const DEFAULT_GENERATION_TIMEOUT_MS = 120_000

export interface GroqAdapterOptions {
  /** Custom base URL (restricted to HTTPS; defaults to official Groq endpoint). */
  readonly baseURL?: string
  /** Custom fetch function for testing and controlled networking. */
  readonly fetchFn?: typeof fetch
  /** Connection test timeout in milliseconds. Defaults to 15000ms. */
  readonly connectionTestTimeoutMs?: number
  /** Generation and streaming timeout in milliseconds. Defaults to 120000ms. */
  readonly generationTimeoutMs?: number
}

export interface GroqApiModelEntry {
  readonly id: string
  readonly object?: string
  readonly created?: number
  readonly owned_by?: string
  readonly active?: boolean
  readonly context_window?: number
  readonly max_completion_tokens?: number | null
  readonly public_apps?: unknown
}

export interface GroqModelsListResponse {
  readonly object?: string
  readonly data?: readonly GroqApiModelEntry[]
}
