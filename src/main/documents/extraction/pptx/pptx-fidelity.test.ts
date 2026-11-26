import { describe, it, expect } from 'vitest'
import { PptxExtractor } from './pptx-extractor'
import type { PptxPresentationDimensions, PptxSection } from './pptx-ooxml-parser'
import { buildRichPptx } from '../../benchmarks/fixtures/office-generator'
import {
  documentExtractionResultToUniversalDocument,
  universalDocumentToLegacy
} from '../../model/converter'
import { serializeUniversalDocument, deserializeUniversalDocument } from '../../model/schema'
import { PresentationChunker } from '../../chunking/presentation-chunker'
import type {
  UniversalTableBlock,
  UniversalImageReferenceBlock,
  UniversalTableCell
} from '../../model/types'

describe('Phase 11 Step 11.8: PPTX Extraction Fidelity & Structured PowerPoint Preservation', () => {
  const extractor = new PptxExtractor()

  // --------------------------------------------------------------------------
  // Suite 1: Slide Ordering & Authoritative Resolution Invariant
  // --------------------------------------------------------------------------
  describe('Suite 1: Slide Ordering & Authoritative Resolution Invariant', () => {
    it('1. enforces strict presentation slide ordering defined by presentation.xml <p:sldIdLst>', async () => {
      // Physical files: 1, 2, 3, 4. Presentation order: 4, 2, 1, 3
      const pptx = buildRichPptx({
        title: 'Order Test',
        slides: [
          { title: 'Slide Alpha (Phys 1)', paragraphs: ['Alpha content'] },
          { title: 'Slide Beta (Phys 2)', paragraphs: ['Beta content'] },
          { title: 'Slide Gamma (Phys 3)', paragraphs: ['Gamma content'] },
          { title: 'Slide Delta (Phys 4)', paragraphs: ['Delta content'] }
        ],
        slideOrderOverride: [4, 2, 1, 3]
      })

      const result = await extractor.extract({ bytes: pptx })

      const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
      expect(boundaries).toHaveLength(4)

      expect(boundaries[0].slide?.number).toBe(1)
      expect(boundaries[0].slide?.title).toBe('Slide Delta (Phys 4)')

      expect(boundaries[1].slide?.number).toBe(2)
      expect(boundaries[1].slide?.title).toBe('Slide Beta (Phys 2)')

      expect(boundaries[2].slide?.number).toBe(3)
      expect(boundaries[2].slide?.title).toBe('Slide Alpha (Phys 1)')

      expect(boundaries[3].slide?.number).toBe(4)
      expect(boundaries[3].slide?.title).toBe('Slide Gamma (Phys 3)')
    })

    it('2. preserves blank slides with slide_boundary and empty slide placeholder', async () => {
      const pptx = buildRichPptx({
        title: 'Blank Slide Test',
        slides: [
          { title: 'First Slide', paragraphs: ['Content 1'] },
          { isBlank: true },
          { title: 'Third Slide', paragraphs: ['Content 3'] }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
      expect(boundaries).toHaveLength(3)
      expect(boundaries[1].slide?.number).toBe(2)
      expect(boundaries[1].metadata?.isBlank).toBe(true)

      const blankPara = result.blocks.find(
        (b) => b.pageNumber === 2 && b.metadata?.isBlankSlide === true
      )
      expect(blankPara).toBeDefined()
      expect(blankPara?.text).toBe('[Empty Slide 2]')
    })

    it('3. detects hidden slides (show="0"), records isHidden: true and emits non-fatal warning', async () => {
      const pptx = buildRichPptx({
        title: 'Hidden Slide Test',
        slides: [
          { title: 'Visible Slide', paragraphs: ['Public information'] },
          { title: 'Confidential Addendum', isHidden: true, paragraphs: ['Internal notes only'] }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      expect(result.metadata?.hiddenSlideCount).toBe(1)
      const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
      expect(boundaries[1].metadata?.isHidden).toBe(true)

      const warning = result.warnings.find((w) => w.code === 'PPTX_SLIDE_HIDDEN')
      expect(warning).toBeDefined()
      expect(warning?.message).toContain('Slide 2 is marked as hidden')
    })
  })

  // --------------------------------------------------------------------------
  // Suite 2: Presentation Metadata, Dimensions, Sections & Transitions
  // --------------------------------------------------------------------------
  describe('Suite 2: Presentation Metadata, Dimensions, Sections & Transitions', () => {
    it('4. extracts widescreen 16:9 slide dimensions and landscape orientation', async () => {
      const pptx = buildRichPptx({
        title: 'Widescreen Presentation',
        dimensions: {
          cx: 12192000,
          cy: 6858000,
          type: 'screen16x9'
        },
        slides: [{ title: 'Slide 1', paragraphs: ['Content'] }]
      })

      const result = await extractor.extract({ bytes: pptx })
      const dims = result.metadata?.dimensions as PptxPresentationDimensions

      expect(dims).toBeDefined()
      expect(dims.cx).toBe(12192000)
      expect(dims.cy).toBe(6858000)
      expect(dims.orientation).toBe('landscape')
      expect(dims.type).toBe('screen16x9')
      expect(dims.widthPt).toBe(960)
      expect(dims.heightPt).toBe(540)
    })

    it('5. extracts portrait orientation when cy > cx', async () => {
      const pptx = buildRichPptx({
        title: 'Portrait Presentation',
        dimensions: {
          cx: 6858000,
          cy: 9144000,
          type: 'custom'
        },
        slides: [{ title: 'Portrait Slide', paragraphs: ['Content'] }]
      })

      const result = await extractor.extract({ bytes: pptx })
      const dims = result.metadata?.dimensions as PptxPresentationDimensions

      expect(dims.orientation).toBe('portrait')
    })

    it('6. parses slide sections (<p14:sectionLst>) and maps section names to slides', async () => {
      const pptx = buildRichPptx({
        title: 'Sectioned Deck',
        sections: [
          { name: 'Introduction', slideIndices: [1] },
          { name: 'Financial Metrics', slideIndices: [2, 3] }
        ],
        slides: [
          { title: 'Welcome', paragraphs: ['Introductory material'] },
          { title: 'Q3 Balance Sheet', paragraphs: ['Financial figures'] },
          { title: 'Cash Flow Analysis', paragraphs: ['Cash burn projections'] }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const sections = result.metadata?.sections as PptxSection[]
      expect(sections).toHaveLength(2)
      expect(sections[0].name).toBe('Introduction')
      expect(sections[1].name).toBe('Financial Metrics')

      const boundaries = result.blocks.filter((b) => b.type === 'slide_boundary')
      expect(boundaries[0].metadata?.sectionName).toBe('Introduction')
      expect(boundaries[1].metadata?.sectionName).toBe('Financial Metrics')
      expect(boundaries[2].metadata?.sectionName).toBe('Financial Metrics')
    })

    it('7. captures slide transition types and duration parameters', async () => {
      const pptx = buildRichPptx({
        title: 'Transition Deck',
        slides: [
          {
            title: 'Animated Slide',
            transition: { type: 'fade', dur: 1500, spd: 'slow' },
            paragraphs: ['Fades in gracefully']
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })
      const boundary = result.blocks.find((b) => b.type === 'slide_boundary')

      expect(boundary?.metadata?.transition).toEqual({
        type: 'fade',
        duration: 1500,
        speed: 'slow'
      })
    })
  })

  // --------------------------------------------------------------------------
  // Suite 3: Text Shapes, Formatting & Hierarchy
  // --------------------------------------------------------------------------
  describe('Suite 3: Text Shapes, Formatting & Hierarchy', () => {
    it('8. preserves slide titles and subtitles with distinct heading levels', async () => {
      const pptx = buildRichPptx({
        title: 'Title Hierarchy Deck',
        slides: [
          {
            title: 'Autonomous Navigation Architecture',
            subtitle: 'Phase 11 Engineering Milestone',
            paragraphs: ['Detailed technical overview']
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const headings = result.blocks.filter((b) => b.type === 'heading')
      expect(headings).toHaveLength(2)

      // Title -> level 1
      expect(headings[0].text).toBe('Autonomous Navigation Architecture')
      expect(headings[0].heading?.level).toBe(1)
      expect(headings[0].metadata?.isSlideTitle).toBe(true)

      // Subtitle -> level 2
      expect(headings[1].text).toBe('Phase 11 Engineering Milestone')
      expect(headings[1].heading?.level).toBe(2)
      expect(headings[1].metadata?.isSlideSubtitle).toBe(true)
    })

    it('9. preserves nested list hierarchies with accurate depth and numbering', async () => {
      const pptx = buildRichPptx({
        title: 'Nested List Deck',
        slides: [
          {
            title: 'Project Hierarchy',
            paragraphs: [
              { text: 'Root Objective', lvl: 0, buAutoNum: { type: 'arabicPeriod', startAt: 1 } },
              { text: 'Sub-task Alpha', lvl: 1, buChar: '•' },
              { text: 'Sub-task Beta', lvl: 1, buChar: '•' },
              { text: 'Nested Detail 1', lvl: 2, buChar: '-' },
              { text: 'Second Objective', lvl: 0, buAutoNum: { type: 'arabicPeriod', startAt: 2 } }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const listBlocks = result.blocks.filter((b) => b.type === 'list')
      expect(listBlocks.length).toBeGreaterThan(0)

      const listBlock = listBlocks[0]
      expect(listBlock.list?.items).toHaveLength(5)
      expect(listBlock.list?.itemDetails).toBeDefined()

      const details = listBlock.list!.itemDetails!
      expect(details[0].text).toBe('Root Objective')
      expect(details[0].depth).toBe(0)
      expect(details[0].itemNumber).toBe(1)

      expect(details[1].text).toBe('Sub-task Alpha')
      expect(details[1].depth).toBe(1)

      expect(details[3].text).toBe('Nested Detail 1')
      expect(details[3].depth).toBe(2)

      expect(details[4].text).toBe('Second Objective')
      expect(details[4].depth).toBe(0)
      expect(details[4].itemNumber).toBe(2)
    })

    it('10. respects <a:buNone> to prevent list categorization in body placeholders', async () => {
      const pptx = buildRichPptx({
        title: 'Non-bullet Deck',
        slides: [
          {
            title: 'Plain Text inside Placeholder',
            paragraphs: [
              { text: 'This paragraph has no bullet.', buNone: true },
              { text: 'This one is a regular bullet item.', buChar: '•' }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const paras = result.blocks.filter((b) => b.type === 'paragraph')
      const lists = result.blocks.filter((b) => b.type === 'list')

      expect(paras.some((p) => p.text === 'This paragraph has no bullet.')).toBe(true)
      expect(lists.some((l) => l.list?.items.includes('This one is a regular bullet item.'))).toBe(
        true
      )
    })

    it('11. preserves font formatting, size, and colors in metadata', async () => {
      const pptx = buildRichPptx({
        title: 'Formatted Deck',
        slides: [
          {
            title: 'Rich Text Run Formatting',
            paragraphs: [
              {
                runs: [
                  { text: 'Critical Alert: ', bold: true, color: 'FF0000', sz: 2400 },
                  { text: 'Core temperature elevated', italic: true, sz: 1800 }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const para = result.blocks.find(
        (b) => b.type === 'paragraph' && b.text.includes('Critical Alert')
      )
      expect(para).toBeDefined()
      expect(para?.text).toBe('Critical Alert: Core temperature elevated')

      const fmt = para?.metadata?.formatting as {
        hasBold?: boolean
        hasItalic?: boolean
        colorHex?: string
        fontSizePt?: number
      }
      expect(fmt).toBeDefined()
      expect(fmt.hasBold).toBe(true)
      expect(fmt.hasItalic).toBe(true)
      expect(fmt.colorHex).toBe('#FF0000')
      expect(fmt.fontSizePt).toBe(24)
    })

    it('12. recursively traverses grouped shapes (<p:grpSp>) and preserves groupPath', async () => {
      const pptx = buildRichPptx({
        title: 'Grouped Shapes Deck',
        slides: [
          {
            title: 'Subsystem Diagram',
            groups: [
              {
                name: 'Avionics Unit',
                shapes: [
                  { name: 'IMU Sensor', paragraphs: [{ text: 'Telemetry rate 100Hz' }] },
                  { name: 'GPS Receiver', paragraphs: [{ text: 'L1/L2 Dual Band' }] }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const imuPara = result.blocks.find((b) => b.text === 'Telemetry rate 100Hz')
      expect(imuPara).toBeDefined()
      expect(imuPara?.metadata?.groupPath).toEqual(['Avionics Unit'])
      expect(imuPara?.metadata?.shapeName).toBe('IMU Sensor')

      const gpsPara = result.blocks.find((b) => b.text === 'L1/L2 Dual Band')
      expect(gpsPara).toBeDefined()
      expect(gpsPara?.metadata?.groupPath).toEqual(['Avionics Unit'])
    })
  })

  // --------------------------------------------------------------------------
  // Suite 4: DrawingML Table Structure
  // --------------------------------------------------------------------------
  describe('Suite 4: DrawingML Table Structure', () => {
    it('13. preserves full 2D table geometry, cell coordinates, and Markdown rendering', async () => {
      const pptx = buildRichPptx({
        title: 'Table Deck',
        slides: [
          {
            title: 'Quarterly Financials',
            tables: [
              {
                firstRow: true,
                rows: [
                  {
                    cells: [{ text: 'Quarter' }, { text: 'Revenue' }, { text: 'Operating Margin' }]
                  },
                  {
                    cells: [{ text: 'Q1' }, { text: '$1,200,000' }, { text: '18.5%' }]
                  },
                  {
                    cells: [{ text: 'Q2' }, { text: '$1,450,000' }, { text: '21.0%' }]
                  }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const tableBlock = result.blocks.find((b) => b.type === 'table')
      expect(tableBlock).toBeDefined()
      expect(tableBlock?.table?.headers).toEqual(['Quarter', 'Revenue', 'Operating Margin'])
      expect(tableBlock?.table?.rows).toHaveLength(2)

      // Verify Markdown rendering
      expect(tableBlock?.text).toContain('| Quarter | Revenue | Operating Margin |')
      expect(tableBlock?.text).toContain('| Q1 | $1,200,000 | 18.5% |')

      // Verify 2D cell matrix
      const cells = tableBlock?.metadata?.cells as UniversalTableCell[][]
      expect(cells).toBeDefined()
      expect(cells).toHaveLength(3) // Header + 2 data rows
      expect(cells[0][0].isHeader).toBe(true)
      expect(cells[1][1].value).toBe('$1,200,000')
      expect(cells[1][1].rowIndex).toBe(1)
      expect(cells[1][1].columnIndex).toBe(1)
    })

    it('14. preserves column span (gridSpan) and empty cell coordinates accurately', async () => {
      const pptx = buildRichPptx({
        title: 'Merged Table Deck',
        slides: [
          {
            title: 'System Allocations',
            tables: [
              {
                rows: [
                  {
                    cells: [{ text: 'Component' }, { text: 'Redundancy Specs', gridSpan: 2 }]
                  },
                  {
                    cells: [
                      { text: 'Flight Controller' },
                      { text: 'Primary: Triple Core' },
                      { text: 'Secondary: Fail-safe' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })
      const tableBlock = result.blocks.find((b) => b.type === 'table')

      const cells = tableBlock?.metadata?.cells as UniversalTableCell[][]
      expect(cells[0][1].colSpan).toBe(2)
      expect(cells[0][1].value).toBe('Redundancy Specs')
      expect(cells[1][2].columnIndex).toBe(2)
    })
  })

  // --------------------------------------------------------------------------
  // Suite 5: Speaker Notes, Comments & Annotations
  // --------------------------------------------------------------------------
  describe('Suite 5: Speaker Notes, Comments & Annotations', () => {
    it('15. extracts speaker notes and ignores slide thumbnail boilerplate', async () => {
      const pptx = buildRichPptx({
        title: 'Notes Deck',
        slides: [
          {
            title: 'Technical Review',
            paragraphs: ['Reviewing battery thermal margins.'],
            speakerNotes:
              'Speaker reminder: emphasize that telemetry was collected under vacuum chamber conditions.'
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const notesBlock = result.blocks.find(
        (b) => b.type === 'paragraph' && b.metadata?.isSpeakerNotes === true
      )
      expect(notesBlock).toBeDefined()
      expect(notesBlock?.text).toBe(
        '[Speaker Notes: Speaker reminder: emphasize that telemetry was collected under vacuum chamber conditions.]'
      )
      expect(result.text).toContain('vacuum chamber conditions')
    })

    it('16. links slide comments with author attribution and timestamps', async () => {
      const pptx = buildRichPptx({
        title: 'Commented Deck',
        commentAuthors: [
          { id: '0', name: 'Dr. Jane Doe', initials: 'JD' },
          { id: '1', name: 'Marcus Vance', initials: 'MV' }
        ],
        slides: [
          {
            title: 'Propulsion Schematic',
            paragraphs: ['Main fuel oxidizer ratio set to 2.4.'],
            comments: [
              {
                authorId: '0',
                date: '2026-11-20T14:30:00Z',
                text: 'Please confirm safety margin at 110% throttle.'
              },
              {
                authorId: '1',
                date: '2026-11-20T15:15:00Z',
                text: 'Thermal analysis indicates 14% headroom.'
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const comments = result.blocks.filter((b) => b.metadata?.isComment === true)
      expect(comments).toHaveLength(2)

      expect(comments[0].text).toContain('Dr. Jane Doe')
      expect(comments[0].text).toContain('Please confirm safety margin at 110% throttle.')
      expect(comments[0].metadata?.author).toBe('Dr. Jane Doe')
      expect(comments[0].metadata?.initials).toBe('JD')

      expect(comments[1].text).toContain('Marcus Vance')
      expect(comments[1].text).toContain('Thermal analysis indicates 14% headroom.')
    })
  })

  // --------------------------------------------------------------------------
  // Suite 6: Charts, SmartArt, Diagrams & OLE Objects
  // --------------------------------------------------------------------------
  describe('Suite 6: Charts, SmartArt, Diagrams & OLE Objects', () => {
    it('17. extracts cached chart categories, series, and values into structured table with warning', async () => {
      const pptx = buildRichPptx({
        title: 'Chart Deck',
        slides: [
          {
            title: 'Annual Performance Metrics',
            charts: [
              {
                title: 'Revenue by Division',
                categories: ['Aerospace', 'Autonomous Nav', 'Deep Space'],
                series: [
                  { name: '2025 Actual ($M)', values: [4.2, 2.8, 1.1] },
                  { name: '2026 Target ($M)', values: [6.5, 4.0, 2.5] }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const chartBlock = result.blocks.find((b) => b.metadata?.isChart === true)
      expect(chartBlock).toBeDefined()
      expect(chartBlock?.text).toContain('[Chart: Revenue by Division]')
      expect(chartBlock?.text).toContain('| Aerospace | 4.2 | 6.5 |')
      expect(chartBlock?.text).toContain('| Deep Space | 1.1 | 2.5 |')

      const chartWarning = result.warnings.find((w) => w.code === 'PPTX_CHART_CACHED_ONLY')
      expect(chartWarning).toBeDefined()
      expect(chartWarning?.message).toContain('cached values preserved')
    })

    it('18. extracts SmartArt node text and emits PPTX_SMARTART_PARTIAL warning', async () => {
      const pptx = buildRichPptx({
        title: 'SmartArt Deck',
        slides: [
          {
            title: 'Development Workflow',
            diagrams: [
              {
                nodes: [
                  'Phase 1: Architecture Audit',
                  'Phase 2: Universal Model',
                  'Phase 3: Persistence'
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const diagBlock = result.blocks.find((b) => b.metadata?.isDiagram === true)
      expect(diagBlock).toBeDefined()
      expect(diagBlock?.text).toContain('Phase 1: Architecture Audit')
      expect(diagBlock?.text).toContain('Phase 2: Universal Model')
      expect(diagBlock?.text).toContain('Phase 3: Persistence')

      const diagWarning = result.warnings.find((w) => w.code === 'PPTX_SMARTART_PARTIAL')
      expect(diagWarning).toBeDefined()
    })

    it('19. preserves embedded images as UniversalImageReferenceBlock with PPTX_IMAGE_SKIPPED warning', async () => {
      const pptx = buildRichPptx({
        title: 'Image Deck',
        slides: [
          {
            title: 'System Schematic',
            images: [
              {
                name: 'Thruster CAD',
                altText: 'Cross section of reaction control thruster assembly',
                caption: 'Figure 4.1 Thruster Valve Assembly'
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const imgBlock = result.blocks.find((b) => b.type === 'image_reference')
      expect(imgBlock).toBeDefined()
      expect(imgBlock?.text).toBe('[Image: Cross section of reaction control thruster assembly]')
      expect(imgBlock?.imageReference?.altText).toBe(
        'Cross section of reaction control thruster assembly'
      )
      expect(imgBlock?.imageReference?.caption).toBe('Figure 4.1 Thruster Valve Assembly')
      expect(imgBlock?.imageReference?.extractionStatus).toBe('skipped')

      const imgWarning = result.warnings.find((w) => w.code === 'PPTX_IMAGE_SKIPPED')
      expect(imgWarning).toBeDefined()
    })

    it('20. detects embedded OLE objects and emits PPTX_EMBEDDED_OBJECT_SKIPPED warning', async () => {
      const pptx = buildRichPptx({
        title: 'OLE Deck',
        slides: [
          {
            title: 'Financial Model Integration',
            oleObjects: [{ progId: 'Excel.Sheet.12', name: 'Q4 Projections Model' }]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const oleBlock = result.blocks.find((b) => b.metadata?.isEmbeddedObject === true)
      expect(oleBlock).toBeDefined()
      expect(oleBlock?.text).toBe('[Embedded Object: Q4 Projections Model]')

      const oleWarning = result.warnings.find((w) => w.code === 'PPTX_EMBEDDED_OBJECT_SKIPPED')
      expect(oleWarning).toBeDefined()
      expect(oleWarning?.message).toContain('Excel.Sheet.12')
    })
  })

  // --------------------------------------------------------------------------
  // Suite 7: Hyperlinks, Unicode, Bengali & Character Fidelity
  // --------------------------------------------------------------------------
  describe('Suite 7: Hyperlinks, Unicode, Bengali & Character Fidelity', () => {
    it('21. captures hyperlink targets on text runs without executing outbound requests', async () => {
      const pptx = buildRichPptx({
        title: 'Hyperlink Deck',
        slides: [
          {
            title: 'Documentation References',
            paragraphs: [
              {
                runs: [
                  {
                    text: 'Antigravity Specification',
                    hyperlink: {
                      target: 'https://antigravity.internal/docs/spec',
                      isExternal: true
                    }
                  }
                ]
              }
            ]
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      const para = result.blocks.find((b) => b.text === 'Antigravity Specification')
      expect(para).toBeDefined()

      const links = para?.metadata?.hyperlinks as Array<{
        text: string
        target: string
        isExternal: boolean
      }>
      expect(links).toBeDefined()
      expect(links).toHaveLength(1)
      expect(links[0].text).toBe('Antigravity Specification')
      expect(links[0].target).toBe('https://antigravity.internal/docs/spec')
      expect(links[0].isExternal).toBe(true)
    })

    it('22. preserves Bengali script, Arabic, CJK, math symbols, and emoji without distortion', async () => {
      const pptx = buildRichPptx({
        title: 'বহুভাষিক উপস্থাপনা (Multilingual Deck)',
        slides: [
          {
            title: 'বাংলা ও আন্তর্জাতিক ভাষা সহায়তা 🚀',
            paragraphs: [
              'কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের সার্বভৌমিক বাস্তবায়ন।',
              'العربية: أنظمة الذكاء الاصطناعي المحلية الآمنة',
              '日本語: ローカル第一の自律型エージェント基盤',
              'Math: ∀x ∈ ℝ, e^{iπ} + 1 = 0 ∧ ∑_{i=1}^n x_i ≥ 0'
            ],
            speakerNotes:
              'বক্তার মন্তব্য: বাংলা যুক্তাক্ষর এবং বিরামচিহ্ন সঠিকভাবে সংরক্ষিত হয়েছে।'
          }
        ]
      })

      const result = await extractor.extract({ bytes: pptx })

      expect(result.text).toContain('বাংলা ও আন্তর্জাতিক ভাষা সহায়তা 🚀')
      expect(result.text).toContain(
        'কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের সার্বভৌমিক বাস্তবায়ন।'
      )
      expect(result.text).toContain('العربية: أنظمة الذكاء الاصطناعي المحلية الآمنة')
      expect(result.text).toContain('日本語: ローカル第一の自律型エージェント基盤')
      expect(result.text).toContain('∀x ∈ ℝ, e^{iπ} + 1 = 0')
      expect(result.text).toContain(
        'বক্তার মন্তব্য: বাংলা যুক্তাক্ষর এবং বিরামচিহ্ন সঠিকভাবে সংরক্ষিত হয়েছে।'
      )
    })
  })

  // --------------------------------------------------------------------------
  // Suite 8: UniversalDocument Integration & PresentationChunker Compatibility
  // --------------------------------------------------------------------------
  describe('Suite 8: UniversalDocument Integration & PresentationChunker Compatibility', () => {
    it('23. converts extraction result to canonical UniversalDocument retaining all blocks and provenance', async () => {
      const pptx = buildRichPptx({
        title: 'Universal Integration Deck',
        slides: [
          {
            title: 'Overview',
            paragraphs: ['Core architectural components'],
            tables: [
              {
                firstRow: true,
                rows: [
                  { cells: [{ text: 'Layer' }, { text: 'Function' }] },
                  { cells: [{ text: 'Ingestion' }, { text: 'Information-preserving extraction' }] }
                ]
              }
            ],
            images: [{ name: 'Architecture Diagram', altText: 'Overview diagram' }]
          }
        ]
      })

      const rawResult = await extractor.extract({ bytes: pptx })
      const universalDoc = documentExtractionResultToUniversalDocument(rawResult, {
        documentId: 'doc-pptx-001',
        sourceId: 'src-001',
        knowledgeBaseId: 'kb-001'
      })

      expect(universalDoc.format).toBe('pptx')
      expect(universalDoc.blocks.length).toBeGreaterThanOrEqual(4)

      const slideBoundary = universalDoc.blocks.find((b) => b.type === 'slide_boundary')
      expect(slideBoundary).toBeDefined()
      expect(slideBoundary?.location?.slideNumber).toBe(1)

      const tableBlock = universalDoc.blocks.find((b) => b.type === 'table') as UniversalTableBlock
      expect(tableBlock).toBeDefined()
      expect(tableBlock.headers).toEqual(['Layer', 'Function'])
      expect(tableBlock.rows).toHaveLength(1)
      expect(tableBlock.cells).toBeDefined()

      const imgBlock = universalDoc.blocks.find(
        (b) => b.type === 'image_reference'
      ) as UniversalImageReferenceBlock
      expect(imgBlock).toBeDefined()
      expect(imgBlock.elementType).toBe('image')
      expect(imgBlock.altText).toBe('Overview diagram')
    })

    it('24. produces chunkable document sections compatible with PresentationChunker', async () => {
      const pptx = buildRichPptx({
        title: 'Chunking Deck',
        slides: [
          {
            title: 'Architecture Strategy',
            paragraphs: ['Strategy discussion and roadmap for local agents.']
          },
          {
            title: 'Execution Matrix',
            paragraphs: ['Sprint deliverables and verification gates.']
          }
        ]
      })

      const rawResult = await extractor.extract({ bytes: pptx })
      const universalDoc = documentExtractionResultToUniversalDocument(rawResult)
      const legacyDoc = universalDocumentToLegacy(universalDoc)
      const chunker = new PresentationChunker()
      const chunkingResult = chunker.chunk(legacyDoc)

      expect(chunkingResult.totalChunks).toBeGreaterThanOrEqual(2)
      expect(chunkingResult.chunks[0].metadata?.slideNumber).toBe(1)
      expect(chunkingResult.chunks[0].content).toContain('[Slide 1: Architecture Strategy]')
      expect(chunkingResult.chunks[1].metadata?.slideNumber).toBe(2)
      expect(chunkingResult.chunks[1].content).toContain('[Slide 2: Execution Matrix]')
    })

    it('25. successfully serializes and deserializes multi-slide PPTX UniversalDocument without circular reference errors', async () => {
      const pptx = buildRichPptx({
        title: 'Multi-Slide Serialization Deck',
        slides: [
          {
            title: 'Slide 1: Ingestion',
            paragraphs: ['Paragraph 1', 'Paragraph 2']
          },
          {
            title: 'Slide 2: Chunking',
            paragraphs: ['Paragraph 3', 'Paragraph 4']
          },
          {
            title: 'Slide 3: Retrieval',
            paragraphs: ['Paragraph 5']
          }
        ]
      })

      const rawResult = await extractor.extract({ bytes: pptx })
      const universalDoc = documentExtractionResultToUniversalDocument(rawResult, {
        documentId: 'doc-pptx-multi',
        sourceId: 'src-pptx-multi',
        knowledgeBaseId: 'kb-001'
      })

      // Verify serialization does not throw Circular reference error on blocks[x].metadata.dimensions
      expect(() => serializeUniversalDocument(universalDoc)).not.toThrow()
      const json = serializeUniversalDocument(universalDoc)
      expect(typeof json).toBe('string')
      expect(json).toContain('Slide 1: Ingestion')
      expect(json).toContain('Slide 2: Chunking')

      const deserialized = deserializeUniversalDocument(json)
      expect(deserialized.id).toBe(universalDoc.id)
      expect(deserialized.blocks.length).toBe(universalDoc.blocks.length)
    })
  })
})
