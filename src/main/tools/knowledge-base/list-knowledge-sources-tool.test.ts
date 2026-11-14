import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { ToolRegistry } from '../tool-registry'
import {
  ListKnowledgeSourcesTool,
  type ListKnowledgeSourcesResult
} from './list-knowledge-sources-tool'
import { ToolValidationError, ToolPermissionError } from '../agent-tool'

describe('ListKnowledgeSourcesTool (Phase 8 Step 8.2)', () => {
  let testContext: MigratedTestDatabaseContext
  let sourceRepo: KnowledgeSourceRepository
  let tool: ListKnowledgeSourcesTool
  let registry: ToolRegistry

  let kbAId: string
  let kbBId: string
  let kbEmptyId: string
  let botAId: string
  let botALegacyId: string
  let botNoPermId: string
  let botEmptyKbId: string
  let sourceA1Id: string
  let sourceA2Id: string
  let sourceBId: string

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    sourceRepo = new KnowledgeSourceRepository(testContext.db)
    tool = new ListKnowledgeSourcesTool(sourceRepo)

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
    const kbEmpty = testContext.kbRepo.create({ name: 'KB Empty' })
    kbEmptyId = kbEmpty.id

    // Bots
    const botA = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A Canonical',
      modelId: 'gpt-4o',
      toolPermissions: ['list_knowledge_sources']
    })
    botAId = botA.id

    // Bot with legacy permission alias
    const botLegacy = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A Legacy',
      modelId: 'gpt-4o',
      toolPermissions: ['list_knowledge_base_documents']
    })
    botALegacyId = botLegacy.id

    const botNoPerm = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot No Perm',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermId = botNoPerm.id

    const botEmpty = testContext.botRepo.create({
      knowledgeBaseId: kbEmptyId,
      name: 'Bot Empty KB',
      modelId: 'gpt-4o',
      toolPermissions: ['list_knowledge_sources']
    })
    botEmptyKbId = botEmpty.id

    // Documents in KB A
    sourceA1Id = randomUUID()
    sourceRepo.create({
      id: sourceA1Id,
      knowledge_base_id: kbAId,
      file_name: 'doc1.pdf',
      original_file_name: 'Architecture Guide.pdf',
      relative_file_path: `originals/${sourceA1Id}.pdf`,
      file_type: 'pdf',
      mime_type: 'application/pdf',
      file_size: 4096,
      content_hash: createHash('sha256').update('doc1').digest('hex'),
      indexing_status: 'completed'
    })
    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceA1Id,
        chunk_index: 0,
        content: 'Architecture content',
        page_number: 1,
        token_count: 5,
        metadata_json: '{}'
      }
    ])
    sourceRepo.complete(sourceA1Id, kbAId)

    sourceA2Id = randomUUID()
    sourceRepo.create({
      id: sourceA2Id,
      knowledge_base_id: kbAId,
      file_name: 'doc2.txt',
      original_file_name: 'Notes.txt',
      relative_file_path: `originals/${sourceA2Id}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 512,
      content_hash: createHash('sha256').update('doc2').digest('hex'),
      indexing_status: 'completed'
    })
    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceA2Id,
        chunk_index: 0,
        content: 'Notes content',
        page_number: null,
        token_count: 4,
        metadata_json: '{}'
      }
    ])
    sourceRepo.complete(sourceA2Id, kbAId)

    // Document in KB B
    sourceBId = randomUUID()
    sourceRepo.create({
      id: sourceBId,
      knowledge_base_id: kbBId,
      file_name: 'docB.md',
      original_file_name: 'Secret Beta.md',
      relative_file_path: `originals/${sourceBId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 1024,
      content_hash: createHash('sha256').update('docB').digest('hex'),
      indexing_status: 'completed'
    })
  })

  afterEach(() => {
    testContext.cleanup()
  })

  it('1. lists documents in the parent Knowledge Base with chunk counts', async () => {
    const res = await registry.execute({
      toolName: 'list_knowledge_sources',
      botId: botAId,
      rawArguments: {}
    })

    const data = res.result as ListKnowledgeSourcesResult
    expect(data.totalSources).toBe(2)
    expect(data.returnedSources).toBe(2)
    expect(data.isTruncated).toBe(false)
    expect(data.sources).toHaveLength(2)

    const docNames = data.sources.map((s) => s.documentName)
    expect(docNames).toContain('Architecture Guide.pdf')
    expect(docNames).toContain('Notes.txt')

    const archDoc = data.sources.find((s) => s.documentName === 'Architecture Guide.pdf')!
    expect(archDoc.sourceId).toBe(sourceA1Id)
    expect(archDoc.fileType).toBe('pdf')
    expect(archDoc.indexingStatus).toBe('completed')
    expect(archDoc.chunkCount).toBe(1)
    expect(archDoc.fileSize).toBe(4096)

    expect(res.resultSummary).toBe('Found 2 document(s) in Knowledge Base')
  })

  it('2. operates cleanly when Bot has historical legacy permission alias', async () => {
    const res = await registry.execute({
      toolName: 'list_knowledge_sources',
      botId: botALegacyId,
      rawArguments: {}
    })

    const data = res.result as ListKnowledgeSourcesResult
    expect(data.totalSources).toBe(2)
  })

  it('3. enforces strict Knowledge Base isolation (documents in KB B are never listed)', async () => {
    const res = await registry.execute({
      toolName: 'list_knowledge_sources',
      botId: botAId,
      rawArguments: {}
    })

    const data = res.result as ListKnowledgeSourcesResult
    const ids = data.sources.map((s) => s.sourceId)
    expect(ids).not.toContain(sourceBId)
  })

  it('4. returns empty list cleanly when Knowledge Base has no documents', async () => {
    const res = await registry.execute({
      toolName: 'list_knowledge_sources',
      botId: botEmptyKbId,
      rawArguments: {}
    })

    const data = res.result as ListKnowledgeSourcesResult
    expect(data.totalSources).toBe(0)
    expect(data.returnedSources).toBe(0)
    expect(data.sources).toHaveLength(0)
    expect(res.resultSummary).toBe('Found 0 document(s) in Knowledge Base')
  })

  it('5. strictly rejects unexpected arguments in model input', async () => {
    await expect(
      registry.execute({
        toolName: 'list_knowledge_sources',
        botId: botAId,
        rawArguments: { knowledgeBaseId: kbBId }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('6. rejects execution when Bot permission is disabled', async () => {
    await expect(
      registry.execute({
        toolName: 'list_knowledge_sources',
        botId: botNoPermId,
        rawArguments: {}
      })
    ).rejects.toThrow(ToolPermissionError)
  })

  it('7. never exposes internal filesystem storage paths', async () => {
    const res = await registry.execute({
      toolName: 'list_knowledge_sources',
      botId: botAId,
      rawArguments: {}
    })

    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain('originals/')
    expect(serialized).not.toContain('workspace.db')
    expect(serialized).not.toContain('documents/')
  })
})
