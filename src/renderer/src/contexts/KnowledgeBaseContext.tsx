/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type ReactElement
} from 'react'
import type {
  KnowledgeBaseDto,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResult,
  KnowledgeBaseApi
} from '../../../shared/knowledge-bases'
import { KnowledgeBaseBridgeError } from '../../../shared/knowledge-bases'

/**
 * Storage key for persisting the active Knowledge Base UUID across application sessions.
 * Strictly persists only the non-sensitive UUID string, never credentials or documents.
 */
export const ACTIVE_KB_STORAGE_KEY = 'local-ai-workspace.activeKnowledgeBaseId.v1'

/**
 * Safe localStorage wrapper that gracefully handles disabled storage, security restrictions,
 * or quota errors without crashing the application.
 */
export function safeGetLocalStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null
  } catch {
    return null
  }
}

export function safeSetLocalStorage(
  storage: Storage | undefined,
  key: string,
  value: string
): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Ignore storage quota or security errors
  }
}

export function safeRemoveLocalStorage(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // Ignore storage quota or security errors
  }
}

/**
 * Public contract exposed by KnowledgeBaseContext and consumed by useKnowledgeBases().
 */
export interface KnowledgeBaseContextValue {
  readonly knowledgeBases: readonly KnowledgeBaseDto[]
  readonly activeKnowledgeBase: KnowledgeBaseDto | null
  readonly activeKnowledgeBaseId: string | null
  readonly loading: boolean
  readonly initialized: boolean
  readonly error: string | null
  refresh: () => Promise<void>
  selectKnowledgeBase: (id: string | null) => void
  createKnowledgeBase: (input: CreateKnowledgeBaseRequest) => Promise<KnowledgeBaseDto>
  updateKnowledgeBase: (
    id: string,
    input: UpdateKnowledgeBaseRequest
  ) => Promise<KnowledgeBaseDto | null>
  archiveKnowledgeBase: (id: string) => Promise<KnowledgeBaseDto | null>
  unarchiveKnowledgeBase: (id: string) => Promise<KnowledgeBaseDto | null>
  deleteKnowledgeBase: (id: string) => Promise<DeleteKnowledgeBaseResult>
  clearError: () => void
}

export const KnowledgeBaseContext = createContext<KnowledgeBaseContextValue | null>(null)

export interface KnowledgeBaseProviderProps {
  readonly children: ReactNode
  readonly api?: KnowledgeBaseApi
  readonly storage?: Storage
}

/**
 * Centralized Knowledge Base state management provider for the React Renderer.
 * Manages loading, listing, creation, updating, archiving, unarchiving, deletion,
 * and persistent active workspace selection across application sessions.
 */
export function KnowledgeBaseProvider({
  children,
  api: propsApi,
  storage: propsStorage
}: KnowledgeBaseProviderProps): ReactElement {
  const [knowledgeBases, setKnowledgeBases] = useState<readonly KnowledgeBaseDto[]>([])
  const [activeKnowledgeBaseId, setActiveKnowledgeBaseId] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [initialized, setInitialized] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Request sequence counter to prevent out-of-order race conditions from stale refresh calls
  const requestSeqRef = useRef<number>(0)

  const getEffectiveApi = useCallback((): KnowledgeBaseApi | undefined => {
    if (propsApi) return propsApi
    if (typeof window !== 'undefined' && window.api?.knowledgeBases) {
      return window.api.knowledgeBases
    }
    return undefined
  }, [propsApi])

  const getEffectiveStorage = useCallback((): Storage | undefined => {
    if (propsStorage) return propsStorage
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
    return undefined
  }, [propsStorage])

  /**
   * Refreshes the authoritative Knowledge Base collection from the Main process.
   * Reconciles active workspace selection against the authoritative collection.
   */
  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)

    const api = getEffectiveApi()
    const storage = getEffectiveStorage()

    if (!api) {
      const err = new KnowledgeBaseBridgeError(
        'Knowledge Base API is unavailable in this environment.',
        'API_UNAVAILABLE'
      )
      setError(err.message)
      setLoading(false)
      setInitialized(true)
      throw err
    }

    try {
      const items = await api.list({ includeArchived: true })
      if (seq !== requestSeqRef.current) return

      setKnowledgeBases(items)

      // Reconcile active workspace selection
      setActiveKnowledgeBaseId((currentActiveId) => {
        const candidateId = currentActiveId ?? safeGetLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
        if (candidateId) {
          const valid = items.find((kb) => kb.id === candidateId && kb.archivedAt === null)
          if (valid) {
            safeSetLocalStorage(storage, ACTIVE_KB_STORAGE_KEY, valid.id)
            return valid.id
          }
        }
        safeRemoveLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
        return null
      })
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false)
        setInitialized(true)
      }
    }
  }, [getEffectiveApi, getEffectiveStorage])

  /**
   * Initial mount effect to populate collection and restore persisted active workspace.
   */
  useEffect(() => {
    let isMounted = true
    const seq = ++requestSeqRef.current

    const initialize = async (): Promise<void> => {
      setLoading(true)
      setError(null)

      const api = getEffectiveApi()
      const storage = getEffectiveStorage()

      if (!api) {
        if (isMounted && seq === requestSeqRef.current) {
          setError('Knowledge Base API is unavailable in this environment.')
          setLoading(false)
          setInitialized(true)
        }
        return
      }

      try {
        const items = await api.list({ includeArchived: true })
        if (!isMounted || seq !== requestSeqRef.current) return

        setKnowledgeBases(items)

        // Restore persisted active KB ID if present and valid
        const savedId = safeGetLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
        if (savedId) {
          const found = items.find((kb) => kb.id === savedId && kb.archivedAt === null)
          if (found) {
            setActiveKnowledgeBaseId(found.id)
          } else {
            setActiveKnowledgeBaseId(null)
            safeRemoveLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
          }
        } else {
          setActiveKnowledgeBaseId(null)
        }
      } catch (err) {
        if (!isMounted || seq !== requestSeqRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
      } finally {
        if (isMounted && seq === requestSeqRef.current) {
          setLoading(false)
          setInitialized(true)
        }
      }
    }

    void initialize()

    return () => {
      isMounted = false
    }
  }, [getEffectiveApi, getEffectiveStorage])

  /**
   * Selects a Knowledge Base as the active workspace.
   * Validates that the KB exists in the current collection and is not archived.
   * Passing null clears the active workspace.
   */
  const selectKnowledgeBase = useCallback(
    (id: string | null): void => {
      const storage = getEffectiveStorage()
      if (id === null) {
        setActiveKnowledgeBaseId(null)
        safeRemoveLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
        return
      }

      const candidate = knowledgeBases.find((kb) => kb.id === id)
      if (!candidate || candidate.archivedAt !== null) {
        // Unknown or archived Knowledge Bases cannot become active workspace
        return
      }

      setActiveKnowledgeBaseId(candidate.id)
      safeSetLocalStorage(storage, ACTIVE_KB_STORAGE_KEY, candidate.id)
    },
    [knowledgeBases, getEffectiveStorage]
  )

  /**
   * Creates a new Knowledge Base via Preload API and appends it to the collection.
   * Does not automatically create a Bot or change the active workspace.
   */
  const createKnowledgeBase = useCallback(
    async (input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDto> => {
      setError(null)
      const api = getEffectiveApi()
      if (!api) {
        const err = new KnowledgeBaseBridgeError(
          'Knowledge Base API is unavailable in this environment.',
          'API_UNAVAILABLE'
        )
        setError(err.message)
        throw err
      }

      try {
        const created = await api.create(input)
        setKnowledgeBases((prev) => [created, ...prev])
        return created
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      }
    },
    [getEffectiveApi]
  )

  /**
   * Updates mutable fields of an existing Knowledge Base.
   */
  const updateKnowledgeBase = useCallback(
    async (id: string, input: UpdateKnowledgeBaseRequest): Promise<KnowledgeBaseDto | null> => {
      setError(null)
      const api = getEffectiveApi()
      if (!api) {
        const err = new KnowledgeBaseBridgeError(
          'Knowledge Base API is unavailable in this environment.',
          'API_UNAVAILABLE'
        )
        setError(err.message)
        throw err
      }

      try {
        const updated = await api.update(id, input)
        if (updated) {
          setKnowledgeBases((prev) => prev.map((kb) => (kb.id === id ? updated : kb)))
        }
        return updated
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      }
    },
    [getEffectiveApi]
  )

  /**
   * Archives a Knowledge Base.
   * If the archived KB is currently active, automatically clears the active selection.
   */
  const archiveKnowledgeBase = useCallback(
    async (id: string): Promise<KnowledgeBaseDto | null> => {
      setError(null)
      const api = getEffectiveApi()
      const storage = getEffectiveStorage()
      if (!api) {
        const err = new KnowledgeBaseBridgeError(
          'Knowledge Base API is unavailable in this environment.',
          'API_UNAVAILABLE'
        )
        setError(err.message)
        throw err
      }

      try {
        const updated = await api.archive(id)
        if (updated) {
          setKnowledgeBases((prev) => prev.map((kb) => (kb.id === id ? updated : kb)))
          setActiveKnowledgeBaseId((currentActiveId) => {
            if (currentActiveId === id) {
              safeRemoveLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
              return null
            }
            return currentActiveId
          })
        }
        return updated
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      }
    },
    [getEffectiveApi, getEffectiveStorage]
  )

  /**
   * Unarchives a Knowledge Base, restoring it to active availability.
   * Does not automatically make it the active workspace.
   */
  const unarchiveKnowledgeBase = useCallback(
    async (id: string): Promise<KnowledgeBaseDto | null> => {
      setError(null)
      const api = getEffectiveApi()
      if (!api) {
        const err = new KnowledgeBaseBridgeError(
          'Knowledge Base API is unavailable in this environment.',
          'API_UNAVAILABLE'
        )
        setError(err.message)
        throw err
      }

      try {
        const updated = await api.unarchive(id)
        if (updated) {
          setKnowledgeBases((prev) => prev.map((kb) => (kb.id === id ? updated : kb)))
        }
        return updated
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      }
    },
    [getEffectiveApi]
  )

  /**
   * Deletes a Knowledge Base.
   * If success is true (even if cleanupPending is true), removes the KB from the collection
   * and clears active workspace selection if it was active.
   */
  const deleteKnowledgeBase = useCallback(
    async (id: string): Promise<DeleteKnowledgeBaseResult> => {
      setError(null)
      const api = getEffectiveApi()
      const storage = getEffectiveStorage()
      if (!api) {
        const err = new KnowledgeBaseBridgeError(
          'Knowledge Base API is unavailable in this environment.',
          'API_UNAVAILABLE'
        )
        setError(err.message)
        throw err
      }

      try {
        const result = await api.delete(id)
        if (result.success) {
          setKnowledgeBases((prev) => prev.filter((kb) => kb.id !== id))
          setActiveKnowledgeBaseId((currentActiveId) => {
            if (currentActiveId === id) {
              safeRemoveLocalStorage(storage, ACTIVE_KB_STORAGE_KEY)
              return null
            }
            return currentActiveId
          })
        }
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      }
    },
    [getEffectiveApi, getEffectiveStorage]
  )

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  /**
   * Derived active Knowledge Base DTO.
   * Evaluates to null if activeKnowledgeBaseId is null, not found, or archived.
   */
  const activeKnowledgeBase = useMemo<KnowledgeBaseDto | null>(() => {
    if (!activeKnowledgeBaseId) return null
    const found = knowledgeBases.find((kb) => kb.id === activeKnowledgeBaseId)
    if (!found || found.archivedAt !== null) {
      return null
    }
    return found
  }, [knowledgeBases, activeKnowledgeBaseId])

  const contextValue = useMemo<KnowledgeBaseContextValue>(
    () => ({
      knowledgeBases,
      activeKnowledgeBase,
      activeKnowledgeBaseId,
      loading,
      initialized,
      error,
      refresh,
      selectKnowledgeBase,
      createKnowledgeBase,
      updateKnowledgeBase,
      archiveKnowledgeBase,
      unarchiveKnowledgeBase,
      deleteKnowledgeBase,
      clearError
    }),
    [
      knowledgeBases,
      activeKnowledgeBase,
      activeKnowledgeBaseId,
      loading,
      initialized,
      error,
      refresh,
      selectKnowledgeBase,
      createKnowledgeBase,
      updateKnowledgeBase,
      archiveKnowledgeBase,
      unarchiveKnowledgeBase,
      deleteKnowledgeBase,
      clearError
    ]
  )

  return (
    <KnowledgeBaseContext.Provider value={contextValue}>{children}</KnowledgeBaseContext.Provider>
  )
}

/**
 * Custom hook providing access to centralized Knowledge Base state and lifecycle operations.
 * Must be used within a <KnowledgeBaseProvider>.
 */
export function useKnowledgeBases(): KnowledgeBaseContextValue {
  const context = useContext(KnowledgeBaseContext)
  if (!context) {
    throw new Error('useKnowledgeBases must be used within a KnowledgeBaseProvider')
  }
  return context
}
