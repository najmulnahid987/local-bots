import type Database from 'better-sqlite3'
import type {
  ReindexDocumentRequest,
  ReindexDocumentResultDto,
  DeleteDocumentRequest,
  DeleteDocumentResultDto
} from '../../../shared/knowledge-documents'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import type { DocumentStorageManager } from '../document-storage-manager'
import type { ExtractorRegistry } from '../extractors/registry'
import type { DocumentExtractionService } from '../extraction'
import type { SemanticChunker, UniversalDocumentChunker } from '../chunking'
import type { DocumentSettingsProvider } from '../document-settings'

export type {
  ReindexDocumentRequest,
  ReindexDocumentResultDto,
  DeleteDocumentRequest,
  DeleteDocumentResultDto
}

/**
 * Dependency injection configuration for DocumentLifecycleService.
 */
export interface DocumentLifecycleServiceOptions {
  readonly db: Database.Database
  readonly sourceRepository: KnowledgeSourceRepository
  readonly storageManager: DocumentStorageManager
  readonly extractorRegistry?: ExtractorRegistry
  readonly extractionService?: DocumentExtractionService
  readonly normalizer?: (text: string) => string
  readonly chunker?: SemanticChunker
  readonly universalChunker?: UniversalDocumentChunker
  readonly settingsProvider?: DocumentSettingsProvider
  readonly extractedDocumentRepository?: ExtractedDocumentRepository
}
