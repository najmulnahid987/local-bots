import {
  type DocumentSearchResultDto,
  type SearchKnowledgeDocumentsRequest,
  searchKnowledgeDocumentsRequestSchema,
  DEFAULT_SEARCH_LIMIT
} from '../../../shared/knowledge-documents'
import type { SearchChunkMatchRow } from '../../database/repositories/types'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { DocumentSettingsProvider } from '../document-settings'
import { sanitizeFts5SearchQuery } from './query-sanitizer'
import type { DocumentSearchServiceOptions } from './types'

/**
 * Maps a raw SQLite search match row into a sanitized, UI-safe DocumentSearchResultDto.
 * Extracts format-aware provenance (headings for MD, pages for PDF, chunker versions)
 * while ensuring zero filesystem path or database handle leakage.
 */
export function toDocumentSearchResultDto(row: SearchChunkMatchRow): DocumentSearchResultDto {
  let parsedMeta: Record<string, unknown> = {}
  try {
    if (row.metadata_json) {
      parsedMeta = JSON.parse(row.metadata_json)
    }
  } catch {
    parsedMeta = {}
  }

  // Heading metadata for Markdown
  const heading =
    typeof parsedMeta.heading === 'string' && parsedMeta.heading.trim().length > 0
      ? parsedMeta.heading.trim()
      : null

  const headingLevel =
    typeof parsedMeta.headingLevel === 'number' && Number.isInteger(parsedMeta.headingLevel)
      ? parsedMeta.headingLevel
      : null

  const headingPath =
    Array.isArray(parsedMeta.headingPath) && parsedMeta.headingPath.length > 0
      ? parsedMeta.headingPath.filter((h): h is string => typeof h === 'string')
      : null

  // PDF Page number: priority to row.page_number, fallback to metadata_json
  const pageNumber =
    row.page_number !== null && row.page_number !== undefined
      ? row.page_number
      : typeof parsedMeta.pageNumber === 'number'
        ? parsedMeta.pageNumber
        : null

  // Chunker algorithm version
  const chunkerVersion =
    typeof parsedMeta.chunkerVersion === 'string' && parsedMeta.chunkerVersion.trim().length > 0
      ? parsedMeta.chunkerVersion.trim()
      : null

  // Original line range if available in metadata
  let lineRange: { readonly start: number; readonly end: number } | null = null
  if (
    parsedMeta.lineRange &&
    typeof parsedMeta.lineRange === 'object' &&
    'start' in parsedMeta.lineRange &&
    'end' in parsedMeta.lineRange &&
    typeof (parsedMeta.lineRange as { start: unknown }).start === 'number' &&
    typeof (parsedMeta.lineRange as { end: unknown }).end === 'number'
  ) {
    lineRange = {
      start: (parsedMeta.lineRange as { start: number }).start,
      end: (parsedMeta.lineRange as { end: number }).end
    }
  }

  return {
    sourceId: row.source_id,
    knowledgeBaseId: row.knowledge_base_id,
    filename: row.original_file_name,
    chunkId: row.chunk_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    snippet: row.match_snippet,
    score: row.rank_score,
    pageNumber,
    heading,
    headingLevel,
    headingPath,
    lineRange,
    chunkerVersion
  }
}

/**
 * Service orchestrating Knowledge Base-scoped full-text document search.
 * Leverages SQLite FTS5 with Porter stemming and BM25 lexical ranking.
 */
export class DocumentSearchService {
  private readonly sourceRepository: KnowledgeSourceRepository
  private readonly settingsProvider?: DocumentSettingsProvider

  constructor(options: DocumentSearchServiceOptions) {
    if (!options.sourceRepository) {
      throw new Error('KnowledgeSourceRepository is required for DocumentSearchService.')
    }
    this.sourceRepository = options.sourceRepository
    this.settingsProvider = options.settingsProvider
  }

  /**
   * Returns the injected or active DocumentSettingsProvider if one was configured.
   */
  public getSettingsProvider(): DocumentSettingsProvider | undefined {
    return this.settingsProvider
  }

  /**
   * Executes a scoped lexical full-text search across documents in a Knowledge Base.
   *
   * Security & Isolation Guarantees:
   * 1. Rejects unknown or non-existent Knowledge Base IDs.
   * 2. Scopes SQL query to the target Knowledge Base at the database layer.
   * 3. Sanitizes user search query to prevent SQLite FTS5 syntax errors.
   * 4. Orders matches by BM25 relevance score ASC (more negative is higher relevance) with deterministic secondary ordering.
   * 5. Strictly excludes sources with non-completed indexing statuses (queued, processing, failed, needs_reindex).
   * 6. Returns safe snippet highlights with non-HTML [[HL]]...[[/HL]] delimiters.
   */
  public async search(
    request: SearchKnowledgeDocumentsRequest
  ): Promise<readonly DocumentSearchResultDto[]> {
    // 1. Zod input validation
    const parseResult = searchKnowledgeDocumentsRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((i) => i.message).join('; ')
      const err = new Error(`Invalid search request: ${errorMsg}`)
      ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
      throw err
    }

    const { knowledgeBaseId, query, limit } = parseResult.data

    // 2. Knowledge Base existence verification
    const kbExists = this.sourceRepository.knowledgeBaseExists(knowledgeBaseId)
    if (!kbExists) {
      const err = new Error(`Knowledge Base '${knowledgeBaseId}' could not be found.`)
      ;(err as unknown as { code: string }).code = 'KNOWLEDGE_BASE_NOT_FOUND'
      throw err
    }

    // 3. Query normalization and FTS5 syntax sanitization
    const sanitizedQuery = sanitizeFts5SearchQuery(query)
    if (sanitizedQuery.length === 0) {
      return []
    }

    // 4. Resolve result limit (bounded between 1 and MAX_SEARCH_LIMIT)
    const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT

    // 5. Query execution through KnowledgeSourceRepository
    const matchRows = this.sourceRepository.searchChunks(
      knowledgeBaseId,
      sanitizedQuery,
      effectiveLimit
    )

    // 6. Map to UI-safe, typed DTOs
    return matchRows.map(toDocumentSearchResultDto)
  }
}
