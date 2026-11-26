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
  /**
   * If true, requires that the Bot explicitly has the 'search_knowledge_base'
   * agent tool permission enabled.
   * Defaults to false: core conversation grounding is mandatory for every active Bot
   * within its parent Knowledge Base regardless of optional agent tool permissions.
   */
  readonly requireToolPermission?: boolean
  /**
   * If true, enables character-level slicing of oversized chunks that exceed remaining token budget.
   * Defaults to false: preserves source content integrity without silent truncation, continuing
   * to evaluate subsequent candidates in the candidate pool that fit within the remaining budget.
   */
  readonly allowTruncation?: boolean
  /**
   * If true, allows relaxed OR term matching across non-stopword content terms
   * when strict AND matching returns zero rows (used by balanced_kb_first for
   * natural-language and partially covered queries). Defaults to false.
   */
  readonly enablePartialFallback?: boolean
}

export type BotRagEvidenceOutcome =
  | 'relevant_evidence'
  | 'partial_evidence'
  | 'no_relevant_evidence'
  | 'no_usable_kb'
  | 'not_attempted'

export type BotRagMatchStrategy = 'exact' | 'content_terms' | 'relaxed_terms' | 'none' | 'skipped'

export interface BotRagEvidenceAssessment {
  readonly outcome: BotRagEvidenceOutcome
  readonly kbReadySourceCount: number
  readonly kbChunkCount: number
  readonly queryContentTermCount: number
  readonly matchedContentTermCount: number
  readonly termCoverageRatio: number
  readonly matchStrategy: BotRagMatchStrategy
}

/**
 * Diagnostic exclusion record detailing why a candidate chunk was omitted from the retrieval result.
 */
export interface BotRagExclusion {
  readonly chunkId: string
  readonly reason: 'exceeds_remaining_budget' | 'candidate_oversized' | string
  readonly candidateTokens: number
  readonly remainingTokens: number
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
  readonly exclusions?: readonly BotRagExclusion[]
  readonly assessment?: BotRagEvidenceAssessment
}

const QUERY_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'both',
  'but',
  'by',
  'can',
  'could',
  'describe',
  'did',
  'do',
  'does',
  'each',
  'else',
  'explain',
  'few',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'help',
  'here',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'know',
  'may',
  'me',
  'might',
  'more',
  'most',
  'must',
  'my',
  'need',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'please',
  'same',
  'shall',
  'she',
  'should',
  'so',
  'some',
  'such',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'want',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'work',
  'works',
  'would',
  'yes',
  'you',
  'your'
])

function extractMeaningfulContentTerms(rawQuery: string): string[] {
  const sanitized = sanitizeFts5SearchQuery(rawQuery)
  if (!sanitized) return []
  const matches = sanitized.match(/"([^"]+)"/g)
  if (!matches) return []

  const seen = new Set<string>()
  const terms: string[] = []
  for (const rawQuoted of matches) {
    const token = rawQuoted.slice(1, -1).toLowerCase()
    if (token.length < 2 || QUERY_STOPWORDS.has(token) || seen.has(token)) {
      continue
    }
    seen.add(token)
    terms.push(token)
  }
  return terms
}

function approximateStem(word: string): string {
  if (word.length <= 3) return word
  return word.replace(/(ations?|ization|ments?|ness|ies|ing|ed|es|s)$/i, '')
}

function quoteFtsTerms(terms: readonly string[], joiner: ' ' | ' OR '): string {
  return terms.map((t) => `"${t}"`).join(joiner)
}

function countMatchedTermsInTexts(
  contentTerms: readonly string[],
  texts: readonly string[]
): number {
  if (contentTerms.length === 0 || texts.length === 0) {
    return 0
  }

  const chunkWords = new Set<string>()
  const chunkStems = new Set<string>()
  for (const text of texts) {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)
    if (!words) continue
    for (const w of words) {
      chunkWords.add(w)
      chunkStems.add(approximateStem(w))
    }
  }

  let matched = 0
  for (const term of contentTerms) {
    const stem = approximateStem(term)
    if (chunkWords.has(term) || (stem.length >= 3 && chunkStems.has(stem))) {
      matched++
    }
  }
  return matched
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

    // 7. Enforce Bot tool permissions only when explicitly required (explicit agent tool execution)
    if (options.requireToolPermission) {
      const hasSearchPermission = bot.toolPermissions.includes('search_knowledge_base')
      if (!hasSearchPermission) {
        return {
          status: 'RETRIEVAL_DISABLED',
          chunks: [],
          citations: [],
          totalTokens: 0,
          reason: "Bot does not have 'search_knowledge_base' permission enabled.",
          assessment: {
            outcome: 'not_attempted',
            kbReadySourceCount: 0,
            kbChunkCount: 0,
            queryContentTermCount: 0,
            matchedContentTermCount: 0,
            termCoverageRatio: 0,
            matchStrategy: 'skipped'
          }
        }
      }
    }

    // 7.5. Inspect searchable Knowledge Base readiness strictly for authoritative KB
    let kbReadySourceCount: number
    let kbChunkCount: number
    try {
      if (typeof this.sourceRepo.getSearchableStats === 'function') {
        const stats = this.sourceRepo.getSearchableStats(authoritativeKbId)
        kbReadySourceCount = stats.readySourceCount
        kbChunkCount = stats.chunkCount
      } else {
        kbChunkCount = this.sourceRepo.countChunks(authoritativeKbId)
        kbReadySourceCount = kbChunkCount > 0 ? 1 : 0
      }
    } catch {
      throw new BotRagServiceError('Failed to check knowledge base readiness.', 'DATABASE_ERROR')
    }

    // 8. Sanitize FTS5 query
    const sanitizedQuery = sanitizeFts5SearchQuery(options.query)
    if (!sanitizedQuery || sanitizedQuery.trim().length === 0) {
      return {
        status: 'EMPTY_QUERY',
        chunks: [],
        citations: [],
        totalTokens: 0,
        reason: 'Search query contains no searchable terms after FTS5 sanitization.',
        assessment: {
          outcome: kbChunkCount === 0 ? 'no_usable_kb' : 'no_relevant_evidence',
          kbReadySourceCount,
          kbChunkCount,
          queryContentTermCount: 0,
          matchedContentTermCount: 0,
          termCoverageRatio: 0,
          matchStrategy: 'skipped'
        }
      }
    }

    const contentTerms = extractMeaningfulContentTerms(options.query)

    // 9. Execute FTS5 search strictly on the authoritative Knowledge Base
    // Fetch a bounded wider candidate pool to avoid retrieval budget starvation when earlier candidates are oversized
    const candidatePoolSize = Math.min(100, Math.max(effectiveTopK * 4, 20))
    let rawMatches: SearchChunkMatchRow[]
    let matchStrategy: BotRagMatchStrategy = 'exact'
    try {
      rawMatches = this.sourceRepo.searchChunks(
        authoritativeKbId,
        sanitizedQuery,
        candidatePoolSize
      )

      if ((!rawMatches || rawMatches.length === 0) && kbChunkCount === 0) {
        return {
          status: 'NO_RESULTS',
          chunks: [],
          citations: [],
          totalTokens: 0,
          reason: 'Assigned Knowledge Base has no indexed documents.',
          assessment: {
            outcome: 'no_usable_kb',
            kbReadySourceCount,
            kbChunkCount: 0,
            queryContentTermCount: contentTerms.length,
            matchedContentTermCount: 0,
            termCoverageRatio: 0,
            matchStrategy: 'skipped'
          }
        }
      }

      // Natural-language fallback 1: strip conversational stopwords while preserving AND semantics
      if ((!rawMatches || rawMatches.length === 0) && contentTerms.length >= 1) {
        const contentAndQuery = quoteFtsTerms(contentTerms, ' ')
        if (contentAndQuery !== sanitizedQuery) {
          rawMatches = this.sourceRepo.searchChunks(
            authoritativeKbId,
            contentAndQuery,
            candidatePoolSize
          )
          if (rawMatches && rawMatches.length > 0) {
            matchStrategy = 'content_terms'
          }
        }
      }

      // Natural-language fallback 2: relaxed OR search across content terms for Balanced partial coverage
      if (
        (!rawMatches || rawMatches.length === 0) &&
        options.enablePartialFallback &&
        contentTerms.length >= 2
      ) {
        const relaxedOrQuery = quoteFtsTerms(contentTerms, ' OR ')
        const relaxedCandidates = this.sourceRepo.searchChunks(
          authoritativeKbId,
          relaxedOrQuery,
          candidatePoolSize
        )
        if (relaxedCandidates && relaxedCandidates.length > 0) {
          const scoredCandidates = relaxedCandidates
            .map((row) => ({
              row,
              matchedCount: countMatchedTermsInTexts(contentTerms, [
                row.content,
                row.original_file_name
              ])
            }))
            .filter((item) => item.matchedCount > 0)
            .sort((a, b) => b.matchedCount - a.matchedCount || a.row.rank_score - b.row.rank_score)

          if (scoredCandidates.length > 0) {
            rawMatches = scoredCandidates.map((item) => item.row)
            matchStrategy = 'relaxed_terms'
          }
        }
      }
    } catch {
      throw new BotRagServiceError('Failed to execute knowledge base search.', 'DATABASE_ERROR')
    }

    if (!rawMatches || rawMatches.length === 0) {
      return {
        status: 'NO_RESULTS',
        chunks: [],
        citations: [],
        totalTokens: 0,
        assessment: {
          outcome: 'no_relevant_evidence',
          kbReadySourceCount,
          kbChunkCount,
          queryContentTermCount: contentTerms.length,
          matchedContentTermCount: 0,
          termCoverageRatio: 0,
          matchStrategy: 'none'
        }
      }
    }

    // 10. Budget enforcement and citation candidate creation
    const allowTruncation = options.allowTruncation === true
    const chunks: RetrievedChunk[] = []
    const citations: CitationDto[] = []
    const exclusions: BotRagExclusion[] = []
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
        if (allowTruncation) {
          // Explicit truncation mode: truncate text to fit remaining token budget
          const allowedChars = remainingTokens * 4
          if (allowedChars <= 0) {
            break
          }
          chunkContent = fullContent.slice(0, allowedChars)
          chunkTokenCount = estimateTokenCount(chunkContent)
          isTruncated = true
        } else {
          // Zero-truncation default: candidate exceeds remaining budget.
          // Do not truncate and do not terminate loop prematurely; record exclusion and continue
          // scanning subsequent candidate chunks that fit within the remaining budget.
          exclusions.push({
            chunkId: row.chunk_id,
            reason: 'exceeds_remaining_budget',
            candidateTokens: chunkTokens,
            remainingTokens
          })
          continue
        }
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
        totalTokens: 0,
        ...(exclusions.length > 0 ? { exclusions } : {}),
        assessment: {
          outcome: 'no_relevant_evidence',
          kbReadySourceCount,
          kbChunkCount,
          queryContentTermCount: contentTerms.length,
          matchedContentTermCount: 0,
          termCoverageRatio: 0,
          matchStrategy: 'none'
        }
      }
    }

    const matchedContentTermCount =
      contentTerms.length === 0
        ? 0
        : countMatchedTermsInTexts(
            contentTerms,
            chunks.map((c) => `${c.fileName} ${c.content}`)
          )

    const effectiveMatchedCount =
      matchStrategy === 'relaxed_terms'
        ? matchedContentTermCount
        : contentTerms.length > 0
          ? Math.max(matchedContentTermCount, contentTerms.length)
          : 0

    const termCoverageRatio =
      contentTerms.length === 0
        ? 1
        : Number(Math.min(1, effectiveMatchedCount / contentTerms.length).toFixed(4))

    const outcome: BotRagEvidenceOutcome =
      matchStrategy === 'relaxed_terms' && termCoverageRatio < 0.75
        ? 'partial_evidence'
        : 'relevant_evidence'

    return {
      status: 'SUCCESS',
      chunks,
      citations,
      totalTokens: currentTokens,
      ...(exclusions.length > 0 ? { exclusions } : {}),
      assessment: {
        outcome,
        kbReadySourceCount,
        kbChunkCount,
        queryContentTermCount: contentTerms.length,
        matchedContentTermCount: effectiveMatchedCount,
        termCoverageRatio,
        matchStrategy
      }
    }
  }
}
