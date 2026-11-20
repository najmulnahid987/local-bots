import readXlsxFile, { type Row } from 'read-excel-file/node'
import { DocumentErrors } from '../../document-errors'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult,
  DocumentExtractionWarning,
  ExtractedDocumentBlock
} from '../types'
import { normalizeFormatExtension } from '../format-detector'
import { XlsxArchiveValidator } from './xlsx-archive-validator'

/**
 * Converts a 0-based column index to standard Excel column letters (A, B, ..., Z, AA, AB, ...).
 */
export function getExcelColumnName(colIndex: number): string {
  let dividend = colIndex + 1
  let columnName = ''
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26
    columnName = String.fromCharCode(65 + modulo) + columnName
    dividend = Math.floor((dividend - modulo) / 26)
  }
  return columnName
}

/**
 * Formats an arbitrary cell value into a clean, deterministic string representation.
 */
export function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) {
    return ''
  }
  if (val instanceof Date) {
    // Preserve date in deterministic ISO format
    const iso = val.toISOString()
    // If midnight UTC, emit YYYY-MM-DD
    if (iso.endsWith('T00:00:00.000Z')) {
      return iso.slice(0, 10)
    }
    return iso
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE'
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : ''
  }
  return String(val)
}

/**
 * High-fidelity, secure Microsoft Excel (.xlsx) spreadsheet extractor using
 * read-excel-file and defensive OpenXML ZIP preflight audit.
 *
 * Guarantees:
 * 1. Executes XlsxArchiveValidator preflight audit on bytes to guarantee ZIP and XML safety.
 * 2. Parses all sheets preserving sheet names, ordering, row numbers, and cell coordinates (A1, B2).
 * 3. Preserves sparse cells and empty gaps without shifting column alignments.
 * 4. Extracts dates deterministically without converting ordinary numbers to dates.
 * 5. Uses cached formula values if available without calculating formulas or executing macros.
 * 6. Emits structured ExtractedDocumentBlock items (sheet boundaries, tables, paragraphs).
 * 7. Enforces fail-closed execution in an isolated Electron utility process.
 */
export class XlsxExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'xlsx-extractor',
    name: 'Microsoft Excel Spreadsheet Extractor',
    version: '1.0.0',
    supportedFormats: ['xlsx'],
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.template'
    ],
    isHeavy: true,
    requiresUtilityProcess: true
  }

  public supports(format: string): boolean {
    const normalized = normalizeFormatExtension(format)
    return this.metadata.supportedFormats.includes(normalized)
  }

  public async extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    const buf = Buffer.isBuffer(request.bytes) ? request.bytes : Buffer.from(request.bytes)

    // 1. Mandatory Defensive Archive Preflight Audit
    const preflight = XlsxArchiveValidator.validate(buf, {
      maxCompressedBytes: context?.limits.maxInputSizeBytes
    })

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 2. Parse all worksheets via readXlsxFile
    let sheets: { sheet: string; data: Row[] }[]
    try {
      const parsedSheets = await readXlsxFile(buf, {
        dateFormat: 'yyyy-mm-dd'
      })
      sheets = parsedSheets as unknown as { sheet: string; data: Row[] }[]
    } catch (parseErr) {
      throw DocumentErrors.extractionInvalidArchive(
        `Failed to parse workbook sheets: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      )
    }

    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw DocumentErrors.extractionNoTextContent('The workbook contains no readable worksheets.')
    }

    const blocks: ExtractedDocumentBlock[] = []
    const warnings: DocumentExtractionWarning[] = []
    const textSections: string[] = []
    let totalPopulatedCells = 0
    let totalPopulatedRows = 0

    // 3. Extract data sheet by sheet
    for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
      if (context?.signal?.aborted) {
        throw DocumentErrors.extractionCancelled()
      }

      const sheetEntry = sheets[sheetIdx]
      const sheetName = sheetEntry.sheet
      const rows = sheetEntry.data ?? []

      // Add sheet boundary block
      blocks.push({
        type: 'sheet_boundary',
        text: `Sheet: ${sheetName}`,
        sheet: {
          name: sheetName,
          index: sheetIdx + 1
        },
        metadata: {
          sheetIndex: sheetIdx + 1,
          sheetName
        }
      })

      // Check if sheet has any populated cells
      const populatedRowsWithIndices: { rowIndex: number; row: Row }[] = []
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]
        if (
          Array.isArray(row) &&
          row.some((cell) => cell !== null && cell !== undefined && cell !== '')
        ) {
          populatedRowsWithIndices.push({ rowIndex: r + 1, row })
        }
      }

      if (populatedRowsWithIndices.length === 0) {
        warnings.push({
          code: 'EMPTY_SHEET_DETECTED',
          message: `Worksheet "${sheetName}" is empty and contains no populated cells.`
        })
        textSections.push(`# Sheet: ${sheetName} (Sheet ${sheetIdx + 1})\n\n[Empty Worksheet]`)
        continue
      }

      totalPopulatedRows += populatedRowsWithIndices.length

      // Detect table structure
      // A table is recognized when row 1 has at least 2 non-empty string headers
      // and there are subsequent populated rows
      let hasTable = false
      let tableHeaders: string[] = []
      const firstRowEntry = populatedRowsWithIndices[0]

      if (
        firstRowEntry.rowIndex === 1 &&
        populatedRowsWithIndices.length >= 2 &&
        firstRowEntry.row.filter((c) => typeof c === 'string' && c.trim().length > 0).length >= 2
      ) {
        hasTable = true
        // Fill table headers, using coordinate name fallback for sparse header cells
        const maxCols = Math.max(...populatedRowsWithIndices.map((p) => p.row.length))
        tableHeaders = []
        for (let c = 0; c < maxCols; c++) {
          const headerVal = formatCellValue(firstRowEntry.row[c])
          tableHeaders.push(headerVal.length > 0 ? headerVal : getExcelColumnName(c))
        }
      }

      // Build sheet text representation and blocks
      const sheetLines: string[] = [`# Sheet: ${sheetName} (Sheet ${sheetIdx + 1})`]
      const tableRowData: string[][] = []

      for (const { rowIndex, row } of populatedRowsWithIndices) {
        const cellParts: string[] = []
        const rowValues: string[] = []

        for (let c = 0; c < row.length; c++) {
          const cell = row[c]
          if (cell !== null && cell !== undefined && cell !== '') {
            totalPopulatedCells++
            const colLetter = getExcelColumnName(c)
            const cellCoord = `${colLetter}${rowIndex}`
            const formatted = formatCellValue(cell)
            cellParts.push(`${cellCoord}: ${formatted}`)
            rowValues.push(formatted)
          } else {
            rowValues.push('')
          }
        }

        if (cellParts.length > 0) {
          sheetLines.push(`Row ${rowIndex} | ${cellParts.join(' | ')}`)
        }

        // If table row after header
        if (hasTable && rowIndex > 1) {
          tableRowData.push(rowValues)
        }
      }

      const sheetText = sheetLines.join('\n')
      textSections.push(sheetText)

      if (hasTable && tableHeaders.length > 0) {
        blocks.push({
          type: 'table',
          text: sheetText,
          table: {
            headers: tableHeaders,
            rows: tableRowData,
            caption: `Sheet: ${sheetName}`
          },
          metadata: {
            sheetName,
            sheetIndex: sheetIdx + 1,
            rowCount: populatedRowsWithIndices.length,
            hasTable: true
          }
        })
      } else {
        blocks.push({
          type: 'paragraph',
          text: sheetText,
          metadata: {
            sheetName,
            sheetIndex: sheetIdx + 1,
            rowCount: populatedRowsWithIndices.length,
            hasTable: false
          }
        })
      }
    }

    if (totalPopulatedCells === 0) {
      throw DocumentErrors.extractionNoTextContent(
        'The spreadsheet contains no extractable cell values or text content.'
      )
    }

    const fullText = textSections.join('\n\n')

    // Enforce output size limit
    const textBytes = Buffer.byteLength(fullText, 'utf-8')
    if (context?.limits?.maxOutputSizeBytes && textBytes > context.limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(
        context.limits.maxOutputSizeBytes,
        textBytes
      )
    }

    // Informational warning regarding cached formula values
    warnings.push({
      code: 'SPREADSHEET_FORMULA_POLICY',
      message:
        'Formula cells return precomputed cached values without local formula recalculation or external workbook linking.'
    })

    return {
      format: 'xlsx',
      text: fullText,
      blocks,
      metadata: {
        sheetCount: sheets.length,
        totalPopulatedRows,
        totalPopulatedCells,
        sheetNames: sheets.map((s) => s.sheet),
        entryCount: preflight.entryCount,
        totalUncompressedSize: preflight.totalUncompressedSize
      },
      warnings,
      quality: {
        fidelity: 'high',
        isLossy: false,
        isOcr: false
      },
      extractor: this.metadata
    }
  }
}
