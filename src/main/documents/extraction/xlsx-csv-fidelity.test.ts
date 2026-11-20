import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { buildRichXlsx, buildSyntheticCsv } from '../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../services/zip-archive'
import { XlsxOoxmlParser } from './xlsx/xlsx-ooxml-parser'
import { XlsxExtractor } from './xlsx/xlsx-extractor'
import { CsvExtractor, parseRfc4180Csv, detectHeaderRow } from './csv/csv-extractor'
import { FormatDetector } from './format-detector'
import { DocumentFileValidator } from '../document-file-validator'
import { SpreadsheetChunker } from '../chunking/spreadsheet-chunker'
import { SemanticChunker } from '../chunking/semantic-chunker'
import {
  documentExtractionResultToUniversalDocument,
  universalDocumentToLegacy,
  validateUniversalDocument
} from '../model'
import type { UniversalTableBlock, UniversalTableCell } from '../model/types'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { CreateKnowledgeChunkInput } from '../../database/repositories/types'

describe('Phase 11 — Step 11.7: XLSX & CSV Extraction Fidelity', () => {
  let db: Database.Database
  let sourceRepo: KnowledgeSourceRepository
  let extractedDocRepo: ExtractedDocumentRepository
  const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    sourceRepo = new KnowledgeSourceRepository(db)
    extractedDocRepo = new ExtractedDocumentRepository(db)

    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, 'Spreadsheet KB', 'kb-path', ?, ?)`
    ).run(kbId, now, now)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // =========================================================================
  // 1. XLSX Extraction Fidelity Tests
  // =========================================================================
  describe('1. XLSX Extraction Fidelity', () => {
    const ooxmlParser = new XlsxOoxmlParser()
    const xlsxExtractor = new XlsxExtractor()

    it('1. extracts multi-sheet workbook with names, 0-based and 1-based indices, and order', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Overview',
            cells: [{ coordinate: 'A1', value: 'Project Overview' }]
          },
          {
            name: 'Financials',
            cells: [{ coordinate: 'A1', value: 'Q1 Revenue' }]
          },
          {
            name: 'Projections',
            cells: [{ coordinate: 'A1', value: '2027 Target' }]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      expect(result.format).toBe('xlsx')
      expect(result.metadata.sheetCount).toBe(3)

      const sheetBoundaries = result.blocks.filter((b) => b.type === 'sheet_boundary')
      expect(sheetBoundaries.length).toBe(3)
      expect(sheetBoundaries[0].sheet?.name).toBe('Overview')
      expect(sheetBoundaries[0].sheet?.index).toBe(1)
      expect(sheetBoundaries[1].sheet?.name).toBe('Financials')
      expect(sheetBoundaries[1].sheet?.index).toBe(2)
      expect(sheetBoundaries[2].sheet?.name).toBe('Projections')
      expect(sheetBoundaries[2].sheet?.index).toBe(3)
    })

    it('2. preserves worksheet visibility state (visible, hidden, veryHidden)', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'PublicSheet',
            state: 'visible',
            cells: [{ coordinate: 'A1', value: 'Public Data' }]
          },
          {
            name: 'AuditTrail',
            state: 'hidden',
            cells: [{ coordinate: 'A1', value: 'Confidential Audit' }]
          },
          {
            name: 'SystemState',
            state: 'veryHidden',
            cells: [{ coordinate: 'A1', value: 'Internal System Check' }]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const boundaries = result.blocks.filter((b) => b.type === 'sheet_boundary')
      expect(boundaries[0].metadata?.state).toBe('visible')
      expect(boundaries[1].metadata?.state).toBe('hidden')
      expect(boundaries[2].metadata?.state).toBe('veryHidden')
    })

    it('3. detects 1904 date system vs 1900 date system', () => {
      const buf1904 = buildRichXlsx({
        date1904: true,
        sheets: [
          {
            name: 'Dates1904',
            cells: [{ coordinate: 'A1', value: 'Apple System' }]
          }
        ]
      })

      const res1904 = ooxmlParser.parse(buf1904)
      expect(res1904.metadata.date1904).toBe(true)

      const buf1900 = buildRichXlsx({
        date1904: false,
        sheets: [
          {
            name: 'Dates1900',
            cells: [{ coordinate: 'A1', value: 'Windows System' }]
          }
        ]
      })

      const res1900 = ooxmlParser.parse(buf1900)
      expect(res1900.metadata.date1904).toBe(false)
    })

    it('4. preserves sparse cell coordinates (A1, Z100, AA50) without collapsing empty columns', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'SparseSheet',
            cells: [
              { coordinate: 'A1', value: 'Origin' },
              { coordinate: 'E1', value: 'Col E' },
              { coordinate: 'Z20', value: 'Far Cell' }
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      expect(tableBlock).toBeDefined()
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      // Cell A1
      const cellA1 = cells[0][0]
      expect(cellA1.coordinate).toBe('A1')
      expect(cellA1.value).toBe('Origin')

      // Empty cell B1
      const cellB1 = cells[0][1]
      expect(cellB1.coordinate).toBe('B1')
      expect(cellB1.value).toBe('')

      // Cell E1 at columnIndex 4
      const cellE1 = cells[0][4]
      expect(cellE1.coordinate).toBe('E1')
      expect(cellE1.value).toBe('Col E')

      // Row 20 (index 19), Col Z (index 25)
      const cellZ20 = cells[19][25]
      expect(cellZ20.coordinate).toBe('Z20')
      expect(cellZ20.value).toBe('Far Cell')
    })

    it('5. preserves formula expressions independently from cached results', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Formulas',
            cells: [
              { coordinate: 'A1', value: 10 },
              { coordinate: 'A2', value: 20 },
              { coordinate: 'A3', formula: '=SUM(A1:A2)', cachedValue: 30 }
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      const cellA3 = cells[2][0]
      expect(cellA3.coordinate).toBe('A3')
      expect(cellA3.formula).toBe('=SUM(A1:A2)')
      expect(cellA3.cachedValue).toBe('30')
      expect(cellA3.value).toBe('30')
    })

    it('6. preserves formula without cached result without executing formulas', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'UncachedFormula',
            cells: [
              { coordinate: 'B5', formula: 'AVERAGE(B1:B4)' } // no cachedValue
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      const cellB5 = cells[4][1]
      expect(cellB5.coordinate).toBe('B5')
      expect(cellB5.formula).toBe('=AVERAGE(B1:B4)')
      expect(cellB5.cachedValue).toBeUndefined()
    })

    it('7. preserves formula error codes (#DIV/0!, #N/A, #REF!, #VALUE!)', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Errors',
            cells: [
              { coordinate: 'A1', formula: '=10/0', value: '#DIV/0!', type: 'e' },
              { coordinate: 'A2', formula: '=VLOOKUP(1,Z:Z,1,0)', value: '#N/A', type: 'e' },
              { coordinate: 'A3', formula: '=OFFSET(A1,-10,0)', value: '#REF!', type: 'e' }
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      expect(cells[0][0].value).toBe('#DIV/0!')
      expect(cells[0][0].formula).toBe('=10/0')
      expect(cells[1][0].value).toBe('#N/A')
      expect(cells[2][0].value).toBe('#REF!')
    })

    it('8. preserves merged cells with colSpan and rowSpan metadata', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Merged',
            cells: [
              { coordinate: 'A1', value: 'Quarterly Financial Summary' },
              { coordinate: 'A2', value: 'Department' },
              { coordinate: 'B2', value: 'Q1' },
              { coordinate: 'C2', value: 'Q2' }
            ],
            merges: ['A1:C1']
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      const cellA1 = cells[0][0]
      expect(cellA1.coordinate).toBe('A1')
      expect(cellA1.value).toBe('Quarterly Financial Summary')
      expect(cellA1.colSpan).toBe(3)
      expect(cellA1.rowSpan).toBe(1)
    })

    it('9. converts serial date numbers to ISO dates deterministically', () => {
      // In Excel 1900 system, serial 44927 is 2023-01-01
      const buf = buildRichXlsx({
        styles: [{ numFmtId: 14, formatCode: 'yyyy-mm-dd' }],
        sheets: [
          {
            name: 'Dates',
            cells: [{ coordinate: 'A1', value: 44927, styleIndex: 1, type: 'n' }]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      const cellA1 = cells[0][0]
      expect(cellA1.coordinate).toBe('A1')
      expect(cellA1.value).toBe('2023-01-01')
      expect(cellA1.rawValue).toBe('2023-01-01')
    })

    it('10. resolves shared strings and preserves Bengali Unicode and emojis', () => {
      const bengaliText = 'মোট বাজেট: ৫০,০০০ টাকা'
      const emojiText = 'Q1 Target 🚀 📊 100%'

      const buf = buildRichXlsx({
        sharedStrings: [bengaliText, emojiText],
        sheets: [
          {
            name: 'Multilingual',
            cells: [
              { coordinate: 'A1', value: 0, type: 's' },
              { coordinate: 'B1', value: 1, type: 's' }
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      expect(cells[0][0].value).toBe(bengaliText)
      expect(cells[0][1].value).toBe(emojiText)
      expect(result.text).toContain(bengaliText)
      expect(result.text).toContain(emojiText)
    })

    it('11. preserves cell comments and hyperlinks', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Annotated',
            cells: [
              {
                coordinate: 'B2',
                value: 'Audit Item',
                comment: 'Requires CEO signoff',
                hyperlink: 'https://internal.corp/audit-2026'
              }
            ]
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]

      const cellB2 = cells[1][1]
      expect(cellB2.coordinate).toBe('B2')
      expect(cellB2.value).toBe('Audit Item')
      expect(cellB2.comment).toBe('Requires CEO signoff')
      expect(cellB2.hyperlink).toBe('https://internal.corp/audit-2026')
    })

    it('12. preserves DrawingML images and charts as structural blocks with warnings', () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'Visuals',
            cells: [{ coordinate: 'A1', value: 'KPI Data' }],
            hasImage: true,
            hasChart: true
          }
        ]
      })

      const result = ooxmlParser.parse(buf)
      const imageBlocks = result.blocks.filter((b) => b.type === 'image_reference')
      expect(imageBlocks.length).toBe(2)

      const img = imageBlocks.find((b) => b.metadata?.elementType === 'image')
      expect(img).toBeDefined()
      expect(img?.metadata?.extractionStatus).toBe('skipped')

      const chart = imageBlocks.find((b) => b.metadata?.elementType === 'chart')
      expect(chart).toBeDefined()
      expect(chart?.metadata?.extractionStatus).toBe('unsupported')

      expect(result.warnings.some((w) => w.code === 'IMAGE_SKIPPED')).toBe(true)
      expect(result.warnings.some((w) => w.code === 'CHART_UNSUPPORTED')).toBe(true)
    })

    it('13. primary XlsxExtractor delegates to XlsxOoxmlParser seamlessly', async () => {
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'PrimaryTest',
            cells: [
              { coordinate: 'A1', value: 'Revenue' },
              { coordinate: 'B1', value: 50000 },
              { coordinate: 'C1', formula: '=B1*1.2', cachedValue: 60000 }
            ]
          }
        ]
      })

      const result = await xlsxExtractor.extract({ bytes: buf })
      expect(result.format).toBe('xlsx')
      expect(result.text).toContain('Revenue')
      expect(result.text).toContain('50000')
      expect(result.text).toContain('60000')

      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]
      expect(cells[0][2].formula).toBe('=B1*1.2')
      expect(cells[0][2].cachedValue).toBe('60000')
    })
  })

  // =========================================================================
  // 2. CSV Extraction Fidelity Tests
  // =========================================================================
  describe('2. CSV Extraction Fidelity', () => {
    const csvExtractor = new CsvExtractor()

    it('1. parses standard RFC 4180 comma-separated records preserving first row as ordinary data by default', async () => {
      const csv = buildSyntheticCsv({
        rows: [
          ['Name', 'Department', 'Salary'],
          ['Alice', 'Engineering', 120000],
          ['Bob', 'Marketing', 95000]
        ]
      })

      const result = await csvExtractor.extract({ bytes: csv })
      expect(result.format).toBe('csv')
      expect(result.metadata.rowCount).toBe(3)
      expect(result.metadata.columnCount).toBe(3)

      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      // Non-authoritative header semantics: default extraction does NOT silently infer headers
      expect(tableBlock.table?.headers).toEqual([])
      expect(tableBlock.table?.rows.length).toBe(3)
      expect(tableBlock.table?.rows[0]).toEqual(['Name', 'Department', 'Salary'])
      expect(tableBlock.metadata?.headerState).toBe('unknown')
      expect(tableBlock.metadata?.hasHeader).toBe(false)
      expect(tableBlock.metadata?.heuristicHeaderSuggestion).toBe(true)
    })

    it('2. preserves quoted fields containing commas, line breaks, and escaped quotes ("")', async () => {
      const multilineField = 'Line 1\nLine 2\nLine 3'
      const quotedQuote = 'He said "Hello World" to the team'
      const commaField = 'Austin, TX, USA'

      const csv = buildSyntheticCsv({
        rows: [
          ['Title', 'Description', 'Location'],
          ['Complex Record', multilineField, commaField],
          ['Quote Record', quotedQuote, 'Remote']
        ]
      })

      const result = await csvExtractor.extract({ bytes: csv })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      const rows = tableBlock.table!.rows

      expect(rows[1][1]).toBe(multilineField)
      expect(rows[1][2]).toBe(commaField)
      expect(rows[2][1]).toBe(quotedQuote)
    })

    it('3. handles empty fields and trailing delimiters without data loss', async () => {
      const rawCsv = 'A,,C,\n1,,3,\n'
      const parsed = parseRfc4180Csv(rawCsv)

      expect(parsed.rowCount).toBe(2)
      expect(parsed.columnCount).toBe(4)
      expect(parsed.rows[0]).toEqual(['A', '', 'C', ''])
      expect(parsed.rows[1]).toEqual(['1', '', '3', ''])

      const cells = parsed.cells
      expect(cells[0][0].coordinate).toBe('A1')
      expect(cells[0][1].coordinate).toBe('B1')
      expect(cells[0][2].coordinate).toBe('C1')
      expect(cells[0][3].coordinate).toBe('D1')
    })

    it('4. decodes UTF-8 with BOM, UTF-16LE with BOM, and UTF-16BE with BOM', async () => {
      const bengaliData = [
        ['নাম', 'পদবি', 'বেতন'],
        ['রহিম', 'প্রকৌশলী', 85000],
        ['করিম', 'ব্যবস্থাপক', 95000]
      ]

      // 1. UTF-8 with BOM
      const utf8Bom = buildSyntheticCsv({ rows: bengaliData, bom: 'utf8' })
      const resUtf8 = await csvExtractor.extract({ bytes: utf8Bom })
      expect(resUtf8.text).toContain('রহিম')
      expect(resUtf8.text).toContain('প্রকৌশলী')
      expect(resUtf8.metadata.encoding).toBe('utf-8-bom')

      // 2. UTF-16LE with BOM
      const utf16Le = buildSyntheticCsv({ rows: bengaliData, bom: 'utf16le' })
      const resLe = await csvExtractor.extract({ bytes: utf16Le })
      expect(resLe.text).toContain('করিম')
      expect(resLe.text).toContain('ব্যবস্থাপক')
      expect(resLe.metadata.encoding).toBe('utf-16le')

      // 3. UTF-16BE with BOM
      const utf16Be = buildSyntheticCsv({ rows: bengaliData, bom: 'utf16be' })
      const resBe = await csvExtractor.extract({ bytes: utf16Be })
      expect(resBe.text).toContain('নাম')
      expect(resBe.text).toContain('বেতন')
      expect(resBe.metadata.encoding).toBe('utf-16be')
    })

    it('5. detects and reports ragged rows without dropping columns or crashing', async () => {
      const rawCsv = 'Col1,Col2,Col3\nVal1\nVal1,Val2,Val3,Val4\n'
      const parsed = parseRfc4180Csv(rawCsv)

      expect(parsed.isRagged).toBe(true)
      expect(parsed.columnCount).toBe(4)
      expect(parsed.raggedRowIndices).toContain(1) // Row 1 has 3 cols (max is 4)
      expect(parsed.raggedRowIndices).toContain(2) // Row 2 has 1 col

      const result = await csvExtractor.extract({ bytes: Buffer.from(rawCsv, 'utf8') })
      expect(result.warnings.some((w) => w.code === 'RAGGED_ROWS_DETECTED')).toBe(true)
    })

    it('6. distinguishes header row from non-header data heuristically (non-authoritative)', () => {
      // Pure numbers: no header suggestion
      const numRows = [
        ['100', '200', '300'],
        ['400', '500', '600']
      ]
      const numHeader = detectHeaderRow(numRows)
      expect(numHeader.hasHeader).toBe(false)
      expect(numHeader.headers).toEqual(['A', 'B', 'C'])

      // Text row followed by numbers: suggested header
      const mixedRows = [
        ['Metric', 'Q1 Actual', 'Q2 Actual'],
        ['Revenue', '50000', '62000']
      ]
      const mixedHeader = detectHeaderRow(mixedRows)
      expect(mixedHeader.hasHeader).toBe(true)
      expect(mixedHeader.headers).toEqual(['Metric', 'Q1 Actual', 'Q2 Actual'])
    })

    it('7. emits formatted lines compatible with SpreadsheetChunker', async () => {
      const csv = buildSyntheticCsv({
        rows: [
          ['SKU', 'Units', 'Price'],
          ['A100', 50, 19.99],
          ['B200', 120, 45.0]
        ]
      })

      const result = await csvExtractor.extract({ bytes: csv })
      expect(result.text).toContain('# Sheet: CSV Document (Sheet 1)')
      expect(result.text).toContain('# Header: None')
      expect(result.text).toContain('Row 1 | A1: SKU | B1: Units | C1: Price')
      expect(result.text).toContain('Row 2 | A2: A100 | B2: 50 | C2: 19.99')
      expect(result.text).toContain('Row 3 | A3: B200 | B3: 120 | C3: 45')
    })

    // --- Specific Acceptance Tests from Step 11.7 Audit ---

    it('8. preserves text-only first row containing actual data as ordinary data by default', async () => {
      const csv = Buffer.from(
        'John Doe,Senior Architect,Austin\nJane Smith,Staff Engineer,Seattle\n',
        'utf8'
      )
      const result = await csvExtractor.extract({ bytes: csv })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.headers).toEqual([])
      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[0]).toEqual(['John Doe', 'Senior Architect', 'Austin'])
      expect(tableBlock.metadata?.headerState).toBe('unknown')
      expect(tableBlock.metadata?.hasHeader).toBe(false)
    })

    it('9. preserves numeric-looking first row as ordinary data by default', async () => {
      const csv = Buffer.from('1001,2002,3003\n4004,5005,6006\n', 'utf8')
      const result = await csvExtractor.extract({ bytes: csv })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.headers).toEqual([])
      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[0]).toEqual(['1001', '2002', '3003'])
      expect(tableBlock.metadata?.headerState).toBe('unknown')
      expect(tableBlock.metadata?.hasHeader).toBe(false)
    })

    it('10. honors explicitly configured header ({ hasHeader: true })', async () => {
      const csv = Buffer.from('Col1,Col2,Col3\nVal1,Val2,Val3\nVal4,Val5,Val6\n', 'utf8')
      const result = await csvExtractor.extract({ bytes: csv }, undefined, { hasHeader: true })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.headers).toEqual(['Col1', 'Col2', 'Col3'])
      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[0]).toEqual(['Val1', 'Val2', 'Val3'])
      expect(tableBlock.metadata?.headerState).toBe('known')
      expect(tableBlock.metadata?.hasHeader).toBe(true)

      const cells = tableBlock.metadata?.cells as UniversalTableCell[][]
      expect(cells[0][0].isHeader).toBe(true)
      expect(cells[1][0].isHeader).toBeFalsy()
    })

    it('11. honors explicitly configured no-header ({ hasHeader: false })', async () => {
      const csv = Buffer.from('Col1,Col2,Col3\nVal1,Val2,Val3\n', 'utf8')
      const result = await csvExtractor.extract({ bytes: csv }, undefined, { hasHeader: false })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.headers).toEqual([])
      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[0]).toEqual(['Col1', 'Col2', 'Col3'])
      expect(tableBlock.metadata?.headerState).toBe('absent')
      expect(tableBlock.metadata?.hasHeader).toBe(false)
    })

    it('12. preserves empty first row without crashing or omitting subsequent records', async () => {
      const csv = Buffer.from(',,\nVal1,Val2,Val3\n', 'utf8')
      const result = await csvExtractor.extract({ bytes: csv })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[0]).toEqual(['', '', ''])
      expect(tableBlock.table?.rows[1]).toEqual(['Val1', 'Val2', 'Val3'])
    })

    it('13. preserves Bengali first row as ordinary data by default and honors explicit header', async () => {
      const csv = Buffer.from('বিভাগ,বাজেট,স্ট্যাটাস\nপ্রকৌশল,"৫০,০০,০০০",অনুমোদিত\n', 'utf8')

      // Default: ordinary data
      const defaultRes = await csvExtractor.extract({ bytes: csv })
      const defaultTable = defaultRes.blocks.find((b) => b.type === 'table')!
      expect(defaultTable.table?.headers).toEqual([])
      expect(defaultTable.table?.rows[0]).toEqual(['বিভাগ', 'বাজেট', 'স্ট্যাটাস'])
      expect(defaultTable.metadata?.headerState).toBe('unknown')

      // Explicit: header
      const explicitRes = await csvExtractor.extract({ bytes: csv }, undefined, { hasHeader: true })
      const explicitTable = explicitRes.blocks.find((b) => b.type === 'table')!
      expect(explicitTable.table?.headers).toEqual(['বিভাগ', 'বাজেট', 'স্ট্যাটাস'])
      expect(explicitTable.table?.rows[0]).toEqual(['প্রকৌশল', '৫০,০০,০০০', 'অনুমোদিত'])
      expect(explicitTable.metadata?.headerState).toBe('known')
    })

    it('14. preserves header-looking but ambiguous data as ordinary data by default', async () => {
      const csv = Buffer.from('Item,Code,Note\nPart A,PA-01,Active\n', 'utf8')
      const result = await csvExtractor.extract({ bytes: csv })
      const tableBlock = result.blocks.find((b) => b.type === 'table')!

      expect(tableBlock.table?.headers).toEqual([])
      expect(tableBlock.table?.rows[0]).toEqual(['Item', 'Code', 'Note'])
      expect(tableBlock.metadata?.headerState).toBe('unknown')
      expect(tableBlock.metadata?.heuristicHeaderSuggestion).toBe(true)
    })

    it('15. recovers safely from malformed CSV with unclosed quotes without discarding records', async () => {
      const rawCsv = 'Col1,Col2\nVal1,"Unclosed text without closing quote'
      const result = await csvExtractor.extract({ bytes: Buffer.from(rawCsv, 'utf8') })

      expect(result.warnings.some((w) => w.code === 'MALFORMED_CSV_UNCLOSED_QUOTE')).toBe(true)
      expect(result.quality.fidelity).toBe('medium')
      expect(result.quality.isLossy).toBe(true)
      expect(result.quality.hasUnparsedElements).toBe(true)

      const tableBlock = result.blocks.find((b) => b.type === 'table')!
      expect(tableBlock.table?.rows.length).toBe(2)
      expect(tableBlock.table?.rows[1][1]).toBe('Unclosed text without closing quote')
    })

    it('16. throws DocumentExtractionError when invalid UTF-8 bytes are encountered, preventing silent replacement characters', async () => {
      // Invalid UTF-8 sequence (overlong encoding / illegal byte)
      const invalidUtf8 = Buffer.from([0xc0, 0xaf, 0x41, 0x42])
      await expect(csvExtractor.extract({ bytes: invalidUtf8 })).rejects.toThrowError(
        expect.objectContaining({ code: 'EXTRACTION_INVALID_UTF8' })
      )
    })
  })

  // =========================================================================
  // 3. Application Pipeline & Chunker Compatibility
  // =========================================================================
  describe('3. Application Pipeline & Chunker Integration', () => {
    it('1. DocumentFileValidator accepts .csv files and computes SHA-256', async () => {
      const validator = new DocumentFileValidator()
      const fs = await import('node:fs')
      const path = await import('node:path')
      const os = await import('node:os')

      const tempDir = os.tmpdir()
      const tempCsv = path.join(tempDir, `test-${randomUUID()}.csv`)
      fs.writeFileSync(tempCsv, 'Name,Score\nAlice,98\nBob,95\n', 'utf8')

      try {
        const valResult = await validator.validate(tempCsv)
        expect(valResult.extension).toBe('csv')
        expect(valResult.fileType).toBe('csv')
        expect(valResult.mimeType).toBe('text/csv')
        expect(valResult.contentHash.length).toBe(64)
      } finally {
        if (fs.existsSync(tempCsv)) {
          fs.unlinkSync(tempCsv)
        }
      }
    })

    it('2. FormatDetector identifies CSV via hints and content heuristics', () => {
      const csvBytes = Buffer.from('Col1,Col2,Col3\nVal1,Val2,Val3\n', 'utf8')
      const detected = FormatDetector.detect(csvBytes, 'data.csv', 'text/csv')

      expect(detected.canonicalFormat).toBe('csv')
      expect(detected.isBinary).toBe(false)
    })

    it('3. SpreadsheetChunker chunks CSV and XLSX preserving sheet and row coordinates', async () => {
      const csvExtractor = new CsvExtractor()
      const chunker = new SpreadsheetChunker()

      const csvBuf = buildSyntheticCsv({
        rows: [
          ['Product', 'Revenue', 'Profit'],
          ['Widget A', 1000, 200],
          ['Widget B', 2500, 600]
        ]
      })

      const extractResult = await csvExtractor.extract({ bytes: csvBuf })
      const legacyDoc = universalDocumentToLegacy(
        documentExtractionResultToUniversalDocument(extractResult, {
          sourceId: randomUUID(),
          knowledgeBaseId: kbId,
          originalFileName: 'products.csv',
          mimeType: 'text/csv'
        })
      )

      const chunkResult = chunker.chunk(legacyDoc)
      expect(chunkResult.chunks.length).toBeGreaterThan(0)
      expect(chunkResult.chunks[0].content).toContain('[Spreadsheet Context]')
      expect(chunkResult.chunks[0].content).toContain('Worksheet: CSV Document')
      expect(chunkResult.chunks[0].content).toContain(
        'Row 1 | A1: Product | B1: Revenue | C1: Profit'
      )
      expect(chunkResult.chunks[0].content).toContain('Row 2 | A2: Widget A | B2: 1000 | C2: 200')
      expect(chunkResult.chunks[0].metadata.startRow).toBe(1)
    })

    it('4. SemanticChunker router delegates csv and xlsx to SpreadsheetChunker', async () => {
      const csvExtractor = new CsvExtractor()
      const semanticChunker = new SemanticChunker()

      const csvBuf = buildSyntheticCsv({
        rows: [
          ['Metric', 'Target'],
          ['Speed', 99]
        ]
      })

      const extractResult = await csvExtractor.extract({ bytes: csvBuf })
      const legacyDoc = universalDocumentToLegacy(
        documentExtractionResultToUniversalDocument(extractResult, {
          sourceId: randomUUID(),
          knowledgeBaseId: kbId,
          originalFileName: 'metrics.csv',
          mimeType: 'text/csv'
        })
      )

      const chunkResult = semanticChunker.chunk(legacyDoc)
      expect(chunkResult.chunks.length).toBeGreaterThan(0)
      expect(chunkResult.chunks[0].content).toContain('Worksheet: CSV Document')
    })
  })

  // =========================================================================
  // 4. Database Round-Trip Persistence & FTS5 Search
  // =========================================================================
  describe('4. Database Round-Trip Persistence & FTS5 Search', () => {
    it('1. persists canonical UniversalDocument for XLSX and retrieves it intact', () => {
      const ooxmlParser = new XlsxOoxmlParser()
      const buf = buildRichXlsx({
        sheets: [
          {
            name: 'FinancialQ3',
            cells: [
              { coordinate: 'A1', value: 'Quarterly Metric' },
              { coordinate: 'B1', value: 'Value USD' },
              { coordinate: 'A2', value: 'Net Profit' },
              { coordinate: 'B2', value: 850000, formula: '=SUM(B3:B5)' }
            ]
          }
        ]
      })

      const extractResult = ooxmlParser.parse(buf)
      const sourceId = randomUUID()
      const now = Date.now()

      const universalDoc = documentExtractionResultToUniversalDocument(extractResult, {
        sourceId,
        knowledgeBaseId: kbId,
        originalFileName: 'q3_financials.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      })

      validateUniversalDocument(universalDoc)

      // Register source in SQLite
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: kbId,
        file_name: 'q3_financials.xlsx',
        original_file_name: 'q3_financials.xlsx',
        relative_file_path: 'originals/q3_financials.xlsx',
        file_type: 'xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_size: buf.length,
        content_hash: '1'.repeat(64),
        indexing_status: 'completed',
        created_at: now,
        updated_at: now
      })

      // Persist UniversalDocument in Migration 009 repository
      extractedDocRepo.save(sourceId, universalDoc, now, kbId)

      // Retrieve and verify
      const retrieved = extractedDocRepo.get(sourceId, kbId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.format).toBe('xlsx')
      expect(retrieved?.originalFileName).toBe('q3_financials.xlsx')

      const tableBlock = retrieved?.blocks.find((b) => b.type === 'table') as UniversalTableBlock
      expect(tableBlock).toBeDefined()
      expect(tableBlock.isSpreadsheet).toBe(true)
      expect(tableBlock.sheetName).toBe('FinancialQ3')

      const cellB2 = tableBlock.cells![1][1]
      expect(cellB2.coordinate).toBe('B2')
      expect(cellB2.formula).toBe('=SUM(B3:B5)')
      expect(cellB2.value).toBe('850000')
    })

    it('2. persists canonical UniversalDocument for CSV and retrieves it intact', async () => {
      const csvExtractor = new CsvExtractor()
      const buf = buildSyntheticCsv({
        rows: [
          ['Project', 'Department', 'Budget'],
          ['Aether Drive', 'Propulsion', 1500000],
          ['Hyper Sensor', 'Avionics', 820000]
        ]
      })

      // Test with explicit headers
      const extractResult = await csvExtractor.extract({ bytes: buf }, undefined, {
        hasHeader: true
      })
      const sourceId = randomUUID()
      const now = Date.now()

      const universalDoc = documentExtractionResultToUniversalDocument(extractResult, {
        sourceId,
        knowledgeBaseId: kbId,
        originalFileName: 'projects.csv',
        mimeType: 'text/csv'
      })

      validateUniversalDocument(universalDoc)

      // Register source in SQLite
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: kbId,
        file_name: 'projects.csv',
        original_file_name: 'projects.csv',
        relative_file_path: 'originals/projects.csv',
        file_type: 'csv',
        mime_type: 'text/csv',
        file_size: buf.length,
        content_hash: '2'.repeat(64),
        indexing_status: 'completed',
        created_at: now,
        updated_at: now
      })

      // Persist UniversalDocument
      extractedDocRepo.save(sourceId, universalDoc, now, kbId)

      // Retrieve and verify
      const retrieved = extractedDocRepo.get(sourceId, kbId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.format).toBe('csv')
      expect(retrieved?.originalFileName).toBe('projects.csv')

      const tableBlock = retrieved?.blocks.find((b) => b.type === 'table') as UniversalTableBlock
      expect(tableBlock.isSpreadsheet).toBe(true)
      expect(tableBlock.headers).toEqual(['Project', 'Department', 'Budget'])
      expect(tableBlock.rows.length).toBe(2)

      // Also verify default extraction without explicit headers preserves all rows as data
      const defaultExtract = await csvExtractor.extract({ bytes: buf })
      const defaultDoc = documentExtractionResultToUniversalDocument(defaultExtract, {
        sourceId: randomUUID(),
        knowledgeBaseId: kbId,
        originalFileName: 'default_projects.csv',
        mimeType: 'text/csv'
      })
      const defaultTable = defaultDoc.blocks.find((b) => b.type === 'table') as UniversalTableBlock
      expect(defaultTable.headers).toEqual([])
      expect(defaultTable.rows.length).toBe(3)
      expect(defaultTable.rows[0]).toEqual(['Project', 'Department', 'Budget'])
    })

    it('3. indexes CSV and XLSX chunks into FTS5 and verifies query matches', async () => {
      const sourceIdXlsx = randomUUID()
      const sourceIdCsv = randomUUID()
      const now = Date.now()

      // Register sources
      sourceRepo.create({
        id: sourceIdXlsx,
        knowledge_base_id: kbId,
        file_name: 'telemetry.xlsx',
        original_file_name: 'telemetry.xlsx',
        relative_file_path: 'originals/telemetry.xlsx',
        file_type: 'xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_size: 1024,
        content_hash: '3'.repeat(64),
        indexing_status: 'completed',
        created_at: now,
        updated_at: now
      })

      sourceRepo.create({
        id: sourceIdCsv,
        knowledge_base_id: kbId,
        file_name: 'manifest.csv',
        original_file_name: 'manifest.csv',
        relative_file_path: 'originals/manifest.csv',
        file_type: 'csv',
        mime_type: 'text/csv',
        file_size: 512,
        content_hash: '4'.repeat(64),
        indexing_status: 'completed',
        created_at: now,
        updated_at: now
      })

      // Insert chunks for both
      const chunkXlsx: CreateKnowledgeChunkInput = {
        id: randomUUID(),
        knowledge_base_id: kbId,
        source_id: sourceIdXlsx,
        chunk_index: 0,
        content:
          '[Spreadsheet Context]\nWorksheet: Telemetry\nA1: PropulsionUnit Alpha | B1: MaxThrustKn 4850',
        page_number: null,
        token_count: 15,
        metadata_json: JSON.stringify({ sheetName: 'Telemetry' }),
        created_at: now
      }

      const chunkCsv: CreateKnowledgeChunkInput = {
        id: randomUUID(),
        knowledge_base_id: kbId,
        source_id: sourceIdCsv,
        chunk_index: 0,
        content:
          '[Spreadsheet Context]\nWorksheet: CSV Document\nA1: CargoIdentifier Beta | B1: Quantity 920',
        page_number: null,
        token_count: 14,
        metadata_json: JSON.stringify({ sheetName: 'CSV Document' }),
        created_at: now
      }

      sourceRepo.insertChunks([chunkXlsx, chunkCsv])

      // Search XLSX term
      const xlsxMatches = sourceRepo.searchChunks(kbId, 'PropulsionUnit')
      expect(xlsxMatches.length).toBe(1)
      expect(xlsxMatches[0].source_id).toBe(sourceIdXlsx)
      expect(xlsxMatches[0].file_type).toBe('xlsx')

      // Search CSV term
      const csvMatches = sourceRepo.searchChunks(kbId, 'CargoIdentifier')
      expect(csvMatches.length).toBe(1)
      expect(csvMatches[0].source_id).toBe(sourceIdCsv)
      expect(csvMatches[0].file_type).toBe('csv')
    })

    it('4. deleting a Knowledge Source cascades to remove its chunks, FTS entries, and extracted document', () => {
      const sourceId = randomUUID()
      const now = Date.now()

      // 1. Create source
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: kbId,
        file_name: 'test_delete.csv',
        original_file_name: 'test_delete.csv',
        relative_file_path: 'originals/test_delete.csv',
        file_type: 'csv',
        mime_type: 'text/csv',
        file_size: 100,
        content_hash: '9'.repeat(64),
        indexing_status: 'completed',
        created_at: now,
        updated_at: now
      })

      // 2. Insert chunk
      const chunkId = randomUUID()
      sourceRepo.insertChunks([
        {
          id: chunkId,
          knowledge_base_id: kbId,
          source_id: sourceId,
          chunk_index: 0,
          content: 'SecretKeywordToCascadeDelete in spreadsheet',
          page_number: null,
          token_count: 5,
          metadata_json: '{}',
          created_at: now
        }
      ])

      // 3. Save extracted document
      const doc = documentExtractionResultToUniversalDocument(
        {
          format: 'csv',
          text: 'SecretKeywordToCascadeDelete in spreadsheet',
          blocks: [],
          metadata: {},
          warnings: [],
          quality: { fidelity: 'high', isLossy: false, isOcr: false },
          extractor: {
            id: 'csv-extractor',
            name: 'CSV Extractor',
            version: '1.0.0',
            supportedFormats: ['csv'],
            supportedMimeTypes: ['text/csv'],
            isHeavy: false,
            requiresUtilityProcess: false
          }
        },
        { sourceId, knowledgeBaseId: kbId }
      )
      extractedDocRepo.save(sourceId, doc, now, kbId)

      // Confirm existence
      expect(extractedDocRepo.get(sourceId, kbId)).toBeDefined()
      expect(sourceRepo.searchChunks(kbId, 'SecretKeywordToCascadeDelete').length).toBe(1)

      // Delete source
      sourceRepo.delete(sourceId, kbId)

      // Verify cascade
      expect(extractedDocRepo.get(sourceId, kbId)).toBeNull()
      expect(sourceRepo.getById(sourceId, kbId)).toBeNull()
      expect(sourceRepo.searchChunks(kbId, 'SecretKeywordToCascadeDelete').length).toBe(0)
    })
  })

  // =========================================================================
  // 5. Security & Defensive Bounds
  // =========================================================================
  describe('5. Security & Defensive Bounds', () => {
    const ooxmlParser = new XlsxOoxmlParser()
    const csvExtractor = new CsvExtractor()

    it('1. rejects non-ZIP corrupted files for XLSX', () => {
      const corruptBytes = Buffer.from('NOT A ZIP FILE HEADER')
      expect(() => ooxmlParser.parse(corruptBytes)).toThrow(/PKZIP signature/)
    })

    it('2. rejects macro-enabled Excel packages (.xlsm / vbaProject.bin)', () => {
      // Build a ZIP with vbaProject.bin
      const writer = new ZipArchiveWriter()
      writer.addEntry(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
        new Date()
      )
      writer.addEntry(
        '_rels/.rels',
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        new Date()
      )
      writer.addEntry(
        'xl/workbook.xml',
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        new Date()
      )
      writer.addEntry('xl/vbaProject.bin', Buffer.from('VBA MACRO PAYLOAD'), new Date())
      const macroBuf = writer.build()

      expect(() => ooxmlParser.parse(macroBuf)).toThrow(/Macro-enabled/)
    })

    it('3. rejects external entity (XXE) injection in XLSX', () => {
      const writer = new ZipArchiveWriter()
      const xxeContent =
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      writer.addEntry('[Content_Types].xml', xxeContent, new Date())
      writer.addEntry(
        '_rels/.rels',
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        new Date()
      )
      writer.addEntry(
        'xl/workbook.xml',
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        new Date()
      )
      writer.addEntry(
        'xl/worksheets/sheet1.xml',
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
        new Date()
      )
      const xxeBuf = writer.build()

      expect(() => ooxmlParser.parse(xxeBuf)).toThrow(/external entity|DOCTYPE/i)
    })

    it('4. rejects empty CSV content fail-closed', async () => {
      await expect(csvExtractor.extract({ bytes: Buffer.alloc(0) })).rejects.toThrow(
        /empty|no text content/i
      )
      await expect(csvExtractor.extract({ bytes: Buffer.from('   \n\n  \t  \n') })).rejects.toThrow(
        /empty|no text content/i
      )
    })
  })
})
