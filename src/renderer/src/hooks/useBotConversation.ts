import { useState, useEffect, useCallback, useRef } from 'react'
import {
  type ConversationDto,
  type ConversationSegmentDto,
  type MessageDto,
  type ClearConversationResultDto,
  type ConversationApi,
  ConversationBridgeError,
  orderMessagesRespectingSegments
} from '../../../shared/conversations'

export interface UseBotConversationOptions {
  readonly botId?: string | null
  readonly enabled?: boolean
  readonly api?: ConversationApi
}

export interface UseBotConversationState {
  readonly conversation: ConversationDto | null
  readonly segments: readonly ConversationSegmentDto[]
  readonly messages: readonly MessageDto[]
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly isClearing: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly clearConversation: () => Promise<ClearConversationResultDto | null>
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
 * Custom React hook managing the single canonical persistent conversation,
 * historical segments, and ordered message timeline for a selected Bot.
 *
 * Security & Lifecycle Invariants:
 * - Strictly opens existing canonical conversations by Bot ID (never creates arbitrary conversations).
 * - Never supplies knowledgeBaseId independently (enforced by Main-process session context).
 * - Prevents stale asynchronous responses from older Bot switches overwriting active state.
 */
export function useBotConversation(options?: UseBotConversationOptions): UseBotConversationState {
  const botId = options?.botId ?? null
  const enabled = options?.enabled ?? true
  const apiOption = options?.api

  const [conversation, setConversation] = useState<ConversationDto | null>(null)
  const [segments, setSegments] = useState<readonly ConversationSegmentDto[]>([])
  const [messages, setMessages] = useState<readonly MessageDto[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(botId && enabled))
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [isClearing, setIsClearing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const [prevKey, setPrevKey] = useState<string>(`${botId ?? ''}::${String(enabled)}`)
  const currentKey = `${botId ?? ''}::${String(enabled)}`
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    setConversation(null)
    setSegments([])
    setMessages([])
    setIsLoading(Boolean(botId && enabled))
    setIsRefreshing(false)
    setIsClearing(false)
    setError(null)
  }

  const mountedRef = useRef<boolean>(true)
  const requestIdRef = useRef<number>(0)
  const activeBotIdRef = useRef<string | null>(botId)
  const activeConversationIdRef = useRef<string | null>(conversation?.id ?? null)
  const segmentsRef = useRef<readonly ConversationSegmentDto[]>(segments)

  useEffect(() => {
    activeBotIdRef.current = botId
  }, [botId])

  useEffect(() => {
    activeConversationIdRef.current = conversation?.id ?? null
  }, [conversation?.id])

  useEffect(() => {
    segmentsRef.current = segments
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

  // Fetch canonical conversation workspace when botId or enabled changes
  useEffect(() => {
    if (!enabled || !botId) {
      return
    }

    let isCurrent = true
    const currentReq = ++requestIdRef.current
    const requestedBotId = botId

    const loadBotConversation = async (): Promise<void> => {
      try {
        const api = getEffectiveApi()
        const data = await api.getConversationForBot({ botId: requestedBotId })

        if (
          !isCurrent ||
          !mountedRef.current ||
          currentReq !== requestIdRef.current ||
          activeBotIdRef.current !== requestedBotId
        ) {
          return
        }

        if (!data || !data.conversation || data.conversation.botId !== requestedBotId) {
          setConversation(null)
          setSegments([])
          setMessages([])
          setError('Canonical conversation could not be loaded for this Bot.')
          return
        }

        const orderedSegments = [...(data.segments ?? [])].sort(
          (a, b) =>
            a.segmentOrder - b.segmentOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
        )
        const orderedMessages = orderMessagesRespectingSegments(
          data.messages ?? [],
          orderedSegments
        )

        setConversation(data.conversation)
        setSegments(orderedSegments)
        setMessages(orderedMessages)
        setError(null)
      } catch (err) {
        if (
          isCurrent &&
          mountedRef.current &&
          currentReq === requestIdRef.current &&
          activeBotIdRef.current === requestedBotId
        ) {
          setConversation(null)
          setSegments([])
          setMessages([])
          setError(sanitizeConversationError(err))
        }
      } finally {
        if (
          isCurrent &&
          mountedRef.current &&
          currentReq === requestIdRef.current &&
          activeBotIdRef.current === requestedBotId
        ) {
          setIsLoading(false)
        }
      }
    }

    void loadBotConversation()

    return () => {
      isCurrent = false
    }
  }, [botId, enabled, getEffectiveApi])

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !botId) {
      return
    }

    const requestedBotId = botId
    const currentReq = ++requestIdRef.current
    setIsRefreshing(true)
    setError(null)

    try {
      const api = getEffectiveApi()
      const data = await api.getConversationForBot({ botId: requestedBotId })

      if (
        !mountedRef.current ||
        currentReq !== requestIdRef.current ||
        activeBotIdRef.current !== requestedBotId
      ) {
        return
      }

      if (!data || !data.conversation || data.conversation.botId !== requestedBotId) {
        setError('Canonical conversation could not be loaded for this Bot.')
        return
      }

      const orderedSegments = [...(data.segments ?? [])].sort(
        (a, b) =>
          a.segmentOrder - b.segmentOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      )
      const orderedMessages = orderMessagesRespectingSegments(data.messages ?? [], orderedSegments)

      setConversation(data.conversation)
      setSegments(orderedSegments)
      setMessages(orderedMessages)
      setError(null)
    } catch (err) {
      if (
        mountedRef.current &&
        currentReq === requestIdRef.current &&
        activeBotIdRef.current === requestedBotId
      ) {
        setError(sanitizeConversationError(err))
      }
    } finally {
      if (
        mountedRef.current &&
        currentReq === requestIdRef.current &&
        activeBotIdRef.current === requestedBotId
      ) {
        setIsRefreshing(false)
        setIsLoading(false)
      }
    }
  }, [botId, enabled, getEffectiveApi])

  const clearConversation = useCallback(async (): Promise<ClearConversationResultDto | null> => {
    const targetConvId = conversation?.id
    const targetBotId = botId
    if (!targetConvId || !targetBotId) {
      throw new ConversationBridgeError(
        'Cannot clear conversation without an active Bot conversation.',
        'NO_CONVERSATION'
      )
    }

    const currentReq = ++requestIdRef.current
    setIsClearing(true)

    try {
      const api = getEffectiveApi()
      const result = await api.clearConversation({ conversationId: targetConvId })

      if (
        !mountedRef.current ||
        currentReq !== requestIdRef.current ||
        activeBotIdRef.current !== targetBotId ||
        activeConversationIdRef.current !== targetConvId
      ) {
        return null
      }

      setConversation(result.conversation)
      setSegments(result.activeSegment ? [result.activeSegment] : [])
      setMessages([])
      setError(null)
      return result
    } catch (err) {
      const sanitized = sanitizeConversationError(err)
      if (
        mountedRef.current &&
        currentReq === requestIdRef.current &&
        activeBotIdRef.current === targetBotId
      ) {
        setError(sanitized)
      }
      throw err
    } finally {
      if (
        mountedRef.current &&
        currentReq === requestIdRef.current &&
        activeBotIdRef.current === targetBotId
      ) {
        setIsClearing(false)
      }
    }
  }, [botId, conversation?.id, getEffectiveApi])

  const appendMessage = useCallback((message: MessageDto): void => {
    if (!mountedRef.current || message.conversationId !== activeConversationIdRef.current) {
      return
    }
    setMessages((prev) => orderMessagesRespectingSegments([...prev, message], segmentsRef.current))
  }, [])

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  return {
    conversation,
    segments,
    messages,
    isLoading,
    isRefreshing,
    isClearing,
    error,
    refresh,
    clearConversation,
    appendMessage,
    clearError
  }
}
