import { PdfExtractor, type RichPdfExtractedDocument } from '../../extractors/pdf-extractor'
import type { DocumentSettingsProvider } from '../../document-settings'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult,
  ExtractedDocumentBlock
} from '../types'
import { normalizeFormatExtension } from '../format-detector'

/**
 * Adapter integrating PdfExtractor (using unpdf) into the modular IDocumentExtractor architecture.
 *
 * Preserves:
 * 1. Physical 1-based page numbers for every extracted page.
 * 2. Strict page-limit enforcement before extraction.
 * 3. Structured DocumentErrors on encrypted, empty, corrupted, or password-protected PDFs.
 */
export class PdfExtractorAdapter implements IDocumentExtractor {
  private readonly innerExtractor: PdfExtractor

  public readonly metadata: ExtractorMetadata = {
    id: 'unpdf-pdf-extractor',
    name: 'unpdf PDF Text Extractor',
    version: '1.0.0',
    supportedFormats: ['pdf'],
    supportedMimeTypes: ['application/pdf'],
    isHeavy: true,
    requiresUtilityProcess: false
  }

  constructor(settingsProvider?: DocumentSettingsProvider, innerExtractor?: PdfExtractor) {
    this.innerExtractor = innerExtractor ?? new PdfExtractor(settingsProvider)
  }

  public supports(format: string): boolean {
    const normalized = normalizeFormatExtension(format)
    return this.metadata.supportedFormats.includes(normalized)
  }

  public async extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    void context
    const extracted = (await this.innerExtractor.extract(request.bytes)) as RichPdfExtractedDocument

    const blocks: ExtractedDocumentBlock[] =
      extracted.blocks && extracted.blocks.length > 0
        ? [...extracted.blocks]
        : extracted.sections.map((section) => ({
            type: 'paragraph',
            text: section.text,
            pageNumber: section.pageNumber,
            lineStart: section.lineStart,
            lineEnd: section.lineEnd
          }))

    const warnings = extracted.warnings ? [...extracted.warnings] : []
    const quality = extracted.quality ?? {
      fidelity: 'medium',
      isLossy: true,
      isOcr: false
    }

    return {
      format: 'pdf',
      text: extracted.text,
      blocks,
      metadata: extracted.metadata ?? {},
      warnings,
      quality,
      extractor: this.metadata
    }
  }
}
