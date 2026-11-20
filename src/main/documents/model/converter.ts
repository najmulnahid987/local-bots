import { randomUUID } from 'node:crypto'
import type {
  UniversalDocument,
  UniversalDocumentBlock,
  UniversalHeadingBlock,
  UniversalParagraphBlock,
  UniversalListBlock,
  UniversalTableBlock,
  UniversalCodeBlock,
  UniversalPageBoundaryBlock,
  UniversalSheetBoundaryBlock,
  UniversalSlideBoundaryBlock,
  UniversalImageReferenceBlock,
  UniversalUnknownBlock,
  UniversalSourceLocation,
  UniversalTableCell,
  UniversalListItem
} from './types'
import type {
  DocumentExtractionResult,
  ExtractedDocumentBlock,
  ExtractorMetadata
} from '../extraction/types'
import type {
  DocumentFormat,
  ExtractedDocument,
  ExtractedDocumentSection
} from '../extractors/types'

export interface ExtractionResultToUniversalDocumentOptions {
  readonly documentId?: string
  readonly sourceId?: string
  readonly knowledgeBaseId?: string
  readonly originalFileName?: string
  readonly mimeType?: string
  readonly extractedAt?: number
}

/**
 * Converts a modern DocumentExtractionResult into a canonical UniversalDocument.
 *
 * Information Preservation Guarantees:
 * 1. ZERO flattening of tables, lists, code, or coordinates.
 * 2. Preserves all block structures, headers, cells, and nested items verbatim.
 * 3. Assigns deterministic orderIndex and stable block IDs.
 * 4. Carries all warnings, fidelity quality classifications, and extractor metadata.
 */
export function documentExtractionResultToUniversalDocument(
  result: DocumentExtractionResult,
  options?: ExtractionResultToUniversalDocumentOptions
): UniversalDocument {
  const documentId = options?.documentId ?? randomUUID()
  const blocks: UniversalDocumentBlock[] = []

  let currentPageNumber: number | undefined = undefined
  let currentSheetName: string | undefined = undefined
  let currentSheetIndex: number | undefined = undefined
  let currentSlideNumber: number | undefined = undefined

  for (let idx = 0; idx < result.blocks.length; idx++) {
    const rawBlock = result.blocks[idx]
    const blockId = `blk-${idx + 1}`

    // Update boundary state trackers
    if (rawBlock.pageNumber !== undefined) {
      currentPageNumber = rawBlock.pageNumber
    }
    if (rawBlock.type === 'sheet_boundary' && rawBlock.sheet) {
      currentSheetName = rawBlock.sheet.name
      currentSheetIndex = rawBlock.sheet.index
    }
    if (rawBlock.type === 'slide_boundary' && rawBlock.slide) {
      currentSlideNumber = rawBlock.slide.number
    }

    // Construct authentic source location
    const location: UniversalSourceLocation = {
      ...(rawBlock.lineStart !== undefined ? { lineStart: rawBlock.lineStart } : {}),
      ...(rawBlock.lineEnd !== undefined ? { lineEnd: rawBlock.lineEnd } : {}),
      ...(rawBlock.pageNumber !== undefined || currentPageNumber !== undefined
        ? { pageNumber: rawBlock.pageNumber ?? currentPageNumber }
        : {}),
      ...(rawBlock.sheet || currentSheetName
        ? {
            sheetName: rawBlock.sheet?.name ?? currentSheetName,
            sheetIndex: rawBlock.sheet?.index ?? currentSheetIndex
          }
        : {}),
      ...(rawBlock.slide || currentSlideNumber
        ? {
            slideNumber: rawBlock.slide?.number ?? currentSlideNumber,
            slideTitle: rawBlock.slide?.title
          }
        : {}),
      ...(rawBlock.metadata?.paragraphIndex !== undefined
        ? { paragraphIndex: rawBlock.metadata.paragraphIndex as number }
        : {}),
      ...(rawBlock.metadata?.headingContext !== undefined
        ? { headingContext: String(rawBlock.metadata.headingContext) }
        : {})
    }

    const hasLocation = Object.keys(location).length > 0

    // Discriminant block mapping
    if (rawBlock.type === 'heading') {
      const headingBlock: UniversalHeadingBlock = {
        id: blockId,
        type: 'heading',
        orderIndex: idx,
        text: rawBlock.text,
        level: rawBlock.heading?.level ?? 1,
        headingPath: rawBlock.heading?.headingPath
          ? [...rawBlock.heading.headingPath]
          : [rawBlock.text],
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(headingBlock)
    } else if (rawBlock.type === 'table') {
      const rawHeaders = rawBlock.table?.headers ?? []
      const rawRows = rawBlock.table?.rows ?? []
      const isSpreadsheet =
        rawBlock.metadata?.isSpreadsheet === true || rawBlock.metadata?.sheetName !== undefined

      // Construct rich cells if available or map from rows
      let cells: UniversalTableCell[][] = []
      if (Array.isArray(rawBlock.metadata?.cells)) {
        cells = (rawBlock.metadata.cells as UniversalTableCell[][]).map((row) =>
          row.map((c) => ({ ...c }))
        )
      } else {
        for (let r = 0; r < rawRows.length; r++) {
          const rowCells: UniversalTableCell[] = []
          for (let c = 0; c < rawRows[r].length; c++) {
            rowCells.push({
              value: rawRows[r][c] ?? '',
              rowIndex: r,
              columnIndex: c
            })
          }
          cells.push(rowCells)
        }
      }

      const tableBlock: UniversalTableBlock = {
        id: blockId,
        type: 'table',
        orderIndex: idx,
        text: rawBlock.text,
        caption: rawBlock.table?.caption,
        headers: [...rawHeaders],
        rows: rawRows.map((r) => [...r]),
        cells,
        rowCount: rawRows.length,
        columnCount: rawHeaders.length > 0 ? rawHeaders.length : (rawRows[0]?.length ?? 0),
        isSpreadsheet,
        sheetName: rawBlock.sheet?.name ?? currentSheetName,
        sheetIndex: rawBlock.sheet?.index ?? currentSheetIndex,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(tableBlock)
    } else if (rawBlock.type === 'list') {
      const rawItems = rawBlock.list?.items ?? []
      const items: UniversalListItem[] = rawBlock.list?.itemDetails
        ? rawBlock.list.itemDetails.map((it, itemIdx) => ({
            text: it.text,
            depth: it.depth ?? 0,
            orderIndex: itemIdx,
            ...(it.itemNumber !== undefined ? { itemNumber: it.itemNumber } : {}),
            ...(it.checked !== undefined ? { checked: it.checked } : {}),
            ...(it.lineStart !== undefined
              ? {
                  location: {
                    lineStart: it.lineStart,
                    lineEnd: it.lineEnd ?? it.lineStart
                  }
                }
              : {})
          }))
        : rawItems.map((itemText, itemIdx) => ({
            text: itemText,
            depth: 0,
            orderIndex: itemIdx,
            itemNumber: rawBlock.list?.ordered ? itemIdx + 1 : undefined
          }))

      const listBlock: UniversalListBlock = {
        id: blockId,
        type: 'list',
        orderIndex: idx,
        text: rawBlock.text,
        ordered: rawBlock.list?.ordered ?? false,
        items,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(listBlock)
    } else if (rawBlock.type === 'code') {
      // Verbatim code body without destructive trimming of leading/trailing indentation
      let codeBody = rawBlock.code?.code
      if (codeBody === undefined) {
        codeBody = rawBlock.text
          .replace(/^[ ]{0,3}(?:`{3,}|~{3,})[^\n]*\n?/, '')
          .replace(/\n?[ ]{0,3}(?:`{3,}|~{3,})[ \t]*$/, '')
      }

      const codeBlock: UniversalCodeBlock = {
        id: blockId,
        type: 'code',
        orderIndex: idx,
        text: rawBlock.text,
        code: codeBody,
        language: rawBlock.code?.language,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(codeBlock)
    } else if (rawBlock.type === 'page_break' || (rawBlock.type as string) === 'page_boundary') {
      const pageBlock: UniversalPageBoundaryBlock = {
        id: blockId,
        type: 'page_boundary',
        orderIndex: idx,
        text: rawBlock.text || `--- Page ${rawBlock.pageNumber ?? 1} ---`,
        pageNumber: rawBlock.pageNumber ?? (currentPageNumber || 1),
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(pageBlock)
    } else if (rawBlock.type === 'sheet_boundary') {
      const sheetBlock: UniversalSheetBoundaryBlock = {
        id: blockId,
        type: 'sheet_boundary',
        orderIndex: idx,
        text: rawBlock.text,
        sheetName: rawBlock.sheet?.name ?? currentSheetName ?? 'Sheet1',
        sheetIndex: rawBlock.sheet?.index ?? currentSheetIndex ?? 1,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(sheetBlock)
    } else if (rawBlock.type === 'slide_boundary') {
      const slideBlock: UniversalSlideBoundaryBlock = {
        id: blockId,
        type: 'slide_boundary',
        orderIndex: idx,
        text: rawBlock.text,
        slideNumber: rawBlock.slide?.number ?? currentSlideNumber ?? 1,
        slideTitle: rawBlock.slide?.title,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(slideBlock)
    } else if ((rawBlock.type as string) === 'image_reference') {
      const imgRef = rawBlock.imageReference
      const imgBlock: UniversalImageReferenceBlock = {
        id: blockId,
        type: 'image_reference',
        orderIndex: idx,
        text: rawBlock.text,
        elementType:
          imgRef?.elementType ??
          (rawBlock.metadata?.elementType as UniversalImageReferenceBlock['elementType']) ??
          'image',
        referenceId:
          imgRef?.referenceId ??
          (rawBlock.metadata?.referenceId as string) ??
          (rawBlock.metadata?.url as string),
        altText: imgRef?.altText ?? (rawBlock.metadata?.altText as string),
        caption: imgRef?.caption ?? (rawBlock.metadata?.caption as string),
        extractionStatus:
          imgRef?.extractionStatus ??
          (rawBlock.metadata
            ?.extractionStatus as UniversalImageReferenceBlock['extractionStatus']) ??
          'skipped',
        warning:
          imgRef?.warning ??
          (rawBlock.metadata?.warning as string) ??
          'Image skipped during text extraction',
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(imgBlock)
    } else if (rawBlock.type === 'paragraph') {
      const isQuote = rawBlock.isQuote ?? rawBlock.metadata?.isQuote === true
      const paraBlock: UniversalParagraphBlock = {
        id: blockId,
        type: 'paragraph',
        orderIndex: idx,
        text: rawBlock.text,
        ...(isQuote ? { isQuote: true } : {}),
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(paraBlock)
    } else {
      const unknownBlock: UniversalUnknownBlock = {
        id: blockId,
        type: 'unknown',
        orderIndex: idx,
        text: rawBlock.text,
        originalType: String(rawBlock.type),
        rawContent: rawBlock,
        warning: `Unknown raw block type encountered: '${String(rawBlock.type)}'`,
        ...(hasLocation ? { location } : {}),
        ...(rawBlock.metadata ? { metadata: rawBlock.metadata } : {})
      }
      blocks.push(unknownBlock)
    }
  }

  // Calculate document-level metrics
  const fullText = result.text || blocks.map((b) => b.text).join('\n\n')
  const lineCount = fullText.split('\n').length
  const wordCount = fullText.trim().length > 0 ? fullText.trim().split(/\s+/).length : 0

  return {
    id: documentId,
    sourceId: options?.sourceId,
    knowledgeBaseId: options?.knowledgeBaseId,
    format: result.format,
    originalFileName: options?.originalFileName,
    mimeType: options?.mimeType,
    extractor: {
      id: result.extractor?.id ?? 'default-extractor',
      name: result.extractor?.name ?? 'Document Extractor',
      version: result.extractor?.version ?? '1.0.0'
    },
    extractedAt: options?.extractedAt ?? Date.now(),
    text: fullText,
    blocks,
    metadata: { ...result.metadata },
    warnings: result.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.details !== undefined ? { details: w.details } : {})
    })),
    quality: {
      fidelity: result.quality?.fidelity ?? 'high',
      isLossy: result.quality?.isLossy ?? false,
      isOcr: result.quality?.isOcr ?? false,
      ...(result.quality?.confidence !== undefined ? { confidence: result.quality.confidence } : {})
    },
    sourceInfo: {
      characterCount: fullText.length,
      lineCount,
      wordCount,
      ...(currentPageNumber !== undefined ? { pageCount: currentPageNumber } : {}),
      ...(currentSheetIndex !== undefined ? { sheetCount: currentSheetIndex } : {}),
      ...(currentSlideNumber !== undefined ? { slideCount: currentSlideNumber } : {})
    }
  }
}

/**
 * Converts a canonical UniversalDocument into a DocumentExtractionResult
 * for interoperability with modular extractors and test contracts.
 */
export function universalDocumentToExtractionResult(
  doc: UniversalDocument
): DocumentExtractionResult {
  const blocks: ExtractedDocumentBlock[] = doc.blocks.map((b) => {
    switch (b.type) {
      case 'heading':
        return {
          type: 'heading',
          text: b.text,
          heading: {
            level: b.level,
            headingPath: [...b.headingPath]
          },
          pageNumber: b.location?.pageNumber,
          lineStart: b.location?.lineStart,
          lineEnd: b.location?.lineEnd,
          metadata: b.metadata
        }
      case 'paragraph':
        return {
          type: 'paragraph',
          text: b.text,
          pageNumber: b.location?.pageNumber,
          lineStart: b.location?.lineStart,
          lineEnd: b.location?.lineEnd,
          metadata: b.metadata
        }
      case 'table':
        return {
          type: 'table',
          text: b.text,
          table: {
            headers: [...b.headers],
            rows: b.rows.map((r) => [...r]),
            caption: b.caption
          },
          pageNumber: b.location?.pageNumber,
          metadata: b.metadata
        }
      case 'list':
        return {
          type: 'list',
          text: b.text,
          list: {
            items: b.items.map((i) => i.text),
            ordered: b.ordered
          },
          pageNumber: b.location?.pageNumber,
          metadata: b.metadata
        }
      case 'code':
        return {
          type: 'code',
          text: b.text,
          code: {
            language: b.language
          },
          lineStart: b.location?.lineStart,
          lineEnd: b.location?.lineEnd,
          metadata: b.metadata
        }
      case 'page_boundary':
        return {
          type: 'page_break',
          text: b.text,
          pageNumber: b.pageNumber,
          metadata: b.metadata
        }
      case 'sheet_boundary':
        return {
          type: 'sheet_boundary',
          text: b.text,
          sheet: {
            name: b.sheetName,
            index: b.sheetIndex
          },
          metadata: b.metadata
        }
      case 'slide_boundary':
        return {
          type: 'slide_boundary',
          text: b.text,
          slide: {
            number: b.slideNumber,
            title: b.slideTitle
          },
          pageNumber: b.slideNumber,
          metadata: b.metadata
        }
      case 'image_reference':
      case 'unknown':
      default:
        return {
          type: 'paragraph',
          text: b.text,
          pageNumber: b.location?.pageNumber,
          metadata: b.metadata
        }
    }
  })

  return {
    format: doc.format,
    text: doc.text,
    blocks,
    metadata: { ...doc.metadata },
    warnings: doc.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.details !== undefined ? { details: w.details } : {})
    })),
    quality: {
      fidelity: doc.quality.fidelity,
      isLossy: doc.quality.isLossy,
      isOcr: doc.quality.isOcr,
      ...(doc.quality.confidence !== undefined ? { confidence: doc.quality.confidence } : {})
    },
    extractor: {
      id: doc.extractor.id,
      name: doc.extractor.name,
      version: doc.extractor.version,
      supportedFormats: [doc.format]
    }
  }
}

/**
 * Converts a UniversalDocument into a legacy ExtractedDocument.
 *
 * @deprecated Lossy compatibility adapter for existing legacy chunkers (SemanticChunker).
 * WARNING: This conversion flattens tables, lists, and code blocks into newline-delimited text.
 * Do not use for canonical representation. Use UniversalDocument directly.
 */
export function universalDocumentToLegacy(doc: UniversalDocument): ExtractedDocument {
  const sections: ExtractedDocumentSection[] = []

  let currentHeading: string | undefined = undefined
  let currentHeadingLevel: number | undefined = undefined
  let currentHeadingPath: readonly string[] | undefined = undefined
  let currentLines: string[] = []
  let sectionLineStart = 1
  let currentLineTracker = 1
  let currentPageNumber: number | undefined = undefined

  const flushSection = (): void => {
    if (currentLines.length > 0 || currentHeading !== undefined) {
      sections.push({
        text: currentLines.join('\n'),
        heading: currentHeading,
        headingLevel: currentHeadingLevel,
        headingPath: currentHeadingPath,
        lineStart: sectionLineStart,
        lineEnd: Math.max(sectionLineStart, currentLineTracker - 1),
        pageNumber: currentPageNumber
      })
      currentLines = []
      currentHeading = undefined
      currentHeadingLevel = undefined
      currentHeadingPath = undefined
      sectionLineStart = currentLineTracker
    }
  }

  for (const block of doc.blocks) {
    if (
      block.type !== 'slide_boundary' &&
      block.type !== 'page_boundary' &&
      block.type !== 'sheet_boundary' &&
      block.location?.pageNumber !== undefined &&
      block.location.pageNumber !== currentPageNumber
    ) {
      if (currentPageNumber !== undefined) {
        flushSection()
      }
      currentPageNumber = block.location.pageNumber
    }

    if (block.type === 'page_boundary') {
      if (currentPageNumber !== undefined) {
        flushSection()
      }
      currentPageNumber = block.pageNumber
      continue
    }

    if (block.type === 'sheet_boundary') {
      flushSection()
      currentHeading = `Sheet: ${block.sheetName}`
      currentHeadingLevel = 1
      currentHeadingPath = [`Sheet: ${block.sheetName}`]
      currentLines = []
      continue
    }

    if (block.type === 'slide_boundary') {
      flushSection()
      const titleSuffix = block.slideTitle ? `: ${block.slideTitle}` : ''
      currentHeading = `Slide ${block.slideNumber}${titleSuffix}`
      currentHeadingLevel = 1
      currentHeadingPath = [currentHeading]
      currentPageNumber = block.slideNumber
      currentLines = []
      continue
    }

    if (block.type === 'heading') {
      if (block.metadata?.isSlideTitle) {
        // Slide title is already captured by slide_boundary heading in legacy presentation chunking
        continue
      }
      flushSection()
      currentHeading = block.text
      currentHeadingLevel = block.level
      currentHeadingPath = block.headingPath
      currentLines = []
    } else {
      currentLines.push(block.text)
    }

    const blockLines = block.text.split('\n').length
    currentLineTracker += blockLines
  }

  flushSection()

  if (sections.length === 0 && doc.text.length > 0) {
    sections.push({
      text: doc.text,
      lineStart: 1,
      lineEnd: doc.text.split('\n').length
    })
  }

  return {
    format: doc.format as DocumentFormat,
    text: doc.text,
    sections,
    metadata: {
      ...doc.metadata,
      warnings: doc.warnings,
      quality: doc.quality,
      extractorId: doc.extractor.id,
      extractorVersion: doc.extractor.version,
      universalDocumentId: doc.id
    }
  }
}

/**
 * Converts a legacy ExtractedDocument into a canonical UniversalDocument.
 */
export function extractedDocumentToUniversalDocument(
  doc: ExtractedDocument,
  options?: {
    documentId?: string
    sourceId?: string
    knowledgeBaseId?: string
    originalFileName?: string
    mimeType?: string
    extractor?: ExtractorMetadata
  }
): UniversalDocument {
  const documentId = options?.documentId ?? randomUUID()
  const blocks: UniversalDocumentBlock[] = []
  let orderIndex = 0

  for (const section of doc.sections) {
    if (section.heading) {
      const headingBlock: UniversalHeadingBlock = {
        id: `blk-${orderIndex + 1}`,
        type: 'heading',
        orderIndex: orderIndex++,
        text: section.heading,
        level: section.headingLevel ?? 1,
        headingPath: section.headingPath ? [...section.headingPath] : [section.heading],
        location: {
          lineStart: section.lineStart,
          lineEnd: section.lineStart,
          pageNumber: section.pageNumber
        }
      }
      blocks.push(headingBlock)
    }

    if (section.text && section.text.length > 0) {
      const paraBlock: UniversalParagraphBlock = {
        id: `blk-${orderIndex + 1}`,
        type: 'paragraph',
        orderIndex: orderIndex++,
        text: section.text,
        location: {
          lineStart: section.heading ? (section.lineStart ?? 1) + 1 : section.lineStart,
          lineEnd: section.lineEnd,
          pageNumber: section.pageNumber
        }
      }
      blocks.push(paraBlock)
    }
  }

  return {
    id: documentId,
    sourceId: options?.sourceId,
    knowledgeBaseId: options?.knowledgeBaseId,
    format: doc.format,
    originalFileName: options?.originalFileName,
    mimeType: options?.mimeType,
    extractor: {
      id: options?.extractor?.id ?? 'legacy-extractor',
      name: options?.extractor?.name ?? 'Legacy Extractor Adapter',
      version: options?.extractor?.version ?? '1.0.0'
    },
    extractedAt: Date.now(),
    text: doc.text,
    blocks,
    metadata: { ...doc.metadata },
    warnings: [],
    quality: {
      fidelity: doc.format === 'pdf' ? 'medium' : 'high',
      isLossy: false,
      isOcr: false
    },
    sourceInfo: {
      characterCount: doc.text.length,
      lineCount: doc.text.split('\n').length
    }
  }
}
