import { isDisallowedControlCharacter } from '../document-file-validator'
import { DocumentErrors } from '../document-errors'

/**
 * Result emitted by format detection inspection.
 */
export interface DetectedFormat {
  /**
   * Canonical lower-case format extension (e.g. 'pdf', 'md', 'txt', 'docx', 'xlsx').
   */
  readonly canonicalFormat: string

  /**
   * Detection confidence level.
   */
  readonly confidence: 'exact' | 'high' | 'heuristic' | 'hint'

  /**
   * Whether unambiguous magic bytes were matched in the header.
   */
  readonly magicBytesMatched: boolean

  /**
   * Whether the byte stream is recognized as binary data.
   */
  readonly isBinary: boolean
}

/**
 * Normalizes any format string or extension into a clean lowercase extension without leading dot.
 */
export function normalizeFormatExtension(formatOrExt: string): string {
  if (!formatOrExt || typeof formatOrExt !== 'string') {
    return ''
  }
  const cleaned = formatOrExt.trim().toLowerCase().replace(/^\.+/, '')
  // Normalize common aliases
  if (cleaned === 'markdown') return 'md'
  if (cleaned === 'text') return 'txt'
  return cleaned
}

/**
 * Helper to check whether bytes match a specific prefix.
 */
function matchesPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

/**
 * FormatDetector inspects raw bytes, magic signatures, character encodings,
 * and filename/MIME hints to deterministically classify a document without
 * blindly trusting renderer inputs.
 */
export class FormatDetector {
  /**
   * Detects the canonical document format from bytes and optional hints.
   */
  public static detect(
    bytes: Uint8Array,
    filenameHint?: string,
    mimeHint?: string,
    formatHint?: string
  ): DetectedFormat {
    if (!bytes || !(bytes instanceof Uint8Array)) {
      throw DocumentErrors.extractionMalformedInput('Bytes must be a valid Uint8Array.')
    }

    // 1. Resolve hint from formatHint or filename
    let hintExt = normalizeFormatExtension(formatHint ?? '')
    if (!hintExt && filenameHint) {
      const match = filenameHint.match(/\.([a-zA-Z0-9_-]+)$/)
      if (match) {
        hintExt = normalizeFormatExtension(match[1])
      }
    }

    // MIME type hint resolution
    if (!hintExt && mimeHint) {
      const lowerMime = mimeHint.toLowerCase().trim()
      if (lowerMime === 'application/pdf') hintExt = 'pdf'
      else if (lowerMime === 'text/markdown') hintExt = 'md'
      else if (lowerMime === 'text/plain') hintExt = 'txt'
      else if (
        lowerMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
        hintExt = 'docx'
      else if (lowerMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        hintExt = 'xlsx'
      else if (
        lowerMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        lowerMime === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'
      )
        hintExt = 'pptx'
      else if (lowerMime === 'text/csv' || lowerMime === 'application/csv') hintExt = 'csv'
    }

    // 2. Check Magic Bytes

    // PDF Magic Bytes: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
    if (matchesPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      return {
        canonicalFormat: 'pdf',
        confidence: 'exact',
        magicBytesMatched: true,
        isBinary: true
      }
    }

    // ZIP Magic Bytes: PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
    // Common to DOCX, XLSX, PPTX, EPUB, and ZIP archives
    if (matchesPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) {
      // If hint specifies a known ZIP-based office format, resolve to that format
      if (hintExt === 'docx' || hintExt === 'xlsx' || hintExt === 'pptx') {
        return {
          canonicalFormat: hintExt,
          confidence: 'high',
          magicBytesMatched: true,
          isBinary: true
        }
      }
      // Inspect if ZIP contains word/document.xml or xl/workbook.xml even without filename hint
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      if (buf.includes('word/document.xml')) {
        return {
          canonicalFormat: 'docx',
          confidence: 'high',
          magicBytesMatched: true,
          isBinary: true
        }
      }
      if (buf.includes('xl/workbook.xml')) {
        return {
          canonicalFormat: 'xlsx',
          confidence: 'high',
          magicBytesMatched: true,
          isBinary: true
        }
      }
      if (buf.includes('ppt/presentation.xml')) {
        return {
          canonicalFormat: 'pptx',
          confidence: 'high',
          magicBytesMatched: true,
          isBinary: true
        }
      }
      return {
        canonicalFormat: 'zip',
        confidence: 'exact',
        magicBytesMatched: true,
        isBinary: true
      }
    }

    // 3. Inspect binary vs text characteristics
    // Inspect first 4096 bytes for disallowed control characters (NUL, etc.)
    const sampleLength = Math.min(bytes.length, 4096)
    let hasDisallowedControl = false

    for (let i = 0; i < sampleLength; i++) {
      if (isDisallowedControlCharacter(bytes[i])) {
        hasDisallowedControl = true
        break
      }
    }

    if (hasDisallowedControl) {
      // Binary content that did not match PDF or ZIP signatures
      return {
        canonicalFormat: hintExt || 'binary',
        confidence: 'hint',
        magicBytesMatched: false,
        isBinary: true
      }
    }

    // 4. Content is clean text (ASCII / UTF-8)
    // Decode a sample safely to inspect text patterns
    let textSample = ''
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false })
      textSample = decoder.decode(bytes.slice(0, Math.min(bytes.length, 8192)))
    } catch {
      // Decode error fallback
    }

    // Check HTML markers
    const trimmed = textSample.trimStart().toLowerCase()
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
      return {
        canonicalFormat: 'html',
        confidence: 'high',
        magicBytesMatched: false,
        isBinary: false
      }
    }

    // If hint is explicitly markdown
    if (hintExt === 'md') {
      return {
        canonicalFormat: 'md',
        confidence: 'high',
        magicBytesMatched: false,
        isBinary: false
      }
    }

    // If hint is explicitly csv
    if (hintExt === 'csv') {
      return {
        canonicalFormat: 'csv',
        confidence: 'high',
        magicBytesMatched: false,
        isBinary: false
      }
    }

    // Markdown heuristic inspection: ATX headings, Markdown tables, or code fences
    const hasMarkdownHeadings = /^[ ]{0,3}#{1,6}\s+/m.test(textSample)
    const hasMarkdownTable = /\|[\s:-]+\|[\s:-]+\|/m.test(textSample)
    const hasCodeFences = /^[ ]{0,3}(`{3,}|~{3,})/m.test(textSample)

    if (hasMarkdownHeadings || hasMarkdownTable || hasCodeFences) {
      return {
        canonicalFormat: 'md',
        confidence: 'heuristic',
        magicBytesMatched: false,
        isBinary: false
      }
    }

    // Default to hintExt if provided, or 'txt' for clean text
    const resolvedTextFormat = hintExt && hintExt !== 'pdf' ? hintExt : 'txt'
    return {
      canonicalFormat: resolvedTextFormat,
      confidence: hintExt ? 'high' : 'heuristic',
      magicBytesMatched: false,
      isBinary: false
    }
  }
}
