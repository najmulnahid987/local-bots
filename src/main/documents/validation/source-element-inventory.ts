import type { UniversalDocument } from '../model/types'
import { normalizeDocumentText } from '../normalization/text-normalizer'
import { DocxArchiveValidator } from '../extraction/docx/docx-archive-validator'
import { XlsxArchiveValidator } from '../extraction/xlsx/xlsx-archive-validator'
import { PptxArchiveValidator } from '../extraction/pptx/pptx-archive-validator'
import type { SourceElementRecord, SourceElementInventory, ExtractionDisposition } from './types'

/**
 * Generator that inspects original file bytes, format hints, and extracted UniversalDocument
 * to build an authoritative SourceElementInventory accounting for all encountered elements.
 *
 * Invariants:
 * 1. Grounded in original source bytes, not reconstructed solely from extracted UniversalDocument.
 * 2. Every discovered source element receives exactly one primary disposition.
 * 3. Visual elements with only metadata/references are classified as 'reference_only', never 'fully_extracted'.
 * 4. Unsupported constructs (VBA macros, 3D models, SmartArt drawings) receive 'unsupported'.
 * 5. Elements where text was preserved but complex structure unparsed receive 'text_preserved_unparsed'.
 * 6. Elements where parsing failed receive 'failed'.
 * 7. When source elements are omitted from UniversalDocument, they are detected and recorded as 'partially_extracted'.
 * 8. No double-counting of elements.
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
    let expectedNormalizedText: string | undefined

    switch (normalizedFormat) {
      case 'txt':
        expectedNormalizedText = this.generateTxtInventory(bytes, doc, records, limitations)
        break
      case 'md':
      case 'markdown':
        expectedNormalizedText = this.generateMarkdownInventory(bytes, doc, records, limitations)
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
        expectedNormalizedText = this.generateCsvInventory(bytes, doc, records, limitations)
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
      expectedNormalizedText,
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
  ): string | undefined {
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
      return undefined
    }

    const normalized = normalizeDocumentText(decodedText)
    const sourceParagraphs = normalized
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    let orderIndex = 0
    const docParagraphs = doc.blocks.filter((b) => b.type === 'paragraph')

    // Track each source paragraph from the raw source
    for (let i = 0; i < sourceParagraphs.length; i++) {
      const srcPara = sourceParagraphs[i]
      const matchingBlock = docParagraphs.find(
        (b) => normalizeDocumentText(b.text.trim()) === srcPara
      )

      if (matchingBlock) {
        records.push({
          id: `txt-para-${matchingBlock.id}`,
          type: 'paragraph',
          location: matchingBlock.location,
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          blockId: matchingBlock.id,
          isSearchable: true,
          characterCount: matchingBlock.text.length
        })
      } else {
        // Source element omitted in extracted UniversalDocument
        records.push({
          id: `txt-src-para-${i + 1}`,
          type: 'paragraph',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          characterCount: srcPara.length,
          details: { omitted: true, preview: srcPara.slice(0, 40) }
        })
      }
    }

    // Check for blank lines / whitespace regions
    const lines = normalized.split('\n')
    const emptyLines = lines.filter((l) => l.trim().length === 0).length
    if (emptyLines > 0) {
      records.push({
        id: 'txt-blank-lines',
        type: 'blank_lines',
        orderIndex,
        disposition: 'fully_extracted',
        isSearchable: false,
        characterCount: 0,
        details: { emptyLineCount: emptyLines }
      })
    }

    return normalized
  }

  // --------------------------------------------------------------------------
  // Markdown Accounting
  // --------------------------------------------------------------------------
  private generateMarkdownInventory(
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): string | undefined {
    let decodedText: string
    try {
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      records.push({
        id: 'md-decode-failure',
        type: 'decoding_error',
        orderIndex: 0,
        disposition: 'failed',
        isSearchable: false,
        warningCode: 'INVALID_UTF8'
      })
      limitations.push('File contains invalid UTF-8 byte sequences.')
      return undefined
    }

    const normalized = normalizeDocumentText(decodedText)
    const lines = normalized.split('\n')
    let orderIndex = 0

    // Source inspection: check for source structures
    let inCodeFence = false
    let sourceHeadings = 0
    let sourceCodeBlocks = 0
    let sourceTables = 0

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]
      const fenceMatch = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenceMatch) {
        if (!inCodeFence) {
          inCodeFence = true
          sourceCodeBlocks++
        } else {
          inCodeFence = false
        }
        continue
      }
      if (inCodeFence) {
        continue
      }
      if (/^[ ]{0,3}#{1,6}\s+/.test(line)) {
        sourceHeadings++
      } else if (/^[ ]{0,3}\|.*\|[ \t]*$/.test(line)) {
        sourceTables++
      }
    }

    // Map doc blocks to source elements
    const docHeadings = doc.blocks.filter((b) => b.type === 'heading')
    const docCode = doc.blocks.filter((b) => b.type === 'code')
    const docTables = doc.blocks.filter((b) => b.type === 'table')

    // Detect omitted code blocks from source
    if (sourceCodeBlocks > docCode.length) {
      const omittedCount = sourceCodeBlocks - docCode.length
      for (let i = 0; i < omittedCount; i++) {
        records.push({
          id: `md-src-omitted-code-${i + 1}`,
          type: 'code_fence',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omittedFromExtracted: true }
        })
      }
    }

    // Detect omitted headings from source
    if (sourceHeadings > docHeadings.length) {
      const omittedCount = sourceHeadings - docHeadings.length
      for (let i = 0; i < omittedCount; i++) {
        records.push({
          id: `md-src-omitted-heading-${i + 1}`,
          type: 'heading',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omittedFromExtracted: true }
        })
      }
    }

    // Detect omitted tables from source
    if (sourceTables > 0 && docTables.length === 0) {
      records.push({
        id: `md-src-omitted-table-1`,
        type: 'table',
        orderIndex: orderIndex++,
        disposition: 'partially_extracted',
        isSearchable: true,
        details: { omittedFromExtracted: true }
      })
    }

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

    return normalized
  }

  // --------------------------------------------------------------------------
  // PDF Accounting
  // --------------------------------------------------------------------------
  private generatePdfInventory(
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0

    // Source inspection: check page count from PDF binary structure
    let sourcePageCount = 0
    if (bytes && bytes.length > 0) {
      const byteStr = Buffer.isBuffer(bytes)
        ? bytes.toString('latin1')
        : Buffer.from(bytes).toString('latin1')
      const countMatches = byteStr.match(/\/Count\s+(\d+)/g)
      if (countMatches && countMatches.length > 0) {
        for (const m of countMatches) {
          const match = /\/Count\s+(\d+)/.exec(m)
          if (match) {
            const count = parseInt(match[1], 10)
            if (count > sourcePageCount && count < 10000) {
              sourcePageCount = count
            }
          }
        }
      }
      if (sourcePageCount === 0) {
        const pageMatches = byteStr.match(/\/Type\s*\/Page\b/g)
        if (pageMatches) {
          sourcePageCount = pageMatches.length
        }
      }
    }

    const docPageCount =
      (doc.metadata?.pageCount as number) ??
      (doc.sourceInfo as { pageCount?: number })?.pageCount ??
      1

    const finalPageCount = Math.max(sourcePageCount, docPageCount)

    const isOcr = doc.quality?.isOcr ?? false
    if (isOcr) {
      limitations.push('Text extracted via OCR; visual layout and graphical elements simplified.')
    }

    // Check for pages omitted from doc.blocks
    for (let page = 1; page <= finalPageCount; page++) {
      const pageBlocks = doc.blocks.filter((b) => b.location?.pageNumber === page)
      const hasPageBoundary = doc.blocks.some(
        (b) => b.type === 'page_boundary' && b.location?.pageNumber === page
      )
      const hasContent = pageBlocks.length > 0 || hasPageBoundary

      if (!hasContent) {
        // Page was in source but omitted from extracted doc
        records.push({
          id: `pdf-page-${page}`,
          type: isOcr ? 'ocr_page' : 'digital_page',
          location: { pageNumber: page },
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: false,
          characterCount: 0,
          details: { pageNumber: page, omitted: true }
        })
      } else {
        const hasText = pageBlocks.some((b) => b.text.trim().length > 0)
        records.push({
          id: `pdf-page-${page}`,
          type: isOcr ? 'ocr_page' : 'digital_page',
          location: { pageNumber: page },
          orderIndex: orderIndex++,
          disposition: 'fully_extracted',
          isSearchable: hasText,
          characterCount: pageBlocks.reduce((acc, b) => acc + b.text.length, 0),
          details: { pageNumber: page, blockCount: pageBlocks.length, isOcr }
        })
      }
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
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0

    // Source inspection: check raw DOCX package structures
    let sourceParaCount = 0
    let sourceTableCount = 0

    if (bytes && bytes.length > 0) {
      try {
        const pkg = DocxArchiveValidator.openPackage(Buffer.from(bytes))
        const docXmlStr = pkg.getEntryText('word/document.xml')
        if (docXmlStr) {
          const pMatches = docXmlStr.match(/<w:p\b/g)
          if (pMatches) {
            sourceParaCount = pMatches.length
          }
          const tblMatches = docXmlStr.match(/<w:tbl\b/g)
          if (tblMatches) {
            sourceTableCount = tblMatches.length
          }
        }
      } catch {
        limitations.push('Unable to inspect DOCX package structure directly.')
      }
    }

    const docParas = doc.blocks.filter((b) => b.type === 'paragraph' || b.type === 'heading')
    const docTables = doc.blocks.filter((b) => b.type === 'table')

    // Detect omitted paragraphs from source
    if (sourceParaCount > docParas.length && docParas.length > 0) {
      const omitted = sourceParaCount - docParas.length
      for (let i = 0; i < omitted; i++) {
        records.push({
          id: `docx-src-omitted-p-${i + 1}`,
          type: 'paragraph',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omitted: true }
        })
      }
    }

    // Detect omitted tables from source
    if (sourceTableCount > docTables.length && docTables.length > 0) {
      const omitted = sourceTableCount - docTables.length
      for (let i = 0; i < omitted; i++) {
        records.push({
          id: `docx-src-omitted-tbl-${i + 1}`,
          type: 'table',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omitted: true }
        })
      }
    }

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
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0

    // Source inspection: check raw XLSX package structures
    let sourceFormulaCount = 0

    if (bytes && bytes.length > 0) {
      try {
        const pkg = XlsxArchiveValidator.openPackage(Buffer.from(bytes))
        for (const sheetEntry of pkg.validationResult.sheetEntries) {
          const sheetXml = pkg.getEntryText(sheetEntry)
          if (sheetXml) {
            const fMatches = sheetXml.match(/<f\b/g)
            if (fMatches) {
              sourceFormulaCount += fMatches.length
            }
          }
        }
      } catch {
        limitations.push('Unable to inspect XLSX workbook package structure directly.')
      }
    }

    // Detect omitted formulas from source
    if (sourceFormulaCount > 0 && doc.blocks.length > 0) {
      const hasFormulaMeta = doc.blocks.some(
        (b) => (b.metadata as { hasFormulas?: boolean })?.hasFormulas
      )
      if (!hasFormulaMeta && doc.text.indexOf('=') === -1) {
        records.push({
          id: 'xlsx-src-omitted-formula',
          type: 'formula',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omitted: true }
        })
      }
    }

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
  ): string | undefined {
    let orderIndex = 0
    let decodedText: string
    try {
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
      return undefined
    }

    const normalized = normalizeDocumentText(decodedText)
    const lines = normalized.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      limitations.push('CSV contains no data rows.')
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

    return normalized
  }

  // --------------------------------------------------------------------------
  // PPTX Accounting
  // --------------------------------------------------------------------------
  private generatePptxInventory(
    bytes: Uint8Array | Buffer,
    doc: UniversalDocument,
    records: SourceElementRecord[],
    limitations: string[]
  ): void {
    let orderIndex = 0

    // Source inspection: check raw PPTX package structures
    let sourceSlideCount = 0
    let sourceShapeCount = 0

    if (bytes && bytes.length > 0) {
      try {
        const pkg = PptxArchiveValidator.openPackage(Buffer.from(bytes))
        const presStr = pkg.getEntryText('ppt/presentation.xml')
        if (presStr) {
          const sldMatches = presStr.match(/<p:sldId\b/g)
          if (sldMatches) {
            sourceSlideCount = sldMatches.length
          }
        }
        for (const entry of pkg.getEntries()) {
          if (entry.startsWith('ppt/slides/slide') && entry.endsWith('.xml')) {
            const slideStr = pkg.getEntryText(entry)
            if (slideStr) {
              const spMatches = slideStr.match(/<p:sp\b/g)
              if (spMatches) {
                sourceShapeCount += spMatches.length
              }
            }
          }
        }
      } catch {
        limitations.push('Unable to inspect PPTX presentation package structure directly.')
      }
    }

    const docSlides = doc.blocks.filter((b) => b.type === 'slide_boundary')
    const docShapes = doc.blocks.filter((b) => b.type === 'paragraph' || b.type === 'heading')

    // Detect omitted slides from source
    if (sourceSlideCount > docSlides.length && docSlides.length > 0) {
      const omitted = sourceSlideCount - docSlides.length
      for (let i = 0; i < omitted; i++) {
        records.push({
          id: `pptx-src-omitted-slide-${i + 1}`,
          type: 'slide',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: false,
          details: { omitted: true }
        })
      }
    }

    // Detect omitted shapes from source
    if (sourceShapeCount > docShapes.length && docShapes.length > 0) {
      const omitted = sourceShapeCount - docShapes.length
      for (let i = 0; i < omitted; i++) {
        records.push({
          id: `pptx-src-omitted-shape-${i + 1}`,
          type: 'slide_shape',
          orderIndex: orderIndex++,
          disposition: 'partially_extracted',
          isSearchable: true,
          details: { omitted: true }
        })
      }
    }

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
