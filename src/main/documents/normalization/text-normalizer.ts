/**
 * Configurable options for text normalization.
 */
export interface TextNormalizationOptions {
  /**
   * Whether to strip the leading UTF-8 Byte Order Mark (\uFEFF) if present.
   * Default: true
   */
  readonly stripBom?: boolean

  /**
   * Whether to strip null bytes (\0).
   * Default: true
   */
  readonly stripNullBytes?: boolean

  /**
   * Whether to normalize CRLF (\r\n) and standalone CR (\r) line endings to LF (\n).
   * Default: true
   */
  readonly normalizeLineEndings?: boolean

  /**
   * Whether to strip C0 and C1 control characters (excluding tab \t [0x09] and newline \n [0x0A]).
   * Default: true
   */
  readonly stripControlCharacters?: boolean

  /**
   * Whether to collapse 3 or more consecutive newlines to \n\n.
   * - In legacy chunker normalization (normalizeText): true (reduces whitespace inflation)
   * - In document extraction preservation (normalizeDocumentText): false (preserves 1-based source lines)
   * Default in normalizeText: true
   */
  readonly collapseExcessiveNewlines?: boolean

  /**
   * Whether to apply Unicode Normalization Form C (NFC) canonical composition.
   * Preserves all scripts (Bengali, Latin, Japanese, Arabic, etc.), emoji, and combining characters.
   * Default: true
   */
  readonly unicodeNfc?: boolean
}

/**
 * Deterministic text normalizer for document text extraction and chunking.
 *
 * Normalization Policy & Guarantees:
 * 1. Strips leading UTF-8 BOM (\uFEFF) when enabled.
 * 2. Removes null bytes (\0) when enabled.
 * 3. Normalizes CRLF (\r\n) and standalone CR (\r) line endings to standard LF (\n).
 * 4. Strips C0/C1 control characters while strictly preserving tabs (\t) and newlines (\n).
 * 5. Collapses excessive consecutive newlines (>= 3 to \n\n) only when collapseExcessiveNewlines is true.
 * 6. Applies Unicode Normalization Form C (NFC), safely composing vowel signs, combining diacritics, and emoji.
 * 7. Never trims document boundaries silently, never truncates long lines, never strips punctuation.
 * 8. Never alters indentation or whitespace inside code blocks.
 * 9. Is strictly idempotent: normalizeText(normalizeText(t)) === normalizeText(t).
 */
export function normalizeText(text: string, options?: TextNormalizationOptions): string {
  if (typeof text !== 'string') {
    return ''
  }

  if (text.length === 0) {
    return ''
  }

  const stripBom = options?.stripBom ?? true
  const stripNullBytes = options?.stripNullBytes ?? true
  const normalizeLineEndings = options?.normalizeLineEndings ?? true
  const stripControlChars = options?.stripControlCharacters ?? true
  const collapseNewlines = options?.collapseExcessiveNewlines ?? true
  const unicodeNfc = options?.unicodeNfc ?? true

  // 1. Remove leading UTF-8 BOM if present
  let normalized = stripBom && text.startsWith('\uFEFF') ? text.slice(1) : text

  // 2. Remove null bytes
  if (stripNullBytes && normalized.includes('\0')) {
    normalized = normalized.replace(/\0/g, '')
  }

  // 3. Normalize CRLF (\r\n) to LF (\n)
  if (normalizeLineEndings && normalized.includes('\r\n')) {
    normalized = normalized.replace(/\r\n/g, '\n')
  }

  // 4. Normalize standalone CR (\r) to LF (\n)
  if (normalizeLineEndings && normalized.includes('\r')) {
    normalized = normalized.replace(/\r/g, '\n')
  }

  // 5. Remove unwanted C0 and C1 control characters (preserve \t [0x09] and \n [0x0A])
  if (stripControlChars) {
    // eslint-disable-next-line no-control-regex
    normalized = normalized.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
  }

  // 6. Collapse excessive consecutive newlines (>= 3) only when explicitly configured
  if (collapseNewlines) {
    normalized = normalized.replace(/\n{3,}/g, '\n\n')
  }

  // 7. Unicode Normalization Form C (NFC)
  if (unicodeNfc) {
    normalized = normalized.normalize('NFC')
  }

  return normalized
}

/**
 * Dedicated normalizer for canonical document extraction (TXT, Markdown).
 *
 * Invariant: Preserves ALL blank lines, exact source line counts, leading/trailing whitespace,
 * and code indentation without newline collapsing.
 */
export function normalizeDocumentText(text: string, options?: TextNormalizationOptions): string {
  return normalizeText(text, {
    collapseExcessiveNewlines: false,
    ...options
  })
}
