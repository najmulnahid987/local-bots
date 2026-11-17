import { ipcMain, BrowserWindow } from 'electron'
import {
  DIAGNOSTICS_IPC_CHANNELS,
  type DatabaseHealthDto,
  type DiagnosticsExportResultDto
} from '../../shared/diagnostics'
import type { DatabaseIntegrityService } from '../services/database-integrity-service'
import type { DiagnosticsExportService } from '../services/diagnostics-export-service'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import { DiagnosticSanitizer } from '../services/diagnostic-sanitizer'

export interface DiagnosticsIpcHandlerOptions {
  readonly getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  readonly integrityService: DatabaseIntegrityService
  readonly exportService: DiagnosticsExportService
}

/**
 * Registers secure IPC handlers for database health checks and technical diagnostics export.
 */
export function registerDiagnosticsIpcHandlers(options: DiagnosticsIpcHandlerOptions): void {
  const { getMainWindow, integrityService, exportService } = options

  const assertAuthorizedSender = (event: IpcSenderEventLike): BrowserWindowLike => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }
    return mainWindow!
  }

  // 1. Get Database Health
  ipcMain.removeHandler(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)
  ipcMain.handle(
    DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH,
    async (event: IpcSenderEventLike): Promise<DatabaseHealthDto> => {
      assertAuthorizedSender(event)
      try {
        return await integrityService.getDatabaseHealth()
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'HEALTH_CHECK_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  // 2. Run Database Integrity Check
  ipcMain.removeHandler(DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK)
  ipcMain.handle(
    DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK,
    async (event: IpcSenderEventLike): Promise<DatabaseHealthDto> => {
      assertAuthorizedSender(event)
      try {
        return await integrityService.runIntegrityCheck()
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'INTEGRITY_CHECK_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  // 3. Export Technical Diagnostics
  ipcMain.removeHandler(DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS)
  ipcMain.handle(
    DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS,
    async (event: IpcSenderEventLike): Promise<DiagnosticsExportResultDto> => {
      assertAuthorizedSender(event)
      try {
        return await exportService.exportDiagnostics()
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DIAGNOSTICS_EXPORT_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )
}

/**
 * Registers safe fallback handlers for all Diagnostics channels if
 * Main process subsystem initialization fails.
 */
export function registerFailingDiagnosticsIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  reason: string
): void {
  const assertAuthorizedSender = (event: IpcSenderEventLike): BrowserWindowLike => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }
    return mainWindow!
  }

  const failingHandler = async (event: IpcSenderEventLike): Promise<never> => {
    assertAuthorizedSender(event)
    const sanitized = DiagnosticSanitizer.sanitizeError(reason, 'SUBSYSTEM_INITIALIZATION_FAILED')
    throw new Error(JSON.stringify(sanitized))
  }

  const channels = [
    DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH,
    DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK,
    DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS
  ]

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
