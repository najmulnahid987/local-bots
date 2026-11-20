import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { DocxExtractor } from './docx-extractor'
import { DocxArchiveValidator } from './docx-archive-validator'
import { buildRichDocx, type RichDocxParagraph } from '../../benchmarks/fixtures/office-generator'
import { documentExtractionResultToUniversalDocument } from '../../model/converter'
import type { UniversalTableCell } from '../../model/types'
import { ExtractedDocumentRepository } from '../../../database/repositories/extracted-document-repository'
import { runMigrations } from '../../../database/migrations/runner'
import { migrations } from '../../../database/migrations'
import { ZipArchiveWriter } from '../../../services/zip-archive'
import { randomUUID } from 'node:crypto'

describe('Phase 11 Step 11.6: DOCX Extraction Fidelity & Structured Word Document Preservation', () => {
  const extractor = new DocxExtractor()

  // 1. Title and Subtitle extraction
  it('1. extracts Document Title and Subtitle with appropriate heading levels', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Local-First AI Architecture', style: 'Title' },
        { text: 'A Sovereign Agent Paradigm', style: 'Subtitle' },
        { text: 'Standard introductory paragraph explaining the core motivation.' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.format).toBe('docx')
    expect(res.blocks.length).toBe(3)

    const titleBlock = res.blocks[0]
    expect(titleBlock.type).toBe('heading')
    expect(titleBlock.text).toBe('Local-First AI Architecture')
    expect(titleBlock.heading?.level).toBe(1)
    expect(titleBlock.metadata?.styleId).toBe('Title')

    const subtitleBlock = res.blocks[1]
    expect(subtitleBlock.type).toBe('heading')
    expect(subtitleBlock.text).toBe('A Sovereign Agent Paradigm')
    expect(subtitleBlock.heading?.level).toBe(2)
  })

  // 2. Heading 1 through 9 extraction
  it('2. extracts Heading 1 through Heading 9 with exact level mapping', async () => {
    const paragraphs: RichDocxParagraph[] = []
    for (let i = 1; i <= 9; i++) {
      paragraphs.push({ text: `Section Level ${i}`, style: `Heading${i}` })
    }

    const buf = buildRichDocx({ paragraphs })
    const res = await extractor.extract({ bytes: buf })

    expect(res.blocks.length).toBe(9)
    for (let i = 1; i <= 9; i++) {
      const b = res.blocks[i - 1]
      expect(b.type).toBe('heading')
      expect(b.text).toBe(`Section Level ${i}`)
      expect(b.metadata?.rawHeadingLevel).toBe(i)
    }
  })

  // 3. Custom heading styles and outline levels
  it('3. extracts custom heading styles and explicit outline levels', async () => {
    const buf = buildRichDocx({
      styles: [
        { styleId: 'CustomSpecHeading', name: 'Custom Specification Heading', outlineLvl: 1 }
      ],
      paragraphs: [
        { text: 'Custom Heading Text', style: 'CustomSpecHeading' },
        { text: 'Direct Outline Paragraph', outlineLvl: 2 }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(2)

    expect(res.blocks[0].type).toBe('heading')
    expect(res.blocks[0].text).toBe('Custom Heading Text')
    expect(res.blocks[0].heading?.level).toBe(2) // outlineLvl 1 -> level 2

    expect(res.blocks[1].type).toBe('heading')
    expect(res.blocks[1].text).toBe('Direct Outline Paragraph')
    expect(res.blocks[1].heading?.level).toBe(3) // outlineLvl 2 -> level 3
  })

  // 4. Heading hierarchy breadcrumb paths
  it('4. builds authentic hierarchical breadcrumbs (headingPath) across nested sections', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: '1. Autonomous Core', style: 'Heading1' },
        { text: '1.1 Neural Routing', style: 'Heading2' },
        { text: 'Detailed routing logic and low-latency packet dispatching.' },
        { text: '1.1.1 Memory Bounds', style: 'Heading3' },
        { text: 'Bounded context buffer management.' },
        { text: '2. Security Firewall', style: 'Heading1' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const hBlocks = res.blocks.filter((b) => b.type === 'heading')
    expect(hBlocks.length).toBe(4)

    expect(hBlocks[0].heading?.headingPath).toEqual(['1. Autonomous Core'])
    expect(hBlocks[1].heading?.headingPath).toEqual(['1. Autonomous Core', '1.1 Neural Routing'])
    expect(hBlocks[2].heading?.headingPath).toEqual([
      '1. Autonomous Core',
      '1.1 Neural Routing',
      '1.1.1 Memory Bounds'
    ])
    expect(hBlocks[3].heading?.headingPath).toEqual(['2. Security Firewall'])
  })

  // 5. Standard paragraph extraction
  it('5. extracts standard text paragraphs with provenance metadata', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Paragraph Alpha with critical information.' },
        { text: 'Paragraph Beta following immediately.' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(2)
    expect(res.blocks[0].type).toBe('paragraph')
    expect(res.blocks[0].text).toBe('Paragraph Alpha with critical information.')
    expect(res.blocks[0].metadata?.paragraphIndex).toBe(1)
    expect(res.blocks[1].metadata?.paragraphIndex).toBe(2)
  })

  // 6. Multi-paragraph documents
  it('6. extracts multi-paragraph documents without truncating or merging lines', async () => {
    const count = 25
    const paragraphs = Array.from({ length: count }, (_, i) => ({
      text: `Distinct paragraph number ${i + 1} verifying volume stability.`
    }))

    const buf = buildRichDocx({ paragraphs })
    const res = await extractor.extract({ bytes: buf })

    expect(res.blocks.length).toBe(count)
    expect(res.text.split('\n\n').length).toBe(count)
  })

  // 7. Empty paragraphs handled cleanly without hallucinations
  it('7. safely skips empty paragraphs without fabricating placeholder text', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'First real paragraph.' },
        { text: '' }, // empty
        { text: '   ' }, // whitespace only
        { text: 'Second real paragraph.' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(2)
    expect(res.blocks[0].text).toBe('First real paragraph.')
    expect(res.blocks[1].text).toBe('Second real paragraph.')
  })

  // 8. Text run preservation (multiple runs concatenated seamlessly)
  it('8. preserves text runs seamlessly without inserting spurious spaces or drops', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          runs: [
            { text: 'Multi-' },
            { text: 'Part ' },
            { text: 'Run ', bold: true },
            { text: 'Sentence.' }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(1)
    expect(res.blocks[0].text).toBe('Multi-Part Run Sentence.')
  })

  // 9-12. Run formatting flags (bold, italic, underline, strike)
  it('9-12. captures formatting flags (bold, italic, underline, strike) in block metadata', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Bold and Italic Statement', bold: true, italic: true },
        { text: 'Underlined and Strikethrough Item', underline: true, strike: true }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(2)

    const p1Formatting = (
      res.blocks[0].metadata as { formatting: { hasBold: boolean; hasItalic: boolean } }
    )?.formatting
    expect(p1Formatting.hasBold).toBe(true)
    expect(p1Formatting.hasItalic).toBe(true)

    const p2Formatting = (
      res.blocks[1].metadata as { formatting: { hasUnderline: boolean; hasStrike: boolean } }
    )?.formatting
    expect(p2Formatting.hasUnderline).toBe(true)
    expect(p2Formatting.hasStrike).toBe(true)
  })

  // 13. Inline tabs
  it('13. preserves inline tabs as tab characters', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          runs: [{ text: 'ColumnA' }, { text: '', tab: true }, { text: 'ColumnB' }]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toBe('ColumnA\tColumnB')
  })

  // 14. Inline line breaks
  it('14. preserves inline line breaks within paragraph runs', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          runs: [{ text: 'Line 1' }, { text: '', br: true }, { text: 'Line 2' }]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toBe('Line 1\nLine 2')
  })

  // 15. Non-breaking hyphens and soft hyphens
  it('15. preserves non-breaking hyphens and soft hyphens', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          runs: [
            { text: 'ISO' },
            { text: '', noBreakHyphen: true },
            { text: '9001' },
            { text: '', softHyphen: true },
            { text: 'Compliant' }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toBe('ISO\u20119001\u00ADCompliant')
  })

  // 16. Symbols
  it('16. converts symbol elements (w:sym) into unicode characters', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          runs: [
            { text: 'Checkmark: ' },
            { text: '', sym: '0050' } // 'P' in Wingdings is checkmark or code point 80
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toContain('Checkmark: P')
  })

  // 17. Word simple fields
  it('17. evaluates Word simple fields (w:fldSimple) like PAGE numbers', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          text: 'Document Page: ',
          fields: [{ instruction: 'PAGE', resultText: '42' }]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toBe('Document Page: 42')
  })

  // 18. Bengali Unicode characters
  it('18. preserves Bengali Unicode characters with complete fidelity', async () => {
    const bengaliHeading = 'বাংলা নথিপত্র এবং নিরাপত্তা বিধিমালা'
    const bengaliBody = 'আমাদের এআই মডেল সম্পূর্ণ অফলাইনে কাজ করে এবং ডেটা সুরক্ষিত রাখে।'

    const buf = buildRichDocx({
      paragraphs: [{ text: bengaliHeading, style: 'Heading1' }, { text: bengaliBody }]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.text).toContain(bengaliHeading)
    expect(res.text).toContain(bengaliBody)
  })

  // 19. Emojis and supplementary multilingual plane characters
  it('19. preserves emojis and supplementary multilingual plane characters', async () => {
    const emojiText = 'Deployment Status: 🚀 Success! 🔒 Encrypted at Rest 🛡️ Sovereign'
    const buf = buildRichDocx({
      paragraphs: [{ text: emojiText }]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks[0].text).toBe(emojiText)
  })

  // 20. Numbered lists (ordered)
  it('20. extracts numbered lists with ordered semantics and item numbers', async () => {
    const buf = buildRichDocx({
      numbering: [
        {
          numId: '1',
          abstractNumId: '0',
          levels: [{ ilvl: 0, numFmt: 'decimal', lvlText: '%1.' }]
        }
      ],
      paragraphs: [
        { text: 'Initialize encryption vault.', list: { numId: '1', ilvl: 0 } },
        { text: 'Load offline weights.', list: { numId: '1', ilvl: 0 } },
        { text: 'Start local server.', list: { numId: '1', ilvl: 0 } }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(1)
    const listBlock = res.blocks[0]
    expect(listBlock.type).toBe('list')
    expect(listBlock.list?.ordered).toBe(true)
    expect(listBlock.list?.items.length).toBe(3)
    expect(listBlock.list?.itemDetails?.[0].itemNumber).toBe(1)
    expect(listBlock.list?.itemDetails?.[1].itemNumber).toBe(2)
    expect(listBlock.list?.itemDetails?.[2].itemNumber).toBe(3)
  })

  // 21. Bulleted lists (unordered)
  it('21. extracts bulleted lists with unordered semantics', async () => {
    const buf = buildRichDocx({
      numbering: [
        {
          numId: '2',
          abstractNumId: '1',
          levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•' }]
        }
      ],
      paragraphs: [
        { text: 'Privacy-first architecture', list: { numId: '2', ilvl: 0 } },
        { text: 'Zero intermediary proxies', list: { numId: '2', ilvl: 0 } }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.blocks.length).toBe(1)
    expect(res.blocks[0].type).toBe('list')
    expect(res.blocks[0].list?.ordered).toBe(false)
    expect(res.blocks[0].list?.items).toEqual([
      'Privacy-first architecture',
      'Zero intermediary proxies'
    ])
  })

  // 22. Multi-level nested lists
  it('22. preserves nesting depth in multi-level lists', async () => {
    const buf = buildRichDocx({
      numbering: [
        {
          numId: '3',
          abstractNumId: '2',
          levels: [
            { ilvl: 0, numFmt: 'decimal', lvlText: '%1.' },
            { ilvl: 1, numFmt: 'lowerLetter', lvlText: '%2.' }
          ]
        }
      ],
      paragraphs: [
        { text: 'Parent Item 1', list: { numId: '3', ilvl: 0 } },
        { text: 'Child Sub-item A', list: { numId: '3', ilvl: 1 } },
        { text: 'Child Sub-item B', list: { numId: '3', ilvl: 1 } },
        { text: 'Parent Item 2', list: { numId: '3', ilvl: 0 } }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const listBlock = res.blocks[0]
    expect(listBlock.list?.itemDetails?.[0].depth).toBe(0)
    expect(listBlock.list?.itemDetails?.[1].depth).toBe(1)
    expect(listBlock.list?.itemDetails?.[2].depth).toBe(1)
    expect(listBlock.list?.itemDetails?.[3].depth).toBe(0)
  })

  // 25. Simple tables with rows and columns
  it('25. extracts tables with headers and row data', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          rows: [
            {
              isHeader: true,
              cells: [{ text: 'Model' }, { text: 'Parameters' }, { text: 'Context' }]
            },
            {
              cells: [{ text: 'Gemini 3.8' }, { text: 'Proprietary' }, { text: '1M tokens' }]
            },
            {
              cells: [{ text: 'Claude 3.7' }, { text: 'Proprietary' }, { text: '200K tokens' }]
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const tblBlock = res.blocks.find((b) => b.type === 'table')
    expect(tblBlock).toBeDefined()
    expect(tblBlock?.table?.headers).toEqual(['Model', 'Parameters', 'Context'])
    expect(tblBlock?.table?.rows.length).toBe(2)
  })

  // 26. Tables with empty cells
  it('26. preserves empty cells without column shifting or dropping cells', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          rows: [
            {
              isHeader: true,
              cells: [{ text: 'Header A' }, { text: 'Header B' }, { text: 'Header C' }]
            },
            {
              cells: [{ text: 'Val 1' }, { text: '' }, { text: 'Val 3' }] // Empty middle cell
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const tblBlock = res.blocks.find((b) => b.type === 'table')
    expect(tblBlock).toBeDefined()
    expect(tblBlock?.table?.rows[0]).toEqual(['Val 1', '', 'Val 3'])

    // Rich cells check
    const richCells = tblBlock?.metadata?.cells as UniversalTableCell[][]
    expect(richCells[1][1].value).toBe('')
    expect(richCells[1][1].columnIndex).toBe(1)
    expect(richCells[1][2].value).toBe('Val 3')
    expect(richCells[1][2].columnIndex).toBe(2)
  })

  // 28. Horizontal cell merges (gridSpan / colSpan)
  it('28. captures horizontal cell merges (gridSpan / colSpan) accurately', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          rows: [
            {
              cells: [{ text: 'Full Width Banner Header', colSpan: 3 }]
            },
            {
              cells: [{ text: 'Col 1' }, { text: 'Col 2' }, { text: 'Col 3' }]
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const tblBlock = res.blocks.find((b) => b.type === 'table')
    expect(tblBlock).toBeDefined()

    const richCells = tblBlock?.metadata?.cells as UniversalTableCell[][]
    expect(richCells[0][0].colSpan).toBe(3)
    expect(richCells[0][0].value).toBe('Full Width Banner Header')
  })

  // 29. Vertical cell merges (vMerge / rowSpan)
  it('29. captures vertical cell merges (vMerge / rowSpan) accurately', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          rows: [
            {
              cells: [
                { text: 'Merged Vertical Item', vMerge: 'restart' },
                { text: 'Row 1 Sub-item' }
              ]
            },
            {
              cells: [{ text: '', vMerge: 'continue' }, { text: 'Row 2 Sub-item' }]
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const tblBlock = res.blocks.find((b) => b.type === 'table')
    expect(tblBlock).toBeDefined()

    const richCells = tblBlock?.metadata?.cells as UniversalTableCell[][]
    expect(richCells[0][0].rowSpan).toBe(2)
    expect(richCells[0][0].value).toBe('Merged Vertical Item')
  })

  // 30. Tables with captions
  it('30. preserves table caption metadata', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          caption: 'Table 1.1: System Resource Allocations',
          rows: [
            {
              cells: [{ text: 'Core' }, { text: 'Memory' }]
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const tblBlock = res.blocks.find((b) => b.type === 'table')
    expect(tblBlock?.table?.caption).toBe('Table 1.1: System Resource Allocations')
    expect(tblBlock?.metadata?.caption).toBe('Table 1.1: System Resource Allocations')
  })

  // 31. Nested tables
  it('31. preserves content within nested tables inside cells', async () => {
    const buf = buildRichDocx({
      tables: [
        {
          rows: [
            {
              cells: [
                {
                  text: 'Outer Cell Description',
                  nestedTable: {
                    rows: [
                      {
                        cells: [{ text: 'Inner Cell 1' }, { text: 'Inner Cell 2' }]
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.text).toContain('Outer Cell Description')
    expect(res.text).toContain('Inner Cell 1')
  })

  // 32-34. Headers and footers
  it('32-34. extracts headers and footers with explicit headerType and section metadata', async () => {
    const buf = buildRichDocx({
      headers: [
        { type: 'default', text: 'CONFIDENTIAL: Local Bots Spec' },
        { type: 'first', text: 'Cover Page Title Banner' }
      ],
      footers: [{ type: 'default', text: 'Page 1 of 10 - All Rights Reserved' }],
      paragraphs: [{ text: 'Main body content inside section.' }]
    })

    const res = await extractor.extract({ bytes: buf })
    const headerBlock = res.blocks.find((b) => b.metadata?.isHeader === true)
    const footerBlock = res.blocks.find((b) => b.metadata?.isFooter === true)

    expect(headerBlock).toBeDefined()
    expect(headerBlock?.text).toContain('CONFIDENTIAL: Local Bots Spec')
    expect(headerBlock?.metadata?.headerType).toBe('default')

    expect(footerBlock).toBeDefined()
    expect(footerBlock?.text).toContain('Page 1 of 10 - All Rights Reserved')
  })

  // 35-36. Footnotes and Endnotes
  it('35-36. extracts footnotes and endnotes with note ID references', async () => {
    const buf = buildRichDocx({
      footnotes: [{ id: '1', text: 'Tesseract OCR runs in isolated native process.' }],
      endnotes: [{ id: '1', text: 'Comprehensive endnote citations reference.' }],
      paragraphs: [
        { text: 'Paragraph referencing footnote', footnoteRef: '1' },
        { text: 'Paragraph referencing endnote', endnoteRef: '1' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    expect(res.text).toContain('Tesseract OCR runs in isolated native process.')
    expect(res.text).toContain('Comprehensive endnote citations reference.')

    const fnBlock = res.blocks.find((b) => b.metadata?.isFootnote === true)
    expect(fnBlock).toBeDefined()
    expect(fnBlock?.metadata?.noteId).toBe('1')

    const enBlock = res.blocks.find((b) => b.metadata?.isEndnote === true)
    expect(enBlock).toBeDefined()
    expect(enBlock?.metadata?.noteId).toBe('1')
  })

  // 37. Comments and annotations
  it('37. extracts comments and annotations with author, timestamp, and text', async () => {
    const buf = buildRichDocx({
      comments: [
        {
          id: '1',
          author: 'Alice Reviewer',
          date: '2026-11-20T12:00:00Z',
          text: 'Verify offline encryption parameters before sign-off.'
        }
      ],
      paragraphs: [{ text: 'Review target paragraph.', commentRef: '1' }]
    })

    const res = await extractor.extract({ bytes: buf })
    const commentBlock = res.blocks.find((b) => b.metadata?.isComment === true)
    expect(commentBlock).toBeDefined()
    expect(commentBlock?.text).toContain('Verify offline encryption parameters before sign-off.')
    expect(commentBlock?.metadata?.author).toBe('Alice Reviewer')
    expect(commentBlock?.metadata?.date).toBe('2026-11-20T12:00:00Z')
  })

  // 38-39. External and internal hyperlinks
  it('38-39. extracts external URLs and internal bookmarks mapped via relationships', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          text: 'Visit project repository: ',
          hyperlinks: [
            {
              text: 'Antigravity Docs',
              target: 'https://github.com/google/antigravity',
              isExternal: true
            },
            { text: 'Internal Section Anchor', target: '#section-2', isExternal: false }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const pBlock = res.blocks[0]
    const hyperlinks = pBlock.metadata?.hyperlinks as {
      text: string
      target: string
      isExternal: boolean
    }[]

    expect(hyperlinks).toBeDefined()
    expect(hyperlinks.length).toBe(2)
    expect(hyperlinks[0].target).toBe('https://github.com/google/antigravity')
    expect(hyperlinks[0].isExternal).toBe(true)
    expect(hyperlinks[1].target).toBe('#section-2')
    expect(hyperlinks[1].isExternal).toBe(false)
  })

  // 40. Embedded images and drawings
  it('40. preserves DrawingML image references with altText and structured warnings', async () => {
    const fakeImagePng = Buffer.from('Fake PNG binary content')
    const buf = buildRichDocx({
      media: [{ path: 'word/media/image1.png', data: fakeImagePng }],
      paragraphs: [
        {
          drawing: {
            id: '10',
            altText: 'System Architecture Diagram',
            caption: 'Figure 1: High-level overview',
            targetMedia: 'media/image1.png'
          }
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const imgBlock = res.blocks.find((b) => b.type === 'image_reference')
    expect(imgBlock).toBeDefined()
    expect(imgBlock?.imageReference?.altText).toBe('System Architecture Diagram')
    expect(imgBlock?.imageReference?.caption).toBe('Figure 1: High-level overview')
    expect(imgBlock?.imageReference?.extractionStatus).toBe('skipped')

    expect(res.warnings.some((w) => w.code === 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED')).toBe(true)
  })

  // 41. Explicit page breaks
  it('41. emits page_break blocks on explicit Word page breaks', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Page One Content' },
        { text: '', pageBreak: true },
        { text: 'Page Two Content' }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const pbBlock = res.blocks.find((b) => b.type === 'page_break')
    expect(pbBlock).toBeDefined()
    expect(res.blocks.some((b) => b.text === 'Page One Content')).toBe(true)
    expect(res.blocks.some((b) => b.text === 'Page Two Content')).toBe(true)
  })

  // 42. Tracked revisions
  it('42. preserves tracked revision insertions and deletions in metadata', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        {
          text: 'Base statement with ',
          revisions: [
            {
              type: 'insertion',
              author: 'Bob Editor',
              date: '2026-11-20T10:00:00Z',
              text: 'approved new clauses'
            },
            {
              type: 'deletion',
              author: 'Alice Reviewer',
              date: '2026-11-20T09:30:00Z',
              text: 'deprecated obsolete terms'
            }
          ]
        }
      ]
    })

    const res = await extractor.extract({ bytes: buf })
    const revBlock = res.blocks[0]
    const revisions = revBlock.metadata?.revisions as {
      type: string
      text: string
      author: string
    }[]

    expect(revisions).toBeDefined()
    expect(revisions.some((r) => r.type === 'insertion' && r.text === 'approved new clauses')).toBe(
      true
    )
    expect(
      revisions.some((r) => r.type === 'deletion' && r.text === 'deprecated obsolete terms')
    ).toBe(true)
  })

  // 43. Defensive archive validation
  it('43. rejects macro-enabled documents (.docm / vbaProject.bin)', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    writer.addEntry('word/vbaProject.bin', Buffer.from('VBA Macro Code'))
    const docmBytes = writer.build()

    expect(() => DocxArchiveValidator.validate(docmBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  // 44. UniversalDocument conversion
  it('44. converts DOCX extraction result to canonical UniversalDocument without information loss', async () => {
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Architecture Overview', style: 'Heading1' },
        { text: 'Detailed system specification paragraph.' }
      ],
      tables: [
        {
          rows: [
            { isHeader: true, cells: [{ text: 'Item' }, { text: 'Status' }] },
            { cells: [{ text: 'Core Engine' }, { text: 'Online' }] }
          ]
        }
      ]
    })

    const rawResult = await extractor.extract({ bytes: buf })
    const uDoc = documentExtractionResultToUniversalDocument(rawResult, {
      originalFileName: 'spec.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    expect(uDoc.format).toBe('docx')
    expect(uDoc.blocks.length).toBe(3)
    expect(uDoc.blocks[0].type).toBe('heading')
    expect(uDoc.blocks[1].type).toBe('paragraph')
    expect(uDoc.blocks[2].type).toBe('table')
  })

  // 45. SQLite database persistence round-trip (Migration 009)
  it('45. persists UniversalDocument to SQLite via ExtractedDocumentRepository and retrieves verbatim', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    const repo = new ExtractedDocumentRepository(db)

    const kbId = randomUUID()
    const sourceId = randomUUID()
    const now = Date.now()

    // Insert target KB and knowledge_sources record
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Test KB', 'kb-path', now, now)

    const dummyHash = 'a'.repeat(64)

    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
      ) VALUES (?, ?, 'report.docx', 'report.docx', 'originals/report.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1024, ?, 'completed', ?, ?)`
    ).run(sourceId, kbId, dummyHash, now, now)

    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Persistent DOCX Title', style: 'Heading1' },
        { text: 'Persistent DOCX body text.' }
      ]
    })

    const extractionResult = await extractor.extract({ bytes: buf })
    const uDoc = documentExtractionResultToUniversalDocument(extractionResult, {
      documentId: sourceId,
      sourceId: sourceId,
      knowledgeBaseId: kbId,
      originalFileName: 'report.docx'
    })

    repo.save(sourceId, uDoc)
    const retrieved = repo.get(sourceId)

    expect(retrieved).toBeDefined()
    expect(retrieved?.id).toBe(sourceId)
    expect(retrieved?.sourceId).toBe(sourceId)
    expect(retrieved?.blocks.length).toBe(2)
    expect(retrieved?.blocks[0].text).toBe('Persistent DOCX Title')
    expect(retrieved?.blocks[1].text).toBe('Persistent DOCX body text.')
  })

  // 46. FTS5 search indexing and query verification
  it('46. enables FTS5 retrieval over DOCX content indexed into knowledge_fts', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    const kbId = randomUUID()
    const sourceId = randomUUID()
    const now = Date.now()

    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Test KB', 'kb-path', now, now)

    const dummyHash = 'b'.repeat(64)

    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
      ) VALUES (?, ?, 'ground_truth.docx', 'ground_truth.docx', 'originals/ground_truth.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2048, ?, 'completed', ?, ?)`
    ).run(sourceId, kbId, dummyHash, now, now)

    const uniqueGroundTruth = 'AETHER-HYPERDRIVE-SPEC-773'
    const buf = buildRichDocx({
      paragraphs: [
        { text: 'Propulsion Telemetry Report', style: 'Heading1' },
        {
          text: `Experimental engine diagnostics for ${uniqueGroundTruth} showed zero thermal drift.`
        }
      ]
    })

    const extractionResult = await extractor.extract({ bytes: buf })

    // Simulate chunk creation & FTS5 indexing
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO knowledge_chunks (id, knowledge_base_id, source_id, chunk_index, content, token_count, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(chunkId, kbId, sourceId, 0, extractionResult.text, 50, '{}', now)

    // Query FTS5 with phrase quotes for hyphenated identifier
    const ftsResults = db
      .prepare(
        `SELECT c.id, c.content
         FROM knowledge_fts f
         JOIN knowledge_chunks c ON c.rowid = f.rowid
         WHERE knowledge_fts MATCH ? AND c.knowledge_base_id = ?`
      )
      .all('"AETHER-HYPERDRIVE-SPEC-773"', kbId) as { id: string; content: string }[]

    expect(ftsResults.length).toBe(1)
    expect(ftsResults[0].content).toContain(uniqueGroundTruth)
    expect(ftsResults[0].content).toContain('Propulsion Telemetry Report')
  })
})
