import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type {
  ConversationDto,
  CreateConversationRequest,
  RenameConversationIpcRequest,
  DeleteConversationIpcRequest,
  DeleteConversationResultDto,
  ConversationApi
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

export interface UseConversationsOptions {
  readonly botId?: string | null
  readonly includeArchived?: boolean
  readonly enabled?: boolean
  readonly initialSelectedId?: string | null
  readonly api?: ConversationApi
}

export interface UseConversationsState {
  readonly conversations: readonly ConversationDto[]
  readonly selectedConversationId: string | null
  readonly selectedConversation: ConversationDto | null
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly isMutating: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly selectConversation: (conversationId: string | null) => void
  readonly createConversation: (title?: string) => Promise<ConversationDto>
  readonly renameConversation: (conversationId: string, title: string) => Promise<ConversationDto>
  readonly deleteConversation: (conversationId: string) => Promise<DeleteConversationResultDto>
  readonly clearError: () => void
}

function sanitizeConversationError(err: unknown): string {
  const rawMsg =
    err instanceof ConversationBridgeError
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
 * Custom React hook managing conversation list state for a specific Bot.
 * Strictly communicates via window.api.conversation / window.api.conversations.
 * Never accepts or supplies knowledgeBaseId independently (enforced by Main-process session context).
 */
export function useConversations(options?: UseConversationsOptions): UseConversationsState {
  const botId = options?.botId
  const includeArchived = options?.includeArchived ?? false
  const enabled = options?.enabled ?? true
  const initialSelectedId = options?.initialSelectedId ?? null
  const apiOption = options?.api

  const [conversations, setConversations] = useState<readonly ConversationDto[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    initialSelectedId
  )
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(botId && enabled))
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [isMutating, setIsMutating] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track botId changes to reset state
  const [prevBotId, setPrevBotId] = useState<string | null | undefined>(botId)
  if (botId !== prevBotId) {
    setPrevBotId(botId)
    setConversations([])
    setSelectedConversationId(null)
    setIsLoading(Boolean(botId && enabled))
    setError(null)
  }

  const mountedRef = useRef<boolean>(true)
  const requestIdRef = useRef<number>(0)

  const getEffectiveApi = useCallback((): ConversationApi => {
    if (apiOption) {
      return apiOption
    }
    if (typeof window !== 'undefined' && window.api?.conversation) {
      return window.api.conversation
    }
    if (typeof window !== 'undefined' && window.api?.conversations) {
      return window.api.conversations
    }
    throw new ConversationBridgeError(
      'Conversation API is not available in window.api.conversation',
      'API_UNAVAILABLE'
    )
  }, [apiOption])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial and reactive fetch when botId or includeArchived changes
  useEffect(() => {
    if (!enabled || !botId) {
      return
    }

    let isCurrent = true
    const currentReq = ++requestIdRef.current

    const fetchConversations = async (): Promise<void> => {
      try {
        const api = getEffectiveApi()
        const data = await api.listConversations({ botId, includeArchived })

        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setConversations(data)
          setError(null)
        }
      } catch (err) {
        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setError(sanitizeConversationError(err))
        }
      } finally {
        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    }

    void fetchConversations()

    return () => {
      isCurrent = false
    }
  }, [botId, includeArchived, enabled, getEffectiveApi])

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !botId) {
      return
    }

    const currentReq = ++requestIdRef.current
    setIsRefreshing(true)
    setError(null)

    try {
      const api = getEffectiveApi()
      const data = await api.listConversations({ botId, includeArchived })

      if (mountedRef.current && currentReq === requestIdRef.current) {
        setConversations(data)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current && currentReq === requestIdRef.current) {
        setError(sanitizeConversationError(err))
      }
    } finally {
      if (mountedRef.current && currentReq === requestIdRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [botId, includeArchived, enabled, getEffectiveApi])

  const selectConversation = useCallback((conversationId: string | null): void => {
    setSelectedConversationId(conversationId)
  }, [])

  const createConversation = useCallback(
    async (title?: string): Promise<ConversationDto> => {
      if (!botId) {
        throw new ConversationBridgeError(
          'Cannot create conversation without a selected Bot',
          'INVALID_BOT'
        )
      }

      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const request: CreateConversationRequest = { botId, title }
        const created = await api.createConversation(request)

        if (mountedRef.current) {
          setConversations((prev) => [created, ...prev.filter((c) => c.id !== created.id)])
          setSelectedConversationId(created.id)
          setError(null)
        }
        return created
      } catch (err) {
        const sanitized = sanitizeConversationError(err)
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
    [botId, getEffectiveApi]
  )

  const renameConversation = useCallback(
    async (conversationId: string, title: string): Promise<ConversationDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const request: RenameConversationIpcRequest = { conversationId, title }
        const updated = await api.renameConversation(request)

        if (mountedRef.current) {
          setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
          setError(null)
        }
        return updated
      } catch (err) {
        const sanitized = sanitizeConversationError(err)
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

  const deleteConversation = useCallback(
    async (conversationId: string): Promise<DeleteConversationResultDto> => {
      setIsMutating(true)
      try {
        const api = getEffectiveApi()
        const request: DeleteConversationIpcRequest = { conversationId }
        const result = await api.deleteConversation(request)

        if (mountedRef.current) {
          setConversations((prev) => prev.filter((c) => c.id !== conversationId))
          setSelectedConversationId((prevSelected) =>
            prevSelected === conversationId ? null : prevSelected
          )
          setError(null)
        }
        return result
      } catch (err) {
        const sanitized = sanitizeConversationError(err)
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

  const selectedConversation = useMemo((): ConversationDto | null => {
    if (!selectedConversationId) {
      return null
    }
    return conversations.find((c) => c.id === selectedConversationId) ?? null
  }, [conversations, selectedConversationId])

  return {
    conversations,
    selectedConversationId,
    selectedConversation,
    isLoading,
    isRefreshing,
    isMutating,
    error,
    refresh,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    clearError
  }
}
