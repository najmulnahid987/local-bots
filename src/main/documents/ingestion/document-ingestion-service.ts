import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  KnowledgeSourceRepository,
  type CreateKnowledgeChunkInput,
  type KnowledgeSource,
  type KnowledgeChunk
} from '../../database/repositories'
import { DocumentErrors, DocumentError } from '../document-errors'
import { DocumentFileValidator } from '../document-file-validator'
import { DocumentStorageManager } from '../document-storage-manager'
import { type DocumentSettingsProvider, StaticDocumentSettingsProvider } from '../document-settings'
import { ExtractorRegistry, defaultExtractorRegistry } from '../extractors'
import { DocumentExtractionService } from '../extraction'
import type { ExtractedDocument } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import { SemanticChunker } from '../chunking/semantic-chunker'
import {
  type IngestDocumentOptions,
  type IngestDocumentResult,
  type DocumentIngestionServiceOptions,
  ConcurrentDuplicateDetectedError
} from './types'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Main-process service that orchestrates the complete document ingestion pipeline:
 *
 * 1. Target Knowledge Base verification.
 * 2. Defensive file validation (extension, size, magic bytes, UTF-8, checksum).
 * 3. Intra-Knowledge Base duplicate detection (scoped to KB + SHA-256).
 * 4. Managed original-file storage (<userData>/documents/<kbId>/originals/<sourceId>.<ext>).
 * 5. Concurrency-protected atomic source registration using SQLite BEGIN IMMEDIATE.
 * 6. Format-aware text extraction (TXT, Markdown, PDF).
 * 7. Deterministic text normalization.
 * 8. Deterministic semantic chunking (~500 tokens with 50-token overlap).
 * 9. Atomic chunk persistence and SQLite FTS5 trigger synchronization.
 * 10. Strict error handling, zero-partial-chunk rollback, and source lifecycle transitions.
 */
export class DocumentIngestionService {
  private readonly db: Database.Database
  private readonly repository: KnowledgeSourceRepository
  private readonly validator: DocumentFileValidator
  private readonly storageManager: DocumentStorageManager
  private readonly extractorRegistry: ExtractorRegistry
  private readonly extractionService: DocumentExtractionService
  private readonly hasCustomRegistry: boolean
  private readonly settingsProvider: DocumentSettingsProvider
  private readonly chunker: SemanticChunker

  constructor(options: DocumentIngestionServiceOptions) {
    if (!options?.db) {
      throw new Error('Database instance is required for DocumentIngestionService.')
    }
    this.db = options.db
    this.repository = options.sourceRepository ?? new KnowledgeSourceRepository(this.db)
    this.settingsProvider = options.settingsProvider ?? new StaticDocumentSettingsProvider()
    this.validator = options.validator ?? new DocumentFileValidator(this.settingsProvider)
    this.storageManager = options.storageManager ?? new DocumentStorageManager()
    this.hasCustomRegistry = !!options.extractorRegistry
    this.extractorRegistry =
      options.extractorRegistry ??
      (options.settingsProvider
        ? new ExtractorRegistry(options.settingsProvider)
        : defaultExtractorRegistry)
    this.extractionService =
      options.extractionService ??
      new DocumentExtractionService({
        settingsProvider: this.settingsProvider
      })
    this.chunker = options.chunker ?? new SemanticChunker(this.settingsProvider)
  }

  /**
   * Orchestrates the complete ingestion pipeline for a document file into a Knowledge Base.
   */
  public async ingest(options: IngestDocumentOptions): Promise<IngestDocumentResult> {
    const { knowledgeBaseId, filePath, allowDuplicate = false } = options

    // 1. Verify Knowledge Base identifier format
    if (!knowledgeBaseId || !UUID_V4_REGEX.test(knowledgeBaseId)) {
      throw DocumentErrors.invalidKnowledgeBaseId(knowledgeBaseId || '(none)')
    }

    // 2. Verify target Knowledge Base exists in SQLite
    const kbRow = this.db
      .prepare('SELECT id FROM knowledge_bases WHERE id = ?')
      .get(knowledgeBaseId)
    if (!kbRow) {
      throw DocumentErrors.knowledgeBaseNotFound(knowledgeBaseId)
    }

    // 3. Defensive File Validation (magic bytes, extensions, size limits, UTF-8, checksum)
    const validation = await this.validator.validate(filePath)

    // 4. Intra-KB Duplicate Pre-Check (avoids unnecessary disk copy if duplicate already exists)
    if (!allowDuplicate) {
      const existing = this.repository.findByChecksum(knowledgeBaseId, validation.contentHash, true)
      if (existing) {
        return {
          status: 'duplicate',
          duplicate: true,
          existingSource: {
            id: existing.id,
            originalFileName: existing.original_file_name,
            fileSize: existing.file_size,
            indexingStatus: existing.indexing_status,
            createdAt: existing.created_at
          }
        }
      }
    }

    // 5. Generate immutable UUID for the source
    const sourceId = randomUUID()

    // 6. Store original document in managed storage layout:
    // <userData>/documents/<kbId>/originals/<sourceId>.<ext>
    const stored = await this.storageManager.storeOriginal({
      knowledgeBaseId,
      sourceId,
      extension: validation.extension,
      sourcePath: validation.sourcePath,
      expectedSize: validation.fileSizeBytes,
      expectedHash: validation.contentHash,
      expectedMtimeMs: validation.sourceMetadata.mtimeMs,
      expectedIno: validation.sourceMetadata.ino
    })

    // 7. Atomic Concurrency-Safe Source Registration
    // Duplicate re-check and initial registration execute in a BEGIN IMMEDIATE write transaction
    // to prevent race conditions during simultaneous duplicate imports.
    try {
      const registerTx = this.db.transaction(() => {
        if (!allowDuplicate) {
          const existing = this.repository.findByChecksum(
            knowledgeBaseId,
            validation.contentHash,
            true
          )
          if (existing) {
            throw new ConcurrentDuplicateDetectedError(existing)
          }
        }

        const now = Date.now()
        this.repository.create({
          id: sourceId,
          knowledge_base_id: knowledgeBaseId,
          file_name: validation.originalFileName,
          original_file_name: validation.originalFileName,
          relative_file_path: stored.relativeFilePath,
          file_type: validation.fileType,
          mime_type: validation.mimeType,
          file_size: stored.fileSizeBytes,
          content_hash: stored.contentHash,
          indexing_status: 'queued',
          error_message: null,
          created_at: now,
          updated_at: now,
          indexed_at: null
        })
      }).immediate

      registerTx()
    } catch (err) {
      // If registration failed or concurrent duplicate was detected:
      // Remove the unregistered staged file safely
      try {
        await this.storageManager.removeOriginal(knowledgeBaseId, sourceId, validation.extension)
      } catch {
        // Safe cleanup attempt: do not hide original error
      }

      if (err instanceof ConcurrentDuplicateDetectedError) {
        return {
          status: 'duplicate',
          duplicate: true,
          existingSource: {
            id: err.existing.id,
            originalFileName: err.existing.original_file_name,
            fileSize: err.existing.file_size,
            indexingStatus: err.existing.indexing_status,
            createdAt: err.existing.created_at
          }
        }
      }

      throw err
    }

    // 8. Transition source status from 'queued' to 'processing'
    this.repository.updateStatus(sourceId, knowledgeBaseId, 'processing')

    // 9. Execute Extraction, Normalization, Chunking and Atomic Persistence
    try {
      // 9A. Read original bytes from managed storage
      const fileBytes = await fs.promises.readFile(stored.storagePath)

      // 9B. Format-neutral text extraction
      const extracted =
        this.hasCustomRegistry && this.extractorRegistry.hasExtractor(validation.fileType)
          ? await this.extractorRegistry.extract(validation.fileType, fileBytes)
          : await this.extractionService.extractLegacy(validation.fileType, fileBytes)

      // 9C. Text normalization
      const normalizedDoc: ExtractedDocument = {
        format: extracted.format,
        text: normalizeText(extracted.text),
        sections: extracted.sections.map((s) => ({
          ...s,
          text: normalizeText(s.text)
        })),
        metadata: extracted.metadata
      }

      // 9D. Semantic Chunking
      const chunkingResult = this.chunker.chunk(normalizedDoc)

      // 9E. Atomic SQLite Chunk Persistence & Source Completion
      // One transaction inserts all chunks and updates source status to 'completed'.
      // SQLite triggers automatically synchronize all chunks into knowledge_fts.
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
          chunkerVersion: c.chunkerVersion
        }),
        created_at: now
      }))

      const persistTx = this.db.transaction(() => {
        this.repository.insertChunks(chunkInputs)
        this.repository.complete(sourceId, knowledgeBaseId, now)
      })

      persistTx()

      const completedSource = this.repository.getById(sourceId, knowledgeBaseId)!

      return {
        status: 'completed',
        duplicate: false,
        sourceId,
        knowledgeBaseId,
        source: completedSource,
        totalChunks: chunkingResult.totalChunks,
        totalTokens: chunkingResult.totalTokens,
        chunkerVersion: chunkingResult.chunkerVersion,
        relativeFilePath: stored.relativeFilePath
      }
    } catch (err) {
      // Processing failed after source was registered.
      // 1. Ensure zero partial chunks or partial FTS entries remain.
      try {
        this.repository.deleteChunksBySourceId(sourceId, knowledgeBaseId)
      } catch {
        // Ignore deletion cleanup error during rollback
      }

      // 2. Mark source as 'failed' in SQLite with sanitized error message.
      const sanitizedError = this.sanitizeErrorMessage(err)
      try {
        this.repository.updateStatus(sourceId, knowledgeBaseId, 'failed', sanitizedError)
      } catch {
        // Ignore status update failure
      }

      // Note: Original file is preserved on disk for user diagnostic review or retry,
      // in accordance with ADR-0011 and Section 12 of PHASE_5_INGESTION_DESIGN.md.
      throw err
    }
  }

  /**
   * Helper to inspect whether a duplicate source exists in a Knowledge Base by content hash.
   */
  public checkForDuplicate(knowledgeBaseId: string, contentHash: string): KnowledgeSource | null {
    return this.repository.findByChecksum(knowledgeBaseId, contentHash, true)
  }

  /**
   * Retrieves a knowledge source record by ID.
   */
  public getSource(id: string, knowledgeBaseId?: string): KnowledgeSource | null {
    return this.repository.getById(id, knowledgeBaseId)
  }

  /**
   * Lists all knowledge sources in a Knowledge Base.
   */
  public listSources(knowledgeBaseId: string): KnowledgeSource[] {
    return this.repository.listByKnowledgeBase(knowledgeBaseId)
  }

  /**
   * Retrieves all chunks for a source document.
   */
  public getChunks(sourceId: string, knowledgeBaseId?: string): KnowledgeChunk[] {
    return this.repository.getChunksBySourceId(sourceId, knowledgeBaseId)
  }

  /**
   * Sanitizes error message to prevent leaking absolute filesystem paths or raw SQL internals.
   */
  private sanitizeErrorMessage(err: unknown): string {
    if (err instanceof DocumentError) {
      return err.message
    }
    const raw = err instanceof Error ? err.message : String(err)
    return raw
      .replace(/[a-zA-Z]:\\[^\s"';)]+/g, '[path]')
      .replace(/\/[\w.-]+(\/[\w.-]+)+/g, '[path]')
      .trim()
  }
}
