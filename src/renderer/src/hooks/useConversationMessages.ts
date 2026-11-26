import { useState, useEffect, useCallback, useRef } from 'react'
import {
  type MessageDto,
  type ConversationSegmentDto,
  type ListMessagesRequest,
  type ConversationApi,
  ConversationBridgeError,
  orderMessagesRespectingSegments
} from '../../../shared/conversations'

export interface UseConversationMessagesOptions {
  readonly conversationId?: string | null
  readonly segments?: readonly ConversationSegmentDto[]
  readonly enabled?: boolean
  readonly api?: ConversationApi
}

export interface UseConversationMessagesState {
  readonly messages: readonly MessageDto[]
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly appendMessage: (message: MessageDto) => void
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
 * Custom React hook managing message history and citations for a specific Conversation.
 * Strictly communicates via window.api.conversation / window.api.conversations.
 * Preserves authentic citation metadata from SQLite and maintains segment-first chronological order.
 */
export function useConversationMessages(
  options?: UseConversationMessagesOptions
): UseConversationMessagesState {
  const conversationId = options?.conversationId
  const segments = options?.segments
  const enabled = options?.enabled ?? true
  const apiOption = options?.api

  const [messages, setMessages] = useState<readonly MessageDto[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(conversationId && enabled))
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track conversationId changes to reset state immediately
  const [prevConversationId, setPrevConversationId] = useState<string | null | undefined>(
    conversationId
  )
  if (conversationId !== prevConversationId) {
    setPrevConversationId(conversationId)
    setMessages([])
    setIsLoading(Boolean(conversationId && enabled))
    setError(null)
  }

  const mountedRef = useRef<boolean>(true)
  const requestIdRef = useRef<number>(0)
  const segmentsRef = useRef<readonly ConversationSegmentDto[]>(segments ?? [])

  useEffect(() => {
    segmentsRef.current = segments ?? []
  }, [segments])

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

  // Initial and reactive fetch when conversationId changes
  useEffect(() => {
    if (!enabled || !conversationId) {
      return
    }

    let isCurrent = true
    const currentReq = ++requestIdRef.current

    const fetchMessages = async (): Promise<void> => {
      try {
        const api = getEffectiveApi()
        const request: ListMessagesRequest = { conversationId }
        const data = await api.listMessages(request)

        if (isCurrent && mountedRef.current && currentReq === requestIdRef.current) {
          setMessages(orderMessagesRespectingSegments(data, segmentsRef.current))
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

    void fetchMessages()

    return () => {
      isCurrent = false
    }
  }, [conversationId, enabled, getEffectiveApi])

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !conversationId) {
      return
    }

    const currentReq = ++requestIdRef.current
    setIsRefreshing(true)
    setError(null)

    try {
      const api = getEffectiveApi()
      const request: ListMessagesRequest = { conversationId }
      const data = await api.listMessages(request)

      if (mountedRef.current && currentReq === requestIdRef.current) {
        setMessages(orderMessagesRespectingSegments(data, segmentsRef.current))
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
  }, [conversationId, enabled, getEffectiveApi])

  const appendMessage = useCallback((message: MessageDto): void => {
    if (!mountedRef.current) {
      return
    }
    setMessages((prev) => orderMessagesRespectingSegments([...prev, message], segmentsRef.current))
  }, [])

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  return {
    messages,
    isLoading,
    isRefreshing,
    error,
    refresh,
    appendMessage,
    clearError
  }
}
