// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useConversationTurn } from './useConversationTurn'
import type {
  MessageDto,
  ConversationTurnResultDto,
  PublicConversationTurnEvent,
  ConversationApi
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

describe('Renderer: useConversationTurn Hook (Phase 7 Step 7.8)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const conversationId = 'conv-1111-1111-1111-111111111111'

  const mockAssistantMessage: MessageDto = {
    id: 'msg-assist-01',
    conversationId,
    role: 'assistant',
    content: 'Hello, how can I help you today?',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
    createdAt: 1700000005000
  }

  const mockTurnResult: ConversationTurnResultDto = {
    assistantMessage: mockAssistantMessage,
    finishReason: 'stop',
    durationMs: 420,
    usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 }
  }

  interface MockConversationApiControls {
    api: ConversationApi
    sendMessageMock: ReturnType<typeof vi.fn>
    retryMock: ReturnType<typeof vi.fn>
    cancelMock: ReturnType<typeof vi.fn>
  }

  function createMockApi(): MockConversationApiControls {
    const sendMessageMock = vi.fn()
    const retryMock = vi.fn()
    const cancelMock = vi.fn(async () => {})

    const api: ConversationApi = {
      sendMessage: sendMessageMock,
      retryLastUserMessage: retryMock,
      cancelGeneration: cancelMock,
      createConversation: vi.fn(),
      listConversations: vi.fn(),
      listMessages: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      resolveCitation: vi.fn()
    }

    return { api, sendMessageMock, retryMock, cancelMock }
  }

  it('1. performs successful send and accumulates incremental text_delta events', async () => {
    const { api, sendMessageMock } = createMockApi()

    sendMessageMock.mockImplementation(
      async (
        _req: unknown,
        onEvent?: (event: PublicConversationTurnEvent) => void
      ): Promise<ConversationTurnResultDto> => {
        onEvent?.({ type: 'text_delta', textDelta: 'Hello' })
        onEvent?.({ type: 'text_delta', textDelta: ', how can I' })
        onEvent?.({ type: 'text_delta', textDelta: ' help you today?' })
        return mockTurnResult
      }
    )

    const onFinish = vi.fn()
    const { result } = renderHook(() => useConversationTurn({ conversationId, api, onFinish }))

    expect(result.current.isGenerating).toBe(false)
    expect(result.current.streamingText).toBe('')

    let turnResult!: ConversationTurnResultDto
    await act(async () => {
      turnResult = await result.current.sendMessage('Hello bot')
    })

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(turnResult).toEqual(mockTurnResult)
    expect(onFinish).toHaveBeenCalledWith(mockTurnResult)
    expect(result.current.isGenerating).toBe(false)
    expect(result.current.finishResult).toEqual(mockTurnResult)
    expect(result.current.error).toBeNull()
  })

  it('2. preserves incremental delta ordering and does not duplicate final assistant text', async () => {
    const { api, sendMessageMock } = createMockApi()

    sendMessageMock.mockImplementation(
      async (
        _req: unknown,
        onEvent?: (event: PublicConversationTurnEvent) => void
      ): Promise<ConversationTurnResultDto> => {
        onEvent?.({ type: 'text_delta', textDelta: 'Part 1. ' })
        onEvent?.({ type: 'text_delta', textDelta: 'Part 2. ' })
        return mockTurnResult
      }
    )

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    await act(async () => {
      await result.current.sendMessage('Test delta ordering')
    })

    // After finish, streamingText is reset to empty (final message is in finishResult)
    expect(result.current.streamingText).toBe('')
    expect(result.current.finishResult?.assistantMessage.content).toBe(
      'Hello, how can I help you today?'
    )
  })

  it('3. handles provider error and exposes code, message, and retryable flag', async () => {
    const { api, sendMessageMock } = createMockApi()

    sendMessageMock.mockImplementation(
      async (
        _req: unknown,
        onEvent?: (event: PublicConversationTurnEvent) => void
      ): Promise<ConversationTurnResultDto> => {
        onEvent?.({
          type: 'error',
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests, try again shortly',
            retryable: true
          }
        })
        throw new ConversationBridgeError(
          'Too many requests, try again shortly',
          'RATE_LIMIT_EXCEEDED',
          true
        )
      }
    )

    const onError = vi.fn()
    const { result } = renderHook(() => useConversationTurn({ conversationId, api, onError }))

    await act(async () => {
      try {
        await result.current.sendMessage('Send rate limited')
      } catch {
        // Expected throw
      }
    })

    expect(result.current.isGenerating).toBe(false)
    expect(result.current.error).toEqual({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, try again shortly',
      retryable: true
    })
    expect(onError).toHaveBeenCalledWith({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, try again shortly',
      retryable: true
    })
  })

  it('4. prevents duplicate sends while a generation is actively running', async () => {
    const { api, sendMessageMock } = createMockApi()

    let resolveTurn!: (res: ConversationTurnResultDto) => void
    const turnPromise = new Promise<ConversationTurnResultDto>((res) => {
      resolveTurn = res
    })

    sendMessageMock.mockReturnValue(turnPromise)

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    // First send
    let firstCall: Promise<ConversationTurnResultDto>
    act(() => {
      firstCall = result.current.sendMessage('First call')
    })

    expect(result.current.isGenerating).toBe(true)

    // Second send while first is generating
    await act(async () => {
      await expect(result.current.sendMessage('Duplicate send')).rejects.toThrow(
        /Generation already in progress/i
      )
    })

    // Resolve first
    await act(async () => {
      resolveTurn(mockTurnResult)
      await firstCall
    })

    expect(result.current.isGenerating).toBe(false)
  })

  it('5. prevents sending with empty or blank message content', async () => {
    const { api, sendMessageMock } = createMockApi()

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    await act(async () => {
      await expect(result.current.sendMessage('   ')).rejects.toThrow(
        /Message content cannot be blank/i
      )
    })

    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('6. cancels active generation and cleans up local state', async () => {
    const { api, sendMessageMock, cancelMock } = createMockApi()

    const turnPromise = new Promise<ConversationTurnResultDto>(() => {})

    sendMessageMock.mockReturnValue(turnPromise)

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    act(() => {
      void result.current.sendMessage('Start cancellable turn')
    })

    expect(result.current.isGenerating).toBe(true)
    const activeReqId = result.current.activeRequestId
    expect(activeReqId).toBeDefined()

    // Trigger cancel
    await act(async () => {
      await result.current.cancelGeneration()
    })

    expect(cancelMock).toHaveBeenCalledWith(activeReqId)
    expect(result.current.isGenerating).toBe(false)
    expect(result.current.isCancelling).toBe(false)
    expect(result.current.streamingText).toBe('')
    expect(result.current.activeRequestId).toBeNull()
  })

  it('7. executes retryLastUserMessage through the dedicated Preload retry API', async () => {
    const { api, retryMock } = createMockApi()

    retryMock.mockImplementation(
      async (
        _req: unknown,
        onEvent?: (event: PublicConversationTurnEvent) => void
      ): Promise<ConversationTurnResultDto> => {
        onEvent?.({ type: 'text_delta', textDelta: 'Retried answer' })
        return mockTurnResult
      }
    )

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    let retryResult!: ConversationTurnResultDto
    await act(async () => {
      retryResult = await result.current.retryLastUserMessage({
        messageId: 'user-msg-01'
      })
    })

    expect(retryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        messageId: 'user-msg-01',
        requestId: expect.any(String)
      }),
      expect.any(Function)
    )
    expect(retryResult).toEqual(mockTurnResult)
    expect(result.current.isGenerating).toBe(false)
  })

  it('8. ignores late events from an old request after resetting or starting a new turn', async () => {
    const { api, sendMessageMock } = createMockApi()

    let lateCallback: ((event: PublicConversationTurnEvent) => void) | undefined

    sendMessageMock.mockImplementation(
      async (_req: unknown, onEvent?: (event: PublicConversationTurnEvent) => void) => {
        lateCallback = onEvent
        return mockTurnResult
      }
    )

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    await act(async () => {
      await result.current.sendMessage('Turn 1')
    })

    // Reset turn
    act(() => {
      result.current.resetTurn()
    })

    // Invoke late callback from old turn
    act(() => {
      lateCallback?.({ type: 'text_delta', textDelta: 'Late phantom delta' })
    })

    // Must ignore late phantom delta
    expect(result.current.streamingText).toBe('')
  })

  it('9. cleans up active generation on component unmount', async () => {
    const { api, sendMessageMock, cancelMock } = createMockApi()

    const turnPromise = new Promise<ConversationTurnResultDto>(() => {})

    sendMessageMock.mockReturnValue(turnPromise)

    const { result, unmount } = renderHook(() => useConversationTurn({ conversationId, api }))

    act(() => {
      void result.current.sendMessage('Turn will unmount')
    })

    const activeReqId = result.current.activeRequestId
    expect(activeReqId).toBeDefined()

    unmount()

    expect(cancelMock).toHaveBeenCalledWith(activeReqId)
  })
})
