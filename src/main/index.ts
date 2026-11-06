import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, isTrustedRendererUrl } from './ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Safe Navigation Restrictions:
  // Block any frame navigation targeting untrusted origins
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url)) {
      event.preventDefault()
    }
  })

  // Block top-level main frame navigation targeting untrusted origins
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) {
      event.preventDefault()
    }
  })

  // Block unauthorized server-side redirects
  mainWindow.webContents.on('will-redirect', (event, redirectUrl) => {
    if (!isTrustedRendererUrl(redirectUrl)) {
      event.preventDefault()
    }
  })

  // Safe Window Opening Restrictions:
  // Deny all child/popup window creations without invoking shell.openExternal
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  if (is.dev) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const results = await mainWindow?.webContents.executeJavaScript(`(async () => {
          // Test A: CSP presence
          const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
          const testA = {
            hasCspMeta: Boolean(cspMeta),
            cspContent: cspMeta?.content ?? null
          };

          // Test B: External in-page navigation attempt
          const initialUrl = window.location.href;
          const link = document.createElement('a');
          link.href = 'https://example.com';
          link.textContent = 'External test';
          document.body.appendChild(link);
          link.click();
          await new Promise((r) => setTimeout(r, 60));
          const testB = {
            stayedOnLocal: window.location.href === initialUrl,
            currentUrl: window.location.href
          };
          link.remove();

          // Test C: Window open restriction
          let testC = { windowOpenResult: null };
          try {
            const popup = window.open('https://example.com');
            testC.windowOpenResult = popup === null ? 'denied' : 'opened';
          } catch (e) {
            testC.windowOpenResult = 'error: ' + e.message;
          }

          // Test D: Iframe external restriction (CSP frame-src 'none')
          let testD = { iframeBlocked: false };
          const frame = document.createElement('iframe');
          let cspViolationCaught = false;
          const onSecurityPolicyViolation = (e) => {
            if (e.violatedDirective === 'frame-src' || String(e.blockedURI).includes('example.com')) {
              cspViolationCaught = true;
            }
          };
          document.addEventListener('securitypolicyviolation', onSecurityPolicyViolation);
          frame.src = 'https://example.com';
          document.body.appendChild(frame);
          await new Promise((r) => setTimeout(r, 60));
          document.removeEventListener('securitypolicyviolation', onSecurityPolicyViolation);
          frame.remove();
          testD.iframeBlocked = cspViolationCaught;

          // Test E: Existing IPC validation
          let testE = { validPing: null, invalidPing: null };
          try {
            testE.validPing = await window.api.ping({ requestId: crypto.randomUUID() });
          } catch (e) {
            testE.validPing = { error: e.message };
          }
          try {
            await window.api.ping({ requestId: 123 });
            testE.invalidPing = { passed: false };
          } catch (e) {
            testE.invalidPing = { rejected: true, message: e.message };
          }

          // Test F: Node & Sandbox isolation
          const testF = {
            require: typeof require,
            process: typeof process,
            windowRequire: typeof window.require,
            windowProcess: typeof window.process,
            windowBuffer: typeof window.Buffer
          };

          return { testA, testB, testC, testD, testE, testF };
        })()`)
        console.log('[STEP_1_4_VERIFICATION]', JSON.stringify(results))
      } catch (err) {
        console.error('[STEP_1_4_VERIFICATION_ERROR]', err)
      }
    })
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Register secure Main process IPC handlers
  registerIpcHandlers(() => mainWindow)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
