import fs from 'node:fs'
import path from 'node:path'
import crypto, { randomUUID } from 'node:crypto'
import {
  type ReindexDocumentRequest,
  type ReindexDocumentResultDto,
  type DeleteDocumentRequest,
  type DeleteDocumentResultDto,
  reindexDocumentRequestSchema,
  deleteDocumentRequestSchema
} from '../../../shared/knowledge-documents'
import type { CreateKnowledgeChunkInput } from '../../database/repositories/types'
import { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import { DocumentStorageManager } from '../document-storage-manager'
import { DocumentErrors } from '../document-errors'
import { type DocumentSettingsProvider, StaticDocumentSettingsProvider } from '../document-settings'
import { ExtractorRegistry, defaultExtractorRegistry } from '../extractors/registry'
import type { ExtractedDocument } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import { SemanticChunker } from '../chunking/semantic-chunker'
import { toKnowledgeSourceDto, sanitizeDocumentErrorMessage } from '../../ipc/document-validation'
import type { DocumentLifecycleServiceOptions } from './types'

/**
 * Service orchestrating document reindexing and deletion lifecycle workflows.
 *
 * Guarantees:
 * 1. Reindex: Atomically replaces existing chunks and FTS5 entries in a single SQLite transaction.
 * 2. Delete: Follows a safe quarantine-and-compensation pattern; cascades to remove chunks and FTS5 entries.
 * 3. Concurrency Guard: Enforces per-source operational locks preventing simultaneous reindex/delete.
 * 4. Zero Path & Secret Leakage: Never returns filesystem paths or raw database handles to callers.
 */
export class DocumentLifecycleService {
  private readonly sourceRepository: KnowledgeSourceRepository
  private readonly storageManager: DocumentStorageManager
  private readonly extractorRegistry: ExtractorRegistry
  private readonly normalizer: (text: string) => string
  private readonly chunker: SemanticChunker
  private readonly settingsProvider: DocumentSettingsProvider

  // In-memory per-source operation locks: `${knowledgeBaseId}:${sourceId}`
  private readonly activeOperations = new Set<string>()

  constructor(options: DocumentLifecycleServiceOptions) {
    if (!options.db) {
      throw DocumentErrors.configurationError(
        'Database instance is required for DocumentLifecycleService.'
      )
    }
    if (!options.sourceRepository) {
      throw DocumentErrors.configurationError(
        'KnowledgeSourceRepository is required for DocumentLifecycleService.'
      )
    }
    if (!options.storageManager) {
      throw DocumentErrors.configurationError(
        'DocumentStorageManager is required for DocumentLifecycleService.'
      )
    }

    this.sourceRepository = options.sourceRepository
    this.storageManager = options.storageManager
    this.settingsProvider = options.settingsProvider ?? new StaticDocumentSettingsProvider()
    this.extractorRegistry = options.extractorRegistry ?? defaultExtractorRegistry
    this.normalizer = options.normalizer ?? normalizeText
    this.chunker = options.chunker ?? new SemanticChunker(this.settingsProvider)
  }

  /**
   * Reindexes an existing document by reprocessing its managed original file.
   * Chunks and FTS5 index entries are replaced atomically in one SQLite transaction.
   */
  public async reindex(request: ReindexDocumentRequest): Promise<ReindexDocumentResultDto> {
    // 1. Zod input validation
    const parseResult = reindexDocumentRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((i) => i.message).join('; ')
      const err = new Error(`Invalid reindex request: ${errorMsg}`)
      ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
      throw err
    }

    const { knowledgeBaseId, sourceId } = parseResult.data

    // 2. Knowledge Base existence verification
    if (!this.sourceRepository.knowledgeBaseExists(knowledgeBaseId)) {
      const err = new Error(`Knowledge Base '${knowledgeBaseId}' could not be found.`)
      ;(err as unknown as { code: string }).code = 'KNOWLEDGE_BASE_NOT_FOUND'
      throw err
    }

    // 3. Document ownership and record retrieval
    const source = this.sourceRepository.getById(sourceId, knowledgeBaseId)
    if (!source) {
      const err = new Error(
        `Document '${sourceId}' could not be found in Knowledge Base '${knowledgeBaseId}'.`
      )
      ;(err as unknown as { code: string }).code = 'DOCUMENT_NOT_FOUND'
      throw err
    }

    // 4. Per-source concurrency lock
    const lockKey = `${knowledgeBaseId}:${sourceId}`
    if (this.activeOperations.has(lockKey)) {
      const err = new Error(
        `An operation is already in progress for document '${sourceId}'. Please wait for it to complete.`
      )
      ;(err as unknown as { code: string }).code = 'OPERATION_IN_PROGRESS'
      throw err
    }
    this.activeOperations.add(lockKey)

    try {
      // 5. Resolve storage path safely from managed storage manager
      const storagePath = this.storageManager.resolveOriginalPath(
        knowledgeBaseId,
        sourceId,
        source.file_type
      )

      // 6. Inspect and defensively validate stored original file
      let stat: fs.Stats
      try {
        stat = await fs.promises.lstat(storagePath)
      } catch {
        throw DocumentErrors.fileNotFound()
      }

      if (stat.isSymbolicLink()) {
        throw DocumentErrors.symlinkNotAllowed()
      }

      if (!stat.isFile()) {
        throw DocumentErrors.invalidFileType()
      }

      const settings = this.settingsProvider.getSettings()
      if (stat.size > settings.maxFileSizeBytes) {
        throw DocumentErrors.fileTooLarge(settings.maxFileSizeBytes)
      }

      // 7. Read file bytes and verify SHA-256 checksum against database record
      const fileBytes = await fs.promises.readFile(storagePath)
      const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex').toLowerCase()
      if (computedHash !== source.content_hash) {
        const err = new Error(
          'Document checksum verification failed: file on disk does not match registered checksum.'
        )
        ;(err as unknown as { code: string }).code = 'CHECKSUM_MISMATCH'
        throw err
      }

      // 8. Transition status to 'processing' (excludes document from active search results)
      this.sourceRepository.updateStatus(sourceId, knowledgeBaseId, 'processing', null)

      // 9. Format-neutral text extraction
      const extracted = await this.extractorRegistry.extract(source.file_type, fileBytes)

      // 10. Text normalization
      const normalizedDoc: ExtractedDocument = {
        format: extracted.format,
        text: this.normalizer(extracted.text),
        sections: extracted.sections.map((s) => ({
          ...s,
          text: this.normalizer(s.text)
        })),
        metadata: extracted.metadata
      }

      // 11. Deterministic semantic chunking
      const chunkingResult = this.chunker.chunk(normalizedDoc)

      // 12. Atomic chunk replacement within one SQLite transaction
      const now = Date.now()
      const chunkInputs: CreateKnowledgeChunkInput[] = chunkingResult.chunks.map((c) => ({
        id: randomUUID(),
        knowledge_base_id: knowledgeBaseId,
        source_id: sourceId,
        chunk_index: c.chunkIndex,
        content: c.content,
        page_number: c.pageNumber,
        token_count: c.tokenCount,
        metadata_json: JSON.stringify({
          ...c.metadata,
          chunkerVersion: chunkingResult.chunkerVersion
        }),
        created_at: now
      }))

      this.sourceRepository.replaceChunks(sourceId, knowledgeBaseId, chunkInputs, now)

      // 13. Retrieve updated source with new chunk count
      const updatedSource = this.sourceRepository.getByIdWithChunkCount(sourceId, knowledgeBaseId)!

      return {
        status: 'completed',
        source: toKnowledgeSourceDto(updatedSource),
        totalChunks: chunkingResult.totalChunks,
        totalTokens: chunkingResult.totalTokens,
        chunkerVersion: chunkingResult.chunkerVersion
      }
    } catch (err) {
      // Mark source as failed and preserve error message for user inspection
      try {
        const sanitized = sanitizeDocumentErrorMessage(
          err instanceof Error ? err.message : String(err)
        )
        this.sourceRepository.updateStatus(sourceId, knowledgeBaseId, 'failed', sanitized)
      } catch {
        // Suppress secondary DB update error to preserve primary error
      }
      throw err
    } finally {
      this.activeOperations.delete(lockKey)
    }
  }

  /**
   * Safely deletes a document using the quarantine-and-compensation pattern.
   * SQLite cascades delete knowledge_chunks, and triggers delete knowledge_fts entries.
   */
  public async delete(request: DeleteDocumentRequest): Promise<DeleteDocumentResultDto> {
    // 1. Zod input validation
    const parseResult = deleteDocumentRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((i) => i.message).join('; ')
      const err = new Error(`Invalid delete request: ${errorMsg}`)
      ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
      throw err
    }

    const { knowledgeBaseId, sourceId } = parseResult.data

    // 2. Knowledge Base existence verification
    if (!this.sourceRepository.knowledgeBaseExists(knowledgeBaseId)) {
      const err = new Error(`Knowledge Base '${knowledgeBaseId}' could not be found.`)
      ;(err as unknown as { code: string }).code = 'KNOWLEDGE_BASE_NOT_FOUND'
      throw err
    }

    // 3. Document ownership and record retrieval
    const source = this.sourceRepository.getById(sourceId, knowledgeBaseId)
    if (!source) {
      const err = new Error(
        `Document '${sourceId}' could not be found in Knowledge Base '${knowledgeBaseId}'.`
      )
      ;(err as unknown as { code: string }).code = 'DOCUMENT_NOT_FOUND'
      throw err
    }

    // 4. Per-source concurrency lock
    const lockKey = `${knowledgeBaseId}:${sourceId}`
    if (this.activeOperations.has(lockKey)) {
      const err = new Error(
        `An operation is already in progress for document '${sourceId}'. Please wait for it to complete.`
      )
      ;(err as unknown as { code: string }).code = 'OPERATION_IN_PROGRESS'
      throw err
    }
    this.activeOperations.add(lockKey)

    try {
      // 5. Resolve storage path safely from managed storage manager
      const storagePath = this.storageManager.resolveOriginalPath(
        knowledgeBaseId,
        sourceId,
        source.file_type
      )
      const originalsDir = this.storageManager.resolveOriginalsDirectory(knowledgeBaseId)

      // 6. Check physical file existence and symlink safety
      let fileExisted = false
      try {
        const stat = await fs.promises.lstat(storagePath)
        if (stat.isSymbolicLink()) {
          throw DocumentErrors.securityError('Cannot delete symbolic link in storage')
        }
        fileExisted = true
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code
        if (code !== 'ENOENT') {
          throw err
        }
      }

      // 7. Quarantine original file atomically prior to SQLite deletion
      let isQuarantined = false
      const quarantineName = `.quarantine_${sourceId}_${randomUUID()}.${source.file_type}`
      const quarantinePath = path.resolve(originalsDir, quarantineName)

      if (fileExisted) {
        try {
          await fs.promises.rename(storagePath, quarantinePath)
          isQuarantined = true
        } catch (renameErr) {
          const err = new Error(
            `Failed to quarantine original file prior to deletion: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
          )
          ;(err as unknown as { code: string }).code = 'STORAGE_ERROR'
          throw err
        }
      }

      // 8. Execute SQLite deletion (cascades to chunks, triggers delete FTS entries)
      let dbDeleted = false
      try {
        dbDeleted = this.sourceRepository.delete(sourceId, knowledgeBaseId)
        if (!dbDeleted) {
          // If record was somehow missing, restore quarantine
          if (isQuarantined) {
            await fs.promises.rename(quarantinePath, storagePath)
          }
          const err = new Error(`Document '${sourceId}' was not found for deletion.`)
          ;(err as unknown as { code: string }).code = 'DOCUMENT_NOT_FOUND'
          throw err
        }
      } catch (dbErr) {
        // Compensation: Restore original file from quarantine on database deletion failure
        if (isQuarantined) {
          try {
            await fs.promises.rename(quarantinePath, storagePath)
          } catch {
            const compensationErr = new Error(
              'Database deletion failed and original file could not be restored from quarantine.'
            )
            ;(compensationErr as unknown as { code: string }).code = 'COMPENSATION_FAILED'
            throw compensationErr
          }
        }
        throw dbErr
      }

      // 9. Finalize safe removal of quarantined file
      let fileCleaned = false
      let cleanupPending = false

      if (isQuarantined) {
        try {
          await fs.promises.unlink(quarantinePath)
          fileCleaned = true
        } catch {
          // Database record, chunks, and FTS rows are gone; OS file lock deferred removal
          fileCleaned = false
          cleanupPending = true
        }
      } else {
        fileCleaned = true
      }

      return {
        success: dbDeleted,
        sourceId,
        knowledgeBaseId,
        fileCleaned,
        cleanupPending
      }
    } finally {
      this.activeOperations.delete(lockKey)
    }
  }
}
