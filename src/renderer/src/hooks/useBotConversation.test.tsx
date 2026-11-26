// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useBotConversation } from './useBotConversation'
import {
  ConversationBridgeError,
  type BotConversationWorkspaceDto,
  type ClearConversationResultDto,
  type ConversationApi,
  type ConversationDto,
  type ConversationSegmentDto,
  type MessageDto
} from '../../../shared/conversations'

describe('Renderer: useBotConversation Hook (Phase 12 Step 12.2)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const kbId = 'kb-1111-1111-1111-111111111111'
  const botId = 'bot-1111-1111-1111-111111111111'
  const bot2Id = 'bot-2222-2222-2222-222222222222'
  const convId = 'conv-1111-1111-1111-111111111111'

  const sampleConv: ConversationDto = {
    id: convId,
    botId,
    knowledgeBaseId: kbId,
    title: 'Alpha Bot Workspace',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    archivedAt: null
  }

  const seg0: ConversationSegmentDto = {
    id: 'seg-0',
    conversationId: convId,
    originalConversationId: convId,
    title: 'Earlier Consolidated Session',
    segmentOrder: 0,
    firstMessageCreatedAt: null,
    lastMessageCreatedAt: null,
    createdAt: 1700000000000,
    archivedAt: null,
    messageCount: 1
  }

  const seg1: ConversationSegmentDto = {
    id: 'seg-1',
    conversationId: convId,
    originalConversationId: convId,
    title: 'Active Consolidated Session',
    segmentOrder: 1,
    firstMessageCreatedAt: null,
    lastMessageCreatedAt: null,
    createdAt: 1700000001000,
    archivedAt: null,
    messageCount: 1
  }

  const msgSeg0LateTs: MessageDto = {
    id: 'msg-0',
    conversationId: convId,
    segmentId: seg0.id,
    role: 'user',
    content: 'From earlier segment despite later timestamp',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000090000
  }

  const msgSeg1EarlyTs: MessageDto = {
    id: 'msg-1',
    conversationId: convId,
    segmentId: seg1.id,
    role: 'assistant',
    content: 'From later segment despite earlier timestamp',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000010000
  }

  function createMockApi(overrides?: Partial<ConversationApi>): {
    api: ConversationApi
    getConversationForBotMock: ReturnType<typeof vi.fn>
    clearConversationMock: ReturnType<typeof vi.fn>
  } {
    const defaultWorkspace: BotConversationWorkspaceDto = {
      conversation: sampleConv,
      segments: [seg1, seg0],
      messages: [msgSeg1EarlyTs, msgSeg0LateTs]
    }
    const getConversationForBotMock = vi.fn(async () => defaultWorkspace)
    const clearConversationMock = vi.fn(async (): Promise<ClearConversationResultDto> => ({
      success: true,
      deletedMessagesCount: 2,
      preservedAgentRunsCount: 1,
      conversation: { ...sampleConv, updatedAt: 1700000100000 },
      activeSegment: {
        id: 'seg-fresh',
        conversationId: convId,
        originalConversationId: convId,
        title: sampleConv.title,
        segmentOrder: 0,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000100000,
        archivedAt: null,
        messageCount: 0
      }
    }))

    const api: ConversationApi = {
      getConversationForBot: getConversationForBotMock,
      getSegments: vi.fn(async () => [seg0, seg1]),
      getClearPreview: vi.fn(),
      clearConversation: clearConversationMock,
      listConversations: vi.fn(),
      listMessages: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      sendMessage: vi.fn(),
      retryLastUserMessage: vi.fn(),
      cancelGeneration: vi.fn(),
      resolveCitation: vi.fn(),
      ...overrides
    }

    return { api, getConversationForBotMock, clearConversationMock }
  }

  it('1. loads canonical conversation, sorts segments by segmentOrder, and prevents timestamp interleaving', async () => {
    const { api, getConversationForBotMock } = createMockApi()
    const { result } = renderHook(() => useBotConversation({ botId, api }))

    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(getConversationForBotMock).toHaveBeenCalledWith({ botId })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.conversation?.id).toBe(convId)
    expect(result.current.segments.map((s) => s.id)).toEqual(['seg-0', 'seg-1'])
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-0', 'msg-1'])
    expect(result.current.error).toBeNull()
  })

  it('2. does not query IPC when enabled=false or botId is missing', async () => {
    const { api, getConversationForBotMock } = createMockApi()
    const { result } = renderHook(() => useBotConversation({ botId: null, enabled: false, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(getConversationForBotMock).not.toHaveBeenCalled()
    expect(result.current.conversation).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('3. prevents stale asynchronous responses during rapid A -> B -> A Bot switching', async () => {
    let resolveReq1!: (w: BotConversationWorkspaceDto) => void
    let resolveReq2!: (w: BotConversationWorkspaceDto) => void

    const p1 = new Promise<BotConversationWorkspaceDto>((res) => {
      resolveReq1 = res
    })
    const p2 = new Promise<BotConversationWorkspaceDto>((res) => {
      resolveReq2 = res
    })

    const getConversationForBotMock = vi.fn().mockReturnValueOnce(p1).mockReturnValueOnce(p2)
    const { api } = createMockApi({ getConversationForBot: getConversationForBotMock })

    let currentBot = botId
    const { result, rerender } = renderHook(() => useBotConversation({ botId: currentBot, api }))

    // Switch quickly to bot2
    currentBot = bot2Id
    rerender()

    // Old state cleared immediately on switch
    expect(result.current.conversation).toBeNull()
    expect(result.current.messages).toEqual([])

    const conv2: ConversationDto = { ...sampleConv, id: 'conv-2', botId: bot2Id, title: 'Bot 2' }
    const msg2: MessageDto = {
      ...msgSeg0LateTs,
      id: 'msg-bot2',
      conversationId: 'conv-2',
      content: 'Bot 2 message'
    }

    // Resolve request 2 first
    await act(async () => {
      resolveReq2({ conversation: conv2, segments: [], messages: [msg2] })
      await p2
    })
    expect(result.current.conversation?.id).toBe('conv-2')
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-bot2'])

    // Late arrival of request 1 must NOT overwrite Bot 2 state
    await act(async () => {
      resolveReq1({ conversation: sampleConv, segments: [seg0], messages: [msgSeg0LateTs] })
      await p1
    })
    expect(result.current.conversation?.id).toBe('conv-2')
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-bot2'])
  })

  it('4. clears conversation, keeps canonical conversation ID, resets to active segment, and allows new messages', async () => {
    const { api, clearConversationMock } = createMockApi()
    const { result } = renderHook(() => useBotConversation({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await result.current.clearConversation()
    })

    expect(clearConversationMock).toHaveBeenCalledWith({ conversationId: convId })
    expect(result.current.conversation?.id).toBe(convId)
    expect(result.current.messages).toEqual([])
    expect(result.current.segments.map((s) => s.id)).toEqual(['seg-fresh'])

    const freshMsg: MessageDto = {
      ...msgSeg0LateTs,
      id: 'msg-after-clear',
      segmentId: 'seg-fresh',
      content: 'Fresh message after clear'
    }
    act(() => {
      result.current.appendMessage(freshMsg)
    })
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-after-clear'])
  })

  it('5. ignores appendMessage belonging to another conversation and sanitizes errors', async () => {
    const { api, getConversationForBotMock } = createMockApi()
    const { result, unmount } = renderHook(() => useBotConversation({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      result.current.appendMessage({
        ...msgSeg0LateTs,
        id: 'msg-foreign',
        conversationId: 'conv-other'
      })
    })
    expect(result.current.messages.some((m) => m.id === 'msg-foreign')).toBe(false)

    // Test refresh failure sanitization
    getConversationForBotMock.mockRejectedValueOnce(
      new ConversationBridgeError(
        'Failed reading C:\\secret\\db.sqlite with sk-proj-1234567890abcd',
        'INTERNAL_ERROR'
      )
    )
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toContain('[REDACTED_PATH]')
    expect(result.current.error).toContain('[REDACTED_KEY]')
    expect(result.current.error).not.toContain('secret')

    act(() => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()

    unmount()
  })

  it('6. sets safe error when canonical conversation payload does not belong to requested Bot', async () => {
    const { api } = createMockApi({
      getConversationForBot: vi.fn(async () => ({
        conversation: { ...sampleConv, botId: 'mismatched-bot' },
        segments: [],
        messages: []
      }))
    })
    const { result } = renderHook(() => useBotConversation({ botId, api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.conversation).toBeNull()
    expect(result.current.error).toContain('Canonical conversation could not be loaded')
  })
})
