import type { OcrPageResult, OcrWord, OcrLine, OcrParagraph, OcrBoundingBox } from './ocr-types'
import { OCR_DEFAULTS } from './ocr-types'

export interface TsvParserOptions {
  readonly minConfidenceThreshold?: number
  readonly maxTsvSizeBytes?: number
  readonly maxWords?: number
}

const DEFAULT_MAX_TSV_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_MAX_WORDS = 20_000

/**
 * Defensive parser for Tesseract TSV (Tab-Separated Values) output format.
 *
 * Tesseract TSV format specification:
 * Header: level	page_num	block_num	par_num	line_num	word_num	left	top	width	height	conf	text
 *
 * Levels:
 * 1 = Page
 * 2 = Block
 * 3 = Paragraph
 * 4 = Line
 * 5 = Word
 */
export class TesseractTsvParser {
  private readonly minConfidenceThreshold: number
  private readonly maxTsvSizeBytes: number
  private readonly maxWords: number

  constructor(options?: TsvParserOptions) {
    this.minConfidenceThreshold =
      options?.minConfidenceThreshold ?? OCR_DEFAULTS.MIN_CONFIDENCE_THRESHOLD
    this.maxTsvSizeBytes = options?.maxTsvSizeBytes ?? DEFAULT_MAX_TSV_SIZE_BYTES
    this.maxWords = options?.maxWords ?? DEFAULT_MAX_WORDS
  }

  /**
   * Parses TSV text into structured OcrPageResult, mapping coordinates and preserving
   * authentic PDF physical page number and hierarchical reading order.
   */
  public parse(
    tsvText: string,
    authenticPageNumber: number,
    renderDpi: number = OCR_DEFAULTS.BASELINE_DPI,
    language: string = OCR_DEFAULTS.LANGUAGE,
    engineVersion: string = '5.5.4'
  ): OcrPageResult {
    if (!tsvText || typeof tsvText !== 'string') {
      return this.createEmptyResult(authenticPageNumber, renderDpi, language, engineVersion)
    }

    const byteLen = Buffer.byteLength(tsvText, 'utf8')
    if (byteLen > this.maxTsvSizeBytes) {
      throw new Error(
        `TSV output exceeded maximum allowed size (${byteLen} > ${this.maxTsvSizeBytes} bytes)`
      )
    }

    const lines = tsvText.split(/\r?\n/)
    if (lines.length === 0 || !lines[0].trim()) {
      return this.createEmptyResult(authenticPageNumber, renderDpi, language, engineVersion)
    }

    // 1. Validate Header
    const headerCols = lines[0].split('\t').map((c) => c.trim().toLowerCase())
    const expectedHeaders = [
      'level',
      'page_num',
      'block_num',
      'par_num',
      'line_num',
      'word_num',
      'left',
      'top',
      'width',
      'height',
      'conf'
    ]
    const hasValidHeader = expectedHeaders.every((h, i) => headerCols[i] === h)

    if (!hasValidHeader) {
      throw new Error(
        `Malformed Tesseract TSV header: expected '${expectedHeaders.join('\t')}', got '${lines[0].slice(0, 100)}'`
      )
    }

    const words: OcrWord[] = []
    let totalConfidence = 0
    let confidenceWordCount = 0
    let minLeft = Infinity
    let minTop = Infinity
    let maxRight = 0
    let maxBottom = 0

    // Temporary grouping maps: blockNum -> parNum -> lineNum -> words
    const blockMap = new Map<number, Map<number, Map<number, OcrWord[]>>>()

    for (let i = 1; i < lines.length; i++) {
      const lineStr = lines[i]
      if (!lineStr.trim()) continue

      const cols = lineStr.split('\t')
      if (cols.length < 11) continue

      const level = Number.parseInt(cols[0], 10)
      const blockNum = Number.parseInt(cols[2], 10)
      const parNum = Number.parseInt(cols[3], 10)
      const lineNum = Number.parseInt(cols[4], 10)
      const _wordNum = Number.parseInt(cols[5], 10)
      void _wordNum
      const left = Number.parseInt(cols[6], 10)
      const top = Number.parseInt(cols[7], 10)
      const width = Number.parseInt(cols[8], 10)
      const height = Number.parseInt(cols[9], 10)
      const conf = Number.parseFloat(cols[10])
      const text = cols.length >= 12 ? cols.slice(11).join('\t').trim() : ''

      // Defensive validation of numeric fields
      if (
        Number.isNaN(level) ||
        Number.isNaN(left) ||
        Number.isNaN(top) ||
        Number.isNaN(width) ||
        Number.isNaN(height) ||
        left < 0 ||
        top < 0 ||
        width < 0 ||
        height < 0
      ) {
        continue
      }

      // Update page bounds if level represents page or block
      if (width > 0 && height > 0) {
        if (left < minLeft) minLeft = left
        if (top < minTop) minTop = top
        if (left + width > maxRight) maxRight = left + width
        if (top + height > maxBottom) maxBottom = top + height
      }

      // Only Level 5 rows represent recognized words
      if (level === 5 && text.length > 0) {
        if (words.length >= this.maxWords) {
          break // Safety cap
        }

        const validConf = Number.isNaN(conf) ? 0 : Math.max(0, Math.min(100, conf))
        if (validConf > 0) {
          totalConfidence += validConf
          confidenceWordCount++
        }

        const bbox: OcrBoundingBox = { left, top, width, height }
        const word: OcrWord = {
          text,
          confidence: validConf,
          bbox,
          lineNum: Number.isNaN(lineNum) ? 0 : lineNum,
          parNum: Number.isNaN(parNum) ? 0 : parNum,
          blockNum: Number.isNaN(blockNum) ? 0 : blockNum
        }

        words.push(word)

        // Organize hierarchically
        if (!blockMap.has(blockNum)) {
          blockMap.set(blockNum, new Map())
        }
        const parMap = blockMap.get(blockNum)!
        if (!parMap.has(parNum)) {
          parMap.set(parNum, new Map())
        }
        const lineWordsMap = parMap.get(parNum)!
        if (!lineWordsMap.has(lineNum)) {
          lineWordsMap.set(lineNum, [])
        }
        lineWordsMap.get(lineNum)!.push(word)
      }
    }

    // Build hierarchical lines and paragraphs in reading order
    const paragraphs: OcrParagraph[] = []
    const allLines: OcrLine[] = []
    const paragraphTexts: string[] = []

    const sortedBlockKeys = Array.from(blockMap.keys()).sort((a, b) => a - b)
    for (const bKey of sortedBlockKeys) {
      const parMap = blockMap.get(bKey)!
      const sortedParKeys = Array.from(parMap.keys()).sort((a, b) => a - b)

      for (const pKey of sortedParKeys) {
        const lineMap = parMap.get(pKey)!
        const sortedLineKeys = Array.from(lineMap.keys()).sort((a, b) => a - b)
        const parLines: OcrLine[] = []

        for (const lKey of sortedLineKeys) {
          const lWords = lineMap.get(lKey)!
          if (lWords.length === 0) continue

          const lineText = lWords.map((w) => w.text).join(' ')
          const lineBbox = this.computeEnclosingBbox(lWords.map((w) => w.bbox))
          const ocrLine: OcrLine = {
            text: lineText,
            bbox: lineBbox,
            words: lWords,
            lineNum: lKey
          }

          parLines.push(ocrLine)
          allLines.push(ocrLine)
        }

        if (parLines.length > 0) {
          const parText = parLines.map((l) => l.text).join('\n')
          paragraphTexts.push(parText)
          paragraphs.push({
            lines: parLines,
            bbox: this.computeEnclosingBbox(parLines.map((l) => l.bbox))
          })
        }
      }
    }

    const fullText = paragraphTexts.join('\n\n')
    const avgConfidence =
      confidenceWordCount > 0
        ? Number.parseFloat((totalConfidence / confidenceWordCount).toFixed(2))
        : 0

    let warning: string | undefined
    if (words.length > 0 && avgConfidence < this.minConfidenceThreshold) {
      warning = `Low OCR recognition confidence (${avgConfidence.toFixed(1)}% < ${this.minConfidenceThreshold}% threshold). Text may contain errors.`
    }

    const pageBbox: OcrBoundingBox =
      words.length > 0
        ? this.computeEnclosingBbox(words.map((w) => w.bbox))
        : {
            left: Number.isFinite(minLeft) ? minLeft : 0,
            top: Number.isFinite(minTop) ? minTop : 0,
            width: Number.isFinite(minLeft) && maxRight > minLeft ? maxRight - minLeft : 0,
            height: Number.isFinite(minTop) && maxBottom > minTop ? maxBottom - minTop : 0
          }

    return {
      pageNumber: authenticPageNumber,
      text: fullText,
      confidence: avgConfidence,
      words,
      lines: allLines,
      paragraphs,
      bbox: pageBbox,
      isOcrDerived: true,
      language,
      engineVersion,
      renderDpi,
      warning
    }
  }

  private computeEnclosingBbox(boxes: readonly OcrBoundingBox[]): OcrBoundingBox {
    if (boxes.length === 0) {
      return { left: 0, top: 0, width: 0, height: 0 }
    }

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const b of boxes) {
      if (b.left < minX) minX = b.left
      if (b.top < minY) minY = b.top
      if (b.left + b.width > maxX) maxX = b.left + b.width
      if (b.top + b.height > maxY) maxY = b.top + b.height
    }

    return {
      left: minX,
      top: minY,
      width: maxX - minX,
      height: maxY - minY
    }
  }

  private createEmptyResult(
    pageNumber: number,
    renderDpi: number,
    language: string,
    engineVersion: string
  ): OcrPageResult {
    return {
      pageNumber,
      text: '',
      confidence: 0,
      words: [],
      lines: [],
      paragraphs: [],
      bbox: { left: 0, top: 0, width: 0, height: 0 },
      isOcrDerived: true,
      language,
      engineVersion,
      renderDpi
    }
  }
}
