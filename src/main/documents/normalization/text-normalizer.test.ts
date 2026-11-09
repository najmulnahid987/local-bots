import { describe, it, expect } from 'vitest'
import { normalizeText } from './text-normalizer'

describe('TextNormalizer (Phase 5 Step 5.6)', () => {
  // 1. BOM removal
  it('1. removes leading UTF-8 Byte Order Mark (\uFEFF)', () => {
    const withBom = '\uFEFFDocument text with leading BOM.'
    expect(normalizeText(withBom)).toBe('Document text with leading BOM.')

    const withoutBom = 'Document text without BOM.'
    expect(normalizeText(withoutBom)).toBe('Document text without BOM.')
  })

  // 2. Null byte removal
  it('2. strips null bytes (\0) throughout the text', () => {
    const withNulls = 'Text\0 with\0 multiple\0 null\0 bytes.'
    expect(normalizeText(withNulls)).toBe('Text with multiple null bytes.')
  })

  // 3. CRLF normalization
  it('3. normalizes Windows CRLF (\\r\\n) line endings to Unix LF (\\n)', () => {
    const crlf = 'Line 1\r\nLine 2\r\nLine 3'
    expect(normalizeText(crlf)).toBe('Line 1\nLine 2\nLine 3')
  })

  // 4. Standalone CR normalization
  it('4. normalizes legacy standalone CR (\\r) line endings to Unix LF (\\n)', () => {
    const standaloneCr = 'Line 1\rLine 2\rLine 3'
    expect(normalizeText(standaloneCr)).toBe('Line 1\nLine 2\nLine 3')
  })

  // 5. Mixed line endings normalization
  it('5. normalizes mixed line endings (\\r\\n, \\r, \\n) consistently to \\n', () => {
    const mixed = 'Line 1\r\nLine 2\rLine 3\nLine 4'
    expect(normalizeText(mixed)).toBe('Line 1\nLine 2\nLine 3\nLine 4')
  })

  // 6. Control character cleanup while preserving tabs and newlines
  it('6. strips unwanted C0 and C1 control characters while preserving tabs and newlines', () => {
    // \x07 (BEL), \x08 (BS), \x1B (ESC), \x7F (DEL), \x9B (C1 control)
    const withControls = 'Tab:\t\x07Newline:\n\x1BIndented:\t\tCode;\x7F\x9B'
    expect(normalizeText(withControls)).toBe('Tab:\tNewline:\nIndented:\t\tCode;')
  })

  // 7. Excessive newline collapsing
  it('7. collapses three or more consecutive newlines to exactly two (\\n\\n)', () => {
    const threeNewlines = 'Para 1\n\n\nPara 2'
    expect(normalizeText(threeNewlines)).toBe('Para 1\n\nPara 2')

    const fiveNewlines = 'Para 1\r\n\r\n\r\n\r\n\r\nPara 2'
    expect(normalizeText(fiveNewlines)).toBe('Para 1\n\nPara 2')

    // Single and double newlines remain intact
    const singleNewline = 'Line 1\nLine 2'
    expect(normalizeText(singleNewline)).toBe('Line 1\nLine 2')

    const doubleNewline = 'Para 1\n\nPara 2'
    expect(normalizeText(doubleNewline)).toBe('Para 1\n\nPara 2')
  })

  // 8. Unicode NFC normalization
  it('8. normalizes Unicode characters to Canonical Composition Form (NFC)', () => {
    // Decomposed 'e' + combining acute accent (\u0065\u0301)
    const decomposed = 'Caf\u0065\u0301'
    const composed = 'Caf\u00E9'

    expect(decomposed).not.toBe(composed)
    expect(normalizeText(decomposed)).toBe(composed)
  })

  // 9. Preservation of punctuation, words, casing, markdown, and code fences
  it('9. preserves markdown formatting, punctuation, casing, and indentation without modification', () => {
    const markdown = `# Architecture Overview (v1.0.0)

> [!NOTE]
> Do not mutate caller buffers.

\`\`\`typescript
function calculate(a: number, b: number): number {
\treturn a + b;
}
\`\`\`

- Bullet 1: [Link](https://example.com)
- Bullet 2: **Bold** and *Italic* text!`

    expect(normalizeText(markdown)).toBe(markdown)
  })

  // 10. Preservation of emojis and Unicode scripts
  it('10. preserves emojis, Japanese, Arabic, and multilingual characters faithfully', () => {
    const multiLang = 'Antigravity 🚀 — 知識ベース (Knowledge Base) — قاعدة المعرفة'
    expect(normalizeText(multiLang)).toBe(multiLang)
  })

  // 11. Empty and non-string inputs
  it('11. returns empty string for empty or non-string inputs safely', () => {
    expect(normalizeText('')).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeText(null as any)).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeText(undefined as any)).toBe('')
  })

  // 12. Strict Idempotency: normalize(normalize(text)) === normalize(text)
  it('12. is strictly idempotent across multiple passes', () => {
    const messyText =
      '\uFEFF\0Complex \r\n\r\n\r\n\r\nDocument\x07 with\t tabs,\r\r\rcarriage returns, and Caf\u0065\u0301.'
    const pass1 = normalizeText(messyText)
    const pass2 = normalizeText(pass1)
    const pass3 = normalizeText(pass2)

    expect(pass1).toBe(pass2)
    expect(pass2).toBe(pass3)
  })
})
