import { describe, it, expect } from 'vitest'
import { XlsxArchiveValidator } from './xlsx-archive-validator'
import { buildSyntheticXlsx } from '../../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../../services/zip-archive'

describe('XlsxArchiveValidator (Phase 10 Step 10.7)', () => {
  const validXlsxBuffer = buildSyntheticXlsx({
    identifier: 'XLSX-VAL-001',
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

  // 1. Valid XLSX package acceptance
  it('1. accepts and validates a standards-compliant XLSX OpenXML package', () => {
    const result = XlsxArchiveValidator.validate(validXlsxBuffer)

    expect(result.valid).toBe(true)
    expect(result.entryCount).toBeGreaterThan(0)
    expect(result.totalUncompressedSize).toBeGreaterThan(0)
    expect(result.sheetCount).toBe(2)
    expect(result.sheetEntries).toContain('xl/worksheets/sheet1.xml')
    expect(result.sheetEntries).toContain('xl/worksheets/sheet2.xml')
    expect(result.entries).toContain('xl/workbook.xml')
    expect(result.entries).toContain('[Content_Types].xml')
  })

  // 2. Empty or invalid binary inputs
  it('2. rejects empty buffer with EXTRACTION_EMPTY_CONTENT', () => {
    expect(() => XlsxArchiveValidator.validate(Buffer.alloc(0))).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_EMPTY_CONTENT' })
    )
  })

  it('3. rejects non-ZIP random bytes with EXTRACTION_INVALID_ARCHIVE', () => {
    const nonZip = Buffer.from('Not an excel file or zip archive')
    expect(() => XlsxArchiveValidator.validate(nonZip)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_INVALID_ARCHIVE' })
    )
  })

  // 3. Legacy binary Excel (.xls) rejection
  it('4. rejects legacy binary Excel (.xls) files with EXTRACTION_INVALID_ARCHIVE', () => {
    // OLE2 compound document header: 0xD0CF11E0A1B11AE1
    const ole2Header = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00
    ])
    expect(() => XlsxArchiveValidator.validate(ole2Header)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Legacy binary Excel (.xls) files are not supported')
      })
    )
  })

  // 4. Missing required OpenXML parts
  it('5. rejects ZIP archive missing xl/workbook.xml with EXTRACTION_MISSING_XLSX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_XLSX_PARTS' })
    )
  })

  it('6. rejects ZIP archive missing [Content_Types].xml with EXTRACTION_MISSING_XLSX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_XLSX_PARTS' })
    )
  })

  it('7. rejects ZIP archive without any worksheet XML parts with EXTRACTION_MISSING_XLSX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_XLSX_PARTS' })
    )
  })

  // 5. Macro-enabled document rejection (.xlsm / VBA binaries)
  it('8. rejects macro-enabled workbooks containing xl/vbaProject.bin with EXTRACTION_MACRO_NOT_ALLOWED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    writer.addEntry('xl/vbaProject.bin', 'vba-macro-binary')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  it('9. rejects macro-enabled workbooks declaring macroEnabled ContentType with EXTRACTION_MACRO_NOT_ALLOWED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'
    )
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  // 6. Mismatched Office formats rejection
  it('10. rejects Word documents (.docx) disguised as XLSX with EXTRACTION_INVALID_ARCHIVE', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Archive is a Word document (.docx)')
      })
    )
  })

  it('11. rejects PowerPoint presentations (.pptx) disguised as XLSX with EXTRACTION_INVALID_ARCHIVE', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Archive is a PowerPoint presentation (.pptx)')
      })
    )
  })

  it('12. rejects Excel binary workbooks (.xlsb) with EXTRACTION_INVALID_ARCHIVE', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/workbook.bin', 'binary-records')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Archive is a binary Excel workbook (.xlsb)')
      })
    )
  })

  // 7. Security: XML External Entity (XXE) and DOCTYPE rejection
  it('13. rejects archives with DOCTYPE in [Content_Types].xml with EXTRACTION_XXE_DETECTED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      '<!DOCTYPE doc SYSTEM "http://evil.com/xxe"><Types></Types>'
    )
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_XXE_DETECTED' })
    )
  })

  it('14. rejects archives with ENTITY declaration in xl/workbook.xml with EXTRACTION_XXE_DETECTED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
    )
    writer.addEntry(
      'xl/workbook.xml',
      '<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///etc/passwd">]><workbook>&secret;</workbook>'
    )
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')
    const zipBytes = writer.build()

    expect(() => XlsxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_XXE_DETECTED' })
    )
  })

  // 8. Path traversal and malicious entries
  it('15. rejects archive entries containing path traversal (..) with EXTRACTION_INVALID_ARCHIVE', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('xl/worksheets/sheet1.xml', '<worksheet></worksheet>')

    const standardZip = writer.build()
    // Mutate an entry name in central directory to include ../
    const mutated = Buffer.from(standardZip)
    const target = Buffer.from('[Content_Types].xml')
    const replacement = Buffer.from('../traversal.xml')
    const idx = mutated.indexOf(target)
    if (idx !== -1) {
      replacement.copy(mutated, idx)
    }

    expect(() => XlsxArchiveValidator.validate(mutated)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_INVALID_ARCHIVE' })
    )
  })

  // 9. Resource limits
  it('16. enforces maxSheets limit on workbooks', () => {
    expect(() => XlsxArchiveValidator.validate(validXlsxBuffer, { maxSheets: 1 })).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED',
        message: expect.stringContaining('exceeding maximum limit of 1')
      })
    )
  })

  it('17. enforces maxCompressedBytes limit', () => {
    expect(() =>
      XlsxArchiveValidator.validate(validXlsxBuffer, { maxCompressedBytes: 50 })
    ).toThrowError(expect.objectContaining({ code: 'FILE_TOO_LARGE' }))
  })
})
