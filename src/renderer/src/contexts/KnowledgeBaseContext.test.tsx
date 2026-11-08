// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode, ReactElement } from 'react'
import {
  KnowledgeBaseProvider,
  useKnowledgeBases,
  ACTIVE_KB_STORAGE_KEY,
  safeGetLocalStorage,
  safeSetLocalStorage,
  safeRemoveLocalStorage
} from './KnowledgeBaseContext'
import type {
  KnowledgeBaseDto,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResult,
  KnowledgeBaseApi
} from '../../../shared/knowledge-bases'
import { KnowledgeBaseBridgeError } from '../../../shared/knowledge-bases'

describe('Renderer: KnowledgeBaseContext & State Management (Phase 4 Step 4.3)', () => {
  const activeKb1: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'Core research documents and notes',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const activeKb2: KnowledgeBaseDto = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Engineering Workspace',
    description: 'Technical specs and runbooks',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const archivedKb: KnowledgeBaseDto = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Legacy Project',
    description: 'Archived legacy documents',
    createdAt: 1690000000000,
    updatedAt: 1695000000000,
    archivedAt: 1695000000000
  }

  // Memory-backed storage implementation for hermetic test execution
  class MemoryStorage implements Storage {
    private store = new Map<string, string>()

    public get length(): number {
      return this.store.size
    }

    public clear(): void {
      this.store.clear()
    }

    public getItem(key: string): string | null {
      return this.store.get(key) ?? null
    }

    public setItem(key: string, value: string): void {
      this.store.set(key, String(value))
    }

    public removeItem(key: string): void {
      this.store.delete(key)
    }

    public key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null
    }
  }

  interface MockApiResult {
    api: KnowledgeBaseApi
    listMock: ReturnType<typeof vi.fn>
    getByIdMock: ReturnType<typeof vi.fn>
    createMock: ReturnType<typeof vi.fn>
    updateMock: ReturnType<typeof vi.fn>
    archiveMock: ReturnType<typeof vi.fn>
    unarchiveMock: ReturnType<typeof vi.fn>
    deleteMock: ReturnType<typeof vi.fn>
  }

  let memoryStorage: MemoryStorage
  let mockApi: MockApiResult

  function createMockApi(initialKbs: KnowledgeBaseDto[] = []): MockApiResult {
    let currentKbs = [...initialKbs]

    const listMock = vi.fn(async () => [...currentKbs])
    const getByIdMock = vi.fn(async (id: string) => currentKbs.find((kb) => kb.id === id) ?? null)
    const createMock = vi.fn(async (input: CreateKnowledgeBaseRequest) => {
      const newKb: KnowledgeBaseDto = {
        id: '44444444-4444-4444-8444-444444444444',
        name: input.name,
        description: input.description ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null
      }
      currentKbs = [newKb, ...currentKbs]
      return newKb
    })
    const updateMock = vi.fn(async (id: string, input: UpdateKnowledgeBaseRequest) => {
      const existing = currentKbs.find((kb) => kb.id === id)
      if (!existing) return null
      const updated: KnowledgeBaseDto = {
        ...existing,
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        updatedAt: Date.now()
      }
      currentKbs = currentKbs.map((kb) => (kb.id === id ? updated : kb))
      return updated
    })
    const archiveMock = vi.fn(async (id: string) => {
      const existing = currentKbs.find((kb) => kb.id === id)
      if (!existing) return null
      const archived: KnowledgeBaseDto = {
        ...existing,
        archivedAt: Date.now(),
        updatedAt: Date.now()
      }
      currentKbs = currentKbs.map((kb) => (kb.id === id ? archived : kb))
      return archived
    })
    const unarchiveMock = vi.fn(async (id: string) => {
      const existing = currentKbs.find((kb) => kb.id === id)
      if (!existing) return null
      const unarchived: KnowledgeBaseDto = {
        ...existing,
        archivedAt: null,
        updatedAt: Date.now()
      }
      currentKbs = currentKbs.map((kb) => (kb.id === id ? unarchived : kb))
      return unarchived
    })
    const deleteMock = vi.fn(async (id: string): Promise<DeleteKnowledgeBaseResult> => {
      const exists = currentKbs.some((kb) => kb.id === id)
      if (!exists) {
        return {
          success: false,
          directoryCleaned: false,
          cleanupPending: false,
          code: 'NOT_FOUND',
          error: 'Not found'
        }
      }
      currentKbs = currentKbs.filter((kb) => kb.id !== id)
      return {
        success: true,
        directoryCleaned: true,
        cleanupPending: false
      }
    })

    const api: KnowledgeBaseApi = {
      list: listMock,
      getById: getByIdMock,
      create: createMock,
      update: updateMock,
      archive: archiveMock,
      unarchive: unarchiveMock,
      delete: deleteMock
    }

    return {
      api,
      listMock,
      getByIdMock,
      createMock,
      updateMock,
      archiveMock,
      unarchiveMock,
      deleteMock
    }
  }

  beforeEach(() => {
    memoryStorage = new MemoryStorage()
    mockApi = createMockApi([activeKb1, activeKb2, archivedKb])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  // Test Consumer Helper Component
  function TestConsumer(): ReactElement {
    const {
      knowledgeBases,
      activeKnowledgeBase,
      activeKnowledgeBaseId,
      loading,
      initialized,
      error,
      refresh,
      selectKnowledgeBase,
      createKnowledgeBase,
      updateKnowledgeBase,
      archiveKnowledgeBase,
      unarchiveKnowledgeBase,
      deleteKnowledgeBase,
      clearError
    } = useKnowledgeBases()

    return (
      <div>
        <div data-testid="loading">{loading ? 'loading' : 'idle'}</div>
        <div data-testid="initialized">{initialized ? 'initialized' : 'uninitialized'}</div>
        <div data-testid="error">{error ?? 'none'}</div>
        <div data-testid="kb-count">{knowledgeBases.length}</div>
        <div data-testid="active-id">{activeKnowledgeBaseId ?? 'none'}</div>
        <div data-testid="active-name">{activeKnowledgeBase?.name ?? 'none'}</div>

        <button
          onClick={() => {
            refresh().catch(() => {})
          }}
          data-testid="btn-refresh"
        >
          Refresh
        </button>
        <button onClick={() => selectKnowledgeBase(activeKb1.id)} data-testid="btn-select-1">
          Select KB1
        </button>
        <button onClick={() => selectKnowledgeBase(activeKb2.id)} data-testid="btn-select-2">
          Select KB2
        </button>
        <button
          onClick={() => selectKnowledgeBase(archivedKb.id)}
          data-testid="btn-select-archived"
        >
          Select Archived
        </button>
        <button onClick={() => selectKnowledgeBase(null)} data-testid="btn-select-null">
          Select Null
        </button>
        <button
          onClick={() => {
            createKnowledgeBase({ name: 'Created KB', description: 'Desc' }).catch(() => {})
          }}
          data-testid="btn-create"
        >
          Create
        </button>
        <button
          onClick={() => {
            updateKnowledgeBase(activeKb1.id, { name: 'Renamed KB1' }).catch(() => {})
          }}
          data-testid="btn-update-1"
        >
          Update KB1
        </button>
        <button
          onClick={() => {
            archiveKnowledgeBase(activeKb1.id).catch(() => {})
          }}
          data-testid="btn-archive-1"
        >
          Archive KB1
        </button>
        <button
          onClick={() => {
            unarchiveKnowledgeBase(archivedKb.id).catch(() => {})
          }}
          data-testid="btn-unarchive"
        >
          Unarchive
        </button>
        <button
          onClick={() => {
            deleteKnowledgeBase(activeKb1.id).catch(() => {})
          }}
          data-testid="btn-delete-1"
        >
          Delete KB1
        </button>
        <button onClick={clearError} data-testid="btn-clear-error">
          Clear Error
        </button>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 1. Initialization & Persistence Tests
  // ---------------------------------------------------------------------------
  describe('1. Initialization & Workspace Persistence', () => {
    it('initializes and loads active and archived Knowledge Bases', async () => {
      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      expect(screen.getByTestId('loading').textContent).toBe('loading')

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('loading').textContent).toBe('idle')
      expect(screen.getByTestId('initialized').textContent).toBe('initialized')
      expect(screen.getByTestId('kb-count').textContent).toBe('3')
      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(mockApi.listMock).toHaveBeenCalledWith({ includeArchived: true })
    })

    it('restores a valid previously persisted active Knowledge Base ID', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)
      expect(screen.getByTestId('active-name').textContent).toBe(activeKb1.name)
    })

    it('clears persisted selection if the saved ID does not exist in collection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, 'non-existent-uuid-9999')

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(screen.getByTestId('active-name').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('clears persisted selection if the saved ID points to an archived Knowledge Base', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, archivedKb.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(screen.getByTestId('active-name').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('gracefully handles localStorage failures without crashing', async () => {
      const faultyStorage: Storage = {
        length: 0,
        clear: vi.fn(),
        getItem: vi.fn(() => {
          throw new Error('Storage access denied')
        }),
        setItem: vi.fn(() => {
          throw new Error('Quota exceeded')
        }),
        removeItem: vi.fn(() => {
          throw new Error('Storage failure')
        }),
        key: vi.fn(() => null)
      }

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={faultyStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('initialized').textContent).toBe('initialized')
      expect(screen.getByTestId('kb-count').textContent).toBe('3')
      expect(screen.getByTestId('active-id').textContent).toBe('none')
    })

    it('captures initialization errors from the API safely', async () => {
      mockApi.listMock.mockRejectedValueOnce(
        new KnowledgeBaseBridgeError('Failed to fetch knowledge bases', 'FETCH_FAILED')
      )

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('initialized').textContent).toBe('initialized')
      expect(screen.getByTestId('loading').textContent).toBe('idle')
      expect(screen.getByTestId('error').textContent).toBe('Failed to fetch knowledge bases')
      expect(screen.getByTestId('kb-count').textContent).toBe('0')
    })

    it('handles missing window.api gracefully in environments without preload', async () => {
      render(
        <KnowledgeBaseProvider api={undefined} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('initialized').textContent).toBe('initialized')
      expect(screen.getByTestId('error').textContent).toContain('unavailable')
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Selection Tests
  // ---------------------------------------------------------------------------
  describe('2. Active Workspace Selection', () => {
    it('selects an active Knowledge Base and persists only its UUID', async () => {
      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        screen.getByTestId('btn-select-1').click()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)
      expect(screen.getByTestId('active-name').textContent).toBe(activeKb1.name)
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb1.id)
    })

    it('selecting null clears active workspace and storage', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)

      act(() => {
        screen.getByTestId('btn-select-null').click()
      })

      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(screen.getByTestId('active-name').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('ignores attempts to select an unknown Knowledge Base', async () => {
      const { result } = renderHook(() => useKnowledgeBases(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
            {children}
          </KnowledgeBaseProvider>
        )
      })

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        result.current.selectKnowledgeBase(activeKb1.id)
      })
      expect(result.current.activeKnowledgeBaseId).toBe(activeKb1.id)

      // Attempt to select invalid unknown ID
      act(() => {
        result.current.selectKnowledgeBase('invalid-uuid-0000')
      })

      // Selection must remain activeKb1, not change to invalid
      expect(result.current.activeKnowledgeBaseId).toBe(activeKb1.id)
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb1.id)
    })

    it('ignores attempts to select an archived Knowledge Base', async () => {
      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        screen.getByTestId('btn-select-archived').click()
      })

      // Archived KB cannot become active workspace
      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Creation & Updating Tests
  // ---------------------------------------------------------------------------
  describe('3. Creation and Update', () => {
    it('creates a new Knowledge Base and updates the context collection', async () => {
      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('kb-count').textContent).toBe('3')

      await act(async () => {
        screen.getByTestId('btn-create').click()
      })

      expect(mockApi.createMock).toHaveBeenCalledWith({
        name: 'Created KB',
        description: 'Desc'
      })
      expect(screen.getByTestId('kb-count').textContent).toBe('4')
    })

    it('updates a Knowledge Base and reflects changes in context and active selection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-name').textContent).toBe(activeKb1.name)

      await act(async () => {
        screen.getByTestId('btn-update-1').click()
      })

      expect(mockApi.updateMock).toHaveBeenCalledWith(activeKb1.id, { name: 'Renamed KB1' })
      expect(screen.getByTestId('active-name').textContent).toBe('Renamed KB1')
    })

    it('failed creation captures error and preserves existing collection', async () => {
      mockApi.createMock.mockRejectedValueOnce(new Error('Network error creating KB'))

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        screen.getByTestId('btn-create').click()
      })

      expect(screen.getByTestId('kb-count').textContent).toBe('3')
      expect(screen.getByTestId('error').textContent).toBe('Network error creating KB')
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Archiving and Unarchiving Tests
  // ---------------------------------------------------------------------------
  describe('4. Archiving & Unarchiving', () => {
    it('archiving the active Knowledge Base automatically clears active selection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)

      await act(async () => {
        screen.getByTestId('btn-archive-1').click()
      })

      // Active selection must be cleared and removed from localStorage
      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(screen.getByTestId('active-name').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
      // Record remains in collection as archived
      expect(screen.getByTestId('kb-count').textContent).toBe('3')
    })

    it('archiving an inactive Knowledge Base preserves the active selection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb2.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb2.id)

      // Archive KB1 (not the active one)
      await act(async () => {
        screen.getByTestId('btn-archive-1').click()
      })

      // Active selection remains activeKb2
      expect(screen.getByTestId('active-id').textContent).toBe(activeKb2.id)
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb2.id)
    })

    it('unarchiving restores Knowledge Base but does not automatically select it', async () => {
      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        screen.getByTestId('btn-unarchive').click()
      })

      expect(mockApi.unarchiveMock).toHaveBeenCalledWith(archivedKb.id)
      // Must not automatically become active workspace
      expect(screen.getByTestId('active-id').textContent).toBe('none')
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Deletion Tests
  // ---------------------------------------------------------------------------
  describe('5. Deletion Semantics', () => {
    it('deleting active Knowledge Base removes it and clears active selection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)

      await act(async () => {
        screen.getByTestId('btn-delete-1').click()
      })

      expect(screen.getByTestId('kb-count').textContent).toBe('2')
      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('removes Knowledge Base when directory cleanup is pending because DB deletion succeeded', async () => {
      mockApi.deleteMock.mockResolvedValueOnce({
        success: true,
        directoryCleaned: false,
        cleanupPending: true
      })

      const { result } = renderHook(() => useKnowledgeBases(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
            {children}
          </KnowledgeBaseProvider>
        )
      })

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        result.current.selectKnowledgeBase(activeKb1.id)
      })
      expect(result.current.activeKnowledgeBaseId).toBe(activeKb1.id)

      let deleteResult: DeleteKnowledgeBaseResult | undefined
      await act(async () => {
        deleteResult = await result.current.deleteKnowledgeBase(activeKb1.id)
      })

      expect(deleteResult?.success).toBe(true)
      expect(deleteResult?.cleanupPending).toBe(true)

      // KB must be removed from context collection and selection cleared
      expect(result.current.knowledgeBases.some((kb) => kb.id === activeKb1.id)).toBe(false)
      expect(result.current.activeKnowledgeBaseId).toBeNull()
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('preserves collection and active selection when deletion fails with success: false', async () => {
      mockApi.deleteMock.mockResolvedValueOnce({
        success: false,
        directoryCleaned: false,
        cleanupPending: false,
        code: 'LOCKED',
        error: 'Database table locked'
      })

      const { result } = renderHook(() => useKnowledgeBases(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
            {children}
          </KnowledgeBaseProvider>
        )
      })

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        result.current.selectKnowledgeBase(activeKb1.id)
      })

      let deleteResult: DeleteKnowledgeBaseResult | undefined
      await act(async () => {
        deleteResult = await result.current.deleteKnowledgeBase(activeKb1.id)
      })

      expect(deleteResult?.success).toBe(false)
      // Collection and selection preserved
      expect(result.current.knowledgeBases.some((kb) => kb.id === activeKb1.id)).toBe(true)
      expect(result.current.activeKnowledgeBaseId).toBe(activeKb1.id)
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Consistency & Race Condition Tests
  // ---------------------------------------------------------------------------
  describe('6. Consistency, Refresh & Concurrency', () => {
    it('refresh reconciles externally deleted active Knowledge Base', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)

      // Simulate external deletion: next list call omits activeKb1
      mockApi.listMock.mockResolvedValueOnce([activeKb2, archivedKb])

      await act(async () => {
        screen.getByTestId('btn-refresh').click()
      })

      expect(screen.getByTestId('kb-count').textContent).toBe('2')
      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('refresh reconciles externally archived active Knowledge Base', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('active-id').textContent).toBe(activeKb1.id)

      // Simulate external archive: activeKb1 now has archivedAt timestamp
      const externallyArchived: KnowledgeBaseDto = {
        ...activeKb1,
        archivedAt: Date.now()
      }
      mockApi.listMock.mockResolvedValueOnce([externallyArchived, activeKb2])

      await act(async () => {
        screen.getByTestId('btn-refresh').click()
      })

      expect(screen.getByTestId('active-id').textContent).toBe('none')
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('prevents stale out-of-order refresh responses from overwriting newer state', async () => {
      let resolveFirst!: (value: KnowledgeBaseDto[]) => void
      let resolveSecond!: (value: KnowledgeBaseDto[]) => void

      const firstPromise = new Promise<KnowledgeBaseDto[]>((res) => {
        resolveFirst = res
      })
      const secondPromise = new Promise<KnowledgeBaseDto[]>((res) => {
        resolveSecond = res
      })

      const { result } = renderHook(() => useKnowledgeBases(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
            {children}
          </KnowledgeBaseProvider>
        )
      })

      // Wait for initial mount effect to complete
      await act(async () => {
        await Promise.resolve()
      })

      // Mock two sequential refresh requests
      mockApi.listMock
        .mockReturnValueOnce(firstPromise) // Slow first call
        .mockReturnValueOnce(secondPromise) // Fast second call

      let p1!: Promise<void>
      let p2!: Promise<void>

      act(() => {
        p1 = result.current.refresh().catch(() => {})
        p2 = result.current.refresh().catch(() => {})
      })

      // Resolve second (newer) call first with activeKb2 only
      await act(async () => {
        resolveSecond([activeKb2])
        await p2
      })

      expect(result.current.knowledgeBases.length).toBe(1)
      expect(result.current.knowledgeBases[0].id).toBe(activeKb2.id)

      // Now resolve the stale first call with both activeKb1 and activeKb2
      await act(async () => {
        resolveFirst([activeKb1, activeKb2])
        await p1
      })

      // Stale response must be discarded; length remains 1 (activeKb2)
      expect(result.current.knowledgeBases.length).toBe(1)
      expect(result.current.knowledgeBases[0].id).toBe(activeKb2.id)
    })

    it('throws error when useKnowledgeBases is called outside KnowledgeBaseProvider', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => {
        try {
          return useKnowledgeBases()
        } catch (err) {
          return err
        }
      })

      expect(result.current).toBeInstanceOf(Error)
      expect((result.current as Error).message).toBe(
        'useKnowledgeBases must be used within a KnowledgeBaseProvider'
      )

      consoleErrorSpy.mockRestore()
    })

    it('clears error state when clearError is called', async () => {
      mockApi.createMock.mockRejectedValueOnce(new Error('Sample error'))

      render(
        <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
          <TestConsumer />
        </KnowledgeBaseProvider>
      )

      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        screen.getByTestId('btn-create').click()
      })

      expect(screen.getByTestId('error').textContent).toBe('Sample error')

      act(() => {
        screen.getByTestId('btn-clear-error').click()
      })

      expect(screen.getByTestId('error').textContent).toBe('none')
    })
  })

  // ---------------------------------------------------------------------------
  // 7. localStorage Helpers Tests
  // ---------------------------------------------------------------------------
  describe('7. Safe Storage Helpers', () => {
    it('safeGetLocalStorage returns null if storage is undefined or throws', () => {
      expect(safeGetLocalStorage(undefined, 'key')).toBeNull()

      const faultyStorage = {
        getItem: () => {
          throw new Error('Access denied')
        }
      } as unknown as Storage
      expect(safeGetLocalStorage(faultyStorage, 'key')).toBeNull()
    })

    it('safeSetLocalStorage and safeRemoveLocalStorage do not throw on errors', () => {
      const faultyStorage = {
        setItem: () => {
          throw new Error('Quota exceeded')
        },
        removeItem: () => {
          throw new Error('Access denied')
        }
      } as unknown as Storage

      expect(() => safeSetLocalStorage(faultyStorage, 'key', 'val')).not.toThrow()
      expect(() => safeRemoveLocalStorage(faultyStorage, 'key')).not.toThrow()
    })
  })
})
