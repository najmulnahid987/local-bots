import { describe, it, expect } from 'vitest'
import { PdfPageClassifier } from './page-classifier'

describe('PdfPageClassifier (Phase 10 Step 10.12)', () => {
  const classifier = new PdfPageClassifier()

  it('1. classifies empty page with zero text and zero images as EMPTY', () => {
    const res = classifier.classifyPage({
      pageNumber: 1,
      textLength: 0,
      invisibleTextLength: 0,
      imageCount: 0,
      imageCoverage: 0
    })

    expect(res.classification).toBe('EMPTY')
    expect(res.pageNumber).toBe(1)
  })

  it('2. classifies page with existing invisible OCR layer >= 100 chars as EXISTING_OCR_TEXT', () => {
    const res = classifier.classifyPage({
      pageNumber: 2,
      textLength: 10,
      invisibleTextLength: 150,
      imageCount: 1,
      imageCoverage: 0.8
    })

    expect(res.classification).toBe('EXISTING_OCR_TEXT')
    expect(res.reason).toContain('existing invisible OCR layer')
  })

  it('3. classifies born-digital page with adequate text (>=100 chars) and low coverage as DIGITAL_TEXT', () => {
    const res = classifier.classifyPage({
      pageNumber: 3,
      textLength: 450,
      invisibleTextLength: 0,
      imageCount: 0,
      imageCoverage: 0
    })

    expect(res.classification).toBe('DIGITAL_TEXT')
    expect(res.reason).toContain('Born-digital page')
  })

  it('4. classifies digital page with decorative images (<0.40 coverage) and moderate text (>=30 chars) as DIGITAL_TEXT', () => {
    const res = classifier.classifyPage({
      pageNumber: 4,
      textLength: 75,
      invisibleTextLength: 0,
      imageCount: 2,
      imageCoverage: 0.15
    })

    expect(res.classification).toBe('DIGITAL_TEXT')
    expect(res.reason).toContain('decorative/minor image coverage')
  })

  it('5. classifies scanned page with zero text and >=1 image as OCR_REQUIRED', () => {
    const res = classifier.classifyPage({
      pageNumber: 5,
      textLength: 0,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.85
    })

    expect(res.classification).toBe('OCR_REQUIRED')
    expect(res.reason).toContain('Scanned page')
  })

  it('6. classifies page with sparse text (<30 chars) and substantial image coverage (>=0.40) as OCR_REQUIRED', () => {
    const res = classifier.classifyPage({
      pageNumber: 6,
      textLength: 15,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.65
    })

    expect(res.classification).toBe('OCR_REQUIRED')
  })

  it('7. classifies mixed ambiguous page and preserves native digital text with warning', () => {
    const res = classifier.classifyPage({
      pageNumber: 7,
      textLength: 50,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.45
    })

    expect(res.classification).toBe('DIGITAL_TEXT')
    expect(res.warning).toContain('Preserving native digital text')
  })

  it('8. respects threshold boundary conditions deterministically', () => {
    // Exactly 100 characters with 0.49 coverage -> DIGITAL_TEXT
    const boundary1 = classifier.classifyPage({
      pageNumber: 8,
      textLength: 100,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.49
    })
    expect(boundary1.classification).toBe('DIGITAL_TEXT')

    // 29 characters with 0.40 coverage -> OCR_REQUIRED (<30 chars, >=0.40 coverage)
    const boundary2 = classifier.classifyPage({
      pageNumber: 9,
      textLength: 29,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.4
    })
    expect(boundary2.classification).toBe('OCR_REQUIRED')

    // 30 characters with 0.39 coverage -> DIGITAL_TEXT (>=30 chars, <0.40 coverage)
    const boundary3 = classifier.classifyPage({
      pageNumber: 10,
      textLength: 30,
      invisibleTextLength: 0,
      imageCount: 1,
      imageCoverage: 0.39
    })
    expect(boundary3.classification).toBe('DIGITAL_TEXT')

    // Exactly 100 invisible characters -> EXISTING_OCR_TEXT
    const boundary4 = classifier.classifyPage({
      pageNumber: 11,
      textLength: 0,
      invisibleTextLength: 100,
      imageCount: 1,
      imageCoverage: 0.9
    })
    expect(boundary4.classification).toBe('EXISTING_OCR_TEXT')
  })

  it('9. classifies full document preserving 1-based page order', () => {
    const docMetrics = [
      { pageNumber: 1, textLength: 500, invisibleTextLength: 0, imageCount: 0, imageCoverage: 0 },
      { pageNumber: 2, textLength: 0, invisibleTextLength: 0, imageCount: 1, imageCoverage: 0.8 },
      { pageNumber: 3, textLength: 0, invisibleTextLength: 0, imageCount: 0, imageCoverage: 0 }
    ]

    const results = classifier.classifyDocument(docMetrics)
    expect(results).toHaveLength(3)
    expect(results[0].classification).toBe('DIGITAL_TEXT')
    expect(results[1].classification).toBe('OCR_REQUIRED')
    expect(results[2].classification).toBe('EMPTY')
  })
})
