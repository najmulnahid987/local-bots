import { z } from 'zod'
import type { UniversalSourceLocation } from '../model/types'
import type { NonSearchableBlockDisposition } from '../chunking/types'

/**
 * Extraction dispositions indicating the degree of preservation for a source element.
 *
 * Invariants:
 * - 'fully_extracted': The element was parsed and its text/structure preserved in the UniversalDocument.
 * - 'text_preserved_unparsed': The element's textual content was preserved, but its complex structure was simplified.
 * - 'reference_only': A reference or metadata was kept (e.g., image or chart metadata), but internal content was not extracted into text.
 * - 'partially_extracted': Some sub-elements were extracted while others were omitted.
 * - 'unsupported': The construct is explicitly unsupported (e.g., VBA macros, 3D models).
 * - 'failed': Extraction was attempted on the element but failed.
 * - 'unknown': Completeness could not be reliably determined.
 */
export const EXTRACTION_DISPOSITIONS = [
  'fully_extracted',
  'text_preserved_unparsed',
  'reference_only',
  'partially_extracted',
  'unsupported',
  'failed',
  'unknown'
] as const

export type ExtractionDisposition = (typeof EXTRACTION_DISPOSITIONS)[number]

/**
 * Validation statuses for extraction completeness and chunk coverage.
 */
export const VALIDATION_STATUSES = ['complete', 'partial', 'unknown', 'failed'] as const
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

/**
 * A typed record representing a discrete source element discovered in the original file.
 */
export interface SourceElementRecord {
  readonly id: string
  readonly type: string
  readonly location?: UniversalSourceLocation
  readonly orderIndex: number
  readonly disposition: ExtractionDisposition
  readonly blockId?: string
  readonly isSearchable: boolean
  readonly warningCode?: string
  readonly characterCount?: number
  readonly details?: Readonly<Record<string, unknown>>
}

/**
 * Complete inventory of source elements discovered in an uploaded document.
 */
export interface SourceElementInventory {
  readonly format: string
  readonly sourceElements: readonly SourceElementRecord[]
  readonly totalElements: number
  readonly elementCountsByType: Readonly<Record<string, number>>
  readonly dispositionCounts: Readonly<Record<ExtractionDisposition, number>>
  readonly expectedSearchableCharacters?: number
  readonly expectedNormalizedText?: string
  readonly measurementLimitations?: readonly string[]
}

/**
 * Result of evaluating extraction completeness (Original File -> UniversalDocument).
 */
export interface ExtractionCompletenessResult {
  readonly status: ValidationStatus
  readonly textualFidelity: ValidationStatus
  readonly structuralFidelity: ValidationStatus
  readonly totalElements: number
  readonly elementCountsByType: Readonly<Record<string, number>>
  readonly dispositionCounts: Readonly<Record<ExtractionDisposition, number>>
  readonly textualCoverage: {
    readonly expectedChars: number
    readonly extractedChars: number
    readonly coverageRatio: number
    readonly status: 'exact' | 'normalized_match' | 'partial' | 'unknown'
  }
  readonly unsupportedElements: readonly SourceElementRecord[]
  readonly failedElements: readonly SourceElementRecord[]
  readonly referenceOnlyElements: readonly SourceElementRecord[]
  readonly warnings: readonly string[]
  readonly measurementLimitations: readonly string[]
}

/**
 * Details of an unchunked or missing character interval in a source block.
 */
export interface MissingChunkInterval {
  readonly blockId: string
  readonly startOffset: number
  readonly endOffset: number
  readonly length: number
}

/**
 * Result of evaluating chunk coverage (UniversalDocument -> Chunks).
 */
export interface ChunkCoverageResult {
  readonly status: ValidationStatus
  readonly totalBlocks: number
  readonly coveredBlocks: number
  readonly missingBlockIds: readonly string[]
  readonly nonSearchableBlocks: readonly NonSearchableBlockDisposition[]
  readonly primaryCharacterCoverage: {
    readonly expectedChars: number
    readonly coveredChars: number
    readonly coverageRatio: number
    readonly missingIntervals: readonly MissingChunkInterval[]
  }
  readonly repeatedOverlapTokens: number
  readonly contextualTokens: number
  readonly structuralDispositions: Readonly<Record<string, number>>
  readonly invalidSpanCount: number
  readonly outOfBoundsSpanCount: number
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
}

/**
 * Comprehensive per-document preservation report persisted in SQLite.
 */
export interface DocumentPreservationReport {
  readonly schemaVersion: '1.0.0'
  readonly sourceId: string
  readonly format: string
  readonly timestamp: number
  readonly status: ValidationStatus
  readonly extractionStatus: ValidationStatus
  readonly textualFidelity?: ValidationStatus
  readonly structuralFidelity?: ValidationStatus
  readonly chunkCoverageStatus: ValidationStatus
  readonly extractionReport: ExtractionCompletenessResult
  readonly chunkReport: ChunkCoverageResult
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly measurementLimitations: readonly string[]
  readonly versions: {
    readonly extractorVersion?: string
    readonly chunkerVersion: string
    readonly validatorVersion: string
  }
}

// ============================================================================
// ZOD SCHEMAS FOR RUNTIME VALIDATION
// ============================================================================

export const sourceElementRecordSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  location: z
    .object({
      lineStart: z.number().int().positive().optional(),
      lineEnd: z.number().int().positive().optional(),
      columnStart: z.number().int().positive().optional(),
      columnEnd: z.number().int().positive().optional(),
      pageNumber: z.number().int().positive().optional(),
      paragraphIndex: z.number().int().nonnegative().optional(),
      headingContext: z.string().optional(),
      sheetName: z.string().optional(),
      sheetIndex: z.number().int().nonnegative().optional(),
      rowNumber: z.number().int().nonnegative().optional(),
      columnNumber: z.number().int().nonnegative().optional(),
      cellCoordinate: z.string().optional(),
      slideNumber: z.number().int().positive().optional(),
      shapeIndex: z.number().int().nonnegative().optional(),
      slideTitle: z.string().optional()
    })
    .optional(),
  orderIndex: z.number().int().nonnegative(),
  disposition: z.enum(EXTRACTION_DISPOSITIONS),
  blockId: z.string().min(1).optional(),
  isSearchable: z.boolean(),
  warningCode: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional()
})

export const extractionCompletenessResultSchema = z.object({
  status: z.enum(VALIDATION_STATUSES),
  textualFidelity: z.enum(VALIDATION_STATUSES).default('unknown'),
  structuralFidelity: z.enum(VALIDATION_STATUSES).default('unknown'),
  totalElements: z.number().int().nonnegative(),
  elementCountsByType: z.record(z.string(), z.number().int().nonnegative()),
  dispositionCounts: z.record(z.string(), z.number().int().nonnegative()),
  textualCoverage: z.object({
    expectedChars: z.number().int().nonnegative(),
    extractedChars: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    status: z.enum(['exact', 'normalized_match', 'partial', 'unknown'])
  }),
  unsupportedElements: z.array(sourceElementRecordSchema),
  failedElements: z.array(sourceElementRecordSchema),
  referenceOnlyElements: z.array(sourceElementRecordSchema),
  warnings: z.array(z.string()),
  measurementLimitations: z.array(z.string())
})

export const missingChunkIntervalSchema = z.object({
  blockId: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative()
})

export const chunkCoverageResultSchema = z.object({
  status: z.enum(VALIDATION_STATUSES),
  totalBlocks: z.number().int().nonnegative(),
  coveredBlocks: z.number().int().nonnegative(),
  missingBlockIds: z.array(z.string()),
  nonSearchableBlocks: z.array(
    z.object({
      blockId: z.string().min(1),
      blockType: z.string(),
      reason: z.string(),
      orderIndex: z.number().int().nonnegative(),
      location: z.record(z.string(), z.unknown()).optional()
    })
  ),
  primaryCharacterCoverage: z.object({
    expectedChars: z.number().int().nonnegative(),
    coveredChars: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    missingIntervals: z.array(missingChunkIntervalSchema)
  }),
  repeatedOverlapTokens: z.number().int().nonnegative(),
  contextualTokens: z.number().int().nonnegative(),
  structuralDispositions: z.record(z.string(), z.number().int().nonnegative()),
  invalidSpanCount: z.number().int().nonnegative(),
  outOfBoundsSpanCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  errors: z.array(z.string())
})

export const documentPreservationReportSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  sourceId: z.string().min(1),
  format: z.string().min(1),
  timestamp: z.number().int().positive(),
  status: z.enum(VALIDATION_STATUSES),
  extractionStatus: z.enum(VALIDATION_STATUSES),
  textualFidelity: z.enum(VALIDATION_STATUSES).optional(),
  structuralFidelity: z.enum(VALIDATION_STATUSES).optional(),
  chunkCoverageStatus: z.enum(VALIDATION_STATUSES),
  extractionReport: extractionCompletenessResultSchema,
  chunkReport: chunkCoverageResultSchema,
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  measurementLimitations: z.array(z.string()),
  versions: z.object({
    extractorVersion: z.string().optional(),
    chunkerVersion: z.string().min(1),
    validatorVersion: z.string().min(1)
  })
})
