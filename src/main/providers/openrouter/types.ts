import { z } from 'zod'
import { OPENROUTER_ROUTING_SORTS } from '../../../shared/providers'

export const OPENROUTER_OFFICIAL_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_DOCS_MODELS_URL = 'https://openrouter.ai/models'
export const OPENROUTER_DEFAULT_TEST_MODEL = 'openrouter/auto'

export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000
export const DEFAULT_GENERATION_TIMEOUT_MS = 120_000

export interface OpenRouterAdapterOptions {
  readonly baseURL?: string
  readonly fetchFn?: typeof fetch
  readonly connectionTestTimeoutMs?: number
  readonly discoveryTimeoutMs?: number
  readonly generationTimeoutMs?: number
}

export const SAFE_OPENROUTER_MODEL_ID_REGEX = /^[a-zA-Z0-9._:/-]+$/

export const openRouterRoutingSchema = z
  .object({
    sort: z.enum(OPENROUTER_ROUTING_SORTS).optional(),
    allowFallbacks: z.boolean().optional(),
    zdr: z.boolean().optional()
  })
  .strict()

export const openRouterAuthKeyResponseSchema = z.object({
  data: z
    .object({
      label: z.string().nullable().optional(),
      usage: z.number().optional(),
      limit: z.number().nullable().optional(),
      is_free_tier: z.boolean().optional(),
      rate_limit: z
        .object({
          requests: z.number().optional(),
          interval: z.string().optional()
        })
        .optional()
    })
    .passthrough()
})

export const openRouterPricingSchema = z
  .object({
    prompt: z.union([z.string(), z.number()]).optional(),
    completion: z.union([z.string(), z.number()]).optional(),
    request: z.union([z.string(), z.number()]).optional(),
    image: z.union([z.string(), z.number()]).optional()
  })
  .passthrough()

export const openRouterArchitectureSchema = z
  .object({
    modality: z.string().nullable().optional(),
    input_modalities: z.array(z.string()).nullable().optional(),
    output_modalities: z.array(z.string()).nullable().optional(),
    tokenizer: z.string().nullable().optional(),
    instruct_type: z.string().nullable().optional()
  })
  .passthrough()

export const openRouterTopProviderSchema = z
  .object({
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
    is_moderated: z.boolean().optional()
  })
  .passthrough()

export const openRouterRawModelSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => SAFE_OPENROUTER_MODEL_ID_REGEX.test(v) && !v.includes('..'), {
        message: 'Invalid OpenRouter model ID characters'
      }),
    canonical_slug: z.string().optional(),
    name: z.string().optional(),
    created: z.number().optional(),
    description: z.string().nullable().optional(),
    context_length: z.number().nullable().optional(),
    architecture: openRouterArchitectureSchema.nullable().optional(),
    pricing: openRouterPricingSchema.nullable().optional(),
    top_provider: openRouterTopProviderSchema.nullable().optional(),
    supported_parameters: z.array(z.string()).nullable().optional()
  })
  .passthrough()

export const openRouterModelsResponseSchema = z.object({
  data: z.array(z.unknown())
})

export type OpenRouterRawModelEntry = z.infer<typeof openRouterRawModelSchema>
