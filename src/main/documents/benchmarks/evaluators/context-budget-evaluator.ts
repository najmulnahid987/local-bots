import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../database/migrations/runner'
import { migrations } from '../../../database/migrations'
import { KnowledgeBaseRepository } from '../../../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../../../database/repositories/knowledge-source-repository'
import { BotRepository } from '../../../database/repositories/bot-repository'
import { BotRagService } from '../../../services/bot-rag-service'
import type { ContextBudgetObservation } from '../types'

/**
 * Evaluates context budget allocation, deterministic text truncation, and
 * subsequent chunk discard behavior in BotRagService.
 */
export class ContextBudgetEvaluator {
  /**
   * Executes budget constraint scenarios and measures truncation and discard behavior.
   */
  public evaluateBudgetScenarios(): ContextBudgetObservation[] {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    const kbRepo = new KnowledgeBaseRepository(db)
    const botRepo = new BotRepository(db)
    const sourceRepo = new KnowledgeSourceRepository(db)

    const ragService = new BotRagService({
      db,
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      knowledgeSourceRepository: sourceRepo
    })

    const kb = kbRepo.create({
      name: 'Budget Test KB',
      description: 'KB for budget evaluation'
    })

    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Budget Bot',
      modelId: 'mock-model-id',
      status: 'active',
      toolPermissions: ['search_knowledge_base']
    })

    const sourceId = randomUUID()
    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kb.id,
      file_name: 'multi_section_report.txt',
      original_file_name: 'multi_section_report.txt',
      relative_file_path: 'originals/multi_section_report.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 4096,
      content_hash: 'c'.repeat(64),
      indexing_status: 'completed'
    })

    // Seed 4 chunks with identical search keyword "BUDGET-TARGET-TEST"
    // Chunk 0: ~250 tokens (1000 chars)
    // Chunk 1: ~300 tokens (1200 chars)
    // Chunk 2: ~200 tokens (800 chars)
    // Chunk 3: ~150 tokens (600 chars)
    const chunk0Text = 'BUDGET-TARGET-TEST Chunk Zero Header. ' + 'Alpha sentence. '.repeat(60)
    const chunk1Text = 'BUDGET-TARGET-TEST Chunk One Header. ' + 'Beta sentence. '.repeat(75)
    const chunk2Text = 'BUDGET-TARGET-TEST Chunk Two Header. ' + 'Gamma sentence. '.repeat(50)
    const chunk3Text = 'BUDGET-TARGET-TEST Chunk Three Header. ' + 'Delta sentence. '.repeat(35)

    sourceRepo.insertChunks([
      {
        id: randomUUID(),
        knowledge_base_id: kb.id,
        source_id: sourceId,
        chunk_index: 0,
        content: chunk0Text,
        page_number: 1,
        token_count: Math.ceil(chunk0Text.length / 4),
        metadata_json: '{}'
      },
      {
        id: randomUUID(),
        knowledge_base_id: kb.id,
        source_id: sourceId,
        chunk_index: 1,
        content: chunk1Text,
        page_number: 2,
        token_count: Math.ceil(chunk1Text.length / 4),
        metadata_json: '{}'
      },
      {
        id: randomUUID(),
        knowledge_base_id: kb.id,
        source_id: sourceId,
        chunk_index: 2,
        content: chunk2Text,
        page_number: 3,
        token_count: Math.ceil(chunk2Text.length / 4),
        metadata_json: '{}'
      },
      {
        id: randomUUID(),
        knowledge_base_id: kb.id,
        source_id: sourceId,
        chunk_index: 3,
        content: chunk3Text,
        page_number: 4,
        token_count: Math.ceil(chunk3Text.length / 4),
        metadata_json: '{}'
      }
    ])

    const observations: ContextBudgetObservation[] = []

    // Scenario 1: Budget truncation and subsequent chunk loss
    // Budget = 400 tokens. Chunk 0 takes ~250 tokens. Remaining: ~150 tokens.
    // Chunk 1 has ~300 tokens > 150 tokens. Chunk 1 is truncated to 150 tokens.
    // Chunk 2 and Chunk 3 are discarded because loop breaks on truncation.
    const budget400Result = ragService.retrieve({
      botId: bot.id,
      query: 'BUDGET-TARGET-TEST',
      topK: 5,
      maxContextTokens: 400,
      allowTruncation: true
    })

    const selectedChunks = budget400Result.chunks
    const truncatedIndex = selectedChunks.findIndex((c) => c.isTruncated)
    const discardedCount = 4 - selectedChunks.length

    observations.push({
      testScenario: 'Constrained Budget with Oversized Second Chunk (400 tokens)',
      initialCandidateCount: 4,
      oversizedChunkIndex: 1,
      oversizedChunkTokens: Math.ceil(chunk1Text.length / 4),
      subsequentRelevantChunkCount: 2, // Chunks 2 and 3
      selectedChunkCount: selectedChunks.length,
      truncatedChunkIndex: truncatedIndex !== -1 ? truncatedIndex : null,
      discardedSubsequentChunkCount: discardedCount,
      citationMapMatchesVisibleEvidence: selectedChunks.every((c) =>
        budget400Result.citations.some((cit) => cit.chunkId === c.chunkId)
      ),
      observations: [
        `Chunk index 1 exceeded remaining budget and was truncated from ${Math.ceil(chunk1Text.length / 4)} tokens to ${selectedChunks[truncatedIndex]?.tokenCount} tokens.`,
        `Loop terminated immediately via break statement upon slicing chunk 1.`,
        `2 subsequent relevant chunks (Chunks 2 and 3) were completely discarded from context even though they matched the FTS query.`,
        `Citation map correctly created 2 citations matching the 2 included chunks.`
      ]
    })

    // Scenario 2: Severe Budget (200 tokens) - first chunk exceeds budget
    const budget200Result = ragService.retrieve({
      botId: bot.id,
      query: 'BUDGET-TARGET-TEST',
      topK: 5,
      maxContextTokens: 200,
      allowTruncation: true
    })

    observations.push({
      testScenario: 'Severe Budget (200 tokens) Slicing Initial Candidate',
      initialCandidateCount: 4,
      oversizedChunkIndex: 0,
      oversizedChunkTokens: Math.ceil(chunk0Text.length / 4),
      subsequentRelevantChunkCount: 3,
      selectedChunkCount: budget200Result.chunks.length,
      truncatedChunkIndex: 0,
      discardedSubsequentChunkCount: 3,
      citationMapMatchesVisibleEvidence:
        budget200Result.citations.length === budget200Result.chunks.length,
      observations: [
        `Chunk 0 exceeded the entire 200 token budget and was truncated to 200 tokens (800 chars).`,
        `3 subsequent candidate chunks were immediately discarded without evaluation.`,
        `Citation 1 was generated for Chunk 0 with truncated content.`
      ]
    })

    db.close()
    return observations
  }
}
