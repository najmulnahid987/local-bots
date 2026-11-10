import { describe, it, expect } from 'vitest'
import { sanitizeFts5SearchQuery } from './query-sanitizer'

describe('Query Sanitizer for SQLite FTS5 (Phase 5 Step 5.9)', () => {
  it('1. returns empty string for empty, undefined, null, or whitespace-only queries', () => {
    expect(sanitizeFts5SearchQuery('')).toBe('')
    expect(sanitizeFts5SearchQuery('   ')).toBe('')
    expect(sanitizeFts5SearchQuery(null as unknown as string)).toBe('')
    expect(sanitizeFts5SearchQuery(undefined as unknown as string)).toBe('')
    expect(sanitizeFts5SearchQuery('\t\n\r  ')).toBe('')
  })

  it('2. sanitizes simple words into quoted FTS5 tokens', () => {
    expect(sanitizeFts5SearchQuery('quantum')).toBe('"quantum"')
    expect(sanitizeFts5SearchQuery('quantum mechanics')).toBe('"quantum" "mechanics"')
  })

  it('3. preserves balanced quoted exact phrases', () => {
    expect(sanitizeFts5SearchQuery('"quantum entanglement"')).toBe('"quantum entanglement"')
    expect(sanitizeFts5SearchQuery('intro to "superconducting qubits" today')).toBe(
      '"intro" "to" "superconducting qubits" "today"'
    )
  })

  it('4. safely strips unclosed or stray quotes without syntax errors', () => {
    expect(sanitizeFts5SearchQuery('"unclosed query')).toBe('"unclosed" "query"')
    expect(sanitizeFts5SearchQuery('stray " quote " balance')).toBe('"stray" "quote" "balance"')
  })

  it('5. preserves trailing asterisks for wildcard prefix queries', () => {
    expect(sanitizeFts5SearchQuery('superconduct*')).toBe('"superconduct"*')
    expect(sanitizeFts5SearchQuery('quant* algorithm*')).toBe('"quant"* "algorithm"*')
    // Bare asterisk alone without token
    expect(sanitizeFts5SearchQuery('*')).toBe('')
  })

  it('6. safely handles special characters, punctuation, and symbols', () => {
    expect(sanitizeFts5SearchQuery('user@example.com')).toBe('"user@example.com"')
    expect(sanitizeFts5SearchQuery('C++')).toBe('"C++"')
    expect(sanitizeFts5SearchQuery('node.js v1.2.3')).toBe('"node.js" "v1.2.3"')
    expect(sanitizeFts5SearchQuery('123-456')).toBe('"123-456"')
    expect(sanitizeFts5SearchQuery('(parentheses)')).toBe('"parentheses"')
    expect(sanitizeFts5SearchQuery('column:field')).toBe('"columnfield"')
    expect(sanitizeFts5SearchQuery('^caret {curly} |pipe')).toBe('"caret" "curly" "pipe"')
  })

  it('7. preserves valid boolean operators between terms and strips dangling operators', () => {
    expect(sanitizeFts5SearchQuery('quantum OR entanglement')).toBe('"quantum" OR "entanglement"')
    expect(sanitizeFts5SearchQuery('alpha AND beta')).toBe('"alpha" AND "beta"')
    expect(sanitizeFts5SearchQuery('alpha NOT beta')).toBe('"alpha" NOT "beta"')

    // Dangling operators
    expect(sanitizeFts5SearchQuery('AND')).toBe('')
    expect(sanitizeFts5SearchQuery('OR')).toBe('')
    expect(sanitizeFts5SearchQuery('NOT')).toBe('')
    expect(sanitizeFts5SearchQuery('quantum AND')).toBe('"quantum"')
    expect(sanitizeFts5SearchQuery('AND quantum')).toBe('"quantum"')
    expect(sanitizeFts5SearchQuery('alpha AND OR beta')).toBe('"alpha" AND "beta"')
  })

  it('8. normalizes Unicode and strips non-printable control characters', () => {
    // Unicode NFC normalization (e.g. café composed vs decomposed)
    const decomposed = 'cafe\u0301'
    const sanitized = sanitizeFts5SearchQuery(decomposed)
    expect(sanitized).toBe('"café"')

    // Control characters
    expect(sanitizeFts5SearchQuery('quantum\x00\x08mechanics')).toBe('"quantum" "mechanics"')
  })
})
