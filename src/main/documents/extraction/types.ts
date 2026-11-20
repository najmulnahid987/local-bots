import type {
  DocumentFormat,
  ExtractedDocument,
  ExtractedDocumentSection
} from '../extractors/types'

/**
 * Metadata identifying an extractor implementation and its operational capabilities.
 */
export interface ExtractorMetadata {
  /**
   * Unique, machine-readable identifier for the extractor (e.g. 'purejs-markdown-extractor').
   */
  readonly id: string

  /**
   * Human-readable display name.
   */
  readonly name: string

  /**
   * Semantic version string of the extractor.
   */
  readonly version: string

  /**
   * Normalized file format extensions handled by this extractor (e.g. ['md', 'markdown']).
   * Without leading dots, all lowercase.
   */
  readonly supportedFormats: readonly string[]

  /**
   * MIME types officially supported by this extractor.
   */
  readonly supportedMimeTypes?: readonly string[]

  /**
   * Indicates whether this parser is computationally heavy or memory intensive.
   */
  readonly isHeavy?: boolean

  /**
   * Indicates whether this parser is designed to run in an isolated utility process.
   */
  readonly requiresUtilityProcess?: boolean
}

/**
 * Configurable boundaries and resource limits enforced during document extraction.
 */
export interface ExtractionLimits {
  /**
   * Maximum wall-clock execution time in milliseconds before extraction is aborted (default: 30,000 ms).
   */
  readonly timeoutMs?: number

  /**
   * Maximum input file size in bytes (default: 20 MiB = 20,971,520).
   */
  readonly maxInputSizeBytes?: number

  /**
   * Maximum total extracted text size in characters/bytes to prevent memory exhaustion (default: 50 MiB).
   */
  readonly maxOutputSizeBytes?: number

  /**
   * Maximum physical page count for page-oriented formats like PDF (default: 200).
   */
  readonly maxPages?: number
}

/**
 * Standard default extraction limits applied when caller does not specify overrides.
 */
export const DEFAULT_EXTRACTION_LIMITS: Required<ExtractionLimits> = {
  timeoutMs: 30_000,
  maxInputSizeBytes: 20 * 1024 * 1024,
  maxOutputSizeBytes: 50 * 1024 * 1024,
  maxPages: 200
} as const

/**
 * Request payload submitted to an extraction service or extractor.
 */
export interface DocumentExtractionRequest {
  /**
   * Binary contents of the document.
   */
  readonly bytes: Uint8Array

  /**
   * Optional original filename hint (used for extension resolution if formatHint is absent).
   */
  readonly filenameHint?: string

  /**
   * Optional MIME type hint provided by the caller or OS.
   */
  readonly mimeTypeHint?: string

  /**
   * Explicit format extension hint (e.g. 'pdf', 'md', 'txt').
   */
  readonly formatHint?: string

  /**
   * Optional abort signal allowing callers to cancel long-running extractions.
   */
  readonly signal?: AbortSignal

  /**
   * Optional per-request extraction limit overrides.
   */
  readonly limits?: ExtractionLimits

  /**
   * Optional extractor-specific options (e.g. CSV hasHeader flag).
   */
  readonly options?: Record<string, unknown>

  /**
   * Optional caller-provided metadata (e.g. source properties).
   */
  readonly metadata?: Record<string, unknown>
}

/**
 * Runtime execution context passed to extractors by the orchestration service.
 */
export interface DocumentExtractionContext {
  /**
   * Abort signal tied to client cancellation or extraction timeout.
   */
  readonly signal?: AbortSignal

  /**
   * Fully resolved extraction limits.
   */
  readonly limits: Required<ExtractionLimits>
}

/**
 * Structured, non-fatal extraction warning emitted during parsing.
 */
export interface DocumentExtractionWarning {
  /**
   * Machine-readable warning code (e.g. 'UNSUPPORTED_EMBEDDED_IMAGE', 'PARTIAL_ENCRYPTED_STREAM').
   */
  readonly code: string

  /**
   * Human-readable diagnostic message.
   */
  readonly message: string

  /**
   * Optional contextual metadata.
   */
  readonly details?: unknown
}

/**
 * Extraction quality and fidelity assessment metadata.
 */
export interface ExtractionQuality {
  /**
   * Overall structural fidelity classification.
   * - 'high': Full structural semantics (headings, tables, lists, text) faithfully recovered.
   * - 'medium': Text mostly extracted, but formatting or table structure degraded.
   * - 'low': Plain text stream only or lossy heuristic recovery.
   */
  readonly fidelity: 'high' | 'medium' | 'low'

  /**
   * Whether some document elements (e.g. images, charts, formulas) were omitted during extraction.
   */
  readonly isLossy: boolean

  /**
   * Whether optical character recognition (OCR) was utilized to extract text.
   */
  readonly isOcr: boolean

  /**
   * Optional numeric confidence score between 0.0 and 1.0 (primarily applicable to OCR).
   */
  readonly confidence?: number

  /**
   * Whether unparsed or skipped document elements (e.g. images, charts, inline HTML) were detected.
   */
  readonly hasUnparsedElements?: boolean
}

/**
 * Discriminated structural block types supported by the normalized document model.
 */
export type ExtractedDocumentBlockType =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'table'
  | 'code'
  | 'page_break'
  | 'sheet_boundary'
  | 'slide_boundary'
  | 'image_reference'
  | 'unknown'

/**
 * A normalized structural block of content extracted from a document.
 * Serves as the high-fidelity primitive for chunking, table preservation, and citation indexing.
 */
export interface ExtractedDocumentBlock {
  /**
   * Structural role of this block.
   */
  readonly type: ExtractedDocumentBlockType

  /**
   * Textual representation of this block.
   */
  readonly text: string

  /**
   * 1-based physical page number if applicable (e.g. PDF, Word page breaks).
   * Undefined if format does not possess physical pages.
   */
  readonly pageNumber?: number

  /**
   * 1-based source line index where this block begins (if line numbers are trackable).
   */
  readonly lineStart?: number

  /**
   * 1-based source line index where this block ends (inclusive).
   */
  readonly lineEnd?: number

  /**
   * Specific attributes for 'heading' blocks.
   */
  readonly heading?: {
    readonly level: number
    readonly headingPath: readonly string[]
  }

  /**
   * Specific attributes for 'list' blocks.
   */
  readonly list?: {
    readonly items: readonly string[]
    readonly ordered: boolean
    readonly itemDetails?: readonly {
      readonly text: string
      readonly depth: number
      readonly itemNumber?: number
      readonly checked?: boolean
      readonly lineStart?: number
      readonly lineEnd?: number
    }[]
  }

  /**
   * Specific attributes for 'table' blocks.
   */
  readonly table?: {
    readonly headers: readonly string[]
    readonly rows: readonly (readonly string[])[]
    readonly caption?: string
    readonly alignments?: readonly ('left' | 'center' | 'right' | 'none')[]
  }

  /**
   * Specific attributes for 'code' blocks.
   */
  readonly code?: {
    readonly language?: string
    readonly code?: string
  }

  /**
   * Specific attributes for 'image_reference' blocks.
   */
  readonly imageReference?: {
    readonly elementType: 'image' | 'chart' | 'diagram' | 'vector_graphic' | 'smart_art' | 'unknown'
    readonly referenceId?: string
    readonly altText?: string
    readonly caption?: string
    readonly extractionStatus?: 'skipped' | 'partial' | 'unsupported' | 'failed'
    readonly warning?: string
  }

  /**
   * Indicates whether this paragraph represents a blockquote.
   */
  readonly isQuote?: boolean

  /**
   * Specific attributes for spreadsheet 'sheet_boundary' blocks.
   */
  readonly sheet?: {
    readonly name: string
    readonly index: number
  }

  /**
   * Specific attributes for presentation 'slide_boundary' blocks.
   */
  readonly slide?: {
    readonly number: number
    readonly title?: string
  }

  /**
   * Additional renderer-safe, extractor-specific metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * Comprehensive, normalized result emitted by modular document extractors.
 */
export interface DocumentExtractionResult {
  /**
   * Resolved canonical document format (e.g. 'txt', 'md', 'pdf', 'docx', 'xlsx').
   */
  readonly format: string

  /**
   * Complete, coherent extracted text of the document.
   */
  readonly text: string

  /**
   * Ordered sequence of structural document blocks.
   */
  readonly blocks: readonly ExtractedDocumentBlock[]

  /**
   * Extractor-level and document-level metadata (e.g. author, pageCount, wordCount).
   */
  readonly metadata: Readonly<Record<string, unknown>>

  /**
   * Non-fatal warnings encountered during parsing.
   */
  readonly warnings: readonly DocumentExtractionWarning[]

  /**
   * Structural fidelity assessment.
   */
  readonly quality: ExtractionQuality

  /**
   * Identity of the extractor that processed this document.
   */
  readonly extractor: ExtractorMetadata
}

/**
 * Common interface implemented by all modular document extractors.
 */
export interface IDocumentExtractor {
  /**
   * Metadata identifying this extractor and its supported formats.
   */
  readonly metadata: ExtractorMetadata

  /**
   * Checks whether this extractor handles the specified normalized format extension.
   */
  supports(format: string): boolean

  /**
   * Extracts structured content from the requested document payload.
   */
  extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext
  ): Promise<DocumentExtractionResult>
}

/**
 * Converts a modern DocumentExtractionResult into a legacy ExtractedDocument
 * for backward compatibility with existing legacy chunkers and pipelines.
 *
 * @deprecated Lossy compatibility adapter. Flattens structured tables, lists, and code blocks
 * into newline-delimited text strings. For canonical information-preserving representation,
 * use `documentExtractionResultToUniversalDocument()` from `../model`.
 */
export function extractionResultToExtractedDocument(
  result: DocumentExtractionResult
): ExtractedDocument {
  const sections: ExtractedDocumentSection[] = []

  // Group contiguous blocks into logical sections matching ExtractedDocumentSection semantics
  let currentHeading: string | undefined = undefined
  let currentHeadingLevel: number | undefined = undefined
  let currentHeadingPath: readonly string[] | undefined = undefined
  let currentLines: string[] = []
  let sectionLineStart = 1
  let currentLineTracker = 1
  let currentPageNumber: number | undefined = undefined

  const flushSection = (): void => {
    if (currentLines.length > 0 || currentHeading !== undefined) {
      const sectionText = currentLines.join('\n')
      sections.push({
        text: sectionText,
        heading: currentHeading,
        headingLevel: currentHeadingLevel,
        headingPath: currentHeadingPath,
        lineStart: sectionLineStart,
        lineEnd: Math.max(sectionLineStart, currentLineTracker - 1),
        pageNumber: currentPageNumber
      })
      currentLines = []
      sectionLineStart = currentLineTracker
    }
  }

  for (const block of result.blocks) {
    if (block.pageNumber !== undefined && block.pageNumber !== currentPageNumber) {
      if (currentPageNumber !== undefined) {
        flushSection()
      }
      currentPageNumber = block.pageNumber
    }

    if (block.type === 'sheet_boundary' && block.sheet) {
      flushSection()
      currentHeading = `Sheet: ${block.sheet.name}`
      currentHeadingLevel = 1
      currentHeadingPath = [`Sheet: ${block.sheet.name}`]
      currentLines = []
      continue
    }

    if (block.type === 'slide_boundary' && block.slide) {
      flushSection()
      const titleSuffix = block.slide.title ? `: ${block.slide.title}` : ''
      currentHeading = `Slide ${block.slide.number}${titleSuffix}`
      currentHeadingLevel = 1
      currentHeadingPath = [currentHeading]
      currentPageNumber = block.slide.number
      currentLines = []
      continue
    }

    if (block.type === 'heading' && block.heading) {
      flushSection()
      currentHeading = block.text
      currentHeadingLevel = block.heading.level
      currentHeadingPath = block.heading.headingPath
      currentLines = []
    } else {
      currentLines.push(block.text)
    }

    const blockLines = block.text.split('\n').length
    currentLineTracker += blockLines
  }

  flushSection()

  // If no sections were produced (e.g. empty document), emit fallback empty section if text is empty,
  // or a single section matching result.text
  if (sections.length === 0 && result.text.length > 0) {
    sections.push({
      text: result.text,
      lineStart: 1,
      lineEnd: result.text.split('\n').length
    })
  }

  // Cast format to DocumentFormat if txt, md, pdf, otherwise string
  return {
    format: result.format as DocumentFormat,
    text: result.text,
    sections,
    metadata: {
      ...result.metadata,
      warnings: result.warnings,
      quality: result.quality,
      extractorId: result.extractor.id,
      extractorVersion: result.extractor.version
    }
  }
}

/**
 * Converts a legacy ExtractedDocument into a DocumentExtractionResult.
 */
export function extractedDocumentToExtractionResult(
  doc: ExtractedDocument,
  extractor: ExtractorMetadata
): DocumentExtractionResult {
  const blocks: ExtractedDocumentBlock[] = []

  for (const section of doc.sections) {
    if (section.heading) {
      blocks.push({
        type: 'heading',
        text: section.heading,
        heading: {
          level: section.headingLevel ?? 1,
          headingPath: section.headingPath ? [...section.headingPath] : [section.heading]
        },
        pageNumber: section.pageNumber,
        lineStart: section.lineStart,
        lineEnd: section.lineStart
      })
    }

    if (section.text && section.text.length > 0) {
      blocks.push({
        type: 'paragraph',
        text: section.text,
        pageNumber: section.pageNumber,
        lineStart: section.heading ? (section.lineStart ?? 1) + 1 : section.lineStart,
        lineEnd: section.lineEnd
      })
    }
  }

  return {
    format: doc.format,
    text: doc.text,
    blocks,
    metadata: doc.metadata ?? {},
    warnings: [],
    quality: {
      fidelity: doc.format === 'pdf' ? 'medium' : 'high',
      isLossy: false,
      isOcr: false
    },
    extractor
  }
}
