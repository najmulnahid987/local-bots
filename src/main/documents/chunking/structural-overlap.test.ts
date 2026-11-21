import { describe, it, expect } from 'vitest'
import { TextChunker } from './text-chunker'
import { MarkdownChunker } from './markdown-chunker'
import { PdfChunker } from './pdf-chunker'
import { DocxChunker } from './docx-chunker'
import { SpreadsheetChunker } from './spreadsheet-chunker'
import { CsvChunker } from './csv-chunker'
import { PresentationChunker } from './presentation-chunker'
import type { UniversalDocument, UniversalDocumentBlock } from '../model/types'
import type { StructuredSourceSpan } from './types'

function makeTestDoc(partial: {
  id: string
  format: UniversalDocument['format']
  blocks: UniversalDocumentBlock[]
}): UniversalDocument {
  return {
    sourceInfo: { fileSizeBytes: 1000 },
    text: '',
    metadata: {},
    warnings: [],
    quality: { fidelity: 'high', isLossy: false, isOcr: false },
    extractor: { id: 'test-extractor', name: 'Test Extractor', version: '1.0.0' },
    extractedAt: Date.now(),
    ...partial
  }
}

describe('Structural Overlap & Source-Span Provenance (Phase 11 Step 11.10)', () => {
  describe('1. TXT Format Structural Overlap & Provenance', () => {
    const chunker = new TextChunker()

    it('assigns sourceSpans with exact character offsets to accumulated paragraphs', () => {
      const doc = makeTestDoc({
        id: 'doc-txt-1',
        format: 'txt',
        blocks: [
          {
            id: 'blk-1',
            type: 'paragraph',
            text: 'First paragraph text.',
            orderIndex: 0
          },
          {
            id: 'blk-2',
            type: 'paragraph',
            text: 'Second paragraph text.',
            orderIndex: 1
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(1)
      const chunk = result.chunks[0]

      const spans = chunk.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans).toBeDefined()
      expect(spans.length).toBe(2)
      expect(spans[0].blockId).toBe('blk-1')
      expect(spans[0].startOffset).toBe(0)
      expect(spans[0].endOffset).toBe('First paragraph text.'.length)
      expect(spans[0].offsetConvention).toBe('utf16_code_units')
      expect(spans[0].isPrimary).toBe(true)
      expect(spans[1].blockId).toBe('blk-2')
    })

    it('slices oversized paragraphs with structural overlap and flags isRepeatedOverlap', () => {
      const longSentence = 'Structural overlap preserves textual continuity. '
      const doc = makeTestDoc({
        id: 'doc-txt-2',
        format: 'txt',
        blocks: [
          {
            id: 'blk-oversized',
            type: 'paragraph',
            text: longSentence.repeat(30), // ~360 tokens
            orderIndex: 0
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 100, chunkOverlapTokens: 20 })
      expect(result.chunks.length).toBeGreaterThan(1)

      // First chunk has no overlap
      expect(result.chunks[0].metadata.hasOverlap).toBeUndefined()
      // Subsequent chunks have overlap flagged
      expect(result.chunks[1].metadata.hasOverlap).toBe(true)
      expect(result.chunks[1].metadata.overlapTokens).toBe(20)

      const spans = result.chunks[1].metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans[0].blockId).toBe('blk-oversized')
      expect(spans[0].isRepeatedOverlap).toBe(true)
      expect(spans[0].startOffset).toBeGreaterThan(0)
    })
  })

  describe('2. Markdown Format Contextual Budgeting & Table Header Overlap', () => {
    const chunker = new MarkdownChunker()

    it('deducts heading context breadcrumbs from chunk target budget', () => {
      const doc = makeTestDoc({
        id: 'doc-md-1',
        format: 'md',
        blocks: [
          {
            id: 'blk-h1',
            type: 'heading',
            level: 1,
            text: 'System Architecture Reference Guide',
            headingPath: ['System Architecture Reference Guide'],
            orderIndex: 0
          },
          {
            id: 'blk-p1',
            type: 'paragraph',
            text: 'Architecture overview description text.',
            orderIndex: 1
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(1)
      const chunk = result.chunks[0]
      expect(chunk.content).toContain('[Context: System Architecture Reference Guide]')
      expect(chunk.metadata.contextPrefix).toBeDefined()
    })

    it('repeats table headers on sliced tables and tags overlap provenance', () => {
      const rows = Array.from({ length: 40 }, (_, i) => [
        `Item ${i + 1}`,
        `Value ${i + 1}`,
        `Notes ${i + 1}`
      ])
      const doc = makeTestDoc({
        id: 'doc-md-2',
        format: 'md',
        blocks: [
          {
            id: 'blk-tbl',
            type: 'table',
            text: '',
            headers: ['Item Name', 'Price USD', 'Description Column'],
            rows,
            rowCount: rows.length,
            columnCount: 3,
            orderIndex: 0
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 150 })
      expect(result.chunks.length).toBeGreaterThan(1)

      // First chunk has no table header overlap repetition
      expect(result.chunks[0].metadata.hasOverlap).toBeUndefined()

      // Second chunk repeats header and tags overlap
      const chunk2 = result.chunks[1]
      expect(chunk2.metadata.hasOverlap).toBe(true)
      expect(chunk2.metadata.overlapTokens).toBeGreaterThan(0)
      expect(chunk2.content).toContain('| Item Name | Price USD | Description Column |')

      const spans = chunk2.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans[0].blockId).toBe('blk-tbl')
      expect(spans[0].isRepeatedOverlap).toBe(true)
    })
  })

  describe('3. PDF Format Page Boundary Preservation & Coordinates', () => {
    const chunker = new PdfChunker()

    it('assigns physical pageNumber and coordinates to sourceSpans', () => {
      const doc = makeTestDoc({
        id: 'doc-pdf-1',
        format: 'pdf',
        blocks: [
          {
            id: 'blk-p1',
            type: 'paragraph',
            text: 'Page one text content.',
            orderIndex: 0,
            location: { pageNumber: 1, lineStart: 1, lineEnd: 2 }
          },
          {
            id: 'blk-pb',
            type: 'page_boundary',
            pageNumber: 2,
            text: '',
            orderIndex: 1
          },
          {
            id: 'blk-p2',
            type: 'paragraph',
            text: 'Page two text content.',
            orderIndex: 2,
            location: { pageNumber: 2, lineStart: 1, lineEnd: 2 }
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(2)
      expect(result.chunks[0].pageNumber).toBe(1)
      expect(result.chunks[1].pageNumber).toBe(2)

      const spans1 = result.chunks[0].metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans1[0].pageNumber).toBe(1)
      const spans2 = result.chunks[1].metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans2[0].pageNumber).toBe(2)
    })
  })

  describe('4. DOCX Format Ancillary Isolation & Footnote Provenance', () => {
    const chunker = new DocxChunker()

    it('isolates footnotes and records noteId in sourceSpans', () => {
      const doc = makeTestDoc({
        id: 'doc-docx-1',
        format: 'docx',
        blocks: [
          {
            id: 'blk-body',
            type: 'paragraph',
            text: 'Main thesis body paragraph.',
            orderIndex: 0
          },
          {
            id: 'blk-fn',
            type: 'paragraph',
            text: 'Citation reference to seminal paper.',
            orderIndex: 1,
            metadata: { role: 'footnote', noteId: '42' }
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(2)

      const fnChunk = result.chunks.find((c) => c.metadata.contentRole === 'footnote')
      expect(fnChunk).toBeDefined()
      expect(fnChunk?.content).toContain('[Footnote 42]')
      const spans = fnChunk?.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans[0].noteId).toBe('42')
    })
  })

  describe('5. XLSX Format Coordinate Tracking & Repeated Header Overlap', () => {
    const chunker = new SpreadsheetChunker()

    it('tracks sheetName, startRow, endRow and tags repeated header overlap', () => {
      const rows = Array.from({ length: 60 }, (_, i) => [
        `Row ${i + 1} | A${i + 1}: Item ${i + 1} | B${i + 1}: ${100 + i}`
      ])

      const doc = makeTestDoc({
        id: 'doc-xlsx-1',
        format: 'xlsx',
        blocks: [
          {
            id: 'blk-sheet',
            type: 'table',
            text: '',
            headers: ['Item Name', 'Amount'],
            rows,
            rowCount: rows.length,
            columnCount: 2,
            orderIndex: 0,
            metadata: { sheetName: 'LedgerSheet', sheetIndex: 1 }
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 150 })
      expect(result.chunks.length).toBeGreaterThan(1)

      const chunk2 = result.chunks[1]
      expect(chunk2.metadata.sheetName).toBe('LedgerSheet')
      expect(chunk2.metadata.hasOverlap).toBe(true)

      const spans = chunk2.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans.some((s) => s.isRepeatedOverlap === true)).toBe(true)
      expect(spans[0].sheetName).toBe('LedgerSheet')
    })
  })

  describe('6. CSV Format Data-Row-1 Preservation & Record Coordinates', () => {
    const chunker = new CsvChunker()

    it('preserves row 1 as data when headerState is unknown and tracks rowIndex spans', () => {
      const rows = [
        ['alpha', '100', 'active'],
        ['beta', '200', 'pending'],
        ['gamma', '300', 'closed']
      ]
      const doc = makeTestDoc({
        id: 'doc-csv-1',
        format: 'csv',
        blocks: [
          {
            id: 'blk-csv',
            type: 'table',
            text: '',
            headers: [],
            rows,
            rowCount: rows.length,
            columnCount: 3,
            orderIndex: 0,
            metadata: { headerState: 'unknown' }
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(1)
      const chunk = result.chunks[0]

      // Row 1 is preserved verbatim as Record 1
      expect(chunk.content).toContain('Record 1 | Col 1: alpha')
      expect(chunk.metadata.hasOverlap).toBeUndefined()

      const spans = chunk.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans.length).toBe(3)
      expect(spans[0].rowIndex).toBe(1)
      expect(spans[1].rowIndex).toBe(2)
      expect(spans[2].rowIndex).toBe(3)
    })
  })

  describe('7. PPTX Format Slide Boundary & Speaker Notes Isolation', () => {
    const chunker = new PresentationChunker()

    it('tracks slideNumber in sourceSpans and isolates speaker notes', () => {
      const doc = makeTestDoc({
        id: 'doc-pptx-1',
        format: 'pptx',
        blocks: [
          {
            id: 'blk-slide-1',
            type: 'slide_boundary',
            slideNumber: 1,
            slideTitle: 'Intro Slide',
            text: '',
            orderIndex: 0,
            metadata: { slideNumber: 1, slideTitle: 'Intro Slide' }
          },
          {
            id: 'blk-text-1',
            type: 'paragraph',
            text: 'Slide 1 visible text.',
            orderIndex: 1
          },
          {
            id: 'blk-notes-1',
            type: 'paragraph',
            text: 'Speaker note: emphasize local-first privacy.',
            orderIndex: 2,
            metadata: { isSpeakerNotes: true, role: 'speaker_note' }
          }
        ]
      })

      const result = chunker.chunk(doc, { chunkTargetTokens: 500 })
      expect(result.chunks.length).toBe(1)
      const chunk = result.chunks[0]

      expect(chunk.content).toContain('[Slide 1: Intro Slide]')
      expect(chunk.content).toContain('Slide 1 visible text.')
      expect(chunk.content).toContain(
        '[Speaker Notes: Speaker note: emphasize local-first privacy.]'
      )
      expect(chunk.metadata.slideNumber).toBe(1)

      const spans = chunk.metadata.sourceSpans as unknown as StructuredSourceSpan[]
      expect(spans.length).toBeGreaterThan(0)
      expect(spans[0].slideNumber).toBe(1)
    })
  })
})
