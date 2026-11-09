import { describe, it, expect } from 'vitest'
import { PdfExtractor, extractPdf } from './pdf-extractor'
import { StaticDocumentSettingsProvider } from '../document-settings'
import { DocumentExtractionError } from '../document-errors'

/**
 * Deterministic in-memory PDF generator for unit tests.
 * Produces valid, standard PDF 1.4 documents with exact xref byte offsets.
 */
function createTestPdf(pages: string[]): Uint8Array {
  const objects: string[] = []
  const pageObjIds: number[] = []
  let nextId = 3

  const contentEntries: { pageId: number; contentId?: number; text?: string }[] = []
  for (const pageText of pages) {
    const pageId = nextId++
    pageObjIds.push(pageId)
    if (pageText.length > 0) {
      const contentId = nextId++
      contentEntries.push({ pageId, contentId, text: pageText })
    } else {
      contentEntries.push({ pageId })
    }
  }

  // 1 0 obj: Catalog
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`
  // 2 0 obj: Pages
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`

  // Font object
  const fontId = nextId++
  objects[fontId] =
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`

  for (const entry of contentEntries) {
    if (entry.contentId && entry.text !== undefined) {
      const escaped = entry.text.replace(/[()\\]/g, '\\$&')
      const streamData = `BT\n/F1 18 Tf\n100 700 Td\n(${escaped}) Tj\nET`
      objects[entry.contentId] =
        `${entry.contentId} 0 obj\n<< /Length ${Buffer.byteLength(streamData)} >>\nstream\n${streamData}\nendstream\nendobj`
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${entry.contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj`
    } else {
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj`
    }
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id < nextId; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += objects[id] + '\n'
  }

  const startXref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${nextId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextId; id++) {
    body += String(offsets[id]).padStart(10, '0') + ' 00000 n \n'
  }
  body += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`

  return new Uint8Array(Buffer.from(body, 'latin1'))
}

/**
 * Generates a deterministic encrypted/password-protected PDF 1.4 document.
 */
function createEncryptedPdf(): Uint8Array {
  const encryptedPdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
6 0 obj
<< /Filter /Standard /V 1 /R 2 /O (12345678901234567890123456789012) /U (12345678901234567890123456789012) /P -4 >>
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000000 65535 f 
0000000000 65535 f 
0000000185 00000 n 
trailer
<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<12345678901234567890123456789012><12345678901234567890123456789012>] >>
startxref
305
%%EOF`
  return new Uint8Array(Buffer.from(encryptedPdf, 'latin1'))
}

describe('PdfExtractor (Phase 5 Step 5.5)', () => {
  const extractor = new PdfExtractor()

  // 1. Valid Single-Page PDF Extraction
  it('1. extracts text from a valid single-page PDF with 1-based page metadata', async () => {
    const bytes = createTestPdf(['Introduction to Antigravity Workspace'])
    const result = await extractor.extract(bytes)

    expect(result.format).toBe('pdf')
    expect(result.text).toContain('Introduction to Antigravity Workspace')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toEqual({
      text: 'Introduction to Antigravity Workspace',
      pageNumber: 1
    })
    expect(result.metadata?.pageCount).toBe(1)
  })

  // 2. Valid Multi-Page PDF Extraction
  it('2. extracts text from a multi-page PDF preserving page-by-page mapping and 1-based page numbers', async () => {
    const pages = ['Page 1 - Vision', 'Page 2 - Architecture', 'Page 3 - Verification']
    const bytes = createTestPdf(pages)
    const result = await extractor.extract(bytes)

    expect(result.format).toBe('pdf')
    expect(result.sections).toHaveLength(3)

    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text).toBe('Page 1 - Vision')

    expect(result.sections[1].pageNumber).toBe(2)
    expect(result.sections[1].text).toBe('Page 2 - Architecture')

    expect(result.sections[2].pageNumber).toBe(3)
    expect(result.sections[2].text).toBe('Page 3 - Verification')

    expect(result.metadata?.pageCount).toBe(3)
  })

  // 3. Blank and Mixed Pages Preservation
  it('3. preserves intermediate blank pages without renumbering or shifting page numbers', async () => {
    const pages = ['First Page Text', '', 'Third Page Text After Blank']
    const bytes = createTestPdf(pages)
    const result = await extractor.extract(bytes)

    expect(result.sections).toHaveLength(3)

    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text).toBe('First Page Text')

    // Page 2 is blank, but section is present and pageNumber is 2
    expect(result.sections[1].pageNumber).toBe(2)
    expect(result.sections[1].text).toBe('')

    // Page 3 retains pageNumber 3
    expect(result.sections[2].pageNumber).toBe(3)
    expect(result.sections[2].text).toBe('Third Page Text After Blank')
  })

  // 4. All-Blank / Scanned PDF Rejection
  it('4. rejects an all-blank or image-only PDF with EXTRACTION_NO_TEXT_CONTENT', async () => {
    const blankSingle = createTestPdf([''])
    await expect(extractor.extract(blankSingle)).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(blankSingle)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_NO_TEXT_CONTENT',
        message: expect.stringContaining('OCR is not supported')
      })
    )

    const blankMulti = createTestPdf(['', '   \n\t  ', ''])
    await expect(extractor.extract(blankMulti)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_NO_TEXT_CONTENT'
      })
    )
  })

  // 5. Page Limit Enforcement - Exceeded Limit
  it('5. rejects PDF exceeding configured page count limit with EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED', async () => {
    // Custom settings provider with maxPdfPages = 2
    const settingsProvider = new StaticDocumentSettingsProvider({ maxPdfPages: 2 })
    const limitedExtractor = new PdfExtractor(settingsProvider)

    const threePagePdf = createTestPdf(['Page 1', 'Page 2', 'Page 3'])

    await expect(limitedExtractor.extract(threePagePdf)).rejects.toThrow(DocumentExtractionError)
    await expect(limitedExtractor.extract(threePagePdf)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED',
        message: expect.stringContaining(
          'exceeds the maximum allowed page count of 2 pages (contains 3 pages)'
        ),
        details: { maxPages: 2, actualPages: 3 }
      })
    )
  })

  // 6. Page Limit Enforcement - Exact Limit
  it('6. accepts PDF exactly matching the configured page limit', async () => {
    const settingsProvider = new StaticDocumentSettingsProvider({ maxPdfPages: 3 })
    const limitedExtractor = new PdfExtractor(settingsProvider)

    const threePagePdf = createTestPdf(['Page 1', 'Page 2', 'Page 3'])
    const result = await limitedExtractor.extract(threePagePdf)

    expect(result.sections).toHaveLength(3)
    expect(result.metadata?.pageCount).toBe(3)
  })

  // 7. Password-Protected PDF Rejection
  it('7. rejects password-protected / encrypted PDF with EXTRACTION_PDF_PASSWORD_PROTECTED', async () => {
    const encryptedBytes = createEncryptedPdf()

    await expect(extractor.extract(encryptedBytes)).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(encryptedBytes)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_PDF_PASSWORD_PROTECTED',
        message: expect.stringContaining('password-protected or encrypted')
      })
    )
  })

  // 8. Corrupt and Malformed PDF Bytes
  it('8. rejects corrupt or invalid PDF bytes with EXTRACTION_INVALID_PDF', async () => {
    const randomBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    await expect(extractor.extract(randomBytes)).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(randomBytes)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_PDF',
        message: expect.stringContaining('structure is invalid or corrupt')
      })
    )

    const truncatedBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog')
    await expect(extractor.extract(truncatedBytes)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_PDF'
      })
    )
  })

  // 9. Empty Bytes Input
  it('9. rejects empty 0-byte input with EXTRACTION_EMPTY_CONTENT', async () => {
    await expect(extractor.extract(new Uint8Array(0))).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(new Uint8Array(0))).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_EMPTY_CONTENT'
      })
    )
  })

  // 10. Malformed Non-Byte Inputs
  it('10. rejects malformed non-byte inputs with EXTRACTION_MALFORMED_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract(null as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract(undefined as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract('string is not bytes' as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )
  })

  // 11. Buffer Immutability & Reusability
  it('11. does not mutate caller buffer and allows repeated extraction', async () => {
    const original = createTestPdf(['Consistent extraction test'])
    const snapshot = new Uint8Array(original)

    const result1 = await extractor.extract(original)
    const result2 = await extractor.extract(original)

    expect(original).toEqual(snapshot)
    expect(result1.text).toBe(result2.text)
    expect(result1.sections).toEqual(result2.sections)
  })

  // 12. Top-Level extractPdf Convenience Function
  it('12. extractPdf convenience function delegates to PdfExtractor with default and custom settings', async () => {
    const bytes = createTestPdf(['Convenience function content'])
    const result = await extractPdf(bytes)

    expect(result.format).toBe('pdf')
    expect(result.text).toContain('Convenience function content')

    const settingsProvider = new StaticDocumentSettingsProvider({ maxPdfPages: 1 })
    const multiPdf = createTestPdf(['P1', 'P2'])
    await expect(extractPdf(multiPdf, settingsProvider)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED'
      })
    )
  })
})
