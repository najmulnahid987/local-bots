import { useState, useCallback, useRef } from 'react'
import type { DocumentSearchResultDto } from '../../../shared/knowledge-documents'

export interface DocumentSearchState {
  readonly query: string
  readonly setQuery: (q: string) => void
  readonly results: readonly DocumentSearchResultDto[]
  readonly searching: boolean
  readonly searchError: string | null
  readonly searchedQuery: string | null
  readonly search: (customQuery?: string) => Promise<void>
  readonly clearSearch: () => void
}

/**
 * Custom React hook managing document search within a Knowledge Base.
 * Automatically clears and resets results when the active Knowledge Base changes.
 */
export function useDocumentSearch(knowledgeBaseId: string): DocumentSearchState {
  const [query, setQuery] = useState<string>('')
  const [results, setResults] = useState<readonly DocumentSearchResultDto[]>([])
  const [searching, setSearching] = useState<boolean>(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null)

  // Reset search state upon Knowledge Base change
  const [prevKnowledgeBaseId, setPrevKnowledgeBaseId] = useState<string>(knowledgeBaseId)
  if (knowledgeBaseId !== prevKnowledgeBaseId) {
    setPrevKnowledgeBaseId(knowledgeBaseId)
    setQuery('')
    setResults([])
    setSearching(false)
    setSearchError(null)
    setSearchedQuery(null)
  }

  const searchReqIdRef = useRef<number>(0)

  const search = useCallback(
    async (customQuery?: string): Promise<void> => {
      const targetQuery = (customQuery !== undefined ? customQuery : query).trim()

      if (!targetQuery) {
        setSearchError('Please enter a search term.')
        return
      }

      if (!knowledgeBaseId) {
        return
      }

      const currentReq = ++searchReqIdRef.current
      setSearching(true)
      setSearchError(null)

      try {
        if (!window.api?.knowledgeDocuments?.search) {
          throw new Error('Document search API is not available.')
        }

        const data = await window.api.knowledgeDocuments.search({
          knowledgeBaseId,
          query: targetQuery
        })

        if (currentReq === searchReqIdRef.current) {
          setResults(data)
          setSearchedQuery(targetQuery)
          setSearchError(null)
        }
      } catch (err) {
        if (currentReq === searchReqIdRef.current) {
          const rawMsg = err instanceof Error ? err.message : String(err)
          const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
          setSearchError(sanitized)
          setResults([])
        }
      } finally {
        if (currentReq === searchReqIdRef.current) {
          setSearching(false)
        }
      }
    },
    [knowledgeBaseId, query]
  )

  const clearSearch = useCallback((): void => {
    setQuery('')
    setResults([])
    setSearchError(null)
    setSearchedQuery(null)
  }, [])

  return {
    query,
    setQuery,
    results,
    searching,
    searchError,
    searchedQuery,
    search,
    clearSearch
  }
}
