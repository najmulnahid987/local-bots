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
export const SUPPORTED_DOCUMENT_FORMATS = ['txt', 'md', 'pdf'] as const
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
}

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
