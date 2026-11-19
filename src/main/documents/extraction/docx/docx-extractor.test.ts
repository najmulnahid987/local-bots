import { describe, it, expect } from 'vitest'
import { DocxExtractor } from './docx-extractor'
import { buildSyntheticDocx } from '../../benchmarks/fixtures/office-generator'
import { ZipArchiveWriter } from '../../../services/zip-archive'

describe('DocxExtractor (Phase 10 Step 10.5)', () => {
  const extractor = new DocxExtractor()

  const validDocxBuffer = buildSyntheticDocx({
    title: 'Autonomous System Specification',
    identifier: 'AUTONOMOUS-SPEC-001',
    headings: ['System Architecture', 'Telemetry Breakdown', 'Operational Directives'],
    tableRows: [
      ['Component', 'Throughput', 'Status'],
      ['LiDAR Matrix', '1.2 GB/s', 'Optimal'],
      ['Optical Flow', '850 MB/s', 'Calibrated']
    ]
  })

  // 1. Basic extraction
  it('1. extracts paragraphs, headings, and tables into normalized blocks', async () => {
    const result = await extractor.extract({
      bytes: validDocxBuffer,
      filenameHint: 'spec.docx'
    })

    expect(result.format).toBe('docx')
    expect(result.quality.fidelity).toBe('high')
    expect(result.quality.isOcr).toBe(false)
    expect(result.quality.isLossy).toBe(false)
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.text).toContain('Autonomous System Specification')
    expect(result.text).toContain('AUTONOMOUS-SPEC-001')
    expect(result.text).toContain('System Architecture')

    // Check heading block
    const headingBlock = result.blocks.find(
      (b) => b.type === 'heading' && b.text === 'System Architecture'
    )
    expect(headingBlock).toBeDefined()
    expect(headingBlock?.heading?.level).toBe(1)

    // Check table block
    const tableBlock = result.blocks.find((b) => b.type === 'table')
    expect(tableBlock).toBeDefined()
    expect(tableBlock?.table?.headers).toEqual(['Component', 'Throughput', 'Status'])
    expect(tableBlock?.table?.rows?.length).toBe(2)
  })

  // 2. Preserves Bengali Unicode content
  it('2. preserves Bengali Unicode characters with complete fidelity', async () => {
    const writer = new ZipArchiveWriter()
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    writer.addEntry('[Content_Types].xml', contentTypes)

    const bengaliDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>বাংলা নথিপত্র এবং নীতি বিবরণী</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>আমাদের স্থানীয় এআই সহকারী সম্পূর্ণ গোপনীয়তা রক্ষা করে কাজ করে। কোনো তথ্য বাহ্যিক সার্ভারে পাঠানো হয় না।</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>বিভাগ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>বাজেট</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>গবেষণা</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>৫০,০০,০০০ টাকা</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`
    writer.addEntry('word/document.xml', bengaliDocXml)

    const docxBytes = writer.build()
    const result = await extractor.extract({ bytes: docxBytes })

    expect(result.text).toContain('বাংলা নথিপত্র এবং নীতি বিবরণী')
    expect(result.text).toContain(
      'আমাদের স্থানীয় এআই সহকারী সম্পূর্ণ গোপনীয়তা রক্ষা করে কাজ করে।'
    )
    expect(result.text).toContain('গবেষণা')
    expect(result.text).toContain('৫০,০০,০০০ টাকা')
  })

  // 3. Image warnings
  it('3. safely skips embedded images and produces structured warnings', async () => {
    const writer = new ZipArchiveWriter()
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    writer.addEntry('[Content_Types].xml', contentTypes)

    const docWithImage = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>Text before image</w:t></w:r></w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p><w:r><w:t>Text after image</w:t></w:r></w:p>
  </w:body>
</w:document>`
    writer.addEntry('word/document.xml', docWithImage)
    writer.addEntry(
      'word/media/image1.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )

    const docxBytes = writer.build()
    const result = await extractor.extract({ bytes: docxBytes })

    expect(result.text).toContain('Text before image')
    expect(result.text).toContain('Text after image')
    expect(result.warnings.some((w) => w.code === 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED')).toBe(true)
  })

  // 4. Pre-aborted cancellation
  it('4. throws EXTRACTION_CANCELLED when context signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      extractor.extract(
        { bytes: validDocxBuffer },
        {
          signal: controller.signal,
          limits: {
            timeoutMs: 5000,
            maxInputSizeBytes: 1048576,
            maxOutputSizeBytes: 1048576,
            maxPages: 100
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
  })

  // 5. Output limit enforcement
  it('5. throws EXTRACTION_OUTPUT_LIMIT_EXCEEDED when text exceeds maxOutputSizeBytes', async () => {
    await expect(
      extractor.extract(
        { bytes: validDocxBuffer },
        {
          limits: {
            timeoutMs: 5000,
            maxInputSizeBytes: 1048576,
            maxOutputSizeBytes: 50,
            maxPages: 100
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_OUTPUT_LIMIT_EXCEEDED' }))
  })
})
