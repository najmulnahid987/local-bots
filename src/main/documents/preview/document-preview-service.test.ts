import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentPreviewService } from './document-preview-service'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import type { DocumentValidationRepository } from '../../database/repositories/document-validation-repository'
import type { UniversalDocument } from '../model/types'
import type { DocumentPreservationReport } from '../validation/types'

describe('DocumentPreviewService', () => {
  const kb1 = 'a1b2c3d4-0000-4000-8000-000000000001'
  const kb2 = 'a1b2c3d4-0000-4000-8000-000000000002'
  const source1 = 's1b2c3d4-0000-4000-8000-000000000001'

  let mockSourceRepo: Partial<KnowledgeSourceRepository>
  let mockExtractedRepo: Partial<ExtractedDocumentRepository>
  let mockValidationRepo: Partial<DocumentValidationRepository>
  let previewService: DocumentPreviewService

  const sampleDoc: UniversalDocument = {
    id: 'doc-preview-1',
    format: 'docx',
    extractedAt: Date.now(),
    extractor: { id: 'test-docx', name: 'Test DOCX', version: '2.0.0' },
    text: 'Heading 1\n\nParagraph text.',
    blocks: [
      {
        id: 'blk-head',
        type: 'heading',
        level: 1,
        headingPath: ['Heading 1'],
        orderIndex: 0,
        text: 'Heading 1'
      },
      {
        id: 'blk-para',
        type: 'paragraph',
        orderIndex: 1,
        text: 'Paragraph text.'
      }
    ],
    metadata: {},
    warnings: [{ code: 'SKIPPED_IMAGE', message: 'Skipped 1 image.' }],
    quality: { fidelity: 'high', isLossy: false, isOcr: false }
  }

  const sampleReport: DocumentPreservationReport = {
    schemaVersion: '1.0.0',
    sourceId: source1,
    format: 'docx',
    timestamp: 1700000000000,
    status: 'partial',
    extractionStatus: 'partial',
    textualFidelity: 'complete',
    structuralFidelity: 'partial',
    chunkCoverageStatus: 'complete',
    extractionReport: {
      status: 'partial',
      textualFidelity: 'complete',
      structuralFidelity: 'partial',
      totalElements: 3,
      elementCountsByType: { heading: 1, paragraph: 1, drawing: 1 },
      dispositionCounts: {
        fully_extracted: 2,
        text_preserved_unparsed: 0,
        reference_only: 1,
        partially_extracted: 0,
        unsupported: 0,
        failed: 0,
        unknown: 0
      },
      textualCoverage: {
        expectedChars: 24,
        extractedChars: 24,
        coverageRatio: 1,
        status: 'exact'
      },
      unsupportedElements: [],
      failedElements: [],
      referenceOnlyElements: [],
      warnings: ['Skipped image'],
      measurementLimitations: []
    },
    chunkReport: {
      status: 'complete',
      totalBlocks: 2,
      coveredBlocks: 2,
      missingBlockIds: [],
      nonSearchableBlocks: [],
      primaryCharacterCoverage: {
        expectedChars: 24,
        coveredChars: 24,
        coverageRatio: 1,
        missingIntervals: []
      },
      repeatedOverlapTokens: 0,
      contextualTokens: 10,
      structuralDispositions: {},
      invalidSpanCount: 0,
      outOfBoundsSpanCount: 0,
      warnings: [],
      errors: []
    },
    warnings: ['Skipped image'],
    errors: [],
    measurementLimitations: [],
    versions: {
      extractorVersion: '2.0.0',
      chunkerVersion: '2.0.0',
      validatorVersion: '1.0.0'
    }
  }

  beforeEach(() => {
    mockSourceRepo = {
      getById: (id: string, kbId: string) => {
        if (id === source1 && kbId === kb1) {
          return {
            id: source1,
            knowledge_base_id: kb1,
            original_file_name: 'test.docx',
            file_name: 'test.docx',
            file_type: 'docx',
            file_size: 1024,
            indexing_status: 'completed',
            chunk_count: 1
          } as never
        }
        return null
      },
      getPreview: (id: string, kbId: string) => {
        if (id === source1 && kbId === kb1) {
          return {
            sourceId: source1,
            knowledgeBaseId: kb1,
            originalFileName: 'test.docx',
            fileType: 'docx',
            fileSize: 1024,
            status: 'completed',
            totalChunks: 1,
            chunks: [
              {
                chunkId: 'chk-1',
                chunkIndex: 0,
                content: 'Heading 1\n\nParagraph text.',
                tokenCount: 6,
                pageNumber: null,
                heading: 'Heading 1',
                headingLevel: 1,
                headingPath: ['Heading 1']
              }
            ]
          }
        }
        return null
      }
    }

    mockExtractedRepo = {
      get: (id: string, kbId: string) => {
        if (id === source1 && kbId === kb1) {
          return sampleDoc
        }
        return null
      }
    }

    mockValidationRepo = {
      getReport: (id: string, kbId: string) => {
        if (id === source1 && kbId === kb1) {
          return sampleReport
        }
        return null
      }
    }

    previewService = new DocumentPreviewService({
      sourceRepository: mockSourceRepo as KnowledgeSourceRepository,
      extractedDocumentRepository: mockExtractedRepo as ExtractedDocumentRepository,
      validationRepository: mockValidationRepo as DocumentValidationRepository
    })
  })

  it('builds full preview from canonical UniversalDocument in SQLite', async () => {
    const preview = await previewService.getPreview({
      knowledgeBaseId: kb1,
      sourceId: source1
    })

    expect(preview).not.toBeNull()
    expect(preview?.sourceId).toBe(source1)
    expect(preview?.originalFileName).toBe('test.docx')
    expect(preview?.totalBlocks).toBe(2)
    expect(preview?.blocks).toHaveLength(2)
    expect(preview?.blocks?.[0].type).toBe('heading')
    expect(preview?.blocks?.[0].level).toBe(1)
    expect(preview?.blocks?.[1].type).toBe('paragraph')
    expect(preview?.preservationReport?.status).toBe('partial')
    expect(preview?.preservationReport?.textualFidelity).toBe('complete')
    expect(preview?.preservationReport?.structuralFidelity).toBe('partial')
    expect(preview?.warnings).toHaveLength(1)
    // Preserves chunks for backward compatibility
    expect(preview?.chunks).toHaveLength(1)
  })

  it('strictly enforces Cross-KB isolation and returns null for other KBs', async () => {
    const crossPreview = await previewService.getPreview({
      knowledgeBaseId: kb2, // unauthorized KB
      sourceId: source1
    })
    expect(crossPreview).toBeNull()

    const crossReport = await previewService.getPreservationReport(kb2, source1)
    expect(crossReport).toBeNull()
  })

  it('supports bounded block pagination for large documents', async () => {
    const preview = await previewService.getPreview({
      knowledgeBaseId: kb1,
      sourceId: source1,
      offset: 1,
      limit: 1
    })

    expect(preview).not.toBeNull()
    expect(preview?.totalBlocks).toBe(2)
    expect(preview?.blocks).toHaveLength(1)
    expect(preview?.blocks?.[0].id).toBe('blk-para')
    expect(preview?.isBounded).toBe(true)
    expect(preview?.offset).toBe(1)
    expect(preview?.limit).toBe(1)
  })

  it('retrieves standalone preservation report with verified status', async () => {
    const report = await previewService.getPreservationReport(kb1, source1)
    expect(report).not.toBeNull()
    expect(report?.status).toBe('partial')
    expect(report?.coveredBlocks).toBe(2)
    expect(report?.totalBlocks).toBe(2)
  })
})
