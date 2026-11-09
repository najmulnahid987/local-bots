/**
 * Deterministic text normalizer for document text extraction and chunking.
 *
 * Guarantees:
 * 1. Removes leading UTF-8 Byte Order Mark (\uFEFF).
 * 2. Removes null bytes (\0).
 * 3. Normalizes all CRLF (\r\n) and standalone CR (\r) line endings to LF (\n).
 * 4. Strips C0 and C1 control characters while preserving tabs (\t) and newlines (\n).
 * 5. Collapses excessive consecutive newlines (3 or more) to a maximum of two (\n\n).
 * 6. Applies Unicode Normalization Form C (NFC).
 * 7. Preserves indentation, code formatting, punctuation, words, and paragraph boundaries.
 * 8. Is strictly idempotent: normalizeText(normalizeText(text)) === normalizeText(text).
 */
export function normalizeText(text: string): string {
  if (typeof text !== 'string') {
    return ''
  }

  if (text.length === 0) {
    return ''
  }

  // 1. Remove leading UTF-8 BOM if present
  let normalized = text.startsWith('\uFEFF') ? text.slice(1) : text

  // 2. Remove null bytes
  if (normalized.includes('\0')) {
    normalized = normalized.replace(/\0/g, '')
  }

  // 3. Normalize CRLF (\r\n) to LF (\n)
  if (normalized.includes('\r\n')) {
    normalized = normalized.replace(/\r\n/g, '\n')
  }

  // 4. Normalize standalone CR (\r) to LF (\n)
  if (normalized.includes('\r')) {
    normalized = normalized.replace(/\r/g, '\n')
  }

  // 5. Remove unwanted C0 and C1 control characters (preserve \t [0x09] and \n [0x0A])
  // eslint-disable-next-line no-control-regex
  normalized = normalized.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')

  // 6. Collapse excessive consecutive newlines (>= 3) to a maximum of two (\n\n)
  normalized = normalized.replace(/\n{3,}/g, '\n\n')

  // 7. Unicode Normalization Form C (NFC)
  normalized = normalized.normalize('NFC')

  return normalized
}
