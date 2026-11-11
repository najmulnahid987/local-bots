import { describe, it, expect } from 'vitest'
import {
  validateModelCapabilities,
  validateBotModelCompatibility,
  assertBotModelCompatibility,
  type ProviderConnectionLookup
} from './capability-validator'
import { ProviderRegistry } from './provider-registry'
import { ProviderManagerError } from './provider-manager/errors'
import { type ProviderConnection } from '../database/repositories/types'

describe('Capability & Bot-Model Compatibility Validator (Step 6.1)', () => {
  const registry = new ProviderRegistry()

  const openAiConnectionId = '11111111-1111-4111-8111-111111111111'
  const anthropicConnectionId = '22222222-2222-4222-8222-222222222222'
  const googleConnectionId = '33333333-3333-4333-8333-333333333333'

  const mockConnections: Record<string, ProviderConnection> = {
    [openAiConnectionId]: {
      id: openAiConnectionId,
      providerId: 'openai',
      label: 'Main OpenAI Key',
      credentialRef:
        'cred_11111111-1111-4111-8111-111111111111' as unknown as import('../database/repositories/types').CredentialRef,
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    },
    [anthropicConnectionId]: {
      id: anthropicConnectionId,
      providerId: 'anthropic',
      label: 'Team Anthropic Key',
      credentialRef:
        'cred_22222222-2222-4222-8222-222222222222' as unknown as import('../database/repositories/types').CredentialRef,
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    },
    [googleConnectionId]: {
      id: googleConnectionId,
      providerId: 'google',
      label: 'Google Gemini Pro Key',
      credentialRef:
        'cred_33333333-3333-4333-8333-333333333333' as unknown as import('../database/repositories/types').CredentialRef,
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    }
  }

  const mockConnectionLookup: ProviderConnectionLookup = {
    getById: (id: string) => mockConnections[id] ?? null
  }

  describe('validateModelCapabilities', () => {
    it('1. validates model capabilities when all requested capabilities are supported', () => {
      const model = registry.getModel('openai', 'gpt-6-luna')!
      expect(model).toBeDefined()

      const result = validateModelCapabilities(model, { streaming: true })
      expect(result.valid).toBe(true)
    })

    it('2. returns failure when requested capability is unsupported by the model', () => {
      // In Phase 3, CURRENT_APPLICATION_CAPABILITIES sets tools: false
      const model = registry.getModel('openai', 'gpt-6-luna')!
      const result = validateModelCapabilities(model, { tools: true })
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.reason).toContain('does not support requested capability: tool calling')
        expect(result.unsupportedCapabilities).toContain('tools')
      }
    })
  })

  describe('validateBotModelCompatibility', () => {
    it('3. accepts a valid provider connection and model combination (OpenAI)', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: openAiConnectionId,
        modelId: 'gpt-6-luna',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(true)
      expect(result.providerId).toBe('openai')
      expect(result.model?.id).toBe('gpt-6-luna')
      expect(result.connection?.id).toBe(openAiConnectionId)
    })

    it('4. accepts a valid provider connection and model combination (Anthropic)', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: anthropicConnectionId,
        modelId: 'claude-sonnet-5-5',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(true)
      expect(result.providerId).toBe('anthropic')
      expect(result.model?.id).toBe('claude-sonnet-5-5')
    })

    it('5. accepts a valid provider connection and model combination (Google)', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: googleConnectionId,
        modelId: 'gemini-3.8-flash',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(true)
      expect(result.providerId).toBe('google')
      expect(result.model?.id).toBe('gemini-3.8-flash')
    })

    it('6. rejects when model belongs to another provider (cross-provider model mismatch)', () => {
      // OpenAI connection paired with Anthropic model
      const result = validateBotModelCompatibility({
        providerConnectionId: openAiConnectionId,
        modelId: 'claude-sonnet-5-5',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      expect(result.error?.message).toContain(
        "Model 'claude-sonnet-5-5' belongs to provider 'anthropic' and cannot be paired with a connection for provider 'openai'"
      )
    })

    it('7. rejects when Google connection is paired with OpenAI model', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: googleConnectionId,
        modelId: 'gpt-6.1-sol',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      expect(result.error?.message).toContain(
        "Model 'gpt-6.1-sol' belongs to provider 'openai' and cannot be paired with a connection for provider 'google'"
      )
    })

    it('8. rejects an unknown model ID that does not exist in any catalog', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: openAiConnectionId,
        modelId: 'nonexistent-model-xyz',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('MODEL_NOT_FOUND')
      expect(result.error?.message).toContain(
        "Model 'nonexistent-model-xyz' was not found in the catalog for provider 'openai'"
      )
    })

    it('9. rejects when provider connection does not exist in repository', () => {
      const missingId = '99999999-9999-4999-8999-999999999999'
      const result = validateBotModelCompatibility({
        providerConnectionId: missingId,
        modelId: 'gpt-6-luna',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('CONNECTION_NOT_FOUND')
      expect(result.error?.message).toContain(
        `Referenced provider connection with ID '${missingId}' does not exist.`
      )
    })

    it('10. rejects an invalid provider connection ID that is not a UUIDv4', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: 'not-a-valid-uuid',
        modelId: 'gpt-6-luna',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
      expect(result.error?.message).toContain('Must be a valid UUIDv4 string')
    })

    it('11. rejects when connectionRepo is missing but providerConnectionId is specified', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: openAiConnectionId,
        modelId: 'gpt-6-luna',
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
      expect(result.error?.message).toContain('Connection repository lookup is required')
    })

    it('12. rejects empty or whitespace-only model ID', () => {
      const resultEmpty = validateBotModelCompatibility({
        modelId: ''
      })
      expect(resultEmpty.valid).toBe(false)
      expect(resultEmpty.error?.code).toBe('VALIDATION_ERROR')

      const resultWhitespace = validateBotModelCompatibility({
        modelId: '   '
      })
      expect(resultWhitespace.valid).toBe(false)
      expect(resultWhitespace.error?.code).toBe('VALIDATION_ERROR')
    })

    it('13. correctly handles absent provider connection with a recognized model', () => {
      // Draft Bot scenario: providerConnectionId is null or undefined
      const resultNull = validateBotModelCompatibility({
        providerConnectionId: null,
        modelId: 'gpt-6-luna',
        registry
      })

      expect(resultNull.valid).toBe(true)
      expect(resultNull.providerId).toBe('openai')
      expect(resultNull.model?.id).toBe('gpt-6-luna')

      const resultUndefined = validateBotModelCompatibility({
        modelId: 'claude-sonnet-5-5',
        registry
      })

      expect(resultUndefined.valid).toBe(true)
      expect(resultUndefined.providerId).toBe('anthropic')
      expect(resultUndefined.model?.id).toBe('claude-sonnet-5-5')
    })

    it('14. rejects absent provider connection when model is unknown in any catalog', () => {
      const result = validateBotModelCompatibility({
        providerConnectionId: null,
        modelId: 'unknown-mystery-model',
        registry
      })

      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('MODEL_NOT_FOUND')
      expect(result.error?.message).toContain(
        "Model 'unknown-mystery-model' is not recognized in any supported provider catalog."
      )
    })
  })

  describe('assertBotModelCompatibility', () => {
    it('15. returns result without throwing on valid compatibility', () => {
      const result = assertBotModelCompatibility({
        providerConnectionId: openAiConnectionId,
        modelId: 'gpt-6-luna',
        connectionRepo: mockConnectionLookup,
        registry
      })

      expect(result.valid).toBe(true)
      expect(result.providerId).toBe('openai')
    })

    it('16. throws typed ProviderManagerError on cross-provider mismatch', () => {
      expect(() =>
        assertBotModelCompatibility({
          providerConnectionId: openAiConnectionId,
          modelId: 'claude-sonnet-5-5',
          connectionRepo: mockConnectionLookup,
          registry
        })
      ).toThrow(ProviderManagerError)

      try {
        assertBotModelCompatibility({
          providerConnectionId: openAiConnectionId,
          modelId: 'claude-sonnet-5-5',
          connectionRepo: mockConnectionLookup,
          registry
        })
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderManagerError)
        const pErr = err as ProviderManagerError
        expect(pErr.code).toBe('CROSS_PROVIDER_MODEL_MISMATCH')
      }
    })

    it('17. throws typed ProviderManagerError on missing connection', () => {
      try {
        assertBotModelCompatibility({
          providerConnectionId: '00000000-0000-4000-8000-000000000000',
          modelId: 'gpt-6-luna',
          connectionRepo: mockConnectionLookup,
          registry
        })
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderManagerError)
        const pErr = err as ProviderManagerError
        expect(pErr.code).toBe('CONNECTION_NOT_FOUND')
      }
    })
  })
})
