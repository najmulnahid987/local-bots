import { MarkdownExtractor } from '../../extractors/markdown-extractor'
import { parseMarkdownStructure } from '../../extractors/markdown-parser'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult
} from '../types'
import { normalizeFormatExtension } from '../format-detector'

/**
 * Adapter integrating MarkdownExtractor into the modular IDocumentExtractor architecture.
 *
 * Preserves:
 * 1. High-fidelity structural block extraction (headings, tables, lists, code fences, blockquotes).
 * 2. Exact 1-based source line boundaries (lineStart, lineEnd).
 * 3. Link metadata (display text, destination URLs, titles).
 * 4. Image reference preservation.
 * 5. Unterminated fence warnings and non-destructive inert HTML handling.
 */
export class MarkdownExtractorAdapter implements IDocumentExtractor {
  private readonly innerExtractor: MarkdownExtractor

  public readonly metadata: ExtractorMetadata = {
    id: 'purejs-markdown-extractor',
    name: 'Pure JavaScript Markdown Extractor',
    version: '1.1.0',
    supportedFormats: ['md', 'markdown'],
    supportedMimeTypes: ['text/markdown', 'text/x-markdown'],
    isHeavy: false,
    requiresUtilityProcess: false
  }

  constructor(innerExtractor?: MarkdownExtractor) {
    this.innerExtractor = innerExtractor ?? new MarkdownExtractor()
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

    if (extracted.text.length === 0) {
      return {
        format: 'md',
        text: '',
        blocks: [],
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

    const parsed = parseMarkdownStructure(extracted.text)

    return {
      format: 'md',
      text: extracted.text,
      blocks: parsed.blocks,
      metadata: {
        ...(extracted.metadata ?? {}),
        links: parsed.links
      },
      warnings: parsed.warnings,
      quality: parsed.quality,
      extractor: this.metadata
    }
  }
}
