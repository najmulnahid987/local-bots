import { DocumentErrors } from '../document-errors'
import { normalizeDocumentText } from '../normalization/text-normalizer'
import type { DocumentExtractor, ExtractedDocument, ExtractedDocumentSection } from './types'

/**
 * Pure-JavaScript text extractor for plain text (.txt) files.
 *
 * Responsibilities:
 * 1. Strictly decodes UTF-8 bytes with fatal error handling.
 * 2. Strips leading Byte Order Mark (\uFEFF) if present.
 * 3. Normalizes line endings consistently to LF (\n) and applies Unicode NFC composition.
 * 4. Preserves all blank lines, whitespace, indentation, and Unicode characters in full text.
 * 5. Segments non-empty lines into meaningful paragraph blocks with accurate 1-based lineStart/lineEnd coordinates.
 * 6. Rejects malformed UTF-8 and non-byte inputs safely.
 */
export class TxtExtractor implements DocumentExtractor {
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })

  /**
   * Extracts plain text from validated UTF-8 bytes.
   */
  public async extract(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
    if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
      throw DocumentErrors.extractionMalformedInput('Input must be a valid Buffer or Uint8Array.')
    }

    // 1. Handle empty input
    if (bytes.length === 0) {
      return {
        format: 'txt',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          paragraphCount: 0,
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
    const normalized = normalizeDocumentText(decoded)

    if (normalized.length === 0) {
      return {
        format: 'txt',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          paragraphCount: 0,
          byteLength: bytes.length
        }
      }
    }

    // 4. Split into lines
    const lines = normalized.split('\n')
    const totalLines = lines.length

    // 5. Segment paragraphs (consecutive non-empty lines)
    const sections: ExtractedDocumentSection[] = []
    let currentParaLines: string[] = []
    let currentParaStart = 1

    for (let i = 0; i < totalLines; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      if (line.trim().length > 0) {
        if (currentParaLines.length === 0) {
          currentParaStart = lineNumber
        }
        currentParaLines.push(line)
      } else {
        // Blank line: finalize current paragraph if any
        if (currentParaLines.length > 0) {
          sections.push({
            text: currentParaLines.join('\n'),
            lineStart: currentParaStart,
            lineEnd: lineNumber - 1
          })
          currentParaLines = []
        }
      }
    }

    // Finalize trailing paragraph
    if (currentParaLines.length > 0) {
      sections.push({
        text: currentParaLines.join('\n'),
        lineStart: currentParaStart,
        lineEnd: totalLines
      })
    }

    // If document is whitespace-only, preserve it as a single section so content is not lost
    if (sections.length === 0 && normalized.length > 0) {
      sections.push({
        text: normalized,
        lineStart: 1,
        lineEnd: totalLines
      })
    }

    return {
      format: 'txt',
      text: normalized,
      sections,
      metadata: {
        lineCount: totalLines,
        paragraphCount: sections.length,
        byteLength: bytes.length
      }
    }
  }
}

/**
 * Convenience function for extracting plain text from bytes.
 */
export async function extractTxt(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
  return new TxtExtractor().extract(bytes)
}
