import { describe, it, expect } from 'vitest'
import {
  isTrustedRendererUrl,
  validateIpcSender,
  BrowserWindowLike,
  IpcSenderEventLike,
  WebContentsLike,
  WebFrameMainLike
} from './security'
import { pathToFileURL } from 'url'
import { resolve } from 'path'

describe('Security: isTrustedRendererUrl', () => {
  const devOrigin = 'http://localhost:5173'
  const prodFilePath = resolve('C:/mock/app/out/renderer/index.html')
  const prodFileUrl = pathToFileURL(prodFilePath).href

  describe('Development mode validation', () => {
    const devOptions = { isDev: true, devRendererUrl: devOrigin }

    it('accepts the exact dev server root URL', () => {
      expect(isTrustedRendererUrl(devOrigin, devOptions)).toBe(true)
      expect(isTrustedRendererUrl(`${devOrigin}/`, devOptions)).toBe(true)
    })

    it('accepts dev server sub-paths and query parameters', () => {
      expect(isTrustedRendererUrl(`${devOrigin}/index.html`, devOptions)).toBe(true)
      expect(isTrustedRendererUrl(`${devOrigin}/sub/path?query=1`, devOptions)).toBe(true)
    })

    it('rejects external hostnames', () => {
      expect(isTrustedRendererUrl('https://example.com', devOptions)).toBe(false)
      expect(isTrustedRendererUrl('http://attacker.com:5173', devOptions)).toBe(false)
    })

    it('rejects different local ports', () => {
      expect(isTrustedRendererUrl('http://localhost:3000', devOptions)).toBe(false)
      expect(isTrustedRendererUrl('http://localhost:8080', devOptions)).toBe(false)
    })

    it('rejects different protocols', () => {
      expect(isTrustedRendererUrl('ftp://localhost:5173', devOptions)).toBe(false)
      expect(isTrustedRendererUrl('file:///C:/test/index.html', devOptions)).toBe(false)
      expect(isTrustedRendererUrl('javascript:alert(1)', devOptions)).toBe(false)
    })

    it('safely rejects empty or malformed strings without throwing', () => {
      expect(isTrustedRendererUrl('', devOptions)).toBe(false)
      expect(isTrustedRendererUrl('not-a-valid-url', devOptions)).toBe(false)
      expect(isTrustedRendererUrl(null as unknown as string, devOptions)).toBe(false)
    })
  })

  describe('Production mode validation', () => {
    const prodOptions = { isDev: false, prodHtmlPath: prodFilePath }

    it('accepts the canonical local production HTML file URL', () => {
      expect(isTrustedRendererUrl(prodFileUrl, prodOptions)).toBe(true)
    })

    it('accepts case-insensitive file URLs', () => {
      expect(isTrustedRendererUrl(prodFileUrl.toUpperCase(), prodOptions)).toBe(true)
    })

    it('rejects arbitrary file system paths', () => {
      const untrustedFilePath = resolve('C:/Windows/System32/calc.exe')
      const untrustedFileUrl = pathToFileURL(untrustedFilePath).href
      expect(isTrustedRendererUrl(untrustedFileUrl, prodOptions)).toBe(false)
    })

    it('rejects http/https origins in production mode', () => {
      expect(isTrustedRendererUrl('http://localhost:5173', prodOptions)).toBe(false)
      expect(isTrustedRendererUrl('https://example.com', prodOptions)).toBe(false)
    })

    it('safely rejects empty or malformed URLs in production mode', () => {
      expect(isTrustedRendererUrl('', prodOptions)).toBe(false)
      expect(isTrustedRendererUrl('file://', prodOptions)).toBe(false)
    })
  })
})

describe('Security: validateIpcSender', () => {
  const devOrigin = 'http://localhost:5173'
  const options = { isDev: true, devRendererUrl: devOrigin }

  function createMockFixtures(): {
    mainFrame: WebFrameMainLike
    webContents: WebContentsLike
    mainWindow: BrowserWindowLike
    validEvent: IpcSenderEventLike
  } {
    const mainFrame: WebFrameMainLike = {
      url: `${devOrigin}/index.html`
    }

    const webContents: WebContentsLike = {
      mainFrame
    }

    const mainWindow: BrowserWindowLike = {
      isDestroyed: () => false,
      webContents
    }

    const validEvent: IpcSenderEventLike = {
      sender: webContents,
      senderFrame: mainFrame
    }

    return { mainFrame, webContents, mainWindow, validEvent }
  }

  it('accepts a valid IPC event from the main frame of the main window', () => {
    const { validEvent, mainWindow } = createMockFixtures()
    expect(validateIpcSender(validEvent, mainWindow, options)).toBe(true)
  })

  it('rejects when mainWindow is null', () => {
    const { validEvent } = createMockFixtures()
    expect(validateIpcSender(validEvent, null, options)).toBe(false)
  })

  it('rejects when mainWindow has been destroyed', () => {
    const { validEvent, mainWindow } = createMockFixtures()
    mainWindow.isDestroyed = () => true
    expect(validateIpcSender(validEvent, mainWindow, options)).toBe(false)
  })

  it('rejects when event sender webContents does not match mainWindow webContents', () => {
    const { validEvent, mainWindow } = createMockFixtures()
    const foreignWebContents: WebContentsLike = {
      mainFrame: { url: `${devOrigin}/index.html` }
    }
    const maliciousEvent: IpcSenderEventLike = {
      ...validEvent,
      sender: foreignWebContents
    }
    expect(validateIpcSender(maliciousEvent, mainWindow, options)).toBe(false)
  })

  it('rejects when senderFrame is missing or null', () => {
    const { validEvent, mainWindow } = createMockFixtures()
    const missingFrameEvent: IpcSenderEventLike = {
      ...validEvent,
      senderFrame: null
    }
    expect(validateIpcSender(missingFrameEvent, mainWindow, options)).toBe(false)
  })

  it('rejects when senderFrame is not the mainFrame (subframe execution attempt)', () => {
    const { validEvent, mainWindow } = createMockFixtures()
    const subframe: WebFrameMainLike = {
      url: `${devOrigin}/iframe.html`
    }
    const subframeEvent: IpcSenderEventLike = {
      ...validEvent,
      senderFrame: subframe
    }
    expect(validateIpcSender(subframeEvent, mainWindow, options)).toBe(false)
  })

  it('rejects when senderFrame URL is untrusted or external', () => {
    const untrustedFrame: WebFrameMainLike = {
      url: 'https://evil-attacker.com/exploit'
    }
    const untrustedWebContents: WebContentsLike = {
      mainFrame: untrustedFrame
    }
    const untrustedWindow: BrowserWindowLike = {
      isDestroyed: () => false,
      webContents: untrustedWebContents
    }
    const untrustedEvent: IpcSenderEventLike = {
      sender: untrustedWebContents,
      senderFrame: untrustedFrame
    }

    expect(validateIpcSender(untrustedEvent, untrustedWindow, options)).toBe(false)
  })

  it('rejects when senderFrame URL is an empty string', () => {
    const emptyUrlFrame: WebFrameMainLike = {
      url: ''
    }
    const emptyUrlWebContents: WebContentsLike = {
      mainFrame: emptyUrlFrame
    }
    const emptyUrlWindow: BrowserWindowLike = {
      isDestroyed: () => false,
      webContents: emptyUrlWebContents
    }
    const emptyUrlEvent: IpcSenderEventLike = {
      sender: emptyUrlWebContents,
      senderFrame: emptyUrlFrame
    }

    expect(validateIpcSender(emptyUrlEvent, emptyUrlWindow, options)).toBe(false)
  })
})
