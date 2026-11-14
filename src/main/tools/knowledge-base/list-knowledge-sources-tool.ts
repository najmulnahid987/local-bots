import { z } from 'zod'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'

// ============================================================================
// Constants & Limits
// ============================================================================

export const MAX_LISTED_KNOWLEDGE_SOURCES = 100

// ============================================================================
// Input Schema
// ============================================================================

export const listKnowledgeSourcesInputSchema = z.object({}).strict()

export type ListKnowledgeSourcesInput = z.infer<typeof listKnowledgeSourcesInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface KnowledgeSourceSummary {
  readonly sourceId: string
  readonly documentName: string
  readonly fileType: string
  readonly indexingStatus: string
  readonly chunkCount: number
  readonly fileSize: number
  readonly createdAt: number
  readonly indexedAt: number | null
}

export interface ListKnowledgeSourcesResult {
  readonly totalSources: number
  readonly returnedSources: number
  readonly isTruncated: boolean
  readonly sources: readonly KnowledgeSourceSummary[]
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class ListKnowledgeSourcesTool implements AgentTool<
  ListKnowledgeSourcesInput,
  ListKnowledgeSourcesResult
> {
  public readonly name = 'list_knowledge_sources' as const
  public readonly description =
    'List documents available in the bot parent Knowledge Base with indexing status and chunk counts.'
  public readonly schema = listKnowledgeSourcesInputSchema
  public readonly requiredPermission = 'list_knowledge_sources' as const

  private readonly sourceRepo: KnowledgeSourceRepository

  constructor(sourceRepo: KnowledgeSourceRepository) {
    if (!sourceRepo) {
      throw new Error('KnowledgeSourceRepository is required for ListKnowledgeSourcesTool.')
    }
    this.sourceRepo = sourceRepo
  }

  public async execute(
    _args: ListKnowledgeSourcesInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<ListKnowledgeSourcesResult>> {
    // 1. Query sources with chunk counts strictly scoped to the authoritative Knowledge Base
    const allSources = this.sourceRepo.listWithChunkCounts(context.knowledgeBaseId)

    // 2. Bound result count
    const isTruncated = allSources.length > MAX_LISTED_KNOWLEDGE_SOURCES
    const candidateSources = allSources.slice(0, MAX_LISTED_KNOWLEDGE_SOURCES)

    const sources: KnowledgeSourceSummary[] = candidateSources.map((source) => ({
      sourceId: source.id,
      documentName: source.original_file_name,
      fileType: source.file_type,
      indexingStatus: source.indexing_status,
      chunkCount: source.chunk_count,
      fileSize: source.file_size,
      createdAt: source.created_at,
      indexedAt: source.indexed_at
    }))

    const result: ListKnowledgeSourcesResult = {
      totalSources: allSources.length,
      returnedSources: sources.length,
      isTruncated,
      sources
    }

    const truncatedNote = isTruncated ? ` (capped at ${MAX_LISTED_KNOWLEDGE_SOURCES})` : ''
    return {
      result,
      resultSummary: `Found ${allSources.length} document(s) in Knowledge Base${truncatedNote}`
    }
  }
}
