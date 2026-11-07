import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS, PingResponse } from '../shared/ipc'
import { pingRequestSchema } from './validation'
import { validateIpcSender } from './security'

export { pingRequestSchema } from './validation'
export {
  isTrustedRendererUrl,
  validateIpcSender,
  type TrustedUrlOptions,
  type WebFrameMainLike,
  type WebContentsLike,
  type BrowserWindowLike,
  type IpcSenderEventLike
} from './security'

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

export * from './ipc/index'
