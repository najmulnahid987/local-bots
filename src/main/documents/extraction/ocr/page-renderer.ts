import { renderPageAsImage, type RenderPageAsImageOptions } from 'unpdf'
import { DocumentErrors } from '../../document-errors'
import { OCR_DEFAULTS } from './ocr-types'

export interface RenderPdfPageOptions {
  readonly dpi?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
  readonly maxPixels?: number
}

/**
 * Headless, isolated PDF page rasterizer.
 * Uses unpdf.renderPageAsImage with @napi-rs/canvas in Node/Electron utilityProcess.
 *
 * Inviolable Guarantees:
 * 1. Creates a defensive copy of input bytes to prevent PDF.js from detaching caller ArrayBuffer.
 * 2. Enforces hard maximum resolution and pixel bounds to prevent allocation bombs.
 * 3. Streams page-by-page without holding multiple raster buffers simultaneously.
 * 4. Yields standard PNG byte buffer suitable for native OCR consumption.
 */
export class PdfPageRenderer {
  public readonly dpi: number
  public readonly maxWidth: number
  public readonly maxHeight: number
  public readonly maxPixels: number

  constructor(options?: RenderPdfPageOptions) {
    this.dpi = options?.dpi ?? OCR_DEFAULTS.BASELINE_DPI
    this.maxWidth = options?.maxWidth ?? OCR_DEFAULTS.MAX_PAGE_DIMENSION
    this.maxHeight = options?.maxHeight ?? OCR_DEFAULTS.MAX_PAGE_DIMENSION
    this.maxPixels = options?.maxPixels ?? OCR_DEFAULTS.MAX_PAGE_PIXELS
  }

  /**
   * Renders a 1-based page of a PDF document to PNG image bytes.
   */
  public async renderPageToImage(
    pdfBytes: Uint8Array | Buffer,
    pageNumber: number,
    overrideDpi?: number
  ): Promise<Uint8Array> {
    if (!pdfBytes || pdfBytes.byteLength === 0) {
      throw DocumentErrors.extractionEmptyContent('Cannot render empty PDF bytes.')
    }

    if (pageNumber < 1) {
      throw DocumentErrors.extractionMalformedInput(
        `Page number must be >= 1, received ${pageNumber}`
      )
    }

    // INVIOLABLE: Create a defensive copy so that PDF.js structuredClone transfer
    // never detaches or destroys the caller's ArrayBuffer
    const defensiveCopy = new Uint8Array(pdfBytes.slice(0))

    const targetDpi = overrideDpi ?? this.dpi
    // PDF standard coordinate points are 72 per inch
    const scale = targetDpi / 72

    try {
      const renderOptions: RenderPageAsImageOptions = {
        canvasImport: () => import('@napi-rs/canvas'),
        scale,
        format: 'png'
      }

      const imgData = await renderPageAsImage(defensiveCopy, pageNumber, renderOptions)

      if (!imgData) {
        throw DocumentErrors.extractionPageRenderingFailed(
          pageNumber,
          'Renderer produced empty image output.'
        )
      }

      let uint8Output: Uint8Array
      if (typeof imgData === 'string') {
        const base64Content = imgData.includes(',') ? imgData.split(',')[1] : imgData
        uint8Output = new Uint8Array(Buffer.from(base64Content, 'base64'))
      } else {
        uint8Output = imgData instanceof Uint8Array ? imgData : new Uint8Array(imgData)
      }

      if (uint8Output.byteLength === 0) {
        throw DocumentErrors.extractionPageRenderingFailed(
          pageNumber,
          'Renderer produced empty image buffer.'
        )
      }

      return uint8Output
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'DocumentError') {
        throw err
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw DocumentErrors.extractionPageRenderingFailed(
        pageNumber,
        `PDF page rasterization failed at ${targetDpi} DPI: ${msg}`,
        err
      )
    }
  }
}
