import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  MessageContentFormat,
  SendMessageRequest,
  ConversationTurnResultDto,
  PublicConversationTurnEvent,
  ConversationApi
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

export interface TurnError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface UseConversationTurnOptions {
  readonly conversationId?: string | null
  readonly api?: ConversationApi
  readonly onFinish?: (result: ConversationTurnResultDto) => void
  readonly onError?: (error: TurnError) => void
}

export interface UseConversationTurnState {
  readonly isGenerating: boolean
  readonly isCancelling: boolean
  readonly streamingText: string
  readonly activeRequestId: string | null
  readonly finishResult: ConversationTurnResultDto | null
  readonly error: TurnError | null
  readonly sendMessage: (
    content: string,
    options?: { contentFormat?: MessageContentFormat }
  ) => Promise<ConversationTurnResultDto>
  readonly retryLastUserMessage: (options?: {
    messageId?: string
  }) => Promise<ConversationTurnResultDto>
  readonly cancelGeneration: () => Promise<void>
  readonly resetTurn: () => void
  readonly clearError: () => void
}

function sanitizeConversationError(err: unknown): TurnError {
  let code = 'GENERATION_ERROR'
  let retryable = false

  if (err instanceof ConversationBridgeError) {
    code = err.code
    retryable = err.retryable
  } else if (err && typeof err === 'object') {
    if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
      code = (err as { code: string }).code
    }
    if ('retryable' in err && typeof (err as { retryable: unknown }).retryable === 'boolean') {
      retryable = (err as { retryable: boolean }).retryable
    }
  }

  const rawMsg =
    err instanceof ConversationBridgeError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
  const sanitizedMsg = rawMsg
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)(?:\/[a-zA-Z0-9_.-]+){2,}/g, ' [REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )

  return {
    code,
    message: sanitizedMsg,
    retryable
  }
}

/**
 * Generates an RFC 4122 UUIDv4 string.
 */
function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Custom React hook managing streaming generation turns for Bot conversations.
 * Directly wraps typed Preload API without exposing IPC or MessagePort primitives.
 * Enforces single active-turn invariant, incremental text accumulation, and deterministic cleanup.
 */
export function useConversationTurn(
  options?: UseConversationTurnOptions
): UseConversationTurnState {
  const conversationId = options?.conversationId
  const apiOption = options?.api
  const onFinishOption = options?.onFinish
  const onErrorOption = options?.onError

  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [isCancelling, setIsCancelling] = useState<boolean>(false)
  const [streamingText, setStreamingText] = useState<string>('')
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [finishResult, setFinishResult] = useState<ConversationTurnResultDto | null>(null)
  const [error, setError] = useState<TurnError | null>(null)

  const mountedRef = useRef<boolean>(true)
  const activeRequestIdRef = useRef<string | null>(null)
  const isGeneratingRef = useRef<boolean>(false)

  const onFinishRef = useRef(onFinishOption)
  const onErrorRef = useRef(onErrorOption)

  useEffect(() => {
    onFinishRef.current = onFinishOption
  }, [onFinishOption])

  useEffect(() => {
    onErrorRef.current = onErrorOption
  }, [onErrorOption])

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

  // Track conversation switching: reset streaming state if conversation changes
  const prevConvIdRef = useRef<string | null | undefined>(conversationId)
  useEffect(() => {
    if (conversationId !== prevConvIdRef.current) {
      prevConvIdRef.current = conversationId
      // If active generation belongs to another conversation, clear local active state
      activeRequestIdRef.current = null
      isGeneratingRef.current = false
      setIsGenerating(false)
      setIsCancelling(false)
      setStreamingText('')
      setActiveRequestId(null)
      setError(null)
      setFinishResult(null)
    }
  }, [conversationId])

  // Component unmount cleanup
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const currentReqId = activeRequestIdRef.current
      if (currentReqId && isGeneratingRef.current) {
        try {
          const api = getEffectiveApi()
          void api.cancelGeneration(currentReqId).catch(() => {})
        } catch {
          // Ignore cancellation failures on unmount
        }
      }
    }
  }, [getEffectiveApi])

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  const resetTurn = useCallback((): void => {
    setStreamingText('')
    setFinishResult(null)
    setError(null)
    setActiveRequestId(null)
    activeRequestIdRef.current = null
    isGeneratingRef.current = false
    setIsGenerating(false)
    setIsCancelling(false)
  }, [])

  const sendMessage = useCallback(
    async (
      content: string,
      turnOptions?: { contentFormat?: MessageContentFormat }
    ): Promise<ConversationTurnResultDto> => {
      if (!conversationId) {
        const err = new ConversationBridgeError(
          'Cannot send message without an active conversation',
          'NO_CONVERSATION'
        )
        const turnError = sanitizeConversationError(err)
        setError(turnError)
        onErrorRef.current?.(turnError)
        throw err
      }

      if (isGeneratingRef.current) {
        const err = new ConversationBridgeError(
          'Generation already in progress for this conversation',
          'CONCURRENT_TURN_ACTIVE',
          true
        )
        const turnError = sanitizeConversationError(err)
        setError(turnError)
        onErrorRef.current?.(turnError)
        throw err
      }

      const trimmed = content.trim()
      if (!trimmed) {
        const err = new ConversationBridgeError('Message content cannot be blank', 'INVALID_INPUT')
        const turnError = sanitizeConversationError(err)
        setError(turnError)
        onErrorRef.current?.(turnError)
        throw err
      }

      const requestId = generateUuid()
      activeRequestIdRef.current = requestId
      isGeneratingRef.current = true

      setIsGenerating(true)
      setIsCancelling(false)
      setStreamingText('')
      setActiveRequestId(requestId)
      setError(null)
      setFinishResult(null)

      const handleEvent = (event: PublicConversationTurnEvent): void => {
        // Discard stale events from old requests or after unmount
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) {
          return
        }

        if (event.type === 'text_delta') {
          setStreamingText((prev) => prev + event.textDelta)
        } else if (event.type === 'error') {
          const turnError: TurnError = {
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable
          }
          setError(turnError)
          setIsGenerating(false)
          isGeneratingRef.current = false
          onErrorRef.current?.(turnError)
        }
      }

      try {
        const api = getEffectiveApi()
        const request: SendMessageRequest & { requestId: string } = {
          conversationId,
          content: trimmed,
          contentFormat: turnOptions?.contentFormat ?? 'markdown',
          requestId
        }

        const result = await api.sendMessage(request, handleEvent)

        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setFinishResult(result)
          setIsGenerating(false)
          isGeneratingRef.current = false
          setStreamingText('')
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onFinishRef.current?.(result)
        }

        return result
      } catch (err) {
        const turnError = sanitizeConversationError(err)
        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setError(turnError)
          setIsGenerating(false)
          isGeneratingRef.current = false
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onErrorRef.current?.(turnError)
        }
        throw err
      }
    },
    [conversationId, getEffectiveApi]
  )

  const retryLastUserMessage = useCallback(
    async (retryOptions?: { messageId?: string }): Promise<ConversationTurnResultDto> => {
      if (!conversationId) {
        const err = new ConversationBridgeError(
          'Cannot retry without an active conversation',
          'NO_CONVERSATION'
        )
        const turnError = sanitizeConversationError(err)
        setError(turnError)
        onErrorRef.current?.(turnError)
        throw err
      }

      if (isGeneratingRef.current) {
        const err = new ConversationBridgeError(
          'Generation already in progress for this conversation',
          'CONCURRENT_TURN_ACTIVE',
          true
        )
        const turnError = sanitizeConversationError(err)
        setError(turnError)
        onErrorRef.current?.(turnError)
        throw err
      }

      const requestId = generateUuid()
      activeRequestIdRef.current = requestId
      isGeneratingRef.current = true

      setIsGenerating(true)
      setIsCancelling(false)
      setStreamingText('')
      setActiveRequestId(requestId)
      setError(null)
      setFinishResult(null)

      const handleEvent = (event: PublicConversationTurnEvent): void => {
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) {
          return
        }

        if (event.type === 'text_delta') {
          setStreamingText((prev) => prev + event.textDelta)
        } else if (event.type === 'error') {
          const turnError: TurnError = {
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable
          }
          setError(turnError)
          setIsGenerating(false)
          isGeneratingRef.current = false
          onErrorRef.current?.(turnError)
        }
      }

      try {
        const api = getEffectiveApi()
        const request = {
          conversationId,
          messageId: retryOptions?.messageId,
          requestId
        }

        const result = await api.retryLastUserMessage(request, handleEvent)

        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setFinishResult(result)
          setIsGenerating(false)
          isGeneratingRef.current = false
          setStreamingText('')
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onFinishRef.current?.(result)
        }

        return result
      } catch (err) {
        const turnError = sanitizeConversationError(err)
        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setError(turnError)
          setIsGenerating(false)
          isGeneratingRef.current = false
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onErrorRef.current?.(turnError)
        }
        throw err
      }
    },
    [conversationId, getEffectiveApi]
  )

  const cancelGeneration = useCallback(async (): Promise<void> => {
    const currentReqId = activeRequestIdRef.current
    if (!currentReqId || !isGeneratingRef.current) {
      return
    }

    setIsCancelling(true)

    try {
      const api = getEffectiveApi()
      await api.cancelGeneration(currentReqId)
    } finally {
      if (mountedRef.current) {
        setIsGenerating(false)
        setIsCancelling(false)
        isGeneratingRef.current = false
        activeRequestIdRef.current = null
        setActiveRequestId(null)
        setStreamingText('')
      }
    }
  }, [getEffectiveApi])

  return {
    isGenerating,
    isCancelling,
    streamingText,
    activeRequestId,
    finishResult,
    error,
    sendMessage,
    retryLastUserMessage,
    cancelGeneration,
    resetTurn,
    clearError
  }
}
