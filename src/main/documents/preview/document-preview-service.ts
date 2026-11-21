import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import type { DocumentValidationRepository } from '../../database/repositories/document-validation-repository'
import type {
  DocumentPreviewDto,
  PreviewBlockDto,
  PreviewPreservationSummaryDto,
  GetDocumentPreviewRequest
} from '../../../shared/knowledge-documents'
import type { UniversalDocumentBlock } from '../model/types'
import type { DocumentPreservationReport } from '../validation/types'

export interface DocumentPreviewServiceOptions {
  readonly sourceRepository: KnowledgeSourceRepository
  readonly extractedDocumentRepository: ExtractedDocumentRepository
  readonly validationRepository?: DocumentValidationRepository
}

/**
 * Service that builds full, format-aware document previews from the canonical
 * UniversalDocument stored in SQLite, and provides associated preservation reports.
 *
 * Invariants:
 * 1. The canonical UniversalDocument is the authoritative source of truth for full preview rendering.
 * 2. Cross-KB data access is strictly forbidden; ownership is enforced via KnowledgeSourceRepository.
 * 3. Never returns unverified, executable, or unsafe script/macro/HTML code.
 * 4. Supports bounded block pagination for large documents.
 */
export class DocumentPreviewService {
  private readonly sourceRepository: KnowledgeSourceRepository
  private readonly extractedDocumentRepository: ExtractedDocumentRepository
  private readonly validationRepository?: DocumentValidationRepository

  constructor(options: DocumentPreviewServiceOptions) {
    this.sourceRepository = options.sourceRepository
    this.extractedDocumentRepository = options.extractedDocumentRepository
    this.validationRepository = options.validationRepository
  }

  /**
   * Retrieves a preview representation of a document, including structured blocks and preservation status.
   */
  public async getPreview(request: GetDocumentPreviewRequest): Promise<DocumentPreviewDto | null> {
    const { knowledgeBaseId, sourceId, offset = 0, limit = 200, maxChunks = 10 } = request

    // 1. Authoritative ownership check
    const source = this.sourceRepository.getById(sourceId, knowledgeBaseId)
    if (!source) {
      return null
    }

    // 2. Load chunk preview for backward compatibility and citation highlighting
    const basePreview = this.sourceRepository.getPreview(sourceId, knowledgeBaseId, maxChunks)

    // 3. Load canonical UniversalDocument from SQLite
    const storedDoc = this.extractedDocumentRepository.get(sourceId, knowledgeBaseId)
    const blocks: PreviewBlockDto[] = []
    let totalBlocks = 0
    let warnings: Array<{ code: string; message: string }> = []

    if (storedDoc) {
      totalBlocks = storedDoc.blocks.length
      const sliceEnd = Math.min(offset + limit, totalBlocks)
      const boundedSlice = storedDoc.blocks.slice(offset, sliceEnd)

      for (const block of boundedSlice) {
        blocks.push(this.toPreviewBlockDto(block))
      }
      warnings = [...storedDoc.warnings]
    }

    // 4. Load DocumentPreservationReport if available
    let preservationReportDto: PreviewPreservationSummaryDto | null = null
    if (this.validationRepository) {
      const rawReport = this.validationRepository.getReport(sourceId, knowledgeBaseId)
      if (rawReport) {
        preservationReportDto = this.toPreviewReportDto(rawReport)
      }
    }

    return {
      sourceId,
      knowledgeBaseId,
      originalFileName: source.original_file_name,
      fileType: source.file_type as DocumentPreviewDto['fileType'],
      fileSize: source.file_size,
      status: source.indexing_status as DocumentPreviewDto['status'],
      totalChunks: basePreview?.totalChunks ?? 0,
      chunks: basePreview?.chunks ?? [],
      totalBlocks,
      blocks,
      preservationReport: preservationReportDto,
      warnings,
      isBounded: totalBlocks > blocks.length,
      offset,
      limit
    }
  }

  /**
   * Retrieves the raw preservation report for a document, enforcing KB ownership.
   */
  public async getPreservationReport(
    knowledgeBaseId: string,
    sourceId: string
  ): Promise<PreviewPreservationSummaryDto | null> {
    const source = this.sourceRepository.getById(sourceId, knowledgeBaseId)
    if (!source || !this.validationRepository) {
      return null
    }

    const rawReport = this.validationRepository.getReport(sourceId, knowledgeBaseId)
    if (!rawReport) {
      return null
    }

    return this.toPreviewReportDto(rawReport)
  }

  private toPreviewBlockDto(block: UniversalDocumentBlock): PreviewBlockDto {
    const dto: PreviewBlockDto = {
      id: block.id,
      type: block.type,
      orderIndex: block.orderIndex,
      text: block.text,
      location: block.location,
      metadata: block.metadata
    }

    if (block.type === 'heading') {
      return { ...dto, level: block.level }
    }
    if (block.type === 'code') {
      return { ...dto, language: block.language }
    }
    if (block.type === 'table') {
      return { ...dto, headers: block.headers, rows: block.rows }
    }
    if (block.type === 'sheet_boundary') {
      return { ...dto, sheetName: block.sheetName, sheetIndex: block.sheetIndex }
    }
    if (block.type === 'slide_boundary') {
      return { ...dto, slideNumber: block.slideNumber, slideTitle: block.slideTitle }
    }

    return dto
  }

  private toPreviewReportDto(report: DocumentPreservationReport): PreviewPreservationSummaryDto {
    return {
      status: report.status,
      extractionStatus: report.extractionStatus,
      textualFidelity: report.textualFidelity ?? report.extractionReport.textualFidelity,
      structuralFidelity: report.structuralFidelity ?? report.extractionReport.structuralFidelity,
      chunkCoverageStatus: report.chunkCoverageStatus,
      totalElements: report.extractionReport.totalElements,
      elementCountsByType: report.extractionReport.elementCountsByType,
      dispositionCounts: report.extractionReport.dispositionCounts,
      coveredBlocks: report.chunkReport.coveredBlocks,
      totalBlocks: report.chunkReport.totalBlocks,
      coverageRatio: report.chunkReport.primaryCharacterCoverage.coverageRatio,
      warnings: report.warnings,
      errors: report.errors,
      measurementLimitations: report.measurementLimitations,
      versions: report.versions,
      timestamp: report.timestamp
    }
  }
}
