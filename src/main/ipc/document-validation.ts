import { z } from 'zod'
import {
  type KnowledgeSourceDto,
  selectAndImportDocumentRequestSchema,
  listKnowledgeDocumentsRequestSchema,
  getKnowledgeDocumentRequestSchema,
  getDocumentPreviewRequestSchema,
  searchKnowledgeDocumentsRequestSchema,
  reindexDocumentRequestSchema,
  deleteDocumentRequestSchema,
  getPreservationReportRequestSchema
} from '../../shared/knowledge-documents'
import type { KnowledgeSourceWithChunkCount } from '../database/repositories/types'

/**
 * Strips raw filesystem paths, quarantine patterns, or internal storage references from error strings.
 */
export function sanitizeDocumentErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'An error occurred during the document operation.'
  }

  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
    .replace(/\.quarantine_[a-zA-Z0-9_-]+/g, '[REDACTED_QUARANTINE]')
}

export const documentSelectAndImportIpcSchema = selectAndImportDocumentRequestSchema

export const documentListIpcSchema = listKnowledgeDocumentsRequestSchema

export const documentGetIpcSchema = getKnowledgeDocumentRequestSchema

export const documentPreviewIpcSchema = getDocumentPreviewRequestSchema

export const documentPreservationReportIpcSchema = getPreservationReportRequestSchema

export const documentSearchIpcSchema = searchKnowledgeDocumentsRequestSchema

export const documentReindexIpcSchema = reindexDocumentRequestSchema

export const documentDeleteIpcSchema = deleteDocumentRequestSchema

/**
 * Validates a raw IPC payload using a strict Zod schema.
 * Throws a sanitized Error with a code of 'VALIDATION_ERROR' on failure.
 */
export function validateDocumentIpcPayload<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    const sanitized = sanitizeDocumentErrorMessage(errorDetails)
    const err = new Error(`Invalid document IPC payload: ${sanitized}`)
    ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
    throw err
  }
  return result.data
}

/**
 * Maps a database KnowledgeSourceWithChunkCount entity into a safe UI-facing KnowledgeSourceDto.
 * Excludes internal storage paths and database internals.
 */
export function toKnowledgeSourceDto(row: KnowledgeSourceWithChunkCount): KnowledgeSourceDto {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    originalFileName: row.original_file_name,
    fileType: row.file_type,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size,
    fileSize: row.file_size,
    status: row.indexing_status,
    indexingStatus: row.indexing_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
    chunkCount: row.chunk_count,
    errorMessage: row.error_message ? sanitizeDocumentErrorMessage(row.error_message) : null
  }
}
