import { describe, it, expect } from 'vitest'
import { PptxArchiveValidator } from './pptx-archive-validator'
import { buildSyntheticPptx } from '../../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../../services/zip-archive'

describe('PptxArchiveValidator (Phase 10 Step 10.9)', () => {
  const validPptxBuffer = buildSyntheticPptx({
    title: 'Aether Dynamics Q3 Review',
    identifier: 'PPTX-VAL-001',
    slides: [
      {
        title: 'Q3 Overview',
        bullets: ['Revenue up 18%', 'Safety threshold exceeded']
      },
      {
        title: 'Department Progress',
        bullets: ['Aerospace deliverable on track', 'Autonomous navigation validated']
      }
    ]
  })

  // 1. Valid PPTX package acceptance
  it('1. accepts and validates a standards-compliant PPTX OpenXML package', () => {
    const result = PptxArchiveValidator.validate(validPptxBuffer)

    expect(result.valid).toBe(true)
    expect(result.entryCount).toBeGreaterThan(0)
    expect(result.totalUncompressedSize).toBeGreaterThan(0)
    expect(result.slideCount).toBe(2)
    expect(result.slideEntries).toContain('ppt/slides/slide1.xml')
    expect(result.slideEntries).toContain('ppt/slides/slide2.xml')
    expect(result.entries).toContain('ppt/presentation.xml')
    expect(result.entries).toContain('[Content_Types].xml')
    expect(result.hasMedia).toBe(false)
  })

  // 2. Empty or invalid binary inputs
  it('2. rejects empty buffer with EXTRACTION_EMPTY_CONTENT', () => {
    expect(() => PptxArchiveValidator.validate(Buffer.alloc(0))).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_EMPTY_CONTENT' })
    )
  })

  it('3. rejects non-ZIP random bytes with EXTRACTION_INVALID_ARCHIVE', () => {
    const nonZip = Buffer.from('Not a pptx presentation or zip archive')
    expect(() => PptxArchiveValidator.validate(nonZip)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_INVALID_ARCHIVE' })
    )
  })

  // 3. Legacy binary PowerPoint (.ppt) rejection
  it('4. rejects legacy binary PowerPoint (.ppt) files with EXTRACTION_INVALID_ARCHIVE', () => {
    const ole2Header = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00
    ])
    expect(() => PptxArchiveValidator.validate(ole2Header)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Legacy binary PowerPoint (.ppt) files are not supported')
      })
    )
  })

  // 4. Missing required OpenXML parts
  it('5. rejects ZIP archive missing ppt/presentation.xml with EXTRACTION_MISSING_PPTX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_PPTX_PARTS' })
    )
  })

  it('6. rejects ZIP archive missing [Content_Types].xml with EXTRACTION_MISSING_PPTX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_PPTX_PARTS' })
    )
  })

  it('7. rejects ZIP archive without any slide XML parts with EXTRACTION_MISSING_PPTX_PARTS', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MISSING_PPTX_PARTS' })
    )
  })

  // 5. Macro-enabled presentation rejection (.pptm / VBA binaries)
  it('8. rejects macro-enabled presentations containing ppt/vbaProject.bin with EXTRACTION_MACRO_NOT_ALLOWED', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    writer.addEntry('ppt/vbaProject.bin', Buffer.from('VBA bytecode'))
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  it('9. rejects macro-enabled content types in [Content_Types].xml', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/>
       </Types>`
    )
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MACRO_NOT_ALLOWED' })
    )
  })

  // 6. Office format mismatch detection
  it('10. rejects Word documents disguised with .pptx extension', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('word/document.xml', '<w:document></w:document>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Word document (.docx)')
      })
    )
  })

  it('11. rejects Excel spreadsheets disguised with .pptx extension', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('[Content_Types].xml', '<Types></Types>')
    writer.addEntry('xl/workbook.xml', '<workbook></workbook>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_ARCHIVE',
        message: expect.stringContaining('Excel spreadsheet (.xlsx)')
      })
    )
  })

  // 7. Path traversal and Zip Slip protection
  it('12. rejects archives containing directory traversal paths', () => {
    const writer = new ZipArchiveWriter()
    expect(() => writer.addEntry('../evil.xml', 'malicious')).toThrowError(/invalid segment/)
  })

  // 8. XXE / DTD expansion protection
  it('13. rejects archives containing DOCTYPE declarations in [Content_Types].xml', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      `<?xml version="1.0"?>
       <!DOCTYPE types [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
       </Types>`
    )
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_XXE_DETECTED' })
    )
  })

  it('14. rejects archives containing DOCTYPE declarations in ppt/presentation.xml', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      `<?xml version="1.0"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
       </Types>`
    )
    writer.addEntry(
      'ppt/presentation.xml',
      '<!DOCTYPE p [ <!ENTITY xxe SYSTEM "http://malicious.com"> ]><p:presentation></p:presentation>'
    )
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    const zipBytes = writer.build()

    expect(() => PptxArchiveValidator.validate(zipBytes)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_XXE_DETECTED' })
    )
  })

  // 9. Slide count limits
  it('15. rejects presentations exceeding maximum slide limits', () => {
    expect(() =>
      PptxArchiveValidator.validate(validPptxBuffer, {
        maxSlides: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED' }))
  })

  // 10. Media detection
  it('16. detects embedded images or media entries in PPTX packages', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry(
      '[Content_Types].xml',
      `<?xml version="1.0"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
       </Types>`
    )
    writer.addEntry('ppt/presentation.xml', '<p:presentation></p:presentation>')
    writer.addEntry('ppt/slides/slide1.xml', '<p:sld></p:sld>')
    writer.addEntry('ppt/media/image1.png', Buffer.from('PNG bytes'))
    const zipBytes = writer.build()

    const result = PptxArchiveValidator.validate(zipBytes)
    expect(result.valid).toBe(true)
    expect(result.hasMedia).toBe(true)
    expect(result.mediaEntries).toContain('ppt/media/image1.png')
  })
})
