import { describe, it, expect } from 'vitest'
import { SpreadsheetChunker } from './spreadsheet-chunker'
import { SemanticChunker } from './semantic-chunker'
import { StaticDocumentSettingsProvider } from '../document-settings'
import type { ExtractedDocument } from '../extractors/types'

describe('SpreadsheetChunker (Phase 10 Step 10.7)', () => {
  const chunker = new SpreadsheetChunker()

  // 1. Basic spreadsheet chunking
  it('1. preserves worksheet identity, row boundaries, and coordinates in chunk context', () => {
    const doc: ExtractedDocument = {
      format: 'xlsx',
      text: '# Sheet: Financials (Sheet 1)\n\nRow 1 | A1: Department | B1: Q1 Budget | C1: Q2 Budget\nRow 2 | A2: Engineering | B2: 500000 | C2: 550000\nRow 3 | A3: Operations | B3: 300000 | C3: 320000',
      sections: [
        {
          heading: 'Sheet: Financials',
          headingLevel: 1,
          headingPath: ['Sheet: Financials'],
          lineStart: 1,
          lineEnd: 4,
          text: '# Sheet: Financials (Sheet 1)\n\nRow 1 | A1: Department | B1: Q1 Budget | C1: Q2 Budget\nRow 2 | A2: Engineering | B2: 500000 | C2: 550000\nRow 3 | A3: Operations | B3: 300000 | C3: 320000'
        }
      ]
    }

    const result = chunker.chunk(doc)

    expect(result.totalChunks).toBeGreaterThan(0)
    expect(result.chunks.length).toBe(1)
    const chunk = result.chunks[0]

    expect(chunk.content).toContain('[Spreadsheet Context]')
    expect(chunk.content).toContain('Worksheet: Financials (Sheet 1)')
    expect(chunk.content).toContain('Rows: 1–3')
    expect(chunk.content).toContain('Row 1 | A1: Department | B1: Q1 Budget | C1: Q2 Budget')
    expect(chunk.content).toContain('Row 2 | A2: Engineering | B2: 500000 | C2: 550000')
    expect(chunk.content).toContain('Row 3 | A3: Operations | B3: 300000 | C3: 320000')

    expect(chunk.metadata.sheetName).toBe('Financials')
    expect(chunk.metadata.startRow).toBe(1)
    expect(chunk.metadata.endRow).toBe(3)
    expect(chunk.tokenCount).toBeGreaterThan(0)
  })

  // 2. Multi-sheet independence
  it('2. isolates multiple worksheets across separate chunk boundaries', () => {
    const doc: ExtractedDocument = {
      format: 'xlsx',
      text: 'Multi-sheet workbook',
      sections: [
        {
          heading: 'Sheet: Sheet_Alpha',
          headingLevel: 1,
          headingPath: ['Sheet: Sheet_Alpha'],
          lineStart: 1,
          lineEnd: 2,
          text: 'Row 1 | A1: Item | B1: Price\nRow 2 | A2: Widget | B2: 9.99'
        },
        {
          heading: 'Sheet: Sheet_Beta',
          headingLevel: 1,
          headingPath: ['Sheet: Sheet_Beta'],
          lineStart: 3,
          lineEnd: 4,
          text: 'Row 1 | A1: Client | B1: Status\nRow 2 | A2: Acme Corp | B2: Active'
        }
      ]
    }

    const result = chunker.chunk(doc)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].metadata.sheetName).toBe('Sheet_Alpha')
    expect(result.chunks[0].content).toContain('Worksheet: Sheet_Alpha')
    expect(result.chunks[0].content).toContain('A2: Widget')

    expect(result.chunks[1].metadata.sheetName).toBe('Sheet_Beta')
    expect(result.chunks[1].content).toContain('Worksheet: Sheet_Beta')
    expect(result.chunks[1].content).toContain('A2: Acme Corp')
  })

  // 3. Repeating table headers on subsequent chunks
  it('3. repeats table headers on subsequent row chunks', () => {
    // Construct a sheet with many rows and a tight token budget
    const rows = ['Row 1 | A1: ID | B1: Name | C1: Score | D1: Grade']
    for (let i = 2; i <= 30; i++) {
      rows.push(`Row ${i} | A${i}: ${i} | B${i}: Student_${i} | C${i}: ${80 + (i % 20)} | D${i}: A`)
    }

    const doc: ExtractedDocument = {
      format: 'xlsx',
      text: rows.join('\n'),
      sections: [
        {
          heading: 'Sheet: Grades',
          headingLevel: 1,
          headingPath: ['Sheet: Grades'],
          lineStart: 1,
          lineEnd: rows.length,
          text: rows.join('\n')
        }
      ]
    }

    // Set tight token target: 100 tokens per chunk
    const customProvider = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 20
    })

    const tightChunker = new SpreadsheetChunker(customProvider)
    const result = tightChunker.chunk(doc)

    expect(result.totalChunks).toBeGreaterThan(1)

    // The first chunk has row 1 as its first row
    expect(result.chunks[0].metadata.startRow).toBe(1)

    // Subsequent chunks (where startRow > 1) MUST contain the repeated table header prefix
    const laterChunks = result.chunks.filter((c) => (c.metadata.startRow as number) > 1)
    expect(laterChunks.length).toBeGreaterThan(0)

    for (const laterChunk of laterChunks) {
      expect(laterChunk.content).toContain(
        '[Table Header: A1: ID | B1: Name | C1: Score | D1: Grade]'
      )
    }
  })

  // 4. Wide row handling
  it('4. slices wide rows exceeding chunkTargetTokens into coordinate parts without dropping data', () => {
    // Construct an ultra-wide single row
    const wideCells: string[] = []
    for (let c = 0; c < 100; c++) {
      wideCells.push(`COL_${c}: VeryLongCellValue_${c}_Data_Payload_123456789`)
    }
    const wideRowText = `Row 1 | ${wideCells.join(' | ')}`

    const doc: ExtractedDocument = {
      format: 'xlsx',
      text: wideRowText,
      sections: [
        {
          heading: 'Sheet: WideSheet',
          headingLevel: 1,
          headingPath: ['Sheet: WideSheet'],
          lineStart: 1,
          lineEnd: 1,
          text: wideRowText
        }
      ]
    }

    // Tight token target
    const tightProvider = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })

    const tightChunker = new SpreadsheetChunker(tightProvider)
    const result = tightChunker.chunk(doc)

    expect(result.totalChunks).toBeGreaterThan(1)
    expect(result.chunks.every((c) => c.metadata.isWideRowSlice === true)).toBe(true)

    // Check that part labels are preserved
    expect(result.chunks[0].content).toContain('Part 1')
    expect(result.chunks[1].content).toContain('Part 2')
  })

  // 5. SemanticChunker delegation integration
  it('5. seamlessly integrates with SemanticChunker when format is xlsx', () => {
    const semanticChunker = new SemanticChunker()
    const doc: ExtractedDocument = {
      format: 'xlsx',
      text: 'Row 1 | A1: K | B1: V\nRow 2 | A2: 1 | B2: 2',
      sections: [
        {
          heading: 'Sheet: Simple',
          headingLevel: 1,
          headingPath: ['Sheet: Simple'],
          lineStart: 1,
          lineEnd: 2,
          text: 'Row 1 | A1: K | B1: V\nRow 2 | A2: 1 | B2: 2'
        }
      ]
    }

    const result = semanticChunker.chunk(doc)
    expect(result.totalChunks).toBe(1)
    expect(result.chunks[0].content).toContain('[Spreadsheet Context]')
    expect(result.chunks[0].metadata.sheetName).toBe('Simple')
  })

  // 6. Error handling
  it('6. rejects documents with unsupported format or empty content', () => {
    expect(() => chunker.chunk({ format: 'docx', text: '', sections: [] })).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_UNSUPPORTED_FORMAT' })
    )

    expect(() => chunker.chunk({ format: 'xlsx', text: '', sections: [] })).toThrowError(
      expect.objectContaining({ code: 'CHUNKING_INVALID_INPUT' })
    )
  })
})
