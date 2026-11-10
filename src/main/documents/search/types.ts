import type {
  DocumentSearchResultDto,
  SearchKnowledgeDocumentsRequest
} from '../../../shared/knowledge-documents'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { DocumentSettingsProvider } from '../document-settings'

export type { DocumentSearchResultDto, SearchKnowledgeDocumentsRequest }

/**
 * Dependency injection configuration for DocumentSearchService.
 */
export interface DocumentSearchServiceOptions {
  readonly sourceRepository: KnowledgeSourceRepository
  readonly settingsProvider?: DocumentSettingsProvider
}
