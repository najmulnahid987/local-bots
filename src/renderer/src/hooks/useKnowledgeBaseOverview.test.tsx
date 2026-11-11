// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKnowledgeBaseOverview } from './useKnowledgeBaseOverview'
import type { KnowledgeBaseOverviewDto } from '../../../shared/knowledge-bases'

describe('Renderer Hook: useKnowledgeBaseOverview (Phase 4 Step 4.6C)', () => {
  const kbId1 = '11111111-1111-4111-8111-111111111111'
  const kbId2 = '22222222-2222-4222-8222-222222222222'

  const mockOverview1: KnowledgeBaseOverviewDto = {
    knowledgeBaseId: kbId1,
    bots: { total: 3, active: 2, archived: 1 },
    documents: {
      total: 5,
      ready: 3,
      processing: 1,
      failed: 1,
      totalBytes: 1048576
    },
    indexing: {
      totalChunks: 120,
      totalTokens: 15400,
      lastIndexedAt: 1700000000000
    },
    recentActivity: [
      {
        id: 'act-1',
        type: 'bot_created',
        title: 'Assistant Bot',
        timestamp: 1700000000000,
        status: 'active'
      }
    ]
  }

  const mockOverview2: KnowledgeBaseOverviewDto = {
    knowledgeBaseId: kbId2,
    bots: { total: 0, active: 0, archived: 0 },
    documents: { total: 0, ready: 0, processing: 0, failed: 0, totalBytes: 0 },
    indexing: { totalChunks: 0, totalTokens: 0, lastIndexedAt: null },
    recentActivity: []
  }

  let getOverviewMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getOverviewMock = vi.fn(async (id: string) => {
      if (id === kbId1) return mockOverview1
      if (id === kbId2) return mockOverview2
      throw new Error(`Knowledge Base not found: ${id}`)
    })

    // Setup window.api mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      knowledgeBases: {
        getOverview: getOverviewMock
      }
    }
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
    vi.restoreAllMocks()
  })

  it('1. loads overview data on mount and exposes correct state', async () => {
    const { result } = renderHook(() => useKnowledgeBaseOverview(kbId1))

    // Initial state: loading is true
    expect(result.current.loading).toBe(true)
    expect(result.current.overview).toBeNull()
    expect(result.current.error).toBeNull()

    // Wait for resolution
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(getOverviewMock).toHaveBeenCalledTimes(1)
    expect(getOverviewMock).toHaveBeenCalledWith(kbId1)
    expect(result.current.overview).toEqual(mockOverview1)
    expect(result.current.error).toBeNull()
    expect(result.current.refreshing).toBe(false)
  })

  it('2. correctly handles an empty Knowledge Base without error', async () => {
    const { result } = renderHook(() => useKnowledgeBaseOverview(kbId2))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.overview).toEqual(mockOverview2)
    expect(result.current.overview?.bots.total).toBe(0)
    expect(result.current.overview?.documents.total).toBe(0)
    expect(result.current.overview?.indexing.lastIndexedAt).toBeNull()
    expect(result.current.overview?.recentActivity).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('3. safely normalizes errors and redacts internal filesystem paths', async () => {
    getOverviewMock.mockRejectedValueOnce(
      new Error('Failed to read database at C:\\Users\\User\\AppData\\Local\\workspace.db')
    )

    const { result } = renderHook(() => useKnowledgeBaseOverview(kbId1))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.overview).toBeNull()
    expect(result.current.error).toBeDefined()
    expect(result.current.error).toContain('[REDACTED_PATH]')
    expect(result.current.error).not.toContain('C:\\Users')
  })

  it('4. safely handles missing preload API without throwing or crashing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api

    const { result } = renderHook(() => useKnowledgeBaseOverview(kbId1))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.overview).toBeNull()
    expect(result.current.error).toBe(
      'Knowledge Base overview API is not available in this environment.'
    )
  })

  it('5. triggers a fresh fetch and clears previous data when knowledgeBaseId changes', async () => {
    let currentId = kbId1
    const { result, rerender } = renderHook(({ id }) => useKnowledgeBaseOverview(id), {
      initialProps: { id: currentId }
    })

    await waitFor(() => {
      expect(result.current.overview?.knowledgeBaseId).toBe(kbId1)
    })

    // Change KB ID to kbId2
    currentId = kbId2
    rerender({ id: currentId })

    // Immediately after ID change, overview should be reset so stale KB 1 data is not shown
    expect(result.current.overview).toBeNull()
    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.overview?.knowledgeBaseId).toBe(kbId2)
    expect(getOverviewMock).toHaveBeenCalledWith(kbId2)
  })

  it('6. prevents race conditions: older async response cannot overwrite newer result', async () => {
    let resolveFirst!: (value: KnowledgeBaseOverviewDto) => void
    const slowFirstPromise = new Promise<KnowledgeBaseOverviewDto>((resolve) => {
      resolveFirst = resolve
    })

    getOverviewMock.mockImplementation(async (id: string) => {
      if (id === kbId1) {
        return slowFirstPromise
      }
      return mockOverview2
    })

    const { result, rerender } = renderHook(({ id }) => useKnowledgeBaseOverview(id), {
      initialProps: { id: kbId1 }
    })

    // Immediately switch to KB 2 before KB 1 resolves
    rerender({ id: kbId2 })

    await waitFor(() => {
      expect(result.current.overview?.knowledgeBaseId).toBe(kbId2)
    })

    // Now resolve the slow response for KB 1
    await act(async () => {
      resolveFirst(mockOverview1)
    })

    // Verified: KB 1 response is ignored; KB 2 remains active
    expect(result.current.overview?.knowledgeBaseId).toBe(kbId2)
  })

  it('7. manual refresh updates refreshing state while preserving existing overview', async () => {
    const { result } = renderHook(() => useKnowledgeBaseOverview(kbId1))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.overview).toEqual(mockOverview1)

    const updatedOverview1: KnowledgeBaseOverviewDto = {
      ...mockOverview1,
      bots: { total: 4, active: 3, archived: 1 }
    }
    getOverviewMock.mockResolvedValueOnce(updatedOverview1)

    let refreshPromise: Promise<void>
    act(() => {
      refreshPromise = result.current.refresh()
    })

    // During refresh, refreshing is true and overview remains visible
    expect(result.current.refreshing).toBe(true)
    expect(result.current.overview).toEqual(mockOverview1)

    await act(async () => {
      await refreshPromise
    })

    expect(result.current.refreshing).toBe(false)
    expect(result.current.overview).toEqual(updatedOverview1)
  })

  it('8. does not update state after component unmounts', async () => {
    let resolvePending!: (value: KnowledgeBaseOverviewDto) => void
    const pendingPromise = new Promise<KnowledgeBaseOverviewDto>((resolve) => {
      resolvePending = resolve
    })
    getOverviewMock.mockReturnValueOnce(pendingPromise)

    const { result, unmount } = renderHook(() => useKnowledgeBaseOverview(kbId1))

    expect(result.current.loading).toBe(true)

    // Unmount before completion
    unmount()

    // Resolve after unmount
    await act(async () => {
      resolvePending(mockOverview1)
    })

    // No error or warning thrown
  })
})

