import type {
  UniversalBlockType,
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
  UniversalDocument
} from './types'

// ============================================================================
// Exhaustive Block Pattern Matching Interface
// ============================================================================

/**
 * Type-level exhaustive handler map.
 * Forces downstream consumers to handle all 10 universal block types.
 * Adding a new block type causes immediate TypeScript compilation errors
 * if any handler is missing.
 */
export interface UniversalBlockHandlers<T> {
  readonly heading: (block: UniversalHeadingBlock) => T
  readonly paragraph: (block: UniversalParagraphBlock) => T
  readonly list: (block: UniversalListBlock) => T
  readonly table: (block: UniversalTableBlock) => T
  readonly code: (block: UniversalCodeBlock) => T
  readonly page_boundary: (block: UniversalPageBoundaryBlock) => T
  readonly sheet_boundary: (block: UniversalSheetBoundaryBlock) => T
  readonly slide_boundary: (block: UniversalSlideBoundaryBlock) => T
  readonly image_reference: (block: UniversalImageReferenceBlock) => T
  readonly unknown: (block: UniversalUnknownBlock) => T
}

/**
 * Executes exhaustive type-safe pattern matching against a universal document block.
 */
export function matchUniversalBlock<T>(
  block: UniversalDocumentBlock,
  handlers: UniversalBlockHandlers<T>
): T {
  switch (block.type) {
    case 'heading':
      return handlers.heading(block)
    case 'paragraph':
      return handlers.paragraph(block)
    case 'list':
      return handlers.list(block)
    case 'table':
      return handlers.table(block)
    case 'code':
      return handlers.code(block)
    case 'page_boundary':
      return handlers.page_boundary(block)
    case 'sheet_boundary':
      return handlers.sheet_boundary(block)
    case 'slide_boundary':
      return handlers.slide_boundary(block)
    case 'image_reference':
      return handlers.image_reference(block)
    case 'unknown':
      return handlers.unknown(block)
    default: {
      // Compile-time exhaustiveness check: 'block' must be never
      const exhaustiveCheck: never = block
      throw new Error(`Unhandled universal block: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}

// ============================================================================
// Visitor Interface & Traversal
// ============================================================================

/**
 * Pluggable visitor interface for inspecting or transforming document blocks.
 */
export interface UniversalBlockVisitor<T = void> {
  heading?(block: UniversalHeadingBlock): T
  paragraph?(block: UniversalParagraphBlock): T
  list?(block: UniversalListBlock): T
  table?(block: UniversalTableBlock): T
  code?(block: UniversalCodeBlock): T
  page_boundary?(block: UniversalPageBoundaryBlock): T
  sheet_boundary?(block: UniversalSheetBoundaryBlock): T
  slide_boundary?(block: UniversalSlideBoundaryBlock): T
  image_reference?(block: UniversalImageReferenceBlock): T
  unknown?(block: UniversalUnknownBlock): T
  default?(block: UniversalDocumentBlock): T
}

/**
 * Traverses all blocks in a document in orderIndex sequence using a visitor.
 */
export function traverseUniversalDocument<T>(
  doc: UniversalDocument,
  visitor: UniversalBlockVisitor<T>
): T[] {
  const results: T[] = []
  for (const block of doc.blocks) {
    let handled = false
    let result: T | undefined

    const method = visitor[block.type]
    if (typeof method === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = (method as any).call(visitor, block)
      handled = true
    } else if (typeof visitor.default === 'function') {
      result = visitor.default(block)
      handled = true
    }

    if (handled && result !== undefined) {
      results.push(result)
    }
  }
  return results
}

// ============================================================================
// Block Query & Extraction Helpers
// ============================================================================

/**
 * Filters document blocks by specific discriminated block type.
 */
export function findBlocksByType<K extends UniversalBlockType>(
  doc: UniversalDocument,
  type: K
): Array<Extract<UniversalDocumentBlock, { type: K }>> {
  return doc.blocks.filter(
    (b): b is Extract<UniversalDocumentBlock, { type: K }> => b.type === type
  )
}

/**
 * Retrieves all structured table blocks from a document.
 */
export function getTableBlocks(doc: UniversalDocument): UniversalTableBlock[] {
  return findBlocksByType(doc, 'table')
}

/**
 * Retrieves all code blocks from a document.
 */
export function getCodeBlocks(doc: UniversalDocument): UniversalCodeBlock[] {
  return findBlocksByType(doc, 'code')
}

/**
 * Retrieves all list blocks from a document.
 */
export function getListBlocks(doc: UniversalDocument): UniversalListBlock[] {
  return findBlocksByType(doc, 'list')
}

/**
 * Retrieves all blocks associated with a specific physical page number.
 */
export function getBlocksByPage(
  doc: UniversalDocument,
  pageNumber: number
): UniversalDocumentBlock[] {
  let currentPage = 1
  const matches: UniversalDocumentBlock[] = []

  for (const block of doc.blocks) {
    if (block.type === 'page_boundary') {
      currentPage = block.pageNumber
    } else if (block.location?.pageNumber !== undefined) {
      if (block.location.pageNumber === pageNumber) {
        matches.push(block)
      }
      continue
    }

    if (currentPage === pageNumber) {
      matches.push(block)
    }
  }

  return matches
}

/**
 * Retrieves all blocks associated with a specific worksheet.
 */
export function getBlocksBySheet(
  doc: UniversalDocument,
  sheetNameOrIndex: string | number
): UniversalDocumentBlock[] {
  let currentSheetName: string | undefined = undefined
  let currentSheetIndex: number | undefined = undefined
  const matches: UniversalDocumentBlock[] = []

  for (const block of doc.blocks) {
    if (block.type === 'sheet_boundary') {
      currentSheetName = block.sheetName
      currentSheetIndex = block.sheetIndex
      if (
        (typeof sheetNameOrIndex === 'string' && block.sheetName === sheetNameOrIndex) ||
        (typeof sheetNameOrIndex === 'number' && block.sheetIndex === sheetNameOrIndex)
      ) {
        matches.push(block)
      }
      continue
    }

    if (block.type === 'slide_boundary') {
      currentSheetName = undefined
      currentSheetIndex = undefined
      continue
    }

    const locSheetName =
      block.location?.sheetName ?? (block.type === 'table' ? block.sheetName : undefined)
    const locSheetIndex =
      block.location?.sheetIndex ?? (block.type === 'table' ? block.sheetIndex : undefined)

    if (locSheetName !== undefined || locSheetIndex !== undefined) {
      const match =
        (typeof sheetNameOrIndex === 'string' && locSheetName === sheetNameOrIndex) ||
        (typeof sheetNameOrIndex === 'number' && locSheetIndex === sheetNameOrIndex)
      if (match) {
        matches.push(block)
      }
      continue
    }

    if (
      currentSheetName &&
      ((typeof sheetNameOrIndex === 'string' && currentSheetName === sheetNameOrIndex) ||
        (typeof sheetNameOrIndex === 'number' && currentSheetIndex === sheetNameOrIndex))
    ) {
      matches.push(block)
    }
  }

  return matches
}

/**
 * Retrieves all blocks associated with a specific presentation slide.
 */
export function getBlocksBySlide(
  doc: UniversalDocument,
  slideNumber: number
): UniversalDocumentBlock[] {
  let currentSlide: number | undefined = undefined
  const matches: UniversalDocumentBlock[] = []

  for (const block of doc.blocks) {
    if (block.type === 'slide_boundary') {
      currentSlide = block.slideNumber
      if (block.slideNumber === slideNumber) {
        matches.push(block)
      }
      continue
    }

    if (block.type === 'sheet_boundary') {
      currentSlide = undefined
      continue
    }

    const locSlideNumber = block.location?.slideNumber

    if (locSlideNumber !== undefined) {
      if (locSlideNumber === slideNumber) {
        matches.push(block)
      }
      continue
    }

    if (currentSlide === slideNumber) {
      matches.push(block)
    }
  }

  return matches
}

/**
 * Reconstructs a hierarchical heading tree where each heading owns its nested child blocks.
 */
export function getHeadingsHierarchy(
  doc: UniversalDocument
): Array<{ heading: UniversalHeadingBlock; children: UniversalDocumentBlock[] }> {
  const sections: Array<{ heading: UniversalHeadingBlock; children: UniversalDocumentBlock[] }> = []
  let currentSection: {
    heading: UniversalHeadingBlock
    children: UniversalDocumentBlock[]
  } | null = null

  for (const block of doc.blocks) {
    if (block.type === 'heading') {
      currentSection = { heading: block, children: [] }
      sections.push(currentSection)
    } else if (currentSection) {
      currentSection.children.push(block)
    }
  }

  return sections
}
