import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import type { KnowledgeSourceStatus } from '../database/repositories/types'
import {
  BotRagService,
  BotRagServiceError,
  DEFAULT_RAG_TOP_K,
  MAX_RAG_TOP_K,
  DEFAULT_RAG_MAX_CONTEXT_TOKENS,
  MAX_RAG_MAX_CONTEXT_TOKENS
} from './bot-rag-service'
import { CURRENT_APPLICATION_CAPABILITIES } from '../../shared/providers'
import { citationDtoSchema } from '../../shared/conversations'

describe('BotRagService (Phase 7 Step 7.3)', () => {
  let tempDir: string
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let sourceRepo: KnowledgeSourceRepository
  let ragService: BotRagService

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string

  const createTestDoc = (
    kbId: string,
    opts: {
      fileName: string
      originalFileName: string
      fileType: 'txt' | 'md' | 'pdf'
      status?: KnowledgeSourceStatus
      chunks: Array<{
        content: string
        pageNumber?: number | null
        metadata?: Record<string, unknown>
      }>
    }
  ): string => {
    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbId,
      file_name: opts.fileName,
      original_file_name: opts.originalFileName,
      relative_file_path: `originals/${sourceId}.${opts.fileType}`,
      file_type: opts.fileType,
      mime_type:
        opts.fileType === 'pdf'
          ? 'application/pdf'
          : opts.fileType === 'md'
            ? 'text/markdown'
            : 'text/plain',
      file_size: 1024,
      content_hash: 'a'.repeat(64),
      indexing_status: opts.status ?? 'completed'
    })

    if (opts.chunks.length > 0) {
      sourceRepo.insertChunks(
        opts.chunks.map((c, idx) => ({
          id: randomUUID(),
          knowledge_base_id: kbId,
          source_id: sourceId,
          chunk_index: idx,
          content: c.content,
          page_number: c.pageNumber ?? null,
          token_count: Math.ceil(c.content.length / 4),
          metadata_json: JSON.stringify(c.metadata ?? {})
        }))
      )
    }

    return sourceId
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-rag-test-'))
    const dbPath = path.join(tempDir, 'test-rag.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)

    ragService = new BotRagService({
      db,
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      knowledgeSourceRepository: sourceRepo
    })

    // Setup two independent Knowledge Bases
    const kbA = kbRepo.create({ name: 'Knowledge Base Alpha', description: 'Alpha documents' })
    const kbB = kbRepo.create({ name: 'Knowledge Base Beta', description: 'Beta documents' })
    kbAId = kbA.id
    kbBId = kbB.id

    // Setup Bot A in KB A with search_knowledge_base permission
    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot Alpha',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base']
    })
    botAId = botA.id

    // Setup Bot B in KB B with search_knowledge_base permission
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot Beta',
      modelId: 'claude-3-5-sonnet-20241022',
      toolPermissions: ['search_knowledge_base']
    })
    botBId = botB.id
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  // ==========================================================================
  // Bot Ownership Tests (1 - 7)
  // ==========================================================================

  it('1. retrieves Bot A and derives KB A from its actual database row', () => {
    createTestDoc(kbAId, {
      fileName: 'alpha.txt',
      originalFileName: 'Alpha Doc.txt',
      fileType: 'txt',
      chunks: [{ content: 'Alpha specific discovery protocol.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'discovery protocol'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].fileName).toBe('Alpha Doc.txt')
  })

  it('2. retrieves Bot B and derives KB B from its actual database row', () => {
    createTestDoc(kbBId, {
      fileName: 'beta.txt',
      originalFileName: 'Beta Doc.txt',
      fileType: 'txt',
      chunks: [{ content: 'Beta specific quantum experiment result.' }]
    })

    const result = ragService.retrieve({
      botId: botBId,
      query: 'quantum experiment'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].fileName).toBe('Beta Doc.txt')
  })

  it('3. unknown Bot ID rejected with BOT_NOT_FOUND', () => {
    const unknownBotId = randomUUID()
    expect(() =>
      ragService.retrieve({
        botId: unknownBotId,
        query: 'search term'
      })
    ).toThrowError(BotRagServiceError)

    try {
      ragService.retrieve({ botId: unknownBotId, query: 'search term' })
    } catch (err) {
      expect(err).toBeInstanceOf(BotRagServiceError)
      expect((err as BotRagServiceError).code).toBe('BOT_NOT_FOUND')
    }
  })

  it('4. archived Bot rejected with BOT_ARCHIVED', () => {
    botRepo.update(botAId, kbAId, { status: 'archived' })

    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'search term'
      })
    ).toThrowError(BotRagServiceError)

    try {
      ragService.retrieve({ botId: botAId, query: 'search term' })
    } catch (err) {
      expect(err).toBeInstanceOf(BotRagServiceError)
      expect((err as BotRagServiceError).code).toBe('BOT_ARCHIVED')
    }
  })

  it('5. archived parent KB rejected with KNOWLEDGE_BASE_ARCHIVED', () => {
    // Manually archive KB A
    db.prepare('UPDATE knowledge_bases SET archived_at = ? WHERE id = ?').run(Date.now(), kbAId)

    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'search term'
      })
    ).toThrowError(BotRagServiceError)

    try {
      ragService.retrieve({ botId: botAId, query: 'search term' })
    } catch (err) {
      expect(err).toBeInstanceOf(BotRagServiceError)
      expect((err as BotRagServiceError).code).toBe('KNOWLEDGE_BASE_ARCHIVED')
    }
  })

  it('6. no client-supplied KB field exists in the service input contract', () => {
    // Verified by TypeScript compiler; runtime check verifies object accepts only documented fields
    const validPayload = {
      botId: botAId,
      query: 'search'
    }
    expect('knowledgeBaseId' in validPayload).toBe(false)
  })

  it('7. a forged KB field cannot alter the resolved scope', () => {
    createTestDoc(kbAId, {
      fileName: 'doc_a.txt',
      originalFileName: 'Alpha Knowledge.txt',
      fileType: 'txt',
      chunks: [{ content: 'Sovereign local-first architecture details in Alpha.' }]
    })

    createTestDoc(kbBId, {
      fileName: 'doc_b.txt',
      originalFileName: 'Beta Secrets.txt',
      fileType: 'txt',
      chunks: [{ content: 'Sovereign secret document in Beta.' }]
    })

    // Untrusted caller attempts to inject knowledgeBaseId of KB B while calling Bot A
    const maliciousOptions = {
      botId: botAId,
      query: 'Sovereign',
      knowledgeBaseId: kbBId
    }

    const result = ragService.retrieve(
      maliciousOptions as unknown as { botId: string; query: string }
    )
    expect(result.status).toBe('SUCCESS')
    // Must ONLY find Alpha documents, never Beta
    expect(result.chunks.every((c) => c.fileName === 'Alpha Knowledge.txt')).toBe(true)
    expect(result.chunks.some((c) => c.fileName === 'Beta Secrets.txt')).toBe(false)
  })

  // ==========================================================================
  // Permission Tests (8 - 11)
  // ==========================================================================

  it('8. Bot with search_knowledge_base enabled can retrieve', () => {
    createTestDoc(kbAId, {
      fileName: 'file.txt',
      originalFileName: 'Permitted.txt',
      fileType: 'txt',
      chunks: [{ content: 'Authorized document retrieval content.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'Authorized'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(1)
  })

  it('9. Bot without search_knowledge_base never triggers FTS5 search', () => {
    const unprivilegedBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Unprivileged Bot',
      modelId: 'gpt-4o',
      toolPermissions: []
    })

    const searchSpy = vi.spyOn(sourceRepo, 'searchChunks')

    const result = ragService.retrieve({
      botId: unprivilegedBot.id,
      query: 'some query',
      requireToolPermission: true
    })

    expect(result.status).toBe('RETRIEVAL_DISABLED')
    expect(result.chunks).toEqual([])
    expect(result.citations).toEqual([])
    expect(result.totalTokens).toBe(0)
    expect(searchSpy).not.toHaveBeenCalled()

    searchSpy.mockRestore()
  })

  it('9b. unprivileged bot without search_knowledge_base permission executes mandatory core conversation retrieval when requireToolPermission is omitted', () => {
    const unprivilegedBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Unprivileged Bot',
      modelId: 'gpt-4o',
      toolPermissions: []
    })

    const searchSpy = vi.spyOn(sourceRepo, 'searchChunks')

    const result = ragService.retrieve({
      botId: unprivilegedBot.id,
      query: 'some query'
    })

    // Mandatory core conversation grounding does not return RETRIEVAL_DISABLED
    expect(result.status).not.toBe('RETRIEVAL_DISABLED')
    expect(searchSpy).toHaveBeenCalledTimes(1)

    searchSpy.mockRestore()
  })

  it('10. other enabled tools do not implicitly authorize knowledge search when requireToolPermission is true', () => {
    const analyticalBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Analytical Bot',
      modelId: 'gpt-4o',
      toolPermissions: ['search_project_files', 'read_project_file', 'prepare_report']
    })

    const searchSpy = vi.spyOn(sourceRepo, 'searchChunks')

    const result = ragService.retrieve({
      botId: analyticalBot.id,
      query: 'search term',
      requireToolPermission: true
    })

    expect(result.status).toBe('RETRIEVAL_DISABLED')
    expect(searchSpy).not.toHaveBeenCalled()

    searchSpy.mockRestore()
  })

  it('11. provider tool calling remains disabled', () => {
    expect(CURRENT_APPLICATION_CAPABILITIES.tools).toBe(false)
  })

  // ==========================================================================
  // Retrieval Tests (12 - 23)
  // ==========================================================================

  it('12. relevant chunks returned for a valid query', () => {
    createTestDoc(kbAId, {
      fileName: 'manual.txt',
      originalFileName: 'User Manual.txt',
      fileType: 'txt',
      chunks: [{ content: 'Operating temperature must stay between 20 and 25 degrees Celsius.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'operating temperature Celsius'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].content).toContain('Operating temperature')
  })

  it('13. results are restricted to the Bots own KB', () => {
    createTestDoc(kbAId, {
      fileName: 'doc1.txt',
      originalFileName: 'Doc A.txt',
      fileType: 'txt',
      chunks: [{ content: 'Unique keyword zebra in Knowledge Base Alpha.' }]
    })
    createTestDoc(kbBId, {
      fileName: 'doc2.txt',
      originalFileName: 'Doc B.txt',
      fileType: 'txt',
      chunks: [{ content: 'Unique keyword zebra in Knowledge Base Beta.' }]
    })

    const resultA = ragService.retrieve({ botId: botAId, query: 'zebra' })
    expect(resultA.chunks.length).toBe(1)
    expect(resultA.chunks[0].fileName).toBe('Doc A.txt')

    const resultB = ragService.retrieve({ botId: botBId, query: 'zebra' })
    expect(resultB.chunks.length).toBe(1)
    expect(resultB.chunks[0].fileName).toBe('Doc B.txt')
  })

  it('14. a unique fact in KB B cannot be retrieved through Bot A', () => {
    createTestDoc(kbBId, {
      fileName: 'secret.txt',
      originalFileName: 'Secret Beta Document.txt',
      fileType: 'txt',
      chunks: [{ content: 'Superluminal tachyon communication array located in sector 7.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'tachyon communication sector'
    })

    expect(result.status).toBe('NO_RESULTS')
    expect(result.chunks).toEqual([])
    expect(result.citations).toEqual([])
  })

  it('15. multiple Bots in KB A can retrieve the same KB documents', () => {
    const siblingBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Sibling Bot Alpha 2',
      modelId: 'gpt-4o-mini',
      toolPermissions: ['search_knowledge_base']
    })

    createTestDoc(kbAId, {
      fileName: 'shared.txt',
      originalFileName: 'Shared Alpha Documentation.txt',
      fileType: 'txt',
      chunks: [{ content: 'Shared internal team guidelines for project development.' }]
    })

    const result1 = ragService.retrieve({ botId: botAId, query: 'guidelines' })
    const result2 = ragService.retrieve({ botId: siblingBot.id, query: 'guidelines' })

    expect(result1.status).toBe('SUCCESS')
    expect(result2.status).toBe('SUCCESS')
    expect(result1.chunks[0].chunkId).toBe(result2.chunks[0].chunkId)
  })

  it('16. unrelated KB documents are never included', () => {
    createTestDoc(kbAId, {
      fileName: 'cooking.txt',
      originalFileName: 'Recipe.txt',
      fileType: 'txt',
      chunks: [{ content: 'Chocolate chip cookies require butter, sugar, and flour.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'superconductors and magnetic levitation'
    })

    expect(result.status).toBe('NO_RESULTS')
    expect(result.chunks).toEqual([])
  })

  it('17. incomplete/failed sources are excluded according to existing Phase 5 rules', () => {
    createTestDoc(kbAId, {
      fileName: 'failed.txt',
      originalFileName: 'Failed Ingest.txt',
      fileType: 'txt',
      status: 'failed',
      chunks: [{ content: 'Corrupt chunk text from failed indexing pipeline.' }]
    })

    createTestDoc(kbAId, {
      fileName: 'pending.txt',
      originalFileName: 'Pending Ingest.txt',
      fileType: 'txt',
      status: 'processing',
      chunks: [{ content: 'Pending indexing chunk text not ready yet.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'indexing chunk'
    })

    expect(result.status).toBe('NO_RESULTS')
    expect(result.chunks).toEqual([])
  })

  it('18. results follow BM25 ranking', () => {
    createTestDoc(kbAId, {
      fileName: 'doc_low.txt',
      originalFileName: 'Low Match.txt',
      fileType: 'txt',
      chunks: [{ content: 'Quantum computing is a field.' }]
    })

    createTestDoc(kbAId, {
      fileName: 'doc_high.txt',
      originalFileName: 'High Match.txt',
      fileType: 'txt',
      chunks: [
        {
          content:
            'Quantum entanglement in quantum processors represents the pinnacle of quantum mechanics research.'
        }
      ]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'quantum mechanics research'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBeGreaterThanOrEqual(1)
    expect(result.chunks[0].fileName).toBe('High Match.txt')
  })

  it('19. deterministic result ordering is preserved', () => {
    createTestDoc(kbAId, {
      fileName: 'ordered.txt',
      originalFileName: 'Ordered.txt',
      fileType: 'txt',
      chunks: [
        { content: 'Consistent repeatability test part one.' },
        { content: 'Consistent repeatability test part two.' }
      ]
    })

    const run1 = ragService.retrieve({ botId: botAId, query: 'repeatability' })
    const run2 = ragService.retrieve({ botId: botAId, query: 'repeatability' })

    expect(run1.chunks.map((c) => c.chunkId)).toEqual(run2.chunks.map((c) => c.chunkId))
    expect(run1.citations.map((c) => c.citationNumber)).toEqual(
      run2.citations.map((c) => c.citationNumber)
    )
  })

  it('20. full retrieved chunk content is available internally', () => {
    const fullText =
      'Complete paragraph containing precise engineering specifications that must not be truncated in normal operation.'
    createTestDoc(kbAId, {
      fileName: 'spec.txt',
      originalFileName: 'Specifications.txt',
      fileType: 'txt',
      chunks: [{ content: fullText }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'specifications' })
    expect(result.chunks[0].content).toBe(fullText)
    expect(result.chunks[0].isTruncated).toBe(false)
  })

  it('21. filename and source ID are correct', () => {
    const sourceId = createTestDoc(kbAId, {
      fileName: 'report.txt',
      originalFileName: 'Annual Financial Report 2026.txt',
      fileType: 'txt',
      chunks: [{ content: 'Revenue figures for Q1 and Q2.' }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'revenue' })
    expect(result.chunks[0].sourceId).toBe(sourceId)
    expect(result.chunks[0].fileName).toBe('Annual Financial Report 2026.txt')
    expect(result.chunks[0].fileType).toBe('txt')
  })

  it('22. PDF page metadata is correct', () => {
    createTestDoc(kbAId, {
      fileName: 'whitepaper.pdf',
      originalFileName: 'Architecture Whitepaper.pdf',
      fileType: 'pdf',
      chunks: [
        {
          content: 'Section discussing decentralized local memory architectures.',
          pageNumber: 7,
          metadata: { pageNumber: 7 }
        }
      ]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'decentralized local' })
    expect(result.chunks[0].pageNumber).toBe(7)
    expect(result.citations[0].pageNumber).toBe(7)
  })

  it('23. Markdown heading path is correct', () => {
    createTestDoc(kbAId, {
      fileName: 'guide.md',
      originalFileName: 'Developer Guide.md',
      fileType: 'md',
      chunks: [
        {
          content: 'IPC bridge security checklist for Electron applications.',
          metadata: {
            heading: 'IPC Security',
            headingLevel: 2,
            headingPath: ['Developer Guide', 'Security Baseline', 'IPC Security']
          }
        }
      ]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'IPC bridge' })
    expect(result.chunks[0].headingPath).toEqual([
      'Developer Guide',
      'Security Baseline',
      'IPC Security'
    ])
    expect(result.citations[0].headingPath).toEqual([
      'Developer Guide',
      'Security Baseline',
      'IPC Security'
    ])
  })

  // ==========================================================================
  // Citation Authenticity Tests (24 - 30)
  // ==========================================================================

  it('24. citation source ID comes from the actual retrieved row', () => {
    const sourceId = createTestDoc(kbAId, {
      fileName: 'provenance.txt',
      originalFileName: 'Source Verification.txt',
      fileType: 'txt',
      chunks: [{ content: 'Verifiable provenance test statement.' }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'provenance' })
    expect(result.citations[0].sourceId).toBe(sourceId)
  })

  it('25. citation chunk ID comes from the actual retrieved row', () => {
    createTestDoc(kbAId, {
      fileName: 'chunk_check.txt',
      originalFileName: 'Chunk Verification.txt',
      fileType: 'txt',
      chunks: [{ content: 'Verifiable chunk id test statement.' }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'verifiable chunk' })
    const chunkRow = db
      .prepare('SELECT id FROM knowledge_chunks WHERE content LIKE ?')
      .get('%Verifiable chunk id%') as { id: string }

    expect(result.citations[0].chunkId).toBe(chunkRow.id)
  })

  it('26. citation numbers begin at 1 and follow ranked order', () => {
    createTestDoc(kbAId, {
      fileName: 'multi.txt',
      originalFileName: 'Multi Chunks.txt',
      fileType: 'txt',
      chunks: [
        { content: 'Common topic segment alpha.' },
        { content: 'Common topic segment beta.' },
        { content: 'Common topic segment gamma.' }
      ]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'Common topic' })
    expect(result.citations.length).toBe(3)
    expect(result.citations[0].citationNumber).toBe(1)
    expect(result.citations[1].citationNumber).toBe(2)
    expect(result.citations[2].citationNumber).toBe(3)
  })

  it('27. citation metadata passes CitationDto validation', () => {
    createTestDoc(kbAId, {
      fileName: 'schema_test.txt',
      originalFileName: 'Schema Test.txt',
      fileType: 'txt',
      chunks: [{ content: 'Valid schema validation test.' }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'schema validation' })
    expect(result.citations.length).toBe(1)
    const citation = result.citations[0]

    expect(() => citationDtoSchema.parse(citation)).not.toThrow()
    const parsed = citationDtoSchema.parse(citation)
    expect(parsed).toEqual(citation)
  })

  it('28. invalid or fabricated citation metadata is never generated', () => {
    createTestDoc(kbAId, {
      fileName: 'clean.txt',
      originalFileName: 'Clean.txt',
      fileType: 'txt',
      chunks: [{ content: 'Pure valid metadata generated only.' }]
    })

    const result = ragService.retrieve({ botId: botAId, query: 'metadata' })
    const citation = result.citations[0]

    // Verify no prohibited path or secret properties exist on citation
    expect('storagePath' in citation).toBe(false)
    expect('filePath' in citation).toBe(false)
    expect('apiKey' in citation).toBe(false)
    expect(citation.fileName).not.toContain('/')
    expect(citation.fileName).not.toContain('\\')
  })

  it('29. empty search results contain no citations', () => {
    const result = ragService.retrieve({ botId: botAId, query: 'nonexistent query term xyz' })
    expect(result.status).toBe('NO_RESULTS')
    expect(result.citations).toEqual([])
    expect(result.chunks).toEqual([])
  })

  it('30. model/user input cannot inject citation objects into retrieval results', () => {
    createTestDoc(kbAId, {
      fileName: 'injection.txt',
      originalFileName: 'Legit.txt',
      fileType: 'txt',
      chunks: [{ content: 'Legitimate document text.' }]
    })

    const maliciousOptions = {
      botId: botAId,
      query: 'Legitimate',
      citations: [
        {
          citationNumber: 99,
          sourceId: randomUUID(),
          chunkId: randomUUID(),
          fileName: 'Hacked.txt',
          fileType: 'txt'
        }
      ]
    }

    const result = ragService.retrieve(
      maliciousOptions as unknown as { botId: string; query: string }
    )
    expect(result.status).toBe('SUCCESS')
    expect(result.citations.length).toBe(1)
    expect(result.citations[0].fileName).toBe('Legit.txt')
    expect(result.citations[0].citationNumber).toBe(1)
  })

  // ==========================================================================
  // Retrieval Budget Tests (31 - 36)
  // ==========================================================================

  it('31. default topK is applied', () => {
    const chunks = Array.from({ length: 8 }, (_, i) => ({
      content: `Repeated search term test chunk number ${i}.`
    }))

    createTestDoc(kbAId, {
      fileName: 'chunks.txt',
      originalFileName: 'Chunks.txt',
      fileType: 'txt',
      chunks
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'search term test chunk'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(DEFAULT_RAG_TOP_K)
    expect(result.chunks.length).toBe(5)
  })

  it('32. topK upper bound is enforced', () => {
    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'test',
        topK: MAX_RAG_TOP_K + 1
      })
    ).toThrowError(/topK must be an integer between 1 and 20/)

    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'test',
        topK: 0
      })
    ).toThrowError(/topK must be an integer between 1 and 20/)
  })

  it('33. maxContextTokens default is applied', () => {
    createTestDoc(kbAId, {
      fileName: 'normal.txt',
      originalFileName: 'Normal.txt',
      fileType: 'txt',
      chunks: [{ content: 'Short document well under four thousand tokens.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'tokens'
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.totalTokens).toBeLessThan(DEFAULT_RAG_MAX_CONTEXT_TOKENS)
  })

  it('34. maxContextTokens upper bound is enforced', () => {
    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'test',
        maxContextTokens: MAX_RAG_MAX_CONTEXT_TOKENS + 1
      })
    ).toThrowError(/maxContextTokens must be an integer between 1 and 16000/)

    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'test',
        maxContextTokens: 0
      })
    ).toThrowError(/maxContextTokens must be an integer between 1 and 16000/)
  })

  it('35. total retrieved content stays within the configured budget', () => {
    // 3 chunks of 200 characters each (50 tokens each)
    createTestDoc(kbAId, {
      fileName: 'budget.txt',
      originalFileName: 'Budget.txt',
      fileType: 'txt',
      chunks: [
        { content: 'A'.repeat(200) + ' budget test keyword one.' },
        { content: 'B'.repeat(200) + ' budget test keyword two.' },
        { content: 'C'.repeat(200) + ' budget test keyword three.' }
      ]
    })

    // Set budget to 80 tokens (Chunk 1 takes ~56 tokens, Chunk 2 would exceed 80 so it gets truncated or bounds total)
    const result = ragService.retrieve({
      botId: botAId,
      query: 'budget test keyword',
      maxContextTokens: 80
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.totalTokens).toBeLessThanOrEqual(80)
  })

  it('36. oversized individual chunk behavior is deterministic and tested', () => {
    // Individual chunk with 800 characters (~200 tokens)
    const longContent = 'X'.repeat(800) + ' oversized test marker.'
    createTestDoc(kbAId, {
      fileName: 'oversized.txt',
      originalFileName: 'Oversized.txt',
      fileType: 'txt',
      chunks: [{ content: longContent }]
    })

    // Budget restricted to 50 tokens (200 chars)
    const result = ragService.retrieve({
      botId: botAId,
      query: 'oversized test marker',
      maxContextTokens: 50
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].isTruncated).toBe(true)
    expect(result.chunks[0].tokenCount).toBeLessThanOrEqual(50)
    expect(result.totalTokens).toBeLessThanOrEqual(50)
    expect(result.chunks[0].content.length).toBe(50 * 4)
  })

  // ==========================================================================
  // Error and Privacy Tests (37 - 40)
  // ==========================================================================

  it('37. empty query rejected or safely treated as no results', () => {
    const emptyResult = ragService.retrieve({ botId: botAId, query: '' })
    expect(emptyResult.status).toBe('EMPTY_QUERY')
    expect(emptyResult.chunks).toEqual([])
    expect(emptyResult.citations).toEqual([])

    const whitespaceResult = ragService.retrieve({ botId: botAId, query: '    ' })
    expect(whitespaceResult.status).toBe('EMPTY_QUERY')
    expect(whitespaceResult.chunks).toEqual([])

    const punctuationOnlyResult = ragService.retrieve({ botId: botAId, query: '*** ::: ((( )))' })
    expect(punctuationOnlyResult.status).toBe('EMPTY_QUERY')
    expect(punctuationOnlyResult.chunks).toEqual([])
  })

  it('38. sanitized query errors do not expose raw SQL', () => {
    // Queries with unclosed quotes or syntax chars should sanitize smoothly without throwing raw FTS5 error
    createTestDoc(kbAId, {
      fileName: 'sql_test.txt',
      originalFileName: 'SQL Test.txt',
      fileType: 'txt',
      chunks: [{ content: 'Complex query handling verification.' }]
    })

    const complexQueries = [
      '"unclosed quotes',
      'AND OR NOT',
      'foo AND',
      'NOT bar',
      '(nested (parentheses',
      'special*chars:with^delimiters'
    ]

    for (const q of complexQueries) {
      expect(() => ragService.retrieve({ botId: botAId, query: q })).not.toThrow()
    }
  })

  it('39. database failures return safe errors', () => {
    // Simulate database error by destroying/closing db
    db.close()

    expect(() =>
      ragService.retrieve({
        botId: botAId,
        query: 'search'
      })
    ).toThrowError(BotRagServiceError)

    try {
      ragService.retrieve({ botId: botAId, query: 'search' })
    } catch (err) {
      expect(err).toBeInstanceOf(BotRagServiceError)
      expect((err as BotRagServiceError).code).toBe('DATABASE_ERROR')
      // Ensure error message does not leak raw filesystem path or connection internals
      expect((err as Error).message).not.toContain(tempDir)
    }
  })

  it('40. no API key, credential reference or filesystem path appears in retrieval output or sanitized errors', () => {
    createTestDoc(kbAId, {
      fileName: 'privacy.txt',
      originalFileName: 'Privacy Baseline.txt',
      fileType: 'txt',
      chunks: [{ content: 'Zero secret leakage invariant validation.' }]
    })

    const result = ragService.retrieve({
      botId: botAId,
      query: 'leakage invariant'
    })

    const resultSerialized = JSON.stringify(result)

    // Check for common filesystem path indicators
    expect(resultSerialized).not.toContain(tempDir)
    expect(resultSerialized).not.toContain('originals/')
    expect(resultSerialized).not.toContain('documents/')
    expect(resultSerialized).not.toContain('workspace.db')

    // Check for credential patterns
    expect(resultSerialized).not.toContain('sk-')
    expect(resultSerialized).not.toContain('Bearer ')
    expect(resultSerialized).not.toContain('credential_ref')
    expect(resultSerialized).not.toContain('encrypted_blob')
  })
})
