/**
 * Comprehensive domain types for native OCR integration, page classification,
 * raster rendering, TSV parsing, and provenance tracking.
 */

export type PageClassification =
  'DIGITAL_TEXT' | 'EXISTING_OCR_TEXT' | 'OCR_REQUIRED' | 'AMBIGUOUS' | 'EMPTY'

export interface PageInspectionData {
  readonly pageNumber: number
  readonly textLength: number
  readonly invisibleTextLength: number
  readonly imageCount: number
  readonly imageCoverage: number
}

export interface PageClassificationResult {
  readonly pageNumber: number
  readonly classification: PageClassification
  readonly reason: string
  readonly warning?: string
  readonly metrics: PageInspectionData
}

export interface OcrBoundingBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface OcrWord {
  readonly text: string
  readonly confidence: number
  readonly bbox: OcrBoundingBox
  readonly lineNum: number
  readonly parNum: number
  readonly blockNum: number
}

export interface OcrLine {
  readonly text: string
  readonly bbox: OcrBoundingBox
  readonly words: readonly OcrWord[]
  readonly lineNum: number
}

export interface OcrParagraph {
  readonly lines: readonly OcrLine[]
  readonly bbox: OcrBoundingBox
}

export interface OcrPageResult {
  readonly pageNumber: number
  readonly text: string
  readonly confidence: number
  readonly words: readonly OcrWord[]
  readonly lines: readonly OcrLine[]
  readonly paragraphs: readonly OcrParagraph[]
  readonly bbox: OcrBoundingBox
  readonly isOcrDerived: true
  readonly language: string
  readonly engineVersion: string
  readonly renderDpi: number
  readonly warning?: string
}

export type OcrLanguage = 'eng' | 'ben' | 'eng+ben'

export interface OcrEngineConfig {
  readonly executablePath?: string
  readonly tessdataPath?: string
  readonly language?: OcrLanguage
  readonly pageSegmentationMode?: number
  readonly perPageTimeoutMs?: number
  readonly totalDocumentTimeoutMs?: number
  readonly baselineDpi?: number
  readonly retryDpi?: number
  readonly minConfidenceThreshold?: number
  readonly retryLowConfidence?: boolean
}

export const OCR_DEFAULTS = {
  LANGUAGE: 'eng+ben' as OcrLanguage,
  BASELINE_DPI: 150,
  RETRY_DPI: 300,
  MAX_PAGE_DIMENSION: 4096,
  MAX_PAGE_PIXELS: 16_777_216,
  PER_PAGE_TIMEOUT_MS: 30_000,
  TOTAL_DOCUMENT_TIMEOUT_MS: 300_000,
  MIN_CONFIDENCE_THRESHOLD: 50.0,
  // Classification threshold hypotheses calibrated against synthetic benchmarks
  ADEQUATE_DIGITAL_TEXT_CHARS: 100,
  MIN_DIGITAL_TEXT_CHARS: 30,
  SCANNED_IMAGE_COVERAGE_THRESHOLD: 0.4,
  HIGH_IMAGE_COVERAGE_THRESHOLD: 0.5,
  EXISTING_OCR_INVISIBLE_CHARS: 100
} as const
