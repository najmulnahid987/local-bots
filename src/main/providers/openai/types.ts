/**
 * Official, fixed OpenAI base URL.
 * Never overridable by user input or environment variables.
 */
export const OPENAI_OFFICIAL_BASE_URL = 'https://api.openai.com/v1'

/**
 * Default timeout for connection testing in milliseconds.
 */
export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15000

/**
 * Default timeout for text generation in milliseconds.
 */
export const DEFAULT_GENERATION_TIMEOUT_MS = 120000

/**
 * Options for configuring the OpenAIAdapter instance.
 */
export interface OpenAIAdapterOptions {
  /**
   * Optional custom fetch implementation (primarily for dependency injection in unit tests).
   * When omitted, the global runtime fetch is used.
   */
  readonly customFetch?: typeof fetch

  /**
   * Optional connection test timeout in milliseconds.
   */
  readonly connectionTestTimeoutMs?: number

  /**
   * Optional generation timeout in milliseconds.
   */
  readonly generationTimeoutMs?: number
}
