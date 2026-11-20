import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { PdfOcrPipeline } from './pdf-ocr-pipeline'
import { TesseractTestDouble } from './tesseract-test-double'
import { buildSyntheticPdf } from '../../benchmarks/fixtures/pdf-generator'
import { DocumentExtractionError } from '../../document-errors'

describe('PdfOcrPipeline (Phase 10 Step 10.12)', () => {
  const testDouble = new TesseractTestDouble()
  const pipeline = new PdfOcrPipeline({
    ocrEngine: testDouble,
    config: {
      language: 'eng+ben',
      retryLowConfidence: true
    }
  })

  it('1. extracts born-digital PDF directly with zero OCR overhead', async () => {
    const digitalPdf = buildSyntheticPdf({
      title: 'Digital PDF',
      pages: [
        {
          pageNumber: 1,
          lines: [
            {
              text: 'This is a born-digital page containing well over one hundred characters of searchable text. It should be extracted directly without calling OCR.',
              x: 50,
              y: 700
            }
          ]
        }
      ]
    })

    const result = await pipeline.extract(digitalPdf)

    expect(result.format).toBe('pdf')
    expect(result.ocrPageNumbers).toHaveLength(0) // Zero pages OCR'd
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text).toContain('born-digital page')
  })

  it('2. selectively performs OCR on scanned image-only PDF pages', async () => {
    const scannedPdf = buildSyntheticPdf({
      title: 'Scanned Document',
      pages: [{ pageNumber: 1, isImageOnly: true }]
    })

    const result = await pipeline.extract(scannedPdf)

    expect(result.format).toBe('pdf')
    expect(result.ocrPageNumbers).toEqual([1])
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text.length).toBeGreaterThan(0)
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.blocks[0].pageNumber).toBe(1)
  })

  it('3. seamlessly handles mixed PDF preserving strict physical page order', async () => {
    const mixedPdf = buildSyntheticPdf({
      title: 'Mixed Digital and Scanned Document',
      pages: [
        {
          pageNumber: 1,
          lines: [
            {
              text: 'Page 1 Digital Introduction: The system architecture enforces local-first document indexing.',
              x: 50,
              y: 700
            }
          ]
        },
        {
          pageNumber: 2,
          isImageOnly: true // Scanned page
        },
        {
          pageNumber: 3,
          lines: [
            {
              text: 'Page 3 Digital Conclusion: Verification passed for multi-page document integrity.',
              x: 50,
              y: 700
            }
          ]
        }
      ]
    })

    const result = await pipeline.extract(mixedPdf)

    expect(result.sections).toHaveLength(3)

    // Page 1: Digital
    expect(result.sections[0].pageNumber).toBe(1)
    expect(result.sections[0].text).toContain('Page 1 Digital Introduction')

    // Page 2: OCR-derived
    expect(result.sections[1].pageNumber).toBe(2)
    expect(result.sections[1].text.length).toBeGreaterThan(0)
    expect(result.ocrPageNumbers).toEqual([2])

    // Page 3: Digital
    expect(result.sections[2].pageNumber).toBe(3)
    expect(result.sections[2].text).toContain('Page 3 Digital Conclusion')
  })

  it('4. strictly preserves original PDF byte immutability and SHA-256 hash', async () => {
    const originalPdf = buildSyntheticPdf({
      title: 'Immutability Test',
      pages: [{ pageNumber: 1, isImageOnly: true }]
    })

    const initialHash = createHash('sha256').update(originalPdf).digest('hex')
    const initialByteLength = originalPdf.byteLength

    await pipeline.extract(originalPdf)

    const finalHash = createHash('sha256').update(originalPdf).digest('hex')
    expect(finalHash).toBe(initialHash)
    expect(originalPdf.byteLength).toBe(initialByteLength)
  })

  it('5. rejects all-blank PDF with EXTRACTION_NO_TEXT_CONTENT', async () => {
    const blankPdf = buildSyntheticPdf({
      title: 'Blank PDF',
      pages: [{ pageNumber: 1, isBlank: true }]
    })

    await expect(pipeline.extract(blankPdf)).rejects.toThrow(DocumentExtractionError)
  })

  it('6. respects AbortSignal cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    const pdf = buildSyntheticPdf({
      title: 'Cancel Test',
      pages: [{ pageNumber: 1, isImageOnly: true }]
    })

    await expect(pipeline.extract(pdf, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'EXTRACTION_CANCELLED' })
    )
  })
})
