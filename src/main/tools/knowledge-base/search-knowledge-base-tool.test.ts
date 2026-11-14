import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { BotRagService } from '../../services/bot-rag-service'
import { ToolRegistry } from '../tool-registry'
import {
  SearchKnowledgeBaseTool,
  type SearchKnowledgeBaseResult
} from './search-knowledge-base-tool'
import { ToolValidationError, ToolPermissionError } from '../agent-tool'

describe('SearchKnowledgeBaseTool (Phase 8 Step 8.2)', () => {
  let testContext: MigratedTestDatabaseContext
  let sourceRepo: KnowledgeSourceRepository
  let ragService: BotRagService
  let tool: SearchKnowledgeBaseTool
  let registry: ToolRegistry

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string
  let botNoPermId: string
  let sourceAId: string
  let sourceBId: string

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    sourceRepo = new KnowledgeSourceRepository(testContext.db)
    ragService = new BotRagService({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo,
      knowledgeSourceRepository: sourceRepo
    })
    tool = new SearchKnowledgeBaseTool(ragService)

    registry = new ToolRegistry({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo
    })
    registry.register(tool)

    // Knowledge Bases
    const kbA = testContext.kbRepo.create({ name: 'KB Alpha' })
    kbAId = kbA.id
    const kbB = testContext.kbRepo.create({ name: 'KB Beta' })
    kbBId = kbB.id

    // Bots
    const botA = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot Alpha',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base']
    })
    botAId = botA.id

    const botB = testContext.botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot Beta',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base']
    })
    botBId = botB.id

    const botNoPerm = testContext.botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot No Perm',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermId = botNoPerm.id

    // Documents and Chunks in KB Alpha
    sourceAId = randomUUID()
    sourceRepo.create({
      id: sourceAId,
      knowledge_base_id: kbAId,
      file_name: 'alpha-security-guide.md',
      original_file_name: 'alpha-security-guide.md',
      relative_file_path: `originals/${sourceAId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 1024,
      content_hash: createHash('sha256').update('alpha-security-guide').digest('hex'),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceAId,
        chunk_index: 0,
        content:
          'Zero-trust architecture mandates strict validation for all external inputs and IPC frames.',
        page_number: 1,
        token_count: 14,
        metadata_json: JSON.stringify({
          heading: 'Zero Trust Principles',
          headingPath: ['Security', 'Zero Trust Principles']
        })
      },
      {
        id: randomUUID(),
        knowledge_base_id: kbAId,
        source_id: sourceAId,
        chunk_index: 1,
        content:
          'Electron applications must enforce contextIsolation true and disable nodeIntegration.',
        page_number: 2,
        token_count: 12,
        metadata_json: JSON.stringify({
          heading: 'Electron Hardening',
          headingPath: ['Security', 'Electron Hardening']
        })
      }
    ])
    sourceRepo.complete(sourceAId, kbAId)

    // Documents and Chunks in KB Beta (with overlapping terminology to verify strict isolation)
    sourceBId = randomUUID()
    sourceRepo.create({
      id: sourceBId,
      knowledge_base_id: kbBId,
      file_name: 'beta-secrets.md',
      original_file_name: 'beta-secrets.md',
      relative_file_path: `originals/${sourceBId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: 512,
      content_hash: createHash('sha256').update('beta-secrets').digest('hex'),
      indexing_status: 'completed'
    })

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbBId,
        source_id: sourceBId,
        chunk_index: 0,
        content: 'Confidential Beta project secrets: Top secret nuclear plans for Project Beta.',
        page_number: 1,
        token_count: 12,
        metadata_json: JSON.stringify({
          heading: 'Beta Classified',
          headingPath: ['Classified']
        })
      }
    ])
    sourceRepo.complete(sourceBId, kbBId)
  })

  afterEach(() => {
    testContext.cleanup()
  })

  it('1. performs successful search returning bounded excerpts and authentic citations', async () => {
    const res = await registry.execute({
      toolName: 'search_knowledge_base',
      botId: botAId,
      rawArguments: { query: 'zero-trust architecture', topK: 5 }
    })

    const data = res.result as SearchKnowledgeBaseResult
    expect(data.status).toBe('SUCCESS')
    expect(data.query).toBe('zero-trust architecture')
    expect(data.totalResults).toBeGreaterThan(0)
    expect(data.excerpts.length).toBeGreaterThan(0)

    const first = data.excerpts[0]
    expect(first.content).toContain('Zero-trust architecture mandates strict validation')
    expect(first.documentName).toBe('alpha-security-guide.md')
    expect(first.pageNumber).toBe(1)
    expect(first.headingPath).toEqual(['Security', 'Zero Trust Principles'])
    expect(first.citationLabel).toBe('[alpha-security-guide.md, p. 1, Chunk #1]')

    // Citations validation
    expect(data.citations.length).toBe(data.excerpts.length)
    expect(data.citations[0].fileName).toBe('alpha-security-guide.md')
    expect(data.citations[0].sourceId).toBe(sourceAId)

    // Summary verification
    expect(res.resultSummary).toContain('Found')
    expect(res.resultSummary).toContain('relevant excerpt(s) in Knowledge Base')
  })

  it('2. enforces strict parent Knowledge Base isolation (cross-KB search denied)', async () => {
    // Bot Alpha queries for Beta content
    const resA = await registry.execute({
      toolName: 'search_knowledge_base',
      botId: botAId,
      rawArguments: { query: 'nuclear plans Project Beta' }
    })

    const dataA = resA.result as SearchKnowledgeBaseResult
    expect(dataA.status).toBe('NO_RESULTS')
    expect(dataA.excerpts).toHaveLength(0)

    // Bot Beta queries for Beta content and finds it
    const resB = await registry.execute({
      toolName: 'search_knowledge_base',
      botId: botBId,
      rawArguments: { query: 'nuclear plans Project Beta' }
    })

    const dataB = resB.result as SearchKnowledgeBaseResult
    expect(dataB.status).toBe('SUCCESS')
    expect(dataB.excerpts.length).toBeGreaterThan(0)
    expect(dataB.excerpts[0].content).toContain('Confidential Beta project secrets')
  })

  it('3. rejects empty or whitespace-only search queries', async () => {
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: '' }
      })
    ).rejects.toThrow(ToolValidationError)

    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: '   ' }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('4. rejects queries exceeding maximum length', async () => {
    const longQuery = 'a'.repeat(501)
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: longQuery }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('5. enforces topK boundaries (1 to 20, integer only)', async () => {
    // 0 is invalid
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: 'test', topK: 0 }
      })
    ).rejects.toThrow(ToolValidationError)

    // 21 is invalid
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: 'test', topK: 21 }
      })
    ).rejects.toThrow(ToolValidationError)

    // Non-integer is invalid
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botAId,
        rawArguments: { query: 'test', topK: 2.5 }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('6. rejects tool execution when permission is disabled', async () => {
    await expect(
      registry.execute({
        toolName: 'search_knowledge_base',
        botId: botNoPermId,
        rawArguments: { query: 'zero-trust' }
      })
    ).rejects.toThrow(ToolPermissionError)
  })

  it('7. never exposes internal filesystem paths or database details', async () => {
    const res = await registry.execute({
      toolName: 'search_knowledge_base',
      botId: botAId,
      rawArguments: { query: 'Electron' }
    })

    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain('originals/')
    expect(serialized).not.toContain('workspace.db')
    expect(serialized).not.toContain('documents/')
  })

  it('8. handles empty query gracefully when all terms are removed by FTS5 sanitization', async () => {
    const res = await registry.execute({
      toolName: 'search_knowledge_base',
      botId: botAId,
      rawArguments: { query: '*** ::: ^^^' }
    })

    const data = res.result as SearchKnowledgeBaseResult
    expect(data.status).toBe('EMPTY_QUERY')
    expect(data.totalResults).toBe(0)
    expect(data.excerpts).toEqual([])
  })
})
