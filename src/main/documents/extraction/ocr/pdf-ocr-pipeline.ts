import { getDocumentProxy, extractText, inspectPages } from 'unpdf'
import { DocumentError, DocumentErrors } from '../../document-errors'
import {
  type DocumentSettingsProvider,
  StaticDocumentSettingsProvider
} from '../../document-settings'
import type { ExtractedDocument, ExtractedDocumentSection } from '../../extractors/types'
import type { ExtractedDocumentBlock, ExtractionQuality } from '../types'
import { PdfPageClassifier } from './page-classifier'
import { PdfPageRenderer } from './page-renderer'
import { TesseractTsvParser } from './tsv-parser'
import { OcrTempStorageManager } from './temp-storage-manager'
import type { IOcrEngine } from './tesseract-engine'
import { NativeTesseractEngine } from './tesseract-engine'
import type { OcrEngineConfig, PageClassificationResult } from './ocr-types'
import { OCR_DEFAULTS } from './ocr-types'

export interface PdfOcrPipelineOptions {
  readonly settingsProvider?: DocumentSettingsProvider
  readonly ocrEngine?: IOcrEngine
  readonly classifier?: PdfPageClassifier
  readonly renderer?: PdfPageRenderer
  readonly tsvParser?: TesseractTsvParser
  readonly tempStorage?: OcrTempStorageManager
  readonly config?: OcrEngineConfig
}

export interface PdfOcrExtractionResult extends ExtractedDocument {
  readonly ocrPageNumbers: readonly number[]
  readonly pageClassifications: readonly PageClassificationResult[]
  readonly warnings: readonly string[]
  readonly blocks: readonly ExtractedDocumentBlock[]
  readonly quality?: ExtractionQuality
}

/**
 * End-to-end PDF extraction pipeline with selective page-level OCR fallback.
 *
 * Invariant Guarantees:
 * 1. Born-digital pages are extracted directly without rasterization or OCR overhead.
 * 2. Pre-existing OCR layers are reused directly without duplicate OCR.
 * 3. Scanned/image-only pages are selectively rendered and processed with OCR.
 * 4. Mixed PDFs strictly preserve physical 1-based page order and provenance.
 * 5. Original PDF bytes remain 100% immutable and unmutated.
 * 6. Temporary raster and TSV files are isolated and deterministically cleaned up.
 */
export class PdfOcrPipeline {
  private readonly settingsProvider: DocumentSettingsProvider
  private readonly ocrEngine: IOcrEngine
  private readonly classifier: PdfPageClassifier
  private readonly renderer: PdfPageRenderer
  private readonly tsvParser: TesseractTsvParser
  private readonly tempStorage: OcrTempStorageManager
  private readonly config: OcrEngineConfig

  constructor(options?: PdfOcrPipelineOptions) {
    this.settingsProvider = options?.settingsProvider ?? new StaticDocumentSettingsProvider()
    this.classifier = options?.classifier ?? new PdfPageClassifier()
    this.renderer = options?.renderer ?? new PdfPageRenderer()
    this.tsvParser = options?.tsvParser ?? new TesseractTsvParser()
    this.tempStorage = options?.tempStorage ?? new OcrTempStorageManager()
    this.config = options?.config ?? {}

    if (options?.ocrEngine) {
      this.ocrEngine = options.ocrEngine
    } else {
      // In production, use NativeTesseractEngine. Never silently fall back to TesseractTestDouble!
      this.ocrEngine = new NativeTesseractEngine()
    }
  }

  /**
   * Processes a PDF byte buffer through the selective extraction and OCR fallback pipeline.
   */
  public async extract(
    bytes: Uint8Array | Buffer,
    signal?: AbortSignal
  ): Promise<PdfOcrExtractionResult> {
    if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
      throw DocumentErrors.extractionMalformedInput('Input must be a valid Buffer or Uint8Array.')
    }

    if (bytes.byteLength === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The document content is empty and contains no text to extract.'
      )
    }

    if (signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // Defensive copy for initial proxy loading
    const initialCopy = new Uint8Array(bytes.slice(0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let proxy: any = null

    try {
      try {
        proxy = await getDocumentProxy(initialCopy)
      } catch (loadErr: unknown) {
        if (loadErr instanceof DocumentError) throw loadErr
        const errObj = loadErr as { name?: string; message?: string; code?: number }
        const errName = errObj?.name ?? ''
        const errMsg = errObj?.message ?? ''

        if (
          errName === 'PasswordException' ||
          errObj?.code === 1 ||
          errObj?.code === 2 ||
          errMsg.toLowerCase().includes('password')
        ) {
          throw DocumentErrors.extractionPdfPasswordProtected(loadErr)
        }

        if (
          errName === 'InvalidPDFException' ||
          errName === 'MissingPDFException' ||
          errMsg.includes('Invalid PDF') ||
          errMsg.includes('PDF file is empty')
        ) {
          throw DocumentErrors.extractionInvalidPdf(loadErr)
        }

        throw DocumentErrors.extractionPdfProcessingFailed(
          errMsg || 'Failed to open PDF document.',
          loadErr
        )
      }

      const totalPages = proxy.numPages
      if (typeof totalPages !== 'number' || totalPages <= 0) {
        throw DocumentErrors.extractionNoTextContent(
          'The PDF document contains no pages to extract.'
        )
      }

      // Enforce configured page limit
      const settings = this.settingsProvider.getSettings()
      const maxPdfPages = settings.maxPdfPages
      if (totalPages > maxPdfPages) {
        throw DocumentErrors.extractionPdfPageLimitExceeded(maxPdfPages, totalPages)
      }

      // 1. Digital text extraction
      let digitalExtractResult: { totalPages: number; text: string[] }
      try {
        digitalExtractResult = await extractText(proxy, { mergePages: false })
      } catch (extractErr: unknown) {
        if (extractErr instanceof DocumentError) throw extractErr
        const errMsg = (extractErr as { message?: string })?.message ?? ''
        throw DocumentErrors.extractionPdfProcessingFailed(
          errMsg || 'Failed to extract text from PDF pages.',
          extractErr
        )
      }

      const rawDigitalPages = Array.isArray(digitalExtractResult.text)
        ? digitalExtractResult.text
        : [digitalExtractResult.text]

      // 2. Page inspection via unpdf.inspectPages (using fresh defensive copy)
      const inspectionCopy = new Uint8Array(bytes.slice(0))
      let inspectedPagesData: {
        totalPages: number
        pages: Array<{
          textLength: number
          invisibleTextLength: number
          imageCount: number
          imageCoverage: number
        }>
      }

      try {
        inspectedPagesData = await inspectPages(inspectionCopy)
      } catch {
        // If inspection fails, fallback to simple length heuristic
        inspectedPagesData = {
          totalPages,
          pages: rawDigitalPages.map((p) => ({
            textLength: (p ?? '').trim().length,
            invisibleTextLength: 0,
            imageCount: 0,
            imageCoverage: 0
          }))
        }
      }

      // 3. Classify all pages
      const classifications: PageClassificationResult[] = []
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1
        const metrics = inspectedPagesData.pages[i] ?? {
          pageNumber: pageNum,
          textLength: (rawDigitalPages[i] ?? '').trim().length,
          invisibleTextLength: 0,
          imageCount: 0,
          imageCoverage: 0
        }
        const classResult = this.classifier.classifyPage(
          { ...metrics, pageNumber: pageNum },
          rawDigitalPages[i]
        )
        classifications.push(classResult)
      }

      // 4. Check if any page requires OCR
      const ocrPages = classifications.filter((c) => c.classification === 'OCR_REQUIRED')

      // If no pages require OCR, verify if there is any extractable digital text
      if (ocrPages.length === 0) {
        const hasText = rawDigitalPages.some((p) => typeof p === 'string' && p.trim().length > 0)
        if (!hasText) {
          throw DocumentErrors.extractionNoTextContent(
            'No extractable text found. This PDF contains no searchable text or scanned images.'
          )
        }

        // Return purely digital extraction result
        const sections: ExtractedDocumentSection[] = rawDigitalPages.map((pageText, index) => ({
          text: pageText ?? '',
          pageNumber: index + 1
        }))
        const fullText = rawDigitalPages.join('\n\n')
        const blocks: ExtractedDocumentBlock[] = sections.map((sec) => ({
          type: 'paragraph',
          text: sec.text,
          pageNumber: sec.pageNumber
        }))

        const quality: ExtractionQuality = {
          fidelity: 'high',
          isLossy: false,
          isOcr: false
        }

        return {
          format: 'pdf',
          text: fullText,
          sections,
          ocrPageNumbers: [],
          pageClassifications: classifications,
          warnings: classifications.map((c) => c.warning).filter((w): w is string => Boolean(w)),
          blocks,
          quality,
          metadata: {
            pageCount: totalPages,
            characterCount: fullText.length
          }
        }
      }

      // 5. Execute selective OCR for pages marked OCR_REQUIRED
      const jobDir = await this.tempStorage.createJobDirectory()
      const ocrPageNumbers: number[] = []
      const warnings: string[] = []
      const finalSections: ExtractedDocumentSection[] = []
      const finalBlocks: ExtractedDocumentBlock[] = []

      try {
        for (let i = 0; i < totalPages; i++) {
          const pageNum = i + 1
          const classification = classifications[i]

          if (signal?.aborted) {
            throw DocumentErrors.extractionCancelled()
          }

          if (classification.warning) {
            warnings.push(classification.warning)
          }

          if (classification.classification === 'OCR_REQUIRED') {
            ocrPageNumbers.push(pageNum)

            // When native OCR engine is unavailable, never emit synthetic text!
            if (!this.ocrEngine.isAvailable) {
              const ocrWarn = `Page ${pageNum}: Scanned content requires OCR, but native Tesseract OCR engine is unavailable.`
              warnings.push(ocrWarn)
              finalSections.push({
                text: `[Page ${pageNum}: Scanned content - OCR unavailable]`,
                pageNumber: pageNum
              })
              finalBlocks.push({
                type: 'paragraph',
                text: `[Page ${pageNum}: Scanned content - OCR unavailable]`,
                pageNumber: pageNum,
                metadata: {
                  isScanned: true,
                  ocrUnavailable: true
                }
              })
              continue
            }

            // Render page to PNG image
            const pngBytes = await this.renderer.renderPageToImage(
              bytes,
              pageNum,
              this.config.baselineDpi ?? OCR_DEFAULTS.BASELINE_DPI
            )

            const imagePath = jobDir.getPageImagePath(pageNum)
            const tsvBasePath = jobDir.getPageTsvBasePath(pageNum)
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('node:fs')
            fs.writeFileSync(imagePath, pngBytes)

            // Execute OCR
            const ocrResult = await this.ocrEngine.executeOcr(
              imagePath,
              tsvBasePath,
              this.config,
              signal
            )

            // Parse TSV into structured page result
            let parsedPage = this.tsvParser.parse(
              ocrResult.tsvContent,
              pageNum,
              this.config.baselineDpi ?? OCR_DEFAULTS.BASELINE_DPI,
              this.config.language ?? OCR_DEFAULTS.LANGUAGE,
              this.ocrEngine.version
            )

            // Check if retry at 300 DPI is beneficial when confidence is low
            if (
              this.config.retryLowConfidence &&
              parsedPage.confidence <
                (this.config.minConfidenceThreshold ?? OCR_DEFAULTS.MIN_CONFIDENCE_THRESHOLD)
            ) {
              try {
                const highResPng = await this.renderer.renderPageToImage(
                  bytes,
                  pageNum,
                  OCR_DEFAULTS.RETRY_DPI
                )
                fs.writeFileSync(imagePath, highResPng)

                const retryOcrResult = await this.ocrEngine.executeOcr(
                  imagePath,
                  tsvBasePath,
                  this.config,
                  signal
                )

                const retryParsed = this.tsvParser.parse(
                  retryOcrResult.tsvContent,
                  pageNum,
                  OCR_DEFAULTS.RETRY_DPI,
                  this.config.language ?? OCR_DEFAULTS.LANGUAGE,
                  this.ocrEngine.version
                )

                if (retryParsed.confidence > parsedPage.confidence) {
                  parsedPage = retryParsed
                  warnings.push(
                    `Page ${pageNum}: OCR retried at 300 DPI, confidence improved from ${parsedPage.confidence}% to ${retryParsed.confidence}%.`
                  )
                }
              } catch {
                // Keep initial parsedPage if retry fails
              }
            }

            if (parsedPage.warning) {
              warnings.push(parsedPage.warning)
            }

            const pageText = parsedPage.text
            finalSections.push({
              text: pageText,
              pageNumber: pageNum
            })

            // Add structured blocks
            if (parsedPage.paragraphs.length > 0) {
              for (const par of parsedPage.paragraphs) {
                const parText = par.lines.map((l) => l.text).join('\n')
                finalBlocks.push({
                  type: 'paragraph',
                  text: parText,
                  pageNumber: pageNum
                })
              }
            } else {
              finalBlocks.push({
                type: 'paragraph',
                text: pageText,
                pageNumber: pageNum
              })
            }
          } else {
            // Digital or pre-existing OCR layer
            const digitalText = rawDigitalPages[i] ?? ''
            finalSections.push({
              text: digitalText,
              pageNumber: pageNum
            })
            finalBlocks.push({
              type: 'paragraph',
              text: digitalText,
              pageNumber: pageNum
            })
          }
        }
      } finally {
        await jobDir.cleanup()
      }

      // Check if document has any real text after OCR
      const hasAnyRealText = finalSections.some(
        (s) => s.text.trim().length > 0 && !s.text.includes('OCR unavailable')
      )
      if (!hasAnyRealText) {
        if (!this.ocrEngine.isAvailable) {
          throw DocumentErrors.extractionOcrEngineUnavailable(
            undefined,
            'The document consists of scanned images, but native Tesseract OCR is unavailable on this system.'
          )
        }
        throw DocumentErrors.extractionNoTextContent(
          'No extractable text found after OCR processing.'
        )
      }

      const fullText = finalSections.map((s) => s.text).join('\n\n')

      const hadOcrUnavailable = warnings.some((w) => w.includes('OCR engine is unavailable'))
      const hasDigitalPages = rawDigitalPages.some(
        (p) => typeof p === 'string' && p.trim().length > 0
      )
      const quality: ExtractionQuality = {
        fidelity: hadOcrUnavailable
          ? hasDigitalPages
            ? 'medium'
            : 'low'
          : ocrPageNumbers.length > 0
            ? 'medium'
            : 'high',
        isLossy: hadOcrUnavailable,
        isOcr: ocrPageNumbers.length > 0 && !hadOcrUnavailable,
        hasUnparsedElements: hadOcrUnavailable
      }

      return {
        format: 'pdf',
        text: fullText,
        sections: finalSections,
        ocrPageNumbers,
        pageClassifications: classifications,
        warnings,
        blocks: finalBlocks,
        quality,
        metadata: {
          pageCount: totalPages,
          characterCount: fullText.length
        }
      }
    } finally {
      if (proxy) {
        try {
          await proxy.loadingTask.destroy()
        } catch {
          // ignore
        }
      }
    }
  }
}
