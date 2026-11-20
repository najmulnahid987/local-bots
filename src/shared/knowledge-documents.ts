import { z } from 'zod'
import { knowledgeBaseIdSchema } from './knowledge-bases'

/**
 * Canonical indexing status for knowledge documents.
 */
export const KNOWLEDGE_DOCUMENT_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'needs_reindex'
] as const

export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number]

/**
 * Approved document format extensions.
 */
export const SUPPORTED_DOCUMENT_FORMATS = ['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx'] as const
export type SupportedDocumentFormat = (typeof SUPPORTED_DOCUMENT_FORMATS)[number]

/**
 * Public, renderer-safe Data Transfer Object representing a document in a Knowledge Base.
 * Excludes internal storage paths and database internals.
 */
export interface KnowledgeSourceDto {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly originalFileName: string
  readonly fileType: SupportedDocumentFormat
  readonly mimeType: string
  readonly fileSizeBytes: number
  readonly fileSize: number
  readonly status: KnowledgeDocumentStatus
  readonly indexingStatus: KnowledgeDocumentStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly indexedAt: number | null
  readonly chunkCount: number
  readonly errorMessage: string | null
}

/**
 * Caller input for selecting and importing a document into a Knowledge Base.
 */
export interface SelectAndImportDocumentRequest {
  readonly knowledgeBaseId: string
  readonly allowDuplicate?: boolean
}

/**
 * Caller input for listing documents in a Knowledge Base.
 */
export interface ListKnowledgeDocumentsRequest {
  readonly knowledgeBaseId: string
}

/**
 * Caller input for retrieving one document's metadata within its parent Knowledge Base.
 */
export interface GetKnowledgeDocumentRequest {
  readonly knowledgeBaseId: string
  readonly sourceId: string
}

/**
 * Result emitted when document import completes successfully.
 */
export interface DocumentImportSuccessResult {
  readonly status: 'completed'
  readonly duplicate: false
  readonly cancelled: false
  readonly source: KnowledgeSourceDto
  readonly totalChunks: number
  readonly totalTokens: number
}

/**
 * Result emitted when document import detects an intra-Knowledge Base duplicate.
 */
export interface DocumentImportDuplicateResult {
  readonly status: 'duplicate'
  readonly duplicate: true
  readonly cancelled: false
  readonly existingSource: {
    readonly id: string
    readonly originalFileName: string
    readonly fileSize: number
    readonly indexingStatus: string
    readonly createdAt: number
  }
}

/**
 * Result emitted when user cancels the native file selection dialog.
 */
export interface DocumentImportCancelledResult {
  readonly status: 'cancelled'
  readonly duplicate: false
  readonly cancelled: true
}

/**
 * Discriminated union of possible document import outcomes.
 */
export type DocumentImportResultDto =
  DocumentImportSuccessResult | DocumentImportDuplicateResult | DocumentImportCancelledResult

/**
 * Structured client-side bridge error thrown by window.api.knowledgeDocuments.
 */
export class KnowledgeDocumentBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'DOCUMENT_OPERATION_FAILED') {
    super(message)
    this.name = 'KnowledgeDocumentBridgeError'
    this.code = code
    Object.setPrototypeOf(this, KnowledgeDocumentBridgeError.prototype)
  }
}

/**
 * Preload interface exposed to the React Renderer at window.api.knowledgeDocuments.
 */
export interface KnowledgeDocumentApi {
  selectAndImport(request: SelectAndImportDocumentRequest): Promise<DocumentImportResultDto>
  list(
    knowledgeBaseIdOrRequest: string | ListKnowledgeDocumentsRequest
  ): Promise<readonly KnowledgeSourceDto[]>
  get(request: GetKnowledgeDocumentRequest): Promise<KnowledgeSourceDto | null>
  preview(request: GetDocumentPreviewRequest): Promise<DocumentPreviewDto | null>
  search(request: SearchKnowledgeDocumentsRequest): Promise<readonly DocumentSearchResultDto[]>
  reindex(request: ReindexDocumentRequest): Promise<ReindexDocumentResultDto>
  delete(request: DeleteDocumentRequest): Promise<DeleteDocumentResultDto>
  getDeletionPreview?(
    request: { id: string } | string
  ): Promise<import('./deletion').DeletionPreviewDto>
}

/**
 * Caller input for searching documents within a Knowledge Base using FTS5.
 */
export interface SearchKnowledgeDocumentsRequest {
  readonly knowledgeBaseId: string
  readonly query: string
  readonly limit?: number
}

/**
 * Public, renderer-safe Data Transfer Object representing a ranked search match chunk.
 * Excludes internal storage paths, raw database handles, and provider secrets.
 */
export interface DocumentSearchResultDto {
  readonly sourceId: string
  readonly knowledgeBaseId: string
  readonly filename: string
  readonly chunkId: string
  readonly chunkIndex: number
  readonly content: string
  readonly snippet: string
  readonly score: number
  readonly pageNumber: number | null
  readonly heading: string | null
  readonly headingLevel: number | null
  readonly headingPath: readonly string[] | null
  readonly lineRange: { readonly start: number; readonly end: number } | null
  readonly chunkerVersion: string | null
}

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 50
export const MAX_SEARCH_QUERY_LENGTH = 1000

// Zod schemas for input validation
export const sourceIdSchema = z
  .string()
  .uuid({ message: 'Invalid sourceId: must be a valid RFC 4122 UUIDv4.' })

export const selectAndImportDocumentRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    allowDuplicate: z.boolean().optional().default(false)
  })
  .strict()

export const listKnowledgeDocumentsRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema
  })
  .strict()

export const getKnowledgeDocumentRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    sourceId: sourceIdSchema
  })
  .strict()

export const searchKnowledgeDocumentsRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    query: z
      .string()
      .trim()
      .min(1, { message: 'Search query cannot be empty.' })
      .max(MAX_SEARCH_QUERY_LENGTH, {
        message: `Search query cannot exceed ${MAX_SEARCH_QUERY_LENGTH} characters.`
      }),
    limit: z
      .number()
      .int()
      .min(1, { message: 'Limit must be at least 1.' })
      .max(MAX_SEARCH_LIMIT, { message: `Limit cannot exceed ${MAX_SEARCH_LIMIT}.` })
      .optional()
      .default(DEFAULT_SEARCH_LIMIT)
  })
  .strict()

/**
 * Caller input for reindexing an existing document.
 */
export interface ReindexDocumentRequest {
  readonly knowledgeBaseId: string
  readonly sourceId: string
}

export const reindexDocumentRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    sourceId: sourceIdSchema
  })
  .strict()

/**
 * Result emitted when document reindexing completes successfully.
 */
export interface ReindexDocumentResultDto {
  readonly status: 'completed'
  readonly source: KnowledgeSourceDto
  readonly totalChunks: number
  readonly totalTokens: number
  readonly chunkerVersion: string
}

/**
 * Caller input for deleting an existing document.
 */
export interface DeleteDocumentRequest {
  readonly knowledgeBaseId: string
  readonly sourceId: string
}

export const deleteDocumentRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    sourceId: sourceIdSchema
  })
  .strict()

/**
 * Result emitted when document deletion completes.
 */
export interface DeleteDocumentResultDto {
  readonly success: boolean
  readonly sourceId: string
  readonly knowledgeBaseId: string
  readonly fileCleaned: boolean
  readonly cleanupPending: boolean
  readonly code?: string
  readonly error?: string
}

/**
 * Bounded document chunk preview item.
 */
export interface DocumentPreviewChunkDto {
  readonly chunkId: string
  readonly chunkIndex: number
  readonly content: string
  readonly tokenCount: number
  readonly pageNumber: number | null
  readonly heading: string | null
  readonly headingLevel: number | null
  readonly headingPath: readonly string[] | null
}

/**
 * Public, renderer-safe Data Transfer Object representing a bounded document preview.
 * Excludes internal storage paths, raw database handles, and provider secrets.
 */
export interface DocumentPreviewDto {
  readonly sourceId: string
  readonly knowledgeBaseId: string
  readonly originalFileName: string
  readonly fileType: SupportedDocumentFormat
  readonly fileSize: number
  readonly status: KnowledgeDocumentStatus
  readonly totalChunks: number
  readonly chunks: readonly DocumentPreviewChunkDto[]
}

/**
 * Caller input for retrieving a bounded preview of a document.
 */
export interface GetDocumentPreviewRequest {
  readonly knowledgeBaseId: string
  readonly sourceId: string
  readonly maxChunks?: number
}

export const getDocumentPreviewRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema,
    sourceId: sourceIdSchema,
    maxChunks: z.number().int().min(1).max(10).optional().default(3)
  })
  .strict()
