import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KB_IPC_CHANNELS, type ExportKnowledgeBaseResultDto } from '../../shared/ipc'
import {
  registerKnowledgeBaseIpcHandlers,
  registerFailingKnowledgeBaseIpcHandlers
} from './knowledge-base-handlers'
import { createKnowledgeBasesApi } from '../../preload'
import type { KnowledgeBaseManager } from '../services/knowledge-base-manager'
import type { BackupExportManager } from '../services/backup-export-manager'
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
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      on: vi.fn(),
      removeListener: vi.fn(),
      invoke: vi.fn()
    }
  }
})

let mockWindow: BrowserWindowLike
let mockWebContents: WebContentsLike
let mockMainFrame: WebFrameMainLike

function createMockFrame(origin: string = 'http://localhost:5173'): WebFrameMainLike {
  return {
    url: `${origin}/index.html`
  }
}

function createMockSenderEvent(window: BrowserWindowLike): IpcSenderEventLike {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame
  }
}

describe('Knowledge Base Export IPC & Preload Bridge', () => {
  const validKbId = '11111111-1111-4111-8111-111111111111'
  let mockKbManager: KnowledgeBaseManager
  let mockExportManager: { exportKnowledgeBase: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] =
      'http://localhost:5173'
    mockIpcHandlers.clear()

    mockMainFrame = createMockFrame('http://localhost:5173')
    mockWebContents = {
      mainFrame: mockMainFrame
    }
    mockWindow = {
      webContents: mockWebContents,
      isDestroyed: vi.fn().mockReturnValue(false)
    }

    mockKbManager = {} as unknown as KnowledgeBaseManager
    mockExportManager = {
      exportKnowledgeBase: vi.fn().mockResolvedValue({
        success: true,
        knowledgeBaseId: validKbId,
        archivePath: '/path/to/archive.voyaro-kb.zip',
        archiveSizeBytes: 12345,
        counts: {
          bots: 1,
          memories: 2,
          sources: 3,
          conversations: 4,
          messages: 5,
          totalSourceBytes: 6789
        }
      } satisfies ExportKnowledgeBaseResultDto)
    }
  })

  it('successfully triggers export handler and returns result DTO', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      mockExportManager as unknown as BackupExportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.EXPORT)
    expect(handler).toBeDefined()

    const event = createMockSenderEvent(mockWindow)
    const result = (await handler!(event, { id: validKbId })) as ExportKnowledgeBaseResultDto

    expect(result.success).toBe(true)
    expect(result.knowledgeBaseId).toBe(validKbId)
    expect(result.archivePath).toBe('/path/to/archive.voyaro-kb.zip')
    expect(mockExportManager.exportKnowledgeBase).toHaveBeenCalledWith(validKbId)
  })

  it('createKnowledgeBasesApi delegates to ipcRenderer with exact channel and payload', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue({
        success: true,
        knowledgeBaseId: validKbId,
        archivePath: '/path/to/archive.voyaro-kb.zip'
      })
    } as unknown as typeof import('electron').ipcRenderer

    const api = createKnowledgeBasesApi(mockIpcRenderer)
    expect(api.export).toBeDefined()
    const result = await api.export!(validKbId)

    expect(result.success).toBe(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.EXPORT, { id: validKbId })
  })

  it('rejects IPC invocation when sender frame is unauthorized', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      mockExportManager as unknown as BackupExportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.EXPORT)
    expect(handler).toBeDefined()

    const unauthorizedEvent: IpcSenderEventLike = {
      sender: mockWebContents,
      senderFrame: createMockFrame('https://evil-external-site.com')
    }

    await expect(handler!(unauthorizedEvent, { id: validKbId })).rejects.toThrow(
      /UNAUTHORIZED_SENDER/
    )
  })

  it('rejects IPC payload with invalid UUID format', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      mockExportManager as unknown as BackupExportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.EXPORT)
    const event = createMockSenderEvent(mockWindow)

    await expect(handler!(event, { id: 'not-a-valid-uuid' })).rejects.toThrow(/VALIDATION_ERROR/)
  })

  it('rejects when export subsystem is not initialized', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined // No export manager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.EXPORT)
    const event = createMockSenderEvent(mockWindow)

    await expect(handler!(event, { id: validKbId })).rejects.toThrow(
      /Export subsystem is not initialized/
    )
  })

  it('handles failing subsystem registration gracefully', async () => {
    registerFailingKnowledgeBaseIpcHandlers(
      () => mockWindow,
      'Database subsystem failed to initialize.'
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.EXPORT)
    expect(handler).toBeDefined()
    const event = createMockSenderEvent(mockWindow)

    await expect(handler!(event, { id: validKbId })).rejects.toThrow(
      /SUBSYSTEM_INITIALIZATION_FAILED/
    )
  })
})
