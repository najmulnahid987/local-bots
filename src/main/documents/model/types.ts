/**
 * Universal Structured Document Model Types
 *
 * Serves as the canonical, format-independent intermediate representation (IR)
 * for the Local Bots Knowledge Base ingestion and chunking pipeline.
 *
 * Invariant Guarantees:
 * 1. Information Preservation: Retains full structural elements (headings, tables, lists, code, coordinates).
 * 2. Discriminated Union: Type-safe, compiler-enforced block matching across all 10 block primitives.
 * 3. Authentic Provenance: Preserves source locations (lines, pages, sheets, slides, cells) without fabrication.
 * 4. Transparent Quality: Carries extraction warnings and quality assessments in the document model.
 */

/**
 * Discriminator enumeration for universal document block types.
 */
export const UNIVERSAL_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'list',
  'table',
  'code',
  'page_boundary',
  'sheet_boundary',
  'slide_boundary',
  'image_reference',
  'unknown'
] as const

export type UniversalBlockType = (typeof UNIVERSAL_BLOCK_TYPES)[number]

/**
 * Universal source location model capturing format-specific provenance coordinates.
 * All properties are optional; extractors must provide only authentic, verified coordinates.
 */
export interface UniversalSourceLocation {
  // TXT / Markdown coordinates (1-based)
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly columnStart?: number
  readonly columnEnd?: number

  // Page-oriented formats (PDF)
  readonly pageNumber?: number

  // Word-processing formats (DOCX)
  readonly paragraphIndex?: number
  readonly headingContext?: string

  // Spreadsheet coordinates (XLSX, CSV)
  readonly sheetName?: string
  readonly sheetIndex?: number
  readonly rowNumber?: number
  readonly columnNumber?: number
  readonly cellCoordinate?: string // e.g. "B12"

  // Presentation coordinates (PPTX)
  readonly slideNumber?: number
  readonly shapeIndex?: number
  readonly slideTitle?: string
}

/**
 * Base block interface shared across all universal document block types.
 */
export interface UniversalBaseBlock {
  /**
   * Stable, unique identifier for this block within the document.
   */
  readonly id: string

  /**
   * Block type discriminator.
   */
  readonly type: UniversalBlockType

  /**
   * 0-based sequential ordering index within the document.
   */
  readonly orderIndex: number

  /**
   * Coherent textual representation of the block content.
   */
  readonly text: string

  /**
   * Authentic source location provenance coordinates.
   */
  readonly location?: UniversalSourceLocation

  /**
   * Optional reference to parent block ID for nested hierarchies.
   */
  readonly parentBlockId?: string

  /**
   * Format-specific or extractor-specific non-standard attributes.
   */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * Structural heading block.
 */
export interface UniversalHeadingBlock extends UniversalBaseBlock {
  readonly type: 'heading'
  readonly level: number // 1 to 6
  readonly headingPath: readonly string[] // Cumulative breadcrumbs (e.g. ["Architecture", "Database"])
}

/**
 * Standard text paragraph block.
 */
export interface UniversalParagraphBlock extends UniversalBaseBlock {
  readonly type: 'paragraph'
  readonly isQuote?: boolean
}

/**
 * Individual item inside a structured list.
 */
export interface UniversalListItem {
  readonly text: string
  readonly depth: number // 0-based indentation/nesting level
  readonly orderIndex: number
  readonly itemNumber?: number // 1-based number for ordered list items
  readonly checked?: boolean // Checkbox status for task items ([x] vs [ ])
  readonly location?: UniversalSourceLocation
}

/**
 * Ordered or unordered list block.
 */
export interface UniversalListBlock extends UniversalBaseBlock {
  readonly type: 'list'
  readonly ordered: boolean
  readonly items: readonly UniversalListItem[]
}

/**
 * Individual cell inside a structured table.
 */
export interface UniversalTableCell {
  readonly value: string
  readonly rawValue?: unknown
  readonly cachedValue?: unknown
  readonly formula?: string
  readonly coordinate?: string // "A1", "B2", etc.
  readonly rowIndex: number
  readonly columnIndex: number
  readonly rowSpan?: number
  readonly colSpan?: number
  readonly styleIndex?: number
  readonly numberFormat?: string
  readonly comment?: string
  readonly hyperlink?: string
  readonly isHeader?: boolean
}

/**
 * High-fidelity, structured table block.
 * Preserves both simple matrix arrays and rich cell coordinates/formulas.
 */
export interface UniversalTableBlock extends UniversalBaseBlock {
  readonly type: 'table'
  readonly tableId?: string
  readonly caption?: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly cells?: readonly (readonly UniversalTableCell[])[]
  readonly rowCount: number
  readonly columnCount: number
  readonly isSpreadsheet?: boolean
  readonly sheetName?: string
  readonly sheetIndex?: number
}

/**
 * Code block with language metadata.
 */
export interface UniversalCodeBlock extends UniversalBaseBlock {
  readonly type: 'code'
  readonly code: string // Pure code body without enclosing fences
  readonly language?: string
}

/**
 * Physical page boundary marker (PDF, Word page breaks).
 */
export interface UniversalPageBoundaryBlock extends UniversalBaseBlock {
  readonly type: 'page_boundary'
  readonly pageNumber: number
  readonly totalPages?: number
  readonly label?: string
}

/**
 * Worksheet boundary marker (XLSX, multi-sheet tables).
 */
export interface UniversalSheetBoundaryBlock extends UniversalBaseBlock {
  readonly type: 'sheet_boundary'
  readonly sheetName: string
  readonly sheetIndex: number
  readonly totalSheets?: number
}

/**
 * Presentation slide boundary marker (PPTX).
 */
export interface UniversalSlideBoundaryBlock extends UniversalBaseBlock {
  readonly type: 'slide_boundary'
  readonly slideNumber: number
  readonly slideTitle?: string
  readonly totalSlides?: number
}

/**
 * Image or visual media reference block (captures skipped or unparsed graphics).
 */
export interface UniversalImageReferenceBlock extends UniversalBaseBlock {
  readonly type: 'image_reference'
  readonly elementType: 'image' | 'chart' | 'diagram' | 'vector_graphic' | 'smart_art' | 'unknown'
  readonly referenceId?: string
  readonly altText?: string
  readonly caption?: string
  readonly extractionStatus: 'skipped' | 'partial' | 'unsupported' | 'failed'
  readonly warning?: string
}

/**
 * Fallback block capturing unknown, unsupported, or custom document constructs.
 */
export interface UniversalUnknownBlock extends UniversalBaseBlock {
  readonly type: 'unknown'
  readonly originalType: string
  readonly rawContent?: unknown
  readonly warning?: string
}

/**
 * Discriminated union of all 10 universal document block types.
 */
export type UniversalDocumentBlock =
  | UniversalHeadingBlock
  | UniversalParagraphBlock
  | UniversalListBlock
  | UniversalTableBlock
  | UniversalCodeBlock
  | UniversalPageBoundaryBlock
  | UniversalSheetBoundaryBlock
  | UniversalSlideBoundaryBlock
  | UniversalImageReferenceBlock
  | UniversalUnknownBlock

/**
 * Structured, non-fatal extraction warning.
 */
export interface UniversalDocumentWarning {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/**
 * Extraction quality and structural fidelity assessment.
 */
export interface UniversalDocumentQuality {
  readonly fidelity: 'high' | 'medium' | 'low'
  readonly isLossy: boolean
  readonly isOcr: boolean
  readonly confidence?: number // 0.0 to 1.0
  readonly hasUnparsedElements?: boolean
}

/**
 * Extractor metadata identifying the parser implementation and version.
 */
export interface UniversalExtractorInfo {
  readonly id: string
  readonly name: string
  readonly version: string
}

/**
 * Document-level source metrics.
 */
export interface UniversalSourceInfo {
  readonly fileSizeBytes?: number
  readonly contentHash?: string
  readonly mimeType?: string
  readonly pageCount?: number
  readonly sheetCount?: number
  readonly slideCount?: number
  readonly lineCount?: number
  readonly characterCount?: number
  readonly wordCount?: number
}

/**
 * The canonical universal structured document model.
 */
export interface UniversalDocument {
  /**
   * Unique, stable identifier for this parsed document instance (UUIDv4).
   */
  readonly id: string

  /**
   * Optional Knowledge Source record ID if registered in database.
   */
  readonly sourceId?: string

  /**
   * Optional Knowledge Base ID to which this document belongs.
   */
  readonly knowledgeBaseId?: string

  /**
   * Canonical lower-case file format extension (e.g. 'txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx').
   */
  readonly format: string

  /**
   * Original source filename when available.
   */
  readonly originalFileName?: string

  /**
   * MIME type when known.
   */
  readonly mimeType?: string

  /**
   * Extractor that produced this document.
   */
  readonly extractor: UniversalExtractorInfo

  /**
   * Epoch millisecond timestamp of extraction.
   */
  readonly extractedAt: number

  /**
   * Complete, coherent plain text representation of the document.
   */
  readonly text: string

  /**
   * Ordered sequence of structural document blocks.
   */
  readonly blocks: readonly UniversalDocumentBlock[]

  /**
   * Document-level metadata.
   */
  readonly metadata: Readonly<Record<string, unknown>>

  /**
   * Non-fatal warnings encountered during extraction.
   */
  readonly warnings: readonly UniversalDocumentWarning[]

  /**
   * Structural fidelity assessment.
   */
  readonly quality: UniversalDocumentQuality

  /**
   * Document-level source metrics and dimensions.
   */
  readonly sourceInfo?: UniversalSourceInfo
}
