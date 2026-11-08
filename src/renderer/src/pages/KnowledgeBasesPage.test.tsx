// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import type { ReactElement } from 'react'
import { KnowledgeBasesPage } from './KnowledgeBasesPage'
import { KnowledgeBaseProvider, ACTIVE_KB_STORAGE_KEY } from '../contexts/KnowledgeBaseContext'
import type {
  KnowledgeBaseDto,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResult,
  KnowledgeBaseApi
} from '../../../shared/knowledge-bases'

describe('Renderer: KnowledgeBasesPage & Dashboard UI (Phase 4 Step 4.4)', () => {
  const activeKb1: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'Core research documents and AI notes',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const activeKb2: KnowledgeBaseDto = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Engineering Specs',
    description: 'Architecture documentation and runbooks',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const archivedKb: KnowledgeBaseDto = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Legacy Project',
    description: 'Archived historical documents',
    createdAt: 1690000000000,
    updatedAt: 1695000000000,
    archivedAt: 1695000000000
  }

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
          error: 'Knowledge Base not found'
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

  function renderPage(): ReactElement {
    return (
      <KnowledgeBaseProvider api={mockApi.api} storage={memoryStorage}>
        <KnowledgeBasesPage />
      </KnowledgeBaseProvider>
    )
  }

  beforeEach(() => {
    memoryStorage = new MemoryStorage()
    mockApi = createMockApi([activeKb1, activeKb2, archivedKb])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------------
  // 1. Dashboard, Listing & Filtering Tests
  // ---------------------------------------------------------------------------
  describe('1. Dashboard, Listing & Filtering', () => {
    it('renders page header, description, and create button', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: /knowledge bases/i })).toBeTruthy()
      })

      expect(
        screen.getByText(
          /organize your documents and shared knowledge in independent workspaces\./i
        )
      ).toBeTruthy()
      expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
    })

    it('displays all Knowledge Bases by default under the All filter', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      expect(screen.getByTestId(`kb-card-${activeKb2.id}`)).toBeTruthy()
      expect(screen.getByTestId(`kb-card-${archivedKb.id}`)).toBeTruthy()

      expect(screen.getByText('Research Workspace')).toBeTruthy()
      expect(screen.getByText('Engineering Specs')).toBeTruthy()
      expect(screen.getByText('Legacy Project')).toBeTruthy()
    })

    it('filters to Active Knowledge Bases only', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('filter-tab-active'))

      expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      expect(screen.getByTestId(`kb-card-${activeKb2.id}`)).toBeTruthy()
      expect(screen.queryByTestId(`kb-card-${archivedKb.id}`)).toBeNull()
    })

    it('filters to Archived Knowledge Bases only', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('filter-tab-archived'))

      expect(screen.queryByTestId(`kb-card-${activeKb1.id}`)).toBeNull()
      expect(screen.queryByTestId(`kb-card-${activeKb2.id}`)).toBeNull()
      expect(screen.getByTestId(`kb-card-${archivedKb.id}`)).toBeTruthy()
    })

    it('searches Knowledge Bases by name with case-insensitivity and whitespace trimming', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      const searchInput = screen.getByTestId('input-kb-search')
      fireEvent.change(searchInput, { target: { value: '  RESEARCH  ' } })

      expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      expect(screen.queryByTestId(`kb-card-${activeKb2.id}`)).toBeNull()
      expect(screen.queryByTestId(`kb-card-${archivedKb.id}`)).toBeNull()
    })

    it('searches Knowledge Bases by description content', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      const searchInput = screen.getByTestId('input-kb-search')
      fireEvent.change(searchInput, { target: { value: 'runbooks' } })

      expect(screen.getByTestId(`kb-card-${activeKb2.id}`)).toBeTruthy()
      expect(screen.queryByTestId(`kb-card-${activeKb1.id}`)).toBeNull()
    })

    it('shows empty search state when query matches nothing, and allows clearing search', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      })

      const searchInput = screen.getByTestId('input-kb-search')
      fireEvent.change(searchInput, { target: { value: 'nonexistent-query-string' } })

      expect(screen.getByTestId('empty-state-no-results')).toBeTruthy()
      expect(screen.getByText(/no matching knowledge bases/i)).toBeTruthy()

      // Click clear search button
      const clearBtn = screen.getByTestId('btn-reset-search')
      fireEvent.click(clearBtn)

      // All cards return
      expect(screen.getByTestId(`kb-card-${activeKb1.id}`)).toBeTruthy()
      expect(screen.getByTestId(`kb-card-${activeKb2.id}`)).toBeTruthy()
    })

    it('shows empty state when workspace has zero Knowledge Bases', async () => {
      mockApi = createMockApi([])
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('empty-state-no-kbs')).toBeTruthy()
      })

      expect(screen.getByText(/no knowledge bases yet/i)).toBeTruthy()
      expect(screen.getByTestId('btn-empty-create-kb')).toBeTruthy()
    })

    it('displays Active Workspace badge on currently selected Knowledge Base', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`badge-current-workspace-${activeKb1.id}`)).toBeTruthy()
      })

      expect(screen.getByTestId(`active-label-${activeKb1.id}`)).toBeTruthy()
      // KB2 should have a select workspace button
      expect(screen.getByTestId(`btn-select-workspace-${activeKb2.id}`)).toBeTruthy()
    })

    it('renders neutral placeholder when a Knowledge Base description is empty', async () => {
      const kbWithoutDesc: KnowledgeBaseDto = {
        ...activeKb1,
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Empty Description KB',
        description: ''
      }
      mockApi = createMockApi([kbWithoutDesc])
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByText('Empty Description KB')).toBeTruthy()
      })

      expect(screen.getByText('No description provided.')).toBeTruthy()
    })

    it('selects a Knowledge Base as active workspace when clicking Select Workspace', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-select-workspace-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-select-workspace-${activeKb1.id}`))

      expect(screen.getByTestId(`badge-current-workspace-${activeKb1.id}`)).toBeTruthy()
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb1.id)
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Creation Modal Tests
  // ---------------------------------------------------------------------------
  describe('2. Create Knowledge Base Modal', () => {
    it('opens create modal when clicking Create Knowledge Base button', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))
      expect(screen.getByTestId('create-kb-modal')).toBeTruthy()
      expect(screen.getByRole('heading', { level: 2, name: /create knowledge base/i })).toBeTruthy()
    })

    it('validates required name field and disables submit when empty', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))
      const submitBtn = screen.getByTestId('btn-submit-create-kb') as HTMLButtonElement
      expect(submitBtn.disabled).toBe(true)

      const nameInput = screen.getByTestId('input-create-kb-name')
      fireEvent.change(nameInput, { target: { value: '   ' } })
      expect(submitBtn.disabled).toBe(true)
    })

    it('creates Knowledge Base on valid input and updates dashboard cards', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))

      const nameInput = screen.getByTestId('input-create-kb-name')
      const descInput = screen.getByTestId('input-create-kb-description')

      fireEvent.change(nameInput, { target: { value: 'Machine Learning Notes' } })
      fireEvent.change(descInput, { target: { value: 'All notes and papers regarding ML' } })

      const submitBtn = screen.getByTestId('btn-submit-create-kb')
      expect((submitBtn as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        fireEvent.click(submitBtn)
      })

      expect(mockApi.createMock).toHaveBeenCalledWith({
        name: 'Machine Learning Notes',
        description: 'All notes and papers regarding ML'
      })

      // Modal closed and notification displayed
      await waitFor(() => {
        expect(screen.queryByTestId('create-kb-modal')).toBeNull()
      })
      expect(screen.getByTestId('kb-dashboard-notification')).toBeTruthy()
      expect(screen.getByRole('heading', { level: 3, name: 'Machine Learning Notes' })).toBeTruthy()
    })

    it('closes create modal on Cancel button click without mutating state', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))
      expect(screen.getByTestId('create-kb-modal')).toBeTruthy()

      fireEvent.click(screen.getByTestId('btn-cancel-create-kb'))
      expect(screen.queryByTestId('create-kb-modal')).toBeNull()
      expect(mockApi.createMock).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Edit Modal Tests
  // ---------------------------------------------------------------------------
  describe('3. Edit Knowledge Base Modal', () => {
    it('populates existing values into edit modal and saves updates', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-edit-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-edit-kb-${activeKb1.id}`))

      expect(screen.getByTestId('edit-kb-modal')).toBeTruthy()
      const nameInput = screen.getByTestId('input-edit-kb-name') as HTMLInputElement
      expect(nameInput.value).toBe(activeKb1.name)

      fireEvent.change(nameInput, { target: { value: 'Updated Research Workspace' } })

      const submitBtn = screen.getByTestId('btn-submit-edit-kb')
      await act(async () => {
        fireEvent.click(submitBtn)
      })

      expect(mockApi.updateMock).toHaveBeenCalledWith(activeKb1.id, {
        name: 'Updated Research Workspace',
        description: activeKb1.description
      })

      await waitFor(() => {
        expect(screen.queryByTestId('edit-kb-modal')).toBeNull()
      })
      expect(screen.getByText('Updated Research Workspace')).toBeTruthy()
    })

    it('rejects whitespace-only name in edit modal and preserves previous values on cancel', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-edit-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-edit-kb-${activeKb1.id}`))

      const nameInput = screen.getByTestId('input-edit-kb-name') as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: '   ' } })

      const submitBtn = screen.getByTestId('btn-submit-edit-kb') as HTMLButtonElement
      expect(submitBtn.disabled).toBe(true)

      // Cancel closes dialog without calling update
      fireEvent.click(screen.getByTestId('btn-cancel-edit-kb'))
      expect(screen.queryByTestId('edit-kb-modal')).toBeNull()
      expect(mockApi.updateMock).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Archive & Unarchive Tests
  // ---------------------------------------------------------------------------
  describe('4. Archive and Unarchive', () => {
    it('opens archive confirmation dialog with explanation', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-archive-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-archive-kb-${activeKb1.id}`))

      expect(screen.getByTestId('archive-kb-dialog')).toBeTruthy()
      expect(screen.getByText(/data is preserved/i)).toBeTruthy()
    })

    it('archiving active Knowledge Base clears active workspace selection', async () => {
      memoryStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb1.id)
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`badge-current-workspace-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-archive-kb-${activeKb1.id}`))
      expect(screen.getByText(/active workspace warning/i)).toBeTruthy()

      const confirmBtn = screen.getByTestId('btn-confirm-archive-kb')
      await act(async () => {
        fireEvent.click(confirmBtn)
      })

      expect(mockApi.archiveMock).toHaveBeenCalledWith(activeKb1.id)
      // Active workspace badge cleared
      expect(screen.queryByTestId(`badge-current-workspace-${activeKb1.id}`)).toBeNull()
      expect(memoryStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })

    it('unarchives an archived Knowledge Base and restores it to active list', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-unarchive-kb-${archivedKb.id}`)).toBeTruthy()
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId(`btn-unarchive-kb-${archivedKb.id}`))
      })

      expect(mockApi.unarchiveMock).toHaveBeenCalledWith(archivedKb.id)
      expect(screen.getByTestId('kb-dashboard-notification')).toBeTruthy()
      // Card is restored to active status
      expect(screen.getByTestId(`badge-active-${archivedKb.id}`)).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Deletion Tests
  // ---------------------------------------------------------------------------
  describe('5. Delete Knowledge Base Modal', () => {
    it('displays destructive warning, export recommendation, and requires exact name confirmation', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`))

      expect(screen.getByTestId('delete-kb-modal')).toBeTruthy()
      expect(screen.getByText(/this action cannot be undone/i)).toBeTruthy()
      expect(screen.getByTestId('export-warning-note')).toBeTruthy()

      const deleteBtn = screen.getByTestId('btn-confirm-delete-kb') as HTMLButtonElement
      expect(deleteBtn.disabled).toBe(true)

      const confirmInput = screen.getByTestId('input-confirm-delete-name')

      // Typing mismatched name
      fireEvent.change(confirmInput, { target: { value: 'Wrong Name' } })
      expect(deleteBtn.disabled).toBe(true)

      // Typing exact name
      fireEvent.change(confirmInput, { target: { value: activeKb1.name } })
      expect(deleteBtn.disabled).toBe(false)
    })

    it('successfully deletes Knowledge Base when confirmed with exact name', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`))

      const confirmInput = screen.getByTestId('input-confirm-delete-name')
      fireEvent.change(confirmInput, { target: { value: activeKb1.name } })

      const deleteBtn = screen.getByTestId('btn-confirm-delete-kb')
      await act(async () => {
        fireEvent.click(deleteBtn)
      })

      expect(mockApi.deleteMock).toHaveBeenCalledWith(activeKb1.id)

      await waitFor(() => {
        expect(screen.queryByTestId('delete-kb-modal')).toBeNull()
      })

      expect(screen.queryByTestId(`kb-card-${activeKb1.id}`)).toBeNull()
      expect(screen.getByTestId('kb-dashboard-notification')).toBeTruthy()
    })

    it('shows warning notification if deletion succeeds with cleanup pending', async () => {
      mockApi.deleteMock.mockResolvedValueOnce({
        success: true,
        directoryCleaned: false,
        cleanupPending: true
      })

      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`))

      const confirmInput = screen.getByTestId('input-confirm-delete-name')
      fireEvent.change(confirmInput, { target: { value: activeKb1.name } })

      const deleteBtn = screen.getByTestId('btn-confirm-delete-kb')
      await act(async () => {
        fireEvent.click(deleteBtn)
      })

      await waitFor(() => {
        expect(screen.queryByTestId('delete-kb-modal')).toBeNull()
      })

      // Removed from dashboard, notification warns about pending OS storage cleanup
      expect(screen.queryByTestId(`kb-card-${activeKb1.id}`)).toBeNull()
      const notification = screen.getByTestId('kb-dashboard-notification')
      expect(notification.textContent).toContain('cleanup is pending')
    })

    it('preserves Knowledge Base and displays error in modal if deletion fails with success: false', async () => {
      mockApi.deleteMock.mockResolvedValueOnce({
        success: false,
        directoryCleaned: false,
        cleanupPending: false,
        code: 'SQLITE_BUSY',
        error: 'Database table is currently locked'
      })

      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-delete-kb-${activeKb1.id}`))

      const confirmInput = screen.getByTestId('input-confirm-delete-name')
      fireEvent.change(confirmInput, { target: { value: activeKb1.name } })

      const deleteBtn = screen.getByTestId('btn-confirm-delete-kb')
      await act(async () => {
        fireEvent.click(deleteBtn)
      })

      expect(screen.getByTestId('delete-kb-modal')).toBeTruthy()
      expect(screen.getByTestId('delete-kb-error')).toBeTruthy()
      expect(screen.getByText(/database table is currently locked/i)).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Accessibility & Keyboard Interaction Tests
  // ---------------------------------------------------------------------------
  describe('6. Accessibility & Keyboard Interaction', () => {
    it('closes modal on Escape key press', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))
      const backdrop = screen.getByTestId('create-kb-modal-backdrop')
      expect(screen.getByTestId('create-kb-modal')).toBeTruthy()

      fireEvent.keyDown(backdrop, { key: 'Escape', code: 'Escape' })
      expect(screen.queryByTestId('create-kb-modal')).toBeNull()
    })

    it('has proper aria labels and dialog roles', async () => {
      render(renderPage())

      await waitFor(() => {
        expect(screen.getByTestId('btn-open-create-kb')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-open-create-kb'))
      const dialog = screen.getByRole('dialog')
      expect(dialog).toBeTruthy()
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(dialog.getAttribute('aria-labelledby')).toBe('create-kb-title')
    })
  })
})
