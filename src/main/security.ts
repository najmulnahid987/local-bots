import { join } from 'path'
import { pathToFileURL } from 'url'

export interface TrustedUrlOptions {
  isDev?: boolean
  devRendererUrl?: string
  prodHtmlPath?: string
}

export interface WebFrameMainLike {
  url: string
}

export interface WebContentsLike {
  mainFrame: WebFrameMainLike
}

export interface BrowserWindowLike {
  isDestroyed(): boolean
  webContents: WebContentsLike
}

export interface IpcSenderEventLike {
  sender: WebContentsLike
  senderFrame?: WebFrameMainLike | null
}

/**
 * Authoritative validator for trusted renderer URLs in Main process.
 * Reused across IPC sender validation and navigation event filtering.
 *
 * 1. Development: Matches only the exact configured local Vite dev server origin.
 * 2. Production: Matches only the local index.html file URL.
 */
export function isTrustedRendererUrl(urlStr: string, options?: TrustedUrlOptions): boolean {
  if (!urlStr || typeof urlStr !== 'string') {
    return false
  }

  const isDev =
    options?.isDev ??
    (Boolean(process.env['ELECTRON_RENDERER_URL']) || process.env.NODE_ENV === 'development')
  const devRendererUrl = options?.devRendererUrl ?? process.env['ELECTRON_RENDERER_URL']

  if (isDev && devRendererUrl) {
    try {
      const parsedTargetUrl = new URL(urlStr)
      const parsedTrustedUrl = new URL(devRendererUrl)
      return parsedTargetUrl.origin === parsedTrustedUrl.origin
    } catch {
      return false
    }
  } else {
    try {
      const expectedFilePath = options?.prodHtmlPath ?? join(__dirname, '../renderer/index.html')
      const expectedUrl = new URL(pathToFileURL(expectedFilePath).href)
      const actualUrl = new URL(urlStr)
      if (actualUrl.protocol !== 'file:') {
        return false
      }
      return actualUrl.pathname.toLowerCase() === expectedUrl.pathname.toLowerCase()
    } catch {
      return false
    }
  }
}

/**
 * Reusable sender validation:
 * 1. Checks that the BrowserWindow exists and is not destroyed.
 * 2. Checks that event.sender is the main BrowserWindow webContents.
 * 3. Checks that event.senderFrame exists and is the main frame.
 * 4. Checks that sender frame URL matches the trusted dev or prod URL.
 */
export function validateIpcSender(
  event: IpcSenderEventLike,
  mainWindow: BrowserWindowLike | null,
  options?: TrustedUrlOptions
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

  return isTrustedRendererUrl(frameUrl, options)
}
