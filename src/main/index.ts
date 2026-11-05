import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'

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

  if (is.dev) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const results = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const testA = {
            apiKeys: Object.keys(window.api),
            hasInvoke: typeof window.api.invoke,
            hasSend: typeof window.api.send,
            hasIpcRenderer: typeof window.api.ipcRenderer,
            hasElectron: typeof window.electron
          };

          const validUuid = crypto.randomUUID();
          let testB = null;
          try {
            testB = await window.api.ping({ requestId: validUuid });
          } catch (e) {
            testB = { error: e.message };
          }

          let testC1 = null;
          try {
            await window.api.ping({ requestId: 123 });
            testC1 = { passed: false };
          } catch (e) {
            testC1 = { rejected: true, message: e.message };
          }

          let testC2 = null;
          try {
            await window.api.ping({});
            testC2 = { passed: false };
          } catch (e) {
            testC2 = { rejected: true, message: e.message };
          }

          let testC3 = null;
          try {
            await window.api.ping({ requestId: crypto.randomUUID(), extraProperty: 'unexpected' });
            testC3 = { passed: false };
          } catch (e) {
            testC3 = { rejected: true, message: e.message };
          }

          const testD = {
            require: typeof require,
            process: typeof process,
            windowRequire: typeof window.require,
            windowProcess: typeof window.process,
            windowBuffer: typeof window.Buffer
          };

          return { testA, testB, testC1, testC2, testC3, testD };
        })()`)
        console.log('[STEP_1_3_VERIFICATION]', JSON.stringify(results))
      } catch (err) {
        console.error('[STEP_1_3_VERIFICATION_ERROR]', err)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

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
