// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import App from '../App'
import { ACTIVE_KB_STORAGE_KEY } from '../contexts/KnowledgeBaseContext'
import type {
  KnowledgeBaseDto,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResult,
  KnowledgeBaseApi
} from '../../../shared/knowledge-bases'

describe('Renderer: Knowledge Base Workspace Shell & Navigation (Phase 4 Step 4.5)', () => {
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

  beforeEach(() => {
    localStorage.clear()
    window.location.hash = '#/'
    mockApi = createMockApi([activeKb1, activeKb2, archivedKb])

    // Mount mocked Preload API onto window.api.knowledgeBases
    Object.defineProperty(window, 'api', {
      value: {
        knowledgeBases: mockApi.api
      },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  // ---------------------------------------------------------------------------
  // 1. Nested Workspace Routing & Overview Redirection
  // ---------------------------------------------------------------------------
  describe('1. Nested Workspace Routing & Redirection', () => {
    it('redirects /knowledge-bases/:kbId to /knowledge-bases/:kbId/overview', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-overview-tab')).toBeTruthy()
      })

      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/overview`)
      expect(screen.getByRole('heading', { level: 1, name: 'Research Workspace' })).toBeTruthy()
      expect(screen.getByTestId('workspace-description').textContent).toBe(
        'Core research documents and AI notes'
      )
    })

    it('renders all five nested workspace tab shells with correct active state', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-overview-tab')).toBeTruthy()
      })

      // 1. Overview active by default
      const overviewTab = screen.getByTestId('tab-overview')
      const knowledgeTab = screen.getByTestId('tab-knowledge')
      const botsTab = screen.getByTestId('tab-bots')
      const activityTab = screen.getByTestId('tab-activity')
      const settingsTab = screen.getByTestId('tab-settings')

      expect(overviewTab.className).toContain('active')
      expect(knowledgeTab.className).not.toContain('active')

      // 2. Click Knowledge tab
      fireEvent.click(knowledgeTab)
      await waitFor(() => {
        expect(screen.getByTestId('workspace-knowledge-tab')).toBeTruthy()
      })
      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/knowledge`)
      expect(knowledgeTab.className).toContain('active')
      expect(overviewTab.className).not.toContain('active')

      // 3. Click Bots tab
      fireEvent.click(botsTab)
      await waitFor(() => {
        expect(screen.getByTestId('workspace-bots-tab')).toBeTruthy()
      })
      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/bots`)
      expect(botsTab.className).toContain('active')

      // 4. Click Activity tab
      fireEvent.click(activityTab)
      await waitFor(() => {
        expect(screen.getByTestId('workspace-activity-tab')).toBeTruthy()
      })
      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/activity`)
      expect(activityTab.className).toContain('active')

      // 5. Click Settings tab
      fireEvent.click(settingsTab)
      await waitFor(() => {
        expect(screen.getByTestId('workspace-settings-tab')).toBeTruthy()
      })
      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/settings`)
      expect(settingsTab.className).toContain('active')
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Workspace Isolation & Scoping
  // ---------------------------------------------------------------------------
  describe('2. Workspace Isolation & Scoping', () => {
    it('renders KB A workspace without displaying KB B data', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-title')).toBeTruthy()
      })

      expect(screen.getByTestId('workspace-title').textContent).toBe(activeKb1.name)
      expect(screen.queryByText(activeKb2.name)).toBeNull()
    })

    it('switches between workspaces and isolates metadata correctly', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/settings`
      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('settings-val-name')).toBeTruthy()
      })
      expect(screen.getByTestId('settings-val-name').textContent).toBe('Research Workspace')
      expect(screen.getByTestId('settings-val-id').textContent).toContain(activeKb1.id)

      // Switch to KB 2
      act(() => {
        window.location.hash = `#/knowledge-bases/${activeKb2.id}/settings`
      })
      rerender(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('settings-val-name').textContent).toBe('Engineering Specs')
      })
      expect(screen.getByTestId('settings-val-id').textContent).toContain(activeKb2.id)
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Disambiguation: Application Activity vs Workspace Activity
  // ---------------------------------------------------------------------------
  describe('3. Disambiguation: Global Activity vs Workspace Activity', () => {
    it('keeps global application Activity and workspace Activity routes completely distinct', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/activity`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-activity-tab')).toBeTruthy()
      })

      // The workspace activity tab explains scoped audit logs
      expect(screen.getByRole('heading', { level: 2, name: 'Workspace Activity' })).toBeTruthy()

      // Click global Activity link in sidebar
      const globalActivityLink = screen.getByRole('link', { name: 'Activity' })
      fireEvent.click(globalActivityLink)

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy()
      })
      expect(window.location.hash).toBe('#/activity')
      expect(
        screen.getByText(/keep track of work and activity across your workspace\./i)
      ).toBeTruthy()
      expect(screen.queryByTestId('workspace-activity-tab')).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Route Validation and Edge Cases
  // ---------------------------------------------------------------------------
  describe('4. Route Validation and Safety Guards', () => {
    it('shows safe invalid-uuid alert when URL contains non-UUID string', async () => {
      window.location.hash = '#/knowledge-bases/not-a-valid-uuid/overview'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-invalid-uuid')).toBeTruthy()
      })

      expect(
        screen.getByText(/the identifier “not-a-valid-uuid” is not a valid uuid format\./i)
      ).toBeTruthy()
      expect(screen.getByTestId('btn-invalid-uuid-return')).toBeTruthy()
    })

    it('shows safe not-found state when UUID does not exist', async () => {
      const nonExistentId = '99999999-9999-4999-8999-999999999999'
      window.location.hash = `#/knowledge-bases/${nonExistentId}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-not-found')).toBeTruthy()
      })

      expect(screen.getByRole('heading', { level: 2, name: 'Workspace Not Found' })).toBeTruthy()
      expect(screen.getByTestId('btn-return-kbs')).toBeTruthy()
    })

    it('redirects archived Knowledge Base to dashboard with explanatory warning notice', async () => {
      window.location.hash = `#/knowledge-bases/${archivedKb.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('knowledge-bases-page')).toBeTruthy()
        expect(
          screen.getByText(
            `Knowledge Base "${archivedKb.name}" is archived and must be restored before opening.`
          )
        ).toBeTruthy()
      })

      expect(window.location.hash).toBe('#/knowledge-bases')
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Dashboard "Open Workspace" Card Action
  // ---------------------------------------------------------------------------
  describe('5. Dashboard Open Action', () => {
    it('opens workspace when clicking Open Workspace button on dashboard card', async () => {
      window.location.hash = '#/knowledge-bases'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId(`btn-open-workspace-${activeKb1.id}`)).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId(`btn-open-workspace-${activeKb1.id}`))

      await waitFor(() => {
        expect(screen.getByTestId('workspace-overview-tab')).toBeTruthy()
      })

      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/overview`)
      expect(localStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb1.id)
    })

    it('does not render Open Workspace button on archived cards', async () => {
      window.location.hash = '#/knowledge-bases'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId(`kb-card-${archivedKb.id}`)).toBeTruthy()
      })

      expect(screen.queryByTestId(`btn-open-workspace-${archivedKb.id}`)).toBeNull()
      // Restore button must be present instead
      expect(screen.getByTestId(`btn-unarchive-kb-${archivedKb.id}`)).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Breadcrumbs Navigation
  // ---------------------------------------------------------------------------
  describe('6. Breadcrumb Navigation', () => {
    it('renders accurate breadcrumbs and updates active tab segment', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/knowledge`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('workspace-breadcrumbs')).toBeTruthy()
      })

      expect(screen.getByTestId('breadcrumb-link-kbs').textContent).toBe('Knowledge Bases')
      expect(screen.getByTestId('breadcrumb-link-workspace').textContent).toBe(activeKb1.name)
      expect(screen.getByTestId('breadcrumb-current-tab').textContent).toBe('Knowledge')

      // Click "Knowledge Bases" breadcrumb
      fireEvent.click(screen.getByTestId('breadcrumb-link-kbs'))
      await waitFor(() => {
        expect(screen.getByTestId('knowledge-bases-page')).toBeTruthy()
      })
      expect(window.location.hash).toBe('#/knowledge-bases')
    })

    it('clicking workspace name in breadcrumb returns to workspace overview', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/settings`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('breadcrumb-link-workspace')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('breadcrumb-link-workspace'))
      await waitFor(() => {
        expect(screen.getByTestId('workspace-overview-tab')).toBeTruthy()
      })
      expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb1.id}/overview`)
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Sidebar Workspace Section & Quick-Switcher
  // ---------------------------------------------------------------------------
  describe('7. Sidebar Workspace Indicator & Quick-Switcher', () => {
    it('shows "No workspace selected" in sidebar when no active workspace exists', async () => {
      window.location.hash = '#/home'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-workspace-empty')).toBeTruthy()
      })

      expect(screen.getByText('No workspace selected')).toBeTruthy()
      expect(screen.getByTestId('sidebar-link-choose-kb')).toBeTruthy()
    })

    it('shows active workspace name in sidebar when workspace is active', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-active-workspace-card')).toBeTruthy()
      })

      expect(
        within(screen.getByTestId('sidebar-active-workspace-card')).getByText(activeKb1.name)
      ).toBeTruthy()
      expect(screen.getByTestId('btn-sidebar-workspace-switcher')).toBeTruthy()
    })

    it('allows switching workspace via the sidebar quick-switcher dropdown', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('btn-sidebar-workspace-switcher')).toBeTruthy()
      })

      // Open quick-switcher dropdown
      fireEvent.click(screen.getByTestId('btn-sidebar-workspace-switcher'))
      expect(screen.getByTestId('workspace-switcher-dropdown')).toBeTruthy()

      // Non-archived KBs should be listed; archived should NOT be listed
      expect(screen.getByTestId(`switcher-item-${activeKb1.id}`)).toBeTruthy()
      expect(screen.getByTestId(`switcher-item-${activeKb2.id}`)).toBeTruthy()
      expect(screen.queryByTestId(`switcher-item-${archivedKb.id}`)).toBeNull()

      // Switch to KB 2
      fireEvent.click(screen.getByTestId(`switcher-item-${activeKb2.id}`))

      await waitFor(() => {
        expect(window.location.hash).toBe(`#/knowledge-bases/${activeKb2.id}/overview`)
      })

      expect(localStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBe(activeKb2.id)
      expect(screen.getByRole('heading', { level: 1, name: activeKb2.name })).toBeTruthy()
    })

    it('closes quick-switcher on Escape key', async () => {
      window.location.hash = `#/knowledge-bases/${activeKb1.id}/overview`
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('btn-sidebar-workspace-switcher')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('btn-sidebar-workspace-switcher'))
      expect(screen.getByTestId('workspace-switcher-dropdown')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('workspace-switcher-dropdown')).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Active Selection Persistence
  // ---------------------------------------------------------------------------
  describe('8. Active Workspace Persistence', () => {
    it('persists selected workspace across re-renders and respects localStorage', async () => {
      localStorage.setItem(ACTIVE_KB_STORAGE_KEY, activeKb2.id)
      window.location.hash = '#/home'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-active-workspace-card')).toBeTruthy()
      })

      expect(
        within(screen.getByTestId('sidebar-active-workspace-card')).getByText(activeKb2.name)
      ).toBeTruthy()
    })

    it('ignores archived workspace stored in localStorage and falls back to empty', async () => {
      localStorage.setItem(ACTIVE_KB_STORAGE_KEY, archivedKb.id)
      window.location.hash = '#/home'
      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-workspace-empty')).toBeTruthy()
      })

      expect(screen.getByText('No workspace selected')).toBeTruthy()
      expect(localStorage.getItem(ACTIVE_KB_STORAGE_KEY)).toBeNull()
    })
  })
})
