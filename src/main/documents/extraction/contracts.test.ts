import { describe, it, expect } from 'vitest'
import {
  extractionResultToExtractedDocument,
  extractedDocumentToExtractionResult,
  type DocumentExtractionResult,
  type ExtractedDocumentBlock,
  type ExtractorMetadata
} from './types'
import { DocumentErrors } from '../document-errors'
import type { ExtractedDocument } from '../extractors/types'

describe('Extraction Contracts (Phase 10 Step 10.4)', () => {
  const dummyExtractor: ExtractorMetadata = {
    id: 'test-extractor',
    name: 'Test Extractor',
    version: '1.0.0',
    supportedFormats: ['txt', 'md']
  }

  // 1. Valid request and result conversion
  it('1. correctly converts DocumentExtractionResult to legacy ExtractedDocument with sections', () => {
    const blocks: ExtractedDocumentBlock[] = [
      {
        type: 'heading',
        text: 'System Overview',
        heading: { level: 1, headingPath: ['System Overview'] },
        lineStart: 1,
        lineEnd: 1
      },
      {
        type: 'paragraph',
        text: 'This is the main system architecture paragraph.',
        lineStart: 2,
        lineEnd: 2
      },
      {
        type: 'heading',
        text: 'Database Engine',
        heading: { level: 2, headingPath: ['System Overview', 'Database Engine'] },
        lineStart: 4,
        lineEnd: 4
      },
      {
        type: 'paragraph',
        text: 'We use SQLite in WAL mode.',
        lineStart: 5,
        lineEnd: 5
      }
    ]

    const result: DocumentExtractionResult = {
      format: 'md',
      text: '# System Overview\nThis is the main system architecture paragraph.\n\n## Database Engine\nWe use SQLite in WAL mode.',
      blocks,
      metadata: { author: 'Engineering Team', wordCount: 15 },
      warnings: [],
      quality: {
        fidelity: 'high',
        isLossy: false,
        isOcr: false
      },
      extractor: dummyExtractor
    }

    const legacyDoc = extractionResultToExtractedDocument(result)

    expect(legacyDoc.format).toBe('md')
    expect(legacyDoc.text).toBe(result.text)
    expect(legacyDoc.sections).toHaveLength(2)

    expect(legacyDoc.sections[0].heading).toBe('System Overview')
    expect(legacyDoc.sections[0].headingLevel).toBe(1)
    expect(legacyDoc.sections[0].headingPath).toEqual(['System Overview'])
    expect(legacyDoc.sections[0].text).toBe('This is the main system architecture paragraph.')

    expect(legacyDoc.sections[1].heading).toBe('Database Engine')
    expect(legacyDoc.sections[1].headingLevel).toBe(2)
    expect(legacyDoc.sections[1].headingPath).toEqual(['System Overview', 'Database Engine'])
    expect(legacyDoc.sections[1].text).toBe('We use SQLite in WAL mode.')

    expect(legacyDoc.metadata?.author).toBe('Engineering Team')
    expect(legacyDoc.metadata?.extractorId).toBe('test-extractor')
  })

  // 2. Conversion from legacy ExtractedDocument to DocumentExtractionResult
  it('2. converts legacy ExtractedDocument to modern DocumentExtractionResult preserving blocks', () => {
    const legacyDoc: ExtractedDocument = {
      format: 'txt',
      text: 'First line of plain text.\nSecond line of plain text.',
      sections: [
        {
          text: 'First line of plain text.\nSecond line of plain text.',
          lineStart: 1,
          lineEnd: 2
        }
      ],
      metadata: { byteLength: 52 }
    }

    const result = extractedDocumentToExtractionResult(legacyDoc, dummyExtractor)

    expect(result.format).toBe('txt')
    expect(result.text).toBe(legacyDoc.text)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('paragraph')
    expect(result.blocks[0].text).toBe(legacyDoc.text)
    expect(result.quality.fidelity).toBe('high')
    expect(result.extractor.id).toBe('test-extractor')
  })

  // 3. Missing optional metadata remains explicitly unavailable
  it('3. leaves optional metadata (pages, sheets, lines) as undefined rather than inventing false values', () => {
    const block: ExtractedDocumentBlock = {
      type: 'paragraph',
      text: 'Simple text block with no page provenance.'
    }

    expect(block.pageNumber).toBeUndefined()
    expect(block.lineStart).toBeUndefined()
    expect(block.lineEnd).toBeUndefined()
    expect(block.heading).toBeUndefined()
    expect(block.sheet).toBeUndefined()
    expect(block.slide).toBeUndefined()
  })

  // 4. Structured warning behavior
  it('4. preserves structured warnings in DocumentExtractionResult and legacy conversion', () => {
    const result: DocumentExtractionResult = {
      format: 'pdf',
      text: 'Partial text extracted.',
      blocks: [{ type: 'paragraph', text: 'Partial text extracted.', pageNumber: 1 }],
      metadata: {},
      warnings: [
        {
          code: 'UNSUPPORTED_VECTOR_GRAPHIC',
          message: 'Page 1 contains embedded vector graphics which were omitted.',
          details: { page: 1, elementCount: 4 }
        }
      ],
      quality: {
        fidelity: 'medium',
        isLossy: true,
        isOcr: false
      },
      extractor: dummyExtractor
    }

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].code).toBe('UNSUPPORTED_VECTOR_GRAPHIC')

    const legacyDoc = extractionResultToExtractedDocument(result)
    // Warnings are retained in metadata
    const legacyWarnings = legacyDoc.metadata?.warnings as typeof result.warnings
    expect(legacyWarnings).toHaveLength(1)
    expect(legacyWarnings[0].code).toBe('UNSUPPORTED_VECTOR_GRAPHIC')
  })

  // 5. Typed extraction failures
  it('5. provides strongly typed error codes for infrastructure failures', () => {
    const timeoutErr = DocumentErrors.extractionTimeout(30000)
    expect(timeoutErr.code).toBe('EXTRACTION_TIMEOUT')
    expect(timeoutErr.message).toContain('30000ms')

    const cancelledErr = DocumentErrors.extractionCancelled()
    expect(cancelledErr.code).toBe('EXTRACTION_CANCELLED')

    const outputLimitErr = DocumentErrors.extractionOutputLimitExceeded(1000, 2000)
    expect(outputLimitErr.code).toBe('EXTRACTION_OUTPUT_LIMIT_EXCEEDED')
    expect(outputLimitErr.message).toContain('1000 bytes')

    const conflictErr = DocumentErrors.extractionRegistryConflict('Conflicting parser')
    expect(conflictErr.code).toBe('EXTRACTION_REGISTRY_CONFLICT')

    const malformedOutputErr = DocumentErrors.extractionMalformedOutput('Missing text')
    expect(malformedOutputErr.code).toBe('EXTRACTION_MALFORMED_OUTPUT')
  })
})
