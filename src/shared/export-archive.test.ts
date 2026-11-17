import { describe, it, expect } from 'vitest'
import {
  EXPORT_ARCHIVE_FORMAT,
  EXPORT_ARCHIVE_SCHEMA_VERSION,
  exportKnowledgeBaseRequestSchema,
  exportManifestDtoSchema,
  exportKnowledgeBaseDtoSchema,
  exportBotDtoSchema,
  exportBotMemoryDtoSchema,
  exportKnowledgeSourceDtoSchema,
  exportConversationDtoSchema,
  exportMessageDtoSchema,
  exportKnowledgeBaseResultDtoSchema,
  importPreviewDtoSchema,
  executeImportRequestSchema,
  executeImportResultDtoSchema,
  cancelImportRequestSchema
} from './export-archive'

describe('export-archive shared contracts', () => {
  const validUuid = '11111111-1111-4111-8111-111111111111'
  const validHash = 'a'.repeat(64)

  it('validates a valid exportKnowledgeBaseRequest', () => {
    const valid = { knowledgeBaseId: validUuid }
    const result = exportKnowledgeBaseRequestSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects invalid exportKnowledgeBaseRequest with non-UUID', () => {
    const invalid = { knowledgeBaseId: 'invalid-id' }
    const result = exportKnowledgeBaseRequestSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('validates a valid exportManifestDto', () => {
    const valid = {
      format: EXPORT_ARCHIVE_FORMAT,
      schemaVersion: EXPORT_ARCHIVE_SCHEMA_VERSION,
      exportedAt: 1700000000000,
      appVersion: '1.0.0',
      knowledgeBase: {
        id: validUuid,
        name: 'My Workspace'
      },
      counts: {
        bots: 2,
        memories: 5,
        sources: 3,
        conversations: 4,
        messages: 20,
        totalSourceBytes: 1048576
      },
      files: [
        {
          path: 'manifest.json',
          sizeBytes: 256,
          sha256: validHash
        }
      ],
      excludedCategories: ['provider_credentials', 'api_keys']
    }
    const result = exportManifestDtoSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects manifest with mismatched format or schemaVersion', () => {
    const invalid = {
      format: 'unknown-format',
      schemaVersion: '2.0.0',
      exportedAt: 1700000000000,
      appVersion: '1.0.0',
      knowledgeBase: { id: validUuid, name: 'Workspace' },
      counts: {
        bots: 0,
        memories: 0,
        sources: 0,
        conversations: 0,
        messages: 0,
        totalSourceBytes: 0
      },
      files: [],
      excludedCategories: []
    }
    const result = exportManifestDtoSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('validates exportKnowledgeBaseDto', () => {
    const valid = {
      id: validUuid,
      name: 'Test KB',
      description: 'A test KB',
      createdAt: 1700000000000,
      updatedAt: 1700000005000,
      archivedAt: null
    }
    const result = exportKnowledgeBaseDtoSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates exportBotDto', () => {
    const valid = {
      id: validUuid,
      name: 'Researcher Bot',
      description: 'Researches things',
      systemPrompt: 'You are helpful',
      modelId: 'gpt-4o',
      status: 'active' as const,
      toolPermissions: ['search_documents'],
      createdAt: 1700000000000,
      updatedAt: 1700000005000
    }
    const result = exportBotDtoSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates exportBotMemoryDto', () => {
    const valid = {
      id: validUuid,
      botId: validUuid,
      memoryType: 'pinned_instruction' as const,
      content: 'Always respond in Markdown',
      createdAt: 1700000000000,
      updatedAt: 1700000005000
    }
    const result = exportBotMemoryDtoSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates exportKnowledgeSourceDto', () => {
    const valid = {
      id: validUuid,
      fileName: 'document.pdf',
      originalFileName: 'my-file.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 2048,
      contentHash: validHash,
      indexingStatus: 'completed',
      createdAt: 1700000000000,
      updatedAt: 1700000005000,
      indexedAt: 1700000006000
    }
    const result = exportKnowledgeSourceDtoSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('validates exportConversationDto and exportMessageDto', () => {
    const validConv = {
      id: validUuid,
      botId: validUuid,
      title: 'Chat 1',
      createdAt: 1700000000000,
      updatedAt: 1700000005000,
      archivedAt: null
    }
    expect(exportConversationDtoSchema.safeParse(validConv).success).toBe(true)

    const validMsg = {
      id: validUuid,
      conversationId: validUuid,
      role: 'assistant' as const,
      content: 'Hello there!',
      contentFormat: 'markdown' as const,
      metadata: { citations: [] },
      createdAt: 1700000001000
    }
    expect(exportMessageDtoSchema.safeParse(validMsg).success).toBe(true)
  })

  it('validates exportKnowledgeBaseResultDto for success and cancelled cases', () => {
    const successResult = {
      success: true,
      knowledgeBaseId: validUuid,
      archivePath: '/path/to/archive.voyaro-kb.zip',
      archiveSizeBytes: 54321,
      counts: {
        bots: 1,
        memories: 2,
        sources: 3,
        conversations: 4,
        messages: 5,
        totalSourceBytes: 6789
      }
    }
    expect(exportKnowledgeBaseResultDtoSchema.safeParse(successResult).success).toBe(true)

    const cancelledResult = {
      success: false,
      cancelled: true,
      knowledgeBaseId: validUuid
    }
    expect(exportKnowledgeBaseResultDtoSchema.safeParse(cancelledResult).success).toBe(true)
  })

  it('validates importPreviewDto', () => {
    const validPreview = {
      sessionId: validUuid,
      archiveName: 'workspace-export.voyaro-kb.zip',
      archiveSizeBytes: 10240,
      format: EXPORT_ARCHIVE_FORMAT,
      schemaVersion: EXPORT_ARCHIVE_SCHEMA_VERSION,
      exportedAt: 1700000000000,
      appVersion: '1.0.0',
      knowledgeBase: {
        id: validUuid,
        name: 'Research KB',
        description: 'Research info'
      },
      counts: {
        bots: 1,
        memories: 2,
        sources: 1,
        conversations: 1,
        messages: 2,
        totalSourceBytes: 5000
      },
      documentFiles: [
        {
          id: validUuid,
          originalFileName: 'paper.pdf',
          fileType: 'pdf',
          sizeBytes: 5000
        }
      ],
      securityNotice: 'Zero credentials will be imported.'
    }
    expect(importPreviewDtoSchema.safeParse(validPreview).success).toBe(true)
  })

  it('validates executeImportRequest for new, merge, and replace strategies', () => {
    // Strategy 'new' does not require targetKnowledgeBaseId
    const validNew = {
      sessionId: validUuid,
      strategy: 'new' as const
    }
    expect(executeImportRequestSchema.safeParse(validNew).success).toBe(true)

    // Strategy 'merge' requires targetKnowledgeBaseId
    const validMerge = {
      sessionId: validUuid,
      strategy: 'merge' as const,
      targetKnowledgeBaseId: validUuid
    }
    expect(executeImportRequestSchema.safeParse(validMerge).success).toBe(true)

    const invalidMerge = {
      sessionId: validUuid,
      strategy: 'merge' as const
    }
    expect(executeImportRequestSchema.safeParse(invalidMerge).success).toBe(false)

    // Strategy 'replace' requires targetKnowledgeBaseId
    const validReplace = {
      sessionId: validUuid,
      strategy: 'replace' as const,
      targetKnowledgeBaseId: validUuid,
      confirmationName: 'Target KB'
    }
    expect(executeImportRequestSchema.safeParse(validReplace).success).toBe(true)
  })

  it('validates executeImportResultDto and cancelImportRequest', () => {
    const validResult = {
      success: true,
      strategy: 'new' as const,
      knowledgeBaseId: validUuid,
      knowledgeBaseName: 'Restored KB',
      counts: {
        bots: 1,
        memories: 1,
        sources: 1,
        conversations: 1,
        messages: 1,
        indexedSources: 1,
        failedSources: 0
      }
    }
    expect(executeImportResultDtoSchema.safeParse(validResult).success).toBe(true)

    const validCancel = {
      sessionId: validUuid
    }
    expect(cancelImportRequestSchema.safeParse(validCancel).success).toBe(true)
  })
})
