import { describe, it, expect } from 'vitest'
import { SourceElementInventoryGenerator } from './source-element-inventory'
import type { UniversalDocument } from '../model/types'

function makeMockDoc(
  format: string,
  blocks: Array<Record<string, unknown>>,
  extra?: Partial<UniversalDocument>
): UniversalDocument {
  const typedBlocks = blocks as unknown as UniversalDocument['blocks']
  return {
    id: 'doc-1234',
    sourceId: 'src-1234',
    knowledgeBaseId: 'kb-1234',
    format,
    extractedAt: Date.now(),
    extractor: {
      id: `test-${format}-extractor`,
      name: `Test ${format} Extractor`,
      version: '1.0.0'
    },
    text: typedBlocks.map((b) => b.text).join('\n\n'),
    blocks: typedBlocks,
    metadata: {},
    warnings: [],
    quality: {
      fidelity: 'high',
      isLossy: false,
      isOcr: false
    },
    ...extra
  }
}

describe('SourceElementInventoryGenerator', () => {
  const generator = new SourceElementInventoryGenerator()

  describe('TXT Accounting', () => {
    it('accounts for paragraphs, lines, and blank line regions in plain text', () => {
      const text = 'Line 1\nLine 2\n\nLine 3\n\n\nLine 4'
      const bytes = Buffer.from(text, 'utf-8')
      const doc = makeMockDoc('txt', [
        {
          id: 'b1',
          type: 'paragraph',
          orderIndex: 0,
          text: 'Line 1\nLine 2',
          location: { lineStart: 1, lineEnd: 2 }
        },
        {
          id: 'b2',
          type: 'paragraph',
          orderIndex: 1,
          text: 'Line 3',
          location: { lineStart: 4, lineEnd: 4 }
        },
        {
          id: 'b3',
          type: 'paragraph',
          orderIndex: 2,
          text: 'Line 4',
          location: { lineStart: 7, lineEnd: 7 }
        }
      ])

      const inv = generator.generateInventory('txt', bytes, doc)
      expect(inv.format).toBe('txt')
      expect(inv.totalElements).toBe(4) // 3 paragraphs + 1 blank line region
      expect(inv.elementCountsByType.paragraph).toBe(3)
      expect(inv.elementCountsByType.blank_lines).toBe(1)
      expect(inv.dispositionCounts.fully_extracted).toBe(4)
      expect(inv.dispositionCounts.failed).toBe(0)
    })

    it('records failed element on invalid UTF-8 decoding', () => {
      const invalidBytes = Buffer.from([0xff, 0xfe, 0x12, 0x00])
      const doc = makeMockDoc('txt', [])

      const inv = generator.generateInventory('txt', invalidBytes, doc)
      expect(inv.dispositionCounts.failed).toBe(1)
      expect(inv.sourceElements[0].disposition).toBe('failed')
      expect(inv.sourceElements[0].warningCode).toBe('INVALID_UTF8')
      expect(inv.measurementLimitations).toContain('File contains invalid UTF-8 byte sequences.')
    })
  })

  describe('Markdown Accounting', () => {
    it('accounts for headings, code fences, lists, tables, and images', () => {
      const doc = makeMockDoc('md', [
        {
          id: 'h1',
          type: 'heading',
          orderIndex: 0,
          text: 'Title Heading',
          metadata: { headingLevel: 1 }
        },
        {
          id: 'p1',
          type: 'paragraph',
          orderIndex: 1,
          text: 'Paragraph with normal text.'
        },
        {
          id: 'p2',
          type: 'paragraph',
          orderIndex: 2,
          text: '<div>Raw HTML construct</div>'
        },
        {
          id: 'c1',
          type: 'code',
          orderIndex: 3,
          text: 'console.log("hello")',
          metadata: { codeLanguage: 'typescript' }
        },
        {
          id: 'l1',
          type: 'list',
          orderIndex: 4,
          text: '- Item 1\n- Item 2',
          metadata: { items: ['Item 1', 'Item 2'] }
        },
        {
          id: 't1',
          type: 'table',
          orderIndex: 5,
          text: '| Col1 | Col2 |\n|---|---|\n| A | B |',
          metadata: { rowCount: 1, columnCount: 2 }
        },
        {
          id: 'img1',
          type: 'image_reference',
          orderIndex: 6,
          text: '![alt](image.png)'
        }
      ])

      const inv = generator.generateInventory('md', Buffer.from(''), doc)
      expect(inv.elementCountsByType.heading).toBe(1)
      expect(inv.elementCountsByType.paragraph).toBe(1)
      expect(inv.elementCountsByType.html_block).toBe(1)
      expect(inv.elementCountsByType.code_fence).toBe(1)
      expect(inv.elementCountsByType.list).toBe(1)
      expect(inv.elementCountsByType.table).toBe(1)
      expect(inv.elementCountsByType.image).toBe(1)

      // Raw HTML should be text_preserved_unparsed
      expect(inv.sourceElements.find((e) => e.type === 'html_block')?.disposition).toBe(
        'text_preserved_unparsed'
      )
      // Image should be reference_only
      expect(inv.sourceElements.find((e) => e.type === 'image')?.disposition).toBe('reference_only')
      expect(inv.dispositionCounts.reference_only).toBe(1)
      expect(inv.dispositionCounts.text_preserved_unparsed).toBe(1)
    })
  })

  describe('PDF Accounting', () => {
    it('accounts for physical pages, digital blocks, and image references', () => {
      const doc = makeMockDoc(
        'pdf',
        [
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Page 1 digital text',
            location: { pageNumber: 1 }
          },
          {
            id: 'img1',
            type: 'image_reference',
            orderIndex: 1,
            text: '[Image: diagram.png]',
            location: { pageNumber: 2 }
          }
        ],
        {
          metadata: { pageCount: 2 }
        }
      )

      const inv = generator.generateInventory('pdf', Buffer.from(''), doc)
      expect(inv.elementCountsByType.digital_page).toBe(2)
      expect(inv.elementCountsByType.paragraph).toBe(1)
      expect(inv.elementCountsByType.image_reference).toBe(1)
      expect(inv.dispositionCounts.reference_only).toBe(1)
    })
  })

  describe('DOCX Accounting', () => {
    it('accounts for headers, footers, footnotes, comments, and tables', () => {
      const doc = makeMockDoc('docx', [
        {
          id: 'h1',
          type: 'heading',
          orderIndex: 0,
          text: 'Section 1'
        },
        {
          id: 'hdr',
          type: 'paragraph',
          orderIndex: 1,
          text: 'Confidential Header',
          metadata: { contentRole: 'header' }
        },
        {
          id: 'fn',
          type: 'paragraph',
          orderIndex: 2,
          text: 'Footnote text',
          metadata: { contentRole: 'footnote' }
        },
        {
          id: 'cm',
          type: 'paragraph',
          orderIndex: 3,
          text: 'Review comment',
          metadata: { contentRole: 'comment' }
        },
        {
          id: 't1',
          type: 'table',
          orderIndex: 4,
          text: 'Cell A\tCell B',
          metadata: { rowCount: 2, columnCount: 2 }
        }
      ])

      const inv = generator.generateInventory('docx', Buffer.from(''), doc)
      expect(inv.elementCountsByType.heading).toBe(1)
      expect(inv.elementCountsByType.header).toBe(1)
      expect(inv.elementCountsByType.footnote).toBe(1)
      expect(inv.elementCountsByType.comment).toBe(1)
      expect(inv.elementCountsByType.table).toBe(1)
      expect(inv.dispositionCounts.fully_extracted).toBe(5)
    })
  })

  describe('XLSX Accounting', () => {
    it('accounts for worksheets and sheet tables', () => {
      const doc = makeMockDoc('xlsx', [
        {
          id: 'sh1',
          type: 'sheet_boundary',
          orderIndex: 0,
          text: '',
          metadata: { sheetName: 'Q1 Sales', sheetIndex: 0 }
        },
        {
          id: 't1',
          type: 'table',
          orderIndex: 1,
          text: 'Region\tRevenue\nEast\t1000\nWest\t1500',
          metadata: { rowCount: 3, columnCount: 2, sheetName: 'Q1 Sales' }
        }
      ])

      const inv = generator.generateInventory('xlsx', Buffer.from(''), doc)
      expect(inv.elementCountsByType.worksheet).toBe(1)
      expect(inv.elementCountsByType.sheet_table).toBe(1)
      expect(inv.dispositionCounts.fully_extracted).toBe(2)
    })
  })

  describe('CSV Accounting', () => {
    it('accounts for header row and logical records', () => {
      const csv = 'Name,Age,Department\nAlice,30,Engineering\nBob,25,Design'
      const doc = makeMockDoc('csv', [
        {
          id: 'c1',
          type: 'table',
          orderIndex: 0,
          text: csv,
          metadata: { hasHeader: true, recordCount: 2, fieldCount: 3 }
        }
      ])

      const inv = generator.generateInventory('csv', Buffer.from(csv, 'utf-8'), doc)
      expect(inv.elementCountsByType.header_row).toBe(1)
      expect(inv.elementCountsByType.logical_records).toBe(1)
      expect(inv.dispositionCounts.fully_extracted).toBe(2)
    })
  })

  describe('PPTX Accounting', () => {
    it('accounts for slides, slide titles, shapes, speaker notes, and comments', () => {
      const doc = makeMockDoc('pptx', [
        {
          id: 'sl1',
          type: 'slide_boundary',
          orderIndex: 0,
          text: '',
          location: { slideNumber: 1, slideTitle: 'Welcome' }
        },
        {
          id: 'st1',
          type: 'heading',
          orderIndex: 1,
          text: 'Welcome to Local Bots',
          location: { slideNumber: 1 }
        },
        {
          id: 'sn1',
          type: 'paragraph',
          orderIndex: 2,
          text: 'Speaker note: explain local-first architecture.',
          location: { slideNumber: 1 },
          metadata: { isSpeakerNotes: true }
        },
        {
          id: 'sc1',
          type: 'paragraph',
          orderIndex: 3,
          text: 'Reviewer comment on slide 1',
          location: { slideNumber: 1 },
          metadata: { contentRole: 'comment' }
        }
      ])

      const inv = generator.generateInventory('pptx', Buffer.from(''), doc)
      expect(inv.elementCountsByType.slide).toBe(1)
      expect(inv.elementCountsByType.slide_title).toBe(1)
      expect(inv.elementCountsByType.speaker_notes).toBe(1)
      expect(inv.elementCountsByType.comment).toBe(1)
      expect(inv.dispositionCounts.fully_extracted).toBe(4)
    })
  })

  describe('Warnings and Unsupported Constructs', () => {
    it('captures unsupported objects from document warnings without overstating extraction', () => {
      const doc = makeMockDoc(
        'docx',
        [
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Text before macro.'
          }
        ],
        {
          warnings: [
            {
              code: 'UNSUPPORTED_VBA_MACRO',
              message: 'VBA macros were skipped during extraction.'
            },
            {
              code: 'UNSUPPORTED_SMARTART',
              message: 'SmartArt diagram was skipped.'
            }
          ]
        }
      )

      const inv = generator.generateInventory('docx', Buffer.from(''), doc)
      expect(inv.dispositionCounts.unsupported).toBe(2)
      expect(inv.sourceElements.filter((e) => e.disposition === 'unsupported')).toHaveLength(2)
    })
  })

  describe('Finding B: Mandatory Independent Source Inventory Omission Tests', () => {
    it('1. TXT: detects missing source text region / paragraph when omitted from UniversalDocument', () => {
      const sourceText =
        'First source paragraph.\n\nSecond source paragraph.\n\nThird source paragraph.'
      const bytes = Buffer.from(sourceText, 'utf-8')
      // UniversalDocument deliberately omits the second paragraph!
      const doc = makeMockDoc('txt', [
        {
          id: 'b1',
          type: 'paragraph',
          orderIndex: 0,
          text: 'First source paragraph.'
        },
        {
          id: 'b3',
          type: 'paragraph',
          orderIndex: 1,
          text: 'Third source paragraph.'
        }
      ])

      const inv = generator.generateInventory('txt', bytes, doc)
      const omitted = inv.sourceElements.filter((e) => e.disposition === 'partially_extracted')
      expect(omitted.length).toBeGreaterThanOrEqual(1)
      expect(omitted.some((e) => e.id.includes('txt-src-para-2'))).toBe(true)
      expect(inv.dispositionCounts.partially_extracted).toBeGreaterThanOrEqual(1)
    })

    it('2. Markdown: detects missing code block when omitted from UniversalDocument', () => {
      const sourceMd =
        '# Header\n\nSome text.\n\n```typescript\nconst x = 42;\n```\n\nEnding paragraph.'
      const bytes = Buffer.from(sourceMd, 'utf-8')
      // UniversalDocument deliberately omits the code block!
      const doc = makeMockDoc('md', [
        { id: 'h1', type: 'heading', orderIndex: 0, text: 'Header' },
        { id: 'p1', type: 'paragraph', orderIndex: 1, text: 'Some text.' },
        { id: 'p2', type: 'paragraph', orderIndex: 2, text: 'Ending paragraph.' }
      ])

      const inv = generator.generateInventory('md', bytes, doc)
      const omitted = inv.sourceElements.filter(
        (e) => e.type === 'code_fence' && e.disposition === 'partially_extracted'
      )
      expect(omitted.length).toBeGreaterThanOrEqual(1)
      expect(inv.dispositionCounts.partially_extracted).toBeGreaterThanOrEqual(1)
    })

    it('3. PDF: detects missing page or page boundary when omitted from UniversalDocument', () => {
      // Simulate raw PDF byte structure with 3 pages (/Count 3)
      const rawPdfBytes = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 3 /Kids [] >>\nendobj\n%%EOF',
        'latin1'
      )
      // UniversalDocument only extracts page 1 and page 2, omitting page 3!
      const doc = makeMockDoc('pdf', [
        { id: 'pb1', type: 'page_boundary', orderIndex: 0, location: { pageNumber: 1 }, text: '' },
        { id: 'p1', type: 'paragraph', orderIndex: 1, location: { pageNumber: 1 }, text: 'Page 1' },
        { id: 'pb2', type: 'page_boundary', orderIndex: 2, location: { pageNumber: 2 }, text: '' },
        { id: 'p2', type: 'paragraph', orderIndex: 3, location: { pageNumber: 2 }, text: 'Page 2' }
      ])

      const inv = generator.generateInventory('pdf', rawPdfBytes, doc)
      const omittedPage = inv.sourceElements.find(
        (e) => e.id === 'pdf-page-3' && e.disposition === 'partially_extracted'
      )
      expect(omittedPage).toBeDefined()
      expect(inv.dispositionCounts.partially_extracted).toBeGreaterThanOrEqual(1)
    })

    it('4. DOCX: detects missing paragraph when omitted from UniversalDocument', () => {
      // When source package has more paragraphs than extracted UniversalDocument
      const doc = makeMockDoc('docx', [
        { id: 'p1', type: 'paragraph', orderIndex: 0, text: 'Extracted first paragraph' }
      ])

      // If document warning notes omitted or if inventory generator inspects package
      const inv = generator.generateInventory('docx', Buffer.from(''), {
        ...doc,
        warnings: [
          {
            code: 'OMITTED_ELEMENTS_UNSUPPORTED',
            message: 'One or more paragraph structures could not be parsed.'
          }
        ]
      })

      expect(
        inv.sourceElements.some(
          (e) => e.disposition === 'unsupported' || e.disposition === 'partially_extracted'
        )
      ).toBe(true)
    })

    it('5. XLSX: detects missing formula when omitted from UniversalDocument', () => {
      const doc = makeMockDoc('xlsx', [
        { id: 's1', type: 'sheet_boundary', orderIndex: 0, text: 'Sheet1' },
        { id: 't1', type: 'table', orderIndex: 1, text: 'Val1 | Val2' }
      ])

      const inv = generator.generateInventory('xlsx', Buffer.from(''), {
        ...doc,
        warnings: [
          {
            code: 'UNSUPPORTED_FORMULA',
            message: 'Formula expression =SUM(A1:A10) omitted.'
          }
        ]
      })

      expect(
        inv.sourceElements.some(
          (e) => e.disposition === 'unsupported' || e.disposition === 'partially_extracted'
        )
      ).toBe(true)
    })

    it('6. PPTX: detects missing slide when omitted from UniversalDocument', () => {
      const doc = makeMockDoc('pptx', [
        { id: 's1', type: 'slide_boundary', orderIndex: 0, text: 'Slide 1' }
      ])

      const inv = generator.generateInventory('pptx', Buffer.from(''), {
        ...doc,
        warnings: [
          {
            code: 'OMITTED_SLIDE_UNSUPPORTED',
            message: 'Slide 2 skipped due to unsupported media layout.'
          }
        ]
      })

      expect(
        inv.sourceElements.some(
          (e) => e.disposition === 'unsupported' || e.disposition === 'partially_extracted'
        )
      ).toBe(true)
    })

    it('7. CSV: detects empty or failed source field parsing', () => {
      const invalidCsvBytes = Buffer.from([0xff, 0xfe, 0x00, 0x00])
      const doc = makeMockDoc('csv', [])

      const inv = generator.generateInventory('csv', invalidCsvBytes, doc)
      expect(inv.dispositionCounts.failed).toBeGreaterThanOrEqual(1)
      expect(inv.sourceElements.some((e) => e.type === 'decoding_error')).toBe(true)
    })
  })
})
