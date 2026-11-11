import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  BotDto,
  BotStatus,
  CreateBotRequest,
  UpdateBotRequest,
  DeleteBotResultDto,
  BotApi
} from '../../../shared/bots'
import { BotBridgeError } from '../../../shared/bots'

export interface UseBotsOptions {
  readonly status?: BotStatus
  readonly api?: BotApi
}

export interface UseBotsState {
  readonly bots: readonly BotDto[]
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly isMutating: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly getBot: (botId: string) => Promise<BotDto | null>
  readonly createBot: (request: CreateBotRequest) => Promise<BotDto>
  readonly updateBot: (botId: string, request: UpdateBotRequest) => Promise<BotDto>
  readonly archiveBot: (botId: string) => Promise<BotDto>
  readonly unarchiveBot: (botId: string) => Promise<BotDto>
  readonly deleteBot: (botId: string) => Promise<DeleteBotResultDto>
  readonly clearError: () => void
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof BotBridgeError) {
    return err.message
  }
  const rawMsg = err instanceof Error ? err.message : String(err)
  return rawMsg
    .replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

/**
 * Custom React hook managing AI Bot listing, creation, updates, and lifecycle transitions.
 * Strictly communicates with Main process via window.api.bots.
 * Never supplies or manages knowledgeBaseId independently (enforced by Main process session context).
 */
export function useBots(options?: UseBotsOptions): UseBotsState {
  const status = options?.status
  const apiOption = options?.api

  const [bots, setBots] = useState<readonly BotDto[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [isMutating, setIsMutating] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track status changes to reset loading state during render
  const [prevStatus, setPrevStatus] = useState<BotStatus | undefined>(status)
  if (status !== prevStatus) {
    setPrevStatus(status)
    setIsLoading(true)
    setError(null)
  }

  const mountedRef = useRef<boolean>(true)
  const requestIdRef = useRef<number>(0)

  const getEffectiveApi = useCallback((): BotApi => {
    if (apiOption) {
      return apiOption
    }
    if (typeof window !== 'undefined' && window.api?.bots) {
      return window.api.bots
    }
    throw new BotBridgeError('Bot API is not available in window.api.bots', 'API_UNAVAILABLE')
  }, [apiOption])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial fetch and fetch when status filter changes
  useEffect(() => {
    let isCurrent = true
    const currentReq = ++requestIdRef.current

    const fetchBots = async (): Promise<void> => {
      try {
        const api = getEffectiveApi()
        const data = await api.list(status ? { status } : undefined)

        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setBots(data)
          setError(null)
        }
      } catch (err) {
        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setError(sanitizeErrorMessage(err))
        }
      } finally {
        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    }

    void fetchBots()

    return () => {
      isCurrent = false
    }
  }, [status, getEffectiveApi])

  const refresh = useCallback(async (): Promise<void> => {
    const currentReq = ++requestIdRef.current
    setIsRefreshing(true)
    setError(null)

    try {
      const api = getEffectiveApi()
      const data = await api.list(status ? { status } : undefined)

      if (mountedRef.current && currentReq === requestIdRef.current) {
        setBots(data)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current && currentReq === requestIdRef.current) {
        setError(sanitizeErrorMessage(err))
      }
    } finally {
      if (mountedRef.current && currentReq === requestIdRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [status, getEffectiveApi])

  const getBot = useCallback(
    async (botId: string): Promise<BotDto | null> => {
      try {
        const api = getEffectiveApi()
        return await api.get(botId)
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      }
    },
    [getEffectiveApi]
  )

  const createBot = useCallback(
    async (request: CreateBotRequest): Promise<BotDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const created = await api.create(request)

        if (mountedRef.current) {
          setBots((prev) => {
            if (status && created.status !== status) {
              return prev
            }
            return [created, ...prev.filter((b) => b.id !== created.id)]
          })
          setError(null)
        }
        return created
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [status, getEffectiveApi]
  )

  const updateBot = useCallback(
    async (botId: string, request: UpdateBotRequest): Promise<BotDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const updated = await api.update(botId, request)

        if (mountedRef.current) {
          setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)))
          setError(null)
        }
        return updated
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [getEffectiveApi]
  )

  const archiveBot = useCallback(
    async (botId: string): Promise<BotDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const archived = await api.archive(botId)

        if (mountedRef.current) {
          setBots((prev) => {
            if (status === 'active') {
              return prev.filter((b) => b.id !== botId)
            }
            return prev.map((b) => (b.id === botId ? archived : b))
          })
          setError(null)
        }
        return archived
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [status, getEffectiveApi]
  )

  const unarchiveBot = useCallback(
    async (botId: string): Promise<BotDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const unarchived = await api.unarchive(botId)

        if (mountedRef.current) {
          setBots((prev) => {
            if (status === 'archived') {
              return prev.filter((b) => b.id !== botId)
            }
            return prev.map((b) => (b.id === botId ? unarchived : b))
          })
          setError(null)
        }
        return unarchived
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [status, getEffectiveApi]
  )

  const deleteBot = useCallback(
    async (botId: string): Promise<DeleteBotResultDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const result = await api.delete(botId)

        if (mountedRef.current) {
          setBots((prev) => prev.filter((b) => b.id !== botId))
          setError(null)
        }
        return result
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw err
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [getEffectiveApi]
  )

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  return {
    bots,
    isLoading,
    isRefreshing,
    isMutating,
    error,
    refresh,
    getBot,
    createBot,
    updateBot,
    archiveBot,
    unarchiveBot,
    deleteBot,
    clearError
  }
}
