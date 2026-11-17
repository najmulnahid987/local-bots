import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type {
  BotMemoryDto,
  BotMemoryType,
  DeleteBotMemoryResultDto,
  BotMemoryApi
} from '../../../shared/bot-memories'
import { BotMemoryBridgeError, estimateTokenCount } from '../../../shared/bot-memories'

export interface UseBotMemoriesOptions {
  readonly botId?: string | null
  readonly memoryType?: BotMemoryType
  readonly enabled?: boolean
  readonly api?: BotMemoryApi
}

export interface UseBotMemoriesState {
  readonly memories: readonly BotMemoryDto[]
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly isMutating: boolean
  readonly error: string | null
  readonly totalEstimatedTokens: number
  readonly pinnedCount: number
  readonly noteCount: number
  readonly refresh: () => Promise<void>
  readonly createMemory: (input: {
    memoryType?: BotMemoryType
    content: string
  }) => Promise<BotMemoryDto>
  readonly updateMemory: (
    memoryId: string,
    input: { memoryType?: BotMemoryType; content?: string }
  ) => Promise<BotMemoryDto>
  readonly deleteMemory: (memoryId: string) => Promise<DeleteBotMemoryResultDto>
  readonly clearError: () => void
}

function sanitizeMemoryError(err: unknown): string {
  const rawMsg =
    err instanceof BotMemoryBridgeError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
  return rawMsg
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)(?:\/[a-zA-Z0-9_.-]+){2,}/g, ' [REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

/**
 * Custom React hook managing the saved memory collection for a selected Bot.
 * Communicates strictly via window.api.botMemories (canonical) or injected api.
 * Scoped strictly to the active Bot identity; resets on Bot change.
 */
export function useBotMemories(options?: UseBotMemoriesOptions): UseBotMemoriesState {
  const botId = options?.botId
  const memoryTypeFilter = options?.memoryType
  const enabled = options?.enabled ?? true
  const apiOption = options?.api

  const [memories, setMemories] = useState<readonly BotMemoryDto[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(botId && enabled))
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [isMutating, setIsMutating] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track botId changes to reset state immediately
  const [prevBotId, setPrevBotId] = useState<string | null | undefined>(botId)
  if (botId !== prevBotId) {
    setPrevBotId(botId)
    setMemories([])
    setIsLoading(Boolean(botId && enabled))
    setError(null)
  }

  const mountedRef = useRef<boolean>(true)
  const requestIdRef = useRef<number>(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const getEffectiveApi = useCallback((): BotMemoryApi => {
    if (apiOption) {
      return apiOption
    }
    if (typeof window !== 'undefined' && window.api?.botMemories) {
      return window.api.botMemories
    }
    if (typeof window !== 'undefined' && window.api?.memories) {
      return window.api.memories
    }
    throw new BotMemoryBridgeError(
      'Bot Memory API is not available on window.api.botMemories',
      'API_UNAVAILABLE'
    )
  }, [apiOption])

  const fetchMemories = useCallback(
    async (isBackgroundRefresh = false): Promise<void> => {
      if (!botId || !enabled) {
        return
      }

      const currentReqId = ++requestIdRef.current

      if (isBackgroundRefresh) {
        setIsRefreshing(true)
      } else {
        setIsLoading(true)
      }
      setError(null)

      try {
        const api = getEffectiveApi()
        const fetched = await api.list({
          botId,
          memoryType: memoryTypeFilter
        })

        if (mountedRef.current && currentReqId === requestIdRef.current) {
          setMemories(fetched)
        }
      } catch (err: unknown) {
        if (mountedRef.current && currentReqId === requestIdRef.current) {
          setError(sanitizeMemoryError(err))
        }
      } finally {
        if (mountedRef.current && currentReqId === requestIdRef.current) {
          setIsLoading(false)
          setIsRefreshing(false)
        }
      }
    },
    [botId, enabled, memoryTypeFilter, getEffectiveApi]
  )

  useEffect(() => {
    if (!botId || !enabled) {
      return
    }

    let isCurrent = true
    const currentReqId = ++requestIdRef.current

    const runInitialFetch = async (): Promise<void> => {
      try {
        const api = getEffectiveApi()
        const fetched = await api.list({
          botId,
          memoryType: memoryTypeFilter
        })

        if (isCurrent && mountedRef.current && currentReqId === requestIdRef.current) {
          setMemories(fetched)
          setError(null)
        }
      } catch (err: unknown) {
        if (isCurrent && mountedRef.current && currentReqId === requestIdRef.current) {
          setError(sanitizeMemoryError(err))
        }
      } finally {
        if (isCurrent && mountedRef.current && currentReqId === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    }

    void runInitialFetch()

    return () => {
      isCurrent = false
    }
  }, [botId, enabled, memoryTypeFilter, getEffectiveApi])

  const refresh = useCallback(async (): Promise<void> => {
    await fetchMemories(true)
  }, [fetchMemories])

  const createMemory = useCallback(
    async (input: { memoryType?: BotMemoryType; content: string }): Promise<BotMemoryDto> => {
      if (!botId) {
        throw new BotMemoryBridgeError('No Bot selected to create memory for.', 'INVALID_INPUT')
      }

      setIsMutating(true)
      setError(null)

      try {
        const api = getEffectiveApi()
        const created = await api.create({
          botId,
          memoryType: input.memoryType ?? 'user_note',
          content: input.content
        })

        if (mountedRef.current) {
          await fetchMemories(true)
        }
        return created
      } catch (err: unknown) {
        const sanitized = sanitizeMemoryError(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw new BotMemoryBridgeError(sanitized)
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [botId, getEffectiveApi, fetchMemories]
  )

  const updateMemory = useCallback(
    async (
      memoryId: string,
      input: { memoryType?: BotMemoryType; content?: string }
    ): Promise<BotMemoryDto> => {
      if (!botId) {
        throw new BotMemoryBridgeError('No Bot selected to update memory for.', 'INVALID_INPUT')
      }

      setIsMutating(true)
      setError(null)

      try {
        const api = getEffectiveApi()
        const updated = await api.update(memoryId, botId, input)

        if (mountedRef.current) {
          await fetchMemories(true)
        }
        return updated
      } catch (err: unknown) {
        const sanitized = sanitizeMemoryError(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw new BotMemoryBridgeError(sanitized)
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [botId, getEffectiveApi, fetchMemories]
  )

  const deleteMemory = useCallback(
    async (memoryId: string): Promise<DeleteBotMemoryResultDto> => {
      if (!botId) {
        throw new BotMemoryBridgeError('No Bot selected to delete memory for.', 'INVALID_INPUT')
      }

      setIsMutating(true)
      setError(null)

      try {
        const api = getEffectiveApi()
        const result = await api.delete(memoryId, botId)

        if (mountedRef.current) {
          await fetchMemories(true)
        }
        return result
      } catch (err: unknown) {
        const sanitized = sanitizeMemoryError(err)
        if (mountedRef.current) {
          setError(sanitized)
        }
        throw new BotMemoryBridgeError(sanitized)
      } finally {
        if (mountedRef.current) {
          setIsMutating(false)
        }
      }
    },
    [botId, getEffectiveApi, fetchMemories]
  )

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  const totalEstimatedTokens = useMemo(() => {
    return memories.reduce((acc, m) => acc + estimateTokenCount(m.content), 0)
  }, [memories])

  const pinnedCount = useMemo(() => {
    return memories.filter((m) => m.memoryType === 'pinned_instruction').length
  }, [memories])

  const noteCount = useMemo(() => {
    return memories.filter((m) => m.memoryType === 'user_note').length
  }, [memories])

  return {
    memories,
    isLoading,
    isRefreshing,
    isMutating,
    error,
    totalEstimatedTokens,
    pinnedCount,
    noteCount,
    refresh,
    createMemory,
    updateMemory,
    deleteMemory,
    clearError
  }
}
