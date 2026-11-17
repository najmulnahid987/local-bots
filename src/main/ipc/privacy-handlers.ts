import { ipcMain, BrowserWindow } from 'electron'
import {
  PRIVACY_IPC_CHANNELS,
  openStorageFolderRequestSchema,
  type LocalStorageInfoDto,
  type OpenStorageFolderResponse
} from '../../shared/privacy'
import type { PrivacyService } from '../services/privacy-service'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import { DiagnosticSanitizer } from '../services/diagnostic-sanitizer'

export interface PrivacyIpcHandlerOptions {
  readonly getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  readonly privacyService: PrivacyService
}

/**
 * Registers secure, sender-validated IPC handlers for privacy disclosures and local folder opening.
 */
export function registerPrivacyIpcHandlers(options: PrivacyIpcHandlerOptions): void {
  const { getMainWindow, privacyService } = options

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

  // 1. Get Local Storage Info
  ipcMain.removeHandler(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)
  ipcMain.handle(
    PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO,
    async (event: IpcSenderEventLike): Promise<LocalStorageInfoDto> => {
      assertAuthorizedSender(event)
      try {
        return await privacyService.getStorageInfo()
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'STORAGE_INFO_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  // 2. Open Storage Folder
  ipcMain.removeHandler(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER)
  ipcMain.handle(
    PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<OpenStorageFolderResponse> => {
      assertAuthorizedSender(event)
      try {
        const payload = openStorageFolderRequestSchema.parse(rawPayload)
        return await privacyService.openStorageFolder(payload.target)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'OPEN_STORAGE_FOLDER_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )
}

/**
 * Registers fallback handlers when Privacy subsystem initialization fails.
 */
export function registerFailingPrivacyIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  failureReason: string
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
    throw new Error(
      JSON.stringify({
        code: 'SUBSYSTEM_INITIALIZATION_FAILED',
        message: failureReason
      })
    )
  }

  for (const channel of Object.values(PRIVACY_IPC_CHANNELS)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
