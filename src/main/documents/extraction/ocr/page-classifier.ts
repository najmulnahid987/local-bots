import type { PageClassificationResult, PageInspectionData, PageClassification } from './ocr-types'
import { OCR_DEFAULTS } from './ocr-types'

export interface PageClassifierOptions {
  readonly adequateDigitalChars?: number
  readonly minDigitalChars?: number
  readonly scannedImageCoverage?: number
  readonly highImageCoverage?: number
  readonly existingOcrInvisibleChars?: number
}

/**
 * Deterministic classifier that inspects page characteristics (text length, invisible text,
 * image count, image coverage) and determines the appropriate extraction strategy.
 *
 * Rules:
 * 1. EMPTY: Page has 0 visible characters, 0 invisible characters, and 0 images (or 0% coverage).
 * 2. EXISTING_OCR_TEXT: Page already contains an invisible OCR text layer >= threshold (>=100 chars).
 * 3. DIGITAL_TEXT:
 *    - Has adequate text (>=100 chars) and image coverage < high threshold (0.50), OR
 *    - Has moderate text (>=30 chars) with low/decorative image coverage (<0.40).
 * 4. OCR_REQUIRED:
 *    - Has very low text (<30 chars) AND has substantial image coverage (>=0.40) or at least 1 image.
 * 5. AMBIGUOUS:
 *    - Mixed page that does not cleanly fit digital or scanned rules (e.g. 30-99 text chars with >=0.40 coverage).
 *      Native text is preserved, and a structured warning is emitted.
 */
export class PdfPageClassifier {
  private readonly adequateDigitalChars: number
  private readonly minDigitalChars: number
  private readonly scannedImageCoverage: number
  private readonly highImageCoverage: number
  private readonly existingOcrInvisibleChars: number

  constructor(options?: PageClassifierOptions) {
    this.adequateDigitalChars =
      options?.adequateDigitalChars ?? OCR_DEFAULTS.ADEQUATE_DIGITAL_TEXT_CHARS
    this.minDigitalChars = options?.minDigitalChars ?? OCR_DEFAULTS.MIN_DIGITAL_TEXT_CHARS
    this.scannedImageCoverage =
      options?.scannedImageCoverage ?? OCR_DEFAULTS.SCANNED_IMAGE_COVERAGE_THRESHOLD
    this.highImageCoverage =
      options?.highImageCoverage ?? OCR_DEFAULTS.HIGH_IMAGE_COVERAGE_THRESHOLD
    this.existingOcrInvisibleChars =
      options?.existingOcrInvisibleChars ?? OCR_DEFAULTS.EXISTING_OCR_INVISIBLE_CHARS
  }

  /**
   * Classifies a single PDF page based on inspection metrics and optional extracted text.
   */
  public classifyPage(
    metrics: PageInspectionData,
    extractedPageText?: string
  ): PageClassificationResult {
    const { pageNumber, textLength, invisibleTextLength, imageCount, imageCoverage } = metrics

    // Rule 1: Blank / Empty Page
    if (
      textLength === 0 &&
      invisibleTextLength === 0 &&
      (imageCount === 0 || imageCoverage === 0)
    ) {
      return {
        pageNumber,
        classification: 'EMPTY',
        reason: 'Page has zero text and zero image content.',
        metrics
      }
    }

    // Rule 2: Existing Invisible OCR Layer
    if (invisibleTextLength >= this.existingOcrInvisibleChars) {
      return {
        pageNumber,
        classification: 'EXISTING_OCR_TEXT',
        reason: `Page contains an existing invisible OCR layer (${invisibleTextLength} characters).`,
        metrics
      }
    }

    // Also check if extracted text has substantial content even if textLength was reported low by inspectPages
    const effectiveTextLen = Math.max(textLength, (extractedPageText ?? '').trim().length)

    // Rule 3: Digital Page with adequate text
    if (effectiveTextLen >= this.adequateDigitalChars && imageCoverage < this.highImageCoverage) {
      return {
        pageNumber,
        classification: 'DIGITAL_TEXT',
        reason: `Born-digital page with adequate searchable text (${effectiveTextLen} chars) and low/moderate image coverage (${(imageCoverage * 100).toFixed(1)}%).`,
        metrics
      }
    }

    // Rule 3b: Digital Page with moderate text and low image coverage (e.g. decorative images/logos)
    if (effectiveTextLen >= this.minDigitalChars && imageCoverage < this.scannedImageCoverage) {
      return {
        pageNumber,
        classification: 'DIGITAL_TEXT',
        reason: `Digital page with ${effectiveTextLen} chars and decorative/minor image coverage (${(imageCoverage * 100).toFixed(1)}%).`,
        metrics
      }
    }

    // Rule 4: Scanned Page needing OCR
    // Less than min text (<30 chars) and has at least one scanned image covering >= 40% (or imageCount >= 1 when text is 0)
    if (
      effectiveTextLen < this.minDigitalChars &&
      (imageCoverage >= this.scannedImageCoverage || (effectiveTextLen === 0 && imageCount >= 1))
    ) {
      return {
        pageNumber,
        classification: 'OCR_REQUIRED',
        reason: `Scanned page: sparse text (${effectiveTextLen} chars) with image content (${imageCount} images, ${(imageCoverage * 100).toFixed(1)}% coverage).`,
        metrics
      }
    }

    // Rule 5: Ambiguous mixed page
    let warningMsg = `Page ${pageNumber} has mixed characteristics: ${effectiveTextLen} characters with ${(imageCoverage * 100).toFixed(1)}% image coverage.`
    const classification: PageClassification =
      effectiveTextLen >= this.minDigitalChars ? 'DIGITAL_TEXT' : 'AMBIGUOUS'

    if (effectiveTextLen >= this.minDigitalChars) {
      // If there's usable text, favor DIGITAL_TEXT with an attached warning rather than failing or re-OCR'ing
      warningMsg += ' Preserving native digital text; OCR was not safely justified.'
    } else {
      warningMsg +=
        ' Insufficient text to confirm digital, but image coverage does not meet scanned threshold.'
    }

    return {
      pageNumber,
      classification,
      reason: 'Mixed/ambiguous page layout.',
      warning: warningMsg,
      metrics
    }
  }

  /**
   * Classifies all pages in a document.
   */
  public classifyDocument(
    pages: readonly PageInspectionData[],
    extractedPageTexts?: readonly string[]
  ): readonly PageClassificationResult[] {
    return pages.map((metrics, idx) => {
      const text = extractedPageTexts?.[idx]
      return this.classifyPage(metrics, text)
    })
  }
}
