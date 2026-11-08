import { useState, useEffect, useCallback, useRef } from 'react'
import type { KnowledgeBaseOverviewDto } from '../../../shared/knowledge-bases'

export interface KnowledgeBaseOverviewState {
  readonly overview: KnowledgeBaseOverviewDto | null
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
}

/**
 * Hook providing aggregated overview statistics and recent activity for a Knowledge Base.
 * Scoped strictly to the provided knowledgeBaseId.
 */
export function useKnowledgeBaseOverview(knowledgeBaseId: string): KnowledgeBaseOverviewState {
  const [overview, setOverview] = useState<KnowledgeBaseOverviewDto | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(knowledgeBaseId))
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track previous knowledgeBaseId to immediately clear state upon workspace switch
  const [prevKnowledgeBaseId, setPrevKnowledgeBaseId] = useState<string>(knowledgeBaseId)
  if (knowledgeBaseId !== prevKnowledgeBaseId) {
    setPrevKnowledgeBaseId(knowledgeBaseId)
    setOverview(null)
    setLoading(Boolean(knowledgeBaseId))
    setError(null)
  }

  const requestIdRef = useRef<number>(0)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let isCurrent = true
    const currentRequestId = ++requestIdRef.current

    if (!knowledgeBaseId) {
      return
    }

    const loadOverview = async (): Promise<void> => {
      try {
        if (typeof window === 'undefined' || !window.api?.knowledgeBases?.getOverview) {
          throw new Error('Knowledge Base overview API is not available in this environment.')
        }

        const data = await window.api.knowledgeBases.getOverview(knowledgeBaseId)

        if (!isCurrent || currentRequestId !== requestIdRef.current) {
          return
        }

        setOverview(data)
        setError(null)
      } catch (err) {
        if (!isCurrent || currentRequestId !== requestIdRef.current) {
          return
        }

        const rawMessage = err instanceof Error ? err.message : String(err)
        // Redact any filesystem paths in error messages
        const sanitized = rawMessage.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setError(sanitized)
      } finally {
        if (isCurrent && currentRequestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }

    void loadOverview()

    return () => {
      isCurrent = false
    }
  }, [knowledgeBaseId])

  const refresh = useCallback(async (): Promise<void> => {
    if (!knowledgeBaseId) return
    const currentRequestId = ++requestIdRef.current

    setRefreshing(true)
    setError(null)

    try {
      if (typeof window === 'undefined' || !window.api?.knowledgeBases?.getOverview) {
        throw new Error('Knowledge Base overview API is not available in this environment.')
      }

      const data = await window.api.knowledgeBases.getOverview(knowledgeBaseId)

      if (mountedRef.current && currentRequestId === requestIdRef.current) {
        setOverview(data)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current && currentRequestId === requestIdRef.current) {
        const rawMessage = err instanceof Error ? err.message : String(err)
        const sanitized = rawMessage.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
        setError(sanitized)
      }
    } finally {
      if (mountedRef.current && currentRequestId === requestIdRef.current) {
        setRefreshing(false)
      }
    }
  }, [knowledgeBaseId])

  return {
    overview,
    loading,
    refreshing,
    error,
    refresh
  }
}
