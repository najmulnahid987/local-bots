import { describe, it, expect } from 'vitest'
import { XlsxExtractor, getExcelColumnName, formatCellValue } from './xlsx-extractor'
import { buildSyntheticXlsx } from '../../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../../services/zip-archive'

describe('XlsxExtractor (Phase 10 Step 10.7)', () => {
  const extractor = new XlsxExtractor()

  // 1. Column name mapping helper
  it('1. correctly maps 0-based column indices to Excel column letters', () => {
    expect(getExcelColumnName(0)).toBe('A')
    expect(getExcelColumnName(1)).toBe('B')
    expect(getExcelColumnName(25)).toBe('Z')
    expect(getExcelColumnName(26)).toBe('AA')
    expect(getExcelColumnName(27)).toBe('AB')
    expect(getExcelColumnName(51)).toBe('AZ')
    expect(getExcelColumnName(52)).toBe('BA')
    expect(getExcelColumnName(701)).toBe('ZZ')
    expect(getExcelColumnName(702)).toBe('AAA')
  })

  // 2. Format cell values helper
  it('2. formats various cell values deterministically', () => {
    expect(formatCellValue(null)).toBe('')
    expect(formatCellValue(undefined)).toBe('')
    expect(formatCellValue('Test Text')).toBe('Test Text')
    expect(formatCellValue(42)).toBe('42')
    expect(formatCellValue(3.14159)).toBe('3.14159')
    expect(formatCellValue(true)).toBe('TRUE')
    expect(formatCellValue(false)).toBe('FALSE')

    const dateMidnight = new Date('2026-05-15T00:00:00Z')
    expect(formatCellValue(dateMidnight)).toBe('2026-05-15')

    const dateWithTime = new Date('2026-05-15T14:30:00Z')
    expect(formatCellValue(dateWithTime)).toBe('2026-05-15T14:30:00.000Z')
  })

  // 3. Metadata & support checks
  it('3. advertises correct extractor metadata and supported formats', () => {
    expect(extractor.metadata.id).toBe('xlsx-extractor')
    expect(extractor.metadata.requiresUtilityProcess).toBe(true)
    expect(extractor.metadata.isHeavy).toBe(true)
    expect(extractor.metadata.supportedFormats).toContain('xlsx')

    expect(extractor.supports('xlsx')).toBe(true)
    expect(extractor.supports('XLSX')).toBe(true)
    expect(extractor.supports('.xlsx')).toBe(true)
    expect(extractor.supports('docx')).toBe(false)
    expect(extractor.supports('pdf')).toBe(false)
    expect(extractor.supports('txt')).toBe(false)
  })

  // 4. End-to-end extraction with multi-sheet workbook
  it('4. extracts multi-sheet spreadsheet preserving sheet names, ordering, and coordinates', async () => {
    const validXlsx = buildSyntheticXlsx({
      identifier: 'EXTRACT-TEST-001',
      summaryRows: [
        ['Metric', 'Q1 Actual', 'Q2 Projected'],
        ['Revenue', '1250000', '1400000'],
        ['Operating Margin', '0.22', '0.24']
      ],
      departmentRows: [
        ['Department', 'Headcount', 'Budget'],
        ['Engineering', '45', '4500000'],
        ['Operations', '20', '1800000']
      ]
    })

    const result = await extractor.extract({ bytes: validXlsx })

    expect(result.format).toBe('xlsx')
    expect(result.quality.fidelity).toBe('high')
    expect(result.metadata.sheetCount).toBe(2)
    expect(result.metadata.sheetNames).toEqual(['Executive_Summary', 'Department_Breakdown'])
    expect(result.metadata.totalPopulatedRows).toBe(6)

    // Check sheet boundary blocks
    const boundaryBlocks = result.blocks.filter((b) => b.type === 'sheet_boundary')
    expect(boundaryBlocks.length).toBe(2)
    expect(boundaryBlocks[0].sheet?.name).toBe('Executive_Summary')
    expect(boundaryBlocks[1].sheet?.name).toBe('Department_Breakdown')

    // Check table blocks
    const tableBlocks = result.blocks.filter((b) => b.type === 'table')
    expect(tableBlocks.length).toBe(2)
    expect(tableBlocks[0].table?.headers).toEqual(['Metric', 'Q1 Actual', 'Q2 Projected'])
    expect(tableBlocks[0].table?.rows.length).toBe(2)

    // Verify cell coordinate notation in extracted text
    expect(result.text).toContain('Row 1 | A1: Metric | B1: Q1 Actual | C1: Q2 Projected')
    expect(result.text).toContain('Row 2 | A2: Revenue | B2: 1250000 | C2: 1400000')
    expect(result.text).toContain('Row 2 | A2: Engineering | B2: 45 | C2: 4500000')

    // Verify warnings contain formula policy notice
    expect(result.warnings.some((w) => w.code === 'SPREADSHEET_FORMULA_POLICY')).toBe(true)
  })

  // 5. Bengali and multilingual text preservation
  it('5. extracts Bengali and unicode spreadsheet text faithfully', async () => {
    const bengaliXlsx = buildSyntheticXlsx({
      identifier: 'BENGALI-TEST-002',
      summaryRows: [
        ['বিভাগ', 'বাজেট', 'স্ট্যাটাস'],
        ['প্রকৌশল', '৫০,০০,০০০', 'অনুমোদিত'],
        ['গবেষণা ও উন্নয়ন', '২৫,০০,০০০', 'চলমান']
      ],
      departmentRows: [
        ['Code', 'Details'],
        ['BN-01', 'সিস্টেম টেস্ট সফল']
      ]
    })

    const result = await extractor.extract({ bytes: bengaliXlsx })

    expect(result.text).toContain('বিভাগ')
    expect(result.text).toContain('প্রকৌশল')
    expect(result.text).toContain('৫০,০০,০০০')
    expect(result.text).toContain('অনুমোদিত')
    expect(result.text).toContain('গবেষণা ও উন্নয়ন')
    expect(result.text).toContain('সিস্টেম টেস্ট সফল')
  })

  // 6. Cancellation support
  it('6. throws EXTRACTION_CANCELLED when AbortSignal is pre-aborted', async () => {
    const validXlsx = buildSyntheticXlsx({
      identifier: 'CANCEL-TEST-003',
      summaryRows: [
        ['A', 'B'],
        ['1', '2']
      ],
      departmentRows: [
        ['C', 'D'],
        ['3', '4']
      ]
    })

    const controller = new AbortController()
    controller.abort()

    await expect(
      extractor.extract(
        { bytes: validXlsx },
        {
          signal: controller.signal,
          limits: {
            timeoutMs: 30000,
            maxInputSizeBytes: 20971520,
            maxOutputSizeBytes: 52428800,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
  })

  // 7. Output size limit enforcement
  it('7. throws EXTRACTION_OUTPUT_LIMIT_EXCEEDED when extracted text exceeds maxOutputSizeBytes', async () => {
    const validXlsx = buildSyntheticXlsx({
      identifier: 'LIMIT-TEST-004',
      summaryRows: [
        ['Metric', 'Value'],
        ['A very long description that takes up some bytes in output', '123456789']
      ],
      departmentRows: [
        ['Dept', 'Code'],
        ['Operations', 'OP-99']
      ]
    })

    await expect(
      extractor.extract(
        { bytes: validXlsx },
        {
          limits: {
            timeoutMs: 30000,
            maxInputSizeBytes: 20971520,
            maxOutputSizeBytes: 50, // Tiny limit
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_OUTPUT_LIMIT_EXCEEDED' }))
  })

  // 8. Empty workbook error
  it('8. throws EXTRACTION_NO_TEXT_CONTENT when workbook has no populated cell values', async () => {
    const writer = new ZipArchiveWriter()
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    writer.addEntry('[Content_Types].xml', contentTypes)
    writer.addEntry(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    )
    writer.addEntry(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    )
    writer.addEntry(
      'xl/workbook.xml',
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="EmptySheet" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    writer.addEntry(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>'
    )

    const emptyWb = writer.build()

    await expect(extractor.extract({ bytes: emptyWb })).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_NO_TEXT_CONTENT' })
    )
  })
})
