import type Database from 'better-sqlite3'
import type {
  KnowledgeSource,
  KnowledgeSourceRepository,
  ExtractedDocumentRepository
} from '../../database/repositories'
import type { DocumentFileValidator } from '../document-file-validator'
import type { DocumentStorageManager } from '../document-storage-manager'
import type { ExtractorRegistry } from '../extractors'
import type { DocumentExtractionService } from '../extraction'
import type { DocumentSettingsProvider } from '../document-settings'
import type { SemanticChunker, UniversalDocumentChunker } from '../chunking'
import type { UniversalDocument } from '../model'

/**
 * Options provided to DocumentIngestionService.ingest().
 */
export interface IngestDocumentOptions {
  /**
   * RFC 4122 UUIDv4 identifier of the target Knowledge Base.
   */
  readonly knowledgeBaseId: string

  /**
   * Absolute path to the source document on the local filesystem.
   * Path is strictly validated and never trusted blindly.
   */
  readonly filePath: string

  /**
   * If true, bypasses the intra-Knowledge Base SHA-256 duplicate rejection check
   * and creates an intentional duplicate copy.
   */
  readonly allowDuplicate?: boolean
}

/**
 * Structured response emitted when an intra-Knowledge Base duplicate is detected.
 */
export interface DuplicateDetectionResult {
  readonly status: 'duplicate'
  readonly duplicate: true
  readonly existingSource: {
    readonly id: string
    readonly originalFileName: string
    readonly fileSize: number
    readonly indexingStatus: string
    readonly createdAt: number
  }
}

/**
 * Structured response emitted upon successful document ingestion and FTS5 indexing.
 */
export interface IngestDocumentSuccessResult {
  readonly status: 'completed'
  readonly duplicate: false
  readonly sourceId: string
  readonly knowledgeBaseId: string
  readonly source: KnowledgeSource
  readonly totalChunks: number
  readonly totalTokens: number
  readonly chunkerVersion: string
  readonly relativeFilePath: string
  readonly universalDocument?: UniversalDocument
}

/**
 * Discriminated union result of an ingestion operation.
 */
export type IngestDocumentResult = DuplicateDetectionResult | IngestDocumentSuccessResult

/**
 * Dependency injection options for initializing DocumentIngestionService.
 */
export interface DocumentIngestionServiceOptions {
  readonly db: Database.Database
  readonly validator?: DocumentFileValidator
  readonly storageManager?: DocumentStorageManager
  readonly extractorRegistry?: ExtractorRegistry
  readonly extractionService?: DocumentExtractionService
  readonly settingsProvider?: DocumentSettingsProvider
  readonly chunker?: SemanticChunker
  readonly universalChunker?: UniversalDocumentChunker
  readonly sourceRepository?: KnowledgeSourceRepository
  readonly extractedDocumentRepository?: ExtractedDocumentRepository
}

/**
 * Internal sentinel error thrown inside BEGIN IMMEDIATE transaction when a duplicate is detected concurrently.
 */
export class ConcurrentDuplicateDetectedError extends Error {
  constructor(public readonly existing: KnowledgeSource) {
    super('Duplicate document detected concurrently in Knowledge Base.')
    this.name = 'ConcurrentDuplicateDetectedError'
    Object.setPrototypeOf(this, ConcurrentDuplicateDetectedError.prototype)
  }
}
