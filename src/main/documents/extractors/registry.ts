import { DocumentErrors } from '../document-errors'
import type { DocumentExtractor, DocumentFormat, ExtractedDocument } from './types'
import { TxtExtractor } from './txt-extractor'
import { MarkdownExtractor } from './markdown-extractor'

/**
 * Registry and dispatcher for document text extractors.
 *
 * Enforces:
 * 1. Formats 'txt' and 'md' are handled by pure-JS extractors.
 * 2. Format 'pdf' is explicitly rejected with EXTRACTION_UNSUPPORTED_FORMAT until Step 5.5.
 * 3. Unknown formats return structured, sanitized extraction errors.
 * 4. Extensible for future extractors via register().
 */
export class ExtractorRegistry {
  private readonly extractors = new Map<string, DocumentExtractor>()

  constructor() {
    this.extractors.set('txt', new TxtExtractor())
    this.extractors.set('md', new MarkdownExtractor())
  }

  /**
   * Registers a document extractor for a specific format extension.
   */
  public register(format: string, extractor: DocumentExtractor): void {
    if (!format || typeof format !== 'string' || !extractor) {
      throw DocumentErrors.extractionMalformedInput('Format and extractor must be provided.')
    }
    const normalized = format.toLowerCase().replace(/^\./, '')
    this.extractors.set(normalized, extractor)
  }

  /**
   * Retrieves registered extractor for format or throws DocumentExtractionError.
   */
  public getExtractor(format: string): DocumentExtractor {
    if (!format || typeof format !== 'string') {
      throw DocumentErrors.extractionUnsupportedFormat(String(format))
    }

    const normalized = format.toLowerCase().replace(/^\./, '')

    if (normalized === 'pdf' && !this.extractors.has('pdf')) {
      throw DocumentErrors.extractionUnsupportedFormat(
        'pdf',
        'PDF text extraction is not yet supported (scheduled for Step 5.5).'
      )
    }

    const extractor = this.extractors.get(normalized)
    if (!extractor) {
      throw DocumentErrors.extractionUnsupportedFormat(normalized)
    }

    return extractor
  }

  /**
   * Checks whether an extractor is registered for the specified format.
   */
  public hasExtractor(format: string): boolean {
    if (!format || typeof format !== 'string') {
      return false
    }
    const normalized = format.toLowerCase().replace(/^\./, '')
    return this.extractors.has(normalized)
  }

  /**
   * Dispatches extraction for validated document bytes to the appropriate format extractor.
   */
  public async extract(format: string, bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
    const extractor = this.getExtractor(format)
    return extractor.extract(bytes)
  }
}

/**
 * Default global extractor registry pre-populated with TXT and Markdown extractors.
 */
export const defaultExtractorRegistry = new ExtractorRegistry()

/**
 * Convenience dispatch function extracting document content using defaultExtractorRegistry.
 */
export async function extractDocument(
  format: DocumentFormat | string,
  bytes: Uint8Array | Buffer
): Promise<ExtractedDocument> {
  return defaultExtractorRegistry.extract(format, bytes)
}
