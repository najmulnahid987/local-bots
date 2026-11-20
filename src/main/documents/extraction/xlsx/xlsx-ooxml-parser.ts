import { DOMParser } from '@xmldom/xmldom'
import { DocumentErrors } from '../../document-errors'
import type {
  ExtractedDocumentBlock,
  DocumentExtractionWarning,
  DocumentExtractionResult
} from '../types'
import { XlsxArchiveValidator, type XlsxPackage } from './xlsx-archive-validator'
import type { UniversalTableCell } from '../../model/types'

/**
 * Converts standard Excel column letters (A, B, ..., Z, AA, AB, ...) to a 0-based column index.
 */
export function excelColumnNameToIndex(colName: string): number {
  let index = 0
  const upper = colName.toUpperCase()
  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 64)
  }
  return index - 1
}

/**
 * Converts a 0-based column index to standard Excel column letters.
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
 * Parses an Excel cell coordinate (e.g. "B12") into row and column indices.
 */
export function parseExcelCellCoordinate(coordinate: string): {
  rowIndex: number // 0-based
  columnIndex: number // 0-based
  rowNumber: number // 1-based
  columnName: string
} {
  const match = coordinate.match(/^([A-Za-z]+)(\d+)$/)
  if (!match) {
    return { rowIndex: 0, columnIndex: 0, rowNumber: 1, columnName: 'A' }
  }
  const columnName = match[1].toUpperCase()
  const rowNumber = parseInt(match[2], 10)
  return {
    rowIndex: rowNumber - 1,
    columnIndex: excelColumnNameToIndex(columnName),
    rowNumber,
    columnName
  }
}

/**
 * Converts an Excel serial date number to an ISO string.
 */
export function excelSerialDateToIso(serial: number, date1904 = false): string {
  if (!Number.isFinite(serial) || serial < 0) {
    return String(serial)
  }
  const epochOffset = date1904 ? 24107 : 25569
  const adjustedSerial = !date1904 && serial < 60 ? serial + 1 : serial
  const utcMillis = Math.round((adjustedSerial - epochOffset) * 86400 * 1000)
  const date = new Date(utcMillis)
  if (isNaN(date.getTime())) {
    return String(serial)
  }
  const iso = date.toISOString()
  if (iso.endsWith('T00:00:00.000Z')) {
    return iso.slice(0, 10)
  }
  return iso
}

interface WorksheetSheetInfo {
  readonly name: string
  readonly sheetId: number
  readonly state: 'visible' | 'hidden' | 'veryHidden'
  readonly targetPath: string
}

interface XlsxStyleInfo {
  readonly numFmtId: number
  readonly formatCode?: string
  readonly isDate: boolean
}

/**
 * High-fidelity OpenXML Excel (.xlsx) Parser.
 *
 * Implements full coverage of Step 11.7 requirements:
 * 1. Workbook metadata: sheets, order, state (visible/hidden/veryHidden), date1904 flag.
 * 2. Shared string resolution (plain <t> and rich text <r><t>).
 * 3. Styles & Number formats (dates, currencies, percentages, custom formats).
 * 4. Cell coordinates: sparse real coordinates (A1, B2) without column collapsing.
 * 5. Formulas & Cached values: formula expression (=SUM(B2:B10)) preserved independently from cached value.
 * 6. Merged cells: rowSpan and colSpan calculation.
 * 7. Hyperlinks and cell comments/notes.
 * 8. DrawingML images and chart elements (UniversalImageReferenceBlock with explicit warnings).
 * 9. Bengali Unicode and emojis preserved verbatim.
 */
export class XlsxOoxmlParser {
  private readonly parser = new DOMParser()

  /**
   * Parses an XLSX buffer into a high-fidelity DocumentExtractionResult.
   */
  public parse(
    bytes: Uint8Array | Buffer,
    options?: { maxCompressedBytes?: number }
  ): DocumentExtractionResult {
    const pkg: XlsxPackage = XlsxArchiveValidator.openPackage(bytes, {
      maxCompressedBytes: options?.maxCompressedBytes
    })

    const warnings: DocumentExtractionWarning[] = []

    // 1. Parse xl/workbook.xml & workbook rels
    const workbookXml = pkg.getEntryText('xl/workbook.xml')
    if (!workbookXml) {
      throw DocumentErrors.extractionMissingXlsxParts(['xl/workbook.xml'])
    }

    const wbDoc = this.parser.parseFromString(workbookXml, 'text/xml')

    // Detect date1904 flag
    let date1904 = false
    const workbookPrNodes = wbDoc.getElementsByTagName('workbookPr')
    if (workbookPrNodes.length > 0) {
      const pr = workbookPrNodes[0]
      const val = pr.getAttribute('date1904')
      if (val === '1' || val === 'true') {
        date1904 = true
      }
    }

    // Resolve sheet relationships via xl/_rels/workbook.xml.rels
    const wbRelsMap = new Map<string, string>()
    const wbRelsXml = pkg.getEntryText('xl/_rels/workbook.xml.rels')
    if (wbRelsXml) {
      const relsDoc = this.parser.parseFromString(wbRelsXml, 'text/xml')
      const relNodes = relsDoc.getElementsByTagName('Relationship')
      for (let i = 0; i < relNodes.length; i++) {
        const id = relNodes[i].getAttribute('Id')
        const target = relNodes[i].getAttribute('Target')
        if (id && target) {
          // Normalize relative path
          const normalizedTarget = target.startsWith('/')
            ? target.slice(1)
            : target.startsWith('xl/')
              ? target
              : `xl/${target}`
          wbRelsMap.set(id, normalizedTarget)
        }
      }
    }

    // Parse sheets list
    const sheetNodes = wbDoc.getElementsByTagName('sheet')
    const sheets: WorksheetSheetInfo[] = []

    for (let i = 0; i < sheetNodes.length; i++) {
      const node = sheetNodes[i]
      const name = node.getAttribute('name') ?? `Sheet${i + 1}`
      const sheetId = parseInt(node.getAttribute('sheetId') ?? String(i + 1), 10)
      const rawState = node.getAttribute('state') ?? 'visible'
      const state =
        rawState === 'hidden' || rawState === 'veryHidden'
          ? (rawState as 'hidden' | 'veryHidden')
          : 'visible'
      const rId =
        node.getAttribute('r:id') ??
        node.getAttribute(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships:id'
        ) ??
        `rId${i + 1}`

      const targetPath = wbRelsMap.get(rId) ?? `xl/worksheets/sheet${i + 1}.xml`
      sheets.push({ name, sheetId, state, targetPath })
    }

    if (sheets.length === 0) {
      throw DocumentErrors.extractionNoTextContent('The workbook contains no readable worksheets.')
    }

    // 2. Parse Shared Strings (xl/sharedStrings.xml)
    const sharedStrings: string[] = []
    const sstXml = pkg.getEntryText('xl/sharedStrings.xml')
    if (sstXml) {
      const sstDoc = this.parser.parseFromString(sstXml, 'text/xml')
      const siNodes = sstDoc.getElementsByTagName('si')
      for (let i = 0; i < siNodes.length; i++) {
        const si = siNodes[i]
        let itemText = ''
        const tNodes = si.getElementsByTagName('t')
        for (let j = 0; j < tNodes.length; j++) {
          itemText += tNodes[j].textContent ?? ''
        }
        sharedStrings.push(itemText)
      }
    }

    // 3. Parse Styles (xl/styles.xml)
    const customNumFmts = new Map<number, string>()
    const cellStyles: XlsxStyleInfo[] = []
    const stylesXml = pkg.getEntryText('xl/styles.xml')
    if (stylesXml) {
      const stylesDoc = this.parser.parseFromString(stylesXml, 'text/xml')

      // Number formats
      const numFmtNodes = stylesDoc.getElementsByTagName('numFmt')
      for (let i = 0; i < numFmtNodes.length; i++) {
        const numFmtId = parseInt(numFmtNodes[i].getAttribute('numFmtId') ?? '0', 10)
        const formatCode = numFmtNodes[i].getAttribute('formatCode') ?? ''
        if (numFmtId > 0 && formatCode) {
          customNumFmts.set(numFmtId, formatCode)
        }
      }

      // Cell XFs
      const xfNodes = stylesDoc.getElementsByTagName('xf')
      for (let i = 0; i < xfNodes.length; i++) {
        const numFmtId = parseInt(xfNodes[i].getAttribute('numFmtId') ?? '0', 10)
        const customCode = customNumFmts.get(numFmtId)
        const isBuiltInDate =
          (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47)
        const isCustomDate = customCode !== undefined && /[ymdhs]/i.test(customCode)
        cellStyles.push({
          numFmtId,
          formatCode: customCode,
          isDate: isBuiltInDate || isCustomDate
        })
      }
    }

    // 4. Process each worksheet
    const blocks: ExtractedDocumentBlock[] = []
    const textSections: string[] = []
    let totalCells = 0
    let totalRows = 0

    for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
      const sheet = sheets[sheetIdx]
      const sheetPath = sheet.targetPath
      const sheetXml = pkg.getEntryText(sheetPath)

      if (!sheetXml) {
        warnings.push({
          code: 'WORKSHEET_NOT_FOUND',
          message: `Worksheet part '${sheetPath}' not found for sheet '${sheet.name}'.`
        })
        continue
      }

      const sheetDoc = this.parser.parseFromString(sheetXml, 'text/xml')

      // Resolve sheet relationships (hyperlinks, comments, drawings, tables)
      const sheetRelsMap = new Map<string, string>()
      const sheetRelsPath = sheetPath.replace(/([^/]+)\.xml$/, '_rels/$1.xml.rels')
      const sheetRelsXml = pkg.getEntryText(sheetRelsPath)
      if (sheetRelsXml) {
        const relsDoc = this.parser.parseFromString(sheetRelsXml, 'text/xml')
        const relNodes = relsDoc.getElementsByTagName('Relationship')
        for (let r = 0; r < relNodes.length; r++) {
          const id = relNodes[r].getAttribute('Id')
          const target = relNodes[r].getAttribute('Target')
          if (id && target) {
            sheetRelsMap.set(id, target)
          }
        }
      }

      // Resolve comments if present
      const commentsMap = new Map<string, string>() // coordinate -> comment text
      for (const [, target] of sheetRelsMap) {
        if (target.includes('comments')) {
          const commentsPath = target.startsWith('/')
            ? target.slice(1)
            : target.startsWith('xl/')
              ? target
              : `xl/${target.replace(/^\.\.\//, '')}`
          const commentsXml = pkg.getEntryText(commentsPath)
          if (commentsXml) {
            const commentsDoc = this.parser.parseFromString(commentsXml, 'text/xml')
            const commentNodes = commentsDoc.getElementsByTagName('comment')
            for (let c = 0; c < commentNodes.length; c++) {
              const ref = commentNodes[c].getAttribute('ref')
              if (ref) {
                let commentText = ''
                const tNodes = commentNodes[c].getElementsByTagName('t')
                for (let t = 0; t < tNodes.length; t++) {
                  commentText += tNodes[t].textContent ?? ''
                }
                commentsMap.set(ref.toUpperCase(), commentText)
              }
            }
          }
        }
      }

      // Resolve hyperlinks in sheet
      const hyperlinksMap = new Map<string, string>() // coordinate -> URL
      const hyperlinkNodes = sheetDoc.getElementsByTagName('hyperlink')
      for (let h = 0; h < hyperlinkNodes.length; h++) {
        const ref = hyperlinkNodes[h].getAttribute('ref')
        const rId =
          hyperlinkNodes[h].getAttribute('r:id') ??
          hyperlinkNodes[h].getAttribute(
            'http://schemas.openxmlformats.org/officeDocument/2006/relationships:id'
          )
        const location = hyperlinkNodes[h].getAttribute('location')
        if (ref) {
          const target = (rId ? sheetRelsMap.get(rId) : null) ?? location ?? ''
          if (target) {
            hyperlinksMap.set(ref.toUpperCase(), target)
          }
        }
      }

      // Resolve merged cells
      const mergeCellMap = new Map<string, { rowSpan: number; colSpan: number }>()
      const mergeCellNodes = sheetDoc.getElementsByTagName('mergeCell')
      for (let m = 0; m < mergeCellNodes.length; m++) {
        const ref = mergeCellNodes[m].getAttribute('ref')
        if (ref && ref.includes(':')) {
          const [startRef, endRef] = ref.split(':')
          const startCoord = parseExcelCellCoordinate(startRef)
          const endCoord = parseExcelCellCoordinate(endRef)
          const rowSpan = endCoord.rowIndex - startCoord.rowIndex + 1
          const colSpan = endCoord.columnIndex - startCoord.columnIndex + 1
          mergeCellMap.set(startRef.toUpperCase(), { rowSpan, colSpan })
        }
      }

      // Add sheet boundary block
      blocks.push({
        type: 'sheet_boundary',
        text: `Sheet: ${sheet.name}`,
        sheet: {
          name: sheet.name,
          index: sheetIdx + 1
        },
        metadata: {
          sheetIndex: sheetIdx + 1,
          sheetName: sheet.name,
          state: sheet.state,
          date1904
        }
      })

      // Parse Sheet Rows & Cells
      const rowNodes = sheetDoc.getElementsByTagName('row')
      const parsedRowMap = new Map<number, Map<number, UniversalTableCell>>()
      let maxColIndex = 0
      let maxRowIndex = 0

      for (let r = 0; r < rowNodes.length; r++) {
        const rowNode = rowNodes[r]
        const rowNumberAttr = rowNode.getAttribute('r')
        const rowNumber = rowNumberAttr ? parseInt(rowNumberAttr, 10) : r + 1
        const rowIndex = rowNumber - 1
        if (rowIndex > maxRowIndex) maxRowIndex = rowIndex

        const cellNodes = rowNode.getElementsByTagName('c')
        const rowCells = new Map<number, UniversalTableCell>()

        for (let c = 0; c < cellNodes.length; c++) {
          const cellNode = cellNodes[c]
          const coordAttr = cellNode.getAttribute('r') ?? `${getExcelColumnName(c)}${rowNumber}`
          const coord = parseExcelCellCoordinate(coordAttr)
          const colIndex = coord.columnIndex
          if (colIndex > maxColIndex) maxColIndex = colIndex

          const cellType = cellNode.getAttribute('t') ?? 'n'
          const styleIdx = parseInt(cellNode.getAttribute('s') ?? '0', 10)
          const style = styleIdx < cellStyles.length ? cellStyles[styleIdx] : undefined

          // Formula extraction (<f>)
          let formula: string | undefined = undefined
          const fNodes = cellNode.getElementsByTagName('f')
          if (fNodes.length > 0) {
            const rawF = fNodes[0].textContent ?? ''
            if (rawF.trim().length > 0) {
              formula = rawF.trim().startsWith('=') ? rawF.trim() : `=${rawF.trim()}`
            }
          }

          // Stored / cached value extraction (<v> or <is><t>)
          let storedValueText = ''
          const vNodes = cellNode.getElementsByTagName('v')
          if (vNodes.length > 0) {
            storedValueText = vNodes[0].textContent ?? ''
          } else {
            const isNodes = cellNode.getElementsByTagName('is')
            if (isNodes.length > 0) {
              const tNodes = isNodes[0].getElementsByTagName('t')
              if (tNodes.length > 0) {
                storedValueText = tNodes[0].textContent ?? ''
              }
            }
          }

          // Determine display value, rawValue, and cachedValue
          let displayValue: string
          let rawValue: unknown = storedValueText
          let cachedValue: unknown = undefined

          if (cellType === 's') {
            // Shared string index
            const sstIdx = parseInt(storedValueText, 10)
            if (!isNaN(sstIdx) && sstIdx >= 0 && sstIdx < sharedStrings.length) {
              displayValue = sharedStrings[sstIdx]
              rawValue = displayValue
            } else {
              displayValue = storedValueText
            }
          } else if (cellType === 'b') {
            displayValue = storedValueText === '1' ? 'TRUE' : 'FALSE'
            rawValue = storedValueText === '1'
          } else if (cellType === 'e') {
            displayValue = storedValueText // Error code e.g. #DIV/0!
            rawValue = storedValueText
          } else if (cellType === 'str' || cellType === 'inlineStr') {
            displayValue = storedValueText
            rawValue = storedValueText
          } else {
            // Numeric or date
            const numVal = Number(storedValueText)
            if (!isNaN(numVal) && storedValueText.length > 0) {
              if (style?.isDate) {
                displayValue = excelSerialDateToIso(numVal, date1904)
                rawValue = displayValue
              } else {
                displayValue = storedValueText
                rawValue = numVal
              }
            } else {
              displayValue = storedValueText
            }
          }

          // If formula is present, cached value is stored
          if (formula !== undefined) {
            cachedValue = displayValue.length > 0 ? displayValue : undefined
          }

          const merge = mergeCellMap.get(coordAttr.toUpperCase())
          const comment = commentsMap.get(coordAttr.toUpperCase())
          const hyperlink = hyperlinksMap.get(coordAttr.toUpperCase())

          const cell: UniversalTableCell = {
            value: displayValue,
            rawValue,
            ...(cachedValue !== undefined ? { cachedValue } : {}),
            ...(formula !== undefined ? { formula } : {}),
            coordinate: coordAttr.toUpperCase(),
            rowIndex,
            columnIndex: colIndex,
            ...(merge?.rowSpan ? { rowSpan: merge.rowSpan } : {}),
            ...(merge?.colSpan ? { colSpan: merge.colSpan } : {}),
            ...(styleIdx > 0 ? { styleIndex: styleIdx } : {}),
            ...(style?.formatCode ? { numberFormat: style.formatCode } : {}),
            ...(comment ? { comment } : {}),
            ...(hyperlink ? { hyperlink } : {})
          }

          rowCells.set(colIndex, cell)
          totalCells++
        }

        parsedRowMap.set(rowIndex, rowCells)
        totalRows++
      }

      // Build 2D matrix of cells and string rows
      const gridCells: UniversalTableCell[][] = []
      const stringRows: string[][] = []
      const sectionLines: string[] = []
      sectionLines.push(`# Sheet: ${sheet.name} (Sheet ${sheetIdx + 1})`)

      for (let r = 0; r <= maxRowIndex; r++) {
        const rowCells = parsedRowMap.get(r)

        const gridRow: UniversalTableCell[] = []
        const stringRow: string[] = []
        const lineParts: string[] = []

        for (let c = 0; c <= maxColIndex; c++) {
          const cell = rowCells?.get(c)
          const cellCoord = `${getExcelColumnName(c)}${r + 1}`
          if (cell) {
            gridRow.push(cell)
            stringRow.push(cell.value)
            if (cell.value.trim().length > 0 || cell.formula) {
              const formulaSuffix = cell.formula ? ` [Formula: ${cell.formula}]` : ''
              lineParts.push(`${cellCoord}: ${cell.value}${formulaSuffix}`)
            }
          } else {
            // Empty cell placeholder
            const emptyCell: UniversalTableCell = {
              value: '',
              coordinate: cellCoord,
              rowIndex: r,
              columnIndex: c
            }
            gridRow.push(emptyCell)
            stringRow.push('')
          }
        }

        gridCells.push(gridRow)
        stringRows.push(stringRow)

        if (lineParts.length > 0) {
          sectionLines.push(`Row ${r + 1} | ${lineParts.join(' | ')}`)
        }
      }

      // Extract headers from first non-empty row
      const headers = stringRows.length > 0 ? stringRows[0] : []
      const dataRows = stringRows.length > 1 ? stringRows.slice(1) : []
      const formattedTableText = sectionLines.join('\n')

      blocks.push({
        type: 'table',
        text: formattedTableText,
        table: {
          headers,
          rows: dataRows,
          caption: sheet.name
        },
        sheet: {
          name: sheet.name,
          index: sheetIdx + 1
        },
        metadata: {
          sheetName: sheet.name,
          sheetIndex: sheetIdx + 1,
          isSpreadsheet: true,
          rowCount: stringRows.length,
          columnCount: maxColIndex + 1,
          cells: gridCells
        }
      })

      textSections.push(formattedTableText)

      // Resolve drawings & charts for sheet
      for (const [, target] of sheetRelsMap) {
        if (target.includes('drawing')) {
          const drawingPath = target.startsWith('/')
            ? target.slice(1)
            : target.startsWith('xl/')
              ? target
              : `xl/${target.replace(/^\.\.\//, '')}`
          const drawingXml = pkg.getEntryText(drawingPath)
          if (drawingXml) {
            // Check for images
            const drawDoc = this.parser.parseFromString(drawingXml, 'text/xml')
            const picNodes = drawDoc.getElementsByTagName('xdr:pic')
            const blipNodes = drawDoc.getElementsByTagName('a:blip')
            const count = Math.max(picNodes.length, blipNodes.length)
            for (let p = 0; p < count; p++) {
              blocks.push({
                type: 'image_reference',
                text: `[DrawingML Image in Sheet '${sheet.name}']`,
                metadata: {
                  elementType: 'image',
                  sheetName: sheet.name,
                  sheetIndex: sheetIdx + 1,
                  extractionStatus: 'skipped',
                  warning:
                    'Spreadsheet embedded image extraction skipped; OCR not supported on drawing elements.'
                }
              })
              warnings.push({
                code: 'IMAGE_SKIPPED',
                message: `Embedded image in sheet '${sheet.name}' was skipped.`
              })
            }

            // Check for charts
            const chartNodes = drawDoc.getElementsByTagName('c:chart')
            for (let ch = 0; ch < chartNodes.length; ch++) {
              blocks.push({
                type: 'image_reference',
                text: `[DrawingML Chart in Sheet '${sheet.name}']`,
                metadata: {
                  elementType: 'chart',
                  sheetName: sheet.name,
                  sheetIndex: sheetIdx + 1,
                  extractionStatus: 'unsupported',
                  warning: 'Spreadsheet chart rendering is unsupported in text extraction pipeline.'
                }
              })
              warnings.push({
                code: 'CHART_UNSUPPORTED',
                message: `Chart in sheet '${sheet.name}' is retained as an unsupported structural reference.`
              })
            }
          }
        }
      }
    }

    const fullText = textSections.join('\n\n')

    const allWarnings: DocumentExtractionWarning[] = [
      {
        code: 'SPREADSHEET_FORMULA_POLICY',
        message:
          'Spreadsheet formulas are extracted as formula expressions and/or cached display values without execution.'
      },
      ...warnings
    ]

    return {
      format: 'xlsx',
      text: fullText,
      blocks,
      metadata: {
        sheetCount: sheets.length,
        sheetNames: sheets.map((s) => s.name),
        totalRows,
        totalPopulatedRows: totalRows,
        totalCells,
        totalPopulatedCells: totalCells,
        date1904
      },
      warnings: allWarnings,
      quality: {
        fidelity: 'high',
        isLossy: false,
        isOcr: false,
        hasUnparsedElements: warnings.some(
          (w) => w.code === 'IMAGE_SKIPPED' || w.code === 'CHART_UNSUPPORTED'
        )
      },
      extractor: {
        id: 'xlsx-ooxml-parser',
        name: 'OpenXML Excel Parser',
        version: '1.0.0',
        supportedFormats: ['xlsx'],
        supportedMimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        isHeavy: true,
        requiresUtilityProcess: true
      }
    }
  }
}
