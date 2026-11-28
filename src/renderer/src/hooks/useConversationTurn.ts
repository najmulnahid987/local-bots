import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  MessageContentFormat,
  SendMessageRequest,
  ConversationTurnResultDto,
  PublicConversationTurnEvent,
  ConversationApi,
  StreamLifecycleStage,
  MessageDto
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

export interface TurnError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly partialMessage?: MessageDto
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
  readonly stage: StreamLifecycleStage
  readonly streamingText: string
  readonly firstVisibleTextMs: number | null
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
  let partialMessage: MessageDto | undefined

  if (err instanceof ConversationBridgeError) {
    code = err.code
    retryable = err.retryable
    if ('partialMessage' in err && err.partialMessage) {
      partialMessage = err.partialMessage as MessageDto
    }
  } else if (err && typeof err === 'object') {
    if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
      code = (err as { code: string }).code
    }
    if ('retryable' in err && typeof (err as { retryable: unknown }).retryable === 'boolean') {
      retryable = (err as { retryable: boolean }).retryable
    }
    if ('partialMessage' in err && (err as { partialMessage: unknown }).partialMessage) {
      partialMessage = (err as { partialMessage: MessageDto }).partialMessage
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
    .replace(
      /(sk-or-v1-|sk-or-|sk-proj-|sk-ant-|AIzaSy|gsk_|pplx-|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi,
      '[REDACTED_KEY]'
    )
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )

  return {
    code,
    message: sanitizedMsg,
    retryable,
    ...(partialMessage ? { partialMessage } : {})
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
  const [stage, setStage] = useState<StreamLifecycleStage>('idle')
  const [streamingText, setStreamingText] = useState<string>('')
  const [firstVisibleTextMs, setFirstVisibleTextMs] = useState<number | null>(null)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [finishResult, setFinishResult] = useState<ConversationTurnResultDto | null>(null)
  const [error, setError] = useState<TurnError | null>(null)

  const mountedRef = useRef<boolean>(true)
  const activeRequestIdRef = useRef<string | null>(null)
  const isGeneratingRef = useRef<boolean>(false)
  const pendingDeltaRef = useRef<string>('')
  const flushRafRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnStartPerfMsRef = useRef<number>(0)
  const hasCommittedFirstVisibleRef = useRef<boolean>(false)

  const onFinishRef = useRef(onFinishOption)
  const onErrorRef = useRef(onErrorOption)

  useEffect(() => {
    onFinishRef.current = onFinishOption
  }, [onFinishOption])

  useEffect(() => {
    onErrorRef.current = onErrorOption
  }, [onErrorOption])

  const cancelScheduledFlush = useCallback((): void => {
    if (flushRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(flushRafRef.current)
      flushRafRef.current = null
    }
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  const flushBufferedDelta = useCallback(
    (expectedRequestId: string): void => {
      cancelScheduledFlush()
      if (!mountedRef.current || activeRequestIdRef.current !== expectedRequestId) {
        pendingDeltaRef.current = ''
        return
      }
      const chunk = pendingDeltaRef.current
      if (!chunk) {
        return
      }
      pendingDeltaRef.current = ''
      if (!hasCommittedFirstVisibleRef.current) {
        hasCommittedFirstVisibleRef.current = true
        setFirstVisibleTextMs(
          Math.max(0, Math.round(performance.now() - turnStartPerfMsRef.current))
        )
      }
      setStreamingText((prev) => prev + chunk)
    },
    [cancelScheduledFlush]
  )

  const scheduleDeltaFlush = useCallback(
    (expectedRequestId: string): void => {
      if (!hasCommittedFirstVisibleRef.current) {
        // Commit first non-empty text token immediately for zero UI TTFT overhead
        flushBufferedDelta(expectedRequestId)
        return
      }
      if (flushRafRef.current !== null || flushTimerRef.current !== null) {
        return
      }
      if (typeof requestAnimationFrame === 'function') {
        flushRafRef.current = requestAnimationFrame(() => {
          flushRafRef.current = null
          flushBufferedDelta(expectedRequestId)
        })
      } else {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null
          flushBufferedDelta(expectedRequestId)
        }, 16)
      }
    },
    [flushBufferedDelta]
  )

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
      cancelScheduledFlush()
      pendingDeltaRef.current = ''
      hasCommittedFirstVisibleRef.current = false
      activeRequestIdRef.current = null
      isGeneratingRef.current = false
      setIsGenerating(false)
      setIsCancelling(false)
      setStage('idle')
      setStreamingText('')
      setFirstVisibleTextMs(null)
      setActiveRequestId(null)
      setError(null)
      setFinishResult(null)
    }
  }, [conversationId, cancelScheduledFlush])

  // Component unmount cleanup
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelScheduledFlush()
      pendingDeltaRef.current = ''
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
  }, [getEffectiveApi, cancelScheduledFlush])

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  const resetTurn = useCallback((): void => {
    cancelScheduledFlush()
    pendingDeltaRef.current = ''
    hasCommittedFirstVisibleRef.current = false
    setStreamingText('')
    setFirstVisibleTextMs(null)
    setFinishResult(null)
    setError(null)
    setActiveRequestId(null)
    activeRequestIdRef.current = null
    isGeneratingRef.current = false
    setIsGenerating(false)
    setIsCancelling(false)
    setStage('idle')
  }, [cancelScheduledFlush])

  const createStreamEventHandler = useCallback(
    (requestId: string) =>
      (event: PublicConversationTurnEvent): void => {
        // Discard stale events from old requests or after unmount
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) {
          return
        }

        if (event.type === 'stage_change') {
          setStage(event.stage)
        } else if (event.type === 'text_delta') {
          setStage('streaming')
          if (event.textDelta.length > 0) {
            pendingDeltaRef.current += event.textDelta
            scheduleDeltaFlush(requestId)
          }
        } else if (event.type === 'finish') {
          cancelScheduledFlush()
          pendingDeltaRef.current = ''
          setStage('completed')
        } else if (event.type === 'error') {
          cancelScheduledFlush()
          pendingDeltaRef.current = ''
          const isCancelled = event.error.code === 'OPERATION_ABORTED'
          setStage(isCancelled ? 'cancelled' : 'failed')
          const turnError: TurnError = {
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable,
            partialMessage: event.partialMessage
          }
          setError(turnError)
          setIsGenerating(false)
          isGeneratingRef.current = false
          onErrorRef.current?.(turnError)
        }
      },
    [cancelScheduledFlush, scheduleDeltaFlush]
  )

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
      cancelScheduledFlush()
      pendingDeltaRef.current = ''
      hasCommittedFirstVisibleRef.current = false
      turnStartPerfMsRef.current = performance.now()

      setIsGenerating(true)
      setIsCancelling(false)
      setStage('preparing')
      setStreamingText('')
      setFirstVisibleTextMs(null)
      setActiveRequestId(requestId)
      setError(null)
      setFinishResult(null)

      const handleEvent = createStreamEventHandler(requestId)

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
          cancelScheduledFlush()
          pendingDeltaRef.current = ''
          setFinishResult(result)
          setStage('completed')
          setIsGenerating(false)
          isGeneratingRef.current = false
          setStreamingText('')
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onFinishRef.current?.(result)
        }

        return result
      } catch (err) {
        cancelScheduledFlush()
        pendingDeltaRef.current = ''
        const turnError = sanitizeConversationError(err)
        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setStage(turnError.code === 'OPERATION_ABORTED' ? 'cancelled' : 'failed')
          setError((prev) => ({
            ...turnError,
            partialMessage: turnError.partialMessage ?? prev?.partialMessage
          }))
          setIsGenerating(false)
          isGeneratingRef.current = false
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onErrorRef.current?.(turnError)
        }
        throw err
      }
    },
    [conversationId, getEffectiveApi, cancelScheduledFlush, createStreamEventHandler]
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
      cancelScheduledFlush()
      pendingDeltaRef.current = ''
      hasCommittedFirstVisibleRef.current = false
      turnStartPerfMsRef.current = performance.now()

      setIsGenerating(true)
      setIsCancelling(false)
      setStage('preparing')
      setStreamingText('')
      setFirstVisibleTextMs(null)
      setActiveRequestId(requestId)
      setError(null)
      setFinishResult(null)

      const handleEvent = createStreamEventHandler(requestId)

      try {
        const api = getEffectiveApi()
        const request = {
          conversationId,
          messageId: retryOptions?.messageId,
          requestId
        }

        const result = await api.retryLastUserMessage(request, handleEvent)

        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          cancelScheduledFlush()
          pendingDeltaRef.current = ''
          setFinishResult(result)
          setStage('completed')
          setIsGenerating(false)
          isGeneratingRef.current = false
          setStreamingText('')
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onFinishRef.current?.(result)
        }

        return result
      } catch (err) {
        cancelScheduledFlush()
        pendingDeltaRef.current = ''
        const turnError = sanitizeConversationError(err)
        if (mountedRef.current && activeRequestIdRef.current === requestId) {
          setStage(turnError.code === 'OPERATION_ABORTED' ? 'cancelled' : 'failed')
          setError((prev) => ({
            ...turnError,
            partialMessage: turnError.partialMessage ?? prev?.partialMessage
          }))
          setIsGenerating(false)
          isGeneratingRef.current = false
          activeRequestIdRef.current = null
          setActiveRequestId(null)
          onErrorRef.current?.(turnError)
        }
        throw err
      }
    },
    [conversationId, getEffectiveApi, cancelScheduledFlush, createStreamEventHandler]
  )

  const cancelGeneration = useCallback(async (): Promise<void> => {
    const currentReqId = activeRequestIdRef.current
    if (!currentReqId || !isGeneratingRef.current) {
      return
    }

    cancelScheduledFlush()
    pendingDeltaRef.current = ''
    setIsCancelling(true)

    try {
      const api = getEffectiveApi()
      await api.cancelGeneration(currentReqId)
    } finally {
      if (mountedRef.current) {
        cancelScheduledFlush()
        pendingDeltaRef.current = ''
        setStage('cancelled')
        setIsGenerating(false)
        setIsCancelling(false)
        isGeneratingRef.current = false
        activeRequestIdRef.current = null
        setActiveRequestId(null)
        setStreamingText('')
      }
    }
  }, [getEffectiveApi, cancelScheduledFlush])

  return {
    isGenerating,
    isCancelling,
    stage,
    streamingText,
    firstVisibleTextMs,
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
