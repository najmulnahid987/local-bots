import { z } from 'zod'
import type { CitationDto } from '../../../shared/conversations'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import { ToolPermissionError } from '../agent-tool'
import type { BotRagService } from '../../services/bot-rag-service'

// ============================================================================
// Input Schema
// ============================================================================

export const searchKnowledgeBaseInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(500, 'Search query cannot exceed 500 characters'),
    topK: z
      .number()
      .int('topK must be an integer')
      .min(1, 'topK must be at least 1')
      .max(20, 'topK cannot exceed 20')
      .optional()
  })
  .strict()

export type SearchKnowledgeBaseInput = z.infer<typeof searchKnowledgeBaseInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface SearchExcerpt {
  readonly citationNumber: number
  readonly citationLabel: string
  readonly sourceId: string
  readonly chunkId: string
  readonly documentName: string
  readonly fileType: string
  readonly pageNumber: number | null
  readonly headingPath: readonly string[] | null
  readonly chunkIndex: number
  readonly score: number
  readonly content: string
}

export interface SearchKnowledgeBaseResult {
  readonly status: 'SUCCESS' | 'NO_RESULTS' | 'EMPTY_QUERY'
  readonly query: string
  readonly totalResults: number
  readonly excerpts: readonly SearchExcerpt[]
  readonly citations: readonly CitationDto[]
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class SearchKnowledgeBaseTool implements AgentTool<
  SearchKnowledgeBaseInput,
  SearchKnowledgeBaseResult
> {
  public readonly name = 'search_knowledge_base' as const
  public readonly description =
    'Search the bot parent Knowledge Base using full-text search (BM25) to retrieve relevant document excerpts with citations.'
  public readonly schema = searchKnowledgeBaseInputSchema
  public readonly requiredPermission = 'search_knowledge_base' as const

  private readonly ragService: BotRagService

  constructor(ragService: BotRagService) {
    if (!ragService) {
      throw new Error('BotRagService is required for SearchKnowledgeBaseTool.')
    }
    this.ragService = ragService
  }

  public async execute(
    args: SearchKnowledgeBaseInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<SearchKnowledgeBaseResult>> {
    const ragResult = this.ragService.retrieve({
      botId: context.botId,
      query: args.query,
      topK: args.topK,
      requireToolPermission: true
    })

    if (ragResult.status === 'RETRIEVAL_DISABLED') {
      throw new ToolPermissionError(
        ragResult.reason ?? "Bot does not have 'search_knowledge_base' permission enabled.",
        this.name
      )
    }

    if (ragResult.status === 'EMPTY_QUERY') {
      const result: SearchKnowledgeBaseResult = {
        status: 'EMPTY_QUERY',
        query: args.query,
        totalResults: 0,
        excerpts: [],
        citations: []
      }
      return {
        result,
        resultSummary: `Search query contained no searchable terms after sanitization: "${args.query}"`
      }
    }

    if (ragResult.status === 'NO_RESULTS') {
      const result: SearchKnowledgeBaseResult = {
        status: 'NO_RESULTS',
        query: args.query,
        totalResults: 0,
        excerpts: [],
        citations: []
      }
      return {
        result,
        resultSummary: `No relevant excerpts found in Knowledge Base for query: "${args.query}"`
      }
    }

    const excerpts: SearchExcerpt[] = ragResult.chunks.map((chunk) => {
      const pageInfo = chunk.pageNumber ? `, p. ${chunk.pageNumber}` : ''
      const citationLabel = `[${chunk.fileName}${pageInfo}, Chunk #${chunk.chunkIndex + 1}]`

      return {
        citationNumber: chunk.citationNumber,
        citationLabel,
        sourceId: chunk.sourceId,
        chunkId: chunk.chunkId,
        documentName: chunk.fileName,
        fileType: chunk.fileType,
        pageNumber: chunk.pageNumber,
        headingPath: chunk.headingPath,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        content: chunk.content
      }
    })

    const result: SearchKnowledgeBaseResult = {
      status: 'SUCCESS',
      query: args.query,
      totalResults: excerpts.length,
      excerpts,
      citations: ragResult.citations
    }

    return {
      result,
      resultSummary: `Found ${excerpts.length} relevant excerpt(s) in Knowledge Base for query: "${args.query}"`
    }
  }
}
