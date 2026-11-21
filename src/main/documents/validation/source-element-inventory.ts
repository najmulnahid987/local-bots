import type { UniversalDocument } from '../model/types'
import type { SourceElementRecord, SourceElementInventory, ExtractionDisposition } from './types'

/**
 * Generator that inspects original file bytes, format hints, and extracted UniversalDocument
 * to build an authoritative SourceElementInventory accounting for all encountered elements.
 *
 * Invariants:
 * 1. Every discovered source element receives exactly one primary disposition.
 * 2. Visual elements with only metadata/references are classified as 'reference_only', never 'fully_extracted'.
 * 3. Unsupported constructs (VBA macros, 3D models, SmartArt drawings) receive 'unsupported'.
 * 4. Elements where text was preserved but complex structure unparsed receive 'text_preserved_unparsed'.
 * 5. Elements where parsing failed receive 'failed'.
 * 6. No double-counting of elements.
 */
export class SourceElementInventoryGenerator {
  /**
   * Generates a complete SourceElementInventory for a given document.
   */
  public generateInventory(
    format: string,
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument
  ): SourceElementInventory {
    const normalizedFormat = format.toLowerCase().trim()
    const records: SourceElementRecord[] = []
    const limitations: string[] = []

    switch (normalizedFormat) {
      case 'txt':
        this.generateTxtInventory(bytes, doc, records, limitations)
        break
      case 'md':
      case 'markdown':
        this.generateMarkdownInventory(bytes, doc, records, limitations)
        break
      case 'pdf':
        this.generatePdfInventory(bytes, doc, records, limitations)
        break
      case 'docx':
        this.generateDocxInventory(bytes, doc, records, limitations)
        break
      case 'xlsx':
        this.generateXlsxInventory(bytes, doc, records, limitations)
        break
      case 'csv':
        this.generateCsvInventory(bytes, doc, records, limitations)
        break
      case 'pptx':
        this.generatePptxInventory(bytes, doc, records, limitations)
        break
      default:
        this.generateGenericInventory(doc, records, limitations)
        break
    }

    // Process warnings to capture unsupported/reference-only elements noted during extraction
    this.processDocumentWarnings(doc, records)

    // Compute aggregate statistics
    const elementCountsByType: Record<string, number> = {}
    const dispositionCounts: Record<ExtractionDisposition, number> = {
      fully_extracted: 0,
      text_preserved_unparsed: 0,
      reference_only: 0,
      partially_extracted: 0,
      unsupported: 0,
      failed: 0,
      unknown: 0
    }

    let expectedSearchableChars = 0

    for (const record of records) {
      elementCountsByType[record.type] = (elementCountsByType[record.type] ?? 0) + 1
      dispositionCounts[record.disposition] = (dispositionCounts[record.disposition] ?? 0) + 1
      if (record.isSearchable && record.characterCount) {
        expectedSearchableChars += record.characterCount
      }
    }

    return {
      format: normalizedFormat,
      sourceElements: records,
      totalElements: records.length,
      elementCountsByType,
      dispositionCounts,
      expectedSearchableCharacters:
        expectedSearchableChars > 0 ? expectedSearchableChars : undefined,
      measurementLimitations: limitations.length > 0 ? limitations : undefined
    }
  }

  // --------------------------------------------------------------------------
  // TXT Accounting
  // --------------------------------------------------------------------------
  private generateTxtInventory(
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let decodedText: string
    try {
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      records.push({
        id: 'txt-decode-failure',
        type: 'decoding_error',
        orderIndex: 0,
        disposition: 'failed',
        isSearchable: false,
        warningCode: 'INVALID_UTF8'
      })
      limitations.push('File contains invalid UTF-8 byte sequences.')
      return
    }

    // Split physical lines
    const normalized = decodedText.replace(/\r\n|\r/g, '\n').replace(/^\uFEFF/, '')
    const lines = normalized.split('\n')
    const lineIdx = 1

    let blockIdx = 0
    for (const block of doc.blocks) {
      if (block.type === 'paragraph') {
        const lineCount = (block.text.match(/\n/g) || []).length + 1
        records.push({
          id: `txt-para-${block.id}`,
          type: 'paragraph',
          location: block.location ?? {
            lineStart: lineIdx,
            lineEnd: lineIdx + lineCount - 1
          },
          orderIndex: blockIdx++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      }
    }

    // Check for blank lines / whitespace regions
    const emptyLines = lines.filter((l) => l.trim().length === 0).length
    if (emptyLines > 0) {
      records.push({
        id: 'txt-blank-lines',
        type: 'blank_lines',
        orderIndex: blockIdx,
        disposition: 'fully_extracted',
        isSearchable: false,
        characterCount: 0,
        details: { emptyLineCount: emptyLines }
      })
    }
  }

  // --------------------------------------------------------------------------
  // Markdown Accounting
  // --------------------------------------------------------------------------
  private generateMarkdownInventory(
    _bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    _limitations: string[]
  ): void {
    void _bytes
    void _limitations
    let orderIndex = 0

    for (const block of doc.blocks) {
      switch (block.type) {
        case 'heading':
          records.push({
            id: `md-heading-${block.id}`,
            type: 'heading',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'fully_extracted',
            blockId: block.id,
            isSearchable: true,
            characterCount: block.text.length,
            details: { headingLevel: (block.metadata as { headingLevel?: number })?.headingLevel }
          })
          break

        case 'paragraph': {
          const isHtml = /<\/?[a-z][\s\S]*>/i.test(block.text)
          records.push({
            id: `md-para-${block.id}`,
            type: isHtml ? 'html_block' : 'paragraph',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: isHtml ? 'text_preserved_unparsed' : 'fully_extracted',
            blockId: block.id,
            isSearchable: true,
            characterCount: block.text.length
          })
          break
        }

        case 'code':
          records.push({
            id: `md-code-${block.id}`,
            type: 'code_fence',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'fully_extracted',
            blockId: block.id,
            isSearchable: true,
            characterCount: block.text.length,
            details: { language: (block.metadata as { codeLanguage?: string })?.codeLanguage }
          })
          break

        case 'list': {
          const items = (block.metadata as { items?: unknown[] })?.items
          records.push({
            id: `md-list-${block.id}`,
            type: 'list',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'fully_extracted',
            blockId: block.id,
            isSearchable: true,
            characterCount: block.text.length,
            details: { itemCount: Array.isArray(items) ? items.length : 1 }
          })
          break
        }

        case 'table': {
          const rows = (block.metadata as { rowCount?: number })?.rowCount ?? 1
          const cols = (block.metadata as { columnCount?: number })?.columnCount ?? 1
          records.push({
            id: `md-table-${block.id}`,
            type: 'table',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'fully_extracted',
            blockId: block.id,
            isSearchable: true,
            characterCount: block.text.length,
            details: { rowCount: rows, columnCount: cols }
          })
          break
        }

        case 'image_reference':
          records.push({
            id: `md-img-${block.id}`,
            type: 'image',
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'reference_only',
            blockId: block.id,
            isSearchable: false,
            characterCount: 0
          })
          break

        default:
          records.push({
            id: `md-block-${block.id}`,
            type: block.type,
            location: block.location,
            orderIndex: orderIndex++,
            disposition: 'text_preserved_unparsed',
            blockId: block.id,
            isSearchable: block.text.length > 0,
            characterCount: block.text.length
          })
          break
      }
    }
  }

  // --------------------------------------------------------------------------
  // PDF Accounting
  // --------------------------------------------------------------------------
  private generatePdfInventory(
    _bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0
    const pageCount =
      (doc.metadata?.pageCount as number) ??
      (doc.sourceInfo as { pageCount?: number })?.pageCount ??
      1

    const isOcr = doc.quality?.isOcr ?? false
    if (isOcr) {
      limitations.push('Text extracted via OCR; visual layout and graphical elements simplified.')
    }

    // Track pages
    for (let page = 1; page <= pageCount; page++) {
      const pageBlocks = doc.blocks.filter((b) => b.location?.pageNumber === page)
      const hasText = pageBlocks.some((b) => b.text.trim().length > 0)

      records.push({
        id: `pdf-page-${page}`,
        type: isOcr ? 'ocr_page' : 'digital_page',
        location: { pageNumber: page },
        orderIndex: orderIndex++,
        disposition: hasText ? 'fully_extracted' : 'fully_extracted',
        isSearchable: hasText,
        characterCount: pageBlocks.reduce((acc, b) => acc + b.text.length, 0),
        details: { pageNumber: page, blockCount: pageBlocks.length, isOcr }
      })
    }

    // Track individual content blocks
    for (const block of doc.blocks) {
      if (block.type === 'page_boundary') {
        continue
      }
      if (block.type === 'image_reference') {
        records.push({
          id: `pdf-img-${block.id}`,
          type: 'image_reference',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'reference_only',
          blockId: block.id,
          isSearchable: false,
          characterCount: 0
        })
      } else {
        records.push({
          id: `pdf-block-${block.id}`,
          type: block.type,
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      }
    }
  }

  // --------------------------------------------------------------------------
  // DOCX Accounting
  // --------------------------------------------------------------------------
  private generateDocxInventory(
    _bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    _limitations: string[]
  ): void {
    void _bytes
    void _limitations
    let orderIndex = 0

    for (const block of doc.blocks) {
      const role = (block.metadata as { contentRole?: string })?.contentRole

      if (block.type === 'heading') {
        records.push({
          id: `docx-head-${block.id}`,
          type: 'heading',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      } else if (block.type === 'table') {
        const rows = (block.metadata as { rowCount?: number })?.rowCount ?? 1
        const cols = (block.metadata as { columnCount?: number })?.columnCount ?? 1
        records.push({
          id: `docx-tbl-${block.id}`,
          type: 'table',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length,
          details: { rowCount: rows, columnCount: cols }
        })
      } else if (block.type === 'image_reference') {
        records.push({
          id: `docx-img-${block.id}`,
          type: 'drawing',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'reference_only',
          blockId: block.id,
          isSearchable: false,
          characterCount: 0
        })
      } else {
        const typeName = role && role !== 'body' ? role : 'paragraph'
        records.push({
          id: `docx-p-${block.id}`,
          type: typeName,
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      }
    }
  }

  // --------------------------------------------------------------------------
  // XLSX Accounting
  // --------------------------------------------------------------------------
  private generateXlsxInventory(
    _bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    _limitations: string[]
  ): void {
    void _bytes
    void _limitations
    let orderIndex = 0

    for (const block of doc.blocks) {
      if (block.type === 'sheet_boundary') {
        const sheetMeta = block.metadata as { sheetName?: string; sheetIndex?: number }
        records.push({
          id: `xlsx-sheet-${block.id}`,
          type: 'worksheet',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: false,
          characterCount: 0,
          details: { sheetName: sheetMeta?.sheetName, sheetIndex: sheetMeta?.sheetIndex }
        })
      } else if (block.type === 'table') {
        const rowCount = (block.metadata as { rowCount?: number })?.rowCount ?? 1
        const colCount = (block.metadata as { columnCount?: number })?.columnCount ?? 1
        records.push({
          id: `xlsx-table-${block.id}`,
          type: 'sheet_table',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length,
          details: { rowCount, columnCount: colCount }
        })
      } else {
        records.push({
          id: `xlsx-block-${block.id}`,
          type: block.type,
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: block.text.length > 0,
          characterCount: block.text.length
        })
      }
    }
  }

  // --------------------------------------------------------------------------
  // CSV Accounting
  // --------------------------------------------------------------------------
  private generateCsvInventory(
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      records.push({
        id: 'csv-decode-failure',
        type: 'decoding_error',
        orderIndex: 0,
        disposition: 'failed',
        isSearchable: false,
        warningCode: 'INVALID_UTF8'
      })
      limitations.push('CSV contains invalid UTF-8 encoding.')
      return
    }

    const hasHeader =
      (doc.metadata?.hasHeader as boolean) ??
      (doc.blocks[0]?.metadata as { hasHeader?: boolean })?.hasHeader ??
      false

    // Header record accounting
    records.push({
      id: 'csv-header',
      type: 'header_row',
      orderIndex: orderIndex++,
      disposition: hasHeader ? 'fully_extracted' : 'text_preserved_unparsed',
      isSearchable: true,
      characterCount: 0,
      details: { hasHeader }
    })

    // Content blocks accounting
    for (const block of doc.blocks) {
      records.push({
        id: `csv-block-${block.id}`,
        type: 'logical_records',
        location: block.location,
        orderIndex: orderIndex++,
        disposition: 'fully_extracted',
        blockId: block.id,
        isSearchable: true,
        characterCount: block.text.length
      })
    }
  }

  // --------------------------------------------------------------------------
  // PPTX Accounting
  // --------------------------------------------------------------------------
  private generatePptxInventory(
    _bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    _limitations: string[]
  ): void {
    void _bytes
    void _limitations
    let orderIndex = 0

    for (const block of doc.blocks) {
      const meta = block.metadata as Record<string, unknown> | undefined

      if (block.type === 'slide_boundary') {
        records.push({
          id: `pptx-slide-${block.id}`,
          type: 'slide',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: false,
          characterCount: 0,
          details: {
            slideNumber: block.location?.slideNumber,
            slideTitle: block.location?.slideTitle
          }
        })
      } else if (meta?.isSpeakerNotes || meta?.contentRole === 'speaker_notes') {
        records.push({
          id: `pptx-notes-${block.id}`,
          type: 'speaker_notes',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      } else if (meta?.contentRole === 'comment') {
        records.push({
          id: `pptx-comment-${block.id}`,
          type: 'comment',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      } else if (block.type === 'heading') {
        records.push({
          id: `pptx-title-${block.id}`,
          type: 'slide_title',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      } else if (block.type === 'table') {
        records.push({
          id: `pptx-tbl-${block.id}`,
          type: 'slide_table',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      } else if (block.type === 'image_reference') {
        records.push({
          id: `pptx-img-${block.id}`,
          type: 'image',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'reference_only',
          blockId: block.id,
          isSearchable: false,
          characterCount: 0
        })
      } else {
        records.push({
          id: `pptx-shape-${block.id}`,
          type: 'slide_shape',
          location: block.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: block.id,
          isSearchable: true,
          characterCount: block.text.length
        })
      }
    }
  }

  // --------------------------------------------------------------------------
  // Generic Fallback Accounting
  // --------------------------------------------------------------------------
  private generateGenericInventory(
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    limitations.push(`Generic element accounting used for format '${doc.format}'.`)
    let orderIndex = 0
    for (const block of doc.blocks) {
      records.push({
        id: `generic-${block.id}`,
        type: block.type,
        location: block.location,
        orderIndex: orderIndex++,
        disposition: block.type === 'image_reference' ? 'reference_only' : 'fully_extracted',
        blockId: block.id,
        isSearchable: block.text.length > 0,
        characterCount: block.text.length
      })
    }
  }

  // --------------------------------------------------------------------------
  // Document Warnings Processing
  // --------------------------------------------------------------------------
  private processDocumentWarnings(doc: UniversalDocument, records: SourceElementRecord[]): void {
    let warnIndex = records.length

    for (const warning of doc.warnings) {
      const code = warning.code.toUpperCase()

      // Detect unsupported objects
      if (
        code.includes('UNSUPPORTED') ||
        code.includes('VBA') ||
        code.includes('MACRO') ||
        code.includes('SMARTART') ||
        code.includes('CHART')
      ) {
        records.push({
          id: `warn-${warning.code.toLowerCase()}-${warnIndex}`,
          type: 'unsupported_feature',
          orderIndex: warnIndex++,
          disposition: 'unsupported',
          isSearchable: false,
          warningCode: warning.code,
          details: { message: warning.message, details: warning.details }
        })
      } else if (code.includes('FAILED') || code.includes('CORRUPT') || code.includes('ERROR')) {
        records.push({
          id: `warn-${warning.code.toLowerCase()}-${warnIndex}`,
          type: 'failed_element',
          orderIndex: warnIndex++,
          disposition: 'failed',
          isSearchable: false,
          warningCode: warning.code,
          details: { message: warning.message, details: warning.details }
        })
      } else if (code.includes('IMAGE') || code.includes('DRAWING')) {
        // Only add if not already captured as an image_reference
        if (!records.some((r) => r.type === 'image' || r.type === 'drawing')) {
          records.push({
            id: `warn-img-${warnIndex}`,
            type: 'image_reference',
            orderIndex: warnIndex++,
            disposition: 'reference_only',
            isSearchable: false,
            warningCode: warning.code,
            details: { message: warning.message }
          })
        }
      }
    }
  }
}

export const defaultSourceElementInventoryGenerator = new SourceElementInventoryGenerator()
