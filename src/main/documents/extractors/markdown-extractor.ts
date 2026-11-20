import { DocumentErrors } from '../document-errors'
import { normalizeDocumentText } from '../normalization/text-normalizer'
import { parseMarkdownStructure } from './markdown-parser'
import type { DocumentExtractor, ExtractedDocument } from './types'

/**
 * Pure-JavaScript structural text extractor for Markdown (.md) documents.
 *
 * Responsibilities:
 * 1. Strictly decodes UTF-8 bytes with fatal error handling and strips leading BOM.
 * 2. Normalizes line endings consistently to LF (\n) and applies Unicode NFC composition.
 * 3. Parses CommonMark ATX headings (# to ######) and Setext headings (= and -).
 * 4. Respects backtick and tilde fenced code blocks so code comments are never mistaken for headings.
 * 5. Partitions document into logical sections with exact 1-based source line boundaries.
 * 6. Preserves all paragraphs, code blocks, lists, and formatting without destructive modification.
 * 7. Treats all embedded HTML as inert text (never parses, executes, or evaluates).
 * 8. Guarantees complete content preservation (sections concatenated equal full text).
 */
export class MarkdownExtractor implements DocumentExtractor {
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })

  /**
   * Extracts structural sections and plain text from validated UTF-8 Markdown bytes.
   */
  public async extract(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
    if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
      throw DocumentErrors.extractionMalformedInput('Input must be a valid Buffer or Uint8Array.')
    }

    // 1. Handle empty input
    if (bytes.length === 0) {
      return {
        format: 'md',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          sectionCount: 0,
          byteLength: 0
        }
      }
    }

    // 2. Strict UTF-8 decoding
    let decoded: string
    try {
      decoded = this.utf8Decoder.decode(bytes)
    } catch {
      throw DocumentErrors.extractionInvalidUtf8()
    }

    // 3. Normalize text (strip BOM, CRLF/CR -> LF, NFC) without collapsing blank lines
    const rawText = normalizeDocumentText(decoded)

    if (rawText.length === 0) {
      return {
        format: 'md',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          sectionCount: 0,
          byteLength: bytes.length
        }
      }
    }

    // 4. Parse structural markdown
    const parsed = parseMarkdownStructure(rawText)
    const lineCount = rawText.split('\n').length

    return {
      format: 'md',
      text: rawText,
      sections: parsed.sections,
      metadata: {
        lineCount,
        sectionCount: parsed.sections.length,
        byteLength: bytes.length
      }
    }
  }
}

/**
 * Convenience function for extracting Markdown sections from bytes.
 */
export async function extractMarkdown(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
  return new MarkdownExtractor().extract(bytes)
}
