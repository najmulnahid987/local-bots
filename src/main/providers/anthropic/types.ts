/**
 * Official, fixed Anthropic base URL.
 * Never overridable by user input or environment variables.
 */
export const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com/v1'

/**
 * Standard Anthropic API version header value.
 */
export const ANTHROPIC_DEFAULT_VERSION = '2023-06-01'

/**
 * Default timeout for connection testing in milliseconds.
 */
export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15000

/**
 * Default timeout for text generation in milliseconds.
 */
export const DEFAULT_GENERATION_TIMEOUT_MS = 120000

/**
 * Options for configuring the AnthropicAdapter instance.
 */
export interface AnthropicAdapterOptions {
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
