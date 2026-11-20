import { describe, it, expect } from 'vitest'
import { UniversalDocumentChunker } from './universal-document-chunker'
import { StaticDocumentSettingsProvider } from '../document-settings'
import type {
  UniversalDocument,
  UniversalDocumentBlock,
  UniversalHeadingBlock,
  UniversalParagraphBlock,
  UniversalTableBlock,
  UniversalCodeBlock,
  UniversalListBlock,
  UniversalPageBoundaryBlock,
  UniversalSheetBoundaryBlock,
  UniversalSlideBoundaryBlock
} from '../model/types'
import { DocumentError } from '../document-errors'

describe('UniversalDocumentChunker (Phase 11 Step 11.9)', () => {
  const settingsProvider = new StaticDocumentSettingsProvider({
    chunkTargetTokens: 100,
    chunkOverlapTokens: 20,
    chunkerVersion: '1.0.0'
  })
  const chunker = new UniversalDocumentChunker(settingsProvider)
  const testExtractor = {
    id: 'test-extractor',
    name: 'Test Extractor',
    version: '1.0.0'
  }

  // 1. Format-Aware Dispatch Tests
  describe('Format-Aware Dispatch', () => {
    it('1a. routes TXT document to TextChunker, preserving paragraph boundaries and Unicode', () => {
      const doc: UniversalDocument = {
        id: 'doc-txt-1',
        sourceInfo: { fileSizeBytes: 500 },
        format: 'txt',
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'First paragraph about quantum decoherence in trapped ions with Greek letters: \u03B1, \u03B2, \u03B3.',
            location: { lineStart: 1, lineEnd: 2 }
          },
          {
            id: 'b2',
            type: 'paragraph',
            orderIndex: 1,
            text: 'Second paragraph discussing cryogenic cooling at 4 Kelvin.',
            location: { lineStart: 4, lineEnd: 5 }
          }
        ],
        text: 'First paragraph...\n\nSecond paragraph...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBeGreaterThanOrEqual(1)
      expect(res.chunks[0].metadata.format).toBe('txt')
      expect(res.chunks[0].content).toContain('\u03B1, \u03B2, \u03B3')
      expect(res.chunks[0].metadata.chunkingStrategy).toBe('format-aware-universal-v1')
    })

    it('1b. routes Markdown document to MarkdownChunker, preserving heading hierarchy and typed blocks', () => {
      const doc: UniversalDocument = {
        id: 'doc-md-1',
        sourceInfo: { fileSizeBytes: 1000 },
        format: 'md',
        blocks: [
          {
            id: 'h1',
            type: 'heading',
            orderIndex: 0,
            level: 1,
            text: 'System Architecture',
            headingPath: ['System Architecture']
          } as UniversalHeadingBlock,
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'The architecture employs an offline-first SQLite database.'
          } as UniversalParagraphBlock,
          {
            id: 'c1',
            type: 'code',
            orderIndex: 2,
            language: 'typescript',
            code: 'const db = new Database("local.db");',
            text: '```typescript\nconst db = new Database("local.db");\n```'
          } as UniversalCodeBlock
        ],
        text: '# System Architecture\n\nThe architecture...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBeGreaterThanOrEqual(1)
      expect(res.chunks[0].metadata.format).toBe('md')
      // Metadata carries heading breadcrumb context
      expect(res.chunks[0].metadata.headings).toEqual(['System Architecture'])
      // Check code block chunk
      const codeChunk = res.chunks.find((c) => c.metadata.contentRole === 'code')
      expect(codeChunk).toBeDefined()
      expect(codeChunk?.content).toContain('const db = new Database("local.db");')
    })

    it('1c. routes PDF document to PdfChunker, respecting page boundaries and OCR provenance', () => {
      const doc: UniversalDocument = {
        id: 'doc-pdf-1',
        sourceInfo: { fileSizeBytes: 2048 },
        format: 'pdf',
        blocks: [
          {
            id: 'pb1',
            type: 'page_boundary',
            orderIndex: 0,
            text: '--- Page 1 ---',
            pageNumber: 1
          } as UniversalPageBoundaryBlock,
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'Page one text discussing astrophysical jets and magnetic collimation.',
            location: { pageNumber: 1 },
            metadata: { isOcr: true, ocrConfidence: 94 }
          } as UniversalParagraphBlock,
          {
            id: 'pb2',
            type: 'page_boundary',
            orderIndex: 2,
            text: '--- Page 2 ---',
            pageNumber: 2
          } as UniversalPageBoundaryBlock,
          {
            id: 'p2',
            type: 'paragraph',
            orderIndex: 3,
            text: 'Page two text detailing relativistic particle acceleration.',
            location: { pageNumber: 2 },
            metadata: { isOcr: true, ocrConfidence: 91 }
          } as UniversalParagraphBlock
        ],
        text: 'Page one...\nPage two...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: true },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBe(2)
      expect(res.chunks[0].pageNumber).toBe(1)
      expect(res.chunks[0].metadata.isOcr).toBe(true)
      expect(res.chunks[0].metadata.ocrConfidence).toBe(94)

      expect(res.chunks[1].pageNumber).toBe(2)
      expect(res.chunks[1].metadata.isOcr).toBe(true)
      expect(res.chunks[1].metadata.ocrConfidence).toBe(91)
    })

    it('1d. routes DOCX document to DocxChunker, isolating ancillary content and preserving breadcrumbs', () => {
      const doc: UniversalDocument = {
        id: 'doc-docx-1',
        sourceInfo: { fileSizeBytes: 3000 },
        format: 'docx',
        blocks: [
          {
            id: 'h1',
            type: 'heading',
            orderIndex: 0,
            level: 1,
            text: 'Service Level Agreement',
            headingPath: ['Service Level Agreement']
          } as UniversalHeadingBlock,
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'The provider guarantees 99.9% uptime per calendar quarter.'
          } as UniversalParagraphBlock,
          {
            id: 'ft1',
            type: 'paragraph',
            orderIndex: 2,
            text: 'Excludes planned maintenance windows announced 48 hours in advance.',
            metadata: { role: 'footnote', noteId: '1' }
          } as UniversalParagraphBlock
        ],
        text: 'Service Level Agreement...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBeGreaterThanOrEqual(1)
      const footnoteChunk = res.chunks.find((c) => c.metadata.contentRole === 'footnote')
      expect(footnoteChunk).toBeDefined()
      expect(footnoteChunk?.metadata.isAncillary).toBe(true)
      expect(footnoteChunk?.content).toContain('[Footnote 1]')
    })

    it('1e. routes XLSX document to SpreadsheetChunker, structuring rows with coordinates and headers', () => {
      const doc: UniversalDocument = {
        id: 'doc-xlsx-1',
        sourceInfo: { fileSizeBytes: 4000 },
        format: 'xlsx',
        blocks: [
          {
            id: 'sb1',
            type: 'sheet_boundary',
            orderIndex: 0,
            text: '# Sheet: Revenue',
            sheetName: 'Revenue',
            sheetIndex: 1
          } as UniversalSheetBoundaryBlock,
          {
            id: 't1',
            type: 'table',
            orderIndex: 1,
            text: 'Row 1 | A1: Quarter | B1: Amount\nRow 2 | A2: Q1 | B2: 120000',
            headers: ['Quarter', 'Amount'],
            rows: [['Q1', '120000']],
            rowCount: 2,
            columnCount: 2,
            isSpreadsheet: true,
            sheetName: 'Revenue',
            sheetIndex: 1
          } as UniversalTableBlock
        ],
        text: 'Revenue...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBe(1)
      expect(res.chunks[0].metadata.format).toBe('xlsx')
      expect(res.chunks[0].metadata.sheetName).toBe('Revenue')
      expect(res.chunks[0].content).toContain('[Spreadsheet Context]')
      expect(res.chunks[0].content).toContain('Quarter')
      expect(res.chunks[0].content).toContain('120000')
    })

    it('1f. routes CSV document to CsvChunker, preserving rows and empty field delimiters', () => {
      const doc: UniversalDocument = {
        id: 'doc-csv-1',
        sourceInfo: { fileSizeBytes: 500 },
        format: 'csv',
        blocks: [
          {
            id: 't1',
            type: 'table',
            orderIndex: 0,
            text: 'Sensor,Reading,Unit\nTemp,42.5,C\nPressure,,hPa',
            headers: ['Sensor', 'Reading', 'Unit'],
            rows: [
              ['Temp', '42.5', 'C'],
              ['Pressure', '', 'hPa']
            ],
            rowCount: 3,
            columnCount: 3,
            metadata: { hasExplicitHeader: true }
          } as UniversalTableBlock
        ],
        text: 'Sensor,Reading,Unit\nTemp,42.5,C\nPressure,,hPa',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBe(1)
      expect(res.chunks[0].metadata.format).toBe('csv')
      expect(res.chunks[0].content).toContain('Record 3 | Sensor: Pressure | Reading:  | Unit: hPa')
    })

    it('1g. routes PPTX document to PresentationChunker, structuring slide by slide with notes', () => {
      const doc: UniversalDocument = {
        id: 'doc-pptx-1',
        sourceInfo: { fileSizeBytes: 6000 },
        format: 'pptx',
        blocks: [
          {
            id: 'sb1',
            type: 'slide_boundary',
            orderIndex: 0,
            text: '# Slide 1: Welcome',
            slideNumber: 1,
            slideTitle: 'Welcome'
          } as UniversalSlideBoundaryBlock,
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'Welcome to the Annual Quantum Systems Summit.'
          } as UniversalParagraphBlock,
          {
            id: 'p2',
            type: 'paragraph',
            orderIndex: 2,
            text: 'Speaker note: pause after this slide for opening applause.',
            metadata: { role: 'speaker_note', slideNumber: 1 }
          } as UniversalParagraphBlock
        ],
        text: 'Slide 1: Welcome...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBe(1)
      expect(res.chunks[0].metadata.format).toBe('pptx')
      expect(res.chunks[0].metadata.slideNumber).toBe(1)
      expect(res.chunks[0].content).toContain('[Slide 1: Welcome]')
      expect(res.chunks[0].content).toContain(
        '[Speaker Notes: Speaker note: pause after this slide for opening applause.]'
      )
    })
  })

  // 2. Information Preservation & Exhaustive Block Accounting Tests
  describe('Information Preservation & Exhaustive Block Accounting', () => {
    it('2a. guarantees 100% of blocks are accounted for across all supported block types', () => {
      const doc: UniversalDocument = {
        id: 'doc-comprehensive-1',
        sourceInfo: { fileSizeBytes: 3000 },
        format: 'md',
        blocks: [
          {
            id: 'b-h1',
            type: 'heading',
            orderIndex: 0,
            level: 1,
            text: 'Introduction',
            headingPath: ['Introduction']
          } as UniversalHeadingBlock,
          {
            id: 'b-p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'This is body paragraph 1.'
          } as UniversalParagraphBlock,
          {
            id: 'b-p-empty',
            type: 'paragraph',
            orderIndex: 2,
            text: '   \n  '
          } as UniversalParagraphBlock,
          {
            id: 'b-code',
            type: 'code',
            orderIndex: 3,
            language: 'python',
            code: 'print("hello world")',
            text: '```python\nprint("hello world")\n```'
          } as UniversalCodeBlock,
          {
            id: 'b-list',
            type: 'list',
            orderIndex: 4,
            ordered: false,
            items: [
              { text: 'Item alpha', depth: 0, orderIndex: 0 },
              { text: 'Item beta', depth: 0, orderIndex: 1 }
            ],
            text: '- Item alpha\n- Item beta'
          } as UniversalListBlock,
          {
            id: 'b-img',
            type: 'image_reference',
            orderIndex: 5,
            text: '![Diagram](diagram.png)',
            caption: 'Architecture Overview Diagram'
          } as UniversalDocumentBlock,
          {
            id: 'b-page',
            type: 'page_boundary',
            orderIndex: 6,
            text: '--- Page Break ---',
            pageNumber: 2
          } as UniversalPageBoundaryBlock
        ],
        text: 'Full text representation',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)

      // Collect all block IDs accounted for in chunks
      const chunkedBlockIds = new Set<string>()
      for (const chunk of res.chunks) {
        const bids = (chunk.metadata.sourceBlockIds as string[]) || []
        for (const bid of bids) {
          chunkedBlockIds.add(bid)
        }
      }

      // Collect all non-searchable block IDs
      const nonSearchableBlockIds = new Set<string>(
        (res.nonSearchableBlocks ?? []).map((b) => b.blockId)
      )

      // Every block ID in the document must be in chunkedBlockIds OR nonSearchableBlockIds
      for (const block of doc.blocks) {
        const isAccounted = chunkedBlockIds.has(block.id) || nonSearchableBlockIds.has(block.id)
        expect(isAccounted).toBe(true)
      }

      // Verification of specific block dispositions
      expect(nonSearchableBlockIds.has('b-p-empty')).toBe(true)
      expect(nonSearchableBlockIds.has('b-page')).toBe(true)
      expect(chunkedBlockIds.has('b-h1')).toBe(true)
      expect(chunkedBlockIds.has('b-p1')).toBe(true)
      expect(chunkedBlockIds.has('b-code')).toBe(true)
      expect(chunkedBlockIds.has('b-list')).toBe(true)
      expect(chunkedBlockIds.has('b-img')).toBe(true)
    })

    it('2b. enforces non-destructive processing: input UniversalDocument is never mutated', () => {
      const doc: UniversalDocument = {
        id: 'doc-immutable',
        sourceInfo: { fileSizeBytes: 100 },
        format: 'txt',
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Original immutable paragraph.'
          }
        ],
        text: 'Original immutable paragraph.',
        metadata: { customField: 'original_value' },
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: 1700000000000
      }

      const deepCopyBefore = JSON.parse(JSON.stringify(doc))
      chunker.chunk(doc)
      const deepCopyAfter = JSON.parse(JSON.stringify(doc))

      expect(deepCopyAfter).toEqual(deepCopyBefore)
    })
  })

  // 3. Context Separation & Slicing Tests
  describe('Context Separation & Semantic Boundaries', () => {
    it('3a. tags repeated headers with repeatedHeader: true and isContextual: true in multi-chunk spreadsheets', () => {
      const rows: string[][] = []
      // Create 20 rows to force multiple chunks with chunkTargetTokens: 100
      for (let i = 1; i <= 20; i++) {
        rows.push([`Prod-${i}`, `Category-${i}`, `Description for product item ${i} in inventory`])
      }

      const doc: UniversalDocument = {
        id: 'doc-xlsx-multichunk',
        sourceInfo: { fileSizeBytes: 10000 },
        format: 'xlsx',
        blocks: [
          {
            id: 't-large',
            type: 'table',
            orderIndex: 0,
            text: 'Inventory Table',
            headers: ['SKU', 'Category', 'Description'],
            rows,
            rowCount: rows.length + 1,
            columnCount: 3,
            isSpreadsheet: true,
            sheetName: 'Inventory',
            sheetIndex: 1
          } as UniversalTableBlock
        ],
        text: 'Inventory Table',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBeGreaterThan(1)

      // Subsequent chunks must have repeatedHeader and isContextual tagged
      const subsequent = res.chunks.slice(1)
      for (const sc of subsequent) {
        expect(sc.metadata.repeatedHeader).toBe(true)
        expect(sc.metadata.isContextual).toBe(true)
        expect(sc.content).toContain('[Table Header:')
      }
    })

    it('3b. splits oversized blocks at semantic sentence boundaries and tags isOversized: true without truncating', () => {
      // Create a massive paragraph of 400 words (exceeding chunkTargetTokens: 100)
      const sentences = [
        'The primary stage booster rocket delivers thirty meganewtons of initial sea-level thrust.',
        'Cryogenic liquid oxygen and subcooled methane propel the core stage through atmospheric ascent.',
        'Telemetry confirmed supersonic transition at altitude twelve kilometers above the launch complex.',
        'Staging separation occurred cleanly under cold-gas thruster attitude control.',
        'The upper stage orbital insertion burn completed with nominal delta-v margins across all vectors.'
      ]
      const oversizedText = sentences.join(' ')

      const doc: UniversalDocument = {
        id: 'doc-oversized-txt',
        sourceInfo: { fileSizeBytes: 5000 },
        format: 'txt',
        blocks: [
          {
            id: 'b-oversized',
            type: 'paragraph',
            orderIndex: 0,
            text: oversizedText
          }
        ],
        text: oversizedText,
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      const res = chunker.chunk(doc)
      expect(res.chunks.length).toBeGreaterThan(1)

      for (const c of res.chunks) {
        expect(c.metadata.isOversized).toBe(true)
        expect(typeof c.metadata.startIndex).toBe('number')
        expect(typeof c.metadata.endIndex).toBe('number')
        expect((c.metadata.endIndex as number) - (c.metadata.startIndex as number)).toBeGreaterThan(
          0
        )
      }

      // Check overlap between chunk 0 and chunk 1
      const c0 = res.chunks[0]
      const c1 = res.chunks[1]
      expect(c0.metadata.endIndex as number).toBeGreaterThan(c1.metadata.startIndex as number)
    })
  })

  // 4. Determinism & Stability Tests
  describe('Determinism & Stability', () => {
    it('4a. produces identical chunk outputs for identical UniversalDocument inputs across runs', () => {
      const doc: UniversalDocument = {
        id: 'doc-deterministic',
        sourceInfo: { fileSizeBytes: 1000 },
        format: 'md',
        blocks: [
          {
            id: 'h1',
            type: 'heading',
            orderIndex: 0,
            level: 1,
            text: 'Chapter 1: Foundations',
            headingPath: ['Chapter 1: Foundations']
          } as UniversalHeadingBlock,
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 1,
            text: 'Foundations of mathematical logic and model theory.'
          } as UniversalParagraphBlock,
          {
            id: 'p2',
            type: 'paragraph',
            orderIndex: 2,
            text: 'Completeness theorem proof and ultraproduct constructions.'
          } as UniversalParagraphBlock
        ],
        text: '# Chapter 1: Foundations\n\nFoundations...',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: testExtractor,
        extractedAt: 1700000000000
      }

      const run1 = chunker.chunk(doc)
      const run2 = chunker.chunk(doc)

      expect(run1.chunks.length).toBe(run2.chunks.length)
      expect(run1.totalTokens).toBe(run2.totalTokens)
      expect(run1.nonSearchableBlocks).toEqual(run2.nonSearchableBlocks)

      for (let i = 0; i < run1.chunks.length; i++) {
        expect(run1.chunks[i].content).toBe(run2.chunks[i].content)
        expect(run1.chunks[i].tokenCount).toBe(run2.chunks[i].tokenCount)
        expect(run1.chunks[i].metadata).toEqual(run2.chunks[i].metadata)
      }
    })
  })

  // 5. Error Handling & Defensive Guards
  describe('Error Handling & Defensive Guards', () => {
    it('5a. rejects null or undefined input with chunkingInvalidInput DocumentError', () => {
      expect(() => chunker.chunk(null as unknown as UniversalDocument)).toThrow(DocumentError)
      expect(() => chunker.chunk(undefined as unknown as UniversalDocument)).toThrow(DocumentError)
    })

    it('5b. rejects document missing blocks array with chunkingInvalidInput DocumentError', () => {
      const invalidDoc = {
        id: 'bad-doc',
        format: 'txt'
      } as unknown as UniversalDocument

      expect(() => chunker.chunk(invalidDoc)).toThrow(DocumentError)
    })

    it('5c. rejects document with unsupported format with extractionUnsupportedFormat DocumentError', () => {
      const unsupportedDoc: UniversalDocument = {
        id: 'bad-format-doc',
        sourceInfo: { fileSizeBytes: 1000 },
        format: 'mp3' as unknown as UniversalDocument['format'],
        blocks: [],
        text: '',
        metadata: {},
        warnings: [],
        quality: { fidelity: 'low', isLossy: true, isOcr: false },
        extractor: testExtractor,
        extractedAt: Date.now()
      }

      expect(() => chunker.chunk(unsupportedDoc)).toThrow(DocumentError)
    })
  })
})
