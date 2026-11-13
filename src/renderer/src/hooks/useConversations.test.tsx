// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useConversations } from './useConversations'
import type {
  ConversationDto,
  CreateConversationRequest,
  RenameConversationIpcRequest,
  DeleteConversationIpcRequest,
  ConversationApi
} from '../../../shared/conversations'
import { ConversationBridgeError } from '../../../shared/conversations'

describe('Renderer: useConversations Hook (Phase 7 Step 7.8)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const botId = '11111111-1111-4111-8111-111111111111'

  const sampleConv1: ConversationDto = {
    id: 'conv-1111-1111-1111-111111111111',
    botId,
    knowledgeBaseId: 'kb-test-01',
    title: 'Research Discussion',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const sampleConv2: ConversationDto = {
    id: 'conv-2222-2222-2222-222222222222',
    botId,
    knowledgeBaseId: 'kb-test-01',
    title: 'Contract Review',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const sampleArchivedConv: ConversationDto = {
    id: 'conv-3333-3333-3333-333333333333',
    botId,
    knowledgeBaseId: 'kb-test-01',
    title: 'Old Thread',
    createdAt: 1690000000000,
    updatedAt: 1695000000000,
    archivedAt: 1695000000000
  }

  interface MockConversationApiControls {
    api: ConversationApi
    listMock: ReturnType<typeof vi.fn>
    createMock: ReturnType<typeof vi.fn>
    renameMock: ReturnType<typeof vi.fn>
    deleteMock: ReturnType<typeof vi.fn>
  }

  function createMockApi(
    initialConversations: ConversationDto[] = []
  ): MockConversationApiControls {
    let currentConversations = [...initialConversations]

    const listMock = vi.fn(async (req: { botId?: string; includeArchived?: boolean }) => {
      let filtered = currentConversations.filter((c) => (req.botId ? c.botId === req.botId : true))
      if (!req.includeArchived) {
        filtered = filtered.filter((c) => c.archivedAt === null)
      }
      return filtered
    })

    const createMock = vi.fn(async (req: CreateConversationRequest) => {
      const created: ConversationDto = {
        id: `conv-new-${Math.random().toString(36).substring(2, 9)}`,
        botId: req.botId,
        knowledgeBaseId: 'kb-test-01',
        title: req.title ?? 'New Conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null
      }
      currentConversations = [created, ...currentConversations]
      return created
    })

    const renameMock = vi.fn(async (req: RenameConversationIpcRequest) => {
      const existing = currentConversations.find((c) => c.id === req.conversationId)
      if (!existing) {
        throw new ConversationBridgeError('Conversation not found', 'CONVERSATION_NOT_FOUND')
      }
      const updated: ConversationDto = {
        ...existing,
        title: req.title,
        updatedAt: Date.now()
      }
      currentConversations = currentConversations.map((c) => (c.id === updated.id ? updated : c))
      return updated
    })

    const deleteMock = vi.fn(async (req: DeleteConversationIpcRequest | string) => {
      const id = typeof req === 'string' ? req : req.conversationId
      currentConversations = currentConversations.filter((c) => c.id !== id)
      return { success: true, conversationId: id }
    })

    const api: ConversationApi = {
      listConversations: listMock,
      createConversation: createMock,
      renameConversation: renameMock,
      deleteConversation: deleteMock,
      listMessages: vi.fn(),
      sendMessage: vi.fn(),
      retryLastUserMessage: vi.fn(),
      cancelGeneration: vi.fn(),
      resolveCitation: vi.fn()
    }

    return {
      api,
      listMock,
      createMock,
      renameMock,
      deleteMock
    }
  }

  it('1. performs initial loading and populates conversation list', async () => {
    const { api } = createMockApi([sampleConv1, sampleConv2])

    const { result } = renderHook(() => useConversations({ botId, api }))

    expect(result.current.isLoading).toBe(true)
    expect(result.current.conversations).toEqual([])

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.conversations).toHaveLength(2)
    expect(result.current.conversations[0].title).toBe('Research Discussion')
    expect(result.current.conversations[1].title).toBe('Contract Review')
    expect(result.current.error).toBeNull()
  })

  it('2. handles failed conversation listing with sanitized error', async () => {
    const { api, listMock } = createMockApi()
    listMock.mockRejectedValueOnce(
      new ConversationBridgeError(
        'SQLite disk I/O error at C:\\data\\workspace.db',
        'DATABASE_ERROR'
      )
    )

    const { result } = renderHook(() => useConversations({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.conversations).toEqual([])
    expect(result.current.error).toBe('SQLite disk I/O error at [REDACTED_PATH]')
  })

  it('3. supports manual refresh', async () => {
    const { api, listMock } = createMockApi([sampleConv1])

    const { result } = renderHook(() => useConversations({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.conversations).toHaveLength(1)

    // Add another conversation to backend
    listMock.mockResolvedValueOnce([sampleConv1, sampleConv2])

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.conversations).toHaveLength(2)
  })

  it('4. creates a conversation, prepends to list, and auto-selects it', async () => {
    const { api, createMock } = createMockApi([sampleConv1])

    const { result } = renderHook(() => useConversations({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    let created: ConversationDto | undefined
    await act(async () => {
      created = await result.current.createConversation('Deep Dive on Section 3')
    })

    expect(createMock).toHaveBeenCalledWith({
      botId,
      title: 'Deep Dive on Section 3'
    })
    expect(result.current.conversations).toHaveLength(2)
    expect(result.current.conversations[0].title).toBe('Deep Dive on Section 3')
    expect(result.current.selectedConversationId).toBe(created?.id)
    expect(result.current.selectedConversation?.title).toBe('Deep Dive on Section 3')
  })

  it('5. renames a conversation and updates state', async () => {
    const { api, renameMock } = createMockApi([sampleConv1, sampleConv2])

    const { result } = renderHook(() =>
      useConversations({ botId, api, initialSelectedId: sampleConv1.id })
    )

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await result.current.renameConversation(sampleConv1.id, 'Updated Title')
    })

    expect(renameMock).toHaveBeenCalledWith({
      conversationId: sampleConv1.id,
      title: 'Updated Title'
    })
    expect(result.current.conversations.find((c) => c.id === sampleConv1.id)?.title).toBe(
      'Updated Title'
    )
    expect(result.current.selectedConversation?.title).toBe('Updated Title')
  })

  it('6. deletes a conversation and unselects it if active', async () => {
    const { api, deleteMock } = createMockApi([sampleConv1, sampleConv2])

    const { result } = renderHook(() =>
      useConversations({ botId, api, initialSelectedId: sampleConv1.id })
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.selectedConversationId).toBe(sampleConv1.id)

    await act(async () => {
      await result.current.deleteConversation(sampleConv1.id)
    })

    expect(deleteMock).toHaveBeenCalledWith({ conversationId: sampleConv1.id })
    expect(result.current.conversations).toHaveLength(1)
    expect(result.current.conversations[0].id).toBe(sampleConv2.id)
    expect(result.current.selectedConversationId).toBeNull()
    expect(result.current.selectedConversation).toBeNull()
  })

  it('7. respects includeArchived option', async () => {
    const { api } = createMockApi([sampleConv1, sampleArchivedConv])

    const { result: defaultResult } = renderHook(() =>
      useConversations({ botId, api, includeArchived: false })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(defaultResult.current.conversations).toHaveLength(1)

    const { result: archivedResult } = renderHook(() =>
      useConversations({ botId, api, includeArchived: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(archivedResult.current.conversations).toHaveLength(2)
  })

  it('8. clears conversations and selections when botId changes', async () => {
    const { api } = createMockApi([sampleConv1])

    let currentBotId: string | null = botId
    const { result, rerender } = renderHook(() => useConversations({ botId: currentBotId, api }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.conversations).toHaveLength(1)

    // Switch to another bot
    currentBotId = '22222222-2222-4222-8222-222222222222'
    rerender()

    expect(result.current.conversations).toEqual([])
    expect(result.current.selectedConversationId).toBeNull()
  })

  it('9. prevents stale asynchronous responses from overwriting newer state', async () => {
    const { api, listMock } = createMockApi()

    let resolveFirst!: (value: ConversationDto[]) => void
    const firstPromise = new Promise<ConversationDto[]>((res) => {
      resolveFirst = res
    })

    let resolveSecond!: (value: ConversationDto[]) => void
    const secondPromise = new Promise<ConversationDto[]>((res) => {
      resolveSecond = res
    })

    listMock.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise)

    let currentBotId = 'bot-first'
    const { result, rerender } = renderHook(() => useConversations({ botId: currentBotId, api }))

    // Switch to bot-second before first finishes
    currentBotId = 'bot-second'
    rerender()

    // Resolve second request first
    await act(async () => {
      resolveSecond([sampleConv2])
      await secondPromise
    })

    expect(result.current.conversations).toEqual([sampleConv2])

    // Later resolve first request
    await act(async () => {
      resolveFirst([sampleConv1])
      await firstPromise
    })

    // Must remain bot-second's data
    expect(result.current.conversations).toEqual([sampleConv2])
  })

  it('10. safely handles unmount and avoids state updates after unmount', async () => {
    let resolveSlow!: (value: ConversationDto[]) => void
    const slowPromise = new Promise<ConversationDto[]>((res) => {
      resolveSlow = res
    })

    const { api, listMock } = createMockApi()
    listMock.mockReturnValueOnce(slowPromise)

    const { unmount } = renderHook(() => useConversations({ botId, api }))

    unmount()

    await act(async () => {
      resolveSlow([sampleConv1])
      await slowPromise
    })
    // No unhandled rejection or state update warnings
  })
})
