import { describe, it, expect } from 'vitest'
import { PptxExtractor } from './pptx-extractor'
import { buildSyntheticPptx } from '../../benchmarks/fixtures/office-generator'
import { DEFAULT_EXTRACTION_LIMITS } from '../types'

describe('PptxExtractor (Phase 10 Step 10.9)', () => {
  const extractor = new PptxExtractor()

  const defaultPptx = buildSyntheticPptx({
    title: 'Aether Dynamics Strategy',
    identifier: 'PPTX-EXT-001',
    slides: [
      {
        title: 'Executive Summary',
        paragraphs: ['Autonomous systems achieved Q3 readiness target.'],
        bullets: ['Revenue reached $1.25M', 'Margin expanded to 22%'],
        speakerNotes: 'Highlight aerospace performance.'
      },
      {
        title: 'Department Metrics',
        tableRows: [
          ['Department', 'Headcount', 'Budget'],
          ['Aerospace', '45', '$4,500,000'],
          ['Navigation', '20', '$1,800,000']
        ]
      },
      {
        title: 'Future Directives',
        bullets: ['Initiate cold-fire test', 'Deliver telemetry package']
      }
    ]
  })

  // 1. Extractor metadata and format support
  it('1. correctly identifies PPTX support and metadata', () => {
    expect(extractor.supports('pptx')).toBe(true)
    expect(extractor.supports('PPTX')).toBe(true)
    expect(extractor.supports('.pptx')).toBe(true)
    expect(extractor.supports('docx')).toBe(false)
    expect(extractor.supports('xlsx')).toBe(false)
    expect(extractor.metadata.requiresUtilityProcess).toBe(true)
    expect(extractor.metadata.isHeavy).toBe(true)
  })

  // 2. Comprehensive extraction
  it('2. extracts structured slides, text, and metadata faithfully', async () => {
    const result = await extractor.extract({
      bytes: defaultPptx,
      filenameHint: 'presentation.pptx'
    })

    expect(result.format).toBe('pptx')
    expect(result.metadata?.pageCount).toBe(3)
    expect(result.metadata?.slideCount).toBe(3)
    expect(result.metadata?.title).toBe('Executive Summary')
    expect(result.blocks.length).toBeGreaterThan(0)

    // Check text contents
    expect(result.text).toContain('Executive Summary')
    expect(result.text).toContain('Autonomous systems achieved Q3 readiness target.')
    expect(result.text).toContain('Revenue reached $1.25M')
    expect(result.text).toContain('Department Metrics')
    expect(result.text).toContain('Aerospace')
    expect(result.text).toContain('Future Directives')
    expect(result.text).toContain('Speaker Notes: Highlight aerospace performance.')

    // Check slide boundaries
    const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
    expect(boundaries.length).toBe(3)
    expect(boundaries[0].slide?.number).toBe(1)
    expect(boundaries[0].slide?.title).toBe('Executive Summary')
    expect(boundaries[1].slide?.number).toBe(2)
    expect(boundaries[1].slide?.title).toBe('Department Metrics')
    expect(boundaries[2].slide?.number).toBe(3)
    expect(boundaries[2].slide?.title).toBe('Future Directives')
  })

  // 3. Table extraction
  it('3. extracts DrawingML tables into normalized table blocks and Markdown', async () => {
    const result = await extractor.extract({
      bytes: defaultPptx
    })

    const tableBlocks = result.blocks.filter((b) => b.type === 'table')
    expect(tableBlocks.length).toBe(1)

    const tableBlock = tableBlocks[0]
    expect(tableBlock.table).toBeDefined()
    expect(tableBlock.table?.headers).toEqual(['Department', 'Headcount', 'Budget'])
    expect(tableBlock.table?.rows).toHaveLength(2)
    expect(tableBlock.table?.rows[0]).toEqual(['Aerospace', '45', '$4,500,000'])
    expect(tableBlock.table?.rows[1]).toEqual(['Navigation', '20', '$1,800,000'])

    // Markdown formatted representation
    expect(tableBlock.text).toContain('| Department | Headcount | Budget |')
    expect(tableBlock.text).toContain('| Aerospace | 45 | $4,500,000 |')
  })

  // 4. Slide ordering invariant
  it('4. enforces strict presentation slide ordering defined by presentation.xml sldIdLst', async () => {
    // Reorder slides 1, 2, 3 as 3, 1, 2
    const reorderedPptx = buildSyntheticPptx({
      title: 'Reordered Presentation',
      identifier: 'PPTX-ORDER-001',
      slides: [
        { title: 'Slide Alpha (physically 1)', bullets: ['Alpha bullet'] },
        { title: 'Slide Beta (physically 2)', bullets: ['Beta bullet'] },
        { title: 'Slide Gamma (physically 3)', bullets: ['Gamma bullet'] }
      ],
      slideOrderOverride: [3, 1, 2]
    })

    const result = await extractor.extract({
      bytes: reorderedPptx
    })

    const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
    expect(boundaries).toHaveLength(3)
    // Slide 1 should be Gamma (3)
    expect(boundaries[0].slide?.number).toBe(1)
    expect(boundaries[0].slide?.title).toBe('Slide Gamma (physically 3)')

    // Slide 2 should be Alpha (1)
    expect(boundaries[1].slide?.number).toBe(2)
    expect(boundaries[1].slide?.title).toBe('Slide Alpha (physically 1)')

    // Slide 3 should be Beta (2)
    expect(boundaries[2].slide?.number).toBe(3)
    expect(boundaries[2].slide?.title).toBe('Slide Beta (physically 2)')
  })

  // 5. Bengali & Unicode preservation
  it('5. preserves Bengali and Unicode text without character corruption', async () => {
    const bengaliPptx = buildSyntheticPptx({
      title: 'বাংলা প্রেজেন্টেশন',
      identifier: 'PPTX-BN-001',
      slides: [
        {
          title: 'বাংলা উপস্থাপনা ও প্রযুক্তি',
          paragraphs: ['কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের কার্যকারিতা।'],
          bullets: ['প্রথম পয়েন্ট: নির্ভুল পাঠ্য আহরণ', 'দ্বিতীয় পয়েন্ট: নিরাপত্তা নিশ্চিতকরণ'],
          speakerNotes: 'বক্তার নোট: সঠিক বাংলা উচ্চারণ নিশ্চিত করুন।'
        }
      ]
    })

    const result = await extractor.extract({
      bytes: bengaliPptx
    })

    expect(result.text).toContain('বাংলা উপস্থাপনা ও প্রযুক্তি')
    expect(result.text).toContain('কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের কার্যকারিতা।')
    expect(result.text).toContain('প্রথম পয়েন্ট: নির্ভুল পাঠ্য আহরণ')
    expect(result.text).toContain('বক্তার নোট: সঠিক বাংলা উচ্চারণ নিশ্চিত করুন।')
  })

  // 6. Non-fatal warnings for omitted images and charts
  it('6. emits structured non-fatal warnings for skipped charts and images', async () => {
    const warningPptx = buildSyntheticPptx({
      title: 'Warning Test',
      identifier: 'PPTX-WARN-001',
      slides: [
        {
          title: 'Slide With Media',
          bullets: ['Contains chart and image'],
          hasChart: true,
          hasImage: true
        }
      ]
    })

    const result = await extractor.extract({
      bytes: warningPptx
    })

    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
    const chartWarning = result.warnings.find((w) => w.code === 'PPTX_CHART_SKIPPED')
    const imageWarning = result.warnings.find((w) => w.code === 'PPTX_IMAGE_SKIPPED')

    expect(chartWarning).toBeDefined()
    expect(chartWarning?.message).toContain('Slide 1')
    expect(imageWarning).toBeDefined()
    expect(imageWarning?.message).toContain('Slide 1')
  })

  // 7. Enforces output size limits
  it('7. throws EXTRACTION_OUTPUT_LIMIT_EXCEEDED when output exceeds configured threshold', async () => {
    await expect(
      extractor.extract(
        { bytes: defaultPptx },
        {
          limits: {
            ...DEFAULT_EXTRACTION_LIMITS,
            maxOutputSizeBytes: 50 // artificially small limit
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_OUTPUT_LIMIT_EXCEEDED' }))
  })

  // 8. Cancellation support
  it('8. aborts extraction promptly when AbortSignal is triggered', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      extractor.extract(
        { bytes: defaultPptx },
        {
          limits: DEFAULT_EXTRACTION_LIMITS,
          signal: controller.signal
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
  })
})
