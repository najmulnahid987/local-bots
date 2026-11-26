import { app, BrowserWindow, session } from 'electron'
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
  registerConversationIpcHandlers,
  registerFailingConversationIpcHandlers,
  registerAgentIpcHandlers,
  registerFailingAgentIpcHandlers,
  registerBotMemoryIpcHandlers,
  registerFailingBotMemoryIpcHandlers,
  registerDiagnosticsIpcHandlers,
  registerFailingDiagnosticsIpcHandlers,
  registerDeletionIpcHandlers,
  registerFailingDeletionIpcHandlers,
  registerPrivacyIpcHandlers,
  registerFailingPrivacyIpcHandlers,
  sanitizeBotMemoryErrorMessage,
  sanitizeAgentErrorMessage,
  isTrustedRendererUrl
} from './ipc'
import { databaseManager } from './database/connection'
import { runMigrations, migrations } from './database/migrations'
import { CredentialVault } from './security/credential-vault/credential-vault'
import { ProviderConnectionRepository } from './database/repositories/provider-connection-repository'
import { KnowledgeBaseRepository } from './database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from './database/repositories/knowledge-source-repository'
import { BotRepository } from './database/repositories/bot-repository'
import { BotMemoryRepository } from './database/repositories/bot-memory-repository'
import { ConversationRepository } from './database/repositories/conversation-repository'
import { MessageRepository } from './database/repositories/message-repository'
import { AgentRunRepository } from './database/repositories/agent-run-repository'
import { ToolEventRepository } from './database/repositories/tool-event-repository'
import { ToolRegistry } from './tools/tool-registry'
import { SearchKnowledgeBaseTool } from './tools/knowledge-base/search-knowledge-base-tool'
import { ReadKnowledgeSourceTool } from './tools/knowledge-base/read-knowledge-source-tool'
import { ListKnowledgeSourcesTool } from './tools/knowledge-base/list-knowledge-sources-tool'
import { SearchWorkspaceFilesTool } from './tools/workspace/search-workspace-files-tool'
import { ReadWorkspaceFileTool } from './tools/workspace/read-workspace-file-tool'
import { SaveReportTool } from './tools/report/save-report-tool'
import { BotRagService } from './services/bot-rag-service'
import { ApprovalController } from './services/approval-controller'
import { WorkspaceFolderService } from './services/workspace-folder-service'
import { AiSdkAgentModelStepExecutor } from './agents/ai-sdk-agent-model-step-executor'
import { BoundedAgentRuntime } from './services/bounded-agent-runtime'
import { AgentTaskService } from './services/agent-task-service'
import { KnowledgeBaseManager } from './services/knowledge-base-manager'
import { ActiveWorkspaceContext } from './services/active-workspace-context'
import { BotManagerService } from './services/bot-manager'
import { sanitizeBotErrorMessage } from './services/bot-errors'
import { ConversationManagerService } from './services/conversation-manager'
import { ConversationTurnService } from './services/conversation-turn-service'
import { BotMemoryService } from './services/bot-memory-service'
import { ConversationExecutionService } from './services/conversation-execution-service'
import { ConversationPersistenceService } from './services/conversation-persistence-service'
import { sanitizeConversationErrorMessage } from './ipc/conversation-validation'
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
import { BackupExportManager } from './services/backup-export-manager'
import { BackupImportManager } from './services/backup-import-manager'
import { ImportRecoveryRepository } from './database/repositories/import-recovery-repository'
import { ImportRecoveryService } from './services/import-recovery-service'
import { StartupReconciliationService } from './services/startup-reconciliation-service'
import { DatabaseIntegrityService } from './services/database-integrity-service'
import { DiagnosticsCollector } from './services/diagnostics-collector'
import { DiagnosticsExportService } from './services/diagnostics-export-service'
import { defaultErrorRingBuffer } from './services/error-ring-buffer'
import { DeletionRecoveryRepository } from './database/repositories/deletion-recovery-repository'
import { DeletionService } from './services/deletion-service'
import { PrivacyService } from './services/privacy-service'

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

  // Deny all browser permission requests (camera, microphone, geolocation, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

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
  let providerManager: ProviderManagerService | null = null
  let vault: CredentialVault | null = null
  let sourceRepo: KnowledgeSourceRepository | null = null
  let turnService: ConversationTurnService | null = null
  let backupExportManager: BackupExportManager | undefined
  let backupImportManager: BackupImportManager | undefined
  let importRecoveryService: ImportRecoveryService | undefined
  let docLifecycleService: DocumentLifecycleService | null = null
  let kbManager: KnowledgeBaseManager | null = null
  let botManager: BotManagerService | null = null
  let conversationManager: ConversationManagerService | null = null
  let botMemoryRepo: BotMemoryRepository | null = null
  let botRepo: BotRepository | null = null
  let conversationRepo: ConversationRepository | null = null
  let messageRepo: MessageRepository | null = null
  let storageManager: DocumentStorageManager | null = null
  let deletionRecoveryRepo: DeletionRecoveryRepository | null = null
  try {
    const userDataPath = app.getPath('userData')
    botRepo = new BotRepository(db)
    botMemoryRepo = new BotMemoryRepository(db)
    conversationRepo = new ConversationRepository(db)
    messageRepo = new MessageRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    deletionRecoveryRepo = new DeletionRecoveryRepository(db)
    storageManager = new DocumentStorageManager({ userDataPath })

    vault = new CredentialVault({ vaultDir: join(userDataPath, 'credentials') })
    providerManager = new ProviderManagerService({
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
    kbManager = new KnowledgeBaseManager({
      repository: kbRepo,
      userDataPath
    })

    registerKnowledgeBaseIpcHandlers(
      () => mainWindow,
      kbManager,
      () => backupExportManager,
      () => backupImportManager
    )
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
    sourceRepo = new KnowledgeSourceRepository(db)
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
    docLifecycleService = lifecycleService

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
    botRepo = botRepo ?? new BotRepository(db)
    conversationRepo = conversationRepo ?? new ConversationRepository(db)
    botManager = new BotManagerService({
      botRepo,
      kbRepo,
      connectionRepo,
      conversationRepo,
      db,
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

  // Initialize BotMemoryRepository and register Bot Memory IPC handlers
  try {
    botRepo = botRepo ?? new BotRepository(db)
    botMemoryRepo = botMemoryRepo ?? new BotMemoryRepository(db)
    registerBotMemoryIpcHandlers({
      getMainWindow: () => mainWindow,
      botMemoryRepo,
      botRepo,
      activeContext: activeWorkspaceContext
    })
    console.log('[BOT_MEMORY_SUBSYSTEM_INITIALIZED]')
  } catch (memError) {
    console.error(
      '[BOT_MEMORY_SUBSYSTEM_INITIALIZATION_FAILED]',
      sanitizeBotMemoryErrorMessage(String(memError))
    )
    registerFailingBotMemoryIpcHandlers(
      () => mainWindow,
      'Bot memory subsystem failed to initialize.'
    )
  }

  // Initialize ConversationManagerService and ConversationTurnService, and register Conversation IPC handlers
  try {
    botRepo = botRepo ?? new BotRepository(db)
    botMemoryRepo = botMemoryRepo ?? new BotMemoryRepository(db)
    const botMemoryService = new BotMemoryService({ db, botRepo, botMemoryRepo })
    conversationRepo = conversationRepo ?? new ConversationRepository(db)
    messageRepo = messageRepo ?? new MessageRepository(db)

    conversationManager = new ConversationManagerService({
      conversationRepo,
      messageRepo,
      botRepo,
      activeContext: activeWorkspaceContext,
      db
    })

    if (!providerManager) {
      throw new Error('ProviderManagerService is not initialized.')
    }

    const executionService = new ConversationExecutionService(providerManager)

    const persistenceService = new ConversationPersistenceService({
      db,
      conversationRepo,
      messageRepo
    })

    turnService = new ConversationTurnService({
      db,
      conversationRepo,
      messageRepo,
      activeWorkspaceContext,
      executionService,
      persistenceService,
      botMemoryService
    })

    registerConversationIpcHandlers({
      getMainWindow: () => mainWindow,
      conversationManager,
      turnService,
      activeContext: activeWorkspaceContext
    })
    console.log('[CONVERSATION_SUBSYSTEM_INITIALIZED]')
  } catch (convError) {
    console.error(
      '[CONVERSATION_SUBSYSTEM_INITIALIZATION_FAILED]',
      sanitizeConversationErrorMessage(String(convError))
    )
    registerFailingConversationIpcHandlers(
      () => mainWindow,
      'Conversation subsystem failed to initialize.'
    )
  }

  // Initialize Backup & Export Subsystem
  try {
    const botRepo = new BotRepository(db)
    const botMemoryRepo = new BotMemoryRepository(db)
    const conversationRepo = new ConversationRepository(db)
    const messageRepo = new MessageRepository(db)
    const storageManager = new DocumentStorageManager({ userDataPath: app.getPath('userData') })

    backupExportManager = new BackupExportManager({
      db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo ?? new KnowledgeSourceRepository(db),
      conversationRepository: conversationRepo,
      messageRepository: messageRepo,
      storageManager,
      appVersion: app.getVersion()
    })
    console.log('[BACKUP_EXPORT_SUBSYSTEM_INITIALIZED]')

    const importRecoveryRepo = new ImportRecoveryRepository(db)
    importRecoveryService = new ImportRecoveryService({
      db,
      journalRepository: importRecoveryRepo,
      storageManager,
      tempBaseDir: join(app.getPath('userData'), 'temp')
    })

    backupImportManager = new BackupImportManager({
      db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo ?? new KnowledgeSourceRepository(db),
      conversationRepository: conversationRepo,
      messageRepository: messageRepo,
      storageManager,
      documentLifecycleService: docLifecycleService ?? undefined,
      importRecoveryService,
      tempBaseDir: join(app.getPath('userData'), 'temp')
    })
    console.log('[BACKUP_IMPORT_SUBSYSTEM_INITIALIZED]')
  } catch (exportInitErr) {
    console.error('[BACKUP_SUBSYSTEM_INITIALIZATION_FAILED]', exportInitErr)
  }

  // Initialize Agent Subsystem and register Agent IPC handlers
  try {
    const userDataPath = app.getPath('userData')
    if (!vault) {
      vault = new CredentialVault({ vaultDir: join(userDataPath, 'credentials') })
    }
    const agentRunRepository = new AgentRunRepository(db)
    const toolEventRepository = new ToolEventRepository(db)
    const botRepo = new BotRepository(db)
    const conversationRepo = new ConversationRepository(db)
    const messageRepo = new MessageRepository(db)
    const approvalController = new ApprovalController()
    const workspaceFolderService = new WorkspaceFolderService()

    const toolRegistry = new ToolRegistry({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo
    })

    const botRagService = new BotRagService({
      db,
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      knowledgeSourceRepository: sourceRepo ?? undefined
    })

    toolRegistry.register(new SearchKnowledgeBaseTool(botRagService))
    if (sourceRepo) {
      toolRegistry.register(new ReadKnowledgeSourceTool(sourceRepo))
      toolRegistry.register(new ListKnowledgeSourcesTool(sourceRepo))
    }
    toolRegistry.register(new SearchWorkspaceFilesTool(workspaceFolderService))
    toolRegistry.register(new ReadWorkspaceFileTool(workspaceFolderService))
    toolRegistry.register(new SaveReportTool(approvalController, undefined, () => mainWindow))

    const stepExecutor = new AiSdkAgentModelStepExecutor({
      botRepository: botRepo,
      connectionRepository: connectionRepo,
      credentialVault: vault
    })

    const boundedAgentRuntime = new BoundedAgentRuntime({
      botRepository: botRepo,
      knowledgeBaseRepository: kbRepo,
      agentRunRepository,
      toolEventRepository,
      toolRegistry,
      stepExecutor,
      approvalController,
      workspaceFolderService,
      conversationRepository: conversationRepo
    })

    const agentTaskService = new AgentTaskService({
      botRepository: botRepo,
      conversationRepository: conversationRepo,
      messageRepository: messageRepo,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connectionRepo,
      credentialVault: vault,
      boundedAgentRuntime,
      toolRegistry,
      approvalController,
      workspaceFolderService,
      activeWorkspaceContext,
      turnService: turnService ?? undefined
    })

    registerAgentIpcHandlers({
      getMainWindow: () => mainWindow,
      agentTaskService,
      agentRunRepository,
      toolEventRepository,
      botRepository: botRepo,
      conversationRepository: conversationRepo,
      approvalController,
      workspaceFolderService,
      activeContext: activeWorkspaceContext,
      knowledgeBaseRepository: kbRepo,
      providerConnectionRepository: connectionRepo
    })
    console.log('[AGENT_SUBSYSTEM_INITIALIZED]')
  } catch (agentError) {
    console.error(
      '[AGENT_SUBSYSTEM_INITIALIZATION_FAILED]',
      sanitizeAgentErrorMessage(String(agentError))
    )
    registerFailingAgentIpcHandlers(() => mainWindow, 'Agent subsystem failed to initialize.')
  }

  // Startup Reconciliation: Reconcile interrupted imports, document indexing, agent tasks, and quarantines
  if (db && sourceRepo && importRecoveryService) {
    try {
      const storageMgr =
        storageManager ?? new DocumentStorageManager({ userDataPath: app.getPath('userData') })
      const startupReconciliationService = new StartupReconciliationService({
        db,
        importRecoveryService,
        storageManager: storageMgr,
        sourceRepository: sourceRepo,
        deletionJournalRepo: deletionRecoveryRepo ?? undefined,
        tempBaseDir: join(app.getPath('userData'), 'temp')
      })

      const reconReport = await startupReconciliationService.reconcile()
      if (
        reconReport.recoveredImportsCount > 0 ||
        reconReport.reconciledSourcesCount > 0 ||
        reconReport.reconciledAgentRunsCount > 0 ||
        reconReport.reconciledToolEventsCount > 0 ||
        reconReport.cleanedStagingDirsCount > 0 ||
        reconReport.quarantineCleanedCount > 0 ||
        reconReport.quarantineRecoveredCount > 0 ||
        reconReport.warnings.length > 0
      ) {
        console.log('[STARTUP_RECONCILIATION_COMPLETED]', JSON.stringify(reconReport))
      }
    } catch (reconErr) {
      console.warn('[STARTUP_RECONCILIATION_WARNING]', reconErr)
    }
  }

  // Initialize DatabaseIntegrityService and DiagnosticsExportService, and register Diagnostics IPC handlers
  try {
    const dbPath = databaseManager.getDatabasePath()
    const integrityService = new DatabaseIntegrityService({
      db,
      databaseFilePath: dbPath
    })
    const diagnosticsCollector = new DiagnosticsCollector({
      db,
      integrityService,
      errorRingBuffer: defaultErrorRingBuffer,
      tempBaseDir: join(app.getPath('userData'), 'temp'),
      appVersion: app.getVersion()
    })
    const diagnosticsExportService = new DiagnosticsExportService({
      collector: diagnosticsCollector
    })

    registerDiagnosticsIpcHandlers({
      getMainWindow: () => mainWindow,
      integrityService,
      exportService: diagnosticsExportService
    })
    console.log('[DIAGNOSTICS_SUBSYSTEM_INITIALIZED]')
  } catch (diagError) {
    console.error('[DIAGNOSTICS_SUBSYSTEM_INITIALIZATION_FAILED]', diagError)
    registerFailingDiagnosticsIpcHandlers(
      () => mainWindow,
      'Diagnostics subsystem failed to initialize.'
    )
  }

  // Initialize DeletionService and register Deletion IPC handlers
  try {
    if (
      !db ||
      !kbRepo ||
      !botRepo ||
      !sourceRepo ||
      !conversationRepo ||
      !messageRepo ||
      !botMemoryRepo ||
      !kbManager ||
      !docLifecycleService ||
      !conversationManager ||
      !botManager ||
      !turnService ||
      !storageManager
    ) {
      throw new Error('Required subsystem dependencies missing for DeletionService.')
    }

    const deletionService = new DeletionService({
      db,
      kbRepo,
      botRepo,
      sourceRepo,
      conversationRepo,
      messageRepo,
      botMemoryRepo,
      kbManager,
      docLifecycleService,
      conversationManager,
      botManager,
      turnService,
      deletionJournalRepo: deletionRecoveryRepo ?? undefined,
      storageManager
    })

    registerDeletionIpcHandlers({
      getMainWindow: () => mainWindow,
      deletionService
    })
    console.log('[DELETION_SUBSYSTEM_INITIALIZED]')
  } catch (deletionError) {
    console.error('[DELETION_SUBSYSTEM_INITIALIZATION_FAILED]', deletionError)
    registerFailingDeletionIpcHandlers(() => mainWindow, 'Deletion subsystem failed to initialize.')
  }

  // Phase 9 Step 9.9: Privacy & Transparency subsystem initialization
  try {
    const privacyService = new PrivacyService({
      userDataPath: app.getPath('userData'),
      credentialVault: vault ?? undefined,
      platform: process.platform
    })

    registerPrivacyIpcHandlers({
      getMainWindow: () => mainWindow,
      privacyService
    })
    console.log('[PRIVACY_SUBSYSTEM_INITIALIZED]')
  } catch (privacyError) {
    console.error('[PRIVACY_SUBSYSTEM_INITIALIZATION_FAILED]', privacyError)
    registerFailingPrivacyIpcHandlers(() => mainWindow, 'Privacy subsystem failed to initialize.')
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

// Orderly shutdown: execute passive checkpoint before database closes
app.on('before-quit', () => {
  try {
    databaseManager.checkpoint('PASSIVE')
  } catch {
    // Non-critical checkpoint
  }
})

// Safely close the database connection during application shutdown
app.on('will-quit', () => {
  databaseManager.close()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
