import { describe, it, expect } from 'vitest'
import { ExtractionCompletenessEvaluator } from './extraction-completeness-evaluator'
import type { UniversalDocument } from '../model/types'
import type { SourceElementInventory } from './types'

function makeMockDoc(
  text: string,
  warnings: Array<{ code: string; message: string }> = []
): UniversalDocument {
  return {
    id: 'doc-eval-1',
    format: 'txt',
    extractedAt: Date.now(),
    extractor: { id: 'test', name: 'Test', version: '1.0.0' },
    text,
    blocks: [
      {
        id: 'b1',
        type: 'paragraph',
        orderIndex: 0,
        text
      }
    ],
    metadata: {},
    warnings,
    quality: {
      fidelity: 'high',
      isLossy: false,
      isOcr: false
    }
  }
}

describe('ExtractionCompletenessEvaluator', () => {
  const evaluator = new ExtractionCompletenessEvaluator()

  it('evaluates completely extracted document as complete', () => {
    const text = 'Hello world, full extraction.'
    const doc = makeMockDoc(text)
    const inventory: SourceElementInventory = {
      format: 'txt',
      sourceElements: [
        {
          id: 'elem-1',
          type: 'paragraph',
          orderIndex: 0,
          disposition: 'fully_extracted',
          blockId: 'b1',
          isSearchable: true,
          characterCount: text.length
        }
      ],
      totalElements: 1,
      elementCountsByType: { paragraph: 1 },
      dispositionCounts: {
        fully_extracted: 1,
        text_preserved_unparsed: 0,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 0,
        failed: 0,
        unknown: 0
      },
      expectedSearchableCharacters: text.length
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.status).toBe('complete')
    expect(result.textualCoverage.coverageRatio).toBe(1.0)
    expect(result.textualCoverage.status).toBe('exact')
    expect(result.unsupportedElements).toHaveLength(0)
    expect(result.failedElements).toHaveLength(0)
    expect(result.referenceOnlyElements).toHaveLength(0)
  })

  it('evaluates document with unsupported or reference-only elements as partial', () => {
    const text = 'Some extracted text.'
    const doc = makeMockDoc(text)
    const inventory: SourceElementInventory = {
      format: 'docx',
      sourceElements: [
        {
          id: 'p1',
          type: 'paragraph',
          orderIndex: 0,
          disposition: 'fully_extracted',
          blockId: 'b1',
          isSearchable: true,
          characterCount: text.length
        },
        {
          id: 'img1',
          type: 'drawing',
          orderIndex: 1,
          disposition: 'reference_only',
          isSearchable: false
        },
        {
          id: 'vba1',
          type: 'unsupported_feature',
          orderIndex: 2,
          disposition: 'unsupported',
          isSearchable: false,
          warningCode: 'UNSUPPORTED_VBA'
        }
      ],
      totalElements: 3,
      elementCountsByType: { paragraph: 1, drawing: 1, unsupported_feature: 1 },
      dispositionCounts: {
        fully_extracted: 1,
        text_preserved_unparsed: 0,
        reference_only: 1,
        partially_extracted: 0,
        unsupported: 1,
        failed: 0,
        unknown: 0
      },
      expectedSearchableCharacters: text.length
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.status).toBe('partial')
    expect(result.unsupportedElements).toHaveLength(1)
    expect(result.referenceOnlyElements).toHaveLength(1)
    expect(result.failedElements).toHaveLength(0)
  })

  it('evaluates document with failed elements as failed', () => {
    const text = 'Corrupted input partial text.'
    const doc = makeMockDoc(text)
    const inventory: SourceElementInventory = {
      format: 'pdf',
      sourceElements: [
        {
          id: 'page-1',
          type: 'ocr_page',
          orderIndex: 0,
          disposition: 'failed',
          isSearchable: false,
          warningCode: 'OCR_ENGINE_CRASH'
        }
      ],
      totalElements: 1,
      elementCountsByType: { ocr_page: 1 },
      dispositionCounts: {
        fully_extracted: 0,
        text_preserved_unparsed: 0,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 0,
        failed: 1,
        unknown: 0
      }
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.status).toBe('failed')
    expect(result.failedElements).toHaveLength(1)
  })

  it('caps diagnostic arrays at 50 elements and adds diagnostic limit warning', () => {
    const text = 'Lots of unsupported items.'
    const doc = makeMockDoc(text)
    const sourceElements = Array.from({ length: 60 }, (_, i) => ({
      id: `unsup-${i}`,
      type: 'drawing',
      orderIndex: i,
      disposition: 'unsupported' as const,
      isSearchable: false
    }))

    const inventory: SourceElementInventory = {
      format: 'docx',
      sourceElements,
      totalElements: 60,
      elementCountsByType: { drawing: 60 },
      dispositionCounts: {
        fully_extracted: 0,
        text_preserved_unparsed: 0,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 60,
        failed: 0,
        unknown: 0
      }
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.status).toBe('partial')
    expect(result.unsupportedElements).toHaveLength(50) // Capped at 50
    expect(result.warnings.some((w) => w.includes('capped at 50'))).toBe(true)
  })

  it('never reports complete when text_preserved_unparsed > 0', () => {
    const text = '<div class="raw-html">Some HTML content</div>'
    const doc = makeMockDoc(text)
    const inventory: SourceElementInventory = {
      format: 'md',
      sourceElements: [
        {
          id: 'md-html-1',
          type: 'html_block',
          orderIndex: 0,
          disposition: 'text_preserved_unparsed',
          blockId: 'b1',
          isSearchable: true,
          characterCount: text.length
        }
      ],
      totalElements: 1,
      elementCountsByType: { html_block: 1 },
      dispositionCounts: {
        fully_extracted: 0,
        text_preserved_unparsed: 1,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 0,
        failed: 0,
        unknown: 0
      },
      expectedSearchableCharacters: text.length
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.structuralFidelity).toBe('partial')
    expect(result.status).toBe('partial')
    expect(result.status).not.toBe('complete')
  })

  it('never reports complete when character match is 95% (lenient ratio removed)', () => {
    const expectedText = 'a'.repeat(100)
    const extractedText = 'a'.repeat(95) // 95% ratio
    const doc = makeMockDoc(extractedText)
    const inventory: SourceElementInventory = {
      format: 'txt',
      sourceElements: [
        {
          id: 'txt-1',
          type: 'paragraph',
          orderIndex: 0,
          disposition: 'fully_extracted',
          blockId: 'b1',
          isSearchable: true,
          characterCount: expectedText.length
        }
      ],
      totalElements: 1,
      elementCountsByType: { paragraph: 1 },
      dispositionCounts: {
        fully_extracted: 1,
        text_preserved_unparsed: 0,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 0,
        failed: 0,
        unknown: 0
      },
      expectedSearchableCharacters: expectedText.length
    }

    const result = evaluator.evaluate(doc, inventory)
    expect(result.textualCoverage.coverageRatio).toBe(0.95)
    expect(result.textualCoverage.status).toBe('partial')
    expect(result.textualFidelity).toBe('partial')
    expect(result.status).toBe('partial')
    expect(result.status).not.toBe('complete')
  })

  describe('intentionally omitted source elements audit tests', () => {
    it('omitting one paragraph never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-para',
        format: 'docx',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'Paragraph 1.',
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Paragraph 1.'
          }
          // Paragraph 2 (b2) is omitted from document
        ],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'docx',
        sourceElements: [
          {
            id: 'p1',
            type: 'paragraph',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'b1',
            isSearchable: true,
            characterCount: 12
          },
          {
            id: 'p2',
            type: 'paragraph',
            orderIndex: 1,
            disposition: 'fully_extracted',
            blockId: 'b2', // omitted from doc.blocks
            isSearchable: true,
            characterCount: 12
          }
        ],
        totalElements: 2,
        elementCountsByType: { paragraph: 2 },
        dispositionCounts: {
          fully_extracted: 2,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 24
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.status).toBe('partial')
      expect(result.structuralFidelity).toBe('partial')
      expect(result.warnings.some((w) => w.includes('missing from extracted document'))).toBe(true)
    })

    it('omitting one spreadsheet cell / table row never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-cell',
        format: 'xlsx',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'Row 1',
        blocks: [
          {
            id: 'tbl-1',
            type: 'table',
            orderIndex: 0,
            text: 'Row 1',
            headers: [],
            rows: [['Row 1']],
            rowCount: 1,
            columnCount: 1
          }
        ],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'xlsx',
        sourceElements: [
          {
            id: 'cell-a1',
            type: 'cell',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'tbl-1',
            isSearchable: true,
            characterCount: 5
          },
          {
            id: 'cell-b1',
            type: 'cell',
            orderIndex: 1,
            disposition: 'partially_extracted',
            blockId: 'cell-missing-block',
            isSearchable: true,
            characterCount: 10
          }
        ],
        totalElements: 2,
        elementCountsByType: { cell: 2 },
        dispositionCounts: {
          fully_extracted: 1,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 1,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 15
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.status).toBe('partial')
    })

    it('omitting one spreadsheet formula never reports complete', () => {
      const doc = makeMockDoc('100') // cached value only, formula omitted
      const inventory: SourceElementInventory = {
        format: 'xlsx',
        sourceElements: [
          {
            id: 'formula-c1',
            type: 'formula_expression',
            orderIndex: 0,
            disposition: 'text_preserved_unparsed',
            blockId: 'b1',
            isSearchable: true,
            characterCount: 10
          }
        ],
        totalElements: 1,
        elementCountsByType: { formula_expression: 1 },
        dispositionCounts: {
          fully_extracted: 0,
          text_preserved_unparsed: 1,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 10
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.structuralFidelity).toBe('partial')
      expect(result.status).not.toBe('complete')
    })

    it('omitting one slide shape never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-shape',
        format: 'pptx',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'Title slide',
        blocks: [{ id: 'shape-title', type: 'paragraph', orderIndex: 0, text: 'Title slide' }],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'pptx',
        sourceElements: [
          {
            id: 'slide-1-shape-1',
            type: 'slide_shape',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'shape-title',
            isSearchable: true,
            characterCount: 11
          },
          {
            id: 'slide-1-shape-2',
            type: 'slide_shape',
            orderIndex: 1,
            disposition: 'fully_extracted',
            blockId: 'shape-body-missing', // missing!
            isSearchable: true,
            characterCount: 20
          }
        ],
        totalElements: 2,
        elementCountsByType: { slide_shape: 2 },
        dispositionCounts: {
          fully_extracted: 2,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 31
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.structuralFidelity).toBe('partial')
    })

    it('omitting one PDF page never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-page',
        format: 'pdf',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'Page 1 text',
        blocks: [
          {
            id: 'b-p1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Page 1 text',
            location: { pageNumber: 1 }
          }
        ],
        metadata: { pageCount: 2 },
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'pdf',
        sourceElements: [
          {
            id: 'pdf-page-1',
            type: 'digital_page',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'b-p1',
            isSearchable: true,
            characterCount: 11
          },
          {
            id: 'pdf-page-2',
            type: 'digital_page',
            orderIndex: 1,
            disposition: 'failed',
            isSearchable: false
          }
        ],
        totalElements: 2,
        elementCountsByType: { digital_page: 2 },
        dispositionCounts: {
          fully_extracted: 1,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 1,
          unknown: 0
        },
        expectedSearchableCharacters: 11
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.status).toBe('partial')
      expect(result.structuralFidelity).toBe('partial')
    })

    it('omitting one CSV field / record never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-csv',
        format: 'csv',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'name,age\nAlice,30',
        blocks: [{ id: 'csv-r1', type: 'paragraph', orderIndex: 0, text: 'name,age\nAlice,30' }],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'csv',
        sourceElements: [
          {
            id: 'csv-rec-1',
            type: 'logical_records',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'csv-r1',
            isSearchable: true,
            characterCount: 17
          },
          {
            id: 'csv-rec-2',
            type: 'logical_records',
            orderIndex: 1,
            disposition: 'fully_extracted',
            blockId: 'csv-missing-rec',
            isSearchable: true,
            characterCount: 15
          }
        ],
        totalElements: 2,
        elementCountsByType: { logical_records: 2 },
        dispositionCounts: {
          fully_extracted: 2,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 32
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.status).toBe('partial')
    })

    it('omitting one code block in markdown never reports complete', () => {
      const doc: UniversalDocument = {
        id: 'doc-omitted-code',
        format: 'md',
        extractedAt: Date.now(),
        extractor: { id: 'test', name: 'Test', version: '1.0.0' },
        text: 'Some prose paragraph.',
        blocks: [{ id: 'md-p1', type: 'paragraph', orderIndex: 0, text: 'Some prose paragraph.' }],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      }

      const inventory: SourceElementInventory = {
        format: 'md',
        sourceElements: [
          {
            id: 'md-p-1',
            type: 'paragraph',
            orderIndex: 0,
            disposition: 'fully_extracted',
            blockId: 'md-p1',
            isSearchable: true,
            characterCount: 21
          },
          {
            id: 'md-code-1',
            type: 'code_fence',
            orderIndex: 1,
            disposition: 'fully_extracted',
            blockId: 'md-code-missing',
            isSearchable: true,
            characterCount: 40
          }
        ],
        totalElements: 2,
        elementCountsByType: { paragraph: 1, code_fence: 1 },
        dispositionCounts: {
          fully_extracted: 2,
          text_preserved_unparsed: 0,
          reference_only: 0,
          partially_extracted: 0,
          unsupported: 0,
          failed: 0,
          unknown: 0
        },
        expectedSearchableCharacters: 61
      }

      const result = evaluator.evaluate(doc, inventory)
      expect(result.status).not.toBe('complete')
      expect(result.status).toBe('partial')
    })
  })
})
