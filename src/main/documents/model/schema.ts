import { z } from 'zod'
import type {
  UniversalSourceLocation,
  UniversalListItem,
  UniversalTableCell,
  UniversalDocumentWarning,
  UniversalDocumentQuality,
  UniversalExtractorInfo,
  UniversalSourceInfo,
  UniversalDocument
} from './types'

// ============================================================================
// Source Location Schema
// ============================================================================

export const universalSourceLocationSchema: z.ZodType<UniversalSourceLocation> = z.object({
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  columnStart: z.number().int().min(1).optional(),
  columnEnd: z.number().int().min(1).optional(),
  pageNumber: z.number().int().min(1).optional(),
  paragraphIndex: z.number().int().min(0).optional(),
  headingContext: z.string().optional(),
  sheetName: z.string().optional(),
  sheetIndex: z.number().int().min(1).optional(),
  rowNumber: z.number().int().min(1).optional(),
  columnNumber: z.number().int().min(1).optional(),
  cellCoordinate: z.string().optional(),
  slideNumber: z.number().int().min(1).optional(),
  shapeIndex: z.number().int().min(0).optional(),
  slideTitle: z.string().optional()
})

// ============================================================================
// Block Component Schemas (Table Cell, List Item)
// ============================================================================

export const universalTableCellSchema: z.ZodType<UniversalTableCell> = z.object({
  value: z.string(),
  rawValue: z.unknown().optional(),
  cachedValue: z.unknown().optional(),
  formula: z.string().optional(),
  coordinate: z.string().optional(),
  rowIndex: z.number().int().min(0),
  columnIndex: z.number().int().min(0),
  rowSpan: z.number().int().min(1).optional(),
  colSpan: z.number().int().min(1).optional(),
  styleIndex: z.number().int().min(0).optional(),
  numberFormat: z.string().optional(),
  comment: z.string().optional(),
  hyperlink: z.string().optional(),
  isHeader: z.boolean().optional()
})

export const universalListItemSchema: z.ZodType<UniversalListItem> = z.object({
  text: z.string(),
  depth: z.number().int().min(0),
  orderIndex: z.number().int().min(0),
  itemNumber: z.number().int().min(1).optional(),
  checked: z.boolean().optional(),
  location: universalSourceLocationSchema.optional()
})

// ============================================================================
// Block Schemas (Discriminated by type)
// ============================================================================

const baseBlockProperties = {
  id: z.string().min(1),
  orderIndex: z.number().int().min(0),
  text: z.string(),
  location: universalSourceLocationSchema.optional(),
  parentBlockId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}

export const universalHeadingBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('heading'),
  level: z.number().int().min(1).max(6),
  headingPath: z.array(z.string())
})

export const universalParagraphBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('paragraph'),
  isQuote: z.boolean().optional()
})

export const universalListBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(universalListItemSchema)
})

export const universalTableBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('table'),
  tableId: z.string().optional(),
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  cells: z.array(z.array(universalTableCellSchema)).optional(),
  rowCount: z.number().int().min(0),
  columnCount: z.number().int().min(0),
  isSpreadsheet: z.boolean().optional(),
  sheetName: z.string().optional(),
  sheetIndex: z.number().int().min(1).optional()
})

export const universalCodeBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('code'),
  code: z.string(),
  language: z.string().optional()
})

export const universalPageBoundaryBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('page_boundary'),
  pageNumber: z.number().int().min(1),
  totalPages: z.number().int().min(1).optional(),
  label: z.string().optional()
})

export const universalSheetBoundaryBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('sheet_boundary'),
  sheetName: z.string().min(1),
  sheetIndex: z.number().int().min(1),
  totalSheets: z.number().int().min(1).optional()
})

export const universalSlideBoundaryBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('slide_boundary'),
  slideNumber: z.number().int().min(1),
  slideTitle: z.string().optional(),
  totalSlides: z.number().int().min(1).optional()
})

export const universalImageReferenceBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('image_reference'),
  elementType: z.enum(['image', 'chart', 'diagram', 'vector_graphic', 'smart_art', 'unknown']),
  referenceId: z.string().optional(),
  altText: z.string().optional(),
  caption: z.string().optional(),
  extractionStatus: z.enum(['skipped', 'partial', 'unsupported', 'failed']),
  warning: z.string().optional()
})

export const universalUnknownBlockSchema = z.object({
  ...baseBlockProperties,
  type: z.literal('unknown'),
  originalType: z.string().min(1),
  rawContent: z.unknown().optional(),
  warning: z.string().optional()
})

export const universalDocumentBlockSchema = z.discriminatedUnion('type', [
  universalHeadingBlockSchema,
  universalParagraphBlockSchema,
  universalListBlockSchema,
  universalTableBlockSchema,
  universalCodeBlockSchema,
  universalPageBoundaryBlockSchema,
  universalSheetBoundaryBlockSchema,
  universalSlideBoundaryBlockSchema,
  universalImageReferenceBlockSchema,
  universalUnknownBlockSchema
])

// ============================================================================
// Document Metadata & Quality Schemas
// ============================================================================

export const universalDocumentWarningSchema: z.ZodType<UniversalDocumentWarning> = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
})

export const universalDocumentQualitySchema: z.ZodType<UniversalDocumentQuality> = z.object({
  fidelity: z.enum(['high', 'medium', 'low']),
  isLossy: z.boolean(),
  isOcr: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  hasUnparsedElements: z.boolean().optional()
})

export const universalExtractorInfoSchema: z.ZodType<UniversalExtractorInfo> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1)
})

export const universalSourceInfoSchema: z.ZodType<UniversalSourceInfo> = z.object({
  fileSizeBytes: z.number().int().min(0).optional(),
  contentHash: z.string().optional(),
  mimeType: z.string().optional(),
  pageCount: z.number().int().min(0).optional(),
  sheetCount: z.number().int().min(0).optional(),
  slideCount: z.number().int().min(0).optional(),
  lineCount: z.number().int().min(0).optional(),
  characterCount: z.number().int().min(0).optional(),
  wordCount: z.number().int().min(0).optional()
})

// ============================================================================
// Document Schema
// ============================================================================

export const universalDocumentSchema: z.ZodType<UniversalDocument> = z.object({
  id: z.string().min(1),
  sourceId: z.string().optional(),
  knowledgeBaseId: z.string().optional(),
  format: z.string().min(1),
  originalFileName: z.string().optional(),
  mimeType: z.string().optional(),
  extractor: universalExtractorInfoSchema,
  extractedAt: z.number().int().min(0),
  text: z.string(),
  blocks: z.array(universalDocumentBlockSchema),
  metadata: z.record(z.string(), z.unknown()),
  warnings: z.array(universalDocumentWarningSchema),
  quality: universalDocumentQualitySchema,
  sourceInfo: universalSourceInfoSchema.optional()
})

// ============================================================================
// Serialization & Validation Utility Functions
// ============================================================================

/**
 * Asserts that an arbitrary JavaScript value or object structure is 100% JSON-safe.
 * Detects and rejects BigInt, Function, Symbol, and circular references with informative path errors.
 */
export function assertJsonSafe(value: unknown, rootPath = '$'): void {
  const activeStack = new WeakSet<object>()

  function walk(val: unknown, currentPath: string): void {
    if (val === null || val === undefined) {
      return
    }
    const valType = typeof val
    if (valType === 'bigint') {
      throw new Error(
        `JSON serialization safety violation at ${currentPath}: BigInt values are not JSON-serializable.`
      )
    }
    if (valType === 'function') {
      throw new Error(
        `JSON serialization safety violation at ${currentPath}: Function values cannot be serialized to JSON.`
      )
    }
    if (valType === 'symbol') {
      throw new Error(
        `JSON serialization safety violation at ${currentPath}: Symbol values cannot be serialized to JSON.`
      )
    }
    if (valType === 'object') {
      if (activeStack.has(val as object)) {
        throw new Error(
          `JSON serialization safety violation at ${currentPath}: Circular reference detected.`
        )
      }
      activeStack.add(val as object)

      try {
        if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            walk(val[i], `${currentPath}[${i}]`)
          }
        } else {
          for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
            walk(v, `${currentPath}.${key}`)
          }
        }
      } finally {
        activeStack.delete(val as object)
      }
    }
  }

  walk(value, rootPath)
}

/**
 * Deterministically serializes a UniversalDocument into a validated JSON string.
 */
export function serializeUniversalDocument(doc: UniversalDocument, space?: number): string {
  // Validate before serializing to guarantee schema compliance
  const validated = universalDocumentSchema.parse(doc)
  // Ensure strict JSON safety (rejects BigInt, functions, symbols, and circular structures)
  assertJsonSafe(validated)
  return JSON.stringify(validated, null, space)
}

/**
 * Deserializes and validates a JSON string into a UniversalDocument instance.
 * Throws a ZodError if the JSON content violates schema constraints.
 */
export function deserializeUniversalDocument(json: string): UniversalDocument {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new Error('Input to deserializeUniversalDocument must be a non-empty string.')
  }
  const raw = JSON.parse(json)
  return universalDocumentSchema.parse(raw)
}

export type UniversalDocumentValidationResult =
  { success: true; data: UniversalDocument } | { success: false; error: z.ZodError }

/**
 * Safely parses and validates a JSON string without throwing, returning a validation result.
 */
export function safeDeserializeUniversalDocument(json: string): UniversalDocumentValidationResult {
  try {
    const raw = JSON.parse(json)
    const result = universalDocumentSchema.safeParse(raw)
    if (result.success) {
      return { success: true, data: result.data }
    }
    return { success: false, error: result.error }
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`
        }
      ])
    }
  }
}

/**
 * Validates an in-memory document data structure against the UniversalDocument schema.
 */
export function validateUniversalDocument(data: unknown): UniversalDocument {
  return universalDocumentSchema.parse(data)
}

/**
 * Safely validates an in-memory document data structure without throwing.
 */
export function safeValidateUniversalDocument(data: unknown): UniversalDocumentValidationResult {
  const result = universalDocumentSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}
