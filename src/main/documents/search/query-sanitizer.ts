/**
 * Query Sanitizer for SQLite FTS5 Full-Text Search.
 *
 * Transforms raw, untrusted user search queries into safe, syntax-valid FTS5 query expressions:
 * 1. Preserves exact phrases within balanced double quotes ("quantum entanglement").
 * 2. Safely handles special characters (e.g., @, ., +, -, :, ^, *, parentheses) by quoting tokens.
 * 3. Preserves trailing wildcard asterisks for prefix queries (e.g., superconduct* -> "superconduct"*).
 * 4. Preserves boolean operators (AND, OR, NOT) when validly positioned between search terms.
 * 5. Strips stray, dangling, or consecutive operators that would trigger SQLite FTS5 syntax errors.
 * 6. Normalizes Unicode to NFC and cleans non-printable control characters.
 */

/**
 * Strips non-printable ASCII control characters (0x00-0x1F) except standard whitespace.
 */
function cleanControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
}

type QueryItem = string | { operator: 'AND' | 'OR' | 'NOT' }

/**
 * Sanitizes and normalizes an untrusted search string into a safe FTS5 MATCH expression.
 * Returns an empty string if the query contains no valid search terms.
 */
export function sanitizeFts5SearchQuery(rawQuery: string): string {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return ''
  }

  const cleaned = cleanControlChars(rawQuery.normalize('NFC')).trim()
  if (cleaned.length === 0) {
    return ''
  }

  // Tokenize preserving quoted strings or whitespace-separated words
  const items: QueryItem[] = []
  const tokenRegex = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(cleaned)) !== null) {
    if (match[1] !== undefined) {
      // Balanced quoted phrase
      const inner = match[1].trim()
      if (inner.length > 0) {
        // Double inner quotes for SQLite string escaping and quote phrase
        const escaped = inner.replace(/"/g, '""')
        items.push(`"${escaped}"`)
      }
    } else if (match[2] !== undefined) {
      const rawToken = match[2].trim()
      const upper = rawToken.toUpperCase()

      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        items.push({ operator: upper })
      } else {
        // Check for wildcard prefix search (e.g. quantum*)
        const isPrefix = rawToken.endsWith('*') && rawToken.length > 1
        // Remove characters that act as FTS5 syntax delimiters outside quotes: ( ) " : ^ { }
        const cleanTerm = rawToken.replace(/[()":^|{}\\]/g, '').replace(/\*+$/g, '')

        if (cleanTerm.length > 0) {
          const escaped = cleanTerm.replace(/"/g, '""')
          if (isPrefix) {
            items.push(`"${escaped}"*`)
          } else {
            items.push(`"${escaped}"`)
          }
        }
      }
    }
  }

  // Filter and normalize operators to guarantee valid FTS5 syntax
  const validTokens: string[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (typeof item === 'string') {
      validTokens.push(item)
    } else {
      const op = item.operator
      // AND / OR must be preceded by a term and followed by a term
      if (
        (op === 'AND' || op === 'OR') &&
        validTokens.length > 0 &&
        validTokens[validTokens.length - 1] !== 'AND' &&
        validTokens[validTokens.length - 1] !== 'OR' &&
        validTokens[validTokens.length - 1] !== 'NOT'
      ) {
        // Peek forward to ensure there is a following string term
        const hasNextTerm = items.slice(i + 1).some((next) => typeof next === 'string')
        if (hasNextTerm) {
          validTokens.push(op)
        }
      } else if (op === 'NOT' && validTokens.length > 0) {
        // NOT must be preceded by a term and followed by a term
        const hasNextTerm = items.slice(i + 1).some((next) => typeof next === 'string')
        if (hasNextTerm && validTokens[validTokens.length - 1] !== 'NOT') {
          validTokens.push(op)
        }
      }
    }
  }

  // Remove any trailing operator
  while (
    validTokens.length > 0 &&
    (validTokens[validTokens.length - 1] === 'AND' ||
      validTokens[validTokens.length - 1] === 'OR' ||
      validTokens[validTokens.length - 1] === 'NOT')
  ) {
    validTokens.pop()
  }

  return validTokens.join(' ')
}
