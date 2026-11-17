import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DELETION_IPC_CHANNELS,
  type DeletionPreviewDto,
  type DeleteEntityResultDto,
  DeletionBridgeError
} from '../../shared/deletion'
import {
  KB_IPC_CHANNELS,
  BOT_IPC_CHANNELS,
  CONVERSATION_IPC_CHANNELS,
  KB_DOCS_IPC_CHANNELS
} from '../../shared/ipc'
import {
  registerDeletionIpcHandlers,
  registerFailingDeletionIpcHandlers
} from './deletion-handlers'
import { createDeletionApi, normalizeDeletionBridgeError } from '../../preload'
import type { DeletionService } from '../services/deletion-service'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'

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
    }
  }
})

describe('Deletion IPC Handlers (Step 9.8)', () => {
  let mockMainFrame: WebFrameMainLike
  let mockWebContents: WebContentsLike
  let mockMainWindow: BrowserWindowLike
  let authorizedEvent: IpcSenderEventLike
  let unauthorizedEvent: IpcSenderEventLike

  let mockDeletionService: Partial<DeletionService>

  const dummyPreview: DeletionPreviewDto = {
    entityType: 'conversation',
    entityId: '11111111-2222-4333-8444-555555555555',
    displayName: 'Test Conversation',
    parentName: 'Test Bot',
    parentId: '22222222-2222-4333-8444-555555555555',
    dependentCounts: {
      messages: 5,
      agentRuns: 1,
      toolEvents: 2
    },
    affectedCategories: ['Messages', 'Agent Runs'],
    unaffectedCategories: ['Bot Profile'],
    backupReversible: true,
    isBlocked: false,
    warnings: ['All messages will be removed permanently.']
  }

  const dummyDeleteResult: DeleteEntityResultDto = {
    success: true,
    entityType: 'conversation',
    entityId: '11111111-2222-4333-8444-555555555555'
  }

  beforeEach(() => {
    mockIpcHandlers.clear()
    vi.clearAllMocks()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] =
      'http://localhost:5173'

    mockMainFrame = {
      url: 'http://localhost:5173/index.html'
    }

    mockWebContents = {
      mainFrame: mockMainFrame
    }

    mockMainWindow = {
      isDestroyed: () => false,
      webContents: mockWebContents
    }

    authorizedEvent = {
      sender: mockWebContents,
      senderFrame: mockMainFrame
    }

    unauthorizedEvent = {
      sender: mockWebContents,
      senderFrame: {
        url: 'http://malicious-origin.com'
      }
    }

    mockDeletionService = {
      getPreview: vi.fn(async () => dummyPreview),
      deleteEntity: vi.fn(async () => dummyDeleteResult)
    }

    registerDeletionIpcHandlers({
      getMainWindow: () => mockMainWindow,
      deletionService: mockDeletionService as DeletionService
    })
  })

  describe('Security & Sender Frame Validation', () => {
    it('rejects invocation when sender frame is unauthorized', async () => {
      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.GET_PREVIEW)
      expect(handler).toBeDefined()

      await expect(
        handler!(unauthorizedEvent, {
          entityType: 'conversation',
          entityId: '11111111-2222-4333-8444-555555555555'
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects invocation when mainWindow is null', async () => {
      registerDeletionIpcHandlers({
        getMainWindow: () => null,
        deletionService: mockDeletionService as DeletionService
      })

      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.GET_PREVIEW)
      await expect(
        handler!(authorizedEvent, {
          entityType: 'conversation',
          entityId: '11111111-2222-4333-8444-555555555555'
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })
  })

  describe('Unified Deletion Channels', () => {
    it('handles DELETION_IPC_CHANNELS.GET_PREVIEW successfully', async () => {
      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.GET_PREVIEW)
      expect(handler).toBeDefined()

      const result = await handler!(authorizedEvent, {
        entityType: 'conversation',
        entityId: '11111111-2222-4333-8444-555555555555'
      })

      expect(mockDeletionService.getPreview).toHaveBeenCalledWith(
        'conversation',
        '11111111-2222-4333-8444-555555555555'
      )
      expect(result).toEqual(dummyPreview)
    })

    it('rejects malformed payload on GET_PREVIEW with sanitized validation error', async () => {
      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.GET_PREVIEW)

      await expect(
        handler!(authorizedEvent, {
          entityType: 'invalid_entity_type',
          entityId: 'not-a-uuid'
        })
      ).rejects.toThrow(/DELETION_PREVIEW_FAILED/)
    })

    it('handles DELETION_IPC_CHANNELS.DELETE_ENTITY successfully', async () => {
      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.DELETE_ENTITY)
      expect(handler).toBeDefined()

      const payload = {
        entityType: 'conversation',
        entityId: '11111111-2222-4333-8444-555555555555'
      }

      const result = await handler!(authorizedEvent, payload)

      expect(mockDeletionService.deleteEntity).toHaveBeenCalledWith(payload)
      expect(result).toEqual(dummyDeleteResult)
    })

    it('rejects invalid DELETE_ENTITY payload', async () => {
      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.DELETE_ENTITY)

      await expect(
        handler!(authorizedEvent, {
          entityType: 'conversation',
          entityId: 'not-a-uuid'
        })
      ).rejects.toThrow(/DELETION_FAILED/)
    })
  })

  describe('Entity-Specific Convenience Preview Channels', () => {
    it('handles KB_IPC_CHANNELS.GET_DELETION_PREVIEW', async () => {
      const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.GET_DELETION_PREVIEW)
      expect(handler).toBeDefined()

      await handler!(authorizedEvent, { id: '11111111-2222-4333-8444-555555555555' })

      expect(mockDeletionService.getPreview).toHaveBeenCalledWith(
        'knowledge_base',
        '11111111-2222-4333-8444-555555555555'
      )
    })

    it('handles BOT_IPC_CHANNELS.GET_DELETION_PREVIEW', async () => {
      const handler = mockIpcHandlers.get(BOT_IPC_CHANNELS.GET_DELETION_PREVIEW)
      expect(handler).toBeDefined()

      await handler!(authorizedEvent, { id: '11111111-2222-4333-8444-555555555555' })

      expect(mockDeletionService.getPreview).toHaveBeenCalledWith(
        'bot',
        '11111111-2222-4333-8444-555555555555'
      )
    })

    it('handles CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW)
      expect(handler).toBeDefined()

      await handler!(authorizedEvent, { id: '11111111-2222-4333-8444-555555555555' })

      expect(mockDeletionService.getPreview).toHaveBeenCalledWith(
        'conversation',
        '11111111-2222-4333-8444-555555555555'
      )
    })

    it('handles KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW', async () => {
      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW)
      expect(handler).toBeDefined()

      await handler!(authorizedEvent, { id: '11111111-2222-4333-8444-555555555555' })

      expect(mockDeletionService.getPreview).toHaveBeenCalledWith(
        'knowledge_source',
        '11111111-2222-4333-8444-555555555555'
      )
    })
  })

  describe('Preload API & Bridge Error Normalization', () => {
    it('createDeletionApi calls ipcRenderer.invoke with correct channels', async () => {
      const mockIpcRenderer = {
        invoke: vi.fn(async (): Promise<unknown> => dummyPreview)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = createDeletionApi(mockIpcRenderer as any)
      const preview = await api.getPreview('conversation', '11111111-2222-4333-8444-555555555555')

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(DELETION_IPC_CHANNELS.GET_PREVIEW, {
        entityType: 'conversation',
        entityId: '11111111-2222-4333-8444-555555555555'
      })
      expect(preview).toEqual(dummyPreview)

      mockIpcRenderer.invoke.mockResolvedValueOnce(dummyDeleteResult)
      const delResult = await api.deleteEntity({
        entityType: 'conversation',
        entityId: '11111111-2222-4333-8444-555555555555'
      })
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(DELETION_IPC_CHANNELS.DELETE_ENTITY, {
        entityType: 'conversation',
        entityId: '11111111-2222-4333-8444-555555555555'
      })
      expect(delResult).toEqual(dummyDeleteResult)
    })

    it('normalizes error JSON into DeletionBridgeError', () => {
      const err = new Error(
        JSON.stringify({
          code: 'OPERATION_BLOCKED',
          message: 'Generation is active.'
        })
      )
      const normalized = normalizeDeletionBridgeError(err)
      expect(normalized).toBeInstanceOf(DeletionBridgeError)
      expect(normalized.code).toBe('OPERATION_BLOCKED')
      expect(normalized.message).toBe('Generation is active.')
    })

    it('normalizes unstructured errors gracefully', () => {
      const normalized = normalizeDeletionBridgeError('Plain network crash')
      expect(normalized).toBeInstanceOf(DeletionBridgeError)
      expect(normalized.code).toBe('DELETION_ERROR')
      expect(normalized.message).toBe('Plain network crash')
    })
  })

  describe('Failing Handler Fallback', () => {
    it('rejects all calls with SUBSYSTEM_INITIALIZATION_FAILED when initialized with failure', async () => {
      registerFailingDeletionIpcHandlers(() => mockMainWindow, 'Database corrupted')

      const handler = mockIpcHandlers.get(DELETION_IPC_CHANNELS.GET_PREVIEW)
      expect(handler).toBeDefined()

      await expect(
        handler!(authorizedEvent, {
          entityType: 'conversation',
          entityId: '11111111-2222-4333-8444-555555555555'
        })
      ).rejects.toThrow(/SUBSYSTEM_INITIALIZATION_FAILED/)
    })
  })
})
