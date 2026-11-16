import { describe, it, expect } from 'vitest'
import {
  createBotMemorySchema,
  updateBotMemorySchema,
  listBotMemoriesSchema,
  getBotMemorySchema,
  deleteBotMemorySchema,
  botMemoryCountSchema,
  toBotMemoryDto,
  MAX_BOT_MEMORY_CONTENT_LENGTH
} from './bot-memories'

describe('Bot Memories Shared Contracts & Zod Validation', () => {
  const validBotId = '11111111-1111-4111-8111-111111111111'
  const validMemoryId = '22222222-2222-4222-8222-222222222222'

  describe('createBotMemorySchema', () => {
    it('accepts valid input with default memoryType (user_note)', () => {
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: 'Remember that the user prefers concise answers.'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.botId).toBe(validBotId)
        expect(result.data.memoryType).toBe('user_note')
        expect(result.data.content).toBe('Remember that the user prefers concise answers.')
      }
    })

    it('accepts valid input with explicit pinned_instruction memoryType', () => {
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        memoryType: 'pinned_instruction',
        content: 'Always format dates in ISO 8601.'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.memoryType).toBe('pinned_instruction')
      }
    })

    it('trims leading and trailing whitespace from content', () => {
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: '   Trimmed memory content   '
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.content).toBe('Trimmed memory content')
      }
    })

    it('rejects missing botId', () => {
      const result = createBotMemorySchema.safeParse({
        content: 'Valid content'
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid UUID botId', () => {
      const result = createBotMemorySchema.safeParse({
        botId: 'invalid-uuid',
        content: 'Valid content'
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty or whitespace-only content', () => {
      const emptyResult = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: ''
      })
      expect(emptyResult.success).toBe(false)

      const whitespaceResult = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: '    \n\t   '
      })
      expect(whitespaceResult.success).toBe(false)
    })

    it('rejects unsupported memory types', () => {
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        memoryType: 'system_override',
        content: 'Valid content'
      })
      expect(result.success).toBe(false)
    })

    it('rejects content exceeding MAX_BOT_MEMORY_CONTENT_LENGTH', () => {
      const overlongContent = 'a'.repeat(MAX_BOT_MEMORY_CONTENT_LENGTH + 1)
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: overlongContent
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          `cannot exceed ${MAX_BOT_MEMORY_CONTENT_LENGTH} characters`
        )
      }
    })

    it('accepts content exactly at MAX_BOT_MEMORY_CONTENT_LENGTH', () => {
      const exactContent = 'b'.repeat(MAX_BOT_MEMORY_CONTENT_LENGTH)
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: exactContent
      })
      expect(result.success).toBe(true)
    })

    it('strictly rejects unexpected fields (e.g. knowledgeBaseId, id, createdAt)', () => {
      const result = createBotMemorySchema.safeParse({
        botId: validBotId,
        content: 'Some note',
        knowledgeBaseId: '33333333-3333-4333-8333-333333333333'
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateBotMemorySchema', () => {
    it('accepts valid content update', () => {
      const result = updateBotMemorySchema.safeParse({
        content: 'Updated content'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.content).toBe('Updated content')
      }
    })

    it('accepts valid memoryType update', () => {
      const result = updateBotMemorySchema.safeParse({
        memoryType: 'pinned_instruction'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.memoryType).toBe('pinned_instruction')
      }
    })

    it('accepts updating both content and memoryType', () => {
      const result = updateBotMemorySchema.safeParse({
        content: 'New content',
        memoryType: 'user_note'
      })
      expect(result.success).toBe(true)
    })

    it('rejects empty update with no fields', () => {
      const result = updateBotMemorySchema.safeParse({})
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          'At least one field (content or memoryType) must be provided'
        )
      }
    })

    it('rejects whitespace-only content update', () => {
      const result = updateBotMemorySchema.safeParse({
        content: '   '
      })
      expect(result.success).toBe(false)
    })

    it('rejects unsupported memory types on update', () => {
      const result = updateBotMemorySchema.safeParse({
        memoryType: 'unknown_type'
      })
      expect(result.success).toBe(false)
    })

    it('rejects oversized content on update', () => {
      const result = updateBotMemorySchema.safeParse({
        content: 'c'.repeat(MAX_BOT_MEMORY_CONTENT_LENGTH + 1)
      })
      expect(result.success).toBe(false)
    })

    it('strictly rejects immutable fields (botId, knowledgeBaseId, id)', () => {
      const result = updateBotMemorySchema.safeParse({
        content: 'Updated content',
        botId: validBotId
      })
      expect(result.success).toBe(false)
    })
  })

  describe('listBotMemoriesSchema', () => {
    it('accepts valid botId', () => {
      const result = listBotMemoriesSchema.safeParse({
        botId: validBotId
      })
      expect(result.success).toBe(true)
    })

    it('accepts valid botId with optional memoryType filter', () => {
      const result = listBotMemoriesSchema.safeParse({
        botId: validBotId,
        memoryType: 'pinned_instruction'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.memoryType).toBe('pinned_instruction')
      }
    })

    it('rejects invalid botId', () => {
      const result = listBotMemoriesSchema.safeParse({
        botId: 'not-a-uuid'
      })
      expect(result.success).toBe(false)
    })

    it('strictly rejects unknown fields', () => {
      const result = listBotMemoriesSchema.safeParse({
        botId: validBotId,
        knowledgeBaseId: validBotId
      })
      expect(result.success).toBe(false)
    })
  })

  describe('getBotMemorySchema & deleteBotMemorySchema', () => {
    it('accepts valid memoryId and botId for get', () => {
      const result = getBotMemorySchema.safeParse({
        memoryId: validMemoryId,
        botId: validBotId
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid memoryId for get', () => {
      const result = getBotMemorySchema.safeParse({
        memoryId: 'bad-id',
        botId: validBotId
      })
      expect(result.success).toBe(false)
    })

    it('accepts valid memoryId and botId for delete', () => {
      const result = deleteBotMemorySchema.safeParse({
        memoryId: validMemoryId,
        botId: validBotId
      })
      expect(result.success).toBe(true)
    })

    it('rejects unexpected fields in delete', () => {
      const result = deleteBotMemorySchema.safeParse({
        memoryId: validMemoryId,
        botId: validBotId,
        extra: 'not-allowed'
      })
      expect(result.success).toBe(false)
    })
  })

  describe('botMemoryCountSchema', () => {
    it('accepts valid botId', () => {
      const result = botMemoryCountSchema.safeParse({
        botId: validBotId
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid botId', () => {
      const result = botMemoryCountSchema.safeParse({
        botId: 'xyz'
      })
      expect(result.success).toBe(false)
    })
  })

  describe('toBotMemoryDto', () => {
    it('correctly maps raw database row to BotMemoryDto', () => {
      const now = Date.now()
      const dto = toBotMemoryDto({
        id: validMemoryId,
        bot_id: validBotId,
        knowledge_base_id: 'kb-1234',
        memory_type: 'pinned_instruction',
        content: 'Always respond in Markdown',
        created_at: now,
        updated_at: now + 500
      })

      expect(dto).toEqual({
        id: validMemoryId,
        botId: validBotId,
        knowledgeBaseId: 'kb-1234',
        memoryType: 'pinned_instruction',
        content: 'Always respond in Markdown',
        createdAt: now,
        updatedAt: now + 500
      })
    })

    it('correctly defaults memoryType to user_note if missing', () => {
      const dto = toBotMemoryDto({
        id: validMemoryId,
        bot_id: validBotId,
        knowledge_base_id: 'kb-1234',
        content: 'Hello'
      })
      expect(dto.memoryType).toBe('user_note')
    })
  })
})
