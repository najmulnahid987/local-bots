import { describe, it, expect } from 'vitest'
import { MarkdownExtractor, extractMarkdown } from './markdown-extractor'
import { DocumentExtractionError } from '../document-errors'

describe('MarkdownExtractor (Phase 5 Step 5.4)', () => {
  const extractor = new MarkdownExtractor()

  // 1. Plain Markdown paragraphs (no headings)
  it('1. extracts Markdown document with no headings as a single unheaded section', async () => {
    const md = 'Paragraph 1.\n\nParagraph 2 with **bold** and *italic* text.\n\n- Item 1\n- Item 2'
    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.format).toBe('md')
    expect(result.text).toBe(md)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].heading).toBeUndefined()
    expect(result.sections[0].headingLevel).toBeUndefined()
    expect(result.sections[0].headingPath).toBeUndefined()
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(6)
    expect(result.sections[0].text).toBe(md)
  })

  // 2. H1, H2, H3 extraction and heading hierarchy
  it('2. extracts H1, H2, and H3 headings with correct levels and titles', async () => {
    const md = [
      '# Project Overview',
      'This is the top-level project overview.',
      '## Architecture',
      'System architecture description.',
      '### Database Layer',
      'SQLite with WAL mode.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(3)

    // Section 1: H1
    expect(result.sections[0].heading).toBe('Project Overview')
    expect(result.sections[0].headingLevel).toBe(1)
    expect(result.sections[0].headingPath).toEqual(['Project Overview'])
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(2)
    expect(result.sections[0].text).toBe(
      '# Project Overview\nThis is the top-level project overview.'
    )

    // Section 2: H2
    expect(result.sections[1].heading).toBe('Architecture')
    expect(result.sections[1].headingLevel).toBe(2)
    expect(result.sections[1].headingPath).toEqual(['Project Overview', 'Architecture'])
    expect(result.sections[1].lineStart).toBe(3)
    expect(result.sections[1].lineEnd).toBe(4)
    expect(result.sections[1].text).toBe('## Architecture\nSystem architecture description.')

    // Section 3: H3
    expect(result.sections[2].heading).toBe('Database Layer')
    expect(result.sections[2].headingLevel).toBe(3)
    expect(result.sections[2].headingPath).toEqual([
      'Project Overview',
      'Architecture',
      'Database Layer'
    ])
    expect(result.sections[2].lineStart).toBe(5)
    expect(result.sections[2].lineEnd).toBe(6)
    expect(result.sections[2].text).toBe('### Database Layer\nSQLite with WAL mode.')
  })

  // 3. Heading stack reset behavior
  it('3. resets heading hierarchy when sibling or higher-level headings appear', async () => {
    const md = [
      '# Book',
      '## Chapter 1',
      '### Section 1.1',
      'Content 1.1',
      '### Section 1.2',
      'Content 1.2',
      '## Chapter 2',
      'Content 2',
      '# Appendix',
      'Appendix content'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(6)

    // Book (H1)
    expect(result.sections[0].headingPath).toEqual(['Book'])

    // Chapter 1 (H2)
    expect(result.sections[1].headingPath).toEqual(['Book', 'Chapter 1'])

    // Section 1.1 (H3)
    expect(result.sections[2].headingPath).toEqual(['Book', 'Chapter 1', 'Section 1.1'])

    // Section 1.2 replaces Section 1.1 at level 3
    expect(result.sections[3].headingPath).toEqual(['Book', 'Chapter 1', 'Section 1.2'])

    // Chapter 2 clears level 3 and replaces Chapter 1 at level 2
    expect(result.sections[4].headingPath).toEqual(['Book', 'Chapter 2'])

    // Appendix clears all level 2 and level 3 and replaces Book at level 1
    expect(result.sections[5].headingPath).toEqual(['Appendix'])
  })

  // 4. Content before the first heading (preamble)
  it('4. preserves preamble content before the first heading as an unheaded section', async () => {
    const md = [
      '---',
      'title: Frontmatter / Preamble Note',
      '---',
      'Introductory notes before the first heading.',
      '',
      '# Main Section',
      'Section body.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(2)

    // Section 0 (preamble)
    expect(result.sections[0].heading).toBeUndefined()
    expect(result.sections[0].headingLevel).toBeUndefined()
    expect(result.sections[0].headingPath).toBeUndefined()
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(5)
    expect(result.sections[0].text).toContain('Introductory notes before the first heading.')

    // Section 1 (first heading)
    expect(result.sections[1].heading).toBe('Main Section')
    expect(result.sections[1].headingLevel).toBe(1)
    expect(result.sections[1].headingPath).toEqual(['Main Section'])
    expect(result.sections[1].lineStart).toBe(6)
    expect(result.sections[1].lineEnd).toBe(7)
  })

  // 5. Strips optional closing hashes (CommonMark closed heading syntax)
  it('5. strips optional closing hashes in headings', async () => {
    const md = '## Configuration Options ##\nBody text.'
    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections[0].heading).toBe('Configuration Options')
    expect(result.sections[0].headingLevel).toBe(2)
  })

  // 6. Fenced backtick code blocks
  it('6. ignores heading-like syntax inside backtick code blocks', async () => {
    const md = [
      '# Code Guide',
      'Here is an example code block:',
      '```typescript',
      '# This is a comment, NOT a heading!',
      '## Another comment',
      'const x = 42;',
      '```',
      '## Actual Next Heading',
      'Post-code text.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    // Must have exactly 2 sections: # Code Guide and ## Actual Next Heading
    expect(result.sections).toHaveLength(2)
    expect(result.sections[0].heading).toBe('Code Guide')
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(7)
    expect(result.sections[0].text).toContain('# This is a comment, NOT a heading!')

    expect(result.sections[1].heading).toBe('Actual Next Heading')
    expect(result.sections[1].lineStart).toBe(8)
    expect(result.sections[1].lineEnd).toBe(9)
  })

  // 7. Fenced tilde code blocks
  it('7. ignores heading-like syntax inside tilde code blocks (~~~)', async () => {
    const md = [
      '# Shell Guide',
      '~~~bash',
      '# bash comment',
      '### another bash comment',
      'echo "done"',
      '~~~',
      '## Conclusion',
      'Shell guide conclusion.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(2)
    expect(result.sections[0].heading).toBe('Shell Guide')
    expect(result.sections[0].text).toContain('### another bash comment')
    expect(result.sections[1].heading).toBe('Conclusion')
  })

  // 8. Unclosed code fences
  it('8. handles unclosed code fences safely by treating remainder as code', async () => {
    const md = [
      '# Section 1',
      '```python',
      'def foo():',
      '    # still in unclosed block',
      '    return True'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].heading).toBe('Section 1')
    expect(result.sections[0].text).toContain('def foo():')
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(5)
  })

  // 9. Nested code fences with different lengths (e.g. 4 backticks containing 3 backticks)
  it('9. correctly handles 4-backtick code fences containing 3-backtick markdown blocks', async () => {
    const md = [
      '# Outer Section',
      '````markdown',
      '```ts',
      '# Still inside 4-backtick fence',
      'const a = 1;',
      '```',
      '````',
      '## Next Section',
      'Text.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(2)
    expect(result.sections[0].heading).toBe('Outer Section')
    expect(result.sections[0].text).toContain('# Still inside 4-backtick fence')
    expect(result.sections[1].heading).toBe('Next Section')
  })

  // 10. Heading requires space after hash
  it('10. treats #withoutSpace as regular text, not a heading', async () => {
    const md = [
      '# Valid Heading',
      'Tagging #typescript and #javascript here.',
      '#notAHeading because no space.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].heading).toBe('Valid Heading')
    expect(result.sections[0].text).toContain('#notAHeading because no space.')
  })

  // 11. Unicode headings and characters
  it('11. preserves Unicode headings and multilingual text', async () => {
    const md = [
      '# システムアーキテクチャ',
      '日本語のテキスト。',
      '## Модуль безопасности',
      'Русский текст.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    expect(result.sections).toHaveLength(2)
    expect(result.sections[0].heading).toBe('システムアーキテクチャ')
    expect(result.sections[1].heading).toBe('Модуль безопасности')
    expect(result.sections[1].headingPath).toEqual([
      'システムアーキテクチャ',
      'Модуль безопасности'
    ])
  })

  // 12. Complete content preservation (no content loss or duplication)
  it('12. guarantees that concatenated sections preserve the entire document without loss', async () => {
    const md = [
      'Introductory paragraph before any heading.',
      'Another intro line.',
      '# Section One',
      'Body paragraph 1.',
      '```ts',
      'const x = 1;',
      '```',
      '## Subsection 1.1',
      'Body paragraph 2.',
      '### Subsection 1.1.1',
      'Deep paragraph.',
      '# Section Two',
      'Final paragraph.'
    ].join('\n')

    const result = await extractor.extract(Buffer.from(md, 'utf-8'))

    // Reconstruct full text by joining section texts with newlines
    const reconstructed = result.sections.map((s) => s.text).join('\n')
    expect(reconstructed).toBe(result.text)
    expect(result.text).toBe(md)
  })

  // 13. BOM handling
  it('13. strips leading UTF-8 BOM from Markdown documents', async () => {
    const raw = '# BOM Title\nDocument text.'
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw, 'utf-8')])

    const result = await extractor.extract(buffer)
    expect(result.text).toBe(raw)
    expect(result.sections[0].heading).toBe('BOM Title')
  })

  // 14. Empty input
  it('14. returns empty result and 0 sections for empty 0-byte input', async () => {
    const result = await extractor.extract(Buffer.alloc(0))
    expect(result.format).toBe('md')
    expect(result.text).toBe('')
    expect(result.sections).toHaveLength(0)
    expect(result.metadata?.lineCount).toBe(0)
  })

  // 15. Malformed UTF-8 rejection
  it('15. rejects malformed UTF-8 sequences with EXTRACTION_INVALID_UTF8', async () => {
    const malformed = Buffer.from([0x23, 0x20, 0x54, 0x65, 0x73, 0x74, 0xff, 0xfe])

    await expect(extractor.extract(malformed)).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(malformed)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_UTF8'
      })
    )
  })

  // 16. Malformed input type rejection
  it('16. rejects non-byte input with EXTRACTION_MALFORMED_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract('not bytes' as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )
  })

  // 17. Determinism
  it('17. produces identical output on repeated runs', async () => {
    const md = '# Title\n\nBody text.\n## Subtitle\nMore text.'
    const buffer = Buffer.from(md, 'utf-8')

    const run1 = await extractor.extract(buffer)
    const run2 = await extractor.extract(buffer)

    expect(run1).toEqual(run2)
  })

  // 18. extractMarkdown helper
  it('18. extractMarkdown helper produces identical output', async () => {
    const buffer = Buffer.from('# Test\nHelper test.')
    const result = await extractMarkdown(buffer)
    expect(result.sections[0].heading).toBe('Test')
  })
})
