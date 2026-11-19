import { describe, it, expect } from 'vitest'
import { MarkdownExtractorAdapter, TxtExtractorAdapter, PdfExtractorAdapter } from './adapters'
import { StaticDocumentSettingsProvider } from '../document-settings'

/**
 * Minimal valid single-page PDF generator for adapter tests.
 */
function createMinimalPdf(text: string): Uint8Array {
  const streamData = `BT\n/F1 18 Tf\n100 700 Td\n(${text}) Tj\nET`
  const body = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${Buffer.byteLength(streamData)} >>
stream
${streamData}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000350 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
429
%%EOF`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('Extractor Adapters (Phase 10 Step 10.4)', () => {
  const dummyContext = {
    limits: {
      timeoutMs: 10000,
      maxInputSizeBytes: 10 * 1024 * 1024,
      maxOutputSizeBytes: 10 * 1024 * 1024,
      maxPages: 100
    }
  }

  describe('MarkdownExtractorAdapter', () => {
    const adapter = new MarkdownExtractorAdapter()

    it('1. extracts structural headings, tables, and paragraphs with full block semantics', async () => {
      const markdown = `# Architecture

Introductory prose describing the system.

## Database

| Engine | Mode | Cache |
|---|---|---|
| SQLite | WAL | 64MB |
| DuckDB | ReadOnly | 32MB |

Final summary paragraph.`

      const result = await adapter.extract(
        { bytes: new Uint8Array(Buffer.from(markdown)) },
        dummyContext
      )

      expect(result.format).toBe('md')
      expect(result.quality.fidelity).toBe('high')
      expect(result.blocks.length).toBeGreaterThanOrEqual(4)

      // Find heading blocks
      const h1 = result.blocks.find((b) => b.type === 'heading' && b.text === 'Architecture')
      expect(h1).toBeDefined()
      expect(h1?.heading?.level).toBe(1)
      expect(h1?.heading?.headingPath).toEqual(['Architecture'])

      const h2 = result.blocks.find((b) => b.type === 'heading' && b.text === 'Database')
      expect(h2).toBeDefined()
      expect(h2?.heading?.level).toBe(2)
      expect(h2?.heading?.headingPath).toEqual(['Architecture', 'Database'])

      // Find table block
      const tableBlock = result.blocks.find((b) => b.type === 'table')
      expect(tableBlock).toBeDefined()
      expect(tableBlock?.table?.headers).toEqual(['Engine', 'Mode', 'Cache'])
      expect(tableBlock?.table?.rows).toHaveLength(2)
      expect(tableBlock?.table?.rows[0]).toEqual(['SQLite', 'WAL', '64MB'])
      expect(tableBlock?.table?.rows[1]).toEqual(['DuckDB', 'ReadOnly', '32MB'])
    })

    it('2. declares correct metadata and supported formats', () => {
      expect(adapter.metadata.id).toBe('purejs-markdown-extractor')
      expect(adapter.supports('md')).toBe(true)
      expect(adapter.supports('.MARKDOWN')).toBe(true)
      expect(adapter.supports('txt')).toBe(false)
    })
  })

  describe('TxtExtractorAdapter', () => {
    const adapter = new TxtExtractorAdapter()

    it('3. extracts plain text documents into paragraph blocks', async () => {
      const text = 'Line one of text.\nLine two of text.'
      const result = await adapter.extract(
        { bytes: new Uint8Array(Buffer.from(text)) },
        dummyContext
      )

      expect(result.format).toBe('txt')
      expect(result.text).toBe(text)
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0].type).toBe('paragraph')
      expect(result.blocks[0].text).toBe(text)
    })

    it('4. declares correct metadata and supported formats', () => {
      expect(adapter.metadata.id).toBe('purejs-txt-extractor')
      expect(adapter.supports('txt')).toBe(true)
      expect(adapter.supports('TEXT')).toBe(true)
      expect(adapter.supports('md')).toBe(false)
    })
  })

  describe('PdfExtractorAdapter', () => {
    const settings = new StaticDocumentSettingsProvider({ maxPdfPages: 5 })
    const adapter = new PdfExtractorAdapter(settings)

    it('5. extracts page-bounded text blocks preserving 1-based page numbers', async () => {
      const pdfBytes = createMinimalPdf('Adapter PDF Integration Test')
      const result = await adapter.extract({ bytes: pdfBytes }, dummyContext)

      expect(result.format).toBe('pdf')
      expect(result.text).toContain('Adapter PDF Integration Test')
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0].pageNumber).toBe(1)
      expect(result.quality.fidelity).toBe('medium')
      expect(result.quality.isLossy).toBe(true)
    })

    it('6. rejects corrupted PDF bytes with structured DocumentExtractionError', async () => {
      const corruptBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00])

      await expect(adapter.extract({ bytes: corruptBytes }, dummyContext)).rejects.toThrowError(
        expect.objectContaining({ code: 'EXTRACTION_INVALID_PDF' })
      )
    })
  })
})
