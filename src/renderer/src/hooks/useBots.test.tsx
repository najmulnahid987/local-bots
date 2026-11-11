// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useBots } from './useBots'
import type {
  BotDto,
  CreateBotRequest,
  UpdateBotRequest,
  DeleteBotResultDto,
  BotApi,
  ListBotsRequest
} from '../../../shared/bots'
import { BotBridgeError } from '../../../shared/bots'
import type { KnowledgeBaseDto } from '../../../shared/knowledge-bases'

describe('Renderer: useBots Hook (Phase 6 Step 6.4)', () => {
  const activeBot1: BotDto = {
    id: '11111111-1111-4111-8111-111111111111',
    knowledgeBaseId: 'kb-test-01',
    name: 'Research Assistant',
    description: 'Specialized in researching local documents',
    systemPrompt: 'You are a research assistant.',
    providerConnectionId: 'conn-openai-01',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base', 'read_knowledge_base_document'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const activeBot2: BotDto = {
    id: '22222222-2222-4222-8222-222222222222',
    knowledgeBaseId: 'kb-test-01',
    name: 'Report Generator',
    description: 'Generates markdown reports from query results',
    systemPrompt: 'You generate structured reports.',
    providerConnectionId: null,
    modelId: 'claude-sonnet-5-5',
    enabledTools: ['prepare_report'],
    status: 'active',
    createdAt: 1700000010000,
    updatedAt: 1700000010000
  }

  const archivedBot: BotDto = {
    id: '33333333-3333-4333-8333-333333333333',
    knowledgeBaseId: 'kb-test-01',
    name: 'Legacy Project Bot',
    description: 'Archived bot no longer in active duty',
    systemPrompt: 'You are an archived bot.',
    providerConnectionId: 'conn-google-01',
    modelId: 'gemini-2.5-pro',
    enabledTools: [],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  interface MockApiControls {
    api: BotApi
    listMock: ReturnType<typeof vi.fn>
    getMock: ReturnType<typeof vi.fn>
    createMock: ReturnType<typeof vi.fn>
    updateMock: ReturnType<typeof vi.fn>
    archiveMock: ReturnType<typeof vi.fn>
    unarchiveMock: ReturnType<typeof vi.fn>
    deleteMock: ReturnType<typeof vi.fn>
    activateWorkspaceMock: ReturnType<typeof vi.fn>
    deactivateWorkspaceMock: ReturnType<typeof vi.fn>
  }

  function createMockApi(initialBots: BotDto[] = []): MockApiControls {
    let currentBots = [...initialBots]

    const listMock = vi.fn(async (options?: ListBotsRequest) => {
      if (options?.status) {
        return currentBots.filter((b) => b.status === options.status)
      }
      return [...currentBots]
    })

    const getMock = vi.fn(async (botId: string) => {
      return currentBots.find((b) => b.id === botId) ?? null
    })

    const createMock = vi.fn(async (request: CreateBotRequest) => {
      const newBot: BotDto = {
        id: 'new-bot-id-' + Math.random().toString(36).substring(2, 9),
        knowledgeBaseId: 'authoritative-kb-id',
        name: request.name,
        description: request.description ?? '',
        systemPrompt: request.systemPrompt ?? '',
        providerConnectionId: request.providerConnectionId ?? null,
        modelId: request.modelId,
        enabledTools: request.enabledTools ?? [],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      currentBots = [newBot, ...currentBots]
      return newBot
    })

    const updateMock = vi.fn(async (botId: string, request: UpdateBotRequest) => {
      const idx = currentBots.findIndex((b) => b.id === botId)
      if (idx === -1) {
        throw new BotBridgeError('Bot not found', 'BOT_NOT_FOUND')
      }
      const existing = currentBots[idx]
      const updated: BotDto = {
        ...existing,
        name: request.name ?? existing.name,
        description:
          request.description !== undefined ? (request.description ?? '') : existing.description,
        systemPrompt:
          request.systemPrompt !== undefined ? (request.systemPrompt ?? '') : existing.systemPrompt,
        providerConnectionId:
          request.providerConnectionId !== undefined
            ? request.providerConnectionId
            : existing.providerConnectionId,
        modelId: request.modelId ?? existing.modelId,
        enabledTools: request.enabledTools ?? existing.enabledTools,
        updatedAt: Date.now()
      }
      currentBots[idx] = updated
      return updated
    })

    const archiveMock = vi.fn(async (botId: string) => {
      const idx = currentBots.findIndex((b) => b.id === botId)
      if (idx === -1) {
        throw new BotBridgeError('Bot not found', 'BOT_NOT_FOUND')
      }
      const existing = currentBots[idx]
      const archived: BotDto = {
        ...existing,
        status: 'archived',
        updatedAt: Date.now()
      }
      currentBots[idx] = archived
      return archived
    })

    const unarchiveMock = vi.fn(async (botId: string) => {
      const idx = currentBots.findIndex((b) => b.id === botId)
      if (idx === -1) {
        throw new BotBridgeError('Bot not found', 'BOT_NOT_FOUND')
      }
      const existing = currentBots[idx]
      const unarchived: BotDto = {
        ...existing,
        status: 'active',
        updatedAt: Date.now()
      }
      currentBots[idx] = unarchived
      return unarchived
    })

    const deleteMock = vi.fn(async (botId: string): Promise<DeleteBotResultDto> => {
      const idx = currentBots.findIndex((b) => b.id === botId)
      if (idx === -1) {
        throw new BotBridgeError('Bot not found', 'BOT_NOT_FOUND')
      }
      currentBots.splice(idx, 1)
      return {
        success: true,
        botId
      }
    })

    const activateWorkspaceMock = vi.fn(
      async (knowledgeBaseId: string): Promise<KnowledgeBaseDto> => ({
        id: knowledgeBaseId,
        name: 'Active KB',
        description: 'Active KB Description',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null
      })
    )

    const deactivateWorkspaceMock = vi.fn(async () => ({ success: true }))

    const api: BotApi = {
      list: listMock,
      get: getMock,
      create: createMock,
      update: updateMock,
      archive: archiveMock,
      unarchive: unarchiveMock,
      delete: deleteMock,
      activateWorkspace: activateWorkspaceMock,
      deactivateWorkspace: deactivateWorkspaceMock
    }

    return {
      api,
      listMock,
      getMock,
      createMock,
      updateMock,
      archiveMock,
      unarchiveMock,
      deleteMock,
      activateWorkspaceMock,
      deactivateWorkspaceMock
    }
  }

  let mockControls: MockApiControls

  beforeEach(() => {
    mockControls = createMockApi([activeBot1, activeBot2, archivedBot])
    // Configure global window.api
    window.api = {
      ...(window.api || {}),
      bots: mockControls.api
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('Initial loading and listing', () => {
    it('loads all bots on mount when no status filter is specified', async () => {
      const { result } = renderHook(() => useBots())

      // Initially loading
      expect(result.current.isLoading).toBe(true)
      expect(result.current.bots).toEqual([])
      expect(result.current.error).toBeNull()

      // Await load completion
      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.bots).toHaveLength(3)
      expect(result.current.bots.map((b) => b.name)).toEqual([
        'Research Assistant',
        'Report Generator',
        'Legacy Project Bot'
      ])
      expect(mockControls.listMock).toHaveBeenCalledWith(undefined)
    })

    it('respects status filter option on mount', async () => {
      const { result } = renderHook(() => useBots({ status: 'active' }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.bots).toHaveLength(2)
      expect(result.current.bots.every((b) => b.status === 'active')).toBe(true)
      expect(mockControls.listMock).toHaveBeenCalledWith({ status: 'active' })
    })

    it('handles empty bot list gracefully', async () => {
      const emptyControls = createMockApi([])
      const { result } = renderHook(() => useBots({ api: emptyControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.bots).toEqual([])
      expect(result.current.error).toBeNull()
    })

    it('uses injected api option over window.api.bots', async () => {
      const customControls = createMockApi([activeBot1])
      const { result } = renderHook(() => useBots({ api: customControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(customControls.listMock).toHaveBeenCalledTimes(1)
      expect(mockControls.listMock).not.toHaveBeenCalled()
      expect(result.current.bots).toHaveLength(1)
    })

    it('handles failure when window.api.bots is completely missing', async () => {
      // Clear window.api.bots
      const originalApi = window.api
      delete (window as unknown as { api?: unknown }).api

      const { result } = renderHook(() => useBots())

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.bots).toEqual([])
      expect(result.current.error).toContain('Bot API is not available')

      window.api = originalApi
    })
  })

  describe('Error handling & Sanitization', () => {
    it('sets sanitized error when listing fails with local paths or keys', async () => {
      const errorApi: BotApi = {
        ...mockControls.api,
        list: vi.fn(async () => {
          throw new Error(
            'Failed to access C:\\Users\\User\\secret\\workspace.db with key sk-proj-1234567890abcdef'
          )
        })
      }

      const { result } = renderHook(() => useBots({ api: errorApi }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBe('Failed to access [REDACTED_PATH] with key [REDACTED_KEY]')
      expect(result.current.error).not.toContain('C:\\Users')
      expect(result.current.error).not.toContain('sk-proj-')
    })

    it('displays BotBridgeError message cleanly without modification', async () => {
      const errorApi: BotApi = {
        ...mockControls.api,
        list: vi.fn(async () => {
          throw new BotBridgeError('Knowledge Base is archived', 'KB_ARCHIVED')
        })
      }

      const { result } = renderHook(() => useBots({ api: errorApi }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.error).toBe('Knowledge Base is archived')
    })

    it('allows clearing error with clearError()', async () => {
      const errorApi: BotApi = {
        ...mockControls.api,
        list: vi.fn(async () => {
          throw new Error('Network timeout')
        })
      }

      const { result } = renderHook(() => useBots({ api: errorApi }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.error).toBe('Network timeout')

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })
  })

  describe('Refresh functionality', () => {
    it('sets isRefreshing during refresh and updates state', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(mockControls.listMock).toHaveBeenCalledTimes(1)

      let refreshPromise: Promise<void>
      act(() => {
        refreshPromise = result.current.refresh()
      })

      expect(result.current.isRefreshing).toBe(true)

      await act(async () => {
        await refreshPromise
      })

      expect(result.current.isRefreshing).toBe(false)
      expect(mockControls.listMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('getBot()', () => {
    it('retrieves a bot by id successfully', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      let bot: BotDto | null = null
      await act(async () => {
        bot = await result.current.getBot(activeBot1.id)
      })

      expect(mockControls.getMock).toHaveBeenCalledWith(activeBot1.id)
      expect(bot).toEqual(activeBot1)
    })

    it('sets error and rethrows when getBot fails', async () => {
      mockControls.getMock.mockRejectedValueOnce(new Error('Bot lookup failure C:\\secret\\file'))
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      let thrown: unknown = null
      await act(async () => {
        try {
          await result.current.getBot('invalid-id')
        } catch (err) {
          thrown = err
        }
      })

      expect(thrown).toBeDefined()
      expect(result.current.error).toContain('[REDACTED_PATH]')
    })
  })

  describe('createBot()', () => {
    it('creates a bot and prepends to local state without requiring knowledgeBaseId from caller', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.bots).toHaveLength(3)

      const createReq: CreateBotRequest = {
        name: 'New Custom Bot',
        description: 'A newly created bot',
        systemPrompt: 'You are helpful.',
        modelId: 'gpt-6-luna',
        enabledTools: ['search_knowledge_base']
      }

      let createdBot: BotDto | null = null
      await act(async () => {
        createdBot = await result.current.createBot(createReq)
      })

      expect(mockControls.createMock).toHaveBeenCalledWith(createReq)
      // Confirms caller never supplied knowledgeBaseId
      expect(createReq).not.toHaveProperty('knowledgeBaseId')
      expect(result.current.bots).toHaveLength(4)
      expect(result.current.bots[0].id).toBe(createdBot!.id)
      expect(result.current.bots[0].name).toBe('New Custom Bot')
      expect(result.current.isMutating).toBe(false)
    })

    it('preserves existing state non-optimistically if creation fails', async () => {
      mockControls.createMock.mockRejectedValueOnce(
        new BotBridgeError('Model not found', 'MODEL_NOT_FOUND')
      )

      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      const originalCount = result.current.bots.length

      let errorCaught = false
      await act(async () => {
        try {
          await result.current.createBot({
            name: 'Failing Bot',
            modelId: 'nonexistent-model'
          })
        } catch {
          errorCaught = true
        }
      })

      expect(errorCaught).toBe(true)
      expect(result.current.bots).toHaveLength(originalCount)
      expect(result.current.error).toBe('Model not found')
      expect(result.current.isMutating).toBe(false)
    })
  })

  describe('updateBot()', () => {
    it('updates an existing bot in local state', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      const updateReq: UpdateBotRequest = {
        name: 'Updated Bot Name',
        description: 'Updated description'
      }

      await act(async () => {
        await result.current.updateBot(activeBot1.id, updateReq)
      })

      expect(mockControls.updateMock).toHaveBeenCalledWith(activeBot1.id, updateReq)
      const updatedInState = result.current.bots.find((b) => b.id === activeBot1.id)
      expect(updatedInState?.name).toBe('Updated Bot Name')
      expect(updatedInState?.description).toBe('Updated description')
      expect(result.current.isMutating).toBe(false)
    })

    it('preserves existing state non-optimistically if update fails', async () => {
      mockControls.updateMock.mockRejectedValueOnce(
        new BotBridgeError('Provider connection required', 'INVALID_CONFIG')
      )

      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      let errorCaught = false
      await act(async () => {
        try {
          await result.current.updateBot(activeBot1.id, { name: 'Should Not Persist' })
        } catch {
          errorCaught = true
        }
      })

      expect(errorCaught).toBe(true)
      const inState = result.current.bots.find((b) => b.id === activeBot1.id)
      expect(inState?.name).toBe('Research Assistant')
      expect(result.current.error).toBe('Provider connection required')
    })
  })

  describe('archiveBot() & unarchiveBot()', () => {
    it('archives bot and updates in-place when no status filter is applied', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        await result.current.archiveBot(activeBot1.id)
      })

      expect(mockControls.archiveMock).toHaveBeenCalledWith(activeBot1.id)
      const inState = result.current.bots.find((b) => b.id === activeBot1.id)
      expect(inState?.status).toBe('archived')
      expect(result.current.bots).toHaveLength(3)
    })

    it('archives bot and filters it out when status="active" filter is active', async () => {
      const { result } = renderHook(() => useBots({ status: 'active', api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.bots).toHaveLength(2)

      await act(async () => {
        await result.current.archiveBot(activeBot1.id)
      })

      expect(result.current.bots).toHaveLength(1)
      expect(result.current.bots.find((b) => b.id === activeBot1.id)).toBeUndefined()
    })

    it('unarchives bot and filters it out when status="archived" filter is active', async () => {
      const { result } = renderHook(() => useBots({ status: 'archived', api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.bots).toHaveLength(1)
      expect(result.current.bots[0].id).toBe(archivedBot.id)

      await act(async () => {
        await result.current.unarchiveBot(archivedBot.id)
      })

      expect(mockControls.unarchiveMock).toHaveBeenCalledWith(archivedBot.id)
      expect(result.current.bots).toHaveLength(0)
    })
  })

  describe('deleteBot()', () => {
    it('deletes bot and removes it from local state', async () => {
      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(result.current.bots).toHaveLength(3)

      let deleteResult: DeleteBotResultDto | null = null
      await act(async () => {
        deleteResult = await result.current.deleteBot(activeBot1.id)
      })

      expect(mockControls.deleteMock).toHaveBeenCalledWith(activeBot1.id)
      expect(deleteResult).toEqual({
        success: true,
        botId: activeBot1.id
      })
      expect(result.current.bots).toHaveLength(2)
      expect(result.current.bots.find((b) => b.id === activeBot1.id)).toBeUndefined()
    })

    it('preserves existing state if deletion fails', async () => {
      mockControls.deleteMock.mockRejectedValueOnce(
        new BotBridgeError('Database error', 'DATABASE_ERROR')
      )

      const { result } = renderHook(() => useBots({ api: mockControls.api }))

      await act(async () => {
        await Promise.resolve()
      })

      let errorCaught = false
      await act(async () => {
        try {
          await result.current.deleteBot(activeBot1.id)
        } catch {
          errorCaught = true
        }
      })

      expect(errorCaught).toBe(true)
      expect(result.current.bots).toHaveLength(3)
      expect(result.current.error).toBe('Database error')
    })
  })

  describe('Race conditions and unmount safety', () => {
    it('discards results of stale requests if filter changed rapidly', async () => {
      let resolveFirstList: (value: readonly BotDto[]) => void = () => {}
      const slowPromise = new Promise<readonly BotDto[]>((res) => {
        resolveFirstList = res
      })

      const customListMock = vi
        .fn()
        .mockImplementationOnce(() => slowPromise)
        .mockImplementationOnce(async () => [archivedBot])

      const racingApi: BotApi = {
        ...mockControls.api,
        list: customListMock
      }

      const { result, rerender } = renderHook(
        (props: { status?: 'active' | 'archived' }) =>
          useBots({ status: props.status, api: racingApi }),
        { initialProps: { status: 'active' } }
      )

      // Rerender with 'archived' immediately
      rerender({ status: 'archived' })

      // Now resolve the first request with active bots
      await act(async () => {
        resolveFirstList([activeBot1, activeBot2])
        await Promise.resolve()
      })

      // The active bots from first request must NOT overwrite the archived bots from second request
      expect(result.current.bots).toEqual([archivedBot])
    })

    it('does not throw or update state after unmount', async () => {
      let resolveList: (value: readonly BotDto[]) => void = () => {}
      const pendingPromise = new Promise<readonly BotDto[]>((res) => {
        resolveList = res
      })

      const pendingApi: BotApi = {
        ...mockControls.api,
        list: vi.fn(() => pendingPromise)
      }

      const { unmount } = renderHook(() => useBots({ api: pendingApi }))

      // Unmount before promise resolves
      unmount()

      // Resolve pending promise - should not cause unhandled errors or React warning
      await act(async () => {
        resolveList([activeBot1])
        await Promise.resolve()
      })
    })
  })
})
