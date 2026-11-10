import { ReactElement } from 'react'
import { FileText, BookOpen, Layers, Eye, ArrowLeft, Search } from 'lucide-react'
import type { DocumentSearchResultDto } from '../../../../shared/knowledge-documents'
import { renderHighlightedSnippet } from '../../utils/snippet-highlighter'

export interface DocumentSearchResultsProps {
  readonly results: readonly DocumentSearchResultDto[]
  readonly searchedQuery: string
  readonly onClearSearch: () => void
  readonly onOpenPreview: (sourceId: string) => void
}

export function DocumentSearchResults({
  results,
  searchedQuery,
  onClearSearch,
  onOpenPreview
}: DocumentSearchResultsProps): ReactElement {
  if (results.length === 0) {
    return (
      <div className="document-search-empty-section" data-testid="search-no-results">
        <div className="empty-state-card">
          <Search size={36} className="inline-icon text-muted" aria-hidden="true" />
          <h3 className="empty-state-heading">No matching documents found</h3>
          <p className="empty-state-text">
            No document passages matched &ldquo;{searchedQuery}&rdquo; in this Knowledge Base. Try
            searching for different keywords or checking for spelling errors.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClearSearch}
            style={{ marginTop: '12px' }}
            data-testid="btn-back-to-documents"
          >
            <ArrowLeft size={14} className="inline-icon" aria-hidden="true" />
            <span>Back to All Documents</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="document-search-results-section" data-testid="search-results-section">
      <div className="document-search-results-header">
        <div className="search-results-count-group">
          <span className="search-results-count" data-testid="search-results-count">
            Found {results.length} match{results.length === 1 ? '' : 'es'}
          </span>
          <span className="search-results-query text-muted">for &ldquo;{searchedQuery}&rdquo;</span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onClearSearch}
          data-testid="btn-clear-search-results"
        >
          <ArrowLeft size={14} className="inline-icon" aria-hidden="true" />
          <span>Show All Documents</span>
        </button>
      </div>

      <div className="document-search-results-list" role="list" data-testid="search-results-list">
        {results.map((result, idx) => (
          <article
            key={`${result.chunkId}-${idx}`}
            className="document-search-result-card"
            data-testid={`search-result-card-${idx}`}
          >
            {/* Header: Document Name and Metadata */}
            <div className="search-result-header">
              <div className="search-result-title-group">
                <FileText size={16} className="inline-icon text-accent" aria-hidden="true" />
                <h4 className="search-result-filename" data-testid={`result-filename-${idx}`}>
                  {result.filename}
                </h4>
              </div>

              <div className="search-result-provenance">
                {result.pageNumber !== null && (
                  <span
                    className="provenance-badge provenance-page"
                    data-testid={`result-page-${idx}`}
                  >
                    <BookOpen size={12} className="inline-icon" aria-hidden="true" /> Page{' '}
                    {result.pageNumber}
                  </span>
                )}

                {result.heading && (
                  <span
                    className="provenance-badge provenance-heading"
                    data-testid={`result-heading-${idx}`}
                  >
                    {result.headingPath && result.headingPath.length > 1
                      ? result.headingPath.join(' > ')
                      : result.heading}
                  </span>
                )}

                <span className="provenance-badge provenance-chunk text-muted">
                  <Layers size={12} className="inline-icon" aria-hidden="true" /> Chunk #
                  {result.chunkIndex + 1}
                </span>

                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-preview-result"
                  onClick={() => onOpenPreview(result.sourceId)}
                  data-testid={`btn-preview-result-${idx}`}
                >
                  <Eye size={14} className="inline-icon" aria-hidden="true" />
                  <span>Preview</span>
                </button>
              </div>
            </div>

            {/* Snippet with safe highlights */}
            <div className="search-result-snippet-box" data-testid={`result-snippet-${idx}`}>
              <p className="search-result-snippet-text">
                &hellip;{renderHighlightedSnippet(result.snippet)}&hellip;
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
