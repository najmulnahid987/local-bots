/**
 * Supported document formats for text extraction and ingestion.
 */
export type DocumentFormat = 'txt' | 'md' | 'pdf'

/**
 * A format-neutral structural section of an extracted document.
 * Serves as the primary unit of provenance and boundary input for the chunking engine.
 */
export interface ExtractedDocumentSection {
  /**
   * Raw text content belonging to this section.
   */
  readonly text: string

  /**
   * Title of the section heading (e.g. "System Architecture"), if section was introduced by a heading.
   */
  readonly heading?: string

  /**
   * 1-based depth of the heading (e.g. 1 for #, 2 for ##, 3 for ###).
   */
  readonly headingLevel?: number

  /**
   * Cumulative hierarchy path of headings leading to this section (e.g. ["Project", "Architecture", "Database"]).
   */
  readonly headingPath?: readonly string[]

  /**
   * 1-based source line index where this section begins (inclusive).
   */
  readonly lineStart?: number

  /**
   * 1-based source line index where this section ends (inclusive).
   */
  readonly lineEnd?: number

  /**
   * 1-based physical page number (reserved for PDF extraction in Step 5.5).
   */
  readonly pageNumber?: number
}

/**
 * Structured, format-neutral extraction result emitted by document extractors.
 */
export interface ExtractedDocument {
  /**
   * Document format of the source content.
   */
  readonly format: DocumentFormat

  /**
   * Complete extracted text of the document.
   */
  readonly text: string

  /**
   * Ordered sequence of structural sections.
   */
  readonly sections: readonly ExtractedDocumentSection[]

  /**
   * Format-specific, renderer-safe extraction metadata (e.g. lineCount, sectionCount).
   */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * Common interface implemented by format-specific document text extractors.
 */
export interface DocumentExtractor {
  /**
   * Extracts text and structural sections from validated input bytes.
   */
  extract(bytes: Uint8Array | Buffer): Promise<ExtractedDocument>
}
