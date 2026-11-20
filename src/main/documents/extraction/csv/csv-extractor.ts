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
import { getExcelColumnName } from '../xlsx/xlsx-extractor'
import type { UniversalTableCell } from '../../model/types'

/**
 * Options for parsing CSV text streams.
 */
export interface CsvParseOptions {
  readonly delimiter?: string
  readonly maxRows?: number
}

/**
 * Extractor-specific options for CSV processing.
 */
export interface CsvExtractorOptions {
  /**
   * Explicit header configuration:
   * - true: First row is explicitly treated as authoritative headers.
   * - false: First row is explicitly treated as data (no header).
   * - undefined: No explicit header configuration (default). First row is preserved as ordinary data,
   *   headerState is 'unknown', and heuristic suggestion is recorded in metadata.
   */
  readonly hasHeader?: boolean
}

/**
 * Parsed raw CSV cell item.
 */
export interface ParsedCsvCell {
  readonly value: string
  readonly rawValue: unknown
  readonly rowIndex: number
  readonly columnIndex: number
  readonly coordinate: string
}

/**
 * Result emitted by the streaming RFC 4180 parser.
 */
export interface ParsedCsvData {
  readonly rows: readonly (readonly string[])[]
  readonly cells: readonly (readonly UniversalTableCell[])[]
  readonly columnCount: number
  readonly rowCount: number
  readonly isRagged: boolean
  readonly raggedRowIndices: readonly number[]
  readonly hasUnclosedQuote: boolean
}

/**
 * Decodes raw bytes to string handling UTF-8, UTF-8 BOM, UTF-16LE BOM, and UTF-16BE BOM.
 * Uses fatal decoding mode so invalid or unsupported encodings throw an explicit
 * DocumentExtractionError instead of introducing silent replacement characters.
 */
export function decodeCsvBytes(bytes: Uint8Array | Buffer): { text: string; encoding: string } {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // UTF-8 with BOM
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      return { text: decoder.decode(buf.subarray(3)), encoding: 'utf-8-bom' }
    } catch {
      throw DocumentErrors.extractionInvalidUtf8(
        'CSV content with UTF-8 BOM contains invalid UTF-8 bytes.'
      )
    }
  }

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16 LE
    try {
      const decoder = new TextDecoder('utf-16le', { fatal: true })
      return { text: decoder.decode(buf.subarray(2)), encoding: 'utf-16le' }
    } catch {
      throw DocumentErrors.extractionInvalidUtf8(
        'CSV content with UTF-16LE BOM contains invalid UTF-16LE bytes.'
      )
    }
  }

  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE: swap byte pairs to decode with fatal utf-16le
    const swapped = Buffer.alloc(buf.length - 2)
    for (let i = 2; i < buf.length; i += 2) {
      if (i + 1 < buf.length) {
        swapped[i - 2] = buf[i + 1]
        swapped[i - 1] = buf[i]
      }
    }
    try {
      const decoder = new TextDecoder('utf-16le', { fatal: true })
      return { text: decoder.decode(swapped), encoding: 'utf-16be' }
    } catch {
      throw DocumentErrors.extractionInvalidUtf8(
        'CSV content with UTF-16BE BOM contains invalid UTF-16BE bytes.'
      )
    }
  }

  // Standard UTF-8 with fatal check to prevent silent replacement characters
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return { text: decoder.decode(buf), encoding: 'utf-8' }
  } catch {
    throw DocumentErrors.extractionInvalidUtf8(
      'CSV content contains invalid UTF-8 bytes and cannot be decoded safely.'
    )
  }
}

/**
 * High-performance, streaming RFC 4180 state-machine CSV parser.
 *
 * Guarantees:
 * 1. Strict RFC 4180 parsing for quoted fields, double-quote escaping (""), and delimiters.
 * 2. Full multiline field preservation across CRLF and LF.
 * 3. Handles empty fields, trailing delimiters, and whitespace cleanly.
 * 4. Deterministic sparse coordinate calculation (A1, B2, ...).
 * 5. Detection of ragged rows with row-index tracking.
 * 6. Non-fatal recovery for malformed/unclosed quotes with explicit warning and quality flagging.
 */
export function parseRfc4180Csv(content: string, options?: CsvParseOptions): ParsedCsvData {
  const delimiter = options?.delimiter ?? ','
  const maxRows = options?.maxRows ?? 1_000_000

  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false
  let i = 0
  const len = content.length

  while (i < len) {
    const char = content[i]

    if (inQuotes) {
      if (char === '"') {
        // Lookahead for escaped quote ("")
        if (i + 1 < len && content[i + 1] === '"') {
          currentField += '"'
          i += 2
          continue
        } else {
          // Closing quote
          inQuotes = false
          i++
          continue
        }
      } else {
        // Any character inside quotes (including \r, \n, commas, unicode) is literal
        currentField += char
        i++
        continue
      }
    } else {
      // Outside quotes
      if (char === '"') {
        inQuotes = true
        i++
        continue
      } else if (char === delimiter) {
        currentRow.push(currentField)
        currentField = ''
        i++
        continue
      } else if (char === '\r') {
        // Handle CRLF or standalone CR
        if (i + 1 < len && content[i + 1] === '\n') {
          i++
        }
        currentRow.push(currentField)
        currentField = ''
        rows.push(currentRow)
        currentRow = []
        i++
        if (rows.length >= maxRows) break
        continue
      } else if (char === '\n') {
        // Standalone LF
        currentRow.push(currentField)
        currentField = ''
        rows.push(currentRow)
        currentRow = []
        i++
        if (rows.length >= maxRows) break
        continue
      } else {
        currentField += char
        i++
        continue
      }
    }
  }

  const hasUnclosedQuote = inQuotes

  // Handle remaining field and row at EOF
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField)
    rows.push(currentRow)
  }

  // If the last row is entirely empty due to trailing newline, ignore it
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop()
  }

  // Calculate maximum column count across all rows
  let maxColCount = 0
  for (const r of rows) {
    if (r.length > maxColCount) {
      maxColCount = r.length
    }
  }

  const raggedRowIndices: number[] = []
  const cells: UniversalTableCell[][] = []

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx]
    if (row.length !== maxColCount) {
      raggedRowIndices.push(rIdx + 1)
    }

    const rowCells: UniversalTableCell[] = []
    for (let cIdx = 0; cIdx < maxColCount; cIdx++) {
      const val = cIdx < row.length ? row[cIdx] : ''
      const coordinate = `${getExcelColumnName(cIdx)}${rIdx + 1}`

      // Infer raw typed value if number or boolean
      let rawVal: unknown = val
      const trimmed = val.trim()
      if (trimmed === 'TRUE' || trimmed === 'true') {
        rawVal = true
      } else if (trimmed === 'FALSE' || trimmed === 'false') {
        rawVal = false
      } else if (trimmed.length > 0 && !isNaN(Number(trimmed)) && !trimmed.startsWith('0x')) {
        rawVal = Number(trimmed)
      }

      rowCells.push({
        value: val,
        rawValue: rawVal,
        coordinate,
        rowIndex: rIdx,
        columnIndex: cIdx
      })
    }
    cells.push(rowCells)
  }

  return {
    rows,
    cells,
    columnCount: maxColCount,
    rowCount: rows.length,
    isRagged: raggedRowIndices.length > 0,
    raggedRowIndices,
    hasUnclosedQuote
  }
}

/**
 * Non-authoritative heuristic to suggest whether row 0 resembles a header row.
 * Exposes a suggestion in metadata only; MUST NOT automatically classify row 0 as an actual header.
 */
export function detectHeaderRowHeuristic(rows: readonly (readonly string[])[]): {
  readonly suggestedHasHeader: boolean
  readonly suggestedHeaders: string[]
} {
  if (rows.length === 0) {
    return { suggestedHasHeader: false, suggestedHeaders: [] }
  }

  const firstRow = rows[0]
  if (rows.length === 1) {
    return {
      suggestedHasHeader: false,
      suggestedHeaders: firstRow.map((col, idx) =>
        col.trim().length > 0 ? col.trim() : `Column ${idx + 1}`
      )
    }
  }

  // If first row has cells and any subsequent row has different type pattern
  // Check if row 1 is entirely non-empty text strings
  const row1IsText = firstRow.every(
    (cell) => isNaN(Number(cell.trim())) || cell.trim().length === 0
  )
  const row2HasNumbers = rows[1]?.some(
    (cell) => !isNaN(Number(cell.trim())) && cell.trim().length > 0
  )

  if (row1IsText && row2HasNumbers) {
    return {
      suggestedHasHeader: true,
      suggestedHeaders: firstRow.map((col, idx) =>
        col.trim().length > 0 ? col.trim() : `Column ${idx + 1}`
      )
    }
  }

  // Treat row 1 as likely headers if not purely numeric
  const allNumeric = firstRow.every((cell) => !isNaN(Number(cell.trim())) && cell.trim().length > 0)
  if (!allNumeric) {
    return {
      suggestedHasHeader: true,
      suggestedHeaders: firstRow.map((col, idx) =>
        col.trim().length > 0 ? col.trim() : `Column ${idx + 1}`
      )
    }
  }

  // Purely numeric: generic column names
  return {
    suggestedHasHeader: false,
    suggestedHeaders: firstRow.map((_, idx) => getExcelColumnName(idx))
  }
}

/**
 * Backward-compatible alias for existing imports.
 */
export function detectHeaderRow(rows: readonly (readonly string[])[]): {
  hasHeader: boolean
  headers: string[]
} {
  const result = detectHeaderRowHeuristic(rows)
  return {
    hasHeader: result.suggestedHasHeader,
    headers: result.suggestedHeaders
  }
}

/**
 * High-fidelity, pure-JavaScript RFC 4180 CSV document extractor.
 *
 * Conforms to Step 11.7 requirements:
 * 1. RFC 4180 state-machine parsing with escaped quotes, commas, CRLF/LF, and multiline fields.
 * 2. Character encoding resilience: UTF-8, UTF-8 BOM, UTF-16LE, and UTF-16BE.
 * 3. Preserves sparse cell coordinates (A1, B2) without alignment drift.
 * 4. Preserves Bengali Unicode and Emojis verbatim.
 * 5. Detects and reports ragged rows without dropping data.
 * 6. Generates canonical UniversalTableBlock and sheet_boundary blocks.
 * 7. Emits structured text sections compatible with SpreadsheetChunker and FTS5 search.
 * 8. Strict non-authoritative header semantics: default extraction preserves first row as data.
 */
export class CsvExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'csv-extractor',
    name: 'RFC 4180 CSV Spreadsheet Extractor',
    version: '1.0.0',
    supportedFormats: ['csv'],
    supportedMimeTypes: ['text/csv', 'application/csv', 'text/comma-separated-values'],
    isHeavy: false,
    requiresUtilityProcess: false
  }

  public supports(format: string): boolean {
    const normalized = normalizeFormatExtension(format)
    return this.metadata.supportedFormats.includes(normalized)
  }

  public async extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext,
    options?: CsvExtractorOptions
  ): Promise<DocumentExtractionResult> {
    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    if (!request.bytes || request.bytes.length === 0) {
      throw DocumentErrors.extractionEmptyContent('CSV document content is empty.')
    }

    const { text, encoding } = decodeCsvBytes(request.bytes)
    if (text.trim().length === 0) {
      throw DocumentErrors.extractionEmptyContent('CSV document contains no text content.')
    }

    // 1. Parse CSV structure via RFC 4180 state machine
    const parsed = parseRfc4180Csv(text)

    if (parsed.rowCount === 0 || parsed.columnCount === 0) {
      throw DocumentErrors.extractionNoTextContent(
        'CSV document contains no readable rows or columns.'
      )
    }

    const warnings: DocumentExtractionWarning[] = []

    if (parsed.isRagged) {
      warnings.push({
        code: 'RAGGED_ROWS_DETECTED',
        message: `CSV contains inconsistent column counts in rows: ${parsed.raggedRowIndices.slice(0, 10).join(', ')}${parsed.raggedRowIndices.length > 10 ? '...' : ''}. Shorter rows were padded to ${parsed.columnCount} columns.`
      })
    }

    if (parsed.hasUnclosedQuote) {
      warnings.push({
        code: 'MALFORMED_CSV_UNCLOSED_QUOTE',
        message:
          'CSV file contains an unclosed quotation mark. The unclosed field was recovered up to EOF without discarding records.'
      })
    }

    // 2. Resolve Header Semantics
    // Priority: explicit options.hasHeader > request.options.hasHeader > request.metadata.hasHeader > default (undefined)
    const explicitHeader =
      options?.hasHeader !== undefined
        ? options.hasHeader
        : request.options?.hasHeader !== undefined
          ? Boolean(request.options.hasHeader)
          : typeof request.metadata?.hasHeader === 'boolean'
            ? (request.metadata.hasHeader as boolean)
            : undefined

    const heuristic = detectHeaderRowHeuristic(parsed.rows)

    let headerState: 'known' | 'absent' | 'unknown'
    let authoritativeHasHeader: boolean
    let tableHeaders: string[]

    if (explicitHeader === true) {
      headerState = 'known'
      authoritativeHasHeader = true
      tableHeaders = parsed.rows.length > 0 ? [...parsed.rows[0]] : []
    } else if (explicitHeader === false) {
      headerState = 'absent'
      authoritativeHasHeader = false
      tableHeaders = []
    } else {
      // Default: No explicit header configuration.
      // Must preserve the first row as ordinary data.
      // Do not silently infer a header.
      headerState = 'unknown'
      authoritativeHasHeader = false
      tableHeaders = []
    }

    // Update cells isHeader flag if authoritative header is configured
    if (authoritativeHasHeader && parsed.cells.length > 0) {
      for (const cell of parsed.cells[0]) {
        ;(cell as { isHeader?: boolean }).isHeader = true
      }
    }

    // 3. Build structured blocks
    const sheetName = 'CSV Document'
    const sheetIndex = 1

    const blocks: ExtractedDocumentBlock[] = []

    // Sheet boundary block
    blocks.push({
      type: 'sheet_boundary',
      text: `Sheet: ${sheetName}`,
      sheet: {
        name: sheetName,
        index: sheetIndex
      },
      metadata: {
        sheetIndex,
        sheetName,
        encoding
      }
    })

    // Format section lines compatible with SpreadsheetChunker
    const rowLines: string[] = []
    rowLines.push(`# Sheet: ${sheetName} (Sheet ${sheetIndex})`)
    if (!authoritativeHasHeader) {
      rowLines.push('# Header: None')
    }

    for (let rIdx = 0; rIdx < parsed.cells.length; rIdx++) {
      const rowNum = rIdx + 1
      const cellParts: string[] = []
      for (const cell of parsed.cells[rIdx]) {
        if (cell.value.trim().length > 0) {
          cellParts.push(`${cell.coordinate}: ${cell.value}`)
        }
      }
      if (cellParts.length > 0) {
        rowLines.push(`Row ${rowNum} | ${cellParts.join(' | ')}`)
      }
    }

    const formattedTableText = rowLines.join('\n')

    // When authoritative header is true, data rows are rows.slice(1).
    // When authoritative header is false or unknown, all rows are preserved as data rows.
    const tableDataRows =
      authoritativeHasHeader && parsed.rows.length > 1 ? parsed.rows.slice(1) : parsed.rows

    // Table block
    blocks.push({
      type: 'table',
      text: formattedTableText,
      table: {
        headers: tableHeaders,
        rows: tableDataRows,
        caption: sheetName
      },
      sheet: {
        name: sheetName,
        index: sheetIndex
      },
      metadata: {
        sheetName,
        sheetIndex,
        isSpreadsheet: true,
        headerState,
        hasHeader: authoritativeHasHeader,
        heuristicHeaderSuggestion: heuristic.suggestedHasHeader,
        suggestedHeaders: heuristic.suggestedHeaders,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        cells: parsed.cells
      }
    })

    const fullText = formattedTableText

    return {
      format: 'csv',
      text: fullText,
      blocks,
      metadata: {
        encoding,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        isRagged: parsed.isRagged,
        sheetCount: 1,
        headerState,
        hasHeader: authoritativeHasHeader,
        heuristicHeaderSuggestion: heuristic.suggestedHasHeader
      },
      warnings,
      quality: {
        fidelity: parsed.hasUnclosedQuote ? 'medium' : 'high',
        isLossy: parsed.hasUnclosedQuote,
        isOcr: false,
        hasUnparsedElements: parsed.hasUnclosedQuote || parsed.isRagged
      },
      extractor: this.metadata
    }
  }
}
