import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BOT_IPC_CHANNELS,
  type BotDto,
  type CreateBotRequest,
  type UpdateBotRequest,
  type DeleteBotResultDto,
  BotBridgeError
} from '../../shared/ipc'
import {
  registerBotIpcHandlers,
  registerFailingBotIpcHandlers,
  resetMonitoredSenders
} from './bot-handlers'
import { createBotsApi, createKnowledgeBasesApi, normalizeBotBridgeError } from '../../preload'
import { BotManagerService } from '../services/bot-manager'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ProviderRegistry } from '../providers/provider-registry'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'

// IPC registry for ipcMain mock
const mockIpcHandlers = new Map<
  string,
  (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
>()

vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
        ) => {
          mockIpcHandlers.set(channel, handler)
        }
      ),
      removeHandler: vi.fn((channel: string) => {
        mockIpcHandlers.delete(channel)
      })
    },
    contextBridge: {
      exposeInMainWorld: vi.fn()
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    },
    BrowserWindow: vi.fn()
  }
})

interface MockWebContentsWithEvents extends WebContentsLike {
  id: number
  eventListeners: Map<string, Array<() => void>>
  isDestroyed: () => boolean
  once: (event: string, listener: () => void) => void
  emit: (event: string) => void
}

function createMockWebContents(id = 1): MockWebContentsWithEvents {
  let destroyed = false
  const eventListeners = new Map<string, Array<() => void>>()

  const mainFrame = {
    url: 'http://localhost:5173/index.html'
  } as WebFrameMainLike

  const contents: MockWebContentsWithEvents = {
    id,
    mainFrame,
    eventListeners,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      const list = eventListeners.get(event) ?? []
      list.push(listener)
      eventListeners.set(event, list)
    },
    emit: (event: string) => {
      if (event === 'destroyed') {
        destroyed = true
      }
      const list = eventListeners.get(event) ?? []
      eventListeners.delete(event)
      for (const listener of list) {
        listener()
      }
    }
  }

  return contents
}

describe('Phase 6 Step 6.3: Bot IPC Bridge & Preload Integration', () => {
  let dbContext: MigratedTestDatabaseContext
  let kbRepo: KnowledgeBaseRepository
  let connRepo: ProviderConnectionRepository
  let botRepo: BotRepository
  let registry: ProviderRegistry
  let activeContext: ActiveWorkspaceContext
  let botManager: BotManagerService

  const devOrigin = 'http://localhost:5173'
  let mockWebContents1: MockWebContentsWithEvents
  let mockWebContents2: MockWebContentsWithEvents
  let mockWindow: BrowserWindowLike
  let isWindowDestroyed: boolean

  let openAiConnId: string

  beforeEach(() => {
    resetMonitoredSenders()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()

    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    connRepo = new ProviderConnectionRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    registry = new ProviderRegistry()
    activeContext = new ActiveWorkspaceContext(kbRepo)

    botManager = new BotManagerService({
      botRepo,
      kbRepo,
      connectionRepo: connRepo,
      registry,
      activeContext
    })

    // Fixture provider connection
    const now = Date.now()
    openAiConnId = '00000000-0000-4000-8000-000000000001'
    dbContext.db
      .prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(openAiConnId, 'openai', 'OpenAI Work', 'cred_openai_12345678', 'active', now, now)

    isWindowDestroyed = false
    mockWebContents1 = createMockWebContents(1)
    mockWebContents2 = createMockWebContents(2)

    mockWindow = {
      isDestroyed: () => isWindowDestroyed,
      webContents: mockWebContents1
    } as unknown as BrowserWindowLike

    mockIpcHandlers.clear()
    registerBotIpcHandlers({
      getMainWindow: () => mockWindow,
      botManager,
      activeContext
    })
  })

  afterEach(() => {
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    dbContext.cleanup()
    vi.restoreAllMocks()
  })

  function createEvent(contents: MockWebContentsWithEvents = mockWebContents1): IpcSenderEventLike {
    return {
      sender: contents,
      senderFrame: contents.mainFrame
    }
  }

  async function invoke(
    channel: string,
    payload?: unknown,
    contents: MockWebContentsWithEvents = mockWebContents1
  ): Promise<unknown> {
    const handler = mockIpcHandlers.get(channel)
    if (!handler) {
      throw new Error(`Handler not registered for channel: ${channel}`)
    }
    return handler(createEvent(contents), payload)
  }

  // ===========================================================================
  // 1. Channel Registration
  // ===========================================================================

  describe('1. Channel Registration', () => {
    it('registers all seven Bot channels plus workspace activation and deactivation', () => {
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.LIST)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.GET)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.CREATE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.UPDATE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.ARCHIVE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.UNARCHIVE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.DELETE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE)).toBe(true)
      expect(mockIpcHandlers.has(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)).toBe(true)
    })
  })

  // ===========================================================================
  // 2. Sender Security Validation
  // ===========================================================================

  describe('2. Sender Security Validation', () => {
    it('rejects invocation when sender is not the main window webContents', async () => {
      const foreignWebContents = createMockWebContents(999)
      const untrustedEvent: IpcSenderEventLike = {
        sender: foreignWebContents,
        senderFrame: foreignWebContents.mainFrame
      }

      const handler = mockIpcHandlers.get(BOT_IPC_CHANNELS.LIST)!
      await expect(handler(untrustedEvent, {})).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects invocation when browser window is destroyed', async () => {
      isWindowDestroyed = true
      await expect(invoke(BOT_IPC_CHANNELS.LIST)).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects invocation when sender frame URL is untrusted', async () => {
      const maliciousFrame = { url: 'https://malicious.evil.com/phish.html' } as WebFrameMainLike
      const maliciousEvent: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: maliciousFrame
      }

      const handler = mockIpcHandlers.get(BOT_IPC_CHANNELS.LIST)!
      await expect(handler(maliciousEvent, {})).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('derives session ID exclusively from event.sender.id, not renderer input', async () => {
      const kb = kbRepo.create({ name: 'Real Workspace' })
      // Activate for session 1
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      // Create bot without passing session ID
      const bot = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Auto Session Bot',
        modelId: 'gpt-6-luna'
      })) as BotDto

      expect(bot.id).toBeDefined()
      expect(bot.knowledgeBaseId).toBe(kb.id)
    })
  })

  // ===========================================================================
  // 3. Input Validation & Strict Schema Enforcement
  // ===========================================================================

  describe('3. Input Validation', () => {
    it('rejects createBot when name is empty', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, {
          name: '   ',
          modelId: 'gpt-6-luna'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects createBot with injected knowledgeBaseId', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, {
          name: 'Spoofed Bot',
          modelId: 'gpt-6-luna',
          knowledgeBaseId: '00000000-0000-4000-8000-000000000099'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects createBot with injected status or id', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, {
          name: 'Injected Status Bot',
          modelId: 'gpt-6-luna',
          status: 'archived'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)

      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, {
          name: 'Injected ID Bot',
          modelId: 'gpt-6-luna',
          id: '00000000-0000-4000-8000-000000000099'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects updateBot with empty editable payload', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      const bot = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Target Bot',
        modelId: 'gpt-6-luna'
      })) as BotDto

      await expect(
        invoke(BOT_IPC_CHANNELS.UPDATE, {
          id: bot.id,
          input: {}
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects updateBot with injected status or knowledgeBaseId', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      const bot = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Target Bot',
        modelId: 'gpt-6-luna'
      })) as BotDto

      await expect(
        invoke(BOT_IPC_CHANNELS.UPDATE, {
          id: bot.id,
          input: {
            name: 'New Name',
            status: 'archived'
          }
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)

      await expect(
        invoke(BOT_IPC_CHANNELS.UPDATE, {
          id: bot.id,
          input: {
            name: 'New Name',
            knowledgeBaseId: '00000000-0000-4000-8000-000000000099'
          }
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects get, archive, unarchive, delete with malformed UUID', async () => {
      const kb = kbRepo.create({ name: 'Validation KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      await expect(invoke(BOT_IPC_CHANNELS.GET, { id: 'not-a-uuid' })).rejects.toThrow(
        /VALIDATION_ERROR/
      )
      await expect(invoke(BOT_IPC_CHANNELS.ARCHIVE, { id: 'not-a-uuid' })).rejects.toThrow(
        /VALIDATION_ERROR/
      )
      await expect(invoke(BOT_IPC_CHANNELS.UNARCHIVE, { id: 'not-a-uuid' })).rejects.toThrow(
        /VALIDATION_ERROR/
      )
      await expect(invoke(BOT_IPC_CHANNELS.DELETE, { id: 'not-a-uuid' })).rejects.toThrow(
        /VALIDATION_ERROR/
      )
    })
  })

  // ===========================================================================
  // 4. Ownership, Context Enforcement & Multi-Session Isolation
  // ===========================================================================

  describe('4. Ownership & Active Context Enforcement', () => {
    it('rejects Bot operations when no workspace has been activated', async () => {
      await expect(invoke(BOT_IPC_CHANNELS.LIST)).rejects.toThrow(/NO_ACTIVE_WORKSPACE/)
      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, { name: 'Lost Bot', modelId: 'gpt-6-luna' })
      ).rejects.toThrow(/NO_ACTIVE_WORKSPACE/)
    })

    it('rejects activation of an archived or nonexistent Knowledge Base', async () => {
      const archivedKb = kbRepo.create({ name: 'Old KB' })
      kbRepo.archive(archivedKb.id)

      await expect(
        invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: archivedKb.id })
      ).rejects.toThrow(/ARCHIVED_WORKSPACE/)

      await expect(
        invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, {
          id: '00000000-0000-4000-8000-000000000099'
        })
      ).rejects.toThrow(/KB_NOT_FOUND/)
    })

    it('maintains strict isolation between two renderer sessions', async () => {
      const kb1 = kbRepo.create({ name: 'Workspace One' })
      const kb2 = kbRepo.create({ name: 'Workspace Two' })

      // Session 1 activates KB 1
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb1.id }, mockWebContents1)
      // Session 2 activates KB 2
      mockWindow.webContents = mockWebContents2
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb2.id }, mockWebContents2)

      // Create Bot in Session 1
      mockWindow.webContents = mockWebContents1
      const bot1 = (await invoke(
        BOT_IPC_CHANNELS.CREATE,
        { name: 'Bot in KB 1', modelId: 'gpt-6-luna' },
        mockWebContents1
      )) as BotDto

      // Create Bot in Session 2
      mockWindow.webContents = mockWebContents2
      const bot2 = (await invoke(
        BOT_IPC_CHANNELS.CREATE,
        { name: 'Bot in KB 2', modelId: 'gpt-6-luna' },
        mockWebContents2
      )) as BotDto

      // Session 1 only sees Bot 1
      mockWindow.webContents = mockWebContents1
      const list1 = (await invoke(BOT_IPC_CHANNELS.LIST, {}, mockWebContents1)) as BotDto[]
      expect(list1.map((b) => b.id)).toEqual([bot1.id])
      expect(await invoke(BOT_IPC_CHANNELS.GET, { id: bot2.id }, mockWebContents1)).toBeNull()

      // Session 2 only sees Bot 2
      mockWindow.webContents = mockWebContents2
      const list2 = (await invoke(BOT_IPC_CHANNELS.LIST, {}, mockWebContents2)) as BotDto[]
      expect(list2.map((b) => b.id)).toEqual([bot2.id])
      expect(await invoke(BOT_IPC_CHANNELS.GET, { id: bot1.id }, mockWebContents2)).toBeNull()

      // Session 1 cannot modify or delete Bot 2
      mockWindow.webContents = mockWebContents1
      await expect(
        invoke(
          BOT_IPC_CHANNELS.UPDATE,
          { id: bot2.id, input: { name: 'Hacked' } },
          mockWebContents1
        )
      ).rejects.toThrow(/NOT_FOUND/)
      await expect(
        invoke(BOT_IPC_CHANNELS.DELETE, { id: bot2.id }, mockWebContents1)
      ).rejects.toThrow(/NOT_FOUND/)
    })

    it('clears active workspace context on deactivation', async () => {
      const kb = kbRepo.create({ name: 'Ephemeral Context' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })
      expect((await invoke(BOT_IPC_CHANNELS.LIST)) as BotDto[]).toHaveLength(0)

      const result = (await invoke(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)) as { success: boolean }
      expect(result.success).toBe(true)

      // Subsequent call fails
      await expect(invoke(BOT_IPC_CHANNELS.LIST)).rejects.toThrow(/NO_ACTIVE_WORKSPACE/)
    })

    it('automatically cleans up workspace context when webContents is destroyed', async () => {
      const kb = kbRepo.create({ name: 'Auto Cleanup KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id }, mockWebContents1)

      expect(activeContext.hasActiveWorkspace(mockWebContents1.id)).toBe(true)

      // Simulate renderer window / tab destruction
      mockWebContents1.emit('destroyed')

      // Context is automatically removed
      expect(activeContext.hasActiveWorkspace(mockWebContents1.id)).toBe(false)
    })
  })

  // ===========================================================================
  // 5. Bot Operations & Lifecycle
  // ===========================================================================

  describe('5. Bot CRUD & Lifecycle Operations', () => {
    it('executes full lifecycle: create, get, update, archive, unarchive, delete', async () => {
      const kb = kbRepo.create({ name: 'Lifecycle Workspace' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      // 1. Create
      const created = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Research Assistant',
        modelId: 'gpt-6-luna',
        description: 'Assists with technical notes',
        systemPrompt: 'You are an expert researcher.',
        providerConnectionId: openAiConnId,
        enabledTools: ['search_knowledge_base', 'prepare_report']
      })) as BotDto

      expect(created.id).toBeDefined()
      expect(created.knowledgeBaseId).toBe(kb.id)
      expect(created.name).toBe('Research Assistant')
      expect(created.status).toBe('active')
      expect(created.enabledTools).toEqual(['search_knowledge_base', 'prepare_report'])

      // 2. Get
      const fetched = (await invoke(BOT_IPC_CHANNELS.GET, { id: created.id })) as BotDto
      expect(fetched.id).toBe(created.id)
      expect(fetched.name).toBe('Research Assistant')

      // 3. Update
      const updated = (await invoke(BOT_IPC_CHANNELS.UPDATE, {
        id: created.id,
        input: {
          name: 'Senior Research Assistant',
          description: 'Updated description'
        }
      })) as BotDto

      expect(updated.name).toBe('Senior Research Assistant')
      expect(updated.description).toBe('Updated description')

      // 4. Archive
      const archived = (await invoke(BOT_IPC_CHANNELS.ARCHIVE, { id: created.id })) as BotDto
      expect(archived.status).toBe('archived')

      // Listing active bots excludes archived
      const activeList = (await invoke(BOT_IPC_CHANNELS.LIST, { status: 'active' })) as BotDto[]
      expect(activeList.map((b) => b.id)).not.toContain(created.id)

      // Listing archived bots includes it
      const archivedList = (await invoke(BOT_IPC_CHANNELS.LIST, {
        status: 'archived'
      })) as BotDto[]
      expect(archivedList.map((b) => b.id)).toContain(created.id)

      // 5. Unarchive
      const unarchived = (await invoke(BOT_IPC_CHANNELS.UNARCHIVE, { id: created.id })) as BotDto
      expect(unarchived.status).toBe('active')

      // 6. Delete
      const delResult = (await invoke(BOT_IPC_CHANNELS.DELETE, {
        id: created.id
      })) as DeleteBotResultDto
      expect(delResult.success).toBe(true)
      expect(delResult.botId).toBe(created.id)

      // Get returns null
      expect(await invoke(BOT_IPC_CHANNELS.GET, { id: created.id })).toBeNull()
    })

    it('rejects incompatible provider/model combinations with sanitized error', async () => {
      const kb = kbRepo.create({ name: 'Model Check KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      try {
        await invoke(BOT_IPC_CHANNELS.CREATE, {
          name: 'Cross Provider Bot',
          modelId: 'claude-sonnet-5-5',
          providerConnectionId: openAiConnId
        })
        expect.fail('Should have failed model compatibility check')
      } catch (err) {
        const errorMsg = (err as Error).message
        expect(errorMsg).toContain('CROSS_PROVIDER_MODEL_MISMATCH')
      }
    })
  })

  // ===========================================================================
  // 6. Preload Bridge API
  // ===========================================================================

  describe('6. Preload Bridge Integration', () => {
    it('invokes expected IPC channels with correct arguments and unwraps errors', async () => {
      const mockIpc = {
        invoke: vi.fn()
      } as unknown as typeof import('electron').ipcRenderer

      const botsApi = createBotsApi(mockIpc)
      const kbApi = createKnowledgeBasesApi(mockIpc)

      // 1. list
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce([])
      await botsApi.list({ status: 'active' })
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.LIST, { status: 'active' })

      // 2. get
      const sampleBot: BotDto = {
        id: '11111111-1111-4111-8111-111111111111',
        knowledgeBaseId: '22222222-2222-4222-8222-222222222222',
        providerConnectionId: null,
        name: 'Test Bot',
        description: '',
        systemPrompt: '',
        modelId: 'gpt-6-luna',
        status: 'active',
        responsePolicy: 'balanced_kb_first',
        enabledTools: [],
        createdAt: 1000,
        updatedAt: 1000
      }
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce(sampleBot)
      const fetched = await botsApi.get(sampleBot.id)
      expect(fetched).toEqual(sampleBot)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.GET, { id: sampleBot.id })

      // 3. create
      const createReq: CreateBotRequest = { name: 'New Bot', modelId: 'gpt-6-luna' }
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce(sampleBot)
      await botsApi.create(createReq)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.CREATE, createReq)

      // 4. update
      const updateReq: UpdateBotRequest = { name: 'Renamed Bot' }
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce(sampleBot)
      await botsApi.update(sampleBot.id, updateReq)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.UPDATE, {
        id: sampleBot.id,
        input: updateReq
      })

      // 5. archive & unarchive
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce(sampleBot)
      await botsApi.archive(sampleBot.id)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.ARCHIVE, { id: sampleBot.id })

      vi.mocked(mockIpc.invoke).mockResolvedValueOnce(sampleBot)
      await botsApi.unarchive(sampleBot.id)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.UNARCHIVE, { id: sampleBot.id })

      // 6. delete
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce({ success: true, botId: sampleBot.id })
      await botsApi.delete(sampleBot.id)
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.DELETE, { id: sampleBot.id })

      // 7. activateWorkspace & deactivateWorkspace via botsApi
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce({ id: 'kb-1' })
      await botsApi.activateWorkspace('kb-1')
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, {
        id: 'kb-1'
      })

      vi.mocked(mockIpc.invoke).mockResolvedValueOnce({ success: true })
      await botsApi.deactivateWorkspace()
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)

      // 8. activateWorkspace & deactivateWorkspace via kbApi
      vi.mocked(mockIpc.invoke).mockResolvedValueOnce({ id: 'kb-1' })
      await kbApi.activateWorkspace!('kb-1')
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, {
        id: 'kb-1'
      })

      vi.mocked(mockIpc.invoke).mockResolvedValueOnce({ success: true })
      await kbApi.deactivateWorkspace!()
      expect(mockIpc.invoke).toHaveBeenCalledWith(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)

      // 9. Error unwrapping into BotBridgeError
      vi.mocked(mockIpc.invoke).mockRejectedValueOnce(
        new Error(JSON.stringify({ code: 'NOT_FOUND', message: 'Bot does not exist' }))
      )
      await expect(botsApi.get('bad-id')).rejects.toThrow(BotBridgeError)
    })

    it('normalizeBotBridgeError correctly unpacks JSON error strings', () => {
      const rawError = new Error(
        JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Name cannot be blank.' })
      )
      const normalized = normalizeBotBridgeError(rawError)
      expect(normalized).toBeInstanceOf(BotBridgeError)
      expect(normalized.code).toBe('VALIDATION_ERROR')
      expect(normalized.message).toBe('Name cannot be blank.')
    })
  })

  // ===========================================================================
  // 7. Failing Subsystem Handler Stub
  // ===========================================================================

  describe('7. Failing Subsystem Handlers', () => {
    it('registers failing handlers that reject with SUBSYSTEM_FAILED', async () => {
      mockIpcHandlers.clear()
      registerFailingBotIpcHandlers(() => mockWindow, 'SQLite connection died.')

      await expect(invoke(BOT_IPC_CHANNELS.LIST)).rejects.toThrow(/BOT_SUBSYSTEM_FAILED/)
    })
  })

  describe('8. Step 12.3 Response Policy IPC Roundtrip & Validation', () => {
    it('creates, retrieves, lists, and updates responsePolicy independently over IPC', async () => {
      const kb = kbRepo.create({ name: 'IPC Policy KB' })
      await invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: kb.id })

      const defaultBot = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Default Policy Bot',
        modelId: 'gpt-6-luna'
      })) as BotDto
      expect(defaultBot.responsePolicy).toBe('balanced_kb_first')

      const strictBot = (await invoke(BOT_IPC_CHANNELS.CREATE, {
        name: 'Strict Policy Bot',
        modelId: 'gpt-6-luna',
        responsePolicy: 'strict_kb_only',
        enabledTools: ['search_knowledge_base']
      })) as BotDto
      expect(strictBot.responsePolicy).toBe('strict_kb_only')

      const updatedBot = (await invoke(BOT_IPC_CHANNELS.UPDATE, {
        id: strictBot.id,
        input: { responsePolicy: 'general_ai_chat' }
      })) as BotDto
      expect(updatedBot.responsePolicy).toBe('general_ai_chat')
      expect(updatedBot.enabledTools).toEqual(['search_knowledge_base'])

      const fetched = (await invoke(BOT_IPC_CHANNELS.GET, { id: strictBot.id })) as BotDto
      expect(fetched.responsePolicy).toBe('general_ai_chat')

      await expect(
        invoke(BOT_IPC_CHANNELS.CREATE, {
          name: 'Invalid Policy Bot',
          modelId: 'gpt-6-luna',
          responsePolicy: 'not_a_real_policy'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })
  })
})
