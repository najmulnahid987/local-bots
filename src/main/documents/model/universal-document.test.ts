import { describe, it, expect } from 'vitest'
import {
  type UniversalDocument,
  type UniversalDocumentBlock,
  type UniversalParagraphBlock,
  type UniversalListBlock,
  type UniversalTableBlock,
  type UniversalCodeBlock,
  type UniversalBlockVisitor,
  UNIVERSAL_BLOCK_TYPES,
  serializeUniversalDocument,
  deserializeUniversalDocument,
  safeDeserializeUniversalDocument,
  validateUniversalDocument,
  safeValidateUniversalDocument,
  matchUniversalBlock,
  traverseUniversalDocument,
  findBlocksByType,
  getTableBlocks,
  getCodeBlocks,
  getListBlocks,
  getBlocksByPage,
  getBlocksBySheet,
  getBlocksBySlide,
  getHeadingsHierarchy,
  documentExtractionResultToUniversalDocument,
  universalDocumentToExtractionResult,
  universalDocumentToLegacy,
  extractedDocumentToUniversalDocument
} from './index'
import type { DocumentExtractionResult } from '../extraction/types'
import type { ExtractedDocument } from '../extractors/types'
import { DocumentExtractionService } from '../extraction/extraction-service'

describe('Universal Structured Document Model (Phase 11 Step 11.2)', () => {
  const sampleExtractor = {
    id: 'test-universal-extractor',
    name: 'Test Universal Extractor',
    version: '1.0.0'
  }

  // Helper to build a comprehensive document containing all 10 block types
  function createComprehensiveDocument(): UniversalDocument {
    const blocks: UniversalDocumentBlock[] = [
      {
        id: 'blk-1',
        type: 'heading',
        orderIndex: 0,
        text: 'Executive Summary',
        level: 1,
        headingPath: ['Executive Summary'],
        location: { lineStart: 1, lineEnd: 1, pageNumber: 1 }
      },
      {
        id: 'blk-2',
        type: 'paragraph',
        orderIndex: 1,
        text: 'This document describes the universal intermediate representation.',
        location: { lineStart: 2, lineEnd: 2, pageNumber: 1 }
      },
      {
        id: 'blk-3',
        type: 'list',
        orderIndex: 2,
        text: '1. Architecture\n2. Implementation',
        ordered: true,
        items: [
          {
            text: 'Architecture',
            depth: 0,
            orderIndex: 0,
            itemNumber: 1,
            location: { lineStart: 3, lineEnd: 3, pageNumber: 1 }
          },
          {
            text: 'Implementation',
            depth: 0,
            orderIndex: 1,
            itemNumber: 2,
            location: { lineStart: 4, lineEnd: 4, pageNumber: 1 }
          }
        ],
        location: { lineStart: 3, lineEnd: 4, pageNumber: 1 }
      },
      {
        id: 'blk-4',
        type: 'table',
        orderIndex: 3,
        text: '| Col A | Col B |\n| --- | --- |\n| Val 1 | Val 2 |',
        caption: 'Metrics Overview',
        headers: ['Col A', 'Col B'],
        rows: [['Val 1', 'Val 2']],
        cells: [
          [
            { value: 'Val 1', coordinate: 'A2', rowIndex: 0, columnIndex: 0 },
            { value: 'Val 2', coordinate: 'B2', rowIndex: 0, columnIndex: 1 }
          ]
        ],
        rowCount: 1,
        columnCount: 2,
        location: { lineStart: 6, lineEnd: 8, pageNumber: 1 }
      },
      {
        id: 'blk-5',
        type: 'code',
        orderIndex: 4,
        text: '```typescript\nconst x = 42;\n```',
        code: 'const x = 42;',
        language: 'typescript',
        location: { lineStart: 10, lineEnd: 12, pageNumber: 1 }
      },
      {
        id: 'blk-6',
        type: 'page_boundary',
        orderIndex: 5,
        text: '--- Page 2 ---',
        pageNumber: 2,
        totalPages: 2,
        location: { pageNumber: 2 }
      },
      {
        id: 'blk-7',
        type: 'sheet_boundary',
        orderIndex: 6,
        text: 'Sheet: Q3 Data',
        sheetName: 'Q3 Data',
        sheetIndex: 1,
        totalSheets: 2,
        location: { sheetName: 'Q3 Data', sheetIndex: 1 }
      },
      {
        id: 'blk-8',
        type: 'slide_boundary',
        orderIndex: 7,
        text: 'Slide 1: Overview',
        slideNumber: 1,
        slideTitle: 'Overview',
        totalSlides: 5,
        location: { slideNumber: 1, slideTitle: 'Overview' }
      },
      {
        id: 'blk-9',
        type: 'image_reference',
        orderIndex: 8,
        text: '[Diagram: System Architecture]',
        elementType: 'diagram',
        referenceId: 'diag-001',
        altText: 'System diagram',
        caption: 'High-level architecture',
        extractionStatus: 'skipped',
        warning: 'Vector diagram skipped during text extraction',
        location: { pageNumber: 2 }
      },
      {
        id: 'blk-10',
        type: 'unknown',
        orderIndex: 9,
        text: '[Custom OLE Form Object]',
        originalType: 'w:customXml',
        rawContent: { tag: 'w:customXml', attributes: { id: 99 } },
        warning: 'Unsupported custom XML element preserved as unknown block',
        location: { pageNumber: 2 }
      }
    ]

    return {
      id: 'doc-uuid-0001',
      sourceId: 'src-uuid-0001',
      knowledgeBaseId: 'kb-uuid-0001',
      format: 'docx',
      originalFileName: 'quarterly_report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractor: sampleExtractor,
      extractedAt: 1732100000000,
      text: 'Full document text representation...',
      blocks,
      metadata: { department: 'Engineering', sensitivity: 'internal' },
      warnings: [
        {
          code: 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED',
          message: 'An embedded diagram was skipped.'
        }
      ],
      quality: {
        fidelity: 'high',
        isLossy: true,
        isOcr: false,
        confidence: 0.95
      },
      sourceInfo: {
        fileSizeBytes: 45000,
        pageCount: 2,
        sheetCount: 2,
        slideCount: 5,
        lineCount: 25,
        characterCount: 500,
        wordCount: 85
      }
    }
  }

  // ==========================================================================
  // Suite 1: Model Correctness & Block Typings
  // ==========================================================================
  describe('Suite 1: Model Correctness & Block Typings', () => {
    it('1.1 supports all 10 universal block types with strict discriminators', () => {
      expect(UNIVERSAL_BLOCK_TYPES).toHaveLength(10)
      expect(UNIVERSAL_BLOCK_TYPES).toContain('heading')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('paragraph')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('list')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('table')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('code')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('page_boundary')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('sheet_boundary')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('slide_boundary')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('image_reference')
      expect(UNIVERSAL_BLOCK_TYPES).toContain('unknown')
    })

    it('1.2 creates and validates a comprehensive document with all 10 block types', () => {
      const doc = createComprehensiveDocument()
      const validated = validateUniversalDocument(doc)

      expect(validated.id).toBe('doc-uuid-0001')
      expect(validated.format).toBe('docx')
      expect(validated.blocks).toHaveLength(10)
      expect(validated.blocks.map((b) => b.type)).toEqual([
        'heading',
        'paragraph',
        'list',
        'table',
        'code',
        'page_boundary',
        'sheet_boundary',
        'slide_boundary',
        'image_reference',
        'unknown'
      ])
    })

    it('1.3 maintains strictly monotonic orderIndex sequence across all blocks', () => {
      const doc = createComprehensiveDocument()
      for (let i = 0; i < doc.blocks.length; i++) {
        expect(doc.blocks[i].orderIndex).toBe(i)
      }
    })

    it('1.4 leaves optional source location properties undefined rather than inventing false values', () => {
      const minimalBlock: UniversalParagraphBlock = {
        id: 'blk-min-1',
        type: 'paragraph',
        orderIndex: 0,
        text: 'Plain text with no coordinates.'
      }

      expect(minimalBlock.location).toBeUndefined()
      expect(minimalBlock.parentBlockId).toBeUndefined()
      expect(minimalBlock.metadata).toBeUndefined()

      const validatedBlock = validateUniversalDocument({
        id: 'doc-min-1',
        format: 'txt',
        extractor: sampleExtractor,
        extractedAt: Date.now(),
        text: 'Plain text with no coordinates.',
        blocks: [minimalBlock],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      })

      expect(validatedBlock.blocks[0].location).toBeUndefined()
    })

    it('1.5 explicitly captures unknown and unsupported constructs without dropping them', () => {
      const doc = createComprehensiveDocument()
      const unknownBlocks = findBlocksByType(doc, 'unknown')

      expect(unknownBlocks).toHaveLength(1)
      expect(unknownBlocks[0].originalType).toBe('w:customXml')
      expect(unknownBlocks[0].rawContent).toBeDefined()
      expect(unknownBlocks[0].warning).toContain('Unsupported')
    })

    it('1.6 rejects invalid block type discriminator via Zod validation', () => {
      const invalidDoc = {
        ...createComprehensiveDocument(),
        blocks: [
          {
            id: 'blk-inv-1',
            type: 'invalid_block_type', // Invalid discriminator
            orderIndex: 0,
            text: 'Should fail'
          }
        ]
      }

      expect(() => validateUniversalDocument(invalidDoc)).toThrow()
      const safe = safeValidateUniversalDocument(invalidDoc)
      expect(safe.success).toBe(false)
    })

    it('1.7 rejects malformed blocks with missing required properties', () => {
      const missingHeadingLevel = {
        ...createComprehensiveDocument(),
        blocks: [
          {
            id: 'blk-inv-2',
            type: 'heading',
            orderIndex: 0,
            text: 'Heading without level',
            // missing level
            headingPath: ['Heading']
          }
        ]
      }

      expect(() => validateUniversalDocument(missingHeadingLevel)).toThrow()
    })
  })

  // ==========================================================================
  // Suite 2: Structural Preservation (Tables, Lists, Code, Boundaries)
  // ==========================================================================
  describe('Suite 2: Structural Preservation', () => {
    it('2.1 preserves multi-row, multi-column tables with headers, cells, and coordinates', () => {
      const tableBlock: UniversalTableBlock = {
        id: 'tbl-1',
        type: 'table',
        orderIndex: 0,
        text: 'Table text',
        caption: 'Employee Directory',
        headers: ['ID', 'Name', 'Department', 'Active'],
        rows: [
          ['101', 'Alice', 'Engineering', 'TRUE'],
          ['102', 'Bob', '', 'FALSE'] // Empty cell preserved
        ],
        cells: [
          [
            { value: '101', coordinate: 'A2', rowIndex: 0, columnIndex: 0 },
            { value: 'Alice', coordinate: 'B2', rowIndex: 0, columnIndex: 1 },
            { value: 'Engineering', coordinate: 'C2', rowIndex: 0, columnIndex: 2 },
            { value: 'TRUE', coordinate: 'D2', rowIndex: 0, columnIndex: 3 }
          ],
          [
            { value: '102', coordinate: 'A3', rowIndex: 1, columnIndex: 0 },
            { value: 'Bob', coordinate: 'B3', rowIndex: 1, columnIndex: 1 },
            { value: '', coordinate: 'C3', rowIndex: 1, columnIndex: 2 }, // Empty cell
            { value: 'FALSE', coordinate: 'D3', rowIndex: 1, columnIndex: 3 }
          ]
        ],
        rowCount: 2,
        columnCount: 4,
        isSpreadsheet: true,
        sheetName: 'Employees',
        sheetIndex: 1
      }

      const doc: UniversalDocument = {
        id: 'doc-tbl-1',
        format: 'xlsx',
        extractor: sampleExtractor,
        extractedAt: Date.now(),
        text: 'Table text',
        blocks: [tableBlock],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const validated = validateUniversalDocument(doc)
      const tables = getTableBlocks(validated)

      expect(tables).toHaveLength(1)
      expect(tables[0].headers).toEqual(['ID', 'Name', 'Department', 'Active'])
      expect(tables[0].rows).toHaveLength(2)
      expect(tables[0].rows[1][2]).toBe('') // Empty cell preserved without shifting
      expect(tables[0].cells?.[1][2].coordinate).toBe('C3')
      expect(tables[0].sheetName).toBe('Employees')
    })

    it('2.2 preserves structured lists with nesting depth, item numbers, and checkbox status', () => {
      const listBlock: UniversalListBlock = {
        id: 'lst-1',
        type: 'list',
        orderIndex: 0,
        text: 'List text',
        ordered: false,
        items: [
          { text: 'Parent Item 1', depth: 0, orderIndex: 0, checked: true },
          { text: 'Child Sub-item A', depth: 1, orderIndex: 1, checked: false },
          { text: 'Child Sub-item B', depth: 1, orderIndex: 2, checked: true },
          { text: 'Parent Item 2', depth: 0, orderIndex: 3 }
        ]
      }

      const doc: UniversalDocument = {
        id: 'doc-lst-1',
        format: 'md',
        extractor: sampleExtractor,
        extractedAt: Date.now(),
        text: 'List text',
        blocks: [listBlock],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const validated = validateUniversalDocument(doc)
      const lists = getListBlocks(validated)

      expect(lists).toHaveLength(1)
      expect(lists[0].items).toHaveLength(4)
      expect(lists[0].items[1].depth).toBe(1)
      expect(lists[0].items[0].checked).toBe(true)
      expect(lists[0].items[1].checked).toBe(false)
    })

    it('2.3 preserves code blocks with language identifiers and raw code body', () => {
      const codeBlock: UniversalCodeBlock = {
        id: 'code-1',
        type: 'code',
        orderIndex: 0,
        text: '```sql\nSELECT * FROM knowledge_sources;\n```',
        code: 'SELECT * FROM knowledge_sources;',
        language: 'sql',
        location: { lineStart: 15, lineEnd: 17 }
      }

      const doc: UniversalDocument = {
        id: 'doc-code-1',
        format: 'md',
        extractor: sampleExtractor,
        extractedAt: Date.now(),
        text: codeBlock.text,
        blocks: [codeBlock],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const validated = validateUniversalDocument(doc)
      const codeBlocks = getCodeBlocks(validated)

      expect(codeBlocks).toHaveLength(1)
      expect(codeBlocks[0].language).toBe('sql')
      expect(codeBlocks[0].code).toBe('SELECT * FROM knowledge_sources;')
      expect(codeBlocks[0].location?.lineStart).toBe(15)
    })

    it('2.4 accurately resolves blocks by page, sheet, and slide boundaries', () => {
      const doc = createComprehensiveDocument()

      const page1Blocks = getBlocksByPage(doc, 1)
      const page2Blocks = getBlocksByPage(doc, 2)
      expect(page1Blocks.length).toBeGreaterThan(0)
      expect(page2Blocks.length).toBeGreaterThan(0)

      const sheetBlocks = getBlocksBySheet(doc, 'Q3 Data')
      expect(sheetBlocks).toHaveLength(1)
      expect(sheetBlocks[0].type).toBe('sheet_boundary')

      const slideBlocks = getBlocksBySlide(doc, 1)
      expect(slideBlocks).toHaveLength(3)
      expect(slideBlocks[0].type).toBe('slide_boundary')
      expect(slideBlocks[1].type).toBe('image_reference')
      expect(slideBlocks[2].type).toBe('unknown')
    })
  })

  // ==========================================================================
  // Suite 3: Serialization & Deserialization Round-Trip
  // ==========================================================================
  describe('Suite 3: Serialization & Deserialization', () => {
    it('3.1 round-trips full universal document through JSON without data loss', () => {
      const original = createComprehensiveDocument()
      const json = serializeUniversalDocument(original)
      const restored = deserializeUniversalDocument(json)

      expect(restored.id).toBe(original.id)
      expect(restored.format).toBe(original.format)
      expect(restored.extractor).toEqual(original.extractor)
      expect(restored.blocks).toHaveLength(original.blocks.length)

      for (let i = 0; i < original.blocks.length; i++) {
        expect(restored.blocks[i].id).toBe(original.blocks[i].id)
        expect(restored.blocks[i].type).toBe(original.blocks[i].type)
        expect(restored.blocks[i].orderIndex).toBe(original.blocks[i].orderIndex)
        expect(restored.blocks[i].text).toBe(original.blocks[i].text)
        expect(restored.blocks[i].location).toEqual(original.blocks[i].location)
      }

      expect(restored.warnings).toEqual(original.warnings)
      expect(restored.quality).toEqual(original.quality)
      expect(restored.sourceInfo).toEqual(original.sourceInfo)
    })

    it('3.2 produces deterministic JSON stringification for identical document inputs', () => {
      const docA = createComprehensiveDocument()
      const docB = createComprehensiveDocument()

      const jsonA = serializeUniversalDocument(docA)
      const jsonB = serializeUniversalDocument(docB)

      expect(jsonA).toBe(jsonB)
    })

    it('3.3 rejects malformed JSON payloads gracefully without crashing', () => {
      const malformedJson = '{"id": "doc-1", "format": "txt", "blocks": [ INVALID JSON ]}'
      expect(() => deserializeUniversalDocument(malformedJson)).toThrow()

      const safeResult = safeDeserializeUniversalDocument(malformedJson)
      expect(safeResult.success).toBe(false)
      if (!safeResult.success) {
        expect(safeResult.error.message).toContain('Malformed JSON')
      }
    })

    it('3.4 rejects invalid block properties during deserialization validation', () => {
      const invalidJson = JSON.stringify({
        id: 'doc-1',
        format: 'txt',
        extractor: sampleExtractor,
        extractedAt: Date.now(),
        text: 'Sample',
        blocks: [
          {
            id: 'blk-1',
            type: 'heading',
            orderIndex: 0,
            text: 'Title',
            level: 7, // Invalid level > 6
            headingPath: ['Title']
          }
        ],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      })

      const safeResult = safeDeserializeUniversalDocument(invalidJson)
      expect(safeResult.success).toBe(false)
    })

    it('3.5 serializes documents with shared object references (DAG) across multiple blocks without false circular reference errors', () => {
      const doc = createComprehensiveDocument()
      const sharedDimensions = { cx: 9144000, cy: 6858000, orientation: 'landscape' }

      // Attach identical shared object reference to multiple block metadata and doc metadata
      const blocksWithShared = doc.blocks.map((b) => ({
        ...b,
        metadata: { ...(b.metadata ?? {}), dimensions: sharedDimensions }
      }))
      const docWithShared = {
        ...doc,
        metadata: { ...doc.metadata, dimensions: sharedDimensions },
        blocks: blocksWithShared
      }

      expect(() => serializeUniversalDocument(docWithShared)).not.toThrow()
      const json = serializeUniversalDocument(docWithShared)
      const deserialized = deserializeUniversalDocument(json)
      expect(deserialized.blocks.length).toBe(doc.blocks.length)
    })

    it('3.6 rejects actual circular object references during serialization', () => {
      const doc = createComprehensiveDocument()
      const circularMeta: Record<string, unknown> = { key: 'value' }
      circularMeta.self = circularMeta

      const docWithCycle = {
        ...doc,
        metadata: circularMeta
      } as unknown as UniversalDocument

      expect(() => serializeUniversalDocument(docWithCycle)).toThrow(/Circular reference detected/)
    })
  })

  // ==========================================================================
  // Suite 4: Block Processing & Exhaustive Pattern Matching
  // ==========================================================================
  describe('Suite 4: Block Processing & Pattern Matching', () => {
    it('4.1 matchUniversalBlock executes exhaustive matching across all 10 block types', () => {
      const doc = createComprehensiveDocument()
      const processedTypes: string[] = []

      for (const block of doc.blocks) {
        const typeName = matchUniversalBlock(block, {
          heading: (b) => `H${b.level}:${b.text}`,
          paragraph: (b) => `P:${b.text.slice(0, 10)}`,
          list: (b) => `L:${b.items.length} items`,
          table: (b) => `T:${b.rowCount}x${b.columnCount}`,
          code: (b) => `C:${b.language}`,
          page_boundary: (b) => `Page:${b.pageNumber}`,
          sheet_boundary: (b) => `Sheet:${b.sheetName}`,
          slide_boundary: (b) => `Slide:${b.slideNumber}`,
          image_reference: (b) => `Img:${b.elementType}`,
          unknown: (b) => `Unk:${b.originalType}`
        })
        processedTypes.push(typeName)
      }

      expect(processedTypes).toEqual([
        'H1:Executive Summary',
        'P:This docum',
        'L:2 items',
        'T:1x2',
        'C:typescript',
        'Page:2',
        'Sheet:Q3 Data',
        'Slide:1',
        'Img:diagram',
        'Unk:w:customXml'
      ])
    })

    it('4.2 traverseUniversalDocument visits blocks and aggregates results', () => {
      const doc = createComprehensiveDocument()
      const visitor: UniversalBlockVisitor<string> = {
        heading: (b) => `Heading: ${b.text}`,
        table: (b) => `Table: ${b.caption ?? 'Untitled'}`,
        code: (b) => `Code: ${b.language}`
      }

      const results = traverseUniversalDocument(doc, visitor)
      expect(results).toEqual([
        'Heading: Executive Summary',
        'Table: Metrics Overview',
        'Code: typescript'
      ])
    })

    it('4.3 getHeadingsHierarchy organizes blocks into hierarchical parent-child sections', () => {
      const doc = createComprehensiveDocument()
      const hierarchy = getHeadingsHierarchy(doc)

      expect(hierarchy).toHaveLength(1)
      expect(hierarchy[0].heading.text).toBe('Executive Summary')
      // All blocks following the heading belong to its section
      expect(hierarchy[0].children).toHaveLength(9)
    })
  })

  // ==========================================================================
  // Suite 5: Legacy Compatibility & Bridging
  // ==========================================================================
  describe('Suite 5: Legacy Compatibility & Bridging', () => {
    it('5.1 documentExtractionResultToUniversalDocument converts modern result without flattening', () => {
      const modernResult: DocumentExtractionResult = {
        format: 'docx',
        text: 'Document full text',
        blocks: [
          {
            type: 'heading',
            text: 'System Design',
            heading: { level: 1, headingPath: ['System Design'] }
          },
          {
            type: 'table',
            text: '| A | B |\n| 1 | 2 |',
            table: {
              headers: ['A', 'B'],
              rows: [['1', '2']],
              caption: 'Sample Table'
            }
          },
          {
            type: 'list',
            text: 'Item 1\nItem 2',
            list: {
              items: ['Item 1', 'Item 2'],
              ordered: false
            }
          }
        ],
        metadata: { author: 'Architect' },
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false },
        extractor: {
          id: 'docx-parser',
          name: 'DOCX Parser',
          version: '1.0.0',
          supportedFormats: ['docx']
        }
      }

      const universal = documentExtractionResultToUniversalDocument(modernResult, {
        documentId: 'doc-bridge-1',
        originalFileName: 'spec.docx'
      })

      expect(universal.id).toBe('doc-bridge-1')
      expect(universal.originalFileName).toBe('spec.docx')
      expect(universal.blocks).toHaveLength(3)

      // Verified: Table block was NOT flattened!
      expect(universal.blocks[1].type).toBe('table')
      const table = universal.blocks[1] as UniversalTableBlock
      expect(table.headers).toEqual(['A', 'B'])
      expect(table.rows).toEqual([['1', '2']])
      expect(table.caption).toBe('Sample Table')

      // Verified: List block was NOT flattened!
      expect(universal.blocks[2].type).toBe('list')
      const list = universal.blocks[2] as UniversalListBlock
      expect(list.items).toHaveLength(2)
      expect(list.items[0].text).toBe('Item 1')
    })

    it('5.2 universalDocumentToExtractionResult round-trips back to DocumentExtractionResult', () => {
      const doc = createComprehensiveDocument()
      const extractionResult = universalDocumentToExtractionResult(doc)

      expect(extractionResult.format).toBe(doc.format)
      expect(extractionResult.blocks).toHaveLength(doc.blocks.length)
      expect(extractionResult.extractor.id).toBe(doc.extractor.id)
      expect(extractionResult.quality.fidelity).toBe(doc.quality.fidelity)
    })

    it('5.3 universalDocumentToLegacy converts to ExtractedDocument for legacy chunker compatibility', () => {
      const doc = createComprehensiveDocument()
      const legacy = universalDocumentToLegacy(doc)

      expect(legacy.format).toBe('docx')
      expect(legacy.sections.length).toBeGreaterThan(0)
      expect(legacy.sections[0].heading).toBe('Executive Summary')
      expect(legacy.metadata?.universalDocumentId).toBe(doc.id)
      expect(legacy.metadata?.warnings).toBeDefined()
    })

    it('5.4 extractedDocumentToUniversalDocument converts legacy document to UniversalDocument', () => {
      const legacy: ExtractedDocument = {
        format: 'txt',
        text: 'Section 1 text.\n\nSection 2 text.',
        sections: [
          { text: 'Section 1 text.', lineStart: 1, lineEnd: 1 },
          { text: 'Section 2 text.', lineStart: 3, lineEnd: 3 }
        ],
        metadata: { lineCount: 3 }
      }

      const universal = extractedDocumentToUniversalDocument(legacy)

      expect(universal.format).toBe('txt')
      expect(universal.blocks).toHaveLength(2)
      expect(universal.blocks[0].type).toBe('paragraph')
      expect(universal.blocks[0].text).toBe('Section 1 text.')
      expect(universal.blocks[1].type).toBe('paragraph')
      expect(universal.blocks[1].text).toBe('Section 2 text.')
    })

    it('5.5 DocumentExtractionService.extractUniversal produces validated UniversalDocument directly', async () => {
      const service = new DocumentExtractionService()
      const mdContent = '# Title\n\nParagraph text.\n\n```python\nprint("hello")\n```'

      const universalDoc = await service.extractUniversal({
        bytes: Buffer.from(mdContent, 'utf-8'),
        formatHint: 'md',
        filenameHint: 'guide.md'
      })

      expect(universalDoc.format).toBe('md')
      expect(universalDoc.blocks.length).toBeGreaterThanOrEqual(2)
      expect(universalDoc.blocks[0].type).toBe('heading')
      expect(universalDoc.quality.fidelity).toBe('high')

      // Verify serialization round-trip on service output
      const json = serializeUniversalDocument(universalDoc)
      const parsed = deserializeUniversalDocument(json)
      expect(parsed.id).toBe(universalDoc.id)
    })
  })
})
