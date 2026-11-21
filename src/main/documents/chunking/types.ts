import type { UniversalBlockType, UniversalSourceLocation } from '../model/types'
import type { SupportedDocumentFormat } from '../../../shared/knowledge-documents'

/**
 * Structured document chunk emitted by deterministic format-aware chunkers.
 * Represents a single indexing unit for SQLite FTS5 full-text search.
 */
export interface DocumentChunk {
  /**
   * 0-based sequential index of the chunk within the source document.
   */
  readonly chunkIndex: number

  /**
   * Normalized text content of the chunk.
   */
  readonly content: string

  /**
   * Estimated token count based on the model-agnostic heuristic: Math.ceil(characterLength / 4).
   * Non-empty chunks always carry a positive token count (>= 1).
   */
  readonly tokenCount: number

  /**
   * 1-based physical page number for PDF documents; null for TXT and Markdown documents.
   */
  readonly pageNumber: number | null

  /**
   * Format-specific structural metadata (e.g. heading, headingPath, headingLevel for Markdown).
   */
  readonly metadata: Readonly<Record<string, unknown>>

  /**
   * Version of the chunker algorithm that generated this chunk (e.g. '1.0.0').
   */
  readonly chunkerVersion: string
}

/**
 * Explicit non-searchable disposition for document blocks that cannot produce searchable text.
 * Guarantees zero silent information loss by accounting for 100% of blocks in the UniversalDocument.
 */
export interface NonSearchableBlockDisposition {
  /**
   * Unique identifier of the source block in the UniversalDocument.
   */
  readonly blockId: string

  /**
   * Universal block type discriminator.
   */
  readonly blockType: UniversalBlockType

  /**
   * Detailed architectural reason this block did not emit a searchable text chunk.
   */
  readonly reason: string

  /**
   * 0-based order index of the block within the document.
   */
  readonly orderIndex: number

  /**
   * Available authentic source location coordinates.
   */
  readonly location?: UniversalSourceLocation
}

/**
 * Summary result produced by the chunking engine.
 */
export interface ChunkingResult {
  /**
   * Ordered sequence of generated document chunks.
   */
  readonly chunks: readonly DocumentChunk[]

  /**
   * Total number of chunks generated.
   */
  readonly totalChunks: number

  /**
   * Sum of estimated token counts across all chunks.
   */
  readonly totalTokens: number

  /**
   * Version of the chunking algorithm used.
   */
  readonly chunkerVersion: string

  /**
   * Explicit dispositions for blocks that did not emit searchable text chunks.
   */
  readonly nonSearchableBlocks?: readonly NonSearchableBlockDisposition[]
}

/**
 * Configuration options provided to UniversalDocumentChunker.chunk().
 */
export interface UniversalChunkingOptions {
  /**
   * Target maximum tokens per chunk (default: 500).
   */
  readonly chunkTargetTokens?: number

  /**
   * Overlap tokens between consecutive text chunks (default: 50).
   */
  readonly chunkOverlapTokens?: number
}

/**
 * Exact source-span provenance tracking character offsets and structural coordinates
 * within a source block.
 */
export interface StructuredSourceSpan {
  readonly blockId: string
  readonly startOffset: number
  readonly endOffset: number
  readonly offsetConvention: 'utf16_code_units' | 'unicode_code_points'
  readonly isPrimary: boolean
  readonly isRepeatedOverlap?: boolean
  readonly pageNumber?: number
  readonly sheetName?: string
  readonly rowIndex?: number
  readonly columnIndex?: number
  readonly cellCoordinate?: string
  readonly slideNumber?: number
  readonly listItemIndex?: number
  readonly noteId?: string
  readonly commentId?: string
}

/**
 * Well-defined structural properties persisted in DocumentChunk.metadata.
 */
export interface StructuredChunkMetadata extends Record<string, unknown> {
  readonly format?: SupportedDocumentFormat | string
  readonly sourceBlockIds?: readonly string[]
  readonly primaryOrderIndexes?: readonly number[]
  readonly sourceSpans?: readonly StructuredSourceSpan[]
  readonly hasOverlap?: boolean
  readonly overlapTokens?: number
  readonly heading?: string | null
  readonly headingLevel?: number | null
  readonly headingPath?: readonly string[] | null
  readonly headingContext?: string | null
  readonly hasTable?: boolean
  readonly contentRole?:
    | 'body'
    | 'table'
    | 'code'
    | 'list'
    | 'heading'
    | 'header'
    | 'footer'
    | 'footnote'
    | 'endnote'
    | 'comment'
    | 'notes'
    | 'chart'
    | 'smartart'
    | 'image'
    | string
  readonly pageNumber?: number | null
  readonly pageNumbers?: readonly number[]
  readonly sheetName?: string
  readonly sheetIndex?: number
  readonly startRow?: number
  readonly endRow?: number
  readonly rowStart?: number
  readonly rowEnd?: number
  readonly slideNumber?: number
  readonly slideTitle?: string
  readonly isSpeakerNotes?: boolean
  readonly isContextual?: boolean
  readonly isOversized?: boolean
  readonly contextPrefix?: string
  readonly sourceLocation?: UniversalSourceLocation
  readonly sourceLocations?: readonly UniversalSourceLocation[]
  readonly isOcr?: boolean
  readonly ocrConfidence?: number
  readonly chunkingStrategy?: string
  readonly chunkerVersion?: string
}
