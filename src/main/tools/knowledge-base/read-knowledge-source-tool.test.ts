import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { ToolRegistry } from '../tool-registry'
import {
  ReadKnowledgeSourceTool,
  type ReadKnowledgeSourceResult
} from './read-knowledge-source-tool'
import { ToolValidationError, ToolPermissionError, ToolExecutionError } from '../agent-tool'

describe('ReadKnowledgeSourceTool (Phase 8 Step 8.2)', () => {
  let testContext: MigratedTestDatabaseContext
  let sourceRepo: KnowledgeSourceRepository
  let tool: ReadKnowledgeSourceTool
  let registry: ToolRegistry

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botALegacyId: string
  let botNoPermId: string
  let sourceAId: string
  let sourceBId: string
  let unindexedSourceId: string

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    sourceRepo = new KnowledgeSourceRepository(testContext.db)
    tool = new ReadKnowledgeSourceTool(sourceRepo)

    registry = new ToolRegistry({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo
    })
    registry.register(tool)

    // Knowledge Bases
    const kbA = testContext.kbRepo.create({ name: 'KB A' })
    kbAId = kbA.id
    const kbB = testContext.kbRepo.create({ name: 'KB B' })
    kbBId = kbB.id

    // Bots
    const botA = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A Canonical',
      modelId: 'gpt-4o',
      toolPermissions: ['read_knowledge_source']
    })
    botAId = botA.id

    // Bot with legacy permission alias
    const botLegacy = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A Legacy',
      modelId: 'gpt-4o',
      toolPermissions: ['read_knowledge_base_document']
    })
    botALegacyId = botLegacy.id

    const botNoPerm = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot No Perm',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermId = botNoPerm.id

    // Source in KB A (Completed)
    sourceAId = randomUUID()
    sourceRepo.create({
      id: sourceAId,
      knowledge_base_id: kbAId,
      file_name: 'handbook.md',
      original_file_name: 'Employee Handbook.md',
      relative_file_path: `originals/${sourceAId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 2048,
      content_hash: createHash('sha256').update('handbook').digest('hex'),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceAId,
        chunk_index: 0,
        content: 'Section 1: Company Policies and Introduction.',
        page_number: 1,
        token_count: 8,
        metadata_json: JSON.stringify({ heading: 'Introduction' })
      },
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceAId,
        chunk_index: 1,
        content: 'Section 2: Work Hours, PTO, and Remote Collaboration.',
        page_number: 2,
        token_count: 10,
        metadata_json: JSON.stringify({ heading: 'Time Off' })
      },
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceAId,
        chunk_index: 2,
        content: 'Section 3: Security, Password Guidelines, and Clean Desk Policy.',
        page_number: 3,
        token_count: 11,
        metadata_json: JSON.stringify({ heading: 'Security' })
      }
    ])
    sourceRepo.complete(sourceAId, kbAId)

    // Source in KB B (Completed)
    sourceBId = randomUUID()
    sourceRepo.create({
      id: sourceBId,
      knowledge_base_id: kbBId,
      file_name: 'classified.md',
      original_file_name: 'Classified Beta.md',
      relative_file_path: `originals/${sourceBId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 1024,
      content_hash: createHash('sha256').update('classified').digest('hex'),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbBId,
        source_id: sourceBId,
        chunk_index: 0,
        content: 'Confidential document belonging to KB B only.',
        page_number: 1,
        token_count: 8,
        metadata_json: JSON.stringify({})
      }
    ])
    sourceRepo.complete(sourceBId, kbBId)

    // Unindexed Source in KB A (status = processing)
    unindexedSourceId = randomUUID()
    sourceRepo.create({
      id: unindexedSourceId,
      knowledge_base_id: kbAId,
      file_name: 'pending.md',
      original_file_name: 'Pending Document.md',
      relative_file_path: `originals/${unindexedSourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 100,
      content_hash: createHash('sha256').update('pending').digest('hex'),
      indexing_status: 'processing'
    })
  })

  afterEach(() => {
    testContext.cleanup()
  })

  it('1. reads document chunks and metadata in ascending chunk order', async () => {
    const res = await registry.execute({
      toolName: 'read_knowledge_source',
      botId: botAId,
      rawArguments: { sourceId: sourceAId }
    })

    const data = res.result as ReadKnowledgeSourceResult
    expect(data.sourceId).toBe(sourceAId)
    expect(data.documentName).toBe('Employee Handbook.md')
    expect(data.fileType).toBe('md')
    expect(data.indexingStatus).toBe('completed')
    expect(data.totalChunksInDocument).toBe(3)
    expect(data.chunksRead).toBe(3)
    expect(data.isTruncated).toBe(false)
    expect(data.chunks).toHaveLength(3)

    // Strict chunk index order verification
    expect(data.chunks[0].chunkIndex).toBe(0)
    expect(data.chunks[0].content).toContain('Section 1')
    expect(data.chunks[0].heading).toBe('Introduction')

    expect(data.chunks[1].chunkIndex).toBe(1)
    expect(data.chunks[1].content).toContain('Section 2')
    expect(data.chunks[1].heading).toBe('Time Off')

    expect(data.chunks[2].chunkIndex).toBe(2)
    expect(data.chunks[2].content).toContain('Section 3')
    expect(data.chunks[2].heading).toBe('Security')

    // Summary verification
    expect(res.resultSummary).toBe(
      'Read 3 chunk(s) from document "Employee Handbook.md" (total: 3 chunks)'
    )
  })

  it('2. operates cleanly when Bot has historical legacy permission alias', async () => {
    const res = await registry.execute({
      toolName: 'read_knowledge_source',
      botId: botALegacyId,
      rawArguments: { sourceId: sourceAId }
    })

    const data = res.result as ReadKnowledgeSourceResult
    expect(data.chunksRead).toBe(3)
  })

  it('3. rejects reading source belonging to another Knowledge Base with PERMISSION_DENIED', async () => {
    // Bot A tries to read sourceBId (which belongs to KB B)
    try {
      await registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: sourceBId }
      })
      expect.unreachable('Should have rejected cross-KB source reading')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).code).toBe('PERMISSION_DENIED')
      expect((err as ToolExecutionError).message).toContain(
        `does not belong to the bot's parent Knowledge Base`
      )
    }
  })

  it('4. rejects unknown or non-existent sourceId with EXECUTION_FAILED', async () => {
    const unknownId = randomUUID()
    try {
      await registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: unknownId }
      })
      expect.unreachable('Should have rejected non-existent sourceId')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).code).toBe('EXECUTION_FAILED')
      expect((err as ToolExecutionError).message).toContain('was not found')
    }
  })

  it('5. rejects invalid UUID strings for sourceId', async () => {
    await expect(
      registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: 'not-a-valid-uuid' }
      })
    ).rejects.toThrow(ToolExecutionError)

    try {
      await registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: 'not-a-valid-uuid' }
      })
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe('VALIDATION_FAILED')
    }
  })

  it('6. rejects reading an unindexed or processing document', async () => {
    try {
      await registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: unindexedSourceId }
      })
      expect.unreachable('Should have rejected unindexed source')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).message).toContain('is not fully indexed')
    }
  })

  it('7. bounds number of chunks when maxChunks is specified', async () => {
    const res = await registry.execute({
      toolName: 'read_knowledge_source',
      botId: botAId,
      rawArguments: { sourceId: sourceAId, maxChunks: 2 }
    })

    const data = res.result as ReadKnowledgeSourceResult
    expect(data.chunksRead).toBe(2)
    expect(data.totalChunksInDocument).toBe(3)
    expect(data.isTruncated).toBe(true)
    expect(data.chunks).toHaveLength(2)
    expect(res.resultSummary).toContain('truncated')
  })

  it('8. rejects maxChunks exceeding valid limits (1 to 50)', async () => {
    // 0 is below minimum
    await expect(
      registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: sourceAId, maxChunks: 0 }
      })
    ).rejects.toThrow(ToolValidationError)

    // 51 is above maximum
    await expect(
      registry.execute({
        toolName: 'read_knowledge_source',
        botId: botAId,
        rawArguments: { sourceId: sourceAId, maxChunks: 51 }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('9. rejects execution when Bot permission is disabled', async () => {
    await expect(
      registry.execute({
        toolName: 'read_knowledge_source',
        botId: botNoPermId,
        rawArguments: { sourceId: sourceAId }
      })
    ).rejects.toThrow(ToolPermissionError)
  })

  it('10. never exposes internal filesystem storage paths', async () => {
    const res = await registry.execute({
      toolName: 'read_knowledge_source',
      botId: botAId,
      rawArguments: { sourceId: sourceAId }
    })

    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain('originals/')
    expect(serialized).not.toContain('workspace.db')
    expect(serialized).not.toContain('documents/')
  })
})
