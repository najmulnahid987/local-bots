import { extractTextItems } from 'unpdf'
import type { ExtractedDocumentSection } from './types'
import type {
  ExtractedDocumentBlock,
  DocumentExtractionWarning,
  ExtractionQuality
} from '../extraction/types'

export interface PdfTextItem {
  readonly str: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fontSize: number
  readonly fontFamily?: string
  readonly dir?: string
  readonly hasEOL?: boolean
}

export interface ExtractedLine {
  text: string
  left: number
  right: number
  y: number
  height: number
  fontSize: number
  fontFamily?: string
  dir?: string
  pageNumber: number
}

export interface PdfLayoutPageResult {
  readonly pageNumber: number
  readonly text: string
  readonly lines: readonly ExtractedLine[]
  readonly blocks: readonly ExtractedDocumentBlock[]
  readonly warnings: readonly DocumentExtractionWarning[]
  readonly hasMultiColumn: boolean
  readonly columnCount: number
}

export interface PdfLayoutExtractionResult {
  readonly totalPages: number
  readonly text: string
  readonly sections: readonly ExtractedDocumentSection[]
  readonly blocks: readonly ExtractedDocumentBlock[]
  readonly warnings: readonly DocumentExtractionWarning[]
  readonly quality: ExtractionQuality
  readonly hasMultiColumn: boolean
}

export interface PdfLayoutExtractorOptions {
  readonly maxPages?: number
  readonly minGutterWidth?: number
  readonly lineYThreshold?: number
  readonly headingScaleThreshold?: number
}

/**
 * Geometric, reading-order-reconstructing layout extractor for PDF pages.
 *
 * Capabilities:
 * 1. Clusters raw PDF text items into authentic horizontal lines using coordinate geometry.
 * 2. Reconstructs reading order across multi-column (2-column, 3-column) layouts.
 * 3. Handles full-width banners, titles, and headers spanning across column gutters.
 * 4. Distinguishes structural headings from body paragraphs using font-size hierarchy and styling.
 * 5. Preserves physical 1-based page boundaries and detects cross-page sentence/paragraph continuity.
 * 6. Defensively falls back to stream order with explicit warnings if spatial layout is ambiguous.
 */
export class PdfLayoutExtractor {
  /**
   * Extracts layout-aware, reading-order-reconstructed text and structured blocks from a PDF proxy.
   */
  public static async extract(
    proxy: Parameters<typeof extractTextItems>[0] & { numPages?: number },
    options?: PdfLayoutExtractorOptions
  ): Promise<PdfLayoutExtractionResult> {
    const totalPages: number = proxy.numPages ?? 1
    const maxPages = options?.maxPages ?? totalPages

    // 1. Extract text items with geometry from all pages via unpdf
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawItemData: { totalPages: number; items: any[][] }
    try {
      rawItemData = await extractTextItems(proxy)
    } catch {
      rawItemData = { totalPages, items: [] }
    }

    const pagesItems: PdfTextItem[][] = rawItemData.items ?? []
    const pagesCountToProcess = Math.min(totalPages, maxPages)

    const pageResults: PdfLayoutPageResult[] = []
    const allWarnings: DocumentExtractionWarning[] = []

    // 2. Process each page's spatial geometry
    for (let i = 0; i < pagesCountToProcess; i++) {
      const pageNum = i + 1
      const items = (pagesItems[i] ?? []) as PdfTextItem[]
      const pageRes = this.processPage(pageNum, items, options)
      pageResults.push(pageRes)
      allWarnings.push(...pageRes.warnings)
    }

    // 3. Assemble document-level blocks with page boundaries and cross-page continuity
    const finalBlocks: ExtractedDocumentBlock[] = []
    const finalSections: ExtractedDocumentSection[] = []
    const pageTexts: string[] = []

    let anyMultiColumn = false

    for (let pIdx = 0; pIdx < pageResults.length; pIdx++) {
      const pageRes = pageResults[pIdx]
      const pageNum = pageRes.pageNumber
      if (pageRes.hasMultiColumn) {
        anyMultiColumn = true
      }

      // Add physical page boundary block between pages (pages 2+)
      if (pIdx > 0) {
        finalBlocks.push({
          type: 'page_break',
          text: `--- Page ${pageNum} ---`,
          pageNumber: pageNum
        })
      }

      // Check cross-page continuity with previous page
      if (pIdx > 0) {
        const prevPage = pageResults[pIdx - 1]
        this.linkCrossPageContinuity(prevPage, pageRes, allWarnings)
      }

      // Add page blocks
      finalBlocks.push(...pageRes.blocks)

      // Section for legacy compatibility
      finalSections.push({
        text: pageRes.text,
        pageNumber: pageNum
      })

      pageTexts.push(pageRes.text)
    }

    const fullText = pageTexts.join('\n\n')

    return {
      totalPages,
      text: fullText,
      sections: finalSections,
      blocks: finalBlocks,
      warnings: allWarnings,
      quality: {
        fidelity: 'medium',
        isLossy: true,
        isOcr: false
      },
      hasMultiColumn: anyMultiColumn
    }
  }

  /**
   * Processes a single PDF page into reading-order lines, headings, and paragraphs.
   */
  public static processPage(
    pageNumber: number,
    items: readonly PdfTextItem[],
    options?: PdfLayoutExtractorOptions
  ): PdfLayoutPageResult {
    // 1. Filter out empty or whitespace-only items (PDF.js synthesizes wide space items across gutters)
    const nonEmpties = items.filter(
      (it) => it && typeof it.str === 'string' && it.str.trim().length > 0
    )

    if (nonEmpties.length === 0) {
      return {
        pageNumber,
        text: '',
        lines: [],
        blocks: [],
        warnings: [],
        hasMultiColumn: false,
        columnCount: 1
      }
    }

    // 2. Check if spatial coordinates are present
    const hasCoordinates = nonEmpties.some((it) => it.x !== 0 || it.y !== 0 || it.width !== 0)
    if (!hasCoordinates) {
      // Fallback to stream concatenation
      const streamText = nonEmpties.map((it) => it.str).join(' ')
      return {
        pageNumber,
        text: streamText,
        lines: [],
        blocks: [
          {
            type: 'paragraph',
            text: streamText,
            pageNumber
          }
        ],
        warnings: [
          {
            code: 'LAYOUT_AMBIGUITY_STREAM_FALLBACK',
            message: `Page ${pageNumber}: Spatial coordinates absent; fell back to stream reading order.`
          }
        ],
        hasMultiColumn: false,
        columnCount: 1
      }
    }

    // 3. Cluster items into horizontal lines
    const lines = this.clusterItemsIntoLines(nonEmpties, pageNumber, options)

    if (lines.length === 0) {
      return {
        pageNumber,
        text: '',
        lines: [],
        blocks: [],
        warnings: [],
        hasMultiColumn: false,
        columnCount: 1
      }
    }

    // 4. Calculate content bounds & median font size
    const fontSizes = lines.map((l) => l.fontSize).filter((s) => s > 0)
    fontSizes.sort((a, b) => a - b)
    const medianFontSize = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length / 2)] : 12

    // 5. Detect multi-column layout and reconstruct reading order
    const { orderedLines, hasMultiColumn, columnCount, warnings } = this.reconstructReadingOrder(
      lines,
      pageNumber,
      options
    )

    // 6. Form headings and paragraphs from ordered lines
    const blocks = this.formBlocksFromLines(orderedLines, pageNumber, medianFontSize, options)

    // 7. Compose page text from blocks
    const pageText = blocks
      .filter((b) => b.type === 'heading' || b.type === 'paragraph')
      .map((b) => b.text)
      .join('\n\n')

    return {
      pageNumber,
      text: pageText,
      lines: orderedLines,
      blocks,
      warnings,
      hasMultiColumn,
      columnCount
    }
  }

  /**
   * Clusters raw text items into horizontal lines based on y-coordinate proximity.
   */
  private static clusterItemsIntoLines(
    items: readonly PdfTextItem[],
    pageNumber: number,
    options?: PdfLayoutExtractorOptions
  ): ExtractedLine[] {
    // Sort items by y descending (top of page to bottom), then by x ascending
    const sorted = [...items].sort((a, b) => {
      const yDiff = b.y - a.y
      if (Math.abs(yDiff) > 1.0) {
        return yDiff
      }
      return a.x - b.x
    })

    const lineBuckets: PdfTextItem[][] = []

    for (const item of sorted) {
      // Find matching line bucket
      let matchedBucket: PdfTextItem[] | null = null
      for (const bucket of lineBuckets) {
        const bucketY = bucket[0].y
        const yTolerance = Math.max(
          options?.lineYThreshold ?? 2.5,
          Math.min(item.fontSize || 12, bucket[0].fontSize || 12) * 0.35
        )
        if (Math.abs(item.y - bucketY) <= yTolerance) {
          matchedBucket = bucket
          break
        }
      }

      if (matchedBucket) {
        matchedBucket.push(item)
      } else {
        lineBuckets.push([item])
      }
    }

    // Assemble line text and bounds for each bucket (handling column gutter splits)
    const lines: ExtractedLine[] = []

    for (const bucket of lineBuckets) {
      // Sort items left-to-right within line
      bucket.sort((a, b) => a.x - b.x)

      // Check for horizontal gutter gaps within the same y bucket (multi-column lines at same y)
      const subBuckets: PdfTextItem[][] = []
      let currentSubBucket: PdfTextItem[] = []

      for (let idx = 0; idx < bucket.length; idx++) {
        const it = bucket[idx]
        if (currentSubBucket.length > 0) {
          const prevIt = currentSubBucket[currentSubBucket.length - 1]
          const prevRight = prevIt.x + (prevIt.width || 0)
          const gap = it.x - prevRight
          const gutterThreshold = Math.max(16, (it.fontSize || 12) * 1.3)
          if (gap >= gutterThreshold) {
            subBuckets.push(currentSubBucket)
            currentSubBucket = []
          }
        }
        currentSubBucket.push(it)
      }
      if (currentSubBucket.length > 0) {
        subBuckets.push(currentSubBucket)
      }

      for (const sub of subBuckets) {
        let assembledText = ''
        let prevRight: number | null = null
        let minLeft = Infinity
        let maxRight = -Infinity
        let maxFontSize = 0
        let representativeY = 0

        for (let idx = 0; idx < sub.length; idx++) {
          const it = sub[idx]
          const itLeft = it.x
          const itRight = it.x + (it.width || 0)

          minLeft = Math.min(minLeft, itLeft)
          maxRight = Math.max(maxRight, itRight)
          maxFontSize = Math.max(maxFontSize, it.fontSize || 12)
          representativeY = it.y

          if (prevRight !== null) {
            const gap = itLeft - prevRight
            const spaceThreshold = (it.fontSize || 12) * 0.22
            // If there is an authentic gap between words, add a space if not already present
            if (
              gap > spaceThreshold &&
              !assembledText.endsWith(' ') &&
              !it.str.startsWith(' ') &&
              !/^[.,!?:;)\]}]/.test(it.str)
            ) {
              assembledText += ' '
            }
          }

          assembledText += it.str
          prevRight = itRight
        }

        const trimmedText = assembledText.trim()
        if (trimmedText.length > 0) {
          lines.push({
            text: trimmedText,
            left: minLeft,
            right: maxRight,
            y: representativeY,
            height: maxFontSize,
            fontSize: maxFontSize,
            fontFamily: sub[0].fontFamily,
            dir: sub[0].dir,
            pageNumber
          })
        }
      }
    }

    // Sort lines by y descending
    lines.sort((a, b) => b.y - a.y)
    return lines
  }

  /**
   * Reconstructs the authentic reading order of lines on a page.
   * Detects multi-column regions and orders columns left-to-right (or RTL).
   */
  private static reconstructReadingOrder(
    lines: readonly ExtractedLine[],
    _pageNumber: number,
    options?: PdfLayoutExtractorOptions
  ): {
    orderedLines: ExtractedLine[]
    hasMultiColumn: boolean
    columnCount: number
    warnings: DocumentExtractionWarning[]
  } {
    if (lines.length <= 1) {
      return {
        orderedLines: [...lines],
        hasMultiColumn: false,
        columnCount: 1,
        warnings: []
      }
    }

    const warnings: DocumentExtractionWarning[] = []

    // 1. Detect side-by-side line pairs
    // Two lines are side-by-side if their y-ranges overlap significantly and they have a distinct horizontal gap
    interface SideBySidePair {
      leftLine: ExtractedLine
      rightLine: ExtractedLine
      gutterLeft: number
      gutterRight: number
      gutterCenter: number
    }

    const sideBySidePairs: SideBySidePair[] = []

    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const l1 = lines[i]
        const l2 = lines[j]

        const yOverlap = Math.abs(l1.y - l2.y) <= Math.max(l1.height, l2.height) * 1.5
        if (yOverlap) {
          if (l1.right < l2.left && l2.left - l1.right >= (options?.minGutterWidth ?? 12)) {
            sideBySidePairs.push({
              leftLine: l1,
              rightLine: l2,
              gutterLeft: l1.right,
              gutterRight: l2.left,
              gutterCenter: (l1.right + l2.left) / 2
            })
          } else if (l2.right < l1.left && l1.left - l2.right >= (options?.minGutterWidth ?? 12)) {
            sideBySidePairs.push({
              leftLine: l2,
              rightLine: l1,
              gutterLeft: l2.right,
              gutterRight: l1.left,
              gutterCenter: (l2.right + l1.left) / 2
            })
          }
        }
      }
    }

    // If no side-by-side lines, it is a single-column layout
    if (sideBySidePairs.length === 0) {
      return {
        orderedLines: [...lines],
        hasMultiColumn: false,
        columnCount: 1,
        warnings
      }
    }

    // 2. Cluster gutters to find column boundary (or boundaries)
    // For 2-column documents, all gutters cluster around a single split point X_split
    const gutterCenters = sideBySidePairs.map((p) => p.gutterCenter)
    gutterCenters.sort((a, b) => a - b)
    const medianGutter = gutterCenters[Math.floor(gutterCenters.length / 2)]

    // Determine content width
    const minContentX = Math.min(...lines.map((l) => l.left))
    const maxContentX = Math.max(...lines.map((l) => l.right))
    const contentWidth = maxContentX - minContentX

    // Check if there are two distinct gutters (3-column layout)
    const lowerGutters = gutterCenters.filter((g) => g < medianGutter - 40)
    const upperGutters = gutterCenters.filter((g) => g > medianGutter + 40)
    const isThreeColumn = lowerGutters.length >= 2 && upperGutters.length >= 2

    const columnCount = isThreeColumn ? 3 : 2

    // 3. Segment the page into vertical bands from top to bottom
    // Spanning elements (titles, banners) cross the gutter and span across columns
    const isSpanningLine = (l: ExtractedLine): boolean => {
      const lineWidth = l.right - l.left
      if (lineWidth >= contentWidth * 0.75) {
        return true
      }
      if (isThreeColumn) {
        const lowerMed = lowerGutters[Math.floor(lowerGutters.length / 2)]
        const upperMed = upperGutters[Math.floor(upperGutters.length / 2)]
        return (
          (l.left < lowerMed && l.right > lowerMed) || (l.left < upperMed && l.right > upperMed)
        )
      }
      // Crosses median gutter
      return l.left < medianGutter - 15 && l.right > medianGutter + 15
    }

    // Group lines into vertical bands
    type Band =
      | { type: 'full_width'; lines: ExtractedLine[] }
      | { type: 'multi_column'; lines: ExtractedLine[] }

    const bands: Band[] = []
    let currentBand: Band | null = null

    for (const line of lines) {
      const spanning = isSpanningLine(line)
      const bandType = spanning ? 'full_width' : 'multi_column'

      if (!currentBand || currentBand.type !== bandType) {
        const newBand: Band = { type: bandType, lines: [line] }
        currentBand = newBand
        bands.push(newBand)
      } else {
        currentBand.lines.push(line)
      }
    }

    // 4. Order lines within each band
    const resultLines: ExtractedLine[] = []

    for (const band of bands) {
      if (band.type === 'full_width') {
        // Single column: simply sort by y descending
        band.lines.sort((a, b) => b.y - a.y)
        resultLines.push(...band.lines)
      } else {
        // Multi-column: partition into columns and order columns
        if (columnCount === 2) {
          const col1: ExtractedLine[] = []
          const col2: ExtractedLine[] = []

          for (const l of band.lines) {
            const center = (l.left + l.right) / 2
            if (center < medianGutter) {
              col1.push(l)
            } else {
              col2.push(l)
            }
          }

          col1.sort((a, b) => b.y - a.y)
          col2.sort((a, b) => b.y - a.y)

          // Reading order: Col 1 top-to-bottom, then Col 2 top-to-bottom
          const isRtl = band.lines.some((l) => l.dir === 'rtl')
          if (isRtl) {
            resultLines.push(...col2, ...col1)
          } else {
            resultLines.push(...col1, ...col2)
          }
        } else {
          // 3-column
          const lowerMed = lowerGutters[Math.floor(lowerGutters.length / 2)]
          const upperMed = upperGutters[Math.floor(upperGutters.length / 2)]

          const col1: ExtractedLine[] = []
          const col2: ExtractedLine[] = []
          const col3: ExtractedLine[] = []

          for (const l of band.lines) {
            const center = (l.left + l.right) / 2
            if (center < lowerMed) {
              col1.push(l)
            } else if (center < upperMed) {
              col2.push(l)
            } else {
              col3.push(l)
            }
          }

          col1.sort((a, b) => b.y - a.y)
          col2.sort((a, b) => b.y - a.y)
          col3.sort((a, b) => b.y - a.y)

          const isRtl = band.lines.some((l) => l.dir === 'rtl')
          if (isRtl) {
            resultLines.push(...col3, ...col2, ...col1)
          } else {
            resultLines.push(...col1, ...col2, ...col3)
          }
        }
      }
    }

    return {
      orderedLines: resultLines,
      hasMultiColumn: true,
      columnCount,
      warnings
    }
  }

  /**
   * Groups ordered lines into structural heading and paragraph blocks.
   */
  private static formBlocksFromLines(
    lines: readonly ExtractedLine[],
    pageNumber: number,
    medianFontSize: number,
    options?: PdfLayoutExtractorOptions
  ): ExtractedDocumentBlock[] {
    const blocks: ExtractedDocumentBlock[] = []
    let currentParagraphLines: ExtractedLine[] = []

    const flushParagraph = (): void => {
      if (currentParagraphLines.length === 0) return

      // Join lines handling hyphenation
      let text = ''
      for (let i = 0; i < currentParagraphLines.length; i++) {
        const l = currentParagraphLines[i]
        if (i === 0) {
          text = l.text
        } else {
          const prev = currentParagraphLines[i - 1].text
          if (prev.endsWith('-') && /^[a-z]/i.test(l.text)) {
            // Soft hyphen join (e.g. "experi-" + "ment" -> "experiment")
            text = text.slice(0, -1) + l.text
          } else {
            text += ' ' + l.text
          }
        }
      }

      blocks.push({
        type: 'paragraph',
        text,
        pageNumber,
        metadata: {
          lineCount: currentParagraphLines.length
        }
      })
      currentParagraphLines = []
    }

    const headingThreshold = options?.headingScaleThreshold ?? 1.25

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]
      const isLargeFont = line.fontSize >= medianFontSize * headingThreshold
      const isShortLine = line.text.length < 90 && !/[.!?।]$/.test(line.text)

      // Heading criteria: noticeably larger font size and relatively short line
      if (isLargeFont && isShortLine) {
        flushParagraph()

        let level = 3
        if (line.fontSize >= medianFontSize * 1.6) {
          level = 1
        } else if (line.fontSize >= medianFontSize * 1.3) {
          level = 2
        }

        blocks.push({
          type: 'heading',
          text: line.text,
          pageNumber,
          heading: {
            level,
            headingPath: [line.text]
          }
        })
      } else {
        // Body line: check if vertical gap suggests a new paragraph
        if (currentParagraphLines.length > 0) {
          const prevLine = currentParagraphLines[currentParagraphLines.length - 1]
          const verticalDrop = prevLine.y - line.y
          const isLargeGap = verticalDrop > medianFontSize * 2.0
          const prevEndsSentence = /[.!?।]$/.test(prevLine.text)

          if (isLargeGap || (prevEndsSentence && verticalDrop > medianFontSize * 1.5)) {
            flushParagraph()
          }
        }
        currentParagraphLines.push(line)
      }
    }

    flushParagraph()
    return blocks
  }

  /**
   * Links sentences and paragraphs that continue across physical page boundaries.
   */
  private static linkCrossPageContinuity(
    prevPage: PdfLayoutPageResult,
    currPage: PdfLayoutPageResult,
    warnings: DocumentExtractionWarning[]
  ): void {
    if (prevPage.blocks.length === 0 || currPage.blocks.length === 0) return

    // Find last paragraph of previous page
    let lastPrevParagraph: ExtractedDocumentBlock | null = null
    for (let i = prevPage.blocks.length - 1; i >= 0; i--) {
      if (prevPage.blocks[i].type === 'paragraph') {
        lastPrevParagraph = prevPage.blocks[i]
        break
      }
    }

    // Find first paragraph of current page
    let firstCurrParagraph: ExtractedDocumentBlock | null = null
    for (let i = 0; i < currPage.blocks.length; i++) {
      if (currPage.blocks[i].type === 'paragraph') {
        firstCurrParagraph = currPage.blocks[i]
        break
      }
    }

    if (!lastPrevParagraph || !firstCurrParagraph) return

    const prevText = lastPrevParagraph.text.trim()
    const currText = firstCurrParagraph.text.trim()

    if (prevText.length === 0 || currText.length === 0) return

    // Criteria for cross-page continuation:
    // 1. Previous page ends without terminal punctuation, or ends with hyphen/comma
    const endsWithTerminal = /[.!?।:;]$/.test(prevText)
    const endsWithHyphenOrComma = /[-,\u2014]$/.test(prevText)
    const unclosedSentence = !endsWithTerminal || endsWithHyphenOrComma

    // 2. Current page starts with a lowercase character or continuation word
    const startsWithLowercase = /^[a-z\u0980-\u09ff]/.test(currText) && !/^[A-Z]/.test(currText)

    if (unclosedSentence && (startsWithLowercase || endsWithHyphenOrComma)) {
      // Annotate blocks with continuity metadata
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prevBlock = lastPrevParagraph as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currBlock = firstCurrParagraph as any

      prevBlock.metadata = {
        ...(prevBlock.metadata ?? {}),
        continuesOnNextPage: true,
        targetPageNumber: currPage.pageNumber
      }

      currBlock.metadata = {
        ...(currBlock.metadata ?? {}),
        continuedFromPreviousPage: true,
        sourcePageNumber: prevPage.pageNumber
      }

      warnings.push({
        code: 'CROSS_PAGE_CONTINUITY',
        message: `Sentence/paragraph from page ${prevPage.pageNumber} continues onto page ${currPage.pageNumber}.`
      })
    }
  }
}
