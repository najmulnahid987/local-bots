import { describe, it, expect } from 'vitest'
import { FormatDetector, normalizeFormatExtension } from './format-detector'

describe('FormatDetector (Phase 10 Step 10.4)', () => {
  // 1. PDF magic bytes detection
  it('1. detects PDF from %PDF- magic bytes regardless of misleading filename or mime', () => {
    const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj'))
    const detected = FormatDetector.detect(pdfBytes, 'readme.txt', 'text/plain')

    expect(detected.canonicalFormat).toBe('pdf')
    expect(detected.confidence).toBe('exact')
    expect(detected.magicBytesMatched).toBe(true)
    expect(detected.isBinary).toBe(true)
  })

  // 2. ZIP magic bytes detection
  it('2. detects ZIP / OpenXML archive from PK\\x03\\x04 signature', () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])

    // With docx hint
    const detectedDocx = FormatDetector.detect(zipBytes, 'report.docx')
    expect(detectedDocx.canonicalFormat).toBe('docx')
    expect(detectedDocx.confidence).toBe('high')
    expect(detectedDocx.magicBytesMatched).toBe(true)

    // With xlsx hint
    const detectedXlsx = FormatDetector.detect(zipBytes, 'budget.xlsx')
    expect(detectedXlsx.canonicalFormat).toBe('xlsx')
    expect(detectedXlsx.confidence).toBe('high')

    // With pptx hint
    const detectedPptx = FormatDetector.detect(zipBytes, 'deck.pptx')
    expect(detectedPptx.canonicalFormat).toBe('pptx')
    expect(detectedPptx.confidence).toBe('high')

    // With pptx MIME type hint
    const detectedPptxMime = FormatDetector.detect(
      zipBytes,
      undefined,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(detectedPptxMime.canonicalFormat).toBe('pptx')
    expect(detectedPptxMime.confidence).toBe('high')

    // Without hint
    const detectedZip = FormatDetector.detect(zipBytes)
    expect(detectedZip.canonicalFormat).toBe('zip')
    expect(detectedZip.confidence).toBe('exact')

    // Content-based inspection for XLSX without hint
    const xlsxZipBytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
        Buffer.from('some data with xl/workbook.xml inside')
      ])
    )
    const detectedXlsxByContent = FormatDetector.detect(xlsxZipBytes)
    expect(detectedXlsxByContent.canonicalFormat).toBe('xlsx')
    expect(detectedXlsxByContent.confidence).toBe('high')

    // Content-based inspection for PPTX without hint
    const pptxZipBytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
        Buffer.from('some data with ppt/presentation.xml inside')
      ])
    )
    const detectedPptxByContent = FormatDetector.detect(pptxZipBytes)
    expect(detectedPptxByContent.canonicalFormat).toBe('pptx')
    expect(detectedPptxByContent.confidence).toBe('high')
  })

  // 3. Binary control bytes check
  it('3. flags binary files with NUL bytes pretending to be text', () => {
    const binaryBytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f])
    const detected = FormatDetector.detect(binaryBytes, 'fake.txt', 'text/plain')

    expect(detected.isBinary).toBe(true)
    expect(detected.canonicalFormat).toBe('txt')
    expect(detected.confidence).toBe('hint')
  })

  // 4. HTML detection
  it('4. detects HTML documents starting with <!doctype html or <html', () => {
    const htmlBytes = new Uint8Array(
      Buffer.from('<!DOCTYPE html>\n<html><body><h1>Title</h1></body></html>')
    )
    const detected = FormatDetector.detect(htmlBytes)

    expect(detected.canonicalFormat).toBe('html')
    expect(detected.confidence).toBe('high')
    expect(detected.isBinary).toBe(false)
  })

  // 5. Markdown heuristic detection
  it('5. detects Markdown from ATX headings, tables, or code fences', () => {
    const mdHeadings = new Uint8Array(Buffer.from('# Project Plan\n\nSome introductory text.'))
    expect(FormatDetector.detect(mdHeadings).canonicalFormat).toBe('md')

    const mdTable = new Uint8Array(Buffer.from('| Col 1 | Col 2 |\n|---|---|\n| Val 1 | Val 2 |'))
    expect(FormatDetector.detect(mdTable).canonicalFormat).toBe('md')

    const mdCode = new Uint8Array(Buffer.from('```typescript\nconst x = 1;\n```'))
    expect(FormatDetector.detect(mdCode).canonicalFormat).toBe('md')
  })

  // 6. Clean plain text fallback
  it('6. classifies clean UTF-8 text without markdown markup as txt', () => {
    const txtBytes = new Uint8Array(
      Buffer.from('This is a completely normal paragraph without any headings.')
    )
    const detected = FormatDetector.detect(txtBytes)

    expect(detected.canonicalFormat).toBe('txt')
    expect(detected.isBinary).toBe(false)
  })

  // 7. Format normalization helper
  it('7. normalizes extensions and common aliases cleanly', () => {
    expect(normalizeFormatExtension('.PDF')).toBe('pdf')
    expect(normalizeFormatExtension('..MD')).toBe('md')
    expect(normalizeFormatExtension('markdown')).toBe('md')
    expect(normalizeFormatExtension('text')).toBe('txt')
    expect(normalizeFormatExtension('  .DOCX  ')).toBe('docx')
    expect(normalizeFormatExtension('')).toBe('')
  })
})
