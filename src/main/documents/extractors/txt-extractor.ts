import { DocumentErrors } from '../document-errors'
import type { DocumentExtractor, ExtractedDocument, ExtractedDocumentSection } from './types'

/**
 * Pure-JavaScript text extractor for plain text (.txt) files.
 *
 * Responsibilities:
 * 1. Strictly decodes UTF-8 bytes with fatal error handling.
 * 2. Handles and strips leading Byte Order Mark (\uFEFF) if present.
 * 3. Preserves all paragraphs, line breaks, whitespace, and Unicode characters faithfully.
 * 4. Emits a single logical ExtractedDocumentSection spanning line 1 to line N.
 * 5. Rejects malformed UTF-8 and non-byte inputs safely.
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

    // 3. Strip leading UTF-8 BOM if present
    const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded

    if (text.length === 0) {
      return {
        format: 'txt',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          byteLength: bytes.length
        }
      }
    }

    // 4. Calculate line count (counting \n boundaries)
    const lineCount = text.split('\n').length

    // 5. Construct single logical section for plain text
    const section: ExtractedDocumentSection = {
      text,
      lineStart: 1,
      lineEnd: lineCount
    }

    return {
      format: 'txt',
      text,
      sections: [section],
      metadata: {
        lineCount,
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
