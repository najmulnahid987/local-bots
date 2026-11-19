import { MarkdownExtractor } from '../../extractors/markdown-extractor'
import { parseMarkdownSectionBlocks } from '../../chunking/markdown-table-chunker'
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
 * Adapter integrating MarkdownExtractor into the modular IDocumentExtractor architecture.
 *
 * Preserves:
 * 1. Step 10.3 table detection, header isolation, and atomic row structures.
 * 2. Step 10.3 heading hierarchy paths and breadcrumb contexts.
 * 3. 100% backward compatibility with existing ExtractedDocument consumers.
 */
export class MarkdownExtractorAdapter implements IDocumentExtractor {
  private readonly innerExtractor: MarkdownExtractor

  public readonly metadata: ExtractorMetadata = {
    id: 'purejs-markdown-extractor',
    name: 'Pure JavaScript Markdown Extractor',
    version: '1.0.0',
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

    const blocks: ExtractedDocumentBlock[] = []

    for (const section of extracted.sections) {
      // 1. Heading block if section starts with heading
      if (section.heading) {
        blocks.push({
          type: 'heading',
          text: section.heading,
          heading: {
            level: section.headingLevel ?? 1,
            headingPath: section.headingPath ? [...section.headingPath] : [section.heading]
          },
          lineStart: section.lineStart,
          lineEnd: section.lineStart
        })
      }

      // 2. Parse structural blocks (prose, tables) using hardened block parser
      // If section was introduced by a heading, strip the leading heading line so it is not duplicated as a paragraph
      let bodyText = section.text
      if (section.heading) {
        bodyText = section.text.replace(/^[ ]{0,3}#{1,6}[ \t]+[^\r\n]*(\r?\n)?/, '')
      }

      if (bodyText.trim().length > 0) {
        const sectionBlocks = parseMarkdownSectionBlocks(bodyText)

        for (const block of sectionBlocks) {
          if (block.type === 'table') {
            const headerRow = block.headerLine || ''
            // Parse headers
            const headers = headerRow
              .trim()
              .slice(1, -1)
              .split('|')
              .map((cell) => cell.trim())

            // Parse data rows
            const rows = block.dataRows.map((row) =>
              row
                .trim()
                .slice(1, -1)
                .split('|')
                .map((cell) => cell.trim())
            )

            const rawTableText = [block.headerLine, block.delimiterLine, ...block.dataRows].join(
              '\n'
            )

            blocks.push({
              type: 'table',
              text: rawTableText,
              table: {
                headers,
                rows
              },
              lineStart: section.lineStart,
              lineEnd: section.lineEnd
            })
          } else {
            blocks.push({
              type: 'paragraph',
              text: block.content,
              lineStart: section.lineStart,
              lineEnd: section.lineEnd
            })
          }
        }
      }
    }

    return {
      format: 'md',
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
