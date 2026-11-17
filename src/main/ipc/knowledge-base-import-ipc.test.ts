import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  KB_IPC_CHANNELS,
  type ImportPreviewResultDto,
  type ExecuteImportResultDto,
  type CancelImportResultDto
} from '../../shared/ipc'
import {
  registerKnowledgeBaseIpcHandlers,
  registerFailingKnowledgeBaseIpcHandlers
} from './knowledge-base-handlers'
import { createKnowledgeBasesApi } from '../../preload'
import type { KnowledgeBaseManager } from '../services/knowledge-base-manager'
import type { BackupImportManager } from '../services/backup-import-manager'
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

describe('Knowledge Base Import IPC & Preload Bridge', () => {
  const validSessionId = '11111111-1111-4111-8111-111111111111'
  const validKbId = '22222222-2222-4222-8222-222222222222'
  let mockKbManager: KnowledgeBaseManager
  let mockImportManager: {
    selectAndPreviewArchive: ReturnType<typeof vi.fn>
    executeImport: ReturnType<typeof vi.fn>
    cancelImport: ReturnType<typeof vi.fn>
  }

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
    mockImportManager = {
      selectAndPreviewArchive: vi.fn().mockResolvedValue({
        success: true,
        cancelled: false,
        preview: {
          sessionId: validSessionId,
          archiveName: 'test.voyaro-kb.zip',
          archiveSizeBytes: 54321,
          format: 'voyaro-knowledge-base-export',
          schemaVersion: '1.0.0',
          exportedAt: 1234567890,
          appVersion: '1.0.0',
          knowledgeBase: {
            id: validKbId,
            name: 'Preview KB',
            description: 'Preview desc'
          },
          counts: {
            bots: 2,
            memories: 3,
            sources: 1,
            conversations: 1,
            messages: 4,
            totalSourceBytes: 1024
          },
          documentFiles: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              originalFileName: 'test.txt',
              fileType: 'txt',
              sizeBytes: 1024
            }
          ],
          securityNotice: 'Security notice active'
        }
      } satisfies ImportPreviewResultDto),

      executeImport: vi.fn().mockResolvedValue({
        success: true,
        cancelled: false,
        strategy: 'new',
        knowledgeBaseId: validKbId,
        knowledgeBaseName: 'Restored KB',
        counts: {
          bots: 2,
          memories: 3,
          sources: 1,
          conversations: 1,
          messages: 4,
          indexedSources: 1,
          failedSources: 0
        }
      } satisfies ExecuteImportResultDto),

      cancelImport: vi.fn().mockResolvedValue({
        success: true
      } satisfies CancelImportResultDto)
    }
  })

  it('1. registers import IPC handlers and forwards selectAndPreview calls correctly', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined,
      mockImportManager as unknown as BackupImportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)
    expect(handler).toBeDefined()

    const event = createMockSenderEvent(mockWindow)
    const result = (await handler!(event)) as ImportPreviewResultDto

    expect(result.success).toBe(true)
    expect(result.preview?.knowledgeBase.name).toBe('Preview KB')
    expect(mockImportManager.selectAndPreviewArchive).toHaveBeenCalledTimes(1)
  })

  it('2. validates and executes import request via IPC handler', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined,
      mockImportManager as unknown as BackupImportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_EXECUTE)
    expect(handler).toBeDefined()

    const event = createMockSenderEvent(mockWindow)
    const result = (await handler!(event, {
      sessionId: validSessionId,
      strategy: 'new'
    })) as ExecuteImportResultDto

    expect(result.success).toBe(true)
    expect(result.knowledgeBaseId).toBe(validKbId)
    expect(mockImportManager.executeImport).toHaveBeenCalledWith({
      sessionId: validSessionId,
      strategy: 'new'
    })
  })

  it('3. rejects execute import request with invalid payload schema', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined,
      mockImportManager as unknown as BackupImportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_EXECUTE)
    const event = createMockSenderEvent(mockWindow)

    // Missing strategy and invalid sessionId
    await expect(handler!(event, { sessionId: 'not-a-uuid' })).rejects.toThrow()
  })

  it('4. forwards cancel import request via IPC handler', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined,
      mockImportManager as unknown as BackupImportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_CANCEL)
    expect(handler).toBeDefined()

    const event = createMockSenderEvent(mockWindow)
    const result = (await handler!(event, {
      sessionId: validSessionId
    })) as CancelImportResultDto

    expect(result.success).toBe(true)
    expect(mockImportManager.cancelImport).toHaveBeenCalledWith({
      sessionId: validSessionId
    })
  })

  it('5. enforces sender frame validation and rejects unauthorized frames', async () => {
    registerKnowledgeBaseIpcHandlers(
      () => mockWindow,
      mockKbManager,
      undefined,
      mockImportManager as unknown as BackupImportManager
    )

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)
    const maliciousEvent: IpcSenderEventLike = {
      sender: mockWebContents,
      senderFrame: createMockFrame('http://evil-attacker.com')
    }

    await expect(handler!(maliciousEvent)).rejects.toThrow(/UNAUTHORIZED_SENDER/)
  })

  it('6. invokes IPC channels from preload bridge methods', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockImplementation((channel: string) => {
        if (channel === KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW) {
          return Promise.resolve({ success: true, preview: { sessionId: validSessionId } })
        }
        if (channel === KB_IPC_CHANNELS.IMPORT_EXECUTE) {
          return Promise.resolve({ success: true, strategy: 'new' })
        }
        if (channel === KB_IPC_CHANNELS.IMPORT_CANCEL) {
          return Promise.resolve({ success: true })
        }
        return Promise.reject(new Error(`Unhandled channel: ${channel}`))
      })
    }

    const api = createKnowledgeBasesApi(
      mockIpcRenderer as unknown as typeof import('electron').ipcRenderer
    )

    const previewRes = await api.importSelectAndPreview!()
    expect(previewRes.success).toBe(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)

    const execRes = await api.importExecute!({ sessionId: validSessionId, strategy: 'new' })
    expect(execRes.success).toBe(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.IMPORT_EXECUTE, {
      sessionId: validSessionId,
      strategy: 'new'
    })

    const cancelRes = await api.importCancel!({ sessionId: validSessionId })
    expect(cancelRes.success).toBe(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(KB_IPC_CHANNELS.IMPORT_CANCEL, {
      sessionId: validSessionId
    })
  })

  it('7. safely rejects with SUBSYSTEM_INITIALIZATION_FAILED when fallback handlers are registered', async () => {
    registerFailingKnowledgeBaseIpcHandlers(() => mockWindow, 'Storage subsystem degraded.')

    const handler = mockIpcHandlers.get(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)
    expect(handler).toBeDefined()

    const event = createMockSenderEvent(mockWindow)
    await expect(handler!(event)).rejects.toThrow(/SUBSYSTEM_INITIALIZATION_FAILED/)
  })
})
