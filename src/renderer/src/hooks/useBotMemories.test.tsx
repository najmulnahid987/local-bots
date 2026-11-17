// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useBotMemories } from './useBotMemories'
import type { BotMemoryDto, BotMemoryApi } from '../../../shared/bot-memories'
import { BotMemoryBridgeError } from '../../../shared/bot-memories'

describe('Renderer: useBotMemories Hook (Phase 9 Step 9.3)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const botId = '11111111-1111-4111-8111-111111111111'
  const kbId = '22222222-2222-4222-8222-222222222222'

  const sampleMemory1: BotMemoryDto = {
    id: 'mem-1111-1111-1111-111111111111',
    botId,
    knowledgeBaseId: kbId,
    memoryType: 'pinned_instruction',
    content: 'Always output typescript code.',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleMemory2: BotMemoryDto = {
    id: 'mem-2222-2222-2222-222222222222',
    botId,
    knowledgeBaseId: kbId,
    memoryType: 'user_note',
    content: 'User prefers concise summaries.',
    createdAt: 1700000010000,
    updatedAt: 1700000010000
  }

  interface MockBotMemoryApiControls {
    api: BotMemoryApi
    listMock: ReturnType<typeof vi.fn>
    getMock: ReturnType<typeof vi.fn>
    createMock: ReturnType<typeof vi.fn>
    updateMock: ReturnType<typeof vi.fn>
    deleteMock: ReturnType<typeof vi.fn>
    countMock: ReturnType<typeof vi.fn>
  }

  function createMockApi(initialMemories: BotMemoryDto[] = []): MockBotMemoryApiControls {
    let store = [...initialMemories]

    const listMock = vi.fn(async (input: { botId: string; memoryType?: string }) => {
      let filtered = store.filter((m) => m.botId === input.botId)
      if (input.memoryType) {
        filtered = filtered.filter((m) => m.memoryType === input.memoryType)
      }
      return filtered
    })

    const getMock = vi.fn(async (memoryId: string, bId: string) => {
      return store.find((m) => m.id === memoryId && m.botId === bId) ?? null
    })

    const createMock = vi.fn(
      async (input: {
        botId: string
        memoryType?: 'user_note' | 'pinned_instruction'
        content: string
      }) => {
        const created: BotMemoryDto = {
          id: `mem-${Date.now()}`,
          botId: input.botId,
          knowledgeBaseId: kbId,
          memoryType: input.memoryType ?? 'user_note',
          content: input.content,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        store.push(created)
        return created
      }
    )

    const updateMock = vi.fn(
      async (
        memoryId: string,
        bId: string,
        input: { memoryType?: 'user_note' | 'pinned_instruction'; content?: string }
      ) => {
        const idx = store.findIndex((m) => m.id === memoryId && m.botId === bId)
        if (idx === -1) throw new BotMemoryBridgeError('Memory not found', 'NOT_FOUND')
        const updated: BotMemoryDto = {
          ...store[idx],
          memoryType: input.memoryType ?? store[idx].memoryType,
          content: input.content ?? store[idx].content,
          updatedAt: Date.now()
        }
        store[idx] = updated
        return updated
      }
    )

    const deleteMock = vi.fn(async (memoryId: string, bId: string) => {
      const idx = store.findIndex((m) => m.id === memoryId && m.botId === bId)
      if (idx === -1) throw new BotMemoryBridgeError('Memory not found', 'NOT_FOUND')
      store = store.filter((m) => !(m.id === memoryId && m.botId === bId))
      return { success: true, memoryId }
    })

    const countMock = vi.fn(async (bId: string) => {
      return { botId: bId, count: store.filter((m) => m.botId === bId).length }
    })

    return {
      api: {
        list: listMock,
        get: getMock,
        create: createMock,
        update: updateMock,
        delete: deleteMock,
        count: countMock
      },
      listMock,
      getMock,
      createMock,
      updateMock,
      deleteMock,
      countMock
    }
  }

  it('1. loads memories for the specified botId', async () => {
    const controls = createMockApi([sampleMemory1, sampleMemory2])

    const { result } = renderHook(() => useBotMemories({ botId, api: controls.api }))

    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.memories).toHaveLength(2)
    expect(result.current.pinnedCount).toBe(1)
    expect(result.current.noteCount).toBe(1)
    expect(result.current.totalEstimatedTokens).toBeGreaterThan(0)
    expect(controls.listMock).toHaveBeenCalledWith({ botId, memoryType: undefined })
  })

  it('2. resets memories and re-fetches when botId changes', async () => {
    const controls = createMockApi([sampleMemory1])
    const botId2 = '33333333-3333-4333-8333-333333333333'

    const { result, rerender } = renderHook(
      ({ currentBotId }) => useBotMemories({ botId: currentBotId, api: controls.api }),
      { initialProps: { currentBotId: botId } }
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.memories).toHaveLength(1)

    // Switch to botId2
    rerender({ currentBotId: botId2 })

    await act(async () => {
      await Promise.resolve()
    })

    expect(controls.listMock).toHaveBeenCalledWith({ botId: botId2, memoryType: undefined })
    expect(result.current.memories).toHaveLength(0)
  })

  it('3. does not fetch when enabled is false or botId is null', async () => {
    const controls = createMockApi([sampleMemory1])

    const { result } = renderHook(() =>
      useBotMemories({ botId: null, enabled: true, api: controls.api })
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.memories).toHaveLength(0)
    expect(controls.listMock).not.toHaveBeenCalled()
  })

  it('4. creates a memory and refreshes list', async () => {
    const controls = createMockApi([])

    const { result } = renderHook(() => useBotMemories({ botId, api: controls.api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.memories).toHaveLength(0)

    await act(async () => {
      await result.current.createMemory({
        memoryType: 'pinned_instruction',
        content: 'New pinned memory.'
      })
    })

    expect(controls.createMock).toHaveBeenCalledWith({
      botId,
      memoryType: 'pinned_instruction',
      content: 'New pinned memory.'
    })
    expect(result.current.memories).toHaveLength(1)
    expect(result.current.memories[0].content).toBe('New pinned memory.')
    expect(result.current.pinnedCount).toBe(1)
  })

  it('5. updates a memory and refreshes list', async () => {
    const controls = createMockApi([sampleMemory1])

    const { result } = renderHook(() => useBotMemories({ botId, api: controls.api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.memories[0].content).toBe('Always output typescript code.')

    await act(async () => {
      await result.current.updateMemory(sampleMemory1.id, {
        content: 'Updated content'
      })
    })

    expect(controls.updateMock).toHaveBeenCalledWith(sampleMemory1.id, botId, {
      content: 'Updated content'
    })
    expect(result.current.memories[0].content).toBe('Updated content')
  })

  it('6. deletes a memory and refreshes list', async () => {
    const controls = createMockApi([sampleMemory1])

    const { result } = renderHook(() => useBotMemories({ botId, api: controls.api }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.memories).toHaveLength(1)

    await act(async () => {
      await result.current.deleteMemory(sampleMemory1.id)
    })

    expect(controls.deleteMock).toHaveBeenCalledWith(sampleMemory1.id, botId)
    expect(result.current.memories).toHaveLength(0)
  })

  it('7. sanitizes error messages and handles API errors', async () => {
    const failingApi: BotMemoryApi = {
      list: vi.fn().mockRejectedValue(new Error('Failed reading C:\\Users\\secret\\db.sqlite')),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn()
    }

    const { result } = renderHook(() => useBotMemories({ botId, api: failingApi }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.error).toBeDefined()
    expect(result.current.error).toContain('[REDACTED_PATH]')
    expect(result.current.error).not.toContain('C:\\Users\\secret')
  })
})
