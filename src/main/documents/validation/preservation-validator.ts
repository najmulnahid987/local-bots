import type { UniversalDocument } from '../model/types'
import type { ChunkingResult } from '../chunking/types'
import {
  type DocumentPreservationReport,
  type SourceElementInventory,
  type ValidationStatus,
  documentPreservationReportSchema
} from './types'
import {
  SourceElementInventoryGenerator,
  defaultSourceElementInventoryGenerator
} from './source-element-inventory'
import {
  ExtractionCompletenessEvaluator,
  defaultExtractionCompletenessEvaluator
} from './extraction-completeness-evaluator'
import { ChunkCoverageEvaluator, defaultChunkCoverageEvaluator } from './chunk-coverage-evaluator'

export interface PreservationValidatorOptions {
  readonly inventoryGenerator?: SourceElementInventoryGenerator
  readonly completenessEvaluator?: ExtractionCompletenessEvaluator
  readonly coverageEvaluator?: ChunkCoverageEvaluator
}

export interface ValidateDocumentOptions {
  readonly sourceId: string
  readonly format: string
  readonly rawBytes: Uint8Array | Buffer
  readonly universalDocument: UniversalDocument
  readonly chunkingResult: ChunkingResult
  readonly inventory?: SourceElementInventory
  readonly timestamp?: number
}

/**
 * Orchestrating service that evaluates both extraction completeness and chunk coverage
 * to produce a unified, tamper-evident DocumentPreservationReport.
 *
 * Invariants:
 * 1. Extraction completeness and chunk coverage remain strictly independent reports.
 * 2. Never claims complete preservation if any extractable element or chunk interval was lost.
 * 3. Bounded diagnostic output to prevent memory and payload explosion.
 */
export class PreservationValidator {
  private readonly inventoryGenerator: SourceElementInventoryGenerator
  private readonly completenessEvaluator: ExtractionCompletenessEvaluator
  private readonly coverageEvaluator: ChunkCoverageEvaluator

  constructor(options?: PreservationValidatorOptions) {
    this.inventoryGenerator = options?.inventoryGenerator ?? defaultSourceElementInventoryGenerator
    this.completenessEvaluator =
      options?.completenessEvaluator ?? defaultExtractionCompletenessEvaluator
    this.coverageEvaluator = options?.coverageEvaluator ?? defaultChunkCoverageEvaluator
  }

  /**
   * Performs runtime validation and generates a DocumentPreservationReport.
   */
  public validate(options: ValidateDocumentOptions): DocumentPreservationReport {
    const { sourceId, format, rawBytes, universalDocument, chunkingResult, timestamp } = options

    // 1. Generate or use provided source element inventory
    const inventory =
      options.inventory ??
      this.inventoryGenerator.generateInventory(format, rawBytes, universalDocument)

    // 2. Evaluate extraction completeness (Original File -> UniversalDocument)
    const extractionReport = this.completenessEvaluator.evaluate(universalDocument, inventory)

    // 3. Evaluate chunk coverage (UniversalDocument -> Chunks)
    const chunkReport = this.coverageEvaluator.evaluate(universalDocument, chunkingResult)

    // 4. Derive overall status
    let overallStatus: ValidationStatus
    if (extractionReport.status === 'failed' || chunkReport.status === 'failed') {
      overallStatus = 'failed'
    } else if (extractionReport.status === 'partial' || chunkReport.status === 'partial') {
      overallStatus = 'partial'
    } else if (extractionReport.status === 'complete' && chunkReport.status === 'complete') {
      overallStatus = 'complete'
    } else {
      overallStatus = 'unknown'
    }

    // 5. Aggregate warnings and errors
    const allWarnings = Array.from(new Set([...extractionReport.warnings, ...chunkReport.warnings]))
    const allErrors = Array.from(new Set([...chunkReport.errors]))
    const allLimitations = Array.from(
      new Set([
        ...(inventory.measurementLimitations ?? []),
        ...extractionReport.measurementLimitations
      ])
    )

    const report: DocumentPreservationReport = {
      schemaVersion: '1.0.0',
      sourceId,
      format: format.toLowerCase().trim(),
      timestamp: timestamp ?? Date.now(),
      status: overallStatus,
      extractionStatus: extractionReport.status,
      textualFidelity: extractionReport.textualFidelity,
      structuralFidelity: extractionReport.structuralFidelity,
      chunkCoverageStatus: chunkReport.status,
      extractionReport,
      chunkReport,
      warnings: allWarnings,
      errors: allErrors,
      measurementLimitations: allLimitations,
      versions: {
        extractorVersion: universalDocument.extractor?.version,
        chunkerVersion: chunkingResult.chunkerVersion,
        validatorVersion: '1.0.0'
      }
    }

    // Defensive runtime validation of report structure
    documentPreservationReportSchema.parse(report)

    return report
  }
}

export const defaultPreservationValidator = new PreservationValidator()
