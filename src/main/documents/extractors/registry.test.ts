import { describe, it, expect } from 'vitest'
import { ExtractorRegistry, defaultExtractorRegistry, extractDocument } from './registry'
import { StaticDocumentSettingsProvider } from '../document-settings'
import type { DocumentExtractor, ExtractedDocument } from './types'

/**
 * Minimal valid single-page PDF generator for registry tests.
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

describe('ExtractorRegistry (Phase 5 Step 5.5)', () => {
  const registry = new ExtractorRegistry()

  // 1. TXT dispatch
  it('1. dispatches txt format to TxtExtractor and returns valid ExtractedDocument', async () => {
    const bytes = Buffer.from('Plain text dispatch test.')
    const result = await registry.extract('txt', bytes)

    expect(result.format).toBe('txt')
    expect(result.text).toBe('Plain text dispatch test.')
    expect(result.sections).toHaveLength(1)
  })

  // 2. Markdown dispatch
  it('2. dispatches md format to MarkdownExtractor and returns valid ExtractedDocument', async () => {
    const bytes = Buffer.from('# Heading\nMarkdown dispatch test.')
    const result = await registry.extract('md', bytes)

    expect(result.format).toBe('md')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].heading).toBe('Heading')
  })

  // 3. Case-insensitive format normalization and leading dot handling
  it('3. normalizes format strings (uppercase, leading dot)', async () => {
    const bytes = Buffer.from('Case normalization test.')

    expect(registry.hasExtractor('.TXT')).toBe(true)
    expect(registry.hasExtractor('MD')).toBe(true)
    expect(registry.hasExtractor('.md')).toBe(true)
    expect(registry.hasExtractor('.PDF')).toBe(true)

    const resultTxt = await registry.extract('.TXT', bytes)
    expect(resultTxt.format).toBe('txt')

    const resultMd = await registry.extract('.MD', Buffer.from('# Title\nContent'))
    expect(resultMd.format).toBe('md')
  })

  // 4. PDF dispatch to PdfExtractor
  it('4. dispatches pdf format to PdfExtractor and returns valid ExtractedDocument', async () => {
    const pdfBytes = createMinimalPdf('Registry PDF Dispatch')
    const result = await registry.extract('pdf', pdfBytes)

    expect(result.format).toBe('pdf')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text).toContain('Registry PDF Dispatch')
    expect(result.metadata?.pageCount).toBe(1)
  })

  // 5. Custom settings provider injection
  it('5. respects custom DocumentSettingsProvider injected into ExtractorRegistry', async () => {
    const restrictedSettings = new StaticDocumentSettingsProvider({ maxPdfPages: 1 })
    const restrictedRegistry = new ExtractorRegistry(restrictedSettings)

    // Build 2-page PDF
    const stream = 'BT\n/F1 18 Tf\n100 700 Td\n(Page) Tj\nET'
    const twoPagePdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>
endobj
4 0 obj
<< /Length ${stream.length} >>
stream
${stream}
endstream
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>
endobj
6 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000122 00000 n 
0000000251 00000 n 
0000000342 00000 n 
0000000471 00000 n 
trailer
<< /Size 7 /Root 1 0 R >>
startxref
550
%%EOF`
    const bytes = new Uint8Array(Buffer.from(twoPagePdf, 'latin1'))

    await expect(restrictedRegistry.extract('pdf', bytes)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED'
      })
    )
  })

  // 6. Unknown/unsupported formats
  it('6. rejects unknown formats with EXTRACTION_UNSUPPORTED_FORMAT', async () => {
    const dummyBytes = Buffer.from('data')
    const unsupported = ['docx', 'doc', 'html', 'rtf', 'epub', '']

    for (const fmt of unsupported) {
      await expect(registry.extract(fmt, dummyBytes)).rejects.toThrow(
        expect.objectContaining({
          code: 'EXTRACTION_UNSUPPORTED_FORMAT'
        })
      )
    }
  })

  // 7. Custom extractor registration
  it('7. allows registering custom extractors for new formats', async () => {
    const customRegistry = new ExtractorRegistry()

    const mockCsvExtractor: DocumentExtractor = {
      extract: async (bytes: Uint8Array | Buffer): Promise<ExtractedDocument> => {
        const text = new TextDecoder('utf-8').decode(bytes)
        return {
          format: 'txt',
          text,
          sections: [{ text, lineStart: 1, lineEnd: 1 }]
        }
      }
    }

    customRegistry.register('csv', mockCsvExtractor)
    expect(customRegistry.hasExtractor('csv')).toBe(true)

    const result = await customRegistry.extract('csv', Buffer.from('a,b,c'))
    expect(result.text).toBe('a,b,c')
  })

  // 8. Rejects invalid registration arguments
  it('8. rejects malformed registration arguments with EXTRACTION_MALFORMED_INPUT', () => {
    const customRegistry = new ExtractorRegistry()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => customRegistry.register('', null as any)).toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )
  })

  // 9. Global extractDocument helper & defaultExtractorRegistry
  it('9. global extractDocument helper dispatches using defaultExtractorRegistry', async () => {
    expect(defaultExtractorRegistry.hasExtractor('txt')).toBe(true)
    expect(defaultExtractorRegistry.hasExtractor('md')).toBe(true)
    expect(defaultExtractorRegistry.hasExtractor('pdf')).toBe(true)

    const result = await extractDocument('txt', Buffer.from('Global helper test.'))
    expect(result.format).toBe('txt')
    expect(result.text).toBe('Global helper test.')

    const pdfResult = await extractDocument('pdf', createMinimalPdf('Global Helper PDF'))
    expect(pdfResult.format).toBe('pdf')
    expect(pdfResult.text).toContain('Global Helper PDF')
  })
})
