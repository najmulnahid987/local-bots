import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  registerIpcHandlers,
  registerProviderIpcHandlers,
  registerFailingProviderIpcHandlers,
  registerKnowledgeBaseIpcHandlers,
  registerFailingKnowledgeBaseIpcHandlers,
  registerDocumentIpcHandlers,
  registerFailingDocumentIpcHandlers,
  registerBotIpcHandlers,
  registerFailingBotIpcHandlers,
  isTrustedRendererUrl
} from './ipc'
import { databaseManager } from './database/connection'
import { runMigrations, migrations } from './database/migrations'
import { CredentialVault } from './security/credential-vault/credential-vault'
import { ProviderConnectionRepository } from './database/repositories/provider-connection-repository'
import { KnowledgeBaseRepository } from './database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from './database/repositories/knowledge-source-repository'
import { BotRepository } from './database/repositories/bot-repository'
import { KnowledgeBaseManager } from './services/knowledge-base-manager'
import { ActiveWorkspaceContext } from './services/active-workspace-context'
import { BotManagerService } from './services/bot-manager'
import { sanitizeBotErrorMessage } from './services/bot-errors'
import {
  DocumentStorageManager,
  DocumentIngestionService,
  DocumentSearchService,
  DocumentLifecycleService,
  recoverQuarantinedDocuments
} from './documents'
import { providerRegistry } from './providers/provider-registry'
import { ProviderManagerService } from './providers/provider-manager/provider-manager-service'
import { sanitizeErrorMessage } from './providers/provider-manager/errors'
import { sanitizeDocumentErrorMessage } from './ipc/document-validation'

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

          // Test G: React Router navigation & active state verification
          const initialHash = window.location.hash;

          // Click Knowledge Bases nav link
          const kbLink = document.querySelector('a[href="#/knowledge-bases"]');
          kbLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          const kbHash = window.location.hash;
          const kbTitle = document.querySelector('.page-title')?.textContent;
          const kbActive = kbLink?.classList.contains('active') ?? false;

          // Click Activity nav link
          const actLink = document.querySelector('a[href="#/activity"]');
          actLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          const actHash = window.location.hash;
          const actTitle = document.querySelector('.page-title')?.textContent;
          const actActive = actLink?.classList.contains('active') ?? false;

          // Click Settings nav link
          const setLink = document.querySelector('a[href="#/settings"]');
          setLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          const setHash = window.location.hash;
          const setTitle = document.querySelector('.page-title')?.textContent;
          const setActive = setLink?.classList.contains('active') ?? false;

          // Navigate back to Home
          const homeLink = document.querySelector('a[href="#/home"]');
          homeLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          const homeHash = window.location.hash;
          const homeTitle = document.querySelector('.page-title')?.textContent;
          const homeActive = homeLink?.classList.contains('active') ?? false;

          // Test "Explore Knowledge Bases" link from Home
          const exploreBtn = document.querySelector('.btn-primary-link');
          exploreBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 60));
          const exploreHash = window.location.hash;

          // Test History back & forward
          window.history.back();
          await new Promise((r) => setTimeout(r, 60));
          const backHash = window.location.hash;

          window.history.forward();
          await new Promise((r) => setTimeout(r, 60));
          const forwardHash = window.location.hash;

          // Test unknown route redirect
          window.location.hash = '#/unknown-route';
          await new Promise((r) => setTimeout(r, 80));
          const unknownHash = window.location.hash;

          const testG = {
            initialHash,
            kbHash,
            kbTitle,
            kbActive,
            actHash,
            actTitle,
            actActive,
            setHash,
            setTitle,
            setActive,
            homeHash,
            homeTitle,
            homeActive,
            exploreHash,
            backHash,
            forwardHash,
            unknownHash
          };

          return { testA, testB, testC, testD, testE, testF, testG };
        })()`)
        console.log('[STEP_1_5_VERIFICATION]', JSON.stringify(results))
      } catch (err) {
        console.error('[STEP_1_5_VERIFICATION_ERROR]', err)
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
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize persistent SQLite database and execute migrations before window creation
  let db
  let connectionRepo: ProviderConnectionRepository
  let kbRepo: KnowledgeBaseRepository
  let activeWorkspaceContext: ActiveWorkspaceContext
  try {
    const userDataPath = app.getPath('userData')
    const initResult = databaseManager.initialize(userDataPath)
    console.log(
      '[DATABASE_INITIALIZED]',
      JSON.stringify({
        dbPath: initResult.dbPath,
        foreignKeys: initResult.foreignKeys ? 1 : 0,
        journalMode: initResult.journalMode,
        synchronous: initResult.synchronous,
        busyTimeout: initResult.busyTimeout,
        walAutoCheckpoint: initResult.walAutoCheckpoint
      })
    )

    db = databaseManager.getDatabase()
    const migrationResult = runMigrations(db, migrations)
    console.log('[MIGRATIONS_COMPLETED]', JSON.stringify(migrationResult))

    connectionRepo = new ProviderConnectionRepository(db)
    kbRepo = new KnowledgeBaseRepository(db)
    activeWorkspaceContext = new ActiveWorkspaceContext(kbRepo)
  } catch (dbError) {
    console.error('[DATABASE_INITIALIZATION_FAILED]', dbError)
    app.quit()
    return
  }

  // Register foundational IPC handlers
  registerIpcHandlers(() => mainWindow)

  // Initialize ProviderManagerService and register provider IPC handlers
  try {
    const userDataPath = app.getPath('userData')
    const vault = new CredentialVault({ vaultDir: join(userDataPath, 'credentials') })
    const providerManager = new ProviderManagerService({
      credentialVault: vault,
      connectionRepo,
      registry: providerRegistry
    })

    const recon = await providerManager.initialize()
    console.log('[PROVIDER_SUBSYSTEM_INITIALIZED]', JSON.stringify(recon))
    registerProviderIpcHandlers(() => mainWindow, providerManager)
  } catch (providerError) {
    console.error(
      '[PROVIDER_SUBSYSTEM_INITIALIZATION_FAILED]',
      sanitizeErrorMessage(String(providerError))
    )
    registerFailingProviderIpcHandlers(() => mainWindow, 'Provider subsystem failed to initialize.')
  }

  // Initialize KnowledgeBaseManager and register Knowledge Base IPC handlers
  try {
    const userDataPath = app.getPath('userData')
    const kbManager = new KnowledgeBaseManager({
      repository: kbRepo,
      userDataPath
    })

    registerKnowledgeBaseIpcHandlers(() => mainWindow, kbManager)
    console.log(
      '[KNOWLEDGE_BASE_SUBSYSTEM_INITIALIZED]',
      JSON.stringify({ documentsDir: kbManager.getDocumentsDirectory() })
    )
  } catch (kbError) {
    console.error('[KNOWLEDGE_BASE_SUBSYSTEM_INITIALIZATION_FAILED]', kbError)
    registerFailingKnowledgeBaseIpcHandlers(
      () => mainWindow,
      'Knowledge Base subsystem failed to initialize.'
    )
  }

  // Initialize Document Ingestion and register Document IPC handlers
  try {
    const userDataPath = app.getPath('userData')
    const sourceRepo = new KnowledgeSourceRepository(db)
    const storageManager = new DocumentStorageManager({ userDataPath })
    const ingestionService = new DocumentIngestionService({
      db,
      sourceRepository: sourceRepo,
      storageManager
    })
    const searchService = new DocumentSearchService({
      sourceRepository: sourceRepo
    })
    const lifecycleService = new DocumentLifecycleService({
      db,
      sourceRepository: sourceRepo,
      storageManager
    })

    registerDocumentIpcHandlers({
      getMainWindow: () => mainWindow,
      ingestionService,
      sourceRepository: sourceRepo,
      searchService,
      lifecycleService
    })
    console.log('[DOCUMENT_SUBSYSTEM_INITIALIZED]')

    // Startup Quarantine Recovery: Reconcile any orphaned or pending quarantined document files
    try {
      const recoveryReport = await recoverQuarantinedDocuments({
        storageManager,
        sourceRepository: sourceRepo
      })
      if (
        recoveryReport.recoveredCount > 0 ||
        recoveryReport.cleanedCount > 0 ||
        recoveryReport.conflictCount > 0 ||
        recoveryReport.errors.length > 0
      ) {
        console.log('[QUARANTINE_RECOVERY_COMPLETED]', JSON.stringify(recoveryReport))
      }
    } catch (recErr) {
      console.warn(
        '[QUARANTINE_RECOVERY_WARNING]',
        sanitizeDocumentErrorMessage(recErr instanceof Error ? recErr.message : String(recErr))
      )
    }
  } catch (docError) {
    console.error('[DOCUMENT_SUBSYSTEM_INITIALIZATION_FAILED]', docError)
    registerFailingDocumentIpcHandlers(() => mainWindow, 'Document subsystem failed to initialize.')
  }

  // Initialize ActiveWorkspaceContext and BotManagerService, and register Bot IPC handlers
  try {
    const botRepo = new BotRepository(db)
    const botManager = new BotManagerService({
      botRepo,
      kbRepo,
      connectionRepo,
      registry: providerRegistry,
      activeContext: activeWorkspaceContext
    })

    registerBotIpcHandlers({
      getMainWindow: () => mainWindow,
      botManager,
      activeContext: activeWorkspaceContext
    })
    console.log('[BOT_SUBSYSTEM_INITIALIZED]')
  } catch (botError) {
    console.error(
      '[BOT_SUBSYSTEM_INITIALIZATION_FAILED]',
      sanitizeBotErrorMessage(String(botError))
    )
    registerFailingBotIpcHandlers(() => mainWindow, 'Bot subsystem failed to initialize.')
  }

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

// Safely close the database connection during application shutdown
app.on('will-quit', () => {
  databaseManager.close()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
