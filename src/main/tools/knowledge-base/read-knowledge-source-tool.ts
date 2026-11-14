import { z } from 'zod'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import { ToolExecutionError } from '../agent-tool'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'

// ============================================================================
// Constants & Limits
// ============================================================================

export const DEFAULT_READ_SOURCE_MAX_CHUNKS = 20
export const MIN_READ_SOURCE_MAX_CHUNKS = 1
export const MAX_READ_SOURCE_MAX_CHUNKS = 50
export const MAX_READ_SOURCE_TOTAL_CHARS = 50000

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ============================================================================
// Input Schema
// ============================================================================

export const readKnowledgeSourceInputSchema = z
  .object({
    sourceId: z
      .string()
      .trim()
      .min(1, 'sourceId cannot be empty')
      .max(100, 'sourceId cannot exceed 100 characters'),
    maxChunks: z
      .number()
      .int('maxChunks must be an integer')
      .min(MIN_READ_SOURCE_MAX_CHUNKS, `maxChunks must be at least ${MIN_READ_SOURCE_MAX_CHUNKS}`)
      .max(MAX_READ_SOURCE_MAX_CHUNKS, `maxChunks cannot exceed ${MAX_READ_SOURCE_MAX_CHUNKS}`)
      .optional()
  })
  .strict()

export type ReadKnowledgeSourceInput = z.infer<typeof readKnowledgeSourceInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface ReadSourceChunk {
  readonly chunkId: string
  readonly chunkIndex: number
  readonly pageNumber: number | null
  readonly heading: string | null
  readonly headingPath: readonly string[] | null
  readonly tokenCount: number
  readonly content: string
}

export interface ReadKnowledgeSourceResult {
  readonly sourceId: string
  readonly documentName: string
  readonly fileType: string
  readonly indexingStatus: string
  readonly totalChunksInDocument: number
  readonly chunksRead: number
  readonly isTruncated: boolean
  readonly chunks: readonly ReadSourceChunk[]
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class ReadKnowledgeSourceTool implements AgentTool<
  ReadKnowledgeSourceInput,
  ReadKnowledgeSourceResult
> {
  public readonly name = 'read_knowledge_source' as const
  public readonly description =
    'Read chunks and structural metadata of an indexed document in the bot parent Knowledge Base by source ID.'
  public readonly schema = readKnowledgeSourceInputSchema
  public readonly requiredPermission = 'read_knowledge_source' as const

  private readonly sourceRepo: KnowledgeSourceRepository

  constructor(sourceRepo: KnowledgeSourceRepository) {
    if (!sourceRepo) {
      throw new Error('KnowledgeSourceRepository is required for ReadKnowledgeSourceTool.')
    }
    this.sourceRepo = sourceRepo
  }

  public async execute(
    args: ReadKnowledgeSourceInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<ReadKnowledgeSourceResult>> {
    // 1. Validate UUID format
    if (!UUID_REGEX.test(args.sourceId)) {
      throw new ToolExecutionError(
        `Invalid sourceId format: '${args.sourceId}'. Must be a valid UUID.`,
        'VALIDATION_FAILED',
        this.name
      )
    }

    // 2. Query source scoped strictly to authoritative parent Knowledge Base
    const source = this.sourceRepo.getById(args.sourceId, context.knowledgeBaseId)
    if (!source) {
      // Check if source exists in another Knowledge Base to provide clear security feedback
      const foreignSource = this.sourceRepo.getById(args.sourceId)
      if (foreignSource) {
        throw new ToolExecutionError(
          `Access denied: Knowledge source '${args.sourceId}' does not belong to the bot's parent Knowledge Base.`,
          'PERMISSION_DENIED',
          this.name
        )
      }
      throw new ToolExecutionError(
        `Knowledge source '${args.sourceId}' was not found in the bot's parent Knowledge Base.`,
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 3. Verify source is indexed
    if (source.indexing_status !== 'completed') {
      throw new ToolExecutionError(
        `Knowledge source '${args.sourceId}' is not fully indexed (current status: '${source.indexing_status}').`,
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 4. Retrieve ordered chunks scoped strictly to source and Knowledge Base
    const allChunks = this.sourceRepo.getChunksBySourceId(args.sourceId, context.knowledgeBaseId)
    const effectiveMaxChunks = args.maxChunks ?? DEFAULT_READ_SOURCE_MAX_CHUNKS

    let isTruncated = allChunks.length > effectiveMaxChunks
    const candidateChunks = allChunks.slice(0, effectiveMaxChunks)

    // 5. Apply total character budget limit
    const readChunks: ReadSourceChunk[] = []
    let accumulatedChars = 0

    for (const chunk of candidateChunks) {
      if (accumulatedChars + chunk.content.length > MAX_READ_SOURCE_TOTAL_CHARS) {
        isTruncated = true
        break
      }

      let parsedMetadata: Record<string, unknown> = {}
      if (chunk.metadata_json) {
        try {
          parsedMetadata = JSON.parse(chunk.metadata_json)
        } catch {
          parsedMetadata = {}
        }
      }

      readChunks.push({
        chunkId: chunk.id,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        heading: typeof parsedMetadata.heading === 'string' ? parsedMetadata.heading : null,
        headingPath: Array.isArray(parsedMetadata.headingPath)
          ? (parsedMetadata.headingPath as string[])
          : null,
        tokenCount: chunk.token_count,
        content: chunk.content
      })

      accumulatedChars += chunk.content.length
    }

    const result: ReadKnowledgeSourceResult = {
      sourceId: source.id,
      documentName: source.original_file_name,
      fileType: source.file_type,
      indexingStatus: source.indexing_status,
      totalChunksInDocument: allChunks.length,
      chunksRead: readChunks.length,
      isTruncated,
      chunks: readChunks
    }

    const truncatedNote = isTruncated ? ', truncated' : ''
    return {
      result,
      resultSummary: `Read ${readChunks.length} chunk(s) from document "${source.original_file_name}" (total: ${allChunks.length} chunks${truncatedNote})`
    }
  }
}
