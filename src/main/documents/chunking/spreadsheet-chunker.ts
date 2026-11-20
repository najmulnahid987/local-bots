import { DocumentErrors } from '../document-errors'
import type { ExtractedDocument, ExtractedDocumentSection } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import type {
  ChunkingResult,
  DocumentChunk,
  NonSearchableBlockDisposition,
  UniversalChunkingOptions
} from './types'
import { estimateTokenCount } from './chunking-utils'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type { UniversalDocument, UniversalTableBlock } from '../model/types'
import { matchUniversalBlock } from '../model/processor'
import { getExcelColumnName } from '../extraction/xlsx/xlsx-extractor'

interface ParsedSpreadsheetRow {
  readonly rowNumber: number
  readonly rawText: string
  readonly tokenCount: number
}

/**
 * Parses raw section text into structured spreadsheet rows (legacy ExtractedDocument support).
 */
function parseSectionRows(sectionText: string): {
  sheetName: string
  headerRow?: ParsedSpreadsheetRow
  rows: ParsedSpreadsheetRow[]
} {
  const lines = sectionText.split('\n')
  let sheetName = 'Sheet1'
  let hasExplicitNoHeader = false
  const rows: ParsedSpreadsheetRow[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Sheet title line: e.g. "# Sheet: Summary (Sheet 1)" or "Sheet: Summary"
    const sheetMatch = trimmed.match(/^#?\s*Sheet:\s*([^(]+?)(?:\s*\(Sheet\s*\d+\))?$/i)
    if (sheetMatch) {
      sheetName = sheetMatch[1].trim()
      continue
    }

    // Explicit no-header directive from extractor
    if (trimmed.match(/^#?\s*Header:\s*None$/i) || trimmed.match(/^\[No Header\]$/i)) {
      hasExplicitNoHeader = true
      continue
    }

    // Row line: e.g. "Row 1 | A1: Metric | B1: Q1 Actual"
    const rowMatch = trimmed.match(/^Row\s+(\d+)\s*\|\s*(.+)$/i)
    if (rowMatch) {
      const rowNum = parseInt(rowMatch[1], 10)
      rows.push({
        rowNumber: rowNum,
        rawText: trimmed,
        tokenCount: estimateTokenCount(trimmed)
      })
    } else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Markdown table line fallback
      rows.push({
        rowNumber: rows.length + 1,
        rawText: trimmed,
        tokenCount: estimateTokenCount(trimmed)
      })
    }
  }

  // Detect table header: only if not explicitly marked as having no header, row 1 exists, and has multiple columns
  let headerRow: ParsedSpreadsheetRow | undefined = undefined
  if (!hasExplicitNoHeader && rows.length >= 2 && rows[0].rowNumber === 1) {
    const firstRowText = rows[0].rawText
    if (firstRowText.split('|').length >= 3) {
      headerRow = rows[0]
    }
  }

  return { sheetName, headerRow, rows }
}

/**
 * Splits an oversized single row that exceeds chunkTargetTokens into coordinate parts.
 */
function sliceWideRow(
  row: ParsedSpreadsheetRow,
  sheetName: string,
  chunkTargetTokens: number
): string[] {
  const parts = row.rawText.split('|').map((s) => s.trim())
  const rowLabel = parts[0]
  const cells = parts.slice(1)

  if (cells.length <= 1) {
    return [row.rawText]
  }

  const slices: string[] = []
  let currentCells: string[] = []
  let currentTokens = estimateTokenCount(rowLabel)
  let partNumber = 1

  for (const cell of cells) {
    const cellTokens = estimateTokenCount(cell) + 1
    if (currentCells.length > 0 && currentTokens + cellTokens > chunkTargetTokens) {
      slices.push(
        `[Spreadsheet Context]\nWorksheet: ${sheetName}\nRow: ${row.rowNumber} (Part ${partNumber})\n\n${rowLabel} | ${currentCells.join(' | ')}`
      )
      partNumber++
      currentCells = [cell]
      currentTokens = estimateTokenCount(rowLabel) + cellTokens
    } else {
      currentCells.push(cell)
      currentTokens += cellTokens
    }
  }

  if (currentCells.length > 0) {
    slices.push(
      `[Spreadsheet Context]\nWorksheet: ${sheetName}\nRow: ${row.rowNumber} (Part ${partNumber})\n\n${rowLabel} | ${currentCells.join(' | ')}`
    )
  }

  return slices
}

/**
 * SpreadsheetChunker implements spreadsheet-aware structured semantic chunking.
 * Supports both canonical UniversalDocument (Phase 11) and legacy ExtractedDocument (Phase 10).
 *
 * Guarantees:
 * 1. Preserves workbook and worksheet identity in every chunk context header.
 * 2. Never merges rows from different worksheets in one chunk.
 * 3. Preserves cell coordinates (A1, B2) and formula expressions alongside cached values.
 * 4. Repeats verified table column headers at the start of each row fragment as contextual content.
 * 5. Handles wide worksheets deterministically via coordinate slicing without dropping cells.
 * 6. Non-searchable block accounting for charts, images, and empty boundaries.
 */
export class SpreadsheetChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(
    doc: UniversalDocument | ExtractedDocument,
    options?: UniversalChunkingOptions
  ): ChunkingResult {
    if (!doc) {
      throw DocumentErrors.chunkingInvalidInput('Document is null or undefined.')
    }

    if ('blocks' in doc) {
      return this.chunkUniversal(doc as UniversalDocument, options)
    }

    return this.chunkLegacy(doc as ExtractedDocument)
  }

  /**
   * Chunks a canonical UniversalDocument representing an XLSX workbook.
   */
  private chunkUniversal(
    doc: UniversalDocument,
    options?: UniversalChunkingOptions
  ): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'xlsx' && doc.format !== 'csv') {
      throw DocumentErrors.extractionUnsupportedFormat(
        `SpreadsheetChunker expected 'xlsx' or 'csv' format, got '${doc.format}'`
      )
    }

    const settings = this.settingsProvider.getSettings()
    const chunkTargetTokens = options?.chunkTargetTokens ?? settings.chunkTargetTokens

    if (
      chunkTargetTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min ||
      chunkTargetTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkTargetTokens (${chunkTargetTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max}.`
      )
    }

    const chunks: DocumentChunk[] = []
    const nonSearchableBlocks: NonSearchableBlockDisposition[] = []
    let currentIndex = 0

    let currentSheetName = 'Sheet1'
    let currentSheetIndex = 0

    for (const block of doc.blocks) {
      matchUniversalBlock(block, {
        sheet_boundary: (b) => {
          if (b.sheetName) {
            currentSheetName = b.sheetName
            currentSheetIndex = b.sheetIndex ?? currentSheetIndex + 1
          }
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'sheet_boundary',
            reason: 'structural worksheet boundary',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        table: (t: UniversalTableBlock) => {
          const sheetName = t.sheetName ?? currentSheetName
          const sheetIndex = t.sheetIndex ?? currentSheetIndex

          // Build parsed row models
          const parsedRows: ParsedSpreadsheetRow[] = []

          if (t.cells && t.cells.length > 0) {
            for (let r = 0; r < t.cells.length; r++) {
              const rowCells = t.cells[r]
              if (!rowCells || rowCells.length === 0) continue

              const cellParts: string[] = []
              let rowNumber = r + 1

              for (let c = 0; c < rowCells.length; c++) {
                const cell = rowCells[c]
                if (cell.coordinate) {
                  const match = cell.coordinate.match(/\d+$/)
                  if (match) {
                    rowNumber = parseInt(match[0], 10)
                  }
                }
                const coord = cell.coordinate ?? `${getExcelColumnName(c)}${rowNumber}`
                let valStr = cell.value ?? ''
                if (cell.formula) {
                  valStr = valStr
                    ? `${valStr} (Formula: ${cell.formula})`
                    : `(Formula: ${cell.formula})`
                }
                if ((cell.rowSpan && cell.rowSpan > 1) || (cell.colSpan && cell.colSpan > 1)) {
                  valStr += ` (Merged: ${cell.rowSpan ?? 1}x${cell.colSpan ?? 1})`
                }
                cellParts.push(`${coord}: ${valStr}`)
              }

              const rawText = `Row ${rowNumber} | ${cellParts.join(' | ')}`
              parsedRows.push({
                rowNumber,
                rawText,
                tokenCount: estimateTokenCount(rawText)
              })
            }

            // If header row (Row 1) was not in t.cells but provided in t.headers, prepend it
            if (
              t.headers &&
              t.headers.length > 0 &&
              parsedRows.length > 0 &&
              parsedRows[0].rowNumber > 1
            ) {
              const headerParts = t.headers.map((h, c) => `${getExcelColumnName(c)}1: ${h}`)
              const headerRawText = `Row 1 | ${headerParts.join(' | ')}`
              parsedRows.unshift({
                rowNumber: 1,
                rawText: headerRawText,
                tokenCount: estimateTokenCount(headerRawText)
              })
            }
          } else {
            let currentRowNum = 1
            if (t.headers && t.headers.length > 0) {
              const headerParts = t.headers.map(
                (h, c) => `${getExcelColumnName(c)}${currentRowNum}: ${h}`
              )
              const headerRawText = `Row ${currentRowNum} | ${headerParts.join(' | ')}`
              parsedRows.push({
                rowNumber: currentRowNum,
                rawText: headerRawText,
                tokenCount: estimateTokenCount(headerRawText)
              })
              currentRowNum++
            }

            for (let r = 0; r < t.rows.length; r++) {
              const rowNumber = currentRowNum++
              const cellParts = t.rows[r].map(
                (val, c) => `${getExcelColumnName(c)}${rowNumber}: ${val ?? ''}`
              )
              const rawText = `Row ${rowNumber} | ${cellParts.join(' | ')}`
              parsedRows.push({
                rowNumber,
                rawText,
                tokenCount: estimateTokenCount(rawText)
              })
            }
          }

          if (parsedRows.length === 0) {
            nonSearchableBlocks.push({
              blockId: t.id,
              blockType: 'table',
              reason: 'empty worksheet table without data rows',
              orderIndex: t.orderIndex,
              location: t.location
            })
            return
          }

          // Detect header row
          let headerRow: ParsedSpreadsheetRow | undefined = undefined
          if (parsedRows.length >= 2 && parsedRows[0].rowNumber === 1) {
            if (t.headers.length >= 2 || parsedRows[0].rawText.split('|').length >= 3) {
              headerRow = parsedRows[0]
            }
          }

          const hasTable = headerRow !== undefined
          const tableHeaderPrefix =
            hasTable && headerRow
              ? `[Table Header: ${headerRow.rawText.replace(/^Row\s+\d+\s*\|\s*/i, '')}]`
              : ''

          let rowIdx = 0
          while (rowIdx < parsedRows.length) {
            const startRowIdx = rowIdx
            const chunkRows: ParsedSpreadsheetRow[] = []

            while (rowIdx < parsedRows.length) {
              const candidateRow = parsedRows[rowIdx]

              if (candidateRow.tokenCount > chunkTargetTokens) {
                if (chunkRows.length > 0) {
                  break
                }

                const wideSlices = sliceWideRow(candidateRow, sheetName, chunkTargetTokens)
                for (const sliceContent of wideSlices) {
                  chunks.push({
                    chunkIndex: currentIndex++,
                    content: sliceContent,
                    tokenCount: estimateTokenCount(sliceContent),
                    pageNumber: null,
                    metadata: {
                      format: 'xlsx',
                      sourceBlockIds: [t.id],
                      primaryOrderIndexes: [t.orderIndex],
                      contentRole: 'table',
                      hasTable: true,
                      sheetName,
                      sheetIndex,
                      startRow: candidateRow.rowNumber,
                      endRow: candidateRow.rowNumber,
                      isWideRowPart: true,
                      isOversized: true,
                      chunkingStrategy: 'format-aware-universal-v1',
                      sourceLocation: t.location
                    },
                    chunkerVersion
                  })
                }
                rowIdx++
                break
              }

              const testRows = [...chunkRows, candidateRow]
              const startRowNum = testRows[0].rowNumber
              const endRowNum = testRows[testRows.length - 1].rowNumber
              const isSubsequentChunk = startRowIdx > 0

              const contextLines = [
                `[Spreadsheet Context]`,
                `Worksheet: ${sheetName}`,
                `Rows: ${startRowNum}–${endRowNum}`
              ]

              const chunkBodyLines: string[] = []
              if (isSubsequentChunk && tableHeaderPrefix) {
                chunkBodyLines.push(tableHeaderPrefix)
              }
              for (const r of testRows) {
                chunkBodyLines.push(r.rawText)
              }

              const candidateFullContent = `${contextLines.join('\n')}\n\n${chunkBodyLines.join('\n')}`
              const candidateTotalTokens = estimateTokenCount(candidateFullContent)

              if (candidateTotalTokens > chunkTargetTokens && chunkRows.length > 0) {
                break
              }

              chunkRows.push(candidateRow)
              rowIdx++
            }

            if (chunkRows.length > 0) {
              const startRowNum = chunkRows[0].rowNumber
              const endRowNum = chunkRows[chunkRows.length - 1].rowNumber
              const isSubsequentChunk = startRowIdx > 0

              const contextLines = [
                `[Spreadsheet Context]`,
                `Worksheet: ${sheetName}`,
                `Rows: ${startRowNum}–${endRowNum}`
              ]

              const chunkBodyLines: string[] = []
              if (isSubsequentChunk && tableHeaderPrefix) {
                chunkBodyLines.push(tableHeaderPrefix)
              }
              for (const r of chunkRows) {
                chunkBodyLines.push(r.rawText)
              }

              const finalContent = `${contextLines.join('\n')}\n\n${chunkBodyLines.join('\n')}`
              const finalTokens = estimateTokenCount(finalContent)

              chunks.push({
                chunkIndex: currentIndex++,
                content: finalContent,
                tokenCount: finalTokens,
                pageNumber: null,
                metadata: {
                  format: 'xlsx',
                  sourceBlockIds: [t.id],
                  primaryOrderIndexes: [t.orderIndex],
                  contentRole: 'table',
                  hasTable: true,
                  sheetName,
                  sheetIndex,
                  startRow: startRowNum,
                  endRow: endRowNum,
                  ...(isSubsequentChunk && tableHeaderPrefix
                    ? { repeatedHeader: true, isContextual: true }
                    : {}),
                  chunkingStrategy: 'format-aware-universal-v1',
                  sourceLocation: t.location
                },
                chunkerVersion
              })
            }
          }
        },
        paragraph: (p) => {
          if (p.text.trim().length > 0) {
            chunks.push({
              chunkIndex: currentIndex++,
              content: p.text,
              tokenCount: estimateTokenCount(p.text),
              pageNumber: null,
              metadata: {
                format: 'xlsx',
                sourceBlockIds: [p.id],
                primaryOrderIndexes: [p.orderIndex],
                contentRole: 'body',
                sheetName: currentSheetName,
                chunkingStrategy: 'format-aware-universal-v1',
                sourceLocation: p.location
              },
              chunkerVersion
            })
          } else {
            nonSearchableBlocks.push({
              blockId: p.id,
              blockType: 'paragraph',
              reason: 'empty paragraph in spreadsheet',
              orderIndex: p.orderIndex,
              location: p.location
            })
          }
        },
        heading: (h) => {
          nonSearchableBlocks.push({
            blockId: h.id,
            blockType: 'heading',
            reason: 'heading metadata in spreadsheet',
            orderIndex: h.orderIndex,
            location: h.location
          })
        },
        list: (l) => {
          nonSearchableBlocks.push({
            blockId: l.id,
            blockType: 'list',
            reason: 'unexpected list in spreadsheet',
            orderIndex: l.orderIndex,
            location: l.location
          })
        },
        code: (c) => {
          nonSearchableBlocks.push({
            blockId: c.id,
            blockType: 'code',
            reason: 'unexpected code in spreadsheet',
            orderIndex: c.orderIndex,
            location: c.location
          })
        },
        page_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'page_boundary',
            reason: 'unexpected page boundary in spreadsheet',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        slide_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'slide_boundary',
            reason: 'unexpected slide boundary in spreadsheet',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        image_reference: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'image_reference',
            reason: 'image or drawing in spreadsheet skipped during text extraction',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        unknown: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'unknown',
            reason: 'unsupported non-tabular element in spreadsheet',
            orderIndex: b.orderIndex,
            location: b.location
          })
        }
      })
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The spreadsheet contains no extractable data rows to chunk.'
      )
    }

    const totalTokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0)

    return {
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      chunkerVersion,
      nonSearchableBlocks
    }
  }

  /**
   * Legacy chunking implementation for backward compatibility with ExtractedDocument tests.
   */
  private chunkLegacy(doc: ExtractedDocument): ChunkingResult {
    if (doc.format !== 'xlsx' && doc.format !== 'csv') {
      throw DocumentErrors.extractionUnsupportedFormat(
        `SpreadsheetChunker expected 'xlsx' or 'csv' format, got '${doc.format}'`
      )
    }

    if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
      throw DocumentErrors.chunkingInvalidInput('Extracted document contains no sections to chunk.')
    }

    const settings = this.settingsProvider.getSettings()
    const { chunkTargetTokens, chunkOverlapTokens, chunkerVersion } = settings

    if (
      chunkTargetTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min ||
      chunkTargetTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkTargetTokens (${chunkTargetTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max}.`
      )
    }

    if (
      chunkOverlapTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min ||
      chunkOverlapTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkOverlapTokens (${chunkOverlapTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max}.`
      )
    }

    if (chunkOverlapTokens >= chunkTargetTokens) {
      throw DocumentErrors.configurationError(
        `chunkOverlapTokens (${chunkOverlapTokens}) must be strictly less than chunkTargetTokens (${chunkTargetTokens}).`
      )
    }

    const chunks: DocumentChunk[] = []
    let currentIndex = 0

    for (let sectionIdx = 0; sectionIdx < doc.sections.length; sectionIdx++) {
      const section: ExtractedDocumentSection = doc.sections[sectionIdx]
      const normalizedSectionText = normalizeText(section.text).trim()
      if (normalizedSectionText.length === 0) {
        continue
      }

      const {
        sheetName: parsedSheetName,
        headerRow,
        rows
      } = parseSectionRows(normalizedSectionText)
      const sheetName =
        section.heading?.replace(/^Sheet:\s*/i, '').trim() ||
        parsedSheetName ||
        `Sheet${sectionIdx + 1}`

      if (rows.length === 0) {
        continue
      }

      const hasTable = headerRow !== undefined
      const tableHeaderPrefix =
        hasTable && headerRow
          ? `[Table Header: ${headerRow.rawText.replace(/^Row\s+\d+\s*\|\s*/i, '')}]`
          : ''

      let rowIdx = 0
      while (rowIdx < rows.length) {
        const startRowIdx = rowIdx
        const chunkRows: ParsedSpreadsheetRow[] = []

        while (rowIdx < rows.length) {
          const candidateRow = rows[rowIdx]

          if (candidateRow.tokenCount > chunkTargetTokens) {
            if (chunkRows.length > 0) {
              break
            }

            const wideSlices = sliceWideRow(candidateRow, sheetName, chunkTargetTokens)
            for (const sliceContent of wideSlices) {
              chunks.push({
                chunkIndex: currentIndex++,
                content: sliceContent,
                tokenCount: estimateTokenCount(sliceContent),
                pageNumber: null,
                metadata: {
                  sheetName,
                  startRow: candidateRow.rowNumber,
                  endRow: candidateRow.rowNumber,
                  hasTable,
                  isWideRowSlice: true
                },
                chunkerVersion
              })
            }
            rowIdx++
            break
          }

          const testRows = [...chunkRows, candidateRow]
          const startRowNum = testRows[0].rowNumber
          const endRowNum = testRows[testRows.length - 1].rowNumber
          const isSubsequentChunk = startRowIdx > 0

          const contextLines = [
            `[Spreadsheet Context]`,
            `Worksheet: ${sheetName} (Sheet ${sectionIdx + 1})`,
            `Rows: ${startRowNum}–${endRowNum}`
          ]

          const chunkBodyLines: string[] = []
          if (isSubsequentChunk && tableHeaderPrefix) {
            chunkBodyLines.push(tableHeaderPrefix)
          }
          for (const r of testRows) {
            chunkBodyLines.push(r.rawText)
          }

          const candidateFullContent = `${contextLines.join('\n')}\n\n${chunkBodyLines.join('\n')}`
          const candidateTotalTokens = estimateTokenCount(candidateFullContent)

          if (candidateTotalTokens > chunkTargetTokens && chunkRows.length > 0) {
            break
          }

          chunkRows.push(candidateRow)
          rowIdx++
        }

        if (chunkRows.length > 0) {
          const startRowNum = chunkRows[0].rowNumber
          const endRowNum = chunkRows[chunkRows.length - 1].rowNumber
          const isSubsequentChunk = startRowIdx > 0

          const contextLines = [
            `[Spreadsheet Context]`,
            `Worksheet: ${sheetName} (Sheet ${sectionIdx + 1})`,
            `Rows: ${startRowNum}–${endRowNum}`
          ]

          const chunkBodyLines: string[] = []
          if (isSubsequentChunk && tableHeaderPrefix) {
            chunkBodyLines.push(tableHeaderPrefix)
          }
          for (const r of chunkRows) {
            chunkBodyLines.push(r.rawText)
          }

          const finalContent = `${contextLines.join('\n')}\n\n${chunkBodyLines.join('\n')}`
          const finalTokens = estimateTokenCount(finalContent)

          chunks.push({
            chunkIndex: currentIndex++,
            content: finalContent,
            tokenCount: finalTokens,
            pageNumber: null,
            metadata: {
              sheetName,
              sheetIndex: sectionIdx + 1,
              startRow: startRowNum,
              endRow: endRowNum,
              hasTable,
              headingPath: [sheetName],
              headingContext: sheetName,
              ...(isSubsequentChunk && tableHeaderPrefix ? { repeatedHeader: true } : {})
            },
            chunkerVersion
          })
        }
      }
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The document contains no extractable spreadsheet rows to chunk.'
      )
    }

    const totalTokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0)

    return {
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      chunkerVersion
    }
  }
}
