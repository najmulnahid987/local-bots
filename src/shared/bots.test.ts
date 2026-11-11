import { describe, it, expect } from 'vitest'
import {
  toBotDto,
  createBotRequestSchema,
  updateBotRequestSchema,
  botIdSchema,
  listBotsRequestSchema,
  BotBridgeError,
  APPROVED_BOT_TOOLS,
  type BotDto,
  type CreateBotRequest,
  type UpdateBotRequest
} from './bots'

describe('Shared Bot Contracts (Step 6.1)', () => {
  const validBotId = '11111111-1111-4111-8111-111111111111'
  const validKbId = '22222222-2222-4222-8222-222222222222'
  const validProviderConnectionId = '33333333-3333-4333-8333-333333333333'

  describe('BotDto and toBotDto', () => {
    it('1. converts a full domain Bot entity into a renderer-safe BotDto', () => {
      const entity = {
        id: validBotId,
        knowledgeBaseId: validKbId,
        providerConnectionId: validProviderConnectionId,
        name: 'Research Assistant',
        description: 'Analyzes technical specifications',
        systemPrompt: 'You are an analytical assistant.',
        modelId: 'gpt-6-luna',
        status: 'active' as const,
        toolPermissions: ['search_knowledge_base', 'read_project_file'] as const,
        createdAt: 1700000000000,
        updatedAt: 1700000050000
      }

      const dto: BotDto = toBotDto(entity)

      expect(dto).toEqual({
        id: validBotId,
        knowledgeBaseId: validKbId,
        providerConnectionId: validProviderConnectionId,
        name: 'Research Assistant',
        description: 'Analyzes technical specifications',
        systemPrompt: 'You are an analytical assistant.',
        modelId: 'gpt-6-luna',
        status: 'active',
        enabledTools: ['search_knowledge_base', 'read_project_file'],
        createdAt: 1700000000000,
        updatedAt: 1700000050000
      })
    })

    it('2. converts snake_case database row format with JSON tools into BotDto', () => {
      const row = {
        id: validBotId,
        knowledge_base_id: validKbId,
        provider_connection_id: null,
        name: 'Draft Bot',
        description: '',
        system_prompt: 'Be concise.',
        model_id: 'claude-sonnet-5-5',
        status: 'archived',
        tool_permissions_json: JSON.stringify(['prepare_report']),
        created_at: 1700000000000,
        updated_at: 1700000000000
      }

      const dto = toBotDto(row)

      expect(dto.id).toBe(validBotId)
      expect(dto.knowledgeBaseId).toBe(validKbId)
      expect(dto.providerConnectionId).toBeNull()
      expect(dto.status).toBe('archived')
      expect(dto.enabledTools).toEqual(['prepare_report'])
      expect(dto.createdAt).toBe(1700000000000)
    })

    it('3. throws an error if knowledgeBaseId is missing during conversion', () => {
      expect(() =>
        toBotDto({
          id: validBotId,
          name: 'Orphan Bot'
        } as unknown as Parameters<typeof toBotDto>[0])
      ).toThrow('Knowledge Base ID is required to construct BotDto.')
    })
  })

  describe('createBotRequestSchema', () => {
    it('4. accepts a valid CreateBotRequest with all fields', () => {
      const input: CreateBotRequest = {
        name: 'Code Reviewer',
        modelId: 'gpt-6.1-sol',
        description: 'Specialized in TypeScript security',
        systemPrompt: 'Focus on defensive programming.',
        providerConnectionId: validProviderConnectionId,
        enabledTools: ['read_project_file', 'search_project_files']
      }

      const parsed = createBotRequestSchema.parse(input)
      expect(parsed).toEqual(input)
    })

    it('5. accepts a valid minimal CreateBotRequest and applies defaults', () => {
      const input = {
        name: 'Minimal Bot',
        modelId: 'gemini-3.8-flash'
      }

      const parsed = createBotRequestSchema.parse(input)
      expect(parsed.name).toBe('Minimal Bot')
      expect(parsed.modelId).toBe('gemini-3.8-flash')
      expect(parsed.description).toBe('')
      expect(parsed.systemPrompt).toBe('')
      expect(parsed.providerConnectionId).toBeNull()
      expect(parsed.enabledTools).toEqual([])
    })

    it('6. rejects empty or whitespace-only name', () => {
      expect(() => createBotRequestSchema.parse({ name: '', modelId: 'gpt-6-luna' })).toThrow(
        /Bot name cannot be blank/
      )
      expect(() => createBotRequestSchema.parse({ name: '   ', modelId: 'gpt-6-luna' })).toThrow(
        /Bot name cannot be blank/
      )
    })

    it('7. rejects name exceeding 100 characters', () => {
      const longName = 'A'.repeat(101)
      expect(() => createBotRequestSchema.parse({ name: longName, modelId: 'gpt-6-luna' })).toThrow(
        /Bot name cannot exceed 100 characters/
      )
    })

    it('8. rejects empty or whitespace-only modelId', () => {
      expect(() => createBotRequestSchema.parse({ name: 'Valid Bot', modelId: '' })).toThrow(
        /Model ID cannot be blank/
      )
      expect(() => createBotRequestSchema.parse({ name: 'Valid Bot', modelId: '   ' })).toThrow(
        /Model ID cannot be blank/
      )
    })

    it('9. rejects invalid providerConnectionId that is not a UUID', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          providerConnectionId: 'not-a-uuid'
        })
      ).toThrow(/must be a valid UUIDv4 string/)
    })

    it('10. rejects unsupported tool identifier', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          enabledTools: [
            'unauthorized_shell_execution' as unknown as (typeof APPROVED_BOT_TOOLS)[number]
          ]
        })
      ).toThrow(/Invalid tool identifier/)
    })

    it('11. rejects duplicate tool identifiers', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          enabledTools: ['search_knowledge_base', 'search_knowledge_base']
        })
      ).toThrow(/Duplicate tool identifiers are not allowed/)
    })

    it('12. strictly rejects unknown properties', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          unexpectedField: 'forbidden'
        })
      ).toThrow(/unrecognized_keys/)
    })

    it('13. strictly rejects attempts to supply knowledgeBaseId in CreateBotRequest', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          knowledgeBaseId: validKbId
        })
      ).toThrow(/unrecognized_keys/)
    })

    it('14. strictly rejects attempts to supply id, createdAt, or status in CreateBotRequest', () => {
      expect(() =>
        createBotRequestSchema.parse({
          name: 'Valid Bot',
          modelId: 'gpt-6-luna',
          id: validBotId,
          createdAt: 1000,
          status: 'active'
        })
      ).toThrow(/unrecognized_keys/)
    })
  })

  describe('updateBotRequestSchema', () => {
    it('15. accepts an update with a single field', () => {
      const input: UpdateBotRequest = { name: 'New Name' }
      const parsed = updateBotRequestSchema.parse(input)
      expect(parsed).toEqual({ name: 'New Name' })
    })

    it('16. accepts an update with multiple valid fields', () => {
      const input: UpdateBotRequest = {
        name: 'Updated Name',
        description: 'New Description',
        modelId: 'claude-sonnet-5-5',
        enabledTools: ['search_knowledge_base', 'prepare_report']
      }
      const parsed = updateBotRequestSchema.parse(input)
      expect(parsed).toEqual(input)
    })

    it('17. rejects an empty update request', () => {
      expect(() => updateBotRequestSchema.parse({})).toThrow(
        /At least one editable Bot field must be provided/
      )
    })

    it('18. rejects whitespace-only name in update', () => {
      expect(() => updateBotRequestSchema.parse({ name: '   ' })).toThrow(
        /Bot name cannot be blank/
      )
    })

    it('19. rejects whitespace-only modelId in update', () => {
      expect(() => updateBotRequestSchema.parse({ modelId: '   ' })).toThrow(
        /Model ID cannot be blank/
      )
    })

    it('20. rejects duplicate tools in update', () => {
      expect(() =>
        updateBotRequestSchema.parse({
          enabledTools: ['read_project_file', 'read_project_file']
        })
      ).toThrow(/Duplicate tool identifiers are not allowed/)
    })

    it('21. strictly rejects immutable fields in update (id, knowledgeBaseId, createdAt, status)', () => {
      expect(() =>
        updateBotRequestSchema.parse({
          name: 'Valid Name',
          knowledgeBaseId: validKbId
        })
      ).toThrow(/unrecognized_keys/)

      expect(() =>
        updateBotRequestSchema.parse({
          name: 'Valid Name',
          id: validBotId
        })
      ).toThrow(/unrecognized_keys/)

      expect(() =>
        updateBotRequestSchema.parse({
          name: 'Valid Name',
          status: 'archived'
        })
      ).toThrow(/unrecognized_keys/)
    })
  })

  describe('botIdSchema and listBotsRequestSchema', () => {
    it('22. botIdSchema accepts valid UUIDv4 and rejects invalid formats', () => {
      expect(botIdSchema.parse(validBotId)).toBe(validBotId)
      expect(() => botIdSchema.parse('invalid-id')).toThrow(/must be a valid RFC 4122 UUIDv4/)
    })

    it('23. listBotsRequestSchema accepts valid status filter and rejects unknown keys', () => {
      expect(listBotsRequestSchema.parse({ status: 'active' })).toEqual({ status: 'active' })
      expect(listBotsRequestSchema.parse({ status: 'archived' })).toEqual({ status: 'archived' })
      expect(listBotsRequestSchema.parse(undefined)).toBeUndefined()

      expect(() =>
        listBotsRequestSchema.parse({
          status: 'unknown_status' as unknown as 'active'
        })
      ).toThrow()

      expect(() =>
        listBotsRequestSchema.parse({
          status: 'active',
          extra: 'bad'
        })
      ).toThrow(/unrecognized_keys/)
    })
  })

  describe('BotBridgeError', () => {
    it('24. instantiates with correct name, code, message, and prototype chain', () => {
      const error = new BotBridgeError('Bot not found in workspace', 'BOT_NOT_FOUND')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(BotBridgeError)
      expect(error.name).toBe('BotBridgeError')
      expect(error.code).toBe('BOT_NOT_FOUND')
      expect(error.message).toBe('Bot not found in workspace')
    })
  })
})
