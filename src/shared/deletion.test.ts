import { describe, it, expect } from 'vitest'
import {
  deletableEntityTypeSchema,
  deletionDependentCountsDtoSchema,
  deletionPreviewDtoSchema,
  getDeletionPreviewRequestSchema,
  deleteEntityRequestSchema,
  deleteEntityResultDtoSchema,
  DeletionBridgeError,
  type DeletionPreviewDto
} from './deletion'

describe('Deletion Contracts & Schemas (src/shared/deletion.ts)', () => {
  const validUuid = '11111111-2222-4333-8444-555555555555'
  const parentUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('validates supported deletable entity types', () => {
    expect(deletableEntityTypeSchema.safeParse('conversation').success).toBe(true)
    expect(deletableEntityTypeSchema.safeParse('bot').success).toBe(true)
    expect(deletableEntityTypeSchema.safeParse('knowledge_source').success).toBe(true)
    expect(deletableEntityTypeSchema.safeParse('knowledge_base').success).toBe(true)
    expect(deletableEntityTypeSchema.safeParse('unknown').success).toBe(false)
  })

  it('validates dependent counts with non-negative integers', () => {
    const validCounts = {
      bots: 2,
      sources: 5,
      chunks: 25,
      conversations: 10,
      messages: 50,
      memories: 3,
      agentRuns: 4,
      toolEvents: 12
    }
    expect(deletionDependentCountsDtoSchema.safeParse(validCounts).success).toBe(true)

    // Negative counts fail
    expect(deletionDependentCountsDtoSchema.safeParse({ messages: -1 }).success).toBe(false)
  })

  it('validates a complete DeletionPreviewDto', () => {
    const samplePreview: DeletionPreviewDto = {
      entityType: 'bot',
      entityId: validUuid,
      displayName: 'Research Assistant',
      parentName: 'Product Documentation',
      parentId: parentUuid,
      dependentCounts: {
        conversations: 3,
        messages: 15,
        memories: 2
      },
      affectedCategories: ['Conversations', 'Messages', 'Saved Memories'],
      unaffectedCategories: ['Knowledge Base documents', 'Sibling Bots'],
      backupReversible: true,
      isBlocked: false,
      warnings: ['Irreversible cascade deletion']
    }

    const parsed = deletionPreviewDtoSchema.safeParse(samplePreview)
    expect(parsed.success).toBe(true)
  })

  it('validates GetDeletionPreviewRequest and DeleteEntityRequest', () => {
    expect(
      getDeletionPreviewRequestSchema.safeParse({
        entityType: 'conversation',
        entityId: validUuid
      }).success
    ).toBe(true)

    expect(
      deleteEntityRequestSchema.safeParse({
        entityType: 'bot',
        entityId: validUuid,
        confirmName: 'Research Assistant'
      }).success
    ).toBe(true)

    // Invalid UUID fails
    expect(
      deleteEntityRequestSchema.safeParse({
        entityType: 'bot',
        entityId: 'not-a-uuid'
      }).success
    ).toBe(false)
  })

  it('validates DeleteEntityResultDto', () => {
    expect(
      deleteEntityResultDtoSchema.safeParse({
        success: true,
        entityType: 'knowledge_base',
        entityId: validUuid,
        directoryCleaned: true
      }).success
    ).toBe(true)
  })

  it('creates DeletionBridgeError with default and custom codes', () => {
    const err = new DeletionBridgeError('Action failed')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('DeletionBridgeError')
    expect(err.code).toBe('DELETION_ERROR')

    const customErr = new DeletionBridgeError('Blocked', 'OPERATION_BLOCKED')
    expect(customErr.code).toBe('OPERATION_BLOCKED')
  })
})
