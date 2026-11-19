import { TxtExtractor } from '../../extractors/txt-extractor'
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
 * Adapter integrating TxtExtractor into the modular IDocumentExtractor architecture.
 */
export class TxtExtractorAdapter implements IDocumentExtractor {
  private readonly innerExtractor: TxtExtractor

  public readonly metadata: ExtractorMetadata = {
    id: 'purejs-txt-extractor',
    name: 'Pure JavaScript Plain Text Extractor',
    version: '1.0.0',
    supportedFormats: ['txt', 'text'],
    supportedMimeTypes: ['text/plain'],
    isHeavy: false,
    requiresUtilityProcess: false
  }

  constructor(innerExtractor?: TxtExtractor) {
    this.innerExtractor = innerExtractor ?? new TxtExtractor()
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
    const extracted = await this.innerExtractor.extract(request.bytes)

    const blocks: ExtractedDocumentBlock[] = extracted.sections.map((section) => ({
      type: 'paragraph',
      text: section.text,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd
    }))

    return {
      format: 'txt',
      text: extracted.text,
      blocks,
      metadata: extracted.metadata ?? {},
      warnings: [],
      quality: {
        fidelity: 'high',
        isLossy: false,
        isOcr: false
      },
      extractor: this.metadata
    }
  }
}
