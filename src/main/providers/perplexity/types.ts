export const PERPLEXITY_OFFICIAL_BASE_URL = 'https://api.perplexity.ai'
export const PERPLEXITY_DEFAULT_TEST_MODEL = 'perplexity/sonar'

export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000
export const DEFAULT_GENERATION_TIMEOUT_MS = 90_000

export type PerplexityCatalogKind = 'direct_model' | 'agent_preset' | 'third_party_routed'

export interface PerplexityAdapterOptions {
  /** Must remain official https://api.perplexity.ai in production; tests may inject mock fetch or local HTTPS stub URL. */
  readonly baseURL?: string
  readonly fetch?: typeof fetch
  readonly testTimeoutMs?: number
  readonly generationTimeoutMs?: number
  /** Controls whether Chat mode enables Perplexity's native `web_search` tool (defaults to true). */
  readonly enableNativeWebSearchInChat?: boolean
}
