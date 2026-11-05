import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { z } from 'zod'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { IPC_CHANNELS, PingResponse } from '../shared/ipc'

/**
 * Strict Zod schema for PingRequest.
 * Enforces valid UUID format and strictly rejects unknown extra properties.
 */
export const pingRequestSchema = z
  .object({
    requestId: z.string().uuid()
  })
  .strict()

/**
 * Reusable sender validation:
 * 1. Checks that the BrowserWindow exists and is not destroyed.
 * 2. Checks that event.sender is the main BrowserWindow webContents.
 * 3. Checks that event.senderFrame exists and is the main frame.
 * 4. Checks that sender frame URL matches the trusted dev or prod URL.
 */
export function validateIpcSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false
  }

  if (event.sender !== mainWindow.webContents) {
    return false
  }

  const senderFrame = event.senderFrame
  if (!senderFrame) {
    return false
  }

  if (senderFrame !== mainWindow.webContents.mainFrame) {
    return false
  }

  const frameUrl = senderFrame.url
  if (!frameUrl) {
    return false
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    try {
      const parsedFrameUrl = new URL(frameUrl)
      const parsedTrustedUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
      if (parsedFrameUrl.origin !== parsedTrustedUrl.origin) {
        return false
      }
    } catch {
      return false
    }
  } else {
    try {
      const expectedFilePath = join(__dirname, '../renderer/index.html')
      const expectedFileUrl = pathToFileURL(expectedFilePath).href.toLowerCase()
      const actualFileUrl = frameUrl.toLowerCase()
      if (actualFileUrl !== expectedFileUrl) {
        return false
      }
    } catch {
      return false
    }
  }

  return true
}

/**
 * Register Main process IPC handlers.
 * Avoids registering duplicate handlers.
 */
export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.removeHandler(IPC_CHANNELS.PING)

  ipcMain.handle(IPC_CHANNELS.PING, async (event, rawPayload: unknown): Promise<PingResponse> => {
    const mainWindow = getMainWindow()

    if (!validateIpcSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: invalid sender')
    }

    const parseResult = pingRequestSchema.safeParse(rawPayload)
    if (!parseResult.success) {
      throw new Error('Invalid IPC request payload')
    }

    return {
      ok: true,
      message: 'pong',
      requestId: parseResult.data.requestId,
      timestamp: Date.now()
    }
  })
}

