// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
  type RenderResult
} from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { WorkspaceBotsPage } from './WorkspaceBotsPage'
import type { WorkspaceOutletContext } from '../../components/kb/KnowledgeBaseWorkspaceLayout'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'
import type {
  BotDto,
  CreateBotRequest,
  UpdateBotRequest,
  DeleteBotResultDto,
  BotApi,
  ListBotsRequest
} from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'

describe('WorkspaceBotsPage Integration (Phase 6 Step 6.6)', () => {
  const activeKb: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'Knowledge base for local research and testing',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const sampleActiveBot: BotDto = {
    id: 'bot-1111-1111-1111-111111111111',
    knowledgeBaseId: activeKb.id,
    name: 'Research Assistant',
    description: 'Answers research questions using documents',
    systemPrompt: 'You are an intelligent research assistant.',
    providerConnectionId: 'conn-openai-01',
    modelId: 'gpt-6-luna',
    responsePolicy: 'balanced_kb_first',
    enabledTools: ['search_knowledge_base', 'read_knowledge_base_document'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleArchivedBot: BotDto = {
    id: 'bot-2222-2222-2222-222222222222',
    knowledgeBaseId: activeKb.id,
    name: 'Old Archival Bot',
    description: 'No longer in service',
    systemPrompt: 'You are an archived bot.',
    providerConnectionId: null,
    modelId: 'gpt-6-luna',
    responsePolicy: 'balanced_kb_first',
    enabledTools: [],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  const mockCatalog: ProviderCatalogDto = {
    providers: [
      {
        id: 'openai',
        displayName: 'OpenAI',
        description: 'OpenAI models',
        docUrl: 'https://openai.com',
        isSupported: true,
        defaultModelId: 'gpt-6-luna'
      }
    ],
    models: [
      {
        id: 'gpt-6-luna',
        providerId: 'openai',
        displayName: 'GPT-6 Luna',
        description: 'Fast reasoning model',
        availability: 'stable',
        capabilities: { streaming: true, tools: true, imageInput: false, structuredOutput: true },
        docUrl: 'https://openai.com'
      }
    ]
  }

  const mockConnections: readonly ProviderConnectionSummary[] = [
    {
      id: 'conn-openai-01',
      providerId: 'openai',
      label: 'OpenAI Primary',
      status: 'active',
      hasCredential: true,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    }
  ]

  let currentBots: BotDto[] = []
  let listMock: ReturnType<typeof vi.fn>
  let getMock: ReturnType<typeof vi.fn>
  let createMock: ReturnType<typeof vi.fn>
  let updateMock: ReturnType<typeof vi.fn>
  let archiveMock: ReturnType<typeof vi.fn>
  let unarchiveMock: ReturnType<typeof vi.fn>
  let deleteMock: ReturnType<typeof vi.fn>
  let activateWorkspaceMock: ReturnType<typeof vi.fn>
  let deactivateWorkspaceMock: ReturnType<typeof vi.fn>

  let getCatalogMock: ReturnType<typeof vi.fn>
  let listConnectionsMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    currentBots = [sampleActiveBot, sampleArchivedBot]

    listMock = vi.fn(async (options?: ListBotsRequest) => {
      if (options?.status) {
        return currentBots.filter((b) => b.status === options.status)
      }
      return [...currentBots]
    })

    getMock = vi.fn(async (botId: string) => {
      return currentBots.find((b) => b.id === botId) ?? null
    })

    createMock = vi.fn(async (request: CreateBotRequest) => {
      const newBot: BotDto = {
        id: 'bot-new-' + Math.random().toString(36).substring(2, 9),
        knowledgeBaseId: activeKb.id,
        name: request.name,
        description: request.description ?? '',
        systemPrompt: request.systemPrompt ?? '',
        providerConnectionId: request.providerConnectionId ?? null,
        modelId: request.modelId,
        responsePolicy: request.responsePolicy ?? 'balanced_kb_first',
        enabledTools: request.enabledTools ?? [],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      currentBots = [newBot, ...currentBots]
      return newBot
    })

    updateMock = vi.fn(async (botId: string, request: UpdateBotRequest) => {
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
        responsePolicy: request.responsePolicy ?? existing.responsePolicy,
        enabledTools: request.enabledTools ?? existing.enabledTools,
        updatedAt: Date.now()
      }
      currentBots[idx] = updated
      return updated
    })

    archiveMock = vi.fn(async (botId: string) => {
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

    unarchiveMock = vi.fn(async (botId: string) => {
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

    deleteMock = vi.fn(async (botId: string): Promise<DeleteBotResultDto> => {
      const idx = currentBots.findIndex((b) => b.id === botId)
      if (idx === -1) {
        throw new BotBridgeError('Bot not found', 'BOT_NOT_FOUND')
      }
      currentBots.splice(idx, 1)
      return { success: true, botId }
    })

    activateWorkspaceMock = vi.fn(async (kbId: string) => ({
      ...activeKb,
      id: kbId
    }))

    deactivateWorkspaceMock = vi.fn(async () => {})

    getCatalogMock = vi.fn(async () => mockCatalog)
    listConnectionsMock = vi.fn(async () => mockConnections)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      bots: {
        list: listMock,
        get: getMock,
        create: createMock,
        update: updateMock,
        archive: archiveMock,
        unarchive: unarchiveMock,
        delete: deleteMock,
        activateWorkspace: activateWorkspaceMock,
        deactivateWorkspace: deactivateWorkspaceMock
      } as BotApi,
      providers: {
        getCatalog: getCatalogMock,
        listConnections: listConnectionsMock
      }
    }
  })

  afterEach(() => {
    cleanup()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
    vi.restoreAllMocks()
  })

  function renderPage(outletContext: Partial<WorkspaceOutletContext> = {}): RenderResult {
    const fullContext: WorkspaceOutletContext = {
      knowledgeBase: activeKb,
      isWorkspaceActivated: true,
      workspaceActivationError: null,
      ...outletContext
    }

    return render(
      <MemoryRouter initialEntries={[`/knowledge-bases/${activeKb.id}/bots`]}>
        <Routes>
          <Route path="/knowledge-bases/:kbId" element={<Outlet context={fullContext} />}>
            <Route path="bots" element={<WorkspaceBotsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  }

  // ---------------------------------------------------------------------------
  // 1. Heading, Subtitle & Initial Bot Display
  // ---------------------------------------------------------------------------
  describe('1. Heading, Subtitle & Initial Bot Display', () => {
    it('renders page title and active KB name in the subtitle', async () => {
      renderPage()

      expect(screen.getByTestId('workspace-bots-heading')).toBeDefined()
      expect(screen.getByText('AI Bots')).toBeDefined()
      expect(screen.getByText('Research Workspace')).toBeDefined()

      await waitFor(() => {
        expect(listMock).toHaveBeenCalled()
      })

      expect(await screen.findByText('Research Assistant')).toBeDefined()
      expect(screen.getByText('Old Archival Bot')).toBeDefined()
    })

    it('renders empty state when knowledge base contains no bots', async () => {
      currentBots = []
      renderPage()

      await waitFor(() => {
        expect(listMock).toHaveBeenCalled()
      })

      expect(await screen.findByTestId('bot-list-empty')).toBeDefined()
      expect(screen.getByText('No Bots created yet')).toBeDefined()
    })

    it('displays loading state while bot list request is pending', () => {
      listMock.mockReturnValueOnce(new Promise(() => {}))
      renderPage()

      expect(screen.getByTestId('bot-list-loading')).toBeDefined()
    })

    it('displays error banner and retry button when fetching bots fails', async () => {
      listMock.mockRejectedValueOnce(new Error('Failed to query bots database'))
      renderPage()

      expect(await screen.findByTestId('bot-list-error')).toBeDefined()
      expect(screen.getByText(/Failed to query bots database/)).toBeDefined()

      const retryBtn = screen.getByTestId('bot-list-retry')
      expect(retryBtn).toBeDefined()

      // Click retry
      fireEvent.click(retryBtn)
      await waitFor(() => {
        expect(listMock).toHaveBeenCalledTimes(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Filter Toolbar and Counts
  // ---------------------------------------------------------------------------
  describe('2. Filter Toolbar and Counts', () => {
    it('switches between All, Active, and Archived filters', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Research Assistant')).toBeDefined()
      })

      // Count indicator shows 2 bots
      expect(screen.getByTestId('bots-count-indicator').textContent).toBe('2 bots')

      // Switch to Active filter
      const activeFilterBtn = screen.getByTestId('filter-active')
      fireEvent.click(activeFilterBtn)

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledWith({ status: 'active' })
      })

      // Switch to Archived filter
      const archivedFilterBtn = screen.getByTestId('filter-archived')
      fireEvent.click(archivedFilterBtn)

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledWith({ status: 'archived' })
      })

      // Switch back to All Bots
      const allFilterBtn = screen.getByTestId('filter-all')
      fireEvent.click(allFilterBtn)

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledWith(undefined)
      })
    })

    it('calls refresh when clicking the refresh button', async () => {
      renderPage()

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledTimes(1)
      })

      const refreshBtn = screen.getByTestId('refresh-bots-btn')
      fireEvent.click(refreshBtn)

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledTimes(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Create Bot Workflow
  // ---------------------------------------------------------------------------
  describe('3. Create Bot Workflow', () => {
    it('opens CreateBotModal and creates a new Bot without knowledgeBaseId in payload', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Research Assistant')).toBeDefined()
      })

      const createBtn = screen.getByTestId('create-bot-btn')
      fireEvent.click(createBtn)

      // Modal is now open
      expect(await screen.findByTestId('create-bot-modal')).toBeDefined()

      // Fill in bot form
      const nameInput = screen.getByTestId('bot-name-input')
      fireEvent.change(nameInput, { target: { value: 'New Test Bot' } })

      const descInput = screen.getByTestId('bot-description-input')
      fireEvent.change(descInput, { target: { value: 'Test description' } })

      // Wait for provider metadata to load
      await waitFor(() => {
        expect(screen.getByTestId('bot-model-select')).not.toBeNull()
      })

      // Submit form
      const submitBtn = screen.getByTestId('bot-form-submit-btn')
      await act(async () => {
        fireEvent.click(submitBtn)
      })

      await waitFor(() => {
        expect(createMock).toHaveBeenCalled()
      })

      // Verify that createMock received request strictly without knowledgeBaseId
      const createPayload = createMock.mock.calls[0][0] as CreateBotRequest
      expect(createPayload.name).toBe('New Test Bot')
      expect(createPayload.description).toBe('Test description')
      expect(createPayload.modelId).toBe('gpt-6-luna')
      // Critical invariant: renderer never provides knowledgeBaseId
      expect((createPayload as unknown as Record<string, unknown>).knowledgeBaseId).toBeUndefined()

      // Verify modal closes and new bot appears in the list
      await waitFor(() => {
        expect(screen.queryByTestId('create-bot-modal')).toBeNull()
        expect(screen.getByText('New Test Bot')).toBeDefined()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Edit Bot Workflow
  // ---------------------------------------------------------------------------
  describe('4. Edit Bot Workflow', () => {
    it('opens EditBotModal and updates existing Bot', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Research Assistant')).toBeDefined()
      })

      const editBtn = screen.getByTestId(`bot-card-edit-btn-${sampleActiveBot.id}`)
      fireEvent.click(editBtn)

      // Edit modal open
      expect(await screen.findByTestId('edit-bot-modal')).toBeDefined()

      const nameInput = screen.getByTestId('bot-name-input')
      expect((nameInput as HTMLInputElement).value).toBe('Research Assistant')

      fireEvent.change(nameInput, { target: { value: 'Updated Assistant' } })

      const submitBtn = screen.getByTestId('bot-form-submit-btn')
      await act(async () => {
        fireEvent.click(submitBtn)
      })

      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith(
          sampleActiveBot.id,
          expect.objectContaining({ name: 'Updated Assistant' })
        )
      })

      await waitFor(() => {
        expect(screen.queryByTestId('edit-bot-modal')).toBeNull()
        expect(screen.getByText('Updated Assistant')).toBeDefined()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Lifecycle Dialogs: Archive, Unarchive, and Permanent Delete
  // ---------------------------------------------------------------------------
  describe('5. Lifecycle Dialogs', () => {
    it('archives an active Bot through BotArchiveDialog', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Research Assistant')).toBeDefined()
      })

      const archiveBtn = screen.getByTestId(`bot-card-archive-btn-${sampleActiveBot.id}`)
      fireEvent.click(archiveBtn)

      expect(await screen.findByTestId('archive-bot-dialog')).toBeDefined()
      expect(screen.getByText(/Archive Bot: Research Assistant/)).toBeDefined()

      const confirmBtn = screen.getByTestId('archive-bot-confirm-btn')
      await act(async () => {
        fireEvent.click(confirmBtn)
      })

      await waitFor(() => {
        expect(archiveMock).toHaveBeenCalledWith(sampleActiveBot.id)
      })

      await waitFor(() => {
        expect(screen.queryByTestId('archive-bot-dialog')).toBeNull()
      })
    })

    it('unarchives an archived Bot through BotUnarchiveDialog', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Old Archival Bot')).toBeDefined()
      })

      const unarchiveBtn = screen.getByTestId(`bot-card-unarchive-btn-${sampleArchivedBot.id}`)
      fireEvent.click(unarchiveBtn)

      expect(await screen.findByTestId('unarchive-bot-dialog')).toBeDefined()
      expect(screen.getByText(/Restore Bot: Old Archival Bot/)).toBeDefined()

      const confirmBtn = screen.getByTestId('unarchive-bot-confirm-btn')
      await act(async () => {
        fireEvent.click(confirmBtn)
      })

      await waitFor(() => {
        expect(unarchiveMock).toHaveBeenCalledWith(sampleArchivedBot.id)
      })

      await waitFor(() => {
        expect(screen.queryByTestId('unarchive-bot-dialog')).toBeNull()
      })
    })

    it('permanently deletes a Bot through BotDeleteDialog after confirming bot name', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Old Archival Bot')).toBeDefined()
      })

      const deleteBtn = screen.getByTestId(`bot-card-delete-btn-${sampleArchivedBot.id}`)
      fireEvent.click(deleteBtn)

      expect(await screen.findByTestId('delete-bot-dialog')).toBeDefined()

      const confirmInput = screen.getByTestId('confirm-delete-bot-input')
      const confirmDeleteBtn = screen.getByTestId('delete-bot-confirm-btn')

      // Initially disabled until name is typed
      expect((confirmDeleteBtn as HTMLButtonElement).disabled).toBe(true)

      // Type confirmation name
      fireEvent.change(confirmInput, { target: { value: 'Old Archival Bot' } })
      expect((confirmDeleteBtn as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        fireEvent.click(confirmDeleteBtn)
      })

      await waitFor(() => {
        expect(deleteMock).toHaveBeenCalledWith(sampleArchivedBot.id)
      })

      await waitFor(() => {
        expect(screen.queryByTestId('delete-bot-dialog')).toBeNull()
        expect(screen.queryByText('Old Archival Bot')).toBeNull()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Main Process Workspace Synchronization State Handling
  // ---------------------------------------------------------------------------
  describe('6. Workspace Synchronization State Handling', () => {
    it('shows activating state and does not call list when isWorkspaceActivated is false', () => {
      renderPage({ isWorkspaceActivated: false })

      expect(screen.getByTestId('workspace-activating-state')).toBeDefined()
      expect(screen.getByText('Synchronizing workspace context...')).toBeDefined()

      // Verify that list was NOT called because enabled was false
      expect(listMock).not.toHaveBeenCalled()

      // Create Bot button is disabled
      expect((screen.getByTestId('create-bot-btn') as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByTestId('refresh-bots-btn') as HTMLButtonElement).disabled).toBe(true)
    })

    it('displays error banner and disables actions when workspaceActivationError is present', () => {
      renderPage({
        isWorkspaceActivated: false,
        workspaceActivationError: 'Knowledge base folder inaccessible'
      })

      expect(screen.getByTestId('workspace-activation-error')).toBeDefined()
      expect(screen.getByText(/Knowledge base folder inaccessible/)).toBeDefined()

      // Create button is disabled
      expect((screen.getByTestId('create-bot-btn') as HTMLButtonElement).disabled).toBe(true)
      expect(listMock).not.toHaveBeenCalled()
    })
  })

  describe('Step 12.3: Response Policy Creation, Editing & Header/Card Independence', () => {
    it('creates a Bot with explicit responsePolicy, shows parent KB context, and updates policy independently of tools', async () => {
      renderPage()

      await waitFor(() => {
        expect(screen.getByText('Research Assistant')).toBeDefined()
      })

      // 1. Open Create modal and verify parent KB context + Balanced default
      fireEvent.click(screen.getByTestId('create-bot-btn'))
      await waitFor(() => {
        expect(screen.getByTestId('create-bot-modal')).toBeDefined()
      })
      expect(screen.getByTestId('parent-kb-indicator').textContent).toContain('Research Workspace')

      const strictRadio = screen
        .getByTestId('policy-option-strict_kb_only')
        .querySelector('input') as HTMLInputElement
      fireEvent.click(strictRadio)
      fireEvent.change(screen.getByTestId('bot-name-input'), {
        target: { value: 'Strict Workspace Bot' }
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
      })

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Strict Workspace Bot',
          responsePolicy: 'strict_kb_only'
        })
      )

      // 2. Edit Research Assistant to General AI Chat without altering enabledTools
      await waitFor(() => {
        expect(screen.getByText('Strict Workspace Bot')).toBeDefined()
      })

      fireEvent.click(screen.getByTestId(`bot-card-edit-btn-${sampleActiveBot.id}`))

      await waitFor(() => {
        expect(screen.getByTestId('edit-bot-modal')).toBeDefined()
      })

      const generalRadio = screen
        .getByTestId('policy-option-general_ai_chat')
        .querySelector('input') as HTMLInputElement
      fireEvent.click(generalRadio)

      await act(async () => {
        fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
      })

      expect(updateMock).toHaveBeenCalledWith(
        sampleActiveBot.id,
        expect.objectContaining({
          responsePolicy: 'general_ai_chat',
          enabledTools: ['search_knowledge_base', 'read_knowledge_base_document']
        })
      )
    })
  })
})
