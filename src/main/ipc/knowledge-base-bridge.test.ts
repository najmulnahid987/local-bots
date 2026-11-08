import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import {
  KB_IPC_CHANNELS,
  type KnowledgeBaseDto,
  type KnowledgeBaseOverviewDto,
  type CreateKnowledgeBaseRequest,
  type UpdateKnowledgeBaseRequest,
  type KnowledgeBaseListRequest,
  type DeleteKnowledgeBaseResult,
  KnowledgeBaseBridgeError
} from '../../shared/ipc'
import {
  registerKnowledgeBaseIpcHandlers,
  registerFailingKnowledgeBaseIpcHandlers,
  formatKnowledgeBaseIpcError
} from './knowledge-base-handlers'
import { createKnowledgeBasesApi, normalizeKnowledgeBaseBridgeError } from '../../preload'
import { KnowledgeBaseManager } from '../services/knowledge-base-manager'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
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

// IPC Registry for ipcMain mock
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

describe('Phase 4 Step 4.2: Secure Knowledge Base IPC Bridge & Preload Integration', () => {
  let dbContext: MigratedTestDatabaseContext
  let userDataDir: string
  let repository: KnowledgeBaseRepository
  let manager: KnowledgeBaseManager

  // Mock BrowserWindow & frames
  const devOrigin = 'http://localhost:5173'
  let mockMainFrame: WebFrameMainLike
  let mockWebContents: WebContentsLike
  let mockWindow: BrowserWindowLike
  let isWindowDestroyed: boolean

  beforeEach(() => {
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ipc-bridge-test-'))

    repository = new KnowledgeBaseRepository(dbContext.db)
    manager = new KnowledgeBaseManager({
      repository,
      userDataPath: userDataDir
    })

    // Setup Mock BrowserWindow
    isWindowDestroyed = false

    mockMainFrame = {
      url: `${devOrigin}/index.html`
    } as unknown as WebFrameMainLike

    mockWebContents = {
      mainFrame: mockMainFrame
    } as unknown as WebContentsLike

    mockWindow = {
      isDestroyed: () => isWindowDestroyed,
      webContents: mockWebContents
    } as unknown as BrowserWindowLike

    mockIpcHandlers.clear()
    registerKnowledgeBaseIpcHandlers(() => mockWindow, manager)
  })

  afterEach(() => {
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    dbContext.cleanup()
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
    vi.restoreAllMocks()
  })

  function createValidEvent(): IpcSenderEventLike {
    return {
      sender: mockWebContents,
      senderFrame: mockMainFrame
    }
  }

  async function invokeHandler(channel: string, payload?: unknown): Promise<unknown> {
    const handler = mockIpcHandlers.get(channel)
    if (!handler) {
      throw new Error(`Handler not registered for channel: ${channel}`)
    }
    return handler(createValidEvent(), payload)
  }

  // ---------------------------------------------------------------------------
  // 1. Channel Registration
  // ---------------------------------------------------------------------------
  describe('1. Channel Registration & Fallback', () => {
    it('registers all 8 Knowledge Base IPC channels', () => {
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.LIST)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.GET_BY_ID)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.CREATE)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.UPDATE)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.ARCHIVE)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.UNARCHIVE)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.DELETE)).toBe(true)
      expect(mockIpcHandlers.has(KB_IPC_CHANNELS.GET_OVERVIEW)).toBe(true)
    })

    it('registerFailingKnowledgeBaseIpcHandlers registers fallback handlers that reject safely', async () => {
      mockIpcHandlers.clear()
      registerFailingKnowledgeBaseIpcHandlers(() => mockWindow, 'Database migration failed')

      for (const channel of Object.values(KB_IPC_CHANNELS)) {
        await expect(invokeHandler(channel, {})).rejects.toThrow()
        try {
          await invokeHandler(channel, {})
        } catch (err) {
          const parsed = JSON.parse((err as Error).message)
          expect(parsed.code).toBe('SUBSYSTEM_INITIALIZATION_FAILED')
          expect(parsed.message).toBe('Database migration failed')
        }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Sender Validation & Authorization
  // ---------------------------------------------------------------------------
  describe('2. Sender Authorization', () => {
    it('rejects if senderFrame does not match mainFrame (subframe spoofing)', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/subframe.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.LIST)!
      await expect(handler(untrustedEvent, {})).rejects.toThrow()
      try {
        await handler(untrustedEvent, {})
      } catch (err) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('UNAUTHORIZED_SENDER')
      }
    })

    it('rejects if sender origin is not authorized (foreign origin)', async () => {
      const foreignFrame = {
        url: 'https://malicious-site.example.com/index.html'
      } as unknown as WebFrameMainLike

      const foreignWebContents = {
        mainFrame: foreignFrame
      } as unknown as WebContentsLike

      const foreignEvent: IpcSenderEventLike = {
        sender: foreignWebContents,
        senderFrame: foreignFrame
      }

      const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.LIST)!
      await expect(handler(foreignEvent, {})).rejects.toThrow()
      try {
        await handler(foreignEvent, {})
      } catch (err) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('UNAUTHORIZED_SENDER')
      }
    })

    it('rejects if window reference is null or destroyed', async () => {
      isWindowDestroyed = true
      const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.LIST)!
      await expect(handler(createValidEvent(), {})).rejects.toThrow()
      try {
        await handler(createValidEvent(), {})
      } catch (err) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('UNAUTHORIZED_SENDER')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Payload Validation
  // ---------------------------------------------------------------------------
  describe('3. Payload Validation', () => {
    describe('LIST channel validation', () => {
      it('accepts empty or undefined payload', async () => {
        const result = await invokeHandler(KB_IPC_CHANNELS.LIST, undefined)
        expect(Array.isArray(result)).toBe(true)
      })

      it('accepts valid filter options', async () => {
        const result = await invokeHandler(KB_IPC_CHANNELS.LIST, {
          includeArchived: true
        })
        expect(Array.isArray(result)).toBe(true)
      })

      it('rejects non-boolean filter options', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.LIST, { includeArchived: 'yes' })
        ).rejects.toThrow()
      })

      it('rejects unexpected properties', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.LIST, { unexpectedKey: 'value' })
        ).rejects.toThrow()
      })
    })

    describe('GET_BY_ID channel validation', () => {
      it('rejects missing or non-object payload', async () => {
        await expect(invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, null)).rejects.toThrow()
        await expect(invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, 'not-an-object')).rejects.toThrow()
      })

      it('rejects invalid or non-UUID id', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, { id: 'invalid-id' })
        ).rejects.toThrow()
        await expect(invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, { id: 12345 })).rejects.toThrow()
      })

      it('rejects unexpected properties', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, {
            id: crypto.randomUUID(),
            extraField: 'not-allowed'
          })
        ).rejects.toThrow()
      })
    })

    describe('CREATE channel validation', () => {
      it('rejects missing or empty name', async () => {
        await expect(invokeHandler(KB_IPC_CHANNELS.CREATE, { name: '' })).rejects.toThrow()
        await expect(invokeHandler(KB_IPC_CHANNELS.CREATE, { name: '   ' })).rejects.toThrow()
        await expect(invokeHandler(KB_IPC_CHANNELS.CREATE, {})).rejects.toThrow()
      })

      it('rejects name exceeding 255 characters', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.CREATE, { name: 'a'.repeat(256) })
        ).rejects.toThrow()
      })

      it('rejects description exceeding 2000 characters', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.CREATE, {
            name: 'Valid Name',
            description: 'a'.repeat(2001)
          })
        ).rejects.toThrow()
      })

      it('rejects unexpected properties (such as paths or flags)', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.CREATE, {
            name: 'Valid Name',
            storage_path: 'C:\\secret\\path'
          })
        ).rejects.toThrow()
      })
    })

    describe('UPDATE channel validation', () => {
      it('rejects invalid id UUID', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.UPDATE, {
            id: 'bad-uuid',
            input: { name: 'New Name' }
          })
        ).rejects.toThrow()
      })

      it('rejects empty name in input if provided', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.UPDATE, {
            id: crypto.randomUUID(),
            input: { name: '  ' }
          })
        ).rejects.toThrow()
      })

      it('rejects unexpected properties in input', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.UPDATE, {
            id: crypto.randomUUID(),
            input: { name: 'Valid', arbitrary: 'malicious' }
          })
        ).rejects.toThrow()
      })
    })

    describe('ARCHIVE, UNARCHIVE, DELETE validation', () => {
      it('archive rejects invalid UUID', async () => {
        await expect(invokeHandler(KB_IPC_CHANNELS.ARCHIVE, { id: 'not-a-uuid' })).rejects.toThrow()
      })

      it('unarchive rejects invalid UUID', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.UNARCHIVE, { id: 'not-a-uuid' })
        ).rejects.toThrow()
      })

      it('delete rejects invalid UUID', async () => {
        await expect(invokeHandler(KB_IPC_CHANNELS.DELETE, { id: 'not-a-uuid' })).rejects.toThrow()
      })

      it('delete rejects extra fields or arbitrary path attempt', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.DELETE, {
            id: crypto.randomUUID(),
            path: 'C:\\Windows\\System32'
          })
        ).rejects.toThrow()
      })
    })

    describe('GET_OVERVIEW channel validation', () => {
      it('rejects missing or non-object payload', async () => {
        await expect(invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, null)).rejects.toThrow()
        await expect(invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, undefined)).rejects.toThrow()
      })

      it('rejects invalid UUID format', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, { id: 'invalid-uuid' })
        ).rejects.toThrow()
      })

      it('rejects unexpected properties (.strict())', async () => {
        await expect(
          invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, {
            id: crypto.randomUUID(),
            extra: 'forbidden'
          })
        ).rejects.toThrow()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Functional Operations via Manager
  // ---------------------------------------------------------------------------
  describe('4. Functional Operations & DTO Mapping', () => {
    it('creates a knowledge base, generates directory, and returns camelCase DTO', async () => {
      const input: CreateKnowledgeBaseRequest = {
        name: 'Research Docs',
        description: 'Primary research documents'
      }

      const dto = (await invokeHandler(KB_IPC_CHANNELS.CREATE, input)) as KnowledgeBaseDto

      expect(dto).toBeDefined()
      expect(dto.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(dto.name).toBe('Research Docs')
      expect(dto.description).toBe('Primary research documents')
      expect(dto.createdAt).toBeDefined()
      expect(dto.updatedAt).toBeDefined()
      expect(dto.archivedAt).toBeNull()

      // Ensure storage_path is not exposed to renderer
      expect((dto as unknown as Record<string, unknown>).storage_path).toBeUndefined()

      // Verify physical directory was created
      const expectedDir = path.join(userDataDir, 'documents', dto.id)
      expect(fs.existsSync(expectedDir)).toBe(true)
    })

    it('gets a knowledge base by ID and returns null for non-existent ID', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Target KB'
      })) as KnowledgeBaseDto

      const retrieved = (await invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, {
        id: created.id
      })) as KnowledgeBaseDto | null

      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(created.id)
      expect(retrieved?.name).toBe('Target KB')

      const nonExistent = (await invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, {
        id: crypto.randomUUID()
      })) as KnowledgeBaseDto | null

      expect(nonExistent).toBeNull()
    })

    it('lists knowledge bases with filter support', async () => {
      const kb1 = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Alpha Project'
      })) as KnowledgeBaseDto

      const kb2 = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Beta Archive'
      })) as KnowledgeBaseDto

      // Archive kb2
      await invokeHandler(KB_IPC_CHANNELS.ARCHIVE, { id: kb2.id })

      // Active only (default)
      const activeList = (await invokeHandler(KB_IPC_CHANNELS.LIST, {})) as KnowledgeBaseDto[]
      expect(activeList.length).toBe(1)
      expect(activeList[0].id).toBe(kb1.id)

      // Include archived
      const allList = (await invokeHandler(KB_IPC_CHANNELS.LIST, {
        includeArchived: true
      })) as KnowledgeBaseDto[]
      expect(allList.length).toBe(2)
    })

    it('updates a knowledge base name and description', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Initial Name'
      })) as KnowledgeBaseDto

      const updatePayload: { id: string; input: UpdateKnowledgeBaseRequest } = {
        id: created.id,
        input: {
          name: 'Updated Name',
          description: 'Updated Description'
        }
      }

      const updated = (await invokeHandler(
        KB_IPC_CHANNELS.UPDATE,
        updatePayload
      )) as KnowledgeBaseDto | null

      expect(updated).not.toBeNull()
      expect(updated?.name).toBe('Updated Name')
      expect(updated?.description).toBe('Updated Description')
    })

    it('archives and unarchives a knowledge base', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Toggle Archive KB'
      })) as KnowledgeBaseDto

      expect(created.archivedAt).toBeNull()

      const archived = (await invokeHandler(KB_IPC_CHANNELS.ARCHIVE, {
        id: created.id
      })) as KnowledgeBaseDto | null

      expect(archived).not.toBeNull()
      expect(archived?.archivedAt).not.toBeNull()

      const unarchived = (await invokeHandler(KB_IPC_CHANNELS.UNARCHIVE, {
        id: created.id
      })) as KnowledgeBaseDto | null

      expect(unarchived).not.toBeNull()
      expect(unarchived?.archivedAt).toBeNull()
    })

    it('deletes a knowledge base and cleans physical directory', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'KB to Delete'
      })) as KnowledgeBaseDto

      const dirPath = path.join(userDataDir, 'documents', created.id)
      expect(fs.existsSync(dirPath)).toBe(true)

      // Write a sample file inside
      fs.writeFileSync(path.join(dirPath, 'sample.txt'), 'test document')

      const result = (await invokeHandler(KB_IPC_CHANNELS.DELETE, {
        id: created.id
      })) as DeleteKnowledgeBaseResult

      expect(result.success).toBe(true)
      expect(result.directoryCleaned).toBe(true)
      expect(result.cleanupPending).toBe(false)

      // Physical dir deleted
      expect(fs.existsSync(dirPath)).toBe(false)

      // DB record deleted
      const check = await invokeHandler(KB_IPC_CHANNELS.GET_BY_ID, {
        id: created.id
      })
      expect(check).toBeNull()
    })

    it('cascades deletion to dependent bots when a knowledge base is deleted via IPC', async () => {
      const botRepo = new BotRepository(dbContext.db)

      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'KB with Bots'
      })) as KnowledgeBaseDto

      const bot = botRepo.create({
        knowledgeBaseId: created.id,
        name: 'Assistant Bot',
        modelId: 'gpt-4o',
        toolPermissions: []
      })

      expect(botRepo.getById(bot.id, created.id)).not.toBeNull()

      const deleteResult = (await invokeHandler(KB_IPC_CHANNELS.DELETE, {
        id: created.id
      })) as DeleteKnowledgeBaseResult

      expect(deleteResult.success).toBe(true)

      // Bot should be cascade-deleted by SQLite foreign key
      expect(botRepo.getById(bot.id, created.id)).toBeNull()
    })

    it('handles delete for non-existent knowledge base by returning NOT_FOUND result', async () => {
      const randomId = crypto.randomUUID()
      const result = (await invokeHandler(KB_IPC_CHANNELS.DELETE, {
        id: randomId
      })) as DeleteKnowledgeBaseResult

      expect(result.success).toBe(false)
      expect(result.code).toBe('NOT_FOUND')
    })

    it('preserves cleanupPending status if directory cleanup encounters an error', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'KB with cleanup error'
      })) as KnowledgeBaseDto

      // Spy on manager.delete to simulate directory quarantine/cleanup issue
      vi.spyOn(manager, 'delete').mockResolvedValueOnce({
        success: true,
        directoryCleaned: false,
        cleanupPending: true
      })

      const result = (await invokeHandler(KB_IPC_CHANNELS.DELETE, {
        id: created.id
      })) as DeleteKnowledgeBaseResult

      expect(result.success).toBe(true)
      expect(result.directoryCleaned).toBe(false)
      expect(result.cleanupPending).toBe(true)
    })

    it('retrieves knowledge base overview with aggregated statistics via GET_OVERVIEW channel', async () => {
      const created = (await invokeHandler(KB_IPC_CHANNELS.CREATE, {
        name: 'Overview KB'
      })) as KnowledgeBaseDto

      const overview = (await invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, {
        id: created.id
      })) as KnowledgeBaseOverviewDto

      expect(overview).toBeDefined()
      expect(overview.knowledgeBaseId).toBe(created.id)
      expect(overview.bots).toEqual({ total: 0, active: 0, archived: 0 })
      expect(overview.documents).toEqual({
        total: 0,
        ready: 0,
        processing: 0,
        failed: 0,
        totalBytes: 0
      })
      expect(overview.indexing).toEqual({ totalChunks: 0, totalTokens: 0, lastIndexedAt: null })
      expect(overview.recentActivity).toEqual([])
    })

    it('rejects overview for nonexistent knowledge base with NOT_FOUND', async () => {
      const nonExistentId = crypto.randomUUID()
      await expect(
        invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, { id: nonExistentId })
      ).rejects.toThrow()

      try {
        await invokeHandler(KB_IPC_CHANNELS.GET_OVERVIEW, { id: nonExistentId })
      } catch (err) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('NOT_FOUND')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Error Formatting & Path Sanitization
  // ---------------------------------------------------------------------------
  describe('5. Error Formatting & Path Sanitization', () => {
    it('sanitizes Windows absolute paths from error messages', () => {
      const sensitiveError = new Error('Failed to access C:\\Users\\User\\AppData\\Secret\\dir')
      const formatted = formatKnowledgeBaseIpcError(sensitiveError)
      const parsed = JSON.parse(formatted.message)

      expect(parsed.code).toBe('KNOWLEDGE_BASE_OPERATION_FAILED')
      expect(parsed.message).not.toContain('C:\\Users')
      expect(parsed.message).toContain('[REDACTED_PATH]')
    })

    it('sanitizes POSIX absolute paths from error messages', () => {
      const sensitiveError = new Error('Failed to open /home/user/.config/workspace.db')
      const formatted = formatKnowledgeBaseIpcError(sensitiveError)
      const parsed = JSON.parse(formatted.message)

      expect(parsed.code).toBe('KNOWLEDGE_BASE_OPERATION_FAILED')
      expect(parsed.message).not.toContain('/home/user')
      expect(parsed.message).toContain('[REDACTED_PATH]')
    })

    it('sanitizes quarantine markers from error messages', () => {
      const sensitiveError = new Error('Quarantine active at .quarantine_12345_abc')
      const formatted = formatKnowledgeBaseIpcError(sensitiveError)
      const parsed = JSON.parse(formatted.message)

      expect(parsed.message).not.toContain('.quarantine_12345_abc')
      expect(parsed.message).toContain('[REDACTED_QUARANTINE]')
    })

    it('preserves known error codes from KnowledgeBaseBridgeError', () => {
      const bridgeErr = new KnowledgeBaseBridgeError(
        'Knowledge base not found',
        'KNOWLEDGE_BASE_NOT_FOUND'
      )
      const formatted = formatKnowledgeBaseIpcError(bridgeErr)
      const parsed = JSON.parse(formatted.message)

      expect(parsed.code).toBe('KNOWLEDGE_BASE_NOT_FOUND')
      expect(parsed.message).toBe('Knowledge base not found')
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Preload Bridge API
  // ---------------------------------------------------------------------------
  describe('6. Preload Bridge (createKnowledgeBasesApi & normalizeKnowledgeBaseBridgeError)', () => {
    it('normalizes serialized JSON IPC errors into KnowledgeBaseBridgeError', () => {
      const serialized = JSON.stringify({
        code: 'VALIDATION_FAILED',
        message: 'Name is required'
      })
      const err = new Error(`Error invoking remote method: ${serialized}`)
      const normalized = normalizeKnowledgeBaseBridgeError(err)

      expect(normalized).toBeInstanceOf(KnowledgeBaseBridgeError)
      expect(normalized.code).toBe('VALIDATION_FAILED')
      expect(normalized.message).toBe('Name is required')
    })

    it('normalizes fallback non-JSON errors into KnowledgeBaseBridgeError', () => {
      const err = new Error('Unexpected remote failure')
      const normalized = normalizeKnowledgeBaseBridgeError(err)

      expect(normalized).toBeInstanceOf(KnowledgeBaseBridgeError)
      expect(normalized.code).toBe('KNOWLEDGE_BASE_ERROR')
      expect(normalized.message).toBe('Unexpected remote failure')
    })

    it('createKnowledgeBasesApi delegates to ipcRenderer with exact channel names and payloads', async () => {
      const mockIpcRenderer = {
        invoke: vi.fn()
      } as unknown as typeof import('electron').ipcRenderer

      const api = createKnowledgeBasesApi(mockIpcRenderer)

      // 1. list
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
      const listOptions: KnowledgeBaseListRequest = { includeArchived: true }
      const listResult = await api.list(listOptions)
      expect(listResult).toEqual([])
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.LIST, listOptions)

      // 2. getById
      const testId = crypto.randomUUID()
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
      const getResult = await api.getById(testId)
      expect(getResult).toBeNull()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.GET_BY_ID, { id: testId })

      // 3. create
      const createInput: CreateKnowledgeBaseRequest = { name: 'New KB' }
      const mockCreated: KnowledgeBaseDto = {
        id: testId,
        name: 'New KB',
        description: '',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        archivedAt: null
      }
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockCreated)
      const createdResult = await api.create(createInput)
      expect(createdResult).toEqual(mockCreated)
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.CREATE, createInput)

      // 4. update
      const updateInput: UpdateKnowledgeBaseRequest = { name: 'Renamed KB' }
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...mockCreated,
        name: 'Renamed KB'
      })
      const updatedResult = await api.update(testId, updateInput)
      expect(updatedResult?.name).toBe('Renamed KB')
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.UPDATE, {
        id: testId,
        input: updateInput
      })

      // 5. archive
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...mockCreated,
        archivedAt: 1700000001000
      })
      const archivedResult = await api.archive(testId)
      expect(archivedResult?.archivedAt).not.toBeNull()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.ARCHIVE, { id: testId })

      // 6. unarchive
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...mockCreated,
        archivedAt: null
      })
      const unarchivedResult = await api.unarchive(testId)
      expect(unarchivedResult?.archivedAt).toBeNull()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.UNARCHIVE, { id: testId })

      // 7. delete
      const deleteResult: DeleteKnowledgeBaseResult = {
        success: true,
        directoryCleaned: true,
        cleanupPending: false
      }
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(deleteResult)
      const deleted = await api.delete(testId)
      expect(deleted).toEqual(deleteResult)
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.DELETE, { id: testId })

      // 8. getOverview
      const mockOverview: KnowledgeBaseOverviewDto = {
        knowledgeBaseId: testId,
        bots: { total: 1, active: 1, archived: 0 },
        documents: { total: 2, ready: 2, processing: 0, failed: 0, totalBytes: 2048 },
        indexing: { totalChunks: 4, totalTokens: 500, lastIndexedAt: 1700000002000 },
        recentActivity: []
      }
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockOverview)
      const overviewResult = await api.getOverview(testId)
      expect(overviewResult).toEqual(mockOverview)
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.GET_OVERVIEW, {
        id: testId
      })
    })

    it('createKnowledgeBasesApi normalizes rejection into KnowledgeBaseBridgeError', async () => {
      const mockIpcRenderer = {
        invoke: vi.fn()
      } as unknown as typeof import('electron').ipcRenderer

      const serialized = JSON.stringify({
        code: 'VALIDATION_FAILED',
        message: 'Name is required'
      })
      ;(mockIpcRenderer.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error(`Error: ${serialized}`)
      )

      const api = createKnowledgeBasesApi(mockIpcRenderer)
      await expect(api.create({ name: '' })).rejects.toThrow(KnowledgeBaseBridgeError)

      try {
        await api.create({ name: '' })
      } catch (err) {
        expect(err).toBeInstanceOf(KnowledgeBaseBridgeError)
        expect((err as KnowledgeBaseBridgeError).code).toBe('VALIDATION_FAILED')
        expect((err as KnowledgeBaseBridgeError).message).toBe('Name is required')
      }
    })
  })
})
