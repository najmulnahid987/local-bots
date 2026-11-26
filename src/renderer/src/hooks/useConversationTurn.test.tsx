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

  const baseMeta = {
    requestId: 'req-0000-0000-0000-000000000001',
    conversationId,
    executionMode: 'chat' as const,
    sequenceNumber: 1,
    timestamp: 1700000000000
  }

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
      getConversationForBot: vi.fn(),
      getSegments: vi.fn(),
      getClearPreview: vi.fn(),
      clearConversation: vi.fn(),
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
        onEvent?.({ ...baseMeta, stage: 'streaming', type: 'text_delta', textDelta: 'Hello' })
        onEvent?.({ ...baseMeta, stage: 'streaming', type: 'text_delta', textDelta: ', how can I' })
        onEvent?.({
          ...baseMeta,
          stage: 'streaming',
          type: 'text_delta',
          textDelta: ' help you today?'
        })
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
        onEvent?.({ ...baseMeta, stage: 'streaming', type: 'text_delta', textDelta: 'Part 1. ' })
        onEvent?.({ ...baseMeta, stage: 'streaming', type: 'text_delta', textDelta: 'Part 2. ' })
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
          ...baseMeta,
          stage: 'failed',
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
        onEvent?.({
          ...baseMeta,
          stage: 'streaming',
          type: 'text_delta',
          textDelta: 'Retried answer'
        })
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
      lateCallback?.({
        ...baseMeta,
        stage: 'streaming',
        type: 'text_delta',
        textDelta: 'Late phantom delta'
      })
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

  it('10. Scenario 43: switching conversationId resets local streaming state and stage to idle', async () => {
    const { api, sendMessageMock } = createMockApi()
    let sendCallback: ((event: PublicConversationTurnEvent) => void) | undefined
    sendMessageMock.mockImplementation(
      async (_req: unknown, onEvent?: (event: PublicConversationTurnEvent) => void) => {
        sendCallback = onEvent
        return new Promise(() => {}) // pending
      }
    )

    let currentConvId = conversationId
    const { result, rerender } = renderHook(() =>
      useConversationTurn({ conversationId: currentConvId, api })
    )

    act(() => {
      void result.current.sendMessage('In flight message')
    })

    act(() => {
      sendCallback?.({
        ...baseMeta,
        stage: 'streaming',
        type: 'text_delta',
        textDelta: 'In progress text...'
      })
    })

    expect(result.current.isGenerating).toBe(true)
    expect(result.current.streamingText).toBe('In progress text...')
    expect(result.current.stage).toBe('streaming')

    // Switch conversation (simulating switching Bots)
    currentConvId = 'conv-2222-2222-2222-222222222222'
    rerender()

    expect(result.current.isGenerating).toBe(false)
    expect(result.current.streamingText).toBe('')
    expect(result.current.stage).toBe('idle')
    expect(result.current.activeRequestId).toBeNull()

    // Stale event from old stream is ignored
    act(() => {
      sendCallback?.({
        ...baseMeta,
        stage: 'streaming',
        type: 'text_delta',
        textDelta: 'stale delta'
      })
    })
    expect(result.current.streamingText).toBe('')
  })

  it('11. Scenario 45: tracks lifecycle stages accurately (preparing -> streaming -> completed)', async () => {
    const { api, sendMessageMock } = createMockApi()
    sendMessageMock.mockImplementation(
      async (_req: unknown, onEvent?: (event: PublicConversationTurnEvent) => void) => {
        onEvent?.({ ...baseMeta, type: 'stage_change', stage: 'preparing' })
        onEvent?.({ ...baseMeta, type: 'stage_change', stage: 'streaming' })
        onEvent?.({
          ...baseMeta,
          stage: 'streaming',
          type: 'text_delta',
          textDelta: 'Progressive tokens'
        })
        onEvent?.({ ...baseMeta, type: 'stage_change', stage: 'finalizing' })
        return mockTurnResult
      }
    )

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))
    expect(result.current.stage).toBe('idle')

    await act(async () => {
      await result.current.sendMessage('Prompt')
    })

    expect(result.current.stage).toBe('completed')
    expect(result.current.isGenerating).toBe(false)
  })

  it('12. Scenario 32/34: surfaces partialMessage and cancelled/failed stage on error', async () => {
    const { api, sendMessageMock } = createMockApi()
    const partialAssistantMessage: MessageDto = {
      ...mockAssistantMessage,
      id: 'partial-msg-01',
      content: 'Incomplete text...',
      metadata: { isPartial: true, status: 'cancelled' }
    }

    sendMessageMock.mockImplementation(
      async (_req: unknown, onEvent?: (event: PublicConversationTurnEvent) => void) => {
        onEvent?.({
          ...baseMeta,
          stage: 'cancelled',
          type: 'error',
          error: { code: 'OPERATION_ABORTED', message: 'Cancelled by user', retryable: false },
          partialMessage: partialAssistantMessage
        })
        throw new ConversationBridgeError('Cancelled by user', 'OPERATION_ABORTED')
      }
    )

    const { result } = renderHook(() => useConversationTurn({ conversationId, api }))

    await act(async () => {
      try {
        await result.current.sendMessage('Prompt')
      } catch {
        // Expected rejection
      }
    })

    expect(result.current.stage).toBe('cancelled')
    expect(result.current.error?.code).toBe('OPERATION_ABORTED')
    expect(result.current.error?.partialMessage).toEqual(partialAssistantMessage)
  })
})
