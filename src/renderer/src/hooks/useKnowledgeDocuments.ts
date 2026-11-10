import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  KnowledgeSourceDto,
  DocumentImportResultDto
} from '../../../shared/knowledge-documents'

export interface KnowledgeDocumentsState {
  readonly documents: readonly KnowledgeSourceDto[]
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly importing: boolean
  readonly importError: string | null
  readonly importResult: DocumentImportResultDto | null
  readonly selectAndImport: (allowDuplicate?: boolean) => Promise<DocumentImportResultDto | null>
  readonly reindexingId: string | null
  readonly reindexError: string | null
  readonly reindexDocument: (sourceId: string) => Promise<boolean>
  readonly deletingId: string | null
  readonly deleteError: string | null
  readonly deleteDocument: (sourceId: string) => Promise<boolean>
  readonly clearErrors: () => void
  readonly clearImportResult: () => void
}

/**
 * Custom React hook managing documents, import, reindexing, and deletion.
 * Strictly scoped to the specified knowledgeBaseId.
 */
export function useKnowledgeDocuments(knowledgeBaseId: string): KnowledgeDocumentsState {
  const [documents, setDocuments] = useState<readonly KnowledgeSourceDto[]>([])
  const [loading, setLoading] = useState<boolean>(Boolean(knowledgeBaseId))
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const [importing, setImporting] = useState<boolean>(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<DocumentImportResultDto | null>(null)

  const [reindexingId, setReindexingId] = useState<string | null>(null)
  const [reindexError, setReindexError] = useState<string | null>(null)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Immediately reset state upon switching Knowledge Bases
  const [prevKnowledgeBaseId, setPrevKnowledgeBaseId] = useState<string>(knowledgeBaseId)
  if (knowledgeBaseId !== prevKnowledgeBaseId) {
    setPrevKnowledgeBaseId(knowledgeBaseId)
    setDocuments([])
    setLoading(Boolean(knowledgeBaseId))
    setError(null)
    setImporting(false)
    setImportError(null)
    setImportResult(null)
    setReindexingId(null)
    setReindexError(null)
    setDeletingId(null)
    setDeleteError(null)
  }

  const requestIdRef = useRef<number>(0)

  // Effect to load documents when knowledgeBaseId changes
  useEffect(() => {
    let isCurrent = true
    const currentReq = ++requestIdRef.current

    if (!knowledgeBaseId) {
      return
    }

    const fetchDocs = async (): Promise<void> => {
      try {
        if (!window.api?.knowledgeDocuments?.list) {
          throw new Error('Knowledge documents API is not available.')
        }

        const data = await window.api.knowledgeDocuments.list(knowledgeBaseId)

        if (isCurrent && currentReq === requestIdRef.current) {
          setDocuments(data)
          setError(null)
        }
      } catch (err) {
        if (isCurrent && currentReq === requestIdRef.current) {
          const rawMsg = err instanceof Error ? err.message : String(err)
          const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
          setError(sanitized)
        }
      } finally {
        if (isCurrent && currentReq === requestIdRef.current) {
          setLoading(false)
        }
      }
    }

    void fetchDocs()

    return () => {
      isCurrent = false
    }
  }, [knowledgeBaseId])

  const refresh = useCallback(async (): Promise<void> => {
    if (!knowledgeBaseId) return

    const currentReq = ++requestIdRef.current
    setRefreshing(true)
    setError(null)

    try {
      if (!window.api?.knowledgeDocuments?.list) {
        throw new Error('Knowledge documents API is not available.')
      }

      const data = await window.api.knowledgeDocuments.list(knowledgeBaseId)

      if (currentReq === requestIdRef.current) {
        setDocuments(data)
        setError(null)
      }
    } catch (err) {
      if (currentReq === requestIdRef.current) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setError(sanitized)
      }
    } finally {
      if (currentReq === requestIdRef.current) {
        setRefreshing(false)
      }
    }
  }, [knowledgeBaseId])

  const selectAndImport = useCallback(
    async (allowDuplicate = false): Promise<DocumentImportResultDto | null> => {
      if (!knowledgeBaseId || importing) {
        return null
      }

      setImporting(true)
      setImportError(null)

      try {
        if (!window.api?.knowledgeDocuments?.selectAndImport) {
          throw new Error('Knowledge documents API is not available.')
        }

        const result = await window.api.knowledgeDocuments.selectAndImport({
          knowledgeBaseId,
          allowDuplicate
        })

        setImportResult(result)

        if (result.status === 'completed') {
          await refresh()
        }

        return result
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setImportError(sanitized)
        return null
      } finally {
        setImporting(false)
      }
    },
    [knowledgeBaseId, importing, refresh]
  )

  const reindexDocument = useCallback(
    async (sourceId: string): Promise<boolean> => {
      if (!knowledgeBaseId || reindexingId || deletingId) {
        return false
      }

      setReindexingId(sourceId)
      setReindexError(null)

      try {
        if (!window.api?.knowledgeDocuments?.reindex) {
          throw new Error('Knowledge documents API is not available.')
        }

        const result = await window.api.knowledgeDocuments.reindex({
          knowledgeBaseId,
          sourceId
        })

        if (result.status === 'completed') {
          await refresh()
          return true
        }
        return false
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setReindexError(sanitized)
        return false
      } finally {
        setReindexingId(null)
      }
    },
    [knowledgeBaseId, reindexingId, deletingId, refresh]
  )

  const deleteDocument = useCallback(
    async (sourceId: string): Promise<boolean> => {
      if (!knowledgeBaseId || deletingId || reindexingId) {
        return false
      }

      setDeletingId(sourceId)
      setDeleteError(null)

      try {
        if (!window.api?.knowledgeDocuments?.delete) {
          throw new Error('Knowledge documents API is not available.')
        }

        const result = await window.api.knowledgeDocuments.delete({
          knowledgeBaseId,
          sourceId
        })

        if (result.success) {
          // Eagerly remove deleted document from local state
          setDocuments((prev) => prev.filter((d) => d.id !== sourceId))
          await refresh()
          return true
        } else {
          setDeleteError(result.error || 'Failed to delete document.')
          return false
        }
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        const sanitized = rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setDeleteError(sanitized)
        return false
      } finally {
        setDeletingId(null)
      }
    },
    [knowledgeBaseId, deletingId, reindexingId, refresh]
  )

  const clearErrors = useCallback((): void => {
    setError(null)
    setImportError(null)
    setReindexError(null)
    setDeleteError(null)
  }, [])

  const clearImportResult = useCallback((): void => {
    setImportResult(null)
  }, [])

  return {
    documents,
    loading,
    refreshing,
    error,
    refresh,
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
  }
}
