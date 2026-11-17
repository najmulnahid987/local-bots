import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DIAGNOSTICS_IPC_CHANNELS,
  type DatabaseHealthDto,
  type DiagnosticsExportResultDto,
  DiagnosticsBridgeError,
  databaseHealthDtoSchema,
  diagnosticsExportResultDtoSchema
} from '../../shared/diagnostics'
import {
  registerDiagnosticsIpcHandlers,
  registerFailingDiagnosticsIpcHandlers
} from './diagnostics-handlers'
import { createDiagnosticsApi, normalizeDiagnosticsBridgeError } from '../../preload'
import type { DatabaseIntegrityService } from '../services/database-integrity-service'
import type { DiagnosticsExportService } from '../services/diagnostics-export-service'
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

function createMockWebContents(): WebContentsLike {
  const mainFrame = {
    url: 'http://localhost:5173/index.html'
  } as WebFrameMainLike

  return {
    mainFrame
  }
}

function createMockBrowserWindow(
  webContents: WebContentsLike,
  destroyed = false
): BrowserWindowLike {
  return {
    isDestroyed: () => destroyed,
    webContents
  }
}

describe('Diagnostics IPC Handlers & Bridge Integration', () => {
  let mockWebContents: WebContentsLike
  let mockWindow: BrowserWindowLike
  let authorizedEvent: IpcSenderEventLike
  let unauthorizedEvent: IpcSenderEventLike

  let mockIntegrityService: DatabaseIntegrityService
  let mockExportService: DiagnosticsExportService

  const sampleHealth: DatabaseHealthDto = {
    status: 'healthy',
    integrityStatus: 'ok',
    foreignKeyStatus: 'ok',
    databaseAvailable: true,
    databaseSizeBytes: 65536,
    walSizeBytes: 0,
    lastVerifiedAt: Date.now(),
    violationsCount: 0,
    violations: [],
    summary: 'Database is healthy and fully consistent.',
    diagnosticCodes: [],
    recoveryGuidance: []
  }

  const sampleExportResult: DiagnosticsExportResultDto = {
    success: true,
    filename: 'local-first-ai-diagnostics-2026-11-17.json',
    sizeBytes: 1024,
    exportedAt: Date.now(),
    schemaVersion: '1.0.0',
    verified: true
  }

  beforeEach(() => {
    mockIpcHandlers.clear()
    const devOrigin = 'http://localhost:5173'
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin

    mockWebContents = createMockWebContents()
    mockWindow = createMockBrowserWindow(mockWebContents)

    authorizedEvent = {
      senderFrame: mockWebContents.mainFrame,
      sender: mockWebContents
    } as unknown as IpcSenderEventLike

    unauthorizedEvent = {
      senderFrame: { url: 'https://evil.attacker.com' } as WebFrameMainLike,
      sender: mockWebContents
    } as unknown as IpcSenderEventLike

    mockIntegrityService = {
      getDatabaseHealth: vi.fn().mockResolvedValue(sampleHealth),
      runIntegrityCheck: vi.fn().mockResolvedValue(sampleHealth)
    } as unknown as DatabaseIntegrityService

    mockExportService = {
      exportDiagnostics: vi.fn().mockResolvedValue(sampleExportResult)
    } as unknown as DiagnosticsExportService
  })

  describe('Registration & Sender Validation', () => {
    it('registers handlers for all diagnostics channels', () => {
      registerDiagnosticsIpcHandlers({
        getMainWindow: () => mockWindow,
        integrityService: mockIntegrityService,
        exportService: mockExportService
      })

      expect(mockIpcHandlers.has(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)).toBe(true)
      expect(mockIpcHandlers.has(DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK)).toBe(true)
      expect(mockIpcHandlers.has(DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS)).toBe(true)
    })

    it('rejects invocations from unauthorized sender frames', async () => {
      registerDiagnosticsIpcHandlers({
        getMainWindow: () => mockWindow,
        integrityService: mockIntegrityService,
        exportService: mockExportService
      })

      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)!
      await expect(handler(unauthorizedEvent)).rejects.toThrow('UNAUTHORIZED_SENDER')
    })

    it('rejects invocations when mainWindow is null or destroyed', async () => {
      registerDiagnosticsIpcHandlers({
        getMainWindow: () => null,
        integrityService: mockIntegrityService,
        exportService: mockExportService
      })

      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)!
      await expect(handler(authorizedEvent)).rejects.toThrow('UNAUTHORIZED_SENDER')
    })
  })

  describe('Channel Execution', () => {
    beforeEach(() => {
      registerDiagnosticsIpcHandlers({
        getMainWindow: () => mockWindow,
        integrityService: mockIntegrityService,
        exportService: mockExportService
      })
    })

    it('GET_DATABASE_HEALTH returns verified health DTO', async () => {
      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)!
      const result = await handler(authorizedEvent)

      expect(mockIntegrityService.getDatabaseHealth).toHaveBeenCalledTimes(1)
      expect(databaseHealthDtoSchema.safeParse(result).success).toBe(true)
      expect(result).toEqual(sampleHealth)
    })

    it('RUN_INTEGRITY_CHECK runs check and returns fresh health DTO', async () => {
      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK)!
      const result = await handler(authorizedEvent)

      expect(mockIntegrityService.runIntegrityCheck).toHaveBeenCalledTimes(1)
      expect(databaseHealthDtoSchema.safeParse(result).success).toBe(true)
      expect(result).toEqual(sampleHealth)
    })

    it('EXPORT_DIAGNOSTICS calls export service and returns result DTO', async () => {
      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS)!
      const result = await handler(authorizedEvent)

      expect(mockExportService.exportDiagnostics).toHaveBeenCalledTimes(1)
      expect(diagnosticsExportResultDtoSchema.safeParse(result).success).toBe(true)
      expect(result).toEqual(sampleExportResult)
    })

    it('sanitizes internal errors and redacts secrets upon failure', async () => {
      vi.mocked(mockIntegrityService.runIntegrityCheck).mockRejectedValueOnce(
        new Error(
          'Failed reading sk-ant-api03-secret123456789012345678901234567890 at C:\\Users\\User\\secret.db'
        )
      )

      const handler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK)!
      await expect(handler(authorizedEvent)).rejects.toThrow()

      try {
        await handler(authorizedEvent)
      } catch (err: unknown) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.message).not.toContain('sk-ant-api03')
        expect(parsed.message).not.toContain('C:\\Users\\User')
        expect(parsed.message).toContain('[REDACTED_API_KEY]')
        expect(parsed.message).toContain('[REDACTED_PATH]')
      }
    })
  })

  describe('Failing Handler Registration', () => {
    it('registers failing handlers that reject with SUBSYSTEM_INITIALIZATION_FAILED', async () => {
      registerFailingDiagnosticsIpcHandlers(
        () => mockWindow,
        'Database connection failed for sk-proj-123456789012345678901234567890'
      )

      const healthHandler = mockIpcHandlers.get(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)!
      await expect(healthHandler(authorizedEvent)).rejects.toThrow()

      try {
        await healthHandler(authorizedEvent)
      } catch (err: unknown) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('SUBSYSTEM_INITIALIZATION_FAILED')
        expect(parsed.message).not.toContain('sk-proj')
        expect(parsed.message).toContain('[REDACTED_API_KEY]')
      }
    })
  })

  describe('Preload Diagnostics API Bridge', () => {
    it('invokes ipcRenderer with proper channels', async () => {
      const mockIpcRenderer = {
        invoke: vi.fn().mockImplementation(async (channel: string) => {
          if (channel === DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH) return sampleHealth
          if (channel === DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK) return sampleHealth
          if (channel === DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS) return sampleExportResult
          throw new Error('Unknown channel')
        })
      } as unknown as typeof import('electron').ipcRenderer

      const bridge = createDiagnosticsApi(mockIpcRenderer)

      const health = await bridge.getDatabaseHealth()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH
      )
      expect(health).toEqual(sampleHealth)

      const checked = await bridge.runIntegrityCheck()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK
      )
      expect(checked).toEqual(sampleHealth)

      const exportRes = await bridge.exportDiagnostics()
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS
      )
      expect(exportRes).toEqual(sampleExportResult)
    })

    it('normalizes ipc errors into DiagnosticsBridgeError', async () => {
      const errorJson = JSON.stringify({
        code: 'INTEGRITY_FAILED',
        message: 'Database file corrupted'
      })
      const mockIpcRenderer = {
        invoke: vi.fn().mockRejectedValue(new Error(`Error occurred: ${errorJson}`))
      } as unknown as typeof import('electron').ipcRenderer

      const bridge = createDiagnosticsApi(mockIpcRenderer)
      await expect(bridge.runIntegrityCheck()).rejects.toThrow(DiagnosticsBridgeError)

      try {
        await bridge.runIntegrityCheck()
      } catch (err) {
        expect(err).toBeInstanceOf(DiagnosticsBridgeError)
        expect((err as DiagnosticsBridgeError).code).toBe('INTEGRITY_FAILED')
        expect((err as DiagnosticsBridgeError).message).toBe('Database file corrupted')
      }
    })

    it('normalizes unstructured errors with default DIAGNOSTICS_ERROR code', () => {
      const bridgeErr = normalizeDiagnosticsBridgeError(new Error('Network disconnected'))
      expect(bridgeErr).toBeInstanceOf(DiagnosticsBridgeError)
      expect(bridgeErr.code).toBe('DIAGNOSTICS_ERROR')
      expect(bridgeErr.message).toBe('Network disconnected')
    })
  })
})
