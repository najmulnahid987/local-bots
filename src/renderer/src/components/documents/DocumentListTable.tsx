import { ReactElement } from 'react'
import {
  FileText,
  RotateCw,
  Trash2,
  Eye,
  AlertCircle,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  FolderOpen
} from 'lucide-react'
import type {
  KnowledgeSourceDto,
  KnowledgeDocumentStatus
} from '../../../../shared/knowledge-documents'
import { formatBytes, formatCount } from '../../utils/formatters'

export interface DocumentListTableProps {
  readonly documents: readonly KnowledgeSourceDto[]
  readonly loading: boolean
  readonly reindexingId: string | null
  readonly deletingId: string | null
  readonly onOpenPreview: (sourceId: string) => void
  readonly onReindex: (sourceId: string) => void
  readonly onRequestDelete: (doc: KnowledgeSourceDto) => void
  readonly onImportClick: () => void
  readonly isImporting: boolean
}

function renderStatusBadge(status: KnowledgeDocumentStatus, errorMsg: string | null): ReactElement {
  switch (status) {
    case 'completed':
      return (
        <span
          className="status-badge status-badge-active"
          title="Document indexed successfully and searchable by Bots"
          data-testid="status-badge-completed"
        >
          <CheckCircle2 size={12} className="inline-icon" aria-hidden="true" /> Completed
        </span>
      )
    case 'processing':
      return (
        <span
          className="status-badge status-badge-neutral"
          title="Document extraction and semantic chunking in progress"
          data-testid="status-badge-processing"
        >
          <Loader2 size={12} className="spinner inline-icon text-accent" aria-hidden="true" />{' '}
          Processing
        </span>
      )
    case 'queued':
      return (
        <span
          className="status-badge status-badge-neutral"
          title="Document queued for ingestion processing"
          data-testid="status-badge-queued"
        >
          <Clock size={12} className="inline-icon" aria-hidden="true" /> Queued
        </span>
      )
    case 'failed':
      return (
        <span
          className="status-badge status-badge-error"
          title={errorMsg || 'Document processing failed'}
          data-testid="status-badge-failed"
        >
          <XCircle size={12} className="inline-icon" aria-hidden="true" /> Failed
        </span>
      )
    case 'needs_reindex':
      return (
        <span
          className="status-badge status-badge-neutral"
          title="Document requires reindexing"
          data-testid="status-badge-needs-reindex"
        >
          <HelpCircle size={12} className="inline-icon text-warning" aria-hidden="true" /> Needs
          Reindex
        </span>
      )
    default:
      return <span className="status-badge status-badge-neutral">{status}</span>
  }
}

export function DocumentListTable({
  documents,
  loading,
  reindexingId,
  deletingId,
  onOpenPreview,
  onReindex,
  onRequestDelete,
  onImportClick,
  isImporting
}: DocumentListTableProps): ReactElement {
  if (loading && documents.length === 0) {
    return (
      <div className="section-loading-state" role="status" data-testid="documents-loading">
        <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
        <span>Loading Knowledge Base documents...</span>
      </div>
    )
  }

  if (documents.length === 0) {
    return (
      <div className="empty-state-section" data-testid="workspace-knowledge-empty">
        <div className="empty-state-card">
          <FolderOpen
            size={44}
            style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
            aria-hidden="true"
          />
          <h3 className="empty-state-heading">No documents uploaded yet</h3>
          <p className="empty-state-text">
            Import text, Markdown, or PDF documents to share them across all Bots in this Knowledge
            Base.
          </p>
          <div className="empty-state-actions" style={{ marginTop: '16px' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onImportClick}
              disabled={isImporting}
              data-testid="btn-empty-import"
            >
              <FileText size={16} className="inline-icon" aria-hidden="true" />
              <span>Import Document</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="document-list-table-wrapper" data-testid="documents-table-wrapper">
      <table className="document-list-table" aria-label="Knowledge Base documents">
        <thead>
          <tr>
            <th scope="col" className="col-filename">
              Document Name
            </th>
            <th scope="col" className="col-type">
              Format
            </th>
            <th scope="col" className="col-size">
              Size
            </th>
            <th scope="col" className="col-chunks">
              Chunks
            </th>
            <th scope="col" className="col-status">
              Status
            </th>
            <th scope="col" className="col-actions">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const isReindexing = reindexingId === doc.id
            const isDeleting = deletingId === doc.id
            const isActionDisabled = isReindexing || isDeleting || isImporting

            return (
              <tr key={doc.id} className="document-row" data-testid={`document-row-${doc.id}`}>
                {/* Filename & error note if failed */}
                <td className="col-filename">
                  <div className="doc-name-cell">
                    <FileText size={16} className="inline-icon text-accent" aria-hidden="true" />
                    <span
                      className="doc-name-text"
                      title={doc.originalFileName}
                      data-testid="doc-name"
                    >
                      {doc.originalFileName}
                    </span>
                  </div>
                  {doc.indexingStatus === 'failed' && doc.errorMessage && (
                    <div className="doc-error-cell-note" data-testid="doc-error-message">
                      <AlertCircle
                        size={12}
                        className="inline-icon text-danger"
                        aria-hidden="true"
                      />
                      <span>{doc.errorMessage}</span>
                    </div>
                  )}
                </td>

                {/* Format badge */}
                <td className="col-type">
                  <span className={`doc-format-badge format-${doc.fileType}`}>
                    {doc.fileType.toUpperCase()}
                  </span>
                </td>

                {/* File size */}
                <td className="col-size" data-testid="doc-size">
                  {formatBytes(doc.fileSize)}
                </td>

                {/* Chunk count */}
                <td className="col-chunks" data-testid="doc-chunk-count">
                  {doc.indexingStatus === 'completed' ? formatCount(doc.chunkCount) : '—'}
                </td>

                {/* Status */}
                <td className="col-status" data-testid="doc-status-cell">
                  {renderStatusBadge(doc.indexingStatus, doc.errorMessage)}
                </td>

                {/* Actions */}
                <td className="col-actions">
                  <div className="doc-row-actions">
                    {/* Preview Button (completed documents only) */}
                    {doc.indexingStatus === 'completed' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onOpenPreview(doc.id)}
                        disabled={isActionDisabled}
                        title="Preview initial excerpts and metadata"
                        aria-label={`Preview ${doc.originalFileName}`}
                        data-testid={`btn-preview-${doc.id}`}
                      >
                        <Eye size={14} className="inline-icon" aria-hidden="true" />
                        <span>Preview</span>
                      </button>
                    )}

                    {/* Reindex Button */}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onReindex(doc.id)}
                      disabled={isActionDisabled}
                      title="Reprocess original file and regenerate search chunks"
                      aria-label={`Reindex ${doc.originalFileName}`}
                      data-testid={`btn-reindex-${doc.id}`}
                    >
                      <RotateCw
                        size={14}
                        className={`inline-icon ${isReindexing ? 'spinner' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{isReindexing ? 'Reindexing...' : 'Reindex'}</span>
                    </button>

                    {/* Delete Button */}
                    <button
                      type="button"
                      className="btn btn-danger-outline btn-sm"
                      onClick={() => onRequestDelete(doc)}
                      disabled={isActionDisabled}
                      title="Permanently delete document and its indexed chunks"
                      aria-label={`Delete ${doc.originalFileName}`}
                      data-testid={`btn-delete-${doc.id}`}
                    >
                      {isDeleting ? (
                        <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                      ) : (
                        <Trash2 size={14} className="inline-icon" aria-hidden="true" />
                      )}
                      <span>{isDeleting ? 'Deleting...' : 'Delete'}</span>
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
