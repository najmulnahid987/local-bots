import type Database from 'better-sqlite3'
import {
  type CitationDto,
  type CitationFileType,
  citationDtoSchema
} from '../../shared/conversations'
import { botIdSchema } from '../../shared/bots'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import type { Bot, KnowledgeBase, SearchChunkMatchRow } from '../database/repositories/types'
import { sanitizeFts5SearchQuery } from '../documents/search/query-sanitizer'
import { estimateTokenCount } from '../documents/chunking/semantic-chunker'

// ============================================================================
// Service Constants & Limits
// ============================================================================

export const DEFAULT_RAG_TOP_K = 5
export const MIN_RAG_TOP_K = 1
export const MAX_RAG_TOP_K = 20

export const DEFAULT_RAG_MAX_CONTEXT_TOKENS = 4000
export const MIN_RAG_MAX_CONTEXT_TOKENS = 1
export const MAX_RAG_MAX_CONTEXT_TOKENS = 16000

// ============================================================================
// Error Types
// ============================================================================

export type BotRagErrorCode =
  | 'BOT_NOT_FOUND'
  | 'BOT_ARCHIVED'
  | 'KNOWLEDGE_BASE_NOT_FOUND'
  | 'KNOWLEDGE_BASE_ARCHIVED'
  | 'INVALID_INPUT'
  | 'DATABASE_ERROR'

export class BotRagServiceError extends Error {
  public readonly code: BotRagErrorCode

  constructor(message: string, code: BotRagErrorCode) {
    super(message)
    this.name = 'BotRagServiceError'
    this.code = code
    Object.setPrototypeOf(this, BotRagServiceError.prototype)
  }
}

// ============================================================================
// Internal Service Contracts
// ============================================================================

/**
 * Caller options for Bot-scoped RAG retrieval.
 * Strictly prohibits caller-supplied knowledgeBaseId to prevent cross-KB context leakage.
 */
export interface BotRagRetrievalOptions {
  readonly botId: string
  readonly query: string
  readonly topK?: number
  readonly maxContextTokens?: number
}

/**
 * Internal retrieved chunk representation holding full document content
 * and authentic provenance metadata.
 */
export interface RetrievedChunk {
  readonly citationNumber: number
  readonly sourceId: string
  readonly chunkId: string
  readonly fileName: string
  readonly fileType: CitationFileType
  readonly pageNumber: number | null
  readonly headingPath: readonly string[] | null
  readonly chunkIndex: number
  readonly score: number
  readonly content: string
  readonly tokenCount: number
  readonly isTruncated: boolean
  readonly citation: CitationDto
}

export type BotRagRetrievalStatus = 'SUCCESS' | 'NO_RESULTS' | 'EMPTY_QUERY' | 'RETRIEVAL_DISABLED'

export interface BotRagRetrievalResult {
  readonly status: BotRagRetrievalStatus
  readonly chunks: readonly RetrievedChunk[]
  readonly citations: readonly CitationDto[]
  readonly totalTokens: number
  readonly reason?: string
}

export interface BotRagServiceDependencies {
  readonly db?: Database.Database
  readonly botRepository?: BotRepository
  readonly knowledgeBaseRepository?: KnowledgeBaseRepository
  readonly knowledgeSourceRepository?: KnowledgeSourceRepository
}

// ============================================================================
// BotRagService Implementation
// ============================================================================

/**
 * Secure Main-process service orchestrating Bot-scoped RAG document chunk retrieval.
 * Enforces the Knowledge Base isolation invariant by deriving the authoritative
 * parent Knowledge Base ID directly from the Bot's database record.
 */
export class BotRagService {
  private readonly botRepo: BotRepository
  private readonly kbRepo: KnowledgeBaseRepository
  private readonly sourceRepo: KnowledgeSourceRepository

  constructor(deps: BotRagServiceDependencies) {
    if (deps.botRepository && deps.knowledgeBaseRepository && deps.knowledgeSourceRepository) {
      this.botRepo = deps.botRepository
      this.kbRepo = deps.knowledgeBaseRepository
      this.sourceRepo = deps.knowledgeSourceRepository
    } else if (deps.db) {
      this.botRepo = deps.botRepository ?? new BotRepository(deps.db)
      this.kbRepo = deps.knowledgeBaseRepository ?? new KnowledgeBaseRepository(deps.db)
      this.sourceRepo = deps.knowledgeSourceRepository ?? new KnowledgeSourceRepository(deps.db)
    } else {
      throw new BotRagServiceError(
        'Database connection or repository dependencies are required for BotRagService.',
        'INVALID_INPUT'
      )
    }
  }

  /**
   * Retrieves relevant document chunks scoped strictly to the Bot's parent Knowledge Base.
   */
  public retrieve(options: BotRagRetrievalOptions): BotRagRetrievalResult {
    if (!options || typeof options !== 'object') {
      throw new BotRagServiceError('Retrieval options must be an object.', 'INVALID_INPUT')
    }

    // 1. Validate Bot ID (RFC 4122 UUIDv4)
    const botIdParse = botIdSchema.safeParse(options.botId)
    if (!botIdParse.success) {
      throw new BotRagServiceError(
        `Invalid Bot identifier: '${options.botId}'. Must be a valid UUIDv4 string.`,
        'INVALID_INPUT'
      )
    }
    const botId = botIdParse.data

    // 2. Validate query
    if (typeof options.query !== 'string') {
      throw new BotRagServiceError('Search query must be a string.', 'INVALID_INPUT')
    }

    // 3. Validate and bound topK
    let effectiveTopK = DEFAULT_RAG_TOP_K
    if (options.topK !== undefined) {
      if (
        typeof options.topK !== 'number' ||
        !Number.isInteger(options.topK) ||
        options.topK < MIN_RAG_TOP_K ||
        options.topK > MAX_RAG_TOP_K
      ) {
        throw new BotRagServiceError(
          `topK must be an integer between ${MIN_RAG_TOP_K} and ${MAX_RAG_TOP_K}. Received: ${options.topK}`,
          'INVALID_INPUT'
        )
      }
      effectiveTopK = options.topK
    }

    // 4. Validate and bound maxContextTokens
    let effectiveMaxContextTokens = DEFAULT_RAG_MAX_CONTEXT_TOKENS
    if (options.maxContextTokens !== undefined) {
      if (
        typeof options.maxContextTokens !== 'number' ||
        !Number.isInteger(options.maxContextTokens) ||
        options.maxContextTokens < MIN_RAG_MAX_CONTEXT_TOKENS ||
        options.maxContextTokens > MAX_RAG_MAX_CONTEXT_TOKENS
      ) {
        throw new BotRagServiceError(
          `maxContextTokens must be an integer between ${MIN_RAG_MAX_CONTEXT_TOKENS} and ${MAX_RAG_MAX_CONTEXT_TOKENS}. Received: ${options.maxContextTokens}`,
          'INVALID_INPUT'
        )
      }
      effectiveMaxContextTokens = options.maxContextTokens
    }

    // 5. Authoritative Bot lookup
    let bot: Bot | null
    try {
      bot = this.botRepo.getByIdOnly(botId)
    } catch (err) {
      throw new BotRagServiceError(
        `Failed to resolve Bot: ${err instanceof Error ? err.message : String(err)}`,
        'DATABASE_ERROR'
      )
    }

    if (!bot) {
      throw new BotRagServiceError(`Bot '${botId}' not found.`, 'BOT_NOT_FOUND')
    }

    if (bot.status !== 'active') {
      throw new BotRagServiceError(
        `Bot '${botId}' is archived and cannot perform knowledge base retrieval.`,
        'BOT_ARCHIVED'
      )
    }

    const authoritativeKbId = bot.knowledgeBaseId

    // 6. Verify parent Knowledge Base exists and is not archived
    let kb: KnowledgeBase | null
    try {
      kb = this.kbRepo.getById(authoritativeKbId)
    } catch (err) {
      throw new BotRagServiceError(
        `Failed to verify parent Knowledge Base: ${err instanceof Error ? err.message : String(err)}`,
        'DATABASE_ERROR'
      )
    }

    if (!kb) {
      throw new BotRagServiceError(
        `Parent Knowledge Base '${authoritativeKbId}' for Bot '${botId}' was not found.`,
        'KNOWLEDGE_BASE_NOT_FOUND'
      )
    }

    if (kb.archived_at !== null) {
      throw new BotRagServiceError(
        `Parent Knowledge Base '${authoritativeKbId}' for Bot '${botId}' is archived.`,
        'KNOWLEDGE_BASE_ARCHIVED'
      )
    }

    // 7. Enforce Bot tool permissions
    const hasSearchPermission = bot.toolPermissions.includes('search_knowledge_base')
    if (!hasSearchPermission) {
      return {
        status: 'RETRIEVAL_DISABLED',
        chunks: [],
        citations: [],
        totalTokens: 0,
        reason: "Bot does not have 'search_knowledge_base' permission enabled."
      }
    }

    // 8. Sanitize FTS5 query
    const sanitizedQuery = sanitizeFts5SearchQuery(options.query)
    if (!sanitizedQuery || sanitizedQuery.trim().length === 0) {
      return {
        status: 'EMPTY_QUERY',
        chunks: [],
        citations: [],
        totalTokens: 0,
        reason: 'Search query contains no searchable terms after FTS5 sanitization.'
      }
    }

    // 9. Execute FTS5 search strictly on the authoritative Knowledge Base
    let rawMatches: SearchChunkMatchRow[]
    try {
      rawMatches = this.sourceRepo.searchChunks(authoritativeKbId, sanitizedQuery, effectiveTopK)
    } catch {
      throw new BotRagServiceError('Failed to execute knowledge base search.', 'DATABASE_ERROR')
    }

    if (!rawMatches || rawMatches.length === 0) {
      return {
        status: 'NO_RESULTS',
        chunks: [],
        citations: [],
        totalTokens: 0
      }
    }

    // 10. Budget enforcement and citation candidate creation
    const chunks: RetrievedChunk[] = []
    const citations: CitationDto[] = []
    let currentTokens = 0
    let citationNumber = 1

    for (const row of rawMatches) {
      if (chunks.length >= effectiveTopK) {
        break
      }

      const remainingTokens = effectiveMaxContextTokens - currentTokens
      if (remainingTokens <= 0) {
        break
      }

      const fullContent = row.content
      const chunkTokens = estimateTokenCount(fullContent)

      let chunkContent = fullContent
      let chunkTokenCount = chunkTokens
      let isTruncated = false

      if (chunkTokens > remainingTokens) {
        // Deterministic truncation strategy: truncate text to fit remaining token budget
        const allowedChars = remainingTokens * 4
        if (allowedChars <= 0) {
          break
        }
        chunkContent = fullContent.slice(0, allowedChars)
        chunkTokenCount = estimateTokenCount(chunkContent)
        isTruncated = true
      }

      // Metadata extraction
      let parsedMeta: Record<string, unknown> = {}
      try {
        if (row.metadata_json) {
          parsedMeta = JSON.parse(row.metadata_json)
        }
      } catch {
        parsedMeta = {}
      }

      // Page number extraction (priority to row.page_number, fallback to metadata_json)
      let pageNumber: number | null = null
      if (
        typeof row.page_number === 'number' &&
        Number.isInteger(row.page_number) &&
        row.page_number >= 1
      ) {
        pageNumber = row.page_number
      } else if (
        typeof parsedMeta.pageNumber === 'number' &&
        Number.isInteger(parsedMeta.pageNumber) &&
        parsedMeta.pageNumber >= 1
      ) {
        pageNumber = parsedMeta.pageNumber
      }

      // Heading path extraction
      let headingPath: string[] | null = null
      if (Array.isArray(parsedMeta.headingPath) && parsedMeta.headingPath.length > 0) {
        const validHeadings = parsedMeta.headingPath
          .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
          .map((h) => h.trim().slice(0, 200))
          .slice(0, 20)
        if (validHeadings.length > 0) {
          headingPath = validHeadings
        }
      } else if (typeof parsedMeta.heading === 'string' && parsedMeta.heading.trim().length > 0) {
        headingPath = [parsedMeta.heading.trim().slice(0, 200)]
      }

      // Sanitize fileName: strip path separators, limit length
      const rawName = row.original_file_name.replace(/.*[/\\]/, '').trim()
      const fileName = rawName.length > 0 ? rawName.slice(0, 255) : 'document'

      // Construct authentic CitationDto
      const citationCandidate: CitationDto = {
        citationNumber,
        sourceId: row.source_id,
        chunkId: row.chunk_id,
        fileName,
        fileType: row.file_type,
        pageNumber,
        headingPath,
        chunkIndex: row.chunk_index
      }

      // Validate against shared CitationDto schema
      const validatedCitation = citationDtoSchema.parse(citationCandidate)

      const retrievedChunk: RetrievedChunk = {
        citationNumber,
        sourceId: row.source_id,
        chunkId: row.chunk_id,
        fileName,
        fileType: row.file_type,
        pageNumber,
        headingPath,
        chunkIndex: row.chunk_index,
        score: row.rank_score,
        content: chunkContent,
        tokenCount: chunkTokenCount,
        isTruncated,
        citation: validatedCitation
      }

      chunks.push(retrievedChunk)
      citations.push(validatedCitation)
      currentTokens += chunkTokenCount
      citationNumber++

      if (isTruncated) {
        break
      }
    }

    if (chunks.length === 0) {
      return {
        status: 'NO_RESULTS',
        chunks: [],
        citations: [],
        totalTokens: 0
      }
    }

    return {
      status: 'SUCCESS',
      chunks,
      citations,
      totalTokens: currentTokens
    }
  }
}
