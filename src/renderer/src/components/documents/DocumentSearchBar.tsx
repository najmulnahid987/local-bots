import { ReactElement, FormEvent } from 'react'
import { Search, X, Loader2 } from 'lucide-react'

export interface DocumentSearchBarProps {
  readonly query: string
  readonly onQueryChange: (q: string) => void
  readonly onSearch: () => void
  readonly onClear: () => void
  readonly isSearching: boolean
  readonly disabled?: boolean
}

export function DocumentSearchBar({
  query,
  onQueryChange,
  onSearch,
  onClear,
  isSearching,
  disabled = false
}: DocumentSearchBarProps): ReactElement {
  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    onSearch()
  }

  return (
    <form
      className="document-search-form"
      role="search"
      aria-label="Search documents"
      onSubmit={handleSubmit}
      data-testid="document-search-form"
    >
      <div className="document-search-input-wrapper">
        <Search size={18} className="document-search-icon" aria-hidden="true" />
        <input
          type="text"
          className="document-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search document content using full-text search..."
          aria-label="Search document content"
          disabled={disabled || isSearching}
          data-testid="input-document-search"
        />
        {query.length > 0 && !isSearching && (
          <button
            type="button"
            className="document-search-clear-btn"
            onClick={onClear}
            aria-label="Clear search query"
            data-testid="btn-clear-search"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <button
        type="submit"
        className="btn btn-primary document-search-submit-btn"
        disabled={disabled || isSearching || query.trim().length === 0}
        data-testid="btn-submit-search"
      >
        {isSearching ? (
          <>
            <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />
            <span>Searching...</span>
          </>
        ) : (
          <span>Search</span>
        )}
      </button>
    </form>
  )
}
