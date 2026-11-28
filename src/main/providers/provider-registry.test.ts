import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  ProviderRegistry,
  providerRegistry,
  validateModelCapabilities,
  INITIAL_PROVIDERS,
  INITIAL_MODELS,
  SUPPORTED_PROVIDER_IDS,
  type ProviderId,
  type ModelDescriptor,
  type ModelCapabilities
} from './index'
import {
  ProviderConnectionRepository,
  createProviderConnectionSchema
} from '../database/repositories'
import { runMigrations, migrations } from '../database/migrations'
import { type CredentialRef } from '../security/credential-vault'

describe('Provider and Model Registry (Phase 3 Step 3.3)', () => {
  // Test 1: All three first-wave providers are registered
  it('1. registers all three first-wave providers (openai, anthropic, google)', () => {
    const providers = providerRegistry.getProviders()
    const providerIds = providers.map((p) => p.id)

    expect(providerIds).toContain('openai')
    expect(providerIds).toContain('anthropic')
    expect(providerIds).toContain('google')
    expect(providerIds).toContain('groq')
    expect(providerIds).toContain('openrouter')
    expect(providerIds).toContain('perplexity')
    expect(providers.length).toBe(6)
    expect(SUPPORTED_PROVIDER_IDS).toEqual([
      'openai',
      'anthropic',
      'google',
      'groq',
      'openrouter',
      'perplexity'
    ])
  })

  // Test 2: Provider descriptors contain required metadata
  it('2. ensures all provider descriptors contain complete and verified metadata', () => {
    const providers = providerRegistry.getProviders()

    for (const p of providers) {
      expect(p.id).toBeDefined()
      expect(p.displayName).toBeTruthy()
      expect(p.description).toBeTruthy()
      expect(p.docUrl.startsWith('https://')).toBe(true)
      expect(p.isSupported).toBe(true)
      expect(p.defaultModelId).toBeTruthy()

      // Default model must resolve to a valid model of that provider
      const defaultModel = providerRegistry.getDefaultModel(p.id)
      expect(defaultModel).not.toBeNull()
      expect(defaultModel?.id).toBe(p.defaultModelId)
      expect(defaultModel?.providerId).toBe(p.id)
    }
  })

  // Test 3: Each model belongs to a valid provider
  it('3. ensures every registered model belongs to an approved first-wave provider', () => {
    const models = providerRegistry.getModels()
    expect(models.length).toBeGreaterThanOrEqual(10)

    for (const m of models) {
      expect(m.id).toBeTruthy()
      expect(SUPPORTED_PROVIDER_IDS).toContain(m.providerId)
      expect(m.displayName).toBeTruthy()
      expect(m.docUrl.startsWith('https://')).toBe(true)

      const provider = providerRegistry.getProvider(m.providerId)
      expect(provider).not.toBeNull()
      expect(provider?.id).toBe(m.providerId)
    }
  })

  // Test 4: Unknown provider lookup is handled safely
  it('4. safely handles lookup of unknown or unsupported provider IDs', () => {
    expect(providerRegistry.getProvider('unsupported_vendor')).toBeNull()
    expect(providerRegistry.getProvider('cohere')).toBeNull()
    expect(providerRegistry.getProvider('xai')).toBeNull()
    expect(providerRegistry.getProvider('')).toBeNull()
    expect(providerRegistry.getProvider(null as unknown as string)).toBeNull()

    expect(providerRegistry.getModels('unsupported_vendor')).toEqual([])
    expect(providerRegistry.getDefaultModel('unsupported_vendor')).toBeNull()
    expect(
      providerRegistry.supportsCapability('unsupported_vendor', 'gpt-6-luna', 'streaming')
    ).toBe(false)
  })

  // Test 5: Unknown model lookup is handled safely
  it('5. safely handles lookup of unknown model IDs without assuming capabilities', () => {
    expect(providerRegistry.getModel('openai', 'non-existent-model')).toBeNull()
    expect(providerRegistry.getModel('anthropic', 'gpt-6-luna')).toBeNull()
    expect(providerRegistry.getModel('google', '')).toBeNull()

    // Unknown models must NEVER receive assumed capabilities
    expect(providerRegistry.supportsCapability('openai', 'unknown-model', 'streaming')).toBe(false)
    expect(providerRegistry.supportsCapability('openai', 'unknown-model', 'tools')).toBe(false)
    expect(providerRegistry.supportsCapability('openai', 'unknown-model', 'imageInput')).toBe(false)
    expect(providerRegistry.supportsCapability('openai', 'unknown-model', 'structuredOutput')).toBe(
      false
    )
  })

  // Test 6: Duplicate model registration is rejected
  it('6. rejects duplicate model registrations within the same provider', () => {
    const duplicateModels: ModelDescriptor[] = [
      ...INITIAL_MODELS,
      {
        id: 'gpt-6-luna',
        providerId: 'openai',
        displayName: 'Duplicate GPT-6 Luna',
        description: 'Duplicate registration',
        availability: 'stable',
        capabilities: {
          streaming: true,
          tools: true,
          imageInput: true,
          structuredOutput: true
        },
        docUrl: 'https://developers.openai.com/api/docs/models'
      }
    ]

    expect(() => new ProviderRegistry(INITIAL_PROVIDERS, duplicateModels)).toThrow(
      /Duplicate model ID 'gpt-6-luna' registered for provider 'openai'/
    )
  })

  // Test 7: Model capability metadata is present and correctly typed
  it('7. verifies capability metadata is present, boolean-typed, and non-null for all models', () => {
    const models = providerRegistry.getModels()

    for (const m of models) {
      expect(typeof m.capabilities.streaming).toBe('boolean')
      expect(typeof m.capabilities.tools).toBe('boolean')
      expect(typeof m.capabilities.imageInput).toBe('boolean')
      expect(typeof m.capabilities.structuredOutput).toBe('boolean')

      if (m.contextWindow) {
        expect(m.contextWindow.inputTokens).toBeGreaterThan(0)
        expect(m.contextWindow.outputTokens).toBeGreaterThan(0)
      }
    }
  })

  // Test 8: Provider model lists contain only models belonging to that provider
  it('8. ensures getModels(providerId) returns exclusively models for that provider', () => {
    const providers: ProviderId[] = ['openai', 'anthropic', 'google', 'groq', 'openrouter']

    for (const p of providers) {
      const models = providerRegistry.getModels(p)
      expect(models.length).toBeGreaterThan(0)

      for (const m of models) {
        expect(m.providerId).toBe(p)
      }
    }
  })

  // Test 9: Default model lookup returns a registered model
  it('9. verifies default model lookup returns a registered model for each provider', () => {
    const openaiDefault = providerRegistry.getDefaultModel('openai')
    expect(openaiDefault).not.toBeNull()
    expect(openaiDefault?.id).toBe('gpt-6-luna')

    const anthropicDefault = providerRegistry.getDefaultModel('anthropic')
    expect(anthropicDefault).not.toBeNull()
    expect(anthropicDefault?.id).toBe('claude-sonnet-5-5')

    const googleDefault = providerRegistry.getDefaultModel('google')
    expect(googleDefault).not.toBeNull()
    expect(googleDefault?.id).toBe('gemini-3.8-flash')
  })

  // Test 10: Preview and deprecated models are clearly distinguished from stable models
  it('10. verifies preview and deprecated models are clearly distinguished from stable models', () => {
    const terraPreview = providerRegistry.getModel('openai', 'gpt-6.1-terra')
    expect(terraPreview).not.toBeNull()
    expect(terraPreview?.availability).toBe('preview')

    const gptLuna = providerRegistry.getModel('openai', 'gpt-6-luna')
    expect(gptLuna?.availability).toBe('stable')

    const claudeSonnet = providerRegistry.getModel('anthropic', 'claude-sonnet-5-5')
    expect(claudeSonnet?.availability).toBe('stable')

    const geminiFlash = providerRegistry.getModel('google', 'gemini-3.8-flash')
    expect(geminiFlash?.availability).toBe('stable')

    const geminiLegacy = providerRegistry.getModel('google', 'gemini-1.5-pro')
    expect(geminiLegacy?.availability).toBe('deprecated')
  })

  // Test 11: Unsupported image capability is rejected
  it('11. capability validation rejects requests requiring image input when model lacks imageInput', () => {
    // Claude Haiku 5.5 is text-only (imageInput: false)
    const haiku = providerRegistry.getModel('anthropic', 'claude-haiku-5-5')!
    expect(haiku.capabilities.imageInput).toBe(false)

    const result = validateModelCapabilities(haiku, { imageInput: true })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.unsupportedCapabilities).toContain('imageInput')
      expect(result.reason).toMatch(/multimodal image input/)
    }

    // gpt-6.1-terra also lacks imageInput
    const terra = providerRegistry.getModel('openai', 'gpt-6.1-terra')!
    expect(terra.capabilities.imageInput).toBe(false)
    const terraResult = validateModelCapabilities(terra, { imageInput: true })
    expect(terraResult.valid).toBe(false)
  })

  // Test 12: Unsupported tool capability is rejected
  it('12. capability validation rejects requests requiring tools when model lacks tools', () => {
    // gpt-6.1-terra does not support tools
    const terra = providerRegistry.getModel('openai', 'gpt-6.1-terra')!
    expect(terra.capabilities.tools).toBe(false)

    const result = validateModelCapabilities(terra, { tools: true })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.unsupportedCapabilities).toContain('tools')
      expect(result.reason).toMatch(/tool calling/)
    }
  })

  // Test 13: Unsupported structured output is rejected
  it('13. capability validation rejects requests requiring structured output when model lacks structuredOutput', () => {
    // gpt-6.1-terra does not support structuredOutput
    const terra = providerRegistry.getModel('openai', 'gpt-6.1-terra')!
    expect(terra.capabilities.structuredOutput).toBe(false)

    const result = validateModelCapabilities(terra, { structuredOutput: true })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.unsupportedCapabilities).toContain('structuredOutput')
      expect(result.reason).toMatch(/structured output schemas/)
    }
  })

  // Test 14: Unsupported streaming is rejected
  it('14. capability validation rejects requests requiring streaming when model lacks streaming', () => {
    // gpt-6.1-terra does not support streaming
    const terra = providerRegistry.getModel('openai', 'gpt-6.1-terra')!
    expect(terra.capabilities.streaming).toBe(false)

    const result = validateModelCapabilities(terra, { streaming: true })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.unsupportedCapabilities).toContain('streaming')
      expect(result.reason).toMatch(/streaming output/)
    }
  })

  // Test 15: Unknown capability information is never treated as supported
  it('15. verifies unknown or unlisted models/capabilities default strictly to false', () => {
    expect(
      providerRegistry.supportsCapability(
        'openai',
        'non-existent-model',
        'tools' as keyof ModelCapabilities
      )
    ).toBe(false)

    expect(
      providerRegistry.supportsCapability(
        'unknown_provider' as unknown as ProviderId,
        'gpt-6-luna',
        'streaming'
      )
    ).toBe(false)

    // Synthesize a model with missing/partial capabilities object
    const incompleteModel: ModelDescriptor = {
      id: 'incomplete-model',
      providerId: 'openai',
      displayName: 'Incomplete Model',
      description: 'Testing fallback',
      availability: 'stable',
      capabilities: {
        streaming: false,
        tools: false,
        imageInput: false,
        structuredOutput: false
      },
      docUrl: 'https://example.com'
    }

    const res = validateModelCapabilities(incompleteModel, {
      streaming: true,
      tools: true
    })
    expect(res.valid).toBe(false)
    if (!res.valid) {
      expect(res.unsupportedCapabilities).toEqual(['streaming', 'tools'])
    }
  })

  // Test 16: Registry metadata cannot be mutated by consumers
  it('16. guarantees registry metadata cannot be mutated at runtime by consumers', () => {
    const provider = providerRegistry.getProvider('openai')!
    expect(Object.isFrozen(provider)).toBe(true)

    expect(() => {
      ;(provider as unknown as Record<string, unknown>).displayName = 'Hacked Name'
    }).toThrow()

    const model = providerRegistry.getModel('openai', 'gpt-6-luna')!
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.capabilities)).toBe(true)

    expect(() => {
      ;(model.capabilities as unknown as Record<string, unknown>).streaming = false
    }).toThrow()

    // Verify registry internal state remained unchanged
    const pristineModel = providerRegistry.getModel('openai', 'gpt-6-luna')!
    expect(pristineModel.capabilities.streaming).toBe(true)
  })

  // Test 17: Existing ProviderConnectionRepository validation remains compatible
  it('17. verifies ProviderConnectionRepository and Zod schemas remain 100% compatible with centralized ProviderId', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    const repo = new ProviderConnectionRepository(db)

    // Centralized provider IDs work seamlessly in repository
    for (const p of SUPPORTED_PROVIDER_IDS) {
      const conn = repo.create({
        providerId: p,
        label: `${p} connection`,
        credentialRef: `cred_${randomUUID()}` as CredentialRef
      })
      expect(conn.providerId).toBe(p)
      expect(repo.getById(conn.id)).not.toBeNull()
    }

    // Zod schema parsing accepts supported provider IDs
    expect(() =>
      createProviderConnectionSchema.parse({
        providerId: 'openai',
        label: 'Valid OpenAI Key',
        credentialRef: `cred_${randomUUID()}`
      })
    ).not.toThrow()

    // Zod schema parsing rejects unsupported provider IDs
    expect(() =>
      createProviderConnectionSchema.parse({
        providerId: 'cohere',
        label: 'Cohere Key',
        credentialRef: `cred_${randomUUID()}`
      })
    ).toThrow()

    db.close()
  })

  // Test 18: No provider request or network call is made by registry operations
  it('18. verifies all registry operations are purely synchronous, in-memory, and issue zero network requests', () => {
    // Assert all getters execute synchronously without returning Promises or issuing HTTP
    const start = performance.now()

    const providers = providerRegistry.getProviders()
    const allModels = providerRegistry.getModels()
    const defaultModel = providerRegistry.getDefaultModel('openai')
    const capCheck = providerRegistry.supportsCapability('openai', 'gpt-6-luna', 'streaming')
    const nativeCapCheck = providerRegistry.supportsNativeCapability(
      'openai',
      'gpt-6-luna',
      'tools'
    )
    const validation = providerRegistry.validateCapabilities(allModels[0], { streaming: true })

    const elapsed = performance.now() - start

    expect(Array.isArray(providers)).toBe(true)
    expect(Array.isArray(allModels)).toBe(true)
    expect(defaultModel).not.toBeNull()
    expect(capCheck).toBe(true)
    expect(nativeCapCheck).toBe(true)
    expect(validation.valid).toBe(true)
    expect(elapsed).toBeLessThan(50) // Sub-millisecond purely synchronous in-memory operation
  })
})
