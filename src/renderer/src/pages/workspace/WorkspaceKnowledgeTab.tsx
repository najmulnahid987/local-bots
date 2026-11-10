import { ReactElement, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { RotateCw, AlertCircle, Plus, Loader2 } from 'lucide-react'
import type { WorkspaceOutletContext } from './WorkspaceOverviewTab'
import type { KnowledgeSourceDto } from '../../../../shared/knowledge-documents'
import { useKnowledgeDocuments } from '../../hooks/useKnowledgeDocuments'
import { useDocumentSearch } from '../../hooks/useDocumentSearch'
import { DocumentSearchBar } from '../../components/documents/DocumentSearchBar'
import { DocumentSearchResults } from '../../components/documents/DocumentSearchResults'
import { DocumentListTable } from '../../components/documents/DocumentListTable'
import { DocumentPreviewModal } from '../../components/documents/DocumentPreviewModal'
import { DocumentDeleteConfirmModal } from '../../components/documents/DocumentDeleteConfirmModal'
import { DocumentDuplicateModal } from '../../components/documents/DocumentDuplicateModal'

export function WorkspaceKnowledgeTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()

  // Documents lifecycle hook
  const {
    documents,
    loading: docsLoading,
    refreshing: docsRefreshing,
    error: docsError,
    refresh: refreshDocs,
    importing,
    importError,
    importResult,
    selectAndImport,
    reindexingId,
    reindexError,
    reindexDocument,
    deletingId,
    deleteError,
    deleteDocument,
    clearErrors,
    clearImportResult
  } = useKnowledgeDocuments(knowledgeBase.id)

  // Document search hook
  const {
    query,
    setQuery,
    results: searchResults,
    searching,
    searchError,
    searchedQuery,
    search,
    clearSearch
  } = useDocumentSearch(knowledgeBase.id)

  // Modal states
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null)
  const [documentToDelete, setDocumentToDelete] = useState<KnowledgeSourceDto | null>(null)

  // Import handler
  const handleImport = async (allowDuplicate = false): Promise<void> => {
    clearErrors()
    clearImportResult()
    await selectAndImport(allowDuplicate)
  }

  // Delete handlers
  const handleConfirmDelete = async (): Promise<void> => {
    if (!documentToDelete) return
    const success = await deleteDocument(documentToDelete.id)
    if (success) {
      setDocumentToDelete(null)
      // If we are currently in search view, refresh or re-run search to clear deleted match
      if (searchedQuery) {
        void search(searchedQuery)
      }
    }
  }

  // Search handler
  const handleTriggerSearch = (): void => {
    clearErrors()
    void search()
  }

  const isOperationInProgress = Boolean(importing || reindexingId || deletingId)

  return (
    <div className="workspace-tab-panel" data-testid="workspace-knowledge-tab">
      {/* Panel Header & Primary Action Bar */}
      <div className="workspace-panel-header-row">
        <div className="workspace-panel-header">
          <h2 className="workspace-panel-title">Knowledge Documents</h2>
          <p className="workspace-panel-subtitle">
            Manage shared documents, full-text search index, and sources for {knowledgeBase.name}.
          </p>
        </div>

        <div className="workspace-panel-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => refreshDocs()}
            disabled={docsLoading || docsRefreshing || isOperationInProgress}
            aria-label="Refresh document list"
            data-testid="btn-refresh-documents"
          >
            <RotateCw
              size={14}
              className={`inline-icon ${docsRefreshing ? 'spinner' : ''}`}
              aria-hidden="true"
            />
            <span>{docsRefreshing ? 'Refreshing...' : 'Refresh'}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => handleImport(false)}
            disabled={isOperationInProgress}
            aria-label="Import document"
            data-testid="btn-import-document"
          >
            {importing ? (
              <>
                <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                <span>Importing...</span>
              </>
            ) : (
              <>
                <Plus size={14} className="inline-icon" aria-hidden="true" />
                <span>Import Document</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error Banners */}
      {docsError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="alert-docs-error"
        >
          <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Failed to load documents</strong>
            <span>{docsError}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => refreshDocs()}
              style={{ marginTop: '8px', alignSelf: 'flex-start' }}
              data-testid="btn-retry-docs"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {importError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="alert-import-error"
        >
          <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Import Error</strong>
            <span>{importError}</span>
          </div>
        </div>
      )}

      {reindexError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="alert-reindex-error"
        >
          <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Reindex Error</strong>
            <span>{reindexError}</span>
          </div>
        </div>
      )}

      {deleteError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="alert-delete-error"
        >
          <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Deletion Error</strong>
            <span>{deleteError}</span>
          </div>
        </div>
      )}

      {searchError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="alert-search-error"
        >
          <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Search Error</strong>
            <span>{searchError}</span>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <DocumentSearchBar
        query={query}
        onQueryChange={setQuery}
        onSearch={handleTriggerSearch}
        onClear={clearSearch}
        isSearching={searching}
        disabled={isOperationInProgress}
      />

      {/* Content Area: Search Results or Document List */}
      {searchedQuery !== null ? (
        <DocumentSearchResults
          results={searchResults}
          searchedQuery={searchedQuery}
          onClearSearch={clearSearch}
          onOpenPreview={(id) => setPreviewSourceId(id)}
        />
      ) : (
        <DocumentListTable
          documents={documents}
          loading={docsLoading}
          reindexingId={reindexingId}
          deletingId={deletingId}
          onOpenPreview={(id) => setPreviewSourceId(id)}
          onReindex={(id) => void reindexDocument(id)}
          onRequestDelete={(doc) => setDocumentToDelete(doc)}
          onImportClick={() => handleImport(false)}
          isImporting={importing}
        />
      )}

      {/* Document Preview Modal */}
      <DocumentPreviewModal
        isOpen={previewSourceId !== null}
        sourceId={previewSourceId}
        knowledgeBaseId={knowledgeBase.id}
        onClose={() => setPreviewSourceId(null)}
      />

      {/* Document Delete Confirmation Modal */}
      <DocumentDeleteConfirmModal
        isOpen={documentToDelete !== null}
        documentName={documentToDelete?.originalFileName || ''}
        isDeleting={deletingId !== null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDocumentToDelete(null)}
      />

      {/* Duplicate Document Modal */}
      <DocumentDuplicateModal
        isOpen={importResult?.status === 'duplicate'}
        existingFileName={
          importResult?.status === 'duplicate'
            ? importResult.existingSource.originalFileName
            : undefined
        }
        existingFileSize={
          importResult?.status === 'duplicate' ? importResult.existingSource.fileSize : undefined
        }
        isImporting={importing}
        onConfirmDuplicate={async () => {
          clearImportResult()
          await handleImport(true)
        }}
        onCancel={() => clearImportResult()}
      />
    </div>
  )
}
