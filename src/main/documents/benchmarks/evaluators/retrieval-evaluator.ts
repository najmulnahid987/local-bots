import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../database/migrations/runner'
import { migrations } from '../../../database/migrations'
import { KnowledgeBaseRepository } from '../../../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../../../database/repositories/knowledge-source-repository'
import { BotRepository } from '../../../database/repositories/bot-repository'
import { BotRagService } from '../../../services/bot-rag-service'
import { SemanticChunker } from '../../chunking/semantic-chunker'
import { ExtractorRegistry } from '../../extractors/registry'
import { generateSyntheticCorpus } from '../fixtures/corpus-generator'
import { GOLDEN_RETRIEVAL_DATASET } from '../golden/qa-dataset'
import { GOLDEN_FIXTURE_MANIFEST } from '../golden/manifest'
import type {
  RetrievalAggregateMetrics,
  RetrievalMetricResult,
  BenchmarkResultStatus
} from '../types'

export interface RetrievalEvaluationOutput {
  readonly aggregateMetrics: RetrievalAggregateMetrics
  readonly detailedResults: readonly RetrievalMetricResult[]
  readonly crossKbIsolationVerified: boolean
}

/**
 * Evaluates FTS5 retrieval, Recall@K, MRR, heading-loss impact, and cross-KB isolation
 * against the golden Q&A dataset in an isolated SQLite environment.
 */
export class RetrievalEvaluator {
  private db: Database.Database | null = null
  private kbRepo!: KnowledgeBaseRepository
  private botRepo!: BotRepository
  private sourceRepo!: KnowledgeSourceRepository
  private ragService!: BotRagService
  private botAlphaId!: string
  private botBetaId!: string

  /**
   * Initializes SQLite database with migrations and seeds synthetic documents into Knowledge Bases.
   */
  public async setup(): Promise<void> {
    this.db = new Database(':memory:')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    runMigrations(this.db, migrations)

    this.kbRepo = new KnowledgeBaseRepository(this.db)
    this.botRepo = new BotRepository(this.db)
    this.sourceRepo = new KnowledgeSourceRepository(this.db)

    this.ragService = new BotRagService({
      db: this.db,
      botRepository: this.botRepo,
      knowledgeBaseRepository: this.kbRepo,
      knowledgeSourceRepository: this.sourceRepo
    })

    // 1. Create Knowledge Base Alpha and Knowledge Base Beta
    const kbAlpha = this.kbRepo.create({
      name: 'Benchmark KB Alpha',
      description: 'Primary evaluation corpus for Step 10.2'
    })

    const kbBeta = this.kbRepo.create({
      name: 'Benchmark KB Beta',
      description: 'Isolated secondary corpus for cross-KB security evaluation'
    })

    // 2. Create Active Bots for both Knowledge Bases with search_knowledge_base permission
    const botAlpha = this.botRepo.create({
      knowledgeBaseId: kbAlpha.id,
      name: 'Benchmark Bot Alpha',
      modelId: 'mock-model-id',
      status: 'active',
      toolPermissions: ['search_knowledge_base']
    })
    this.botAlphaId = botAlpha.id

    const botBeta = this.botRepo.create({
      knowledgeBaseId: kbBeta.id,
      name: 'Benchmark Bot Beta',
      modelId: 'mock-model-id',
      status: 'active',
      toolPermissions: ['search_knowledge_base']
    })
    this.botBetaId = botBeta.id

    // 3. Ingest supported fixtures into KB-ALPHA
    const corpus = generateSyntheticCorpus()
    const extractorRegistry = new ExtractorRegistry()
    const chunker = new SemanticChunker()

    const supportedEntries = GOLDEN_FIXTURE_MANIFEST.filter(
      (entry) =>
        entry.currentApplicationSupport === 'SUPPORTED' &&
        !['corrupt_truncated.pdf', 'password_protected.pdf'].includes(entry.filename)
    )

    for (const entry of supportedEntries) {
      const fixture = corpus.get(entry.id)
      if (!fixture) continue

      try {
        const extractor = extractorRegistry.getExtractor(fixture.extension)
        const extracted = await extractor.extract(fixture.contentBytes)
        const chunkResult = chunker.chunk(extracted)

        const sourceId = randomUUID()
        const mimeType =
          fixture.extension === 'pdf'
            ? 'application/pdf'
            : fixture.extension === 'md'
              ? 'text/markdown'
              : 'text/plain'

        this.sourceRepo.create({
          id: sourceId,
          knowledge_base_id: kbAlpha.id,
          file_name: fixture.filename,
          original_file_name: fixture.filename,
          relative_file_path: `originals/${fixture.filename}`,
          file_type: fixture.extension as 'txt' | 'md' | 'pdf',
          mime_type: mimeType,
          file_size: fixture.byteSize,
          content_hash: fixture.sha256,
          indexing_status: 'completed'
        })

        if (chunkResult.chunks.length > 0) {
          this.sourceRepo.insertChunks(
            chunkResult.chunks.map((c) => ({
              id: randomUUID(),
              knowledge_base_id: kbAlpha.id,
              source_id: sourceId,
              chunk_index: c.chunkIndex,
              content: c.content,
              page_number: c.pageNumber,
              token_count: c.tokenCount,
              metadata_json: JSON.stringify(c.metadata ?? {})
            }))
          )
        }
      } catch (err) {
        // Document extraction failure during benchmark setup
        console.warn(`Benchmark ingestion skipped for ${entry.filename}:`, err)
      }
    }

    // 4. Ingest isolated document strictly into KB-BETA to test Cross-KB query firewall
    const betaSourceId = randomUUID()
    this.sourceRepo.create({
      id: betaSourceId,
      knowledge_base_id: kbBeta.id,
      file_name: 'isolated_beta_audit.txt',
      original_file_name: 'isolated_beta_audit.txt',
      relative_file_path: 'originals/isolated_beta_audit.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 512,
      content_hash: 'b'.repeat(64),
      indexing_status: 'completed'
    })

    this.sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kbBeta.id,
        source_id: betaSourceId,
        chunk_index: 0,
        content:
          'SECURITY AUDIT RECONCILIATION LOG FOR CLUSTER BETA\nEntry: AUDIT-LOG-BETA-03 confirms isolated node cluster synchronization status active.',
        page_number: null,
        token_count: 30,
        metadata_json: '{}'
      }
    ])
  }

  /**
   * Executes all test cases in the golden Q&A dataset and computes evaluation metrics.
   */
  public async evaluate(): Promise<RetrievalEvaluationOutput> {
    if (!this.db) {
      await this.setup()
    }

    const detailedResults: RetrievalMetricResult[] = []
    let totalRecallAt1 = 0
    let totalRecallAt3 = 0
    let totalRecallAt5 = 0
    let totalReciprocalRank = 0
    let answerableCount = 0

    const typeStats: Record<string, { total: number; hitsAt1: number; sumRr: number }> = {}

    for (const testCase of GOLDEN_RETRIEVAL_DATASET) {
      if (!typeStats[testCase.searchType]) {
        typeStats[testCase.searchType] = { total: 0, hitsAt1: 0, sumRr: 0 }
      }
      typeStats[testCase.searchType].total++

      // Execute retrieval via Bot Alpha (authoritative KB-ALPHA)
      const result = this.ragService.retrieve({
        botId: this.botAlphaId,
        query: testCase.query,
        topK: 5,
        maxContextTokens: 4000
      })

      if (!testCase.shouldBeAnswerable) {
        // Query should NOT be answerable in KB-ALPHA
        // Check if results were returned
        const retrievedChunks = result.chunks
        let hasFalsePositiveHit = false
        if (retrievedChunks.length > 0 && testCase.expectedRelevantFactMarkers.length > 0) {
          hasFalsePositiveHit = retrievedChunks.some((c) =>
            testCase.expectedRelevantFactMarkers.some((m) => c.content.includes(m))
          )
        }

        const status: BenchmarkResultStatus = hasFalsePositiveHit
          ? 'FAIL'
          : testCase.searchType === 'negative_unanswerable'
            ? 'PASS'
            : 'NOT_SUPPORTED'

        detailedResults.push({
          queryId: testCase.id,
          query: testCase.query,
          searchType: testCase.searchType,
          rank: null,
          hitAt1: false,
          hitAt3: false,
          hitAt5: false,
          reciprocalRank: 0,
          retrievedCount: retrievedChunks.length,
          status,
          matchedMarkers: [],
          notes: testCase.notes
        })
        continue
      }

      answerableCount++
      const retrievedChunks = result.chunks
      let matchRank: number | null = null
      const matchedMarkers: string[] = []

      for (let i = 0; i < retrievedChunks.length; i++) {
        const chunk = retrievedChunks[i]
        const matched = testCase.expectedRelevantFactMarkers.filter((m) =>
          chunk.content.includes(m)
        )
        if (matched.length > 0) {
          matchRank = i + 1 // 1-based rank
          matchedMarkers.push(...matched)
          break
        }
      }

      const hitAt1 = matchRank === 1
      const hitAt3 = matchRank !== null && matchRank <= 3
      const hitAt5 = matchRank !== null && matchRank <= 5
      const reciprocalRank = matchRank !== null ? 1 / matchRank : 0

      if (hitAt1) {
        totalRecallAt1++
        typeStats[testCase.searchType].hitsAt1++
      }
      if (hitAt3) totalRecallAt3++
      if (hitAt5) totalRecallAt5++
      totalReciprocalRank += reciprocalRank
      typeStats[testCase.searchType].sumRr += reciprocalRank

      let status: BenchmarkResultStatus = 'PASS'
      if (!hitAt5) {
        // Check if this was a known limitation (e.g. QA-12 heading loss defect)
        if (testCase.id === 'QA-12') {
          status = 'KNOWN_LIMITATION'
        } else {
          status = 'FAIL'
        }
      }

      detailedResults.push({
        queryId: testCase.id,
        query: testCase.query,
        searchType: testCase.searchType,
        rank: matchRank,
        hitAt1,
        hitAt3,
        hitAt5,
        reciprocalRank,
        retrievedCount: retrievedChunks.length,
        status,
        matchedMarkers,
        notes: testCase.notes
      })
    }

    // Strictly verify Cross-KB Isolation
    // 1. Bot Alpha querying AUDIT-LOG-BETA-03 MUST return 0 chunks
    const crossKbAlphaResult = this.ragService.retrieve({
      botId: this.botAlphaId,
      query: 'AUDIT-LOG-BETA-03',
      topK: 5,
      maxContextTokens: 4000
    })
    const alphaLeakedBetaDoc = crossKbAlphaResult.chunks.some((c) =>
      c.content.includes('AUDIT-LOG-BETA-03')
    )

    // 2. Bot Beta querying AUDIT-LOG-BETA-03 MUST return 1 chunk
    const crossKbBetaResult = this.ragService.retrieve({
      botId: this.botBetaId,
      query: 'AUDIT-LOG-BETA-03',
      topK: 5,
      maxContextTokens: 4000
    })
    const betaFoundOwnDoc = crossKbBetaResult.chunks.some((c) =>
      c.content.includes('AUDIT-LOG-BETA-03')
    )

    const crossKbIsolationVerified = !alphaLeakedBetaDoc && betaFoundOwnDoc

    const resultsByType: Record<string, { total: number; recallAt1: number; mrr: number }> = {}
    for (const [st, stats] of Object.entries(typeStats)) {
      resultsByType[st] = {
        total: stats.total,
        recallAt1: stats.total > 0 ? Math.round((stats.hitsAt1 / stats.total) * 1000) / 1000 : 0,
        mrr: stats.total > 0 ? Math.round((stats.sumRr / stats.total) * 1000) / 1000 : 0
      }
    }

    const aggregateMetrics: RetrievalAggregateMetrics = {
      totalQueries: GOLDEN_RETRIEVAL_DATASET.length,
      answerableQueries: answerableCount,
      recallAt1:
        answerableCount > 0 ? Math.round((totalRecallAt1 / answerableCount) * 1000) / 1000 : 0,
      recallAt3:
        answerableCount > 0 ? Math.round((totalRecallAt3 / answerableCount) * 1000) / 1000 : 0,
      recallAt5:
        answerableCount > 0 ? Math.round((totalRecallAt5 / answerableCount) * 1000) / 1000 : 0,
      mrr:
        answerableCount > 0 ? Math.round((totalReciprocalRank / answerableCount) * 1000) / 1000 : 0,
      resultsByType
    }

    return {
      aggregateMetrics,
      detailedResults,
      crossKbIsolationVerified
    }
  }

  /**
   * Closes database and tears down evaluation harness.
   */
  public teardown(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
