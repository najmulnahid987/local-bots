import { describe, it, expect } from 'vitest'
import { DocxArchiveValidator } from './docx-archive-validator'
import { buildSyntheticDocx } from '../../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../../services/zip-archive'

describe('DocxArchiveValidator (Phase 10 Step 10.5)', () => {
  const validDocxBuffer = buildSyntheticDocx({
    title: 'Valid OpenXML Document',
    identifier: 'DOCX-VAL-001',
    headings: ['Executive Overview', 'Financial Summary', 'Strategic Recommendations'],
    tableRows: [
      ['Department', 'Q1 Budget', 'Q2 Allocation'],
      ['Aerospace', '$1,200,000', '$1,450,000'],
      ['Navigation', '$850,000', '$920,000']
    ]
  })

  // 1. Valid DOCX validation
  it('1. accepts and validates a standards-compliant DOCX OpenXML package', () => {
    const result = DocxArchiveValidator.validate(validDocxBuffer)

    expect(result.valid).toBe(true)
    expect(result.entryCount).toBeGreaterThan(0)
    expect(result.totalUncompressedSize).toBeGreaterThan(0)
    expect(result.entries).toContain('word/document.xml')
    expect(result.entries).toContain('[Content_Types].xml')
    expect(result.hasImages).toBe(false)
  })

  // 2. Empty or non-ZIP input
  it('2. rejects empty buffer with EXTRACTION_EMPTY_CONTENT', () => {
    expect(() => DocxArchiveValidator.validate(Buffer.alloc(0))).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_EMPTY_CONTENT' })
    )
  })

  it('3. rejects non-ZIP random bytes with EXTRACTION_INVALID_ARCHIVE', () => {
    const nonZip = Buffer.from('Not a zip file at all!')
    expect(() => DocxArchiveValidator.validate(nonZip)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_INVALID_ARCHIVE' })
    )
  })

  // 3. Missing required OpenXML parts
  it('4. rejects ZIP archive missing word/document.xml with EXTRACTION_MISSING_DOCX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('_rels/.rels', '<Relationships></Relationships>')
    const zipBytes = writer.build()

    expect(() => DocxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_DOCX_PARTS' })
    )
  })

  it('5. rejects ZIP archive missing [Content_Types].xml with EXTRACTION_MISSING_DOCX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    const zipBytes = writer.build()

    expect(() => DocxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_DOCX_PARTS' })
    )
  })

  // 4. Macro-enabled document rejection
  it('6. rejects macro-enabled documents containing vbaProject.bin with EXTRACTION_MACRO_NOT_ALLOWED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    writer.addEntry('word/vbaProject.bin', 'binary-macro-payload')
    const zipBytes = writer.build()

    expect(() => DocxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  // 5. Path traversal rejection
  it('7. rejects archive entries containing path traversal (..) with EXTRACTION_INVALID_ARCHIVE', () => {
    // Construct raw ZIP with a path traversal entry name
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('word/document.xml', '<w:document></w:document>')

    const standardZip = writer.build()
    // Mutate an entry name in central directory to include ../
    const mutated = Buffer.from(standardZip)
    const target = Buffer.from('[Content_Types].xml')
    const replacement = Buffer.from('../traversal.xml')
    const idx = mutated.indexOf(target)
    if (idx !== -1) {
      replacement.copy(mutated, idx)
    }

    expect(() => DocxArchiveValidator.validate(mutated)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_INVALID_ARCHIVE' })
    )
  })

  // 6. Limits enforcement
  it('8. rejects archive exceeding maxEntries limit with EXTRACTION_ARCHIVE_LIMIT_EXCEEDED', () => {
    expect(() => DocxArchiveValidator.validate(validDocxBuffer, { maxEntries: 2 })).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED' })
    )
  })

  it('9. rejects archive exceeding maxTotalUncompressedBytes limit with EXTRACTION_ARCHIVE_LIMIT_EXCEEDED', () => {
    expect(() =>
      DocxArchiveValidator.validate(validDocxBuffer, { maxTotalUncompressedBytes: 100 })
    ).toThrowError(expect.objectContaining({ code: 'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED' }))
  })

  // 7. XXE / DOCTYPE injection rejection
  it('10. rejects XML parts containing DOCTYPE entity expansion with EXTRACTION_XXE_DETECTED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      '<?xml version="1.0"?><!DOCTYPE test [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><Types>&xxe;</Types>'
    )
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    const zipBytes = writer.build()

    expect(() => DocxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_XXE_DETECTED' })
    )
  })

  // 8. Image detection
  it('11. flags presence of image entries without failing validation', () => {
    const writer = new ZipArchiveWriter()
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    writer.addEntry('[Content_Types].xml', contentTypes)
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    writer.addEntry('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const zipBytes = writer.build()

    const result = DocxArchiveValidator.validate(zipBytes)
    expect(result.valid).toBe(true)
    expect(result.hasImages).toBe(true)
    expect(result.imageEntries).toEqual(['word/media/image1.png'])
  })
})
