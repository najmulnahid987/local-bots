import { describe, it, expect } from 'vitest'
import { PdfPageRenderer } from './page-renderer'
import { buildSyntheticPdf } from '../../benchmarks/fixtures/pdf-generator'
import { DocumentExtractionError } from '../../document-errors'

describe('PdfPageRenderer (Phase 10 Step 10.12)', () => {
  const renderer = new PdfPageRenderer({ dpi: 150 })

  it('1. renders a valid PDF page to PNG byte buffer with valid PNG magic bytes', async () => {
    const pdfBytes = buildSyntheticPdf({
      title: 'Render Test',
      pages: [
        {
          pageNumber: 1,
          lines: [{ text: 'Native Renderer Test Header', x: 50, y: 700, fontSize: 16 }]
        }
      ]
    })

    const pngBytes = await renderer.renderPageToImage(pdfBytes, 1)

    expect(pngBytes).toBeInstanceOf(Uint8Array)
    expect(pngBytes.byteLength).toBeGreaterThan(100)

    // Verify PNG magic header bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    expect(pngBytes[0]).toBe(0x89)
    expect(pngBytes[1]).toBe(0x50) // P
    expect(pngBytes[2]).toBe(0x4e) // N
    expect(pngBytes[3]).toBe(0x47) // G
    expect(pngBytes[4]).toBe(0x0d)
    expect(pngBytes[5]).toBe(0x0a)
    expect(pngBytes[6]).toBe(0x1a)
    expect(pngBytes[7]).toBe(0x0a)
  })

  it('2. preserves input buffer byteLength and never detaches caller ArrayBuffer', async () => {
    const pdfBytes = buildSyntheticPdf({
      title: 'Buffer Invariant Test',
      pages: [{ pageNumber: 1, lines: [{ text: 'Preserve Caller Buffer', x: 50, y: 700 }] }]
    })

    const initialLen = pdfBytes.byteLength
    const initialBufferLen = pdfBytes.buffer.byteLength

    await renderer.renderPageToImage(pdfBytes, 1)

    // INVIOLABLE: Caller's buffer must NOT be detached or corrupted
    expect(pdfBytes.byteLength).toBe(initialLen)
    expect(pdfBytes.buffer.byteLength).toBe(initialBufferLen)
  })

  it('3. renders scanned/image-only PDF page reliably', async () => {
    const scannedPdf = buildSyntheticPdf({
      title: 'Scanned Raster Test',
      pages: [{ pageNumber: 1, isImageOnly: true }]
    })

    const png = await renderer.renderPageToImage(scannedPdf, 1)
    expect(png.byteLength).toBeGreaterThan(0)
    expect(png[1]).toBe(0x50) // 'P'
  })

  it('4. rejects empty PDF bytes with DocumentExtractionError', async () => {
    await expect(renderer.renderPageToImage(new Uint8Array(0), 1)).rejects.toThrow(
      DocumentExtractionError
    )
  })

  it('5. rejects invalid page numbers (<1)', async () => {
    const pdfBytes = buildSyntheticPdf({
      title: 'Page Bound Test',
      pages: [{ pageNumber: 1, lines: [{ text: 'Test', x: 50, y: 700 }] }]
    })

    await expect(renderer.renderPageToImage(pdfBytes, 0)).rejects.toThrow(DocumentExtractionError)
  })
})
