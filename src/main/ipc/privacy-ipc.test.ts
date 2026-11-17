import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PRIVACY_IPC_CHANNELS,
  type LocalStorageInfoDto,
  type OpenStorageFolderResponse,
  PrivacyBridgeError
} from '../../shared/privacy'
import { registerPrivacyIpcHandlers } from './privacy-handlers'
import { createPrivacyApi, normalizePrivacyBridgeError } from '../../preload'
import type { PrivacyService } from '../services/privacy-service'
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
    },
    BrowserWindow: vi.fn()
  }
})

function createMockWebContents(): WebContentsLike {
  const mainFrame = {
    url: 'http://localhost:5173/index.html'
  } as WebFrameMainLike

  return {
    mainFrame
  }
}

function createMockWindow(): BrowserWindowLike {
  const webContents = createMockWebContents()
  return {
    webContents,
    isDestroyed: () => false
  }
}

describe('Privacy IPC Bridge & Preload Integration (Step 9.9)', () => {
  let mockWindow: BrowserWindowLike
  let mockPrivacyService: Partial<PrivacyService>

  const dummyStorageInfo: LocalStorageInfoDto = {
    userDataPath: 'C:\\AppData\\Roaming\\voyaro',
    databasePath: 'C:\\AppData\\Roaming\\voyaro\\database\\app.sqlite',
    documentsPath: 'C:\\AppData\\Roaming\\voyaro\\documents',
    credentialsPath: 'C:\\AppData\\Roaming\\voyaro\\credentials',
    platform: 'win32',
    encryptionAvailable: true,
    encryptionBackend: 'dpapi',
    databaseSizeBytes: 1048576,
    walSizeBytes: 65536
  }

  const dummyOpenResponse: OpenStorageFolderResponse = {
    success: true,
    target: 'documents'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIpcHandlers.clear()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] =
      'http://localhost:5173'
    mockWindow = createMockWindow()

    mockPrivacyService = {
      getStorageInfo: vi.fn().mockResolvedValue(dummyStorageInfo),
      openStorageFolder: vi.fn().mockResolvedValue(dummyOpenResponse)
    }

    registerPrivacyIpcHandlers({
      getMainWindow: () => mockWindow,
      privacyService: mockPrivacyService as PrivacyService
    })
  })

  function createValidEvent(): IpcSenderEventLike {
    return {
      senderFrame: mockWindow.webContents.mainFrame,
      sender: mockWindow.webContents
    }
  }

  it('1. registers privacy IPC channels', () => {
    expect(mockIpcHandlers.has(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)).toBe(true)
    expect(mockIpcHandlers.has(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER)).toBe(true)
  })

  it('2. getStorageInfo handler checks sender and returns storage info', async () => {
    const handler = mockIpcHandlers.get(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)!
    const res = await handler(createValidEvent())

    expect(mockPrivacyService.getStorageInfo).toHaveBeenCalled()
    expect(res).toEqual(dummyStorageInfo)
  })

  it('3. openStorageFolder handler validates payload and executes open', async () => {
    const handler = mockIpcHandlers.get(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER)!
    const res = await handler(createValidEvent(), { target: 'documents' })

    expect(mockPrivacyService.openStorageFolder).toHaveBeenCalledWith('documents')
    expect(res).toEqual(dummyOpenResponse)
  })

  it('4. openStorageFolder rejects invalid target payload', async () => {
    const handler = mockIpcHandlers.get(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER)!

    await expect(handler(createValidEvent(), { target: 'invalid' })).rejects.toThrow()
    await expect(
      handler(createValidEvent(), { target: 'documents', extra: true })
    ).rejects.toThrow()
  })

  it('5. rejects unauthorized senderFrame', async () => {
    const handler = mockIpcHandlers.get(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)!
    const untrustedEvent: IpcSenderEventLike = {
      senderFrame: { url: 'http://malicious.attacker.com' } as WebFrameMainLike,
      sender: mockWindow.webContents
    }

    await expect(handler(untrustedEvent)).rejects.toThrow('UNAUTHORIZED_SENDER')
  })

  it('6. createPrivacyApi wraps ipcRenderer with proper channels', async () => {
    const mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue(dummyStorageInfo)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = createPrivacyApi(mockIpcRenderer as any)
    const info = await api.getStorageInfo()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)
    expect(info).toEqual(dummyStorageInfo)

    mockIpcRenderer.invoke.mockResolvedValueOnce(dummyOpenResponse)
    const openRes = await api.openStorageFolder('database')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER, {
      target: 'database'
    })
    expect(openRes).toEqual(dummyOpenResponse)
  })

  it('7. normalizePrivacyBridgeError parses JSON error message or falls back', () => {
    const jsonErr = new Error(
      JSON.stringify({ code: 'FOLDER_ACCESS_DENIED', message: 'Failed to access folder.' })
    )
    const normalized = normalizePrivacyBridgeError(jsonErr)
    expect(normalized).toBeInstanceOf(PrivacyBridgeError)
    expect(normalized.code).toBe('FOLDER_ACCESS_DENIED')
    expect(normalized.message).toBe('Failed to access folder.')

    const plainErr = new Error('Raw IPC error')
    const fallback = normalizePrivacyBridgeError(plainErr)
    expect(fallback).toBeInstanceOf(PrivacyBridgeError)
    expect(fallback.code).toBe('PRIVACY_ERROR')
    expect(fallback.message).toBe('Raw IPC error')
  })
})
