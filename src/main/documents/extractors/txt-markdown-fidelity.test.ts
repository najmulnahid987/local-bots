import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { TxtExtractor } from './txt-extractor'
import { MarkdownExtractorAdapter } from '../extraction/adapters/markdown-extractor-adapter'
import { DocumentExtractionService } from '../extraction/extraction-service'
import { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { DocumentExtractionError } from '../document-errors'
import type {
  UniversalParagraphBlock,
  UniversalTableBlock,
  UniversalListBlock,
  UniversalCodeBlock
} from '../model/types'

describe('Phase 11 Step 11.4: Plain Text & Markdown Extraction Fidelity', () => {
  const txtExtractor = new TxtExtractor()
  const mdAdapter = new MarkdownExtractorAdapter()

  const dummyContext = {
    limits: {
      timeoutMs: 10000,
      maxInputSizeBytes: 20 * 1024 * 1024,
      maxOutputSizeBytes: 50 * 1024 * 1024,
      maxPages: 200
    }
  }

  // ==========================================================================
  // Part 1: TXT Extraction Fidelity (14 Core Scenarios)
  // ==========================================================================
  describe('TXT Extraction Fidelity', () => {
    // 1. Multiple paragraphs separated by blank lines
    it('1. segments consecutive non-empty lines into paragraphs separated by blank lines', async () => {
      const txt =
        'Paragraph 1 line 1.\nParagraph 1 line 2.\n\nParagraph 2 single line.\n\nParagraph 3 line 1.\nParagraph 3 line 2.'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.text).toBe(txt)
      expect(result.sections).toHaveLength(3)

      expect(result.sections[0].text).toBe('Paragraph 1 line 1.\nParagraph 1 line 2.')
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[0].lineEnd).toBe(2)

      expect(result.sections[1].text).toBe('Paragraph 2 single line.')
      expect(result.sections[1].lineStart).toBe(4)
      expect(result.sections[1].lineEnd).toBe(4)

      expect(result.sections[2].text).toBe('Paragraph 3 line 1.\nParagraph 3 line 2.')
      expect(result.sections[2].lineStart).toBe(6)
      expect(result.sections[2].lineEnd).toBe(7)
    })

    // 2. Multiple lines inside one paragraph
    it('2. preserves internal line breaks inside a single paragraph', async () => {
      const txt = 'Line A\nLine B\nLine C'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].text).toBe('Line A\nLine B\nLine C')
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[0].lineEnd).toBe(3)
    })

    // 3. Leading indentation
    it('3. preserves leading spaces and indentation in each line verbatim', async () => {
      const txt = '    Indented line 1 (4 spaces)\n        Indented line 2 (8 spaces)'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.sections[0].text).toBe(txt)
      expect(result.sections[0].text).toContain('    Indented line 1')
      expect(result.sections[0].text).toContain('        Indented line 2')
    })

    // 4. Repeated spaces
    it('4. preserves repeated consecutive spaces without collapsing', async () => {
      const txt = 'Word1     Word2          Word3'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.sections[0].text).toBe(txt)
      expect(result.sections[0].text).toContain('Word1     Word2          Word3')
    })

    // 5. Tabs
    it('5. preserves horizontal tab characters (\\t) faithfully', async () => {
      const txt = 'Col1\tCol2\tCol3\nVal1\tVal2\tVal3'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.sections[0].text).toBe(txt)
      expect(result.sections[0].text).toContain('\t')
    })

    // 6. Empty lines
    it('6. preserves empty lines in full document text without creating empty paragraph blocks', async () => {
      const txt = '\n\nFirst paragraph after leading blank lines.\n\n\n\nSecond paragraph.'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.text).toBe(txt)
      expect(result.sections).toHaveLength(2)
      expect(result.sections[0].text).toBe('First paragraph after leading blank lines.')
      expect(result.sections[0].lineStart).toBe(3)
      expect(result.sections[0].lineEnd).toBe(3)
      expect(result.sections[1].text).toBe('Second paragraph.')
      expect(result.sections[1].lineStart).toBe(7)
      expect(result.sections[1].lineEnd).toBe(7)
    })

    // 7. Whitespace-only lines
    it('7. preserves whitespace-only lines in full text without corrupting line count', async () => {
      const txt = 'Paragraph 1\n   \n\t\nParagraph 2'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.text).toBe(txt)
      expect(result.sections).toHaveLength(2)
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[0].lineEnd).toBe(1)
      expect(result.sections[1].lineStart).toBe(4)
      expect(result.sections[1].lineEnd).toBe(4)
      expect(result.metadata?.lineCount).toBe(4)
    })

    // 8. Bengali text
    it('8. faithfully extracts Bengali text, vowel signs, and conjuncts with exact coordinates', async () => {
      const bengali =
        'প্রথম অনুচ্ছেদ: বাংলা সাহিত্যের ইতিহাস সমৃদ্ধ ও প্রাচীন।\n\nদ্বিতীয় অনুচ্ছেদ: রবীন্দ্রভারতী আন্তর্জাতিক বিশ্ববিদ্যালয়।'
      const result = await txtExtractor.extract(Buffer.from(bengali, 'utf-8'))

      expect(result.sections).toHaveLength(2)
      expect(result.sections[0].text).toContain('প্রথম অনুচ্ছেদ')
      expect(result.sections[1].text).toContain('দ্বিতীয় অনুচ্ছেদ'.normalize('NFC'))
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[1].lineStart).toBe(3)
    })

    // 9. Emoji
    it('9. preserves emojis and multi-byte Unicode glyphs accurately', async () => {
      const txt = '🤖 AI Agent workspace\n🚀 Autonomous processing\n🇧🇩 Bangladesh'
      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))

      expect(result.sections[0].text).toContain('🤖')
      expect(result.sections[0].text).toContain('🚀')
      expect(result.sections[0].text).toContain('🇧🇩')
    })

    // 10. Combining Unicode characters (NFC composition)
    it('10. normalizes decomposed Unicode characters into canonical NFC composition', async () => {
      // e + \u0301 (combining acute) -> é (\u00E9)
      const decomposed = 'Caf\u0065\u0301 culture and na\u00EFve art'
      const composed = 'Caf\u00E9 culture and na\u00EFve art'
      const result = await txtExtractor.extract(Buffer.from(decomposed, 'utf-8'))

      expect(result.text).toBe(composed)
      expect(result.sections[0].text).toBe(composed)
    })

    // 11. Very long lines (>10,000 characters)
    it('11. preserves very long lines without truncation or memory issues', async () => {
      const longSentence = 'Telemetry metrics stream across distributed nodes. '
      const longLine = longSentence.repeat(250) // 12,750 characters
      const txt = `Header\n${longLine}\nFooter`

      const result = await txtExtractor.extract(Buffer.from(txt, 'utf-8'))
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].text.length).toBe(txt.length)
      expect(result.metadata?.lineCount).toBe(3)
    })

    // 12. Line ending variations (LF, CRLF, CR)
    it('12. normalizes Windows CRLF and standalone CR line endings consistently', async () => {
      const crlf = 'Line 1\r\nLine 2\r\n\r\nLine 3\rLine 4'
      const result = await txtExtractor.extract(Buffer.from(crlf, 'utf-8'))

      expect(result.text).toBe('Line 1\nLine 2\n\nLine 3\nLine 4')
      expect(result.sections).toHaveLength(2)
      expect(result.sections[0].text).toBe('Line 1\nLine 2')
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[0].lineEnd).toBe(2)
      expect(result.sections[1].text).toBe('Line 3\nLine 4')
      expect(result.sections[1].lineStart).toBe(4)
      expect(result.sections[1].lineEnd).toBe(5)
    })

    // 13. UTF-8 BOM
    it('13. safely strips leading UTF-8 Byte Order Mark (BOM) without affecting coordinates', async () => {
      const txt = 'Text starting with BOM.'
      const bomBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(txt, 'utf-8')])

      const result = await txtExtractor.extract(bomBuffer)
      expect(result.text).toBe(txt)
      expect(result.sections[0].lineStart).toBe(1)
      expect(result.sections[0].lineEnd).toBe(1)
    })

    // 14. Invalid UTF-8 rejection
    it('14. strictly rejects malformed UTF-8 bytes with EXTRACTION_INVALID_UTF8', async () => {
      const malformed = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe])

      await expect(txtExtractor.extract(malformed)).rejects.toThrow(DocumentExtractionError)
      await expect(txtExtractor.extract(malformed)).rejects.toThrow(
        expect.objectContaining({ code: 'EXTRACTION_INVALID_UTF8' })
      )
    })
  })

  // ==========================================================================
  // Part 2: Markdown Extraction Fidelity (23 Core Scenarios)
  // ==========================================================================
  describe('Markdown Extraction Fidelity', () => {
    // 1. ATX headings at all six levels (# to ######)
    it('1. extracts ATX headings at all six levels (# to ######) with correct levels and titles', async () => {
      const md = [
        '# Heading 1',
        '## Heading 2',
        '### Heading 3',
        '#### Heading 4',
        '##### Heading 5',
        '###### Heading 6'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(6)
      for (let lvl = 1; lvl <= 6; lvl++) {
        const b = result.blocks[lvl - 1]
        expect(b.type).toBe('heading')
        expect(b.text).toBe(`Heading ${lvl}`)
        expect(b.heading?.level).toBe(lvl)
        expect(b.lineStart).toBe(lvl)
        expect(b.lineEnd).toBe(lvl)
      }
    })

    // 2. Setext headings (= for H1, - for H2)
    it('2. extracts Setext headings (= for H1, - for H2) spanning 2 lines', async () => {
      const md = [
        'Setext Level One',
        '================',
        '',
        'Setext Level Two',
        '----------------'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(2)

      // H1 Setext
      expect(result.blocks[0].type).toBe('heading')
      expect(result.blocks[0].text).toBe('Setext Level One')
      expect(result.blocks[0].heading?.level).toBe(1)
      expect(result.blocks[0].heading?.headingPath).toEqual(['Setext Level One'])
      expect(result.blocks[0].lineStart).toBe(1)
      expect(result.blocks[0].lineEnd).toBe(2)

      // H2 Setext
      expect(result.blocks[1].type).toBe('heading')
      expect(result.blocks[1].text).toBe('Setext Level Two')
      expect(result.blocks[1].heading?.level).toBe(2)
      expect(result.blocks[1].heading?.headingPath).toEqual([
        'Setext Level One',
        'Setext Level Two'
      ])
      expect(result.blocks[1].lineStart).toBe(4)
      expect(result.blocks[1].lineEnd).toBe(5)
    })

    // 3. Heading level jumps (e.g. H1 followed directly by H3)
    it('3. handles skipped heading levels (H1 -> H3) with authentic breadcrumbs', async () => {
      const md = '# Root Guide\n\n### Deep Sub-Section\n\nProse content.'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const h1 = result.blocks[0]
      const h3 = result.blocks[1]

      expect(h1.heading?.level).toBe(1)
      expect(h1.heading?.headingPath).toEqual(['Root Guide'])

      expect(h3.heading?.level).toBe(3)
      expect(h3.heading?.headingPath).toEqual(['Root Guide', 'Deep Sub-Section'])
    })

    // 4. Headings inside fenced code (must not be parsed as headings)
    it('4. ignores heading syntax inside code fences', async () => {
      const md = [
        '# Document Header',
        '```bash',
        '# Comment inside bash code',
        '## Another comment',
        'echo "running"',
        '```',
        '## Next Valid Heading'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const headingBlocks = result.blocks.filter((b) => b.type === 'heading')
      expect(headingBlocks).toHaveLength(2)
      expect(headingBlocks[0].text).toBe('Document Header')
      expect(headingBlocks[1].text).toBe('Next Valid Heading')

      const codeBlock = result.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.code?.code).toContain('# Comment inside bash code')
    })

    // 5. Backtick code fences
    it('5. preserves backtick code fences with language metadata and verbatim indentation', async () => {
      const md =
        '```typescript\nfunction add(a: number, b: number): number {\n\treturn a + b;\n}\n```'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const b = result.blocks[0]
      expect(b.type).toBe('code')
      expect(b.code?.language).toBe('typescript')
      expect(b.code?.code).toBe('function add(a: number, b: number): number {\n\treturn a + b;\n}')
      expect(b.lineStart).toBe(1)
      expect(b.lineEnd).toBe(5)
    })

    // 6. Tilde code fences (~~~)
    it('6. extracts tilde code fences (~~~) with language and exact line span', async () => {
      const md = '~~~python\ndef hello():\n    print("world")\n~~~'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const b = result.blocks[0]
      expect(b.type).toBe('code')
      expect(b.code?.language).toBe('python')
      expect(b.code?.code).toBe('def hello():\n    print("world")')
    })

    // 7. Variable-length code fences (4 backticks enclosing 3 backticks)
    it('7. correctly preserves 4-backtick fences containing 3-backtick markdown blocks', async () => {
      const md = '````markdown\n```json\n{"key": "value"}\n```\n````'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const b = result.blocks[0]
      expect(b.type).toBe('code')
      expect(b.code?.code).toBe('```json\n{"key": "value"}\n```')
    })

    // 8. Unterminated code fences
    it('8. safely handles unterminated code fences, preserving remaining content with warning', async () => {
      const md = '# Title\n```python\ndef incomplete():\n    return 42'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(2)
      const codeBlock = result.blocks[1]
      expect(codeBlock.type).toBe('code')
      expect(codeBlock.code?.code).toContain('def incomplete():')
      expect(result.warnings.some((w) => w.code === 'UNTERMINATED_CODE_FENCE')).toBe(true)
    })

    // 9. Nested ordered and unordered lists
    it('9. preserves nested list items and indent depth hierarchy', async () => {
      const md = [
        '- Top level item 1',
        '  - Sub item 1.1',
        '  - Sub item 1.2',
        '- Top level item 2'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const listBlock = result.blocks[0]
      expect(listBlock.type).toBe('list')
      expect(listBlock.list?.items).toHaveLength(4)
      expect(listBlock.list?.itemDetails?.[0].depth).toBe(0)
      expect(listBlock.list?.itemDetails?.[1].depth).toBe(1)
      expect(listBlock.list?.itemDetails?.[2].depth).toBe(1)
      expect(listBlock.list?.itemDetails?.[3].depth).toBe(0)
    })

    // 10. Task lists ([x] vs [ ])
    it('10. parses task lists with checked and unchecked boolean state', async () => {
      const md = [
        '- [x] Completed task item',
        '- [ ] Pending task item',
        '- [X] Also completed task'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const list = result.blocks[0].list
      expect(list?.itemDetails?.[0].checked).toBe(true)
      expect(list?.itemDetails?.[0].text).toBe('Completed task item')

      expect(list?.itemDetails?.[1].checked).toBe(false)
      expect(list?.itemDetails?.[1].text).toBe('Pending task item')

      expect(list?.itemDetails?.[2].checked).toBe(true)
      expect(list?.itemDetails?.[2].text).toBe('Also completed task')
    })

    // 11. Multiline list items with continuation lines
    it('11. preserves continuation lines in multiline list items', async () => {
      const md = ['- First item line one', '  continuation of first item', '- Second item'].join(
        '\n'
      )

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const items = result.blocks[0].list?.itemDetails
      expect(items?.[0].text).toContain('First item line one\ncontinuation of first item')
      expect(items?.[1].text).toBe('Second item')
    })

    // 12. GFM tables with empty cells
    it('12. preserves table headers, data rows, and empty cells faithfully', async () => {
      const md = [
        '| Header A | Header B | Header C |',
        '|---|---|---|',
        '| val1 |  | val3 |',
        '|  | val5 |  |'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const table = result.blocks[0].table
      expect(table?.headers).toEqual(['Header A', 'Header B', 'Header C'])
      expect(table?.rows).toHaveLength(2)
      expect(table?.rows[0]).toEqual(['val1', '', 'val3'])
      expect(table?.rows[1]).toEqual(['', 'val5', ''])
    })

    // 13. Escaped table delimiters (\|)
    it('13. correctly handles escaped pipes (\\|) inside table cells without splitting cells', async () => {
      const md = [
        '| Command | Description |',
        '|---|---|',
        '| `cat file \\| grep foo` | Pipes output to grep |'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const table = result.blocks[0].table
      expect(table?.headers).toEqual(['Command', 'Description'])
      expect(table?.rows[0][0]).toContain('cat file | grep foo')
      expect(table?.rows[0][1]).toBe('Pipes output to grep')
    })

    // 14. Inline code inside tables (code spans containing pipes)
    it('14. respects inline code spans containing unescaped pipes in tables', async () => {
      const md = ['| Syntax | Role |', '|---|---|', '| `a | b` | Logical OR pattern |'].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const table = result.blocks[0].table
      expect(table?.rows[0][0]).toBe('`a | b`')
      expect(table?.rows[0][1]).toBe('Logical OR pattern')
    })

    // 15. Blockquotes and nested quotes
    it('15. classifies blockquotes with isQuote: true and tracks nesting depth', async () => {
      const md = '> First line of quote\n> Second line of quote'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const b = result.blocks[0]
      expect(b.type).toBe('paragraph')
      expect(b.isQuote).toBe(true)
      expect(b.text).toContain('First line of quote\n> Second line of quote')
      expect(b.metadata?.isQuote).toBe(true)
    })

    // 16. Inline links with destination URLs
    it('16. extracts hyperlink destination URLs, display text, and optional titles into metadata', async () => {
      const md =
        'Check the [Official Docs](https://electronjs.org "Electron Documentation") for details.'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      const para = result.blocks[0]
      expect(para.text).toBe(md)
      // Check block metadata
      const blockLinks = para.metadata?.links as Array<{
        text: string
        url: string
        title?: string
      }>
      expect(blockLinks).toBeDefined()
      expect(blockLinks[0].text).toBe('Official Docs')
      expect(blockLinks[0].url).toBe('https://electronjs.org')
      expect(blockLinks[0].title).toBe('Electron Documentation')
      // Check document metadata summary
      const docLinks = result.metadata.links as Array<{ text: string; url: string }>
      expect(docLinks.some((l) => l.url === 'https://electronjs.org')).toBe(true)
    })

    // 17. Reference-style links
    it('17. preserves reference-style link text and definitions without discarding syntax', async () => {
      const md = 'Reference [here][ref1].\n\n[ref1]: https://example.com/reference'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.text).toContain('[ref1]: https://example.com/reference')
      expect(result.blocks.length).toBeGreaterThanOrEqual(1)
    })

    // 18. Images with alt text and URLs
    it('18. preserves standalone images as image_reference blocks with altText, referenceId, and caption', async () => {
      const md = '![System Architecture Diagram](https://example.com/diag.png "Architecture v1")'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      const imgBlock = result.blocks[0]
      expect(imgBlock.type).toBe('image_reference')
      expect(imgBlock.imageReference?.altText).toBe('System Architecture Diagram')
      expect(imgBlock.imageReference?.referenceId).toBe('https://example.com/diag.png')
      expect(imgBlock.imageReference?.caption).toBe('Architecture v1')
      expect(result.quality.hasUnparsedElements).toBe(true)
    })

    // 19. Inline HTML (inert text with non-destructive preservation and warning)
    it('19. preserves inline and block HTML as inert text without execution, emitting warning', async () => {
      const md = '<div class="alert">\n<p>HTML paragraph content</p>\n</div>'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0].text).toBe(md)
      expect(result.warnings.some((w) => w.code === 'INERT_HTML_PRESERVED')).toBe(true)
      expect(result.quality.hasUnparsedElements).toBe(true)
    })

    // 20. Horizontal rules (---, ***, ___)
    it('20. extracts thematic breaks / horizontal rules without mistaking them for Setext headings', async () => {
      const md = 'Paragraph One\n\n---\n\nParagraph Two\n\n***\n\nParagraph Three'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      // Must have paragraphs and thematic breaks, NOT Setext headings
      const headings = result.blocks.filter((b) => b.type === 'heading')
      expect(headings).toHaveLength(0)

      const hrBlocks = result.blocks.filter((b) => b.metadata?.isHorizontalRule === true)
      expect(hrBlocks).toHaveLength(2)
      expect(hrBlocks[0].text).toBe('---')
      expect(hrBlocks[1].text).toBe('***')
    })

    // 21. Bengali prose in Markdown
    it('21. preserves Bengali headings, prose, and list items in Markdown structure', async () => {
      const md = [
        '# স্থানীয় এআই এজেন্ট প্ল্যাটফর্ম',
        '',
        'এটি একটি স্বশাসিত অফলাইন অ্যাপ্লিকেশন।',
        '',
        '## বৈশিষ্ট্যসমূহ',
        '',
        '- সম্পুর্ণ স্থানীয় জ্ঞানভাণ্ডার',
        '- বহু-মডেল সমর্থন'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks).toHaveLength(4)
      expect(result.blocks[0].type).toBe('heading')
      expect(result.blocks[0].text).toBe('স্থানীয় এআই এজেন্ট প্ল্যাটফর্ম'.normalize('NFC'))

      expect(result.blocks[1].type).toBe('paragraph')
      expect(result.blocks[1].text).toContain('স্বশাসিত')

      expect(result.blocks[2].type).toBe('heading')
      expect(result.blocks[2].text).toBe('বৈশিষ্ট্যসমূহ'.normalize('NFC'))

      expect(result.blocks[3].type).toBe('list')
      expect(result.blocks[3].list?.items).toHaveLength(2)
    })

    // 22. Unicode and emoji in Markdown
    it('22. preserves emojis in headings, code blocks, and list items', async () => {
      const md = '# 🚀 Launch Checklist\n\n- [x] 🤖 Run automated tests\n- [ ] 🔒 Verify security'
      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks[0].text).toContain('🚀 Launch Checklist')
      expect(result.blocks[1].list?.items[0]).toContain('🤖 Run automated tests')
      expect(result.blocks[1].list?.items[1]).toContain('🔒 Verify security')
    })

    // 23. Mixed Markdown content containing multiple structures in one file
    it('23. extracts complex mixed Markdown document with correct source locations and types', async () => {
      const md = [
        '# System Architecture (v2)',
        '',
        'Introductory overview prose for the multi-model workspace.',
        '',
        '## Database Components',
        '',
        '| Table | Engine | Cascade |',
        '|---|---|---|',
        '| knowledge_sources | SQLite | ON DELETE CASCADE |',
        '| knowledge_extracted_documents | SQLite | ON DELETE CASCADE |',
        '',
        '### Code Sample',
        '',
        '```typescript',
        'const db = new Database(":memory:");',
        'db.pragma("foreign_keys = ON;");',
        '```',
        '',
        '> [!NOTE]',
        '> Foreign keys must be strictly enforced.',
        '',
        '![Diagram](https://example.com/arch.png)',
        '',
        '- [x] Phase 11 Step 11.1 Audit',
        '- [x] Phase 11 Step 11.2 Model',
        '- [x] Phase 11 Step 11.3 Persistence',
        '- [ ] Phase 11 Step 11.4 Extraction Fidelity'
      ].join('\n')

      const result = await mdAdapter.extract(
        { bytes: new Uint8Array(Buffer.from(md, 'utf-8')) },
        dummyContext
      )

      expect(result.blocks.length).toBeGreaterThanOrEqual(8)

      // Check block type sequence
      const types = result.blocks.map((b) => b.type)
      expect(types).toContain('heading')
      expect(types).toContain('paragraph')
      expect(types).toContain('table')
      expect(types).toContain('code')
      expect(types).toContain('image_reference')
      expect(types).toContain('list')

      // Check strictly increasing order and valid 1-based line coordinates
      for (let idx = 0; idx < result.blocks.length; idx++) {
        const b = result.blocks[idx]
        expect(b.lineStart).toBeDefined()
        expect(b.lineEnd).toBeDefined()
        expect(b.lineStart!).toBeGreaterThanOrEqual(1)
        expect(b.lineEnd!).toBeGreaterThanOrEqual(b.lineStart!)
        if (idx > 0) {
          expect(b.lineStart!).toBeGreaterThanOrEqual(result.blocks[idx - 1].lineStart!)
        }
      }
    })
  })

  // ==========================================================================
  // Part 3: UniversalDocument Persistence Round-Trip Integration
  // ==========================================================================
  describe('UniversalDocument Persistence & Round-Trip Verification', () => {
    let db: Database.Database
    let service: DocumentExtractionService
    let docRepo: ExtractedDocumentRepository

    const testKbId = 'a1b2c3d4-1111-4000-8000-000000000001'
    const testSourceId = 'b1b2c3d4-2222-4000-8000-000000000002'

    beforeEach(() => {
      db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      runMigrations(db, migrations)

      service = new DocumentExtractionService()
      docRepo = new ExtractedDocumentRepository(db)

      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(testKbId, 'Fidelity KB', 'kb-path-fidelity', now, now)

      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'fidelity_test.md', 'fidelity_test.md', 'originals/fidelity_test.md', 'md', 'text/markdown', 2048, ?, 'processing', ?, ?)`
      ).run(testSourceId, testKbId, 'a'.repeat(64), now, now)
    })

    afterEach(() => {
      db.close()
    })

    it('24. extracts UniversalDocument from Markdown and round-trips through SQLite without information loss', async () => {
      const markdownContent = [
        '# Document Specification',
        '',
        'Comprehensive specification for information preservation in the knowledge base pipeline.',
        '',
        '## Data Matrix',
        '',
        '| Metric | Target | Status |',
        '|---|---|---|',
        '| Precision | 100% | Verified |',
        '| Recall | 100% | Verified |',
        '',
        '## Execution Code',
        '',
        '```typescript',
        'function verifyFidelity(doc: UniversalDocument): boolean {',
        '    return doc.blocks.length > 0;',
        '}',
        '```',
        '',
        '- [x] Task 1 Completed',
        '- [ ] Task 2 In Progress'
      ].join('\n')

      const bytes = new Uint8Array(Buffer.from(markdownContent, 'utf-8'))

      // 1. Extract UniversalDocument using extraction service
      const universalDoc = await service.extractUniversal(
        {
          bytes,
          formatHint: 'md',
          filenameHint: 'fidelity_test.md'
        },
        {
          sourceId: testSourceId,
          knowledgeBaseId: testKbId,
          originalFileName: 'fidelity_test.md'
        }
      )

      expect(universalDoc.format).toBe('md')
      expect(universalDoc.sourceId).toBe(testSourceId)
      expect(universalDoc.text).toBe(markdownContent)
      expect(universalDoc.blocks.length).toBeGreaterThanOrEqual(6)

      // 2. Persist in SQLite
      const saveResult = docRepo.save(testSourceId, universalDoc)
      expect(saveResult.source_id).toBe(testSourceId)
      expect(saveResult.block_count).toBe(universalDoc.blocks.length)

      // 3. Verify cryptographic integrity
      const verification = docRepo.verify(testSourceId)
      expect(verification.valid).toBe(true)
      expect(verification.computed_hash).toBe(saveResult.document_hash)

      // 4. Retrieve back from SQLite
      const retrieved = docRepo.get(testSourceId)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(universalDoc.id)
      expect(retrieved!.format).toBe('md')
      expect(retrieved!.text).toBe(markdownContent)
      expect(retrieved!.blocks).toHaveLength(universalDoc.blocks.length)

      // Check table preservation on readback
      const table = retrieved!.blocks.find((b) => b.type === 'table') as UniversalTableBlock
      expect(table).toBeDefined()
      expect(table.headers).toEqual(['Metric', 'Target', 'Status'])
      expect(table.rows).toHaveLength(2)
      expect(table.rows[0]).toEqual(['Precision', '100%', 'Verified'])

      // Check code block preservation on readback
      const code = retrieved!.blocks.find((b) => b.type === 'code') as UniversalCodeBlock
      expect(code).toBeDefined()
      expect(code.language).toBe('typescript')
      expect(code.code).toContain('function verifyFidelity')

      // Check list preservation on readback
      const list = retrieved!.blocks.find((b) => b.type === 'list') as UniversalListBlock
      expect(list).toBeDefined()
      expect(list.items).toHaveLength(2)
      expect(list.items[0].checked).toBe(true)
      expect(list.items[1].checked).toBe(false)
    })

    it('25. extracts UniversalDocument from TXT with multiple paragraphs and round-trips through SQLite', async () => {
      const txtContent =
        'Paragraph Alpha: First paragraph text.\nWith internal line break.\n\nParagraph Beta: Second paragraph text.\n\nParagraph Gamma: Final concluding paragraph.'
      const bytes = new Uint8Array(Buffer.from(txtContent, 'utf-8'))

      const universalDoc = await service.extractUniversal(
        {
          bytes,
          formatHint: 'txt',
          filenameHint: 'sample.txt'
        },
        {
          sourceId: testSourceId,
          knowledgeBaseId: testKbId,
          originalFileName: 'sample.txt'
        }
      )

      expect(universalDoc.format).toBe('txt')
      expect(universalDoc.blocks).toHaveLength(3)

      docRepo.save(testSourceId, universalDoc)
      const retrieved = docRepo.get(testSourceId)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.blocks).toHaveLength(3)
      expect((retrieved!.blocks[0] as UniversalParagraphBlock).text).toBe(
        'Paragraph Alpha: First paragraph text.\nWith internal line break.'
      )
      expect(retrieved!.blocks[0].location?.lineStart).toBe(1)
      expect(retrieved!.blocks[0].location?.lineEnd).toBe(2)

      expect((retrieved!.blocks[1] as UniversalParagraphBlock).text).toBe(
        'Paragraph Beta: Second paragraph text.'
      )
      expect(retrieved!.blocks[1].location?.lineStart).toBe(4)
      expect(retrieved!.blocks[1].location?.lineEnd).toBe(4)

      expect((retrieved!.blocks[2] as UniversalParagraphBlock).text).toBe(
        'Paragraph Gamma: Final concluding paragraph.'
      )
      expect(retrieved!.blocks[2].location?.lineStart).toBe(6)
      expect(retrieved!.blocks[2].location?.lineEnd).toBe(6)
    })
  })

  // ==========================================================================
  // Part 4: Performance & Scalability Benchmarks
  // ==========================================================================
  describe('Performance Benchmarks', () => {
    it('26. extracts representative Markdown document in under 10ms', async () => {
      const sample = [
        '# Performance Test',
        '',
        'A representative documentation page with standard paragraphs, tables, and lists.',
        '',
        '## Section Table',
        '',
        '| Metric | Time (ms) |',
        '|---|---|',
        '| Parse | 2.5 |',
        '| Convert | 0.8 |',
        '',
        '- Item A',
        '- Item B'
      ].join('\n')

      const bytes = new Uint8Array(Buffer.from(sample, 'utf-8'))

      const start = performance.now()
      const result = await mdAdapter.extract({ bytes }, dummyContext)
      const durationMs = performance.now() - start

      expect(result.blocks.length).toBeGreaterThanOrEqual(4)
      expect(durationMs).toBeLessThan(50) // well within budget
    })

    it('27. scales efficiently on larger fixtures (500+ lines with tables and code) in under 100ms', async () => {
      const sections: string[] = []
      for (let s = 1; s <= 25; s++) {
        sections.push(
          `## Section ${s}\n\n` +
            `Paragraph describing section ${s} telemetry and operations in detail.\n\n` +
            `| Param | Val |\n|---|---|\n| p${s} | ${s * 10} |\n\n` +
            `\`\`\`ts\nconst val${s} = ${s};\n\`\`\`\n\n` +
            `- [x] Subtask ${s}.1\n- [ ] Subtask ${s}.2\n`
        )
      }
      const largeMd = `# Large Scale Architecture\n\n${sections.join('\n')}`
      const bytes = new Uint8Array(Buffer.from(largeMd, 'utf-8'))

      const start = performance.now()
      const result = await mdAdapter.extract({ bytes }, dummyContext)
      const durationMs = performance.now() - start

      // 25 sections * ~4 blocks = 100+ blocks
      expect(result.blocks.length).toBeGreaterThan(80)
      expect(durationMs).toBeLessThan(100) // fast sub-100ms performance
    })
  })
})
