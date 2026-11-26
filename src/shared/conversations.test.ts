import { describe, it, expect } from 'vitest'
import {
  toConversationDto,
  toMessageDto,
  CONVERSATION_IPC_CHANNELS,
  conversationIdSchema,
  messageIdSchema,
  conversationTitleSchema,
  getConversationForBotRequestSchema,
  getSegmentsRequestSchema,
  clearConversationRequestSchema,
  renameConversationRequestSchema,
  listConversationsRequestSchema,
  listMessagesRequestSchema,
  deleteConversationResultSchema,
  messageRoleSchema,
  messageContentFormatSchema,
  messageTokenUsageSchema,
  citationDtoSchema,
  messageToolCallSchema,
  generationMetadataSchema,
  messageMetadataSchema,
  sendMessageRequestSchema,
  conversationDtoSchema,
  messageDtoSchema,
  groupMessagesBySegments,
  orderMessagesRespectingSegments,
  serializeMessageMetadata,
  deserializeMessageMetadata,
  serializeMessageTokenUsage,
  deserializeMessageTokenUsage,
  ConversationBridgeError,
  CONVERSATION_TITLE_MAX_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_ROLES,
  MESSAGE_CONTENT_FORMATS,
  type ConversationDto,
  type ConversationSegmentDto,
  type MessageDto,
  type CitationDto,
  type GetConversationForBotRequest,
  type ClearConversationRequest,
  type RenameConversationRequest,
  type MessageTokenUsageDto,
  type MessageMetadataDto
} from './conversations'

describe('Shared Conversation and Message Contracts (Step 7.1)', () => {
  const validConvId = '11111111-1111-4111-8111-111111111111'
  const validBotId = '22222222-2222-4222-8222-222222222222'
  const validKbId = '33333333-3333-4333-8333-333333333333'
  const validSourceId = '44444444-4444-4444-8444-444444444444'
  const validChunkId = '55555555-5555-4555-8555-555555555555'
  const validMsgId = '66666666-6666-4666-8666-666666666666'

  // ==========================================================================
  // 1. Conversation Contracts
  // ==========================================================================
  describe('Conversation Contracts', () => {
    it('1. accepts a valid ConversationDto', () => {
      const dto: ConversationDto = {
        id: validConvId,
        botId: validBotId,
        knowledgeBaseId: validKbId,
        title: 'Q3 Financial Analysis',
        createdAt: 1700000000000,
        updatedAt: 1700000010000,
        archivedAt: null
      }

      const parsed = conversationDtoSchema.parse(dto)
      expect(parsed).toEqual(dto)
    })

    it('2. converts entity or row to ConversationDto with camelCase mapping', () => {
      const entity = {
        id: validConvId,
        botId: validBotId,
        knowledgeBaseId: validKbId,
        title: 'Project Roadmap',
        createdAt: 1700000000000,
        updatedAt: 1700000020000,
        archivedAt: null
      }

      const dto = toConversationDto(entity)
      expect(dto.id).toBe(validConvId)
      expect(dto.botId).toBe(validBotId)
      expect(dto.knowledgeBaseId).toBe(validKbId)
      expect(dto.title).toBe('Project Roadmap')
    })

    it('3. converts snake_case database row to ConversationDto', () => {
      const row = {
        id: validConvId,
        bot_id: validBotId,
        knowledge_base_id: validKbId,
        title: 'Database Investigation',
        created_at: 1700000000000,
        updated_at: 1700000030000,
        archived_at: 1700000050000
      }

      const dto = toConversationDto(row)
      expect(dto.id).toBe(validConvId)
      expect(dto.botId).toBe(validBotId)
      expect(dto.knowledgeBaseId).toBe(validKbId)
      expect(dto.title).toBe('Database Investigation')
      expect(dto.archivedAt).toBe(1700000050000)
    })

    it('4. throws when converting row without required botId or knowledgeBaseId', () => {
      expect(() =>
        toConversationDto({
          id: validConvId,
          title: 'Orphan Conversation',
          created_at: 1700000000000
        } as Parameters<typeof toConversationDto>[0])
      ).toThrow(/Bot ID is required/)

      expect(() =>
        toConversationDto({
          id: validConvId,
          bot_id: validBotId,
          title: 'Orphan Conversation',
          created_at: 1700000000000
        } as Parameters<typeof toConversationDto>[0])
      ).toThrow(/Knowledge Base ID is required/)
    })

    it('5. validates GetConversationForBotRequest and rejects injected knowledgeBaseId', () => {
      const req: GetConversationForBotRequest = {
        botId: validBotId
      }

      const parsed = getConversationForBotRequestSchema.parse(req)
      expect(parsed.botId).toBe(validBotId)

      expect(() =>
        getConversationForBotRequestSchema.parse({
          botId: validBotId,
          knowledgeBaseId: validKbId
        })
      ).toThrow(/Unrecognized key|knowledgeBaseId/)
    })

    it('6. omits CREATE from CONVERSATION_IPC_CHANNELS and includes Step 12.2 channels', () => {
      expect((CONVERSATION_IPC_CHANNELS as Record<string, unknown>).CREATE).toBeUndefined()
      expect(Object.values(CONVERSATION_IPC_CHANNELS)).not.toContain('conversation:create')
      expect(CONVERSATION_IPC_CHANNELS.GET_FOR_BOT).toBe('conversation:get-for-bot')
      expect(CONVERSATION_IPC_CHANNELS.GET_SEGMENTS).toBe('conversation:get-segments')
      expect(CONVERSATION_IPC_CHANNELS.CLEAR).toBe('conversation:clear')
      expect(CONVERSATION_IPC_CHANNELS.GET_CLEAR_PREVIEW).toBe('conversation:get-clear-preview')
    })

    it('7. accepts a valid RenameConversationRequest', () => {
      const req: RenameConversationRequest = {
        title: 'Renamed Analysis Thread'
      }

      const parsed = renameConversationRequestSchema.parse(req)
      expect(parsed.title).toBe('Renamed Analysis Thread')
    })

    it('8. rejects empty and whitespace-only conversation titles', () => {
      expect(() => conversationTitleSchema.parse('')).toThrow(/cannot be blank/)
      expect(() => conversationTitleSchema.parse('   ')).toThrow(/cannot be blank/)
      expect(() => renameConversationRequestSchema.parse({ title: '' })).toThrow(/cannot be blank/)
    })

    it('9. enforces maximum conversation title length', () => {
      const overlongTitle = 'a'.repeat(CONVERSATION_TITLE_MAX_LENGTH + 1)
      expect(() => conversationTitleSchema.parse(overlongTitle)).toThrow(
        new RegExp(`cannot exceed ${CONVERSATION_TITLE_MAX_LENGTH} characters`)
      )
      expect(() => renameConversationRequestSchema.parse({ title: overlongTitle })).toThrow(
        new RegExp(`cannot exceed ${CONVERSATION_TITLE_MAX_LENGTH} characters`)
      )
    })

    it('10. rejects invalid UUID for conversationId, getConversationForBot, getSegments, and clearConversation', () => {
      expect(() => conversationIdSchema.parse('not-a-uuid')).toThrow(/valid RFC 4122 UUIDv4/)
      expect(() => getConversationForBotRequestSchema.parse({ botId: 'invalid-bot-uuid' })).toThrow(
        /valid RFC 4122 UUIDv4/
      )
      expect(() => getSegmentsRequestSchema.parse({ conversationId: 'invalid-conv-uuid' })).toThrow(
        /valid RFC 4122 UUIDv4/
      )
      expect(() =>
        clearConversationRequestSchema.parse({ conversationId: 'invalid-conv-uuid' })
      ).toThrow(/valid RFC 4122 UUIDv4/)
    })

    it('11. strictly rejects unknown properties in getSegments and clearConversation requests', () => {
      expect(() =>
        getSegmentsRequestSchema.parse({
          conversationId: validConvId,
          unknownField: 'malicious'
        })
      ).toThrow(/Unrecognized key/)
      expect(() =>
        clearConversationRequestSchema.parse({
          conversationId: validConvId,
          knowledgeBaseId: validKbId
        })
      ).toThrow(/Unrecognized key|knowledgeBaseId/)
    })

    it('12. accepts valid ClearConversationRequest and high listMessages limit up to 10000', () => {
      const req: ClearConversationRequest = { conversationId: validConvId }
      expect(clearConversationRequestSchema.parse(req)).toEqual({ conversationId: validConvId })
      const listParsed = listMessagesRequestSchema.parse({
        conversationId: validConvId,
        limit: 10000
      })
      expect(listParsed.limit).toBe(10000)
    })

    it('13. prevents bot ownership reassignment in rename request', () => {
      expect(() =>
        renameConversationRequestSchema.parse({
          title: 'Renamed Thread',
          botId: validBotId
        })
      ).toThrow(/botId/)

      expect(() =>
        renameConversationRequestSchema.parse({
          title: 'Renamed Thread',
          knowledgeBaseId: validKbId
        })
      ).toThrow(/knowledgeBaseId/)
    })

    it('14. validates list conversations request with bot filter and archived flag', () => {
      const valid = listConversationsRequestSchema.parse({
        botId: validBotId,
        includeArchived: true
      })
      expect(valid?.botId).toBe(validBotId)
      expect(valid?.includeArchived).toBe(true)

      // Undefined options is also valid
      expect(listConversationsRequestSchema.parse(undefined)).toBeUndefined()

      // Unknown property in list filter rejected
      expect(() =>
        listConversationsRequestSchema.parse({
          botId: validBotId,
          knowledgeBaseId: validKbId
        })
      ).toThrow(/Unrecognized key/)
    })

    it('15. validates delete conversation result schema', () => {
      const res = deleteConversationResultSchema.parse({
        success: true,
        conversationId: validConvId
      })
      expect(res.success).toBe(true)
      expect(res.conversationId).toBe(validConvId)
    })
  })

  // ==========================================================================
  // 2. Message Contracts
  // ==========================================================================
  describe('Message Contracts', () => {
    it('16. validates all four supported message roles', () => {
      expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system', 'tool'])
      for (const role of MESSAGE_ROLES) {
        expect(messageRoleSchema.parse(role)).toBe(role)
      }
    })

    it('17. rejects invalid message roles', () => {
      expect(() => messageRoleSchema.parse('admin')).toThrow(/Invalid message role/)
      expect(() => messageRoleSchema.parse('bot')).toThrow(/Invalid message role/)
      expect(() => messageRoleSchema.parse('')).toThrow(/Invalid message role/)
    })

    it('18. validates all supported content formats including markdown', () => {
      expect(MESSAGE_CONTENT_FORMATS).toEqual(['text', 'markdown', 'json'])
      for (const format of MESSAGE_CONTENT_FORMATS) {
        expect(messageContentFormatSchema.parse(format)).toBe(format)
      }
    })

    it('19. rejects invalid content formats', () => {
      expect(() => messageContentFormatSchema.parse('html')).toThrow(/Invalid content format/)
      expect(() => messageContentFormatSchema.parse('xml')).toThrow(/Invalid content format/)
    })

    it('20. validates valid token usage metrics', () => {
      const usage: MessageTokenUsageDto = {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165
      }

      const parsed = messageTokenUsageSchema.parse(usage)
      expect(parsed).toEqual(usage)
    })

    it('21. rejects invalid negative or non-integer token usage values', () => {
      expect(() =>
        messageTokenUsageSchema.parse({
          promptTokens: -1,
          completionTokens: 10,
          totalTokens: 9
        })
      ).toThrow(/promptTokens must be non-negative/)

      expect(() =>
        messageTokenUsageSchema.parse({
          promptTokens: 10.5,
          completionTokens: 10,
          totalTokens: 20
        })
      ).toThrow(/promptTokens must be an integer/)
    })

    it('22. validates structured message metadata with provider, model and generation stats', () => {
      const genMeta = {
        finishReason: 'stop',
        durationMs: 450,
        firstTokenMs: 80,
        temperature: 0.7
      }
      expect(generationMetadataSchema.parse(genMeta)).toEqual(genMeta)

      const meta: MessageMetadataDto = {
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        generation: genMeta
      }

      const parsed = messageMetadataSchema.parse(meta)
      expect(parsed.providerId).toBe('openai')
      expect(parsed.modelId).toBe('gpt-6-luna')
      expect(parsed.generation?.finishReason).toBe('stop')
    })

    it('23. converts entity or row to MessageDto safely', () => {
      expect(messageIdSchema.parse(validMsgId)).toBe(validMsgId)
      expect(() => messageIdSchema.parse('invalid-id')).toThrow(/valid RFC 4122 UUIDv4/)

      const row = {
        id: validMsgId,
        conversation_id: validConvId,
        role: 'assistant',
        content: 'Here is the summary of the financial report.',
        content_format: 'markdown',
        metadata_json: JSON.stringify({
          providerId: 'google',
          modelId: 'gemini-3.8-flash'
        }),
        token_usage_json: JSON.stringify({
          promptTokens: 50,
          completionTokens: 20,
          totalTokens: 70
        }),
        created_at: 1700000000000
      }

      const dto: MessageDto = toMessageDto(row)
      expect(dto.id).toBe(validMsgId)
      expect(dto.conversationId).toBe(validConvId)
      expect(dto.role).toBe('assistant')
      expect(dto.content).toBe('Here is the summary of the financial report.')
      expect(dto.contentFormat).toBe('markdown')
      expect(dto.metadata.providerId).toBe('google')
      expect(dto.metadata.modelId).toBe('gemini-3.8-flash')
      expect(dto.tokenUsage?.totalTokens).toBe(70)

      const validatedDto = messageDtoSchema.parse(dto)
      expect(validatedDto).toEqual(dto)
    })

    it('24. validates SendMessageRequest with size bounding', () => {
      const req = {
        conversationId: validConvId,
        content: 'Please summarize our documents.',
        contentFormat: 'markdown' as const
      }

      const parsed = sendMessageRequestSchema.parse(req)
      expect(parsed.conversationId).toBe(validConvId)
      expect(parsed.content).toBe('Please summarize our documents.')

      const overlongContent = 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
      expect(() =>
        sendMessageRequestSchema.parse({
          conversationId: validConvId,
          content: overlongContent
        })
      ).toThrow(new RegExp(`cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters`))
    })
  })

  // ==========================================================================
  // 3. Structured Citation Contracts
  // ==========================================================================
  describe('Citation Contracts', () => {
    it('25. validates a valid PDF citation with 1-based page number', () => {
      const citation: CitationDto = {
        citationNumber: 1,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'annual_report_2026.pdf',
        fileType: 'pdf',
        pageNumber: 14,
        headingPath: null,
        chunkIndex: 3
      }

      const parsed = citationDtoSchema.parse(citation)
      expect(parsed).toEqual(citation)
    })

    it('26. validates a valid Markdown citation with heading hierarchy path', () => {
      const citation: CitationDto = {
        citationNumber: 2,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'architecture.md',
        fileType: 'md',
        pageNumber: null,
        headingPath: ['Architecture Overview', 'Security Baseline', 'Threat Model'],
        chunkIndex: 5
      }

      const parsed = citationDtoSchema.parse(citation)
      expect(parsed).toEqual(citation)
    })

    it('27. validates a valid TXT citation with null page and null headings', () => {
      const citation: CitationDto = {
        citationNumber: 3,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'raw_notes.txt',
        fileType: 'txt',
        pageNumber: null,
        headingPath: null,
        chunkIndex: 0
      }

      const parsed = citationDtoSchema.parse(citation)
      expect(parsed).toEqual(citation)
    })

    it('28. rejects invalid source and chunk UUIDs in citation', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: 'not-a-uuid',
          chunkId: validChunkId,
          fileName: 'doc.txt',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/sourceId must be a valid RFC 4122 UUIDv4/)

      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: 'invalid-chunk',
          fileName: 'doc.txt',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/chunkId must be a valid RFC 4122 UUIDv4/)
    })

    it('29. rejects non-positive or 0 citation numbers', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 0,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.txt',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/citationNumber must be a positive 1-based integer/)

      expect(() =>
        citationDtoSchema.parse({
          citationNumber: -1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.txt',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/citationNumber must be a positive 1-based integer/)
    })

    it('30. rejects non-positive or 0 PDF page numbers', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.pdf',
          fileType: 'pdf',
          pageNumber: 0,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/pageNumber must be a positive 1-based integer/)
    })

    it('31. rejects negative chunk indexes', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.txt',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: -1
        })
      ).toThrow(/chunkIndex must be a non-negative integer/)
    })

    it('32. rejects invalid file types in citation', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'executable.exe',
          fileType: 'exe' as unknown as 'pdf',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/fileType must be 'txt', 'md', 'pdf', 'docx', 'xlsx', or 'pptx'/)
    })

    it('32b. accepts docx file type in citation', () => {
      const parsed = citationDtoSchema.parse({
        citationNumber: 1,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'specification.docx',
        fileType: 'docx',
        pageNumber: null,
        headingPath: ['Architecture', 'Overview'],
        chunkIndex: 0
      })
      expect(parsed.fileType).toBe('docx')
    })

    it('32c. accepts xlsx file type in citation', () => {
      const parsed = citationDtoSchema.parse({
        citationNumber: 1,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'financial_model.xlsx',
        fileType: 'xlsx',
        pageNumber: null,
        headingPath: ['Sheet: Q1 Revenue'],
        chunkIndex: 0
      })
      expect(parsed.fileType).toBe('xlsx')
    })

    it('32d. accepts pptx file type in citation with slide number', () => {
      const parsed = citationDtoSchema.parse({
        citationNumber: 1,
        sourceId: validSourceId,
        chunkId: validChunkId,
        fileName: 'deck.pptx',
        fileType: 'pptx',
        pageNumber: 3,
        headingPath: ['Executive Summary'],
        chunkIndex: 2
      })
      expect(parsed.fileType).toBe('pptx')
      expect(parsed.pageNumber).toBe(3)
      expect(parsed.headingPath).toEqual(['Executive Summary'])
    })

    it('33. rejects empty heading strings in headingPath', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.md',
          fileType: 'md',
          pageNumber: null,
          headingPath: ['Heading 1', '   '],
          chunkIndex: 0
        })
      ).toThrow(/Heading cannot be empty/)
    })

    it('34. rejects filesystem paths in fileName and unexpected properties', () => {
      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: '/etc/passwd',
          fileType: 'txt',
          pageNumber: null,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/fileName must be a simple filename without path separators/)

      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'C:\\Users\\Secret\\doc.pdf',
          fileType: 'pdf',
          pageNumber: 1,
          headingPath: null,
          chunkIndex: 0
        })
      ).toThrow(/fileName must be a simple filename without path separators/)

      expect(() =>
        citationDtoSchema.parse({
          citationNumber: 1,
          sourceId: validSourceId,
          chunkId: validChunkId,
          fileName: 'doc.pdf',
          fileType: 'pdf',
          pageNumber: 1,
          headingPath: null,
          chunkIndex: 0,
          storagePath: '/userData/documents/file.pdf'
        })
      ).toThrow(/storagePath/)
    })
  })

  // ==========================================================================
  // 4. Structured Tool Calls in Message Metadata
  // ==========================================================================
  describe('Structured Tool Calls Metadata', () => {
    it('35. validates tool-call references conforming to approved tools', () => {
      const toolCall = {
        id: 'call_123',
        toolName: 'search_knowledge_base' as const,
        status: 'completed' as const,
        argumentsSummary: '{"query": "quarterly revenue"}',
        resultSummary: 'Found 3 chunks in annual_report_2026.pdf',
        errorMessage: null
      }

      const parsed = messageToolCallSchema.parse(toolCall)
      expect(parsed).toEqual(toolCall)
    })

    it('36. rejects unapproved tool names', () => {
      expect(() =>
        messageToolCallSchema.parse({
          id: 'call_456',
          toolName: 'execute_shell_command',
          status: 'pending'
        })
      ).toThrow(/Invalid tool identifier/)
    })
  })

  // ==========================================================================
  // 5. Serialization and Safe Metadata Parsing
  // ==========================================================================
  describe('Serialization and Deserialization Safety', () => {
    it('37. round-trips valid metadata with citations, toolCalls and generation info', () => {
      const original: MessageMetadataDto = {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5-5',
        citations: [
          {
            citationNumber: 1,
            sourceId: validSourceId,
            chunkId: validChunkId,
            fileName: 'guide.md',
            fileType: 'md',
            pageNumber: null,
            headingPath: ['Getting Started'],
            chunkIndex: 0
          }
        ],
        toolCalls: [
          {
            id: 'tc-1',
            toolName: 'read_knowledge_base_document',
            status: 'completed',
            resultSummary: 'Loaded 1 chunk'
          }
        ],
        generation: {
          finishReason: 'stop',
          durationMs: 1200
        }
      }

      const jsonStr = serializeMessageMetadata(original)
      expect(typeof jsonStr).toBe('string')

      const deserialized = deserializeMessageMetadata(jsonStr)
      expect(deserialized).toEqual(original)
    })

    it('38. handles missing, null, undefined, and empty optional metadata safely', () => {
      expect(serializeMessageMetadata(null)).toBe('{}')
      expect(serializeMessageMetadata(undefined)).toBe('{}')
      expect(serializeMessageMetadata({})).toBe('{}')

      expect(deserializeMessageMetadata(null)).toEqual({})
      expect(deserializeMessageMetadata(undefined)).toEqual({})
      expect(deserializeMessageMetadata('')).toEqual({})
      expect(deserializeMessageMetadata('{}')).toEqual({})
      expect(deserializeMessageMetadata('   ')).toEqual({})
    })

    it('39. handles malformed JSON safely without throwing or leaking error details', () => {
      // Must not throw SyntaxError
      const result1 = deserializeMessageMetadata('{ invalid json broken syntax !!!')
      expect(result1).toEqual({})

      const result2 = deserializeMessageMetadata('<html><body>404 Not Found</body></html>')
      expect(result2).toEqual({})

      const result3 = deserializeMessageMetadata(12345)
      expect(result3).toEqual({})
    })

    it('40. rejects corrupted citation metadata and does not fabricate citations', () => {
      const corruptedJson = JSON.stringify({
        citations: [
          {
            citationNumber: -99,
            sourceId: 'corrupted-id',
            fileName: '/root/secret.key',
            fileType: 'exe'
          }
        ]
      })

      // Deserialization safely rejects invalid metadata and returns safe fallback {}
      // It never fabricates missing references or allows invalid citations through
      const result = deserializeMessageMetadata(corruptedJson)
      expect(result).toEqual({})
    })

    it('41. round-trips valid token usage and safely handles invalid token usage JSON', () => {
      const usage: MessageTokenUsageDto = {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125
      }

      const serialized = serializeMessageTokenUsage(usage)
      expect(deserializeMessageTokenUsage(serialized)).toEqual(usage)

      expect(serializeMessageTokenUsage(null)).toBe('{}')
      expect(deserializeMessageTokenUsage(null)).toBeNull()
      expect(deserializeMessageTokenUsage('')).toBeNull()
      expect(deserializeMessageTokenUsage('{}')).toBeNull()
      expect(deserializeMessageTokenUsage('{ broken json')).toBeNull()
      expect(deserializeMessageTokenUsage(JSON.stringify({ promptTokens: -5 }))).toBeNull()
    })

    it('42. verifies ConversationBridgeError instantiates with correct name and code', () => {
      const err = new ConversationBridgeError('Thread not found', 'THREAD_NOT_FOUND')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ConversationBridgeError)
      expect(err.name).toBe('ConversationBridgeError')
      expect(err.code).toBe('THREAD_NOT_FOUND')
      expect(err.message).toBe('Thread not found')
    })

    it('43. groupMessagesBySegments preserves segmentOrder even with overlapping historical timestamps and empty segments', () => {
      const seg0: ConversationSegmentDto = {
        id: '77777777-7777-4777-8777-777777777700',
        conversationId: validConvId,
        originalConversationId: validConvId,
        title: 'Early Research',
        segmentOrder: 0,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000000000,
        archivedAt: null,
        messageCount: 1
      }
      const seg1Empty: ConversationSegmentDto = {
        id: '77777777-7777-4777-8777-777777777701',
        conversationId: validConvId,
        originalConversationId: validConvId,
        title: 'Empty Archived Thread',
        segmentOrder: 1,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000001000,
        archivedAt: null,
        messageCount: 0
      }
      const seg2: ConversationSegmentDto = {
        id: '77777777-7777-4777-8777-777777777702',
        conversationId: validConvId,
        originalConversationId: validConvId,
        title: 'Later Segment With Earlier Timestamp Msg',
        segmentOrder: 2,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000002000,
        archivedAt: null,
        messageCount: 1
      }

      const msgInSeg0LaterTs: MessageDto = {
        id: '88888888-8888-4888-8888-888888888801',
        conversationId: validConvId,
        segmentId: seg0.id,
        role: 'user',
        content: 'Message in segment 0 with later timestamp',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: 1700000050000
      }
      const msgInSeg2EarlierTs: MessageDto = {
        id: '88888888-8888-4888-8888-888888888802',
        conversationId: validConvId,
        segmentId: seg2.id,
        role: 'user',
        content: 'Message in segment 2 with earlier timestamp',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: 1700000010000
      }
      const unsegmentedMsg: MessageDto = {
        id: '88888888-8888-4888-8888-888888888803',
        conversationId: validConvId,
        segmentId: null,
        role: 'assistant',
        content: 'Recent unsegmented turn',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: 1700000060000
      }

      const groups = groupMessagesBySegments(
        [seg2, seg0, seg1Empty],
        [msgInSeg2EarlierTs, unsegmentedMsg, msgInSeg0LaterTs]
      )
      expect(groups).toHaveLength(4)
      expect(groups[0].segment?.id).toBe(seg0.id)
      expect(groups[0].messages.map((m) => m.id)).toEqual([msgInSeg0LaterTs.id])
      expect(groups[1].segment?.id).toBe(seg1Empty.id)
      expect(groups[1].messages).toEqual([])
      expect(groups[2].segment?.id).toBe(seg2.id)
      expect(groups[2].messages.map((m) => m.id)).toEqual([msgInSeg2EarlierTs.id])
      expect(groups[3].segment).toBeNull()
      expect(groups[3].messages.map((m) => m.id)).toEqual([unsegmentedMsg.id])

      const ordered = orderMessagesRespectingSegments(
        [msgInSeg2EarlierTs, unsegmentedMsg, msgInSeg0LaterTs],
        [seg2, seg0, seg1Empty]
      )
      expect(ordered.map((m) => m.id)).toEqual([
        msgInSeg0LaterTs.id,
        msgInSeg2EarlierTs.id,
        unsegmentedMsg.id
      ])
    })
  })

  describe('Step 12.4: messageMetadataSchema groundingMode persistence validation', () => {
    it('accepts valid groundingMode metadata values and rejects unknown values', () => {
      const valid = messageMetadataSchema.parse({
        providerId: 'openai',
        modelId: 'gpt-4o',
        groundingMode: 'kb_partial_with_general_fallback'
      })
      expect(valid.groundingMode).toBe('kb_partial_with_general_fallback')

      const roundtripped = deserializeMessageMetadata(serializeMessageMetadata(valid))
      expect(roundtripped).toEqual(valid)

      expect(() =>
        messageMetadataSchema.parse({
          groundingMode: 'fabricated_mode'
        })
      ).toThrow()
    })
  })

  describe('Step 12.5: messageMetadataSchema claim provenance persistence & malformed fallback', () => {
    it('validates structured per-claim provenance references and safely rejects malformed provenance payloads', () => {
      const claimMeta = messageMetadataSchema.parse({
        providerId: 'openai',
        modelId: 'gpt-4o',
        groundingMode: 'kb_partial_with_general_fallback',
        claims: [
          {
            claimId: 'claim-1',
            claimText: 'MFA is required for administrative access.',
            provenance: 'kb_supported',
            validationStatus: 'validated',
            evidenceReferences: [
              {
                knowledgeBaseId: '11111111-1111-4111-8111-111111111111',
                sourceId: '22222222-2222-4222-8222-222222222222',
                chunkId: '33333333-3333-4333-8333-333333333333',
                citationNumber: 1,
                fileName: 'security.pdf',
                fileType: 'pdf',
                pageNumber: 2,
                headingPath: ['Access'],
                chunkIndex: 0
              }
            ]
          },
          {
            claimId: 'claim-2',
            claimText: 'Password managers help engineers avoid credential reuse.',
            provenance: 'general_knowledge',
            validationStatus: 'not_checked',
            evidenceReferences: []
          }
        ]
      })

      const roundtripped = deserializeMessageMetadata(serializeMessageMetadata(claimMeta))
      expect(roundtripped.claims).toHaveLength(2)
      expect(roundtripped.claims?.[0].evidenceReferences[0].sourceId).toBe(
        '22222222-2222-4222-8222-222222222222'
      )

      // Malformed claim provenance degrades safely to empty metadata on deserialize
      const corrupt = deserializeMessageMetadata(
        JSON.stringify({
          claims: [{ claimId: 'c1', provenance: 'fake_provenance', validationStatus: 'validated' }]
        })
      )
      expect(corrupt).toEqual({})
    })
  })
})
