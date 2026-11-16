import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BOT_MEMORY_IPC_CHANNELS,
  type BotMemoryDto,
  type CreateBotMemoryInput,
  type UpdateBotMemoryInput,
  type DeleteBotMemoryResultDto,
  type BotMemoryCountDto,
  BotMemoryBridgeError
} from '../../shared/bot-memories'
import {
  registerBotMemoryIpcHandlers,
  registerFailingBotMemoryIpcHandlers
} from './bot-memory-handlers'
import { formatBotMemoryIpcError, sanitizeBotMemoryErrorMessage } from './bot-memory-validation'
import { resetMonitoredSenders } from './bot-handlers'
import { createBotMemoriesApi, normalizeBotMemoryBridgeError, api } from '../../preload'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
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

function createMockBrowserWindow(webContents: MockWebContentsWithEvents): BrowserWindowLike {
  return {
    isDestroyed: () => webContents.isDestroyed(),
    webContents
  } as unknown as BrowserWindowLike
}

describe('Bot Memory IPC Bridge & Preload Integration', () => {
  let testDbContext: MigratedTestDatabaseContext
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let memoryRepo: BotMemoryRepository
  let activeContext: ActiveWorkspaceContext

  let mockWebContents: MockWebContentsWithEvents
  let mockWindow: BrowserWindowLike
  let authorizedEvent: IpcSenderEventLike

  let kbAId: string
  let kbBId: string
  let botA1Id: string
  let botA2Id: string
  let botB1Id: string
  let archivedBotId: string

  beforeEach(() => {
    mockIpcHandlers.clear()
    resetMonitoredSenders()

    const devOrigin = 'http://localhost:5173'
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin

    testDbContext = createMigratedTestDatabase()
    const { db } = testDbContext

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    memoryRepo = new BotMemoryRepository(db)
    activeContext = new ActiveWorkspaceContext(kbRepo)

    // Create test Knowledge Bases & Bots
    const kbA = kbRepo.create({ name: 'Knowledge Base A' })
    kbAId = kbA.id

    const botA1 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A1',
      modelId: 'gpt-4o'
    })
    botA1Id = botA1.id

    const botA2 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A2 (Sibling)',
      modelId: 'claude-3-5'
    })
    botA2Id = botA2.id

    const archivedBot = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Archived Bot',
      modelId: 'gpt-4o',
      status: 'archived'
    })
    archivedBotId = archivedBot.id

    const kbB = kbRepo.create({ name: 'Knowledge Base B' })
    kbBId = kbB.id

    const botB1 = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot B1 (Cross-KB)',
      modelId: 'gpt-4o'
    })
    botB1Id = botB1.id

    // Setup mock window & sender
    mockWebContents = createMockWebContents(1)
    mockWindow = createMockBrowserWindow(mockWebContents)
    authorizedEvent = {
      sender: mockWebContents,
      senderFrame: mockWebContents.mainFrame
    }

    // Register active workspace context for session 1
    activeContext.activateWorkspace(1, kbAId)

    // Register IPC handlers
    registerBotMemoryIpcHandlers({
      getMainWindow: () => mockWindow,
      botMemoryRepo: memoryRepo,
      botRepo: botRepo,
      activeContext: activeContext
    })
  })

  afterEach(() => {
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    testDbContext.cleanup()
  })

  // ==========================================================================
  // Suite 1: Sender Authorization & Security
  // ==========================================================================

  describe('Suite 1: Sender Authorization & Security', () => {
    it('rejects invocation when sender frame does not match mainFrame', async () => {
      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: { url: 'http://evil.com/iframe.html' } as WebFrameMainLike
      }

      const handler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)
      expect(handler).toBeDefined()

      await expect(handler!(untrustedEvent, { botId: botA1Id })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects invocation when main window is null', async () => {
      registerBotMemoryIpcHandlers({
        getMainWindow: () => null,
        botMemoryRepo: memoryRepo,
        botRepo: botRepo,
        activeContext: activeContext
      })

      const handler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)
      await expect(handler!(authorizedEvent, { botId: botA1Id })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })
  })

  // ==========================================================================
  // Suite 2: CRUD Operations & Authoritative Scoping
  // ==========================================================================

  describe('Suite 2: CRUD Operations & Authoritative Scoping', () => {
    it('creates a memory with authoritative KB resolution (ignores renderer KB injection)', async () => {
      const createHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.CREATE)
      expect(createHandler).toBeDefined()

      const result = (await createHandler!(authorizedEvent, {
        botId: botA1Id,
        memoryType: 'user_note',
        content: 'Remember that user likes dark mode.'
      })) as BotMemoryDto

      expect(result).toBeDefined()
      expect(result.botId).toBe(botA1Id)
      expect(result.knowledgeBaseId).toBe(kbAId)
      expect(result.memoryType).toBe('user_note')
      expect(result.content).toBe('Remember that user likes dark mode.')
      expect(result.createdAt).toBeGreaterThan(0)
    })

    it('retrieves a memory by ID for the authoritative Bot', async () => {
      const created = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Fetch me'
      })

      const getHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.GET)
      const result = (await getHandler!(authorizedEvent, {
        memoryId: created.id,
        botId: botA1Id
      })) as BotMemoryDto | null

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
      expect(result?.content).toBe('Fetch me')
    })

    it('lists memories for a Bot with optional memoryType filter', async () => {
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        memoryType: 'user_note',
        content: 'Note A'
      })
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        memoryType: 'pinned_instruction',
        content: 'Instruction A'
      })

      const listHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)
      const allMemories = (await listHandler!(authorizedEvent, {
        botId: botA1Id
      })) as BotMemoryDto[]

      expect(allMemories).toHaveLength(2)

      const onlyNotes = (await listHandler!(authorizedEvent, {
        botId: botA1Id,
        memoryType: 'user_note'
      })) as BotMemoryDto[]
      expect(onlyNotes).toHaveLength(1)
      expect(onlyNotes[0].content).toBe('Note A')
    })

    it('updates a memory content and type', async () => {
      const created = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Before update'
      })

      const updateHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.UPDATE)
      const updated = (await updateHandler!(authorizedEvent, {
        memoryId: created.id,
        botId: botA1Id,
        input: {
          content: 'After update',
          memoryType: 'pinned_instruction'
        }
      })) as BotMemoryDto

      expect(updated.id).toBe(created.id)
      expect(updated.content).toBe('After update')
      expect(updated.memoryType).toBe('pinned_instruction')
    })

    it('deletes a memory within authoritative Bot scope', async () => {
      const created = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'To be deleted'
      })

      const deleteHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.DELETE)
      const res = (await deleteHandler!(authorizedEvent, {
        memoryId: created.id,
        botId: botA1Id
      })) as DeleteBotMemoryResultDto

      expect(res.success).toBe(true)
      expect(res.memoryId).toBe(created.id)

      // Verify deletion in DB
      const check = memoryRepo.getById(created.id, botA1Id, kbAId)
      expect(check).toBeNull()
    })

    it('counts memories for a Bot', async () => {
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Item 1'
      })
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Item 2'
      })

      const countHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.COUNT)
      const countRes = (await countHandler!(authorizedEvent, {
        botId: botA1Id
      })) as BotMemoryCountDto

      expect(countRes.botId).toBe(botA1Id)
      expect(countRes.count).toBe(2)
    })
  })

  // ==========================================================================
  // Suite 3: Cross-Bot Isolation & Active Workspace Protection
  // ==========================================================================

  describe('Suite 3: Cross-Bot Isolation & Active Workspace Protection', () => {
    it('sibling Bot cannot retrieve another Bot memories via IPC (returns null)', async () => {
      const memA1 = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Private to Bot A1'
      })

      const getHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.GET)
      const res = await getHandler!(authorizedEvent, {
        memoryId: memA1.id,
        botId: botA2Id // requesting with sibling Bot ID
      })

      expect(res).toBeNull()
    })

    it('sibling Bot cannot update another Bot memories via IPC (throws BOT_MEMORY_NOT_FOUND)', async () => {
      const memA1 = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Private to Bot A1'
      })

      const updateHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.UPDATE)
      await expect(
        updateHandler!(authorizedEvent, {
          memoryId: memA1.id,
          botId: botA2Id,
          input: { content: 'Tampered' }
        })
      ).rejects.toThrow(/BOT_MEMORY_NOT_FOUND/)
    })

    it('sibling Bot cannot delete another Bot memories via IPC (throws BOT_MEMORY_NOT_FOUND)', async () => {
      const memA1 = memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Private to Bot A1'
      })

      const deleteHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.DELETE)
      await expect(
        deleteHandler!(authorizedEvent, {
          memoryId: memA1.id,
          botId: botA2Id
        })
      ).rejects.toThrow(/BOT_MEMORY_NOT_FOUND/)

      // Verify original memory is intact
      expect(memoryRepo.getById(memA1.id, botA1Id, kbAId)).not.toBeNull()
    })

    it('rejects unknown Bot ID with BOT_NOT_FOUND', async () => {
      const unknownBotId = '99999999-9999-4999-8999-999999999999'
      const listHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)

      await expect(
        listHandler!(authorizedEvent, {
          botId: unknownBotId
        })
      ).rejects.toThrow(/BOT_NOT_FOUND/)
    })

    it('rejects operations when Bot does not match active session Knowledge Base (BOT_KB_MISMATCH)', async () => {
      // Session 1 is active on KB A, but Bot B1 belongs to KB B
      const listHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)

      await expect(
        listHandler!(authorizedEvent, {
          botId: botB1Id
        })
      ).rejects.toThrow(/BOT_KB_MISMATCH/)
    })

    it('rejects mutations on archived Bot (BOT_ARCHIVED)', async () => {
      const createHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.CREATE)
      await expect(
        createHandler!(authorizedEvent, {
          botId: archivedBotId,
          content: 'Cannot add to archived bot'
        })
      ).rejects.toThrow(/BOT_ARCHIVED/)
    })
  })

  // ==========================================================================
  // Suite 4: Schema Validation & Error Sanitization
  // ==========================================================================

  describe('Suite 4: Schema Validation & Error Sanitization', () => {
    it('rejects invalid payload (blank content) with VALIDATION_ERROR', async () => {
      const createHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.CREATE)
      await expect(
        createHandler!(authorizedEvent, {
          botId: botA1Id,
          content: '   '
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects unknown properties in payload with VALIDATION_ERROR', async () => {
      const createHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.CREATE)
      await expect(
        createHandler!(authorizedEvent, {
          botId: botA1Id,
          content: 'Valid content',
          maliciousField: true
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('sanitizes filesystem paths and secret keys from returned error messages', () => {
      const rawError =
        'Error at C:\\Users\\Administrator\\Secret\\keys.txt\nfailed with sk-proj-1234567890abcdef12345678'
      const sanitized = sanitizeBotMemoryErrorMessage(rawError)

      expect(sanitized).not.toContain('C:\\Users\\Administrator')
      expect(sanitized).not.toContain('sk-proj-1234567890abcdef12345678')
      expect(sanitized).toContain('[REDACTED_PATH]')
      expect(sanitized).toContain('[REDACTED_KEY]')
    })

    it('formatBotMemoryIpcError safely formats unknown errors into structured JSON', () => {
      const formatted = formatBotMemoryIpcError(new Error('Simple failure'))
      const parsed = JSON.parse(formatted.message) as { code: string; message: string }

      expect(parsed.code).toBe('BOT_MEMORY_OPERATION_FAILED')
      expect(parsed.message).toBe('Simple failure')
    })
  })

  // ==========================================================================
  // Suite 5: Fallback Failing Handlers
  // ==========================================================================

  describe('Suite 5: Fallback Failing Handlers', () => {
    it('rejects all channels when failing handlers are registered', async () => {
      registerFailingBotMemoryIpcHandlers(() => mockWindow, 'Subsystem crash test')

      const createHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.CREATE)
      await expect(
        createHandler!(authorizedEvent, {
          botId: botA1Id,
          content: 'Fail'
        })
      ).rejects.toThrow(/SUBSYSTEM_INITIALIZATION_FAILED/)

      const listHandler = mockIpcHandlers.get(BOT_MEMORY_IPC_CHANNELS.LIST)
      await expect(listHandler!(authorizedEvent, { botId: botA1Id })).rejects.toThrow(
        /SUBSYSTEM_INITIALIZATION_FAILED/
      )
    })
  })

  // ==========================================================================
  // Suite 6: Preload API Bridge & Normalization
  // ==========================================================================

  describe('Suite 6: Preload API Bridge & Normalization', () => {
    it('createBotMemoriesApi bridges all calls through ipcRenderer and handles success', async () => {
      const mockIpcRenderer = {
        invoke: vi.fn().mockImplementation(async (channel: string, payload: unknown) => {
          if (channel === BOT_MEMORY_IPC_CHANNELS.CREATE) {
            const p = payload as CreateBotMemoryInput
            return {
              id: 'mem-123',
              botId: p.botId,
              knowledgeBaseId: kbAId,
              memoryType: p.memoryType ?? 'user_note',
              content: p.content,
              createdAt: 1000,
              updatedAt: 1000
            }
          }
          if (channel === BOT_MEMORY_IPC_CHANNELS.GET) {
            return {
              id: 'mem-123',
              botId: botA1Id,
              knowledgeBaseId: kbAId,
              memoryType: 'user_note',
              content: 'Get result',
              createdAt: 1000,
              updatedAt: 1000
            }
          }
          if (channel === BOT_MEMORY_IPC_CHANNELS.LIST) {
            return []
          }
          if (channel === BOT_MEMORY_IPC_CHANNELS.UPDATE) {
            const p = payload as { memoryId: string; input: UpdateBotMemoryInput }
            return {
              id: p.memoryId,
              botId: botA1Id,
              knowledgeBaseId: kbAId,
              memoryType: 'pinned_instruction',
              content: p.input.content ?? 'Updated',
              createdAt: 1000,
              updatedAt: 2000
            }
          }
          if (channel === BOT_MEMORY_IPC_CHANNELS.DELETE) {
            return { success: true, memoryId: 'mem-123' }
          }
          if (channel === BOT_MEMORY_IPC_CHANNELS.COUNT) {
            return { botId: botA1Id, count: 5 }
          }
          return null
        })
      } as unknown as typeof import('electron').ipcRenderer

      const clientApi = createBotMemoriesApi(mockIpcRenderer)

      const created = await clientApi.create({
        botId: botA1Id,
        content: 'Preload test note'
      })
      expect(created.id).toBe('mem-123')
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(BOT_MEMORY_IPC_CHANNELS.CREATE, {
        botId: botA1Id,
        content: 'Preload test note'
      })

      const fetched = await clientApi.get('mem-123', botA1Id)
      expect(fetched?.content).toBe('Get result')

      const list = await clientApi.list({ botId: botA1Id })
      expect(list).toEqual([])

      const updated = await clientApi.update('mem-123', botA1Id, { content: 'New text' })
      expect(updated.content).toBe('New text')

      const del = await clientApi.delete('mem-123', botA1Id)
      expect(del.success).toBe(true)

      const count = await clientApi.count(botA1Id)
      expect(count.count).toBe(5)
    })

    it('normalizeBotMemoryBridgeError unpacks structured IPC errors', () => {
      const jsonError = new Error(
        JSON.stringify({ code: 'BOT_MEMORY_NOT_FOUND', message: 'Memory not found' })
      )
      const normalized = normalizeBotMemoryBridgeError(jsonError)

      expect(normalized).toBeInstanceOf(BotMemoryBridgeError)
      expect(normalized.code).toBe('BOT_MEMORY_NOT_FOUND')
      expect(normalized.message).toBe('Memory not found')
    })

    it('normalizeBotMemoryBridgeError handles unstructured errors safely', () => {
      const rawError = new Error('Raw IPC connection failed')
      const normalized = normalizeBotMemoryBridgeError(rawError)

      expect(normalized).toBeInstanceOf(BotMemoryBridgeError)
      expect(normalized.code).toBe('BOT_MEMORY_ERROR')
      expect(normalized.message).toBe('Raw IPC connection failed')
    })

    it('verifies preload api export exposes both botMemories and memories namespaces with safe typed methods', () => {
      expect(api.botMemories).toBeDefined()
      expect(api.memories).toBeDefined()
      expect(typeof api.botMemories?.create).toBe('function')
      expect(typeof api.botMemories?.get).toBe('function')
      expect(typeof api.botMemories?.list).toBe('function')
      expect(typeof api.botMemories?.update).toBe('function')
      expect(typeof api.botMemories?.delete).toBe('function')
      expect(typeof api.botMemories?.count).toBe('function')

      // Ensure no raw Node or database internals are exposed on window.api
      expect((api as Record<string, unknown>).db).toBeUndefined()
      expect((api as Record<string, unknown>).sqlite).toBeUndefined()
      expect((api as Record<string, unknown>).fs).toBeUndefined()
      expect((api as Record<string, unknown>).process).toBeUndefined()
    })
  })
})
