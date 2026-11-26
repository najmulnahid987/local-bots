// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useConversationMessages } from './useConversationMessages'
import type {
  MessageDto,
  ConversationApi,
  ListMessagesRequest
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

describe('Renderer: useConversationMessages Hook (Phase 7 Step 7.8)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const conversationId = 'conv-1111-1111-1111-111111111111'

  const userMsg: MessageDto = {
    id: 'msg-1111-1111-1111-111111111111',
    conversationId,
    role: 'user',
    content: 'What are the termination clauses in the contract?',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000000000
  }

  const assistantMsg: MessageDto = {
    id: 'msg-2222-2222-2222-222222222222',
    conversationId,
    role: 'assistant',
    content: 'According to Section 9.2 [1], either party may terminate upon 30 days notice.',
    contentFormat: 'markdown',
    metadata: {
      citations: [
        {
          citationNumber: 1,
          sourceId: 'src-0000-0000-0000-000000000001',
          chunkId: 'chk-0000-0000-0000-000000000001',
          fileName: 'service_agreement.pdf',
          fileType: 'pdf',
          pageNumber: 14,
          headingPath: ['Termination', 'Notice Period'],
          chunkIndex: 3
        }
      ]
    },
    tokenUsage: {
      promptTokens: 450,
      completionTokens: 85,
      totalTokens: 535
    },
    createdAt: 1700000005000
  }

  interface MockConversationApiControls {
    api: ConversationApi
    listMessagesMock: ReturnType<typeof vi.fn>
  }

  function createMockApi(initialMessages: MessageDto[] = []): MockConversationApiControls {
    const currentMessages = [...initialMessages]

    const listMessagesMock = vi.fn(async (req: ListMessagesRequest | string) => {
      const convId = typeof req === 'string' ? req : req.conversationId
      return currentMessages.filter((m) => m.conversationId === convId)
    })

    const api: ConversationApi = {
      getConversationForBot: vi.fn(),
      getSegments: vi.fn(),
      getClearPreview: vi.fn(),
      clearConversation: vi.fn(),
      listMessages: listMessagesMock,
      listConversations: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      sendMessage: vi.fn(),
      retryLastUserMessage: vi.fn(),
      cancelGeneration: vi.fn(),
      resolveCitation: vi.fn()
    }

    return { api, listMessagesMock }
  }

  it('1. performs initial message loading and preserves chronological order', async () => {
    // Deliver out of order to verify chronological sorting
    const { api } = createMockApi([assistantMsg, userMsg])

    const { result } = renderHook(() => useConversationMessages({ conversationId, api }))

    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.messages).toHaveLength(2)
    // First message must be userMsg (createdAt: 1700000000000)
    expect(result.current.messages[0].id).toBe(userMsg.id)
    // Second message must be assistantMsg (createdAt: 1700000005000)
    expect(result.current.messages[1].id).toBe(assistantMsg.id)
    expect(result.current.error).toBeNull()
  })

  it('2. preserves authentic citation metadata on loaded assistant message', async () => {
    const { api } = createMockApi([userMsg, assistantMsg])

    const { result } = renderHook(() => useConversationMessages({ conversationId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    const assistant = result.current.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant?.metadata.citations).toHaveLength(1)
    expect(assistant?.metadata.citations?.[0].citationNumber).toBe(1)
    expect(assistant?.metadata.citations?.[0].fileName).toBe('service_agreement.pdf')
    expect(assistant?.metadata.citations?.[0].pageNumber).toBe(14)
  })

  it('3. handles failed message loading with sanitized error', async () => {
    const { api, listMessagesMock } = createMockApi()
    listMessagesMock.mockRejectedValueOnce(
      new ConversationBridgeError(
        'Access denied for conversation on D:\\vault\\workspace.db',
        'ACCESS_DENIED'
      )
    )

    const { result } = renderHook(() => useConversationMessages({ conversationId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBe('Access denied for conversation on [REDACTED_PATH]')
  })

  it('4. supports manual refresh of messages', async () => {
    const { api, listMessagesMock } = createMockApi([userMsg])

    const { result } = renderHook(() => useConversationMessages({ conversationId, api }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.messages).toHaveLength(1)

    // Backend received the assistant message
    listMessagesMock.mockResolvedValueOnce([userMsg, assistantMsg])

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.messages).toHaveLength(2)
  })

  it('5. appends message without creating duplicates', async () => {
    const { api } = createMockApi([userMsg])

    const { result } = renderHook(() => useConversationMessages({ conversationId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.messages).toHaveLength(1)

    // Append new assistant message
    act(() => {
      result.current.appendMessage(assistantMsg)
    })
    expect(result.current.messages).toHaveLength(2)

    // Appending same assistant message again should not duplicate
    act(() => {
      result.current.appendMessage(assistantMsg)
    })
    expect(result.current.messages).toHaveLength(2)
  })

  it('6. clears messages when conversationId changes', async () => {
    const { api } = createMockApi([userMsg, assistantMsg])

    let currentConvId: string | null = conversationId
    const { result, rerender } = renderHook(() =>
      useConversationMessages({ conversationId: currentConvId, api })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.messages).toHaveLength(2)

    // Switch conversation
    currentConvId = 'conv-2222-2222-2222-222222222222'
    rerender()

    expect(result.current.messages).toEqual([])
    expect(result.current.isLoading).toBe(true)
  })

  it('7. prevents stale asynchronous responses from overwriting current conversation state', async () => {
    const { api, listMessagesMock } = createMockApi()

    let resolveFirst!: (value: MessageDto[]) => void
    const firstPromise = new Promise<MessageDto[]>((res) => {
      resolveFirst = res
    })

    let resolveSecond!: (value: MessageDto[]) => void
    const secondPromise = new Promise<MessageDto[]>((res) => {
      resolveSecond = res
    })

    listMessagesMock.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise)

    let currentConvId = 'conv-first'
    const { result, rerender } = renderHook(() =>
      useConversationMessages({ conversationId: currentConvId, api })
    )

    // Switch conversation before first finishes
    currentConvId = 'conv-second'
    rerender()

    const convSecondMsg: MessageDto = {
      ...userMsg,
      id: 'msg-second',
      conversationId: 'conv-second'
    }

    // Resolve second request first
    await act(async () => {
      resolveSecond([convSecondMsg])
      await secondPromise
    })
    expect(result.current.messages).toEqual([convSecondMsg])

    // Later resolve first request
    await act(async () => {
      resolveFirst([userMsg])
      await firstPromise
    })
    // Must still contain conv-second message
    expect(result.current.messages).toEqual([convSecondMsg])
  })

  it('8. safely handles component unmount', async () => {
    let resolveSlow!: (value: MessageDto[]) => void
    const slowPromise = new Promise<MessageDto[]>((res) => {
      resolveSlow = res
    })

    const { api, listMessagesMock } = createMockApi()
    listMessagesMock.mockReturnValueOnce(slowPromise)

    const { unmount } = renderHook(() => useConversationMessages({ conversationId, api }))

    unmount()

    await act(async () => {
      resolveSlow([userMsg])
      await slowPromise
    })
    // No error or warning on unmount
  })

  it('9. preserves historical segment order without interleaving overlapping timestamps', async () => {
    const seg0Msg: MessageDto = {
      ...userMsg,
      id: 'msg-seg0',
      segmentId: 'seg-0',
      createdAt: 1700000090000
    }
    const seg1Msg: MessageDto = {
      ...assistantMsg,
      id: 'msg-seg1',
      segmentId: 'seg-1',
      createdAt: 1700000010000
    }
    const { api } = createMockApi([seg1Msg, seg0Msg])

    const segments = [
      {
        id: 'seg-0',
        conversationId,
        originalConversationId: conversationId,
        title: 'First Historical Thread',
        segmentOrder: 0,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000000000,
        archivedAt: null,
        messageCount: 1
      },
      {
        id: 'seg-1',
        conversationId,
        originalConversationId: conversationId,
        title: 'Second Historical Thread',
        segmentOrder: 1,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000005000,
        archivedAt: null,
        messageCount: 1
      }
    ]

    const { result } = renderHook(() => useConversationMessages({ conversationId, segments, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-seg0', 'msg-seg1'])
  })
})
