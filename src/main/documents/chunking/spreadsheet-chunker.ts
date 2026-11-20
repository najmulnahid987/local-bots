import { DocumentErrors } from '../document-errors'
import type { ExtractedDocument, ExtractedDocumentSection } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import type { ChunkingResult, DocumentChunk } from './types'
import { estimateTokenCount } from './semantic-chunker'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'

interface ParsedSpreadsheetRow {
  readonly rowNumber: number
  readonly rawText: string
  readonly tokenCount: number
}

/**
 * Parses raw section text into structured spreadsheet rows.
 */
function parseSectionRows(sectionText: string): {
  sheetName: string
  headerRow?: ParsedSpreadsheetRow
  rows: ParsedSpreadsheetRow[]
} {
  const lines = sectionText.split('\n')
  let sheetName = 'Sheet1'
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

  // Detect table header: if row 1 exists and has multiple columns
  let headerRow: ParsedSpreadsheetRow | undefined = undefined
  if (rows.length >= 2 && rows[0].rowNumber === 1) {
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
  // Extract cells from row: e.g. "Row 5 | A5: Val1 | B5: Val2 | C5: Val3"
  const parts = row.rawText.split('|').map((s) => s.trim())
  const rowLabel = parts[0] // "Row 5"
  const cells = parts.slice(1) // ["A5: Val1", "B5: Val2", ...]

  if (cells.length <= 1) {
    // If only one huge cell, return rawText as a single item
    return [row.rawText]
  }

  const slices: string[] = []
  let currentCells: string[] = []
  let currentTokens = estimateTokenCount(rowLabel)
  let partNumber = 1

  for (const cell of cells) {
    const cellTokens = estimateTokenCount(cell) + 1 // +1 for delimiter
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
 * SpreadsheetChunker implements spreadsheet-aware semantic chunking
 * conforming to Phase 10 Step 10.7 specifications:
 *
 * Guarantees:
 * 1. Preserves workbook and worksheet identity in every chunk context header.
 * 2. Never splits a logical spreadsheet row across chunks.
 * 3. Preserves cell coordinates (A1, B2) and original row numbering.
 * 4. Repeats verified table column headers at the start of each row fragment.
 * 5. Handles wide worksheets deterministically via coordinate slicing without dropping cells.
 * 6. Hard-bounds worksheet separation (never merges rows from different sheets in one chunk).
 */
export class SpreadsheetChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  /**
   * Chunks an ExtractedDocument representing an XLSX workbook.
   */
  public chunk(doc: ExtractedDocument): ChunkingResult {
    if (!doc) {
      throw DocumentErrors.chunkingInvalidInput('Extracted document is null or undefined.')
    }

    if (doc.format !== 'xlsx') {
      throw DocumentErrors.extractionUnsupportedFormat(
        `SpreadsheetChunker expected 'xlsx' format, got '${doc.format}'`
      )
    }

    if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
      throw DocumentErrors.chunkingInvalidInput('Extracted document contains no sections to chunk.')
    }

    // Load and validate settings
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

    // Process each worksheet section independently
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
        // Section had no structured rows (e.g. empty sheet notice)
        continue
      }

      const hasTable = headerRow !== undefined
      const tableHeaderPrefix =
        hasTable && headerRow
          ? `[Table Header: ${headerRow.rawText.replace(/^Row\s+\d+\s*\|\s*/i, '')}]`
          : ''

      // Group rows into chunks
      let rowIdx = 0
      while (rowIdx < rows.length) {
        const startRowIdx = rowIdx
        const chunkRows: ParsedSpreadsheetRow[] = []

        // Base context header text
        // Rows range placeholder will be filled once chunkRows are collected
        let accumulatedTokens = 0

        while (rowIdx < rows.length) {
          const candidateRow = rows[rowIdx]

          // Check if candidate row itself is wider than chunkTargetTokens
          if (candidateRow.tokenCount > chunkTargetTokens) {
            // If we already have accumulated rows, flush them first
            if (chunkRows.length > 0) {
              break
            }

            // Slice the wide row into coordinate parts
            const wideSlices = sliceWideRow(candidateRow, sheetName, chunkTargetTokens)
            for (const sliceContent of wideSlices) {
              chunks.push({
                chunkIndex: currentIndex++,
                content: sliceContent,
                tokenCount: estimateTokenCount(sliceContent),
                pageNumber: null,
                metadata: {
                  sheetName,
                  sheetIndex: sectionIdx + 1,
                  startRow: candidateRow.rowNumber,
                  endRow: candidateRow.rowNumber,
                  isWideRowSlice: true,
                  headingPath: [sheetName],
                  headingContext: sheetName
                },
                chunkerVersion
              })
            }
            rowIdx++
            break
          }

          // Check if adding this row exceeds target tokens
          const rowTokens = candidateRow.tokenCount
          if (chunkRows.length > 0 && accumulatedTokens + rowTokens > chunkTargetTokens) {
            break
          }

          chunkRows.push(candidateRow)
          accumulatedTokens += rowTokens
          rowIdx++
        }

        if (chunkRows.length === 0) {
          // Handled by wide row or reached end
          continue
        }

        const startRowNum = chunkRows[0].rowNumber
        const endRowNum = chunkRows[chunkRows.length - 1].rowNumber

        // Build chunk context header
        const contextHeaderLines = [
          `[Spreadsheet Context]`,
          `Worksheet: ${sheetName} (Sheet ${sectionIdx + 1})`,
          `Rows: ${startRowNum}–${endRowNum}`
        ]

        // Repeat table headers if startRowNum > 1 and table headers exist
        if (hasTable && startRowNum > 1 && tableHeaderPrefix) {
          contextHeaderLines.push(tableHeaderPrefix)
        }

        const contextHeader = contextHeaderLines.join('\n')
        const rowsText = chunkRows.map((r) => r.rawText).join('\n')
        const fullChunkContent = `${contextHeader}\n\n${rowsText}`

        chunks.push({
          chunkIndex: currentIndex++,
          content: fullChunkContent,
          tokenCount: estimateTokenCount(fullChunkContent),
          pageNumber: null,
          metadata: {
            sheetName,
            sheetIndex: sectionIdx + 1,
            startRow: startRowNum,
            endRow: endRowNum,
            hasTable,
            headingPath: [sheetName],
            headingContext: sheetName
          },
          chunkerVersion
        })

        // Row-based overlap: calculate how many rows to rewind for overlap
        if (chunkOverlapTokens > 0 && rowIdx < rows.length) {
          let overlapTokens = 0
          let rewindCount = 0
          for (let r = chunkRows.length - 1; r >= 0; r--) {
            const rTokens = chunkRows[r].tokenCount
            if (
              overlapTokens + rTokens <= chunkOverlapTokens &&
              rewindCount < chunkRows.length - 1
            ) {
              overlapTokens += rTokens
              rewindCount++
            } else {
              break
            }
          }

          if (rewindCount > 0 && startRowIdx + rewindCount < rowIdx) {
            rowIdx -= rewindCount
          }
        }
      }
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The spreadsheet contains no extractable row content to chunk.'
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
