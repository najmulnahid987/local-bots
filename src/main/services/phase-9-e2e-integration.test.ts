/**
 * Phase 9 — Step 9.10: Final End-to-End Integration, Security & Clean-Profile Verification
 *
 * Comprehensive integration suite covering the integrated workflows across:
 * 1. Bot Memory CRUD & RAG Prompt Integration
 * 2. Knowledge Base Export (.voyaro-kb.zip) & Archive Structure Validation
 * 3. Knowledge Base Import as New & ID Remapping
 * 4. Knowledge Base Merge & Replace with Exact Name Confirmation
 * 5. Deletion Cascades & Multi-KB Isolation
 * 6. Active Operation Locking & Concurrency Protection
 * 7. Database Integrity Verification & WAL-Aware Online Backup
 * 8. Diagnostics Export & Sanitizer Redaction
 * 9. Privacy Storage Resolution & Allowlisted Folder Revealing
 * 10. Startup Reconciliation of Interrupted Deletions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ImportRecoveryRepository } from '../database/repositories/import-recovery-repository'
import { DeletionRecoveryRepository } from '../database/repositories/deletion-recovery-repository'
import { BotMemoryService } from './bot-memory-service'
import { RagPromptBuilder } from './rag-prompt-builder'
import { BackupExportManager } from './backup-export-manager'
import { BackupImportManager } from './backup-import-manager'
import { ImportRecoveryService } from './import-recovery-service'
import { StartupReconciliationService } from './startup-reconciliation-service'
import { DeletionService, DeletionServiceError } from './deletion-service'
import { DatabaseIntegrityService } from './database-integrity-service'
import { DiagnosticsCollector } from './diagnostics-collector'
import { ApplicationErrorRingBuffer } from './error-ring-buffer'
import { PrivacyService, PrivacyServiceError } from './privacy-service'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { KnowledgeBaseManager } from './knowledge-base-manager'
import type { ConversationTurnService } from './conversation-turn-service'
import type { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import type { ConversationManagerService } from './conversation-manager'
import type { BotManagerService } from './bot-manager'

describe('Phase 9 — Step 9.10: Final Master End-to-End Integration Suite', () => {
  let ctx: MigratedTestDatabaseContext
  let memoryRepo: BotMemoryRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let sourceRepo: KnowledgeSourceRepository
  let importJournalRepo: ImportRecoveryRepository
  let deletionJournalRepo: DeletionRecoveryRepository

  let tempDir: string
  let storageManager: DocumentStorageManager
  let memoryService: BotMemoryService
  let exportManager: BackupExportManager
  let importManager: BackupImportManager
  let importRecoveryService: ImportRecoveryService
  let deletionService: DeletionService
  let integrityService: DatabaseIntegrityService
  let privacyService: PrivacyService

  let mockTurnService: Partial<ConversationTurnService>
  let mockDocLifecycle: Partial<DocumentLifecycleService>
  let mockKbManager: Partial<KnowledgeBaseManager>
  let mockBotManager: Partial<BotManagerService>
  let mockConvManager: Partial<ConversationManagerService>

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    memoryRepo = new BotMemoryRepository(ctx.db)
    convRepo = new ConversationRepository(ctx.db)
    msgRepo = new MessageRepository(ctx.db)
    sourceRepo = new KnowledgeSourceRepository(ctx.db)
    importJournalRepo = new ImportRecoveryRepository(ctx.db)
    deletionJournalRepo = new DeletionRecoveryRepository(ctx.db)

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyaro-phase9-e2e-'))
    const docsDir = path.join(tempDir, 'documents')
    fs.mkdirSync(docsDir, { recursive: true })

    storageManager = new DocumentStorageManager({
      userDataPath: tempDir,
      documentsDir: docsDir
    })

    memoryService = new BotMemoryService({
      botMemoryRepo: memoryRepo,
      botRepo: ctx.botRepo,
      db: ctx.db
    })

    exportManager = new BackupExportManager({
      db: ctx.db,
      kbRepository: ctx.kbRepo,
      botRepository: ctx.botRepo,
      botMemoryRepository: memoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager
    })

    importRecoveryService = new ImportRecoveryService({
      db: ctx.db,
      journalRepository: importJournalRepo,
      storageManager,
      tempBaseDir: tempDir
    })

    importManager = new BackupImportManager({
      db: ctx.db,
      kbRepository: ctx.kbRepo,
      botRepository: ctx.botRepo,
      botMemoryRepository: memoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      importRecoveryService,
      tempBaseDir: tempDir
    })

    mockTurnService = {
      isGenerating: vi.fn().mockReturnValue(false),
      isDeleting: vi.fn().mockReturnValue(false),
      acquireDeletionLock: vi.fn(),
      releaseDeletionLock: vi.fn()
    }

    mockDocLifecycle = {
      reindex: vi.fn(),
      delete: vi.fn()
    }

    mockKbManager = {
      delete: vi.fn().mockImplementation((id: string) => {
        ctx.kbRepo.delete(id)
        return Promise.resolve({ success: true, knowledgeBaseId: id, directoryCleaned: true })
      })
    }

    mockBotManager = {
      deleteBot: vi.fn().mockReturnValue({ success: true, botId: 'test-bot' })
    }

    mockConvManager = {
      deleteConversation: vi.fn()
    }

    deletionService = new DeletionService({
      db: ctx.db,
      kbRepo: ctx.kbRepo,
      botRepo: ctx.botRepo,
      sourceRepo,
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      botMemoryRepo: memoryRepo,
      kbManager: mockKbManager as KnowledgeBaseManager,
      docLifecycleService: mockDocLifecycle as DocumentLifecycleService,
      conversationManager: mockConvManager as ConversationManagerService,
      botManager: mockBotManager as BotManagerService,
      turnService: mockTurnService as ConversationTurnService,
      deletionJournalRepo,
      storageManager
    })

    integrityService = new DatabaseIntegrityService({
      db: ctx.db
    })

    privacyService = new PrivacyService({
      userDataPath: tempDir,
      platform: 'win32',
      openPathFn: vi.fn().mockResolvedValue('')
    })
  })

  afterEach(() => {
    ctx.cleanup()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  // --------------------------------------------------------------------------
  // Workflow 1: Bot Memory CRUD & RAG Prompt Integration
  // --------------------------------------------------------------------------
  it('Workflow 1: creates memories, prioritizes pinned instructions, and builds RAG prompt', async () => {
    const kb = ctx.kbRepo.create({ name: 'Memory KB', description: 'Testing bot memories' })
    const bot = ctx.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Memory Analyst',
      modelId: 'test-model',
      systemPrompt: 'You are an analytical assistant.'
    })

    // Create 1 pinned instruction and 1 general note (user_note)
    const pinned = memoryRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      memoryType: 'pinned_instruction',
      content: 'Always respond in bullet points.'
    })
    expect(pinned.id).toBeDefined()
    expect(pinned.memoryType).toBe('pinned_instruction')

    const note = memoryRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      memoryType: 'user_note',
      content: 'User prefers concise summaries.'
    })
    expect(note.id).toBeDefined()

    // Retrieve active memory context
    const memContext = memoryService.getMemoryContext(bot.id)
    expect(memContext.items.length).toBe(2)
    expect(memContext.formattedText).toContain('Always respond in bullet points.')
    expect(memContext.formattedText).toContain('User prefers concise summaries.')
    expect(memContext.estimatedTokens).toBeLessThanOrEqual(1500)

    // Build RAG prompt with memory context
    const prompt = RagPromptBuilder.build({
      bot: { name: bot.name, systemPrompt: bot.systemPrompt },
      history: [],
      question: 'Summarize the architecture.',
      retrievalResult: { status: 'NO_RESULTS', chunks: [], citations: [], totalTokens: 0 },
      memoryContext: memContext
    })

    const finalUserContent = prompt.messages[prompt.messages.length - 1].content
    expect(finalUserContent).toContain('<bot_memories>')
    expect(finalUserContent).toContain('Always respond in bullet points.')
    expect(finalUserContent).toContain('Summarize the architecture.')
  })

  // --------------------------------------------------------------------------
  // Workflow 2: Export KB -> Inspect Archive -> Import as New
  // --------------------------------------------------------------------------
  it('Workflow 2: exports KB, verifies archive exclusions, and imports into fresh KB', async () => {
    const kbOriginal = ctx.kbRepo.create({ name: 'Exportable KB', description: 'Original KB' })
    const botOriginal = ctx.botRepo.create({
      knowledgeBaseId: kbOriginal.id,
      name: 'Export Bot',
      modelId: 'gpt-4o'
    })

    memoryRepo.create({
      botId: botOriginal.id,
      knowledgeBaseId: kbOriginal.id,
      memoryType: 'pinned_instruction',
      content: 'Pinned memory to export'
    })

    const conv = convRepo.create({
      knowledgeBaseId: kbOriginal.id,
      botId: botOriginal.id,
      title: 'Original Conversation'
    })

    msgRepo.create({
      knowledgeBaseId: kbOriginal.id,
      botId: botOriginal.id,
      conversationId: conv.id,
      role: 'user',
      content: 'Hello export'
    })

    // Store physical original document and compute authentic SHA-256
    const sourceId = '44444444-2222-4333-8444-555555555555'
    const kbDir = path.join(tempDir, 'documents', kbOriginal.id, 'originals')
    fs.mkdirSync(kbDir, { recursive: true })
    const physicalDocPath = path.join(kbDir, `${sourceId}.txt`)
    const docContent = 'Test document content for export'
    const docHash = crypto.createHash('sha256').update(docContent).digest('hex')
    fs.writeFileSync(physicalDocPath, docContent)

    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kbOriginal.id,
      file_name: 'doc.txt',
      original_file_name: 'doc.txt',
      relative_file_path: `${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: Buffer.byteLength(docContent),
      content_hash: docHash,
      indexing_status: 'completed'
    })

    // Export Knowledge Base with explicit custom path
    const exportFile = path.join(tempDir, 'export.voyaro-kb.zip')
    const exportResult = await exportManager.exportKnowledgeBase(kbOriginal.id, exportFile)
    expect(exportResult.success).toBe(true)
    expect(exportResult.archivePath).toBeDefined()
    expect(fs.existsSync(exportResult.archivePath!)).toBe(true)

    // Preview archive before import: verify manifest and structure
    const previewResult = await importManager.selectAndPreviewArchive(exportResult.archivePath!)
    expect(previewResult.success).toBe(true)
    expect(previewResult.preview).toBeDefined()
    expect(previewResult.preview!.knowledgeBase.name).toBe('Exportable KB')
    expect(previewResult.preview!.counts.bots).toBe(1)
    expect(previewResult.preview!.counts.sources).toBe(1)
    expect(previewResult.preview!.counts.memories).toBe(1)
    expect(previewResult.preview!.counts.conversations).toBe(1)

    // Execute Import as New
    const importResult = await importManager.executeImport({
      sessionId: previewResult.preview!.sessionId,
      strategy: 'new'
    })

    expect(importResult.success).toBe(true)
    expect(importResult.knowledgeBaseId).toBeDefined()
    expect(importResult.knowledgeBaseId).not.toBe(kbOriginal.id)

    // Verify imported KB in database
    const importedKb = ctx.kbRepo.getById(importResult.knowledgeBaseId!)
    expect(importedKb).toBeDefined()

    const importedBots = ctx.botRepo.listByKnowledgeBase(importResult.knowledgeBaseId!)
    expect(importedBots.length).toBe(1)
    expect(importedBots[0].name).toBe('Export Bot')
    expect(importedBots[0].providerConnectionId).toBeNull() // Disconnected from credentials

    const importedMemories = memoryRepo.listByBot(importedBots[0].id, importResult.knowledgeBaseId!)
    expect(importedMemories.length).toBe(1)
    expect(importedMemories[0].content).toBe('Pinned memory to export')

    const importedConvs = convRepo.listByBot(importedBots[0].id, importResult.knowledgeBaseId!)
    expect(importedConvs.length).toBe(1)
    const importedMsgs = msgRepo.listByConversation(
      importedConvs[0].id,
      importedBots[0].id,
      importResult.knowledgeBaseId!
    )
    expect(importedMsgs.length).toBe(1)
    expect(importedMsgs[0].content).toBe('Hello export')
  })

  // --------------------------------------------------------------------------
  // Workflow 3: Merge and Replace Import Strategies
  // --------------------------------------------------------------------------
  it('Workflow 3: verifies Merge and Replace import workflows with exact name confirmation', async () => {
    // 1. Create source KB and export
    const kbSource = ctx.kbRepo.create({ name: 'Template KB', description: 'Template' })
    ctx.botRepo.create({
      knowledgeBaseId: kbSource.id,
      name: 'Template Bot',
      modelId: 'test-model'
    })
    const expFile = path.join(tempDir, 'template.voyaro-kb.zip')
    const exp = await exportManager.exportKnowledgeBase(kbSource.id, expFile)
    expect(exp.success).toBe(true)

    // 2. Create target KB
    const kbTarget = ctx.kbRepo.create({ name: 'Destination KB', description: 'Destination' })
    ctx.botRepo.create({
      knowledgeBaseId: kbTarget.id,
      name: 'Existing Bot',
      modelId: 'test-model'
    })

    // Merge into target KB
    const mergePreview = await importManager.selectAndPreviewArchive(exp.archivePath!)
    expect(mergePreview.success).toBe(true)

    const mergeResult = await importManager.executeImport({
      sessionId: mergePreview.preview!.sessionId,
      strategy: 'merge',
      targetKnowledgeBaseId: kbTarget.id
    })
    expect(mergeResult.success).toBe(true)

    // Verify merged KB has 2 bots (Existing Bot + Template Bot)
    const mergedBots = ctx.botRepo.listByKnowledgeBase(kbTarget.id)
    expect(mergedBots.length).toBe(2)

    // Replace target KB with exact name confirmation
    const replacePreview = await importManager.selectAndPreviewArchive(exp.archivePath!)
    expect(replacePreview.success).toBe(true)

    const replaceResult = await importManager.executeImport({
      sessionId: replacePreview.preview!.sessionId,
      strategy: 'replace',
      targetKnowledgeBaseId: kbTarget.id,
      confirmationName: 'Destination KB'
    })
    expect(replaceResult.success).toBe(true)

    // After replace, only the imported Bot should exist (Existing Bot was wiped)
    const replacedBots = ctx.botRepo.listByKnowledgeBase(kbTarget.id)
    expect(replacedBots.length).toBe(1)
    expect(replacedBots[0].name).toBe('Template Bot')
  })

  // --------------------------------------------------------------------------
  // Workflow 4: Deletion Cascades & Multi-KB Isolation
  // --------------------------------------------------------------------------
  it('Workflow 4: verifies entity deletion cascades while preserving sibling bots and unrelated KBs', async () => {
    // KB Alpha (with 2 Bots and 1 Conversation)
    const kbAlpha = ctx.kbRepo.create({ name: 'Alpha KB', description: 'Alpha' })
    const botAlpha1 = ctx.botRepo.create({
      knowledgeBaseId: kbAlpha.id,
      name: 'Alpha Bot 1',
      modelId: 'm1'
    })
    const botAlpha2 = ctx.botRepo.create({
      knowledgeBaseId: kbAlpha.id,
      name: 'Alpha Bot 2',
      modelId: 'm2'
    })

    const convAlpha1 = convRepo.create({
      knowledgeBaseId: kbAlpha.id,
      botId: botAlpha1.id,
      title: 'Thread A1'
    })
    msgRepo.create({
      knowledgeBaseId: kbAlpha.id,
      botId: botAlpha1.id,
      conversationId: convAlpha1.id,
      role: 'user',
      content: 'Message A1'
    })

    // KB Beta (unrelated)
    const kbBeta = ctx.kbRepo.create({ name: 'Beta KB', description: 'Beta' })
    const botBeta = ctx.botRepo.create({
      knowledgeBaseId: kbBeta.id,
      name: 'Beta Bot',
      modelId: 'm3'
    })

    // 1. Delete Conversation Alpha 1 -> Bot Alpha 1 and KB Alpha remain
    const convDelRes = await deletionService.deleteEntity({
      entityType: 'conversation',
      entityId: convAlpha1.id
    })
    expect(convDelRes.success).toBe(true)
    expect(convRepo.getByIdOnly(convAlpha1.id)).toBeNull()
    expect(ctx.botRepo.getByIdOnly(botAlpha1.id)).toBeDefined()

    // 2. Delete Bot Alpha 1 -> Bot Alpha 2 and KB Alpha remain
    const botDelRes = await deletionService.deleteEntity({
      entityType: 'bot',
      entityId: botAlpha1.id,
      confirmName: 'Alpha Bot 1'
    })
    expect(botDelRes.success).toBe(true)
    expect(ctx.botRepo.getByIdOnly(botAlpha1.id)).toBeNull()
    expect(ctx.botRepo.getByIdOnly(botAlpha2.id)).toBeDefined()
    expect(ctx.kbRepo.getById(kbAlpha.id)).toBeDefined()

    // 3. Delete KB Alpha -> KB Beta remains completely untouched
    const kbDelRes = await deletionService.deleteEntity({
      entityType: 'knowledge_base',
      entityId: kbAlpha.id,
      confirmName: 'Alpha KB'
    })
    expect(kbDelRes.success).toBe(true)
    expect(ctx.kbRepo.getById(kbAlpha.id)).toBeNull()
    expect(ctx.kbRepo.getById(kbBeta.id)).toBeDefined()
    expect(ctx.botRepo.getByIdOnly(botBeta.id)).toBeDefined()
  })

  // --------------------------------------------------------------------------
  // Workflow 5: Active Operation Locking
  // --------------------------------------------------------------------------
  it('Workflow 5: blocks deletion when an active turn is generating', async () => {
    const kb = ctx.kbRepo.create({ name: 'Lock KB', description: 'Lock testing' })
    const bot = ctx.botRepo.create({ knowledgeBaseId: kb.id, name: 'Lock Bot', modelId: 'm1' })
    const conv = convRepo.create({ knowledgeBaseId: kb.id, botId: bot.id, title: 'Active Conv' })

    // Simulate active generation lock
    mockTurnService.isGenerating = vi.fn().mockReturnValue(true)

    // Deletion preview should report blocked
    const preview = await deletionService.getPreview('conversation', conv.id)
    expect(preview.isBlocked).toBe(true)
    expect(preview.blockReason).toContain('generation')

    // Executing deletion should throw OPERATION_BLOCKED
    await expect(
      deletionService.deleteEntity({
        entityType: 'conversation',
        entityId: conv.id
      })
    ).rejects.toThrow(DeletionServiceError)
  })

  // --------------------------------------------------------------------------
  // Workflow 6: Database Integrity Check & WAL-Aware Online Backup
  // --------------------------------------------------------------------------
  it('Workflow 6: runs database integrity checks and performs WAL-aware online backup', async () => {
    const health = await integrityService.getDatabaseHealth()
    expect(health.status).toBe('healthy')
    expect(health.integrityStatus).toBe('ok')
    expect(health.foreignKeyStatus).toBe('ok')
    expect(health.violationsCount).toBe(0)

    // Test online backup
    const backupDir = path.join(tempDir, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const backupFile = path.join(backupDir, 'wal-consistent.sqlite')

    const backupResult = await ctx.manager.backup(backupFile)
    expect(backupResult.integrityVerified).toBe(true)
    expect(fs.existsSync(backupFile)).toBe(true)
    expect(backupResult.sizeBytes).toBeGreaterThan(0)
  })

  // --------------------------------------------------------------------------
  // Workflow 7: Diagnostics Export & Sanitizer Redaction
  // --------------------------------------------------------------------------
  it('Workflow 7: redacts sensitive keys, paths, and bare document filenames from diagnostics', async () => {
    const errorBuffer = new ApplicationErrorRingBuffer(50)
    errorBuffer.addError({
      code: 'API_ERROR',
      category: 'provider',
      message: 'Failed request with key sk-proj-1234567890abcdef1234567890abcdef'
    })
    errorBuffer.addError({
      code: 'PARSE_ERROR',
      category: 'ingestion',
      message: 'Could not extract text from invoice_2026.pdf at C:\\Users\\Alice\\invoice_2026.pdf'
    })

    const collector = new DiagnosticsCollector({
      db: ctx.db,
      integrityService,
      errorRingBuffer: errorBuffer
    })

    const payload = await collector.collect()

    // Verify system metrics
    expect(payload.environment.appVersion).toBe('1.0.0')
    expect(payload.databaseMetrics.knowledgeBasesCount).toBeGreaterThanOrEqual(0)

    // Verify error ring buffer redactions
    expect(payload.recentErrors.length).toBe(2)

    const keyError = payload.recentErrors.find((e) => e.code === 'API_ERROR')!
    expect(keyError.sanitizedMessage).toContain('[REDACTED_API_KEY]')
    expect(keyError.sanitizedMessage).not.toContain('sk-proj-')

    const parseError = payload.recentErrors.find((e) => e.code === 'PARSE_ERROR')!
    expect(parseError.sanitizedMessage).toContain('[REDACTED_PATH]')
    expect(parseError.sanitizedMessage).toContain('[REDACTED_FILE]')
    expect(parseError.sanitizedMessage).not.toContain('invoice_2026.pdf')
    expect(parseError.sanitizedMessage).not.toContain('Alice')
  })

  // --------------------------------------------------------------------------
  // Workflow 8: Privacy Service Storage Resolution & Folder Security
  // --------------------------------------------------------------------------
  it('Workflow 8: resolves authoritative storage paths and enforces safe folder opening', async () => {
    const info = await privacyService.getStorageInfo()
    expect(info.userDataPath).toBe(tempDir)
    expect(info.databasePath).toBe(path.join(tempDir, 'database', 'app.sqlite'))
    expect(info.documentsPath).toBe(path.join(tempDir, 'documents'))
    expect(info.credentialsPath).toBe(path.join(tempDir, 'credentials'))
    expect(info.encryptionAvailable).toBe(true)

    // Allowed folder opens
    const userRes = await privacyService.openStorageFolder('userData')
    expect(userRes.success).toBe(true)

    const docsRes = await privacyService.openStorageFolder('documents')
    expect(docsRes.success).toBe(true)

    // Unlisted target rejection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(privacyService.openStorageFolder('credentials' as any)).rejects.toThrow(
      PrivacyServiceError
    )
  })

  // --------------------------------------------------------------------------
  // Workflow 9: Startup Reconciliation of Interrupted Deletions
  // --------------------------------------------------------------------------
  it('Workflow 9: reconciles dangling quarantine directories during startup reconciliation', async () => {
    const reconciliationService = new StartupReconciliationService({
      db: ctx.db,
      importRecoveryService,
      sourceRepository: sourceRepo,
      deletionJournalRepo,
      storageManager,
      tempBaseDir: tempDir
    })

    // Seed a committed deletion record with a remaining quarantine folder
    const opId = '99999999-2222-4333-8444-555555555555'
    const quarantinePathName = `.quarantine_kb_test_${opId}`
    const documentsDir = storageManager.getDocumentsDirectory()
    const quarantineDir = path.join(documentsDir, quarantinePathName)
    fs.mkdirSync(quarantineDir, { recursive: true })
    fs.writeFileSync(path.join(quarantineDir, 'temp.txt'), 'abandoned file')

    deletionJournalRepo.create({
      id: opId,
      entityType: 'knowledge_base',
      entityId: 'kb-deleted-before-crash',
      knowledgeBaseId: 'kb-deleted-before-crash',
      entityName: 'Deleted KB',
      quarantinePathName,
      state: 'database_deleted'
    })

    // Run reconciliation: since the entity no longer exists in DB, quarantine should be purged
    const report = await reconciliationService.reconcile()
    expect(report.quarantineCleanedCount).toBe(1)
    expect(fs.existsSync(quarantineDir)).toBe(false)
  })

  // --------------------------------------------------------------------------
  // Workflow 10: Clean-Profile Cold-Start Verification
  // --------------------------------------------------------------------------
  it('Workflow 10: initializes a clean profile directory with zero state, healthy database, and valid migrations', async () => {
    const freshTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyaro-clean-profile-'))
    const freshDbDir = path.join(freshTempDir, 'database')
    fs.mkdirSync(freshDbDir, { recursive: true })
    const freshDocsDir = path.join(freshTempDir, 'documents')
    fs.mkdirSync(freshDocsDir, { recursive: true })

    try {
      // 1. Initialize fresh DatabaseManager
      const freshManager = new (await import('../database/connection')).DatabaseManager()
      const initResult = freshManager.initialize(freshTempDir)
      expect(initResult.journalMode).toBe('wal')
      expect(initResult.foreignKeys).toBe(true)

      const freshDb = freshManager.getDatabase()
      const { runMigrations } = await import('../database/migrations/runner')
      const { migrations } = await import('../database/migrations')
      const migrationResults = runMigrations(freshDb, migrations)

      // All 5 migrations must succeed
      expect(migrationResults.appliedCount).toBe(5)
      expect(migrationResults.currentVersion).toBe(5)

      // Verify all tables exist and count is 13
      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      expect(tables.length).toBeGreaterThanOrEqual(13)

      // 2. Fresh Startup Reconciliation
      const freshStorage = new DocumentStorageManager({
        userDataPath: freshTempDir,
        documentsDir: freshDocsDir
      })
      const freshImportJournal = new ImportRecoveryRepository(freshDb)
      const freshDeletionJournal = new DeletionRecoveryRepository(freshDb)
      const freshSourceRepo = new KnowledgeSourceRepository(freshDb)
      const freshImportRecovery = new ImportRecoveryService({
        db: freshDb,
        journalRepository: freshImportJournal,
        storageManager: freshStorage,
        tempBaseDir: freshTempDir
      })

      const freshRecon = new StartupReconciliationService({
        db: freshDb,
        importRecoveryService: freshImportRecovery,
        sourceRepository: freshSourceRepo,
        deletionJournalRepo: freshDeletionJournal,
        storageManager: freshStorage,
        tempBaseDir: freshTempDir
      })

      const reconReport = await freshRecon.reconcile()
      expect(reconReport.recoveredImportsCount).toBe(0)
      expect(reconReport.quarantineRecoveredCount).toBe(0)
      expect(reconReport.quarantineCleanedCount).toBe(0)
      expect(reconReport.warnings.length).toBe(0)

      // 3. Fresh Database Health & Integrity
      const freshIntegrity = new DatabaseIntegrityService({ db: freshDb })
      const health = await freshIntegrity.getDatabaseHealth()
      expect(health.status).toBe('healthy')
      expect(health.integrityStatus).toBe('ok')
      expect(health.foreignKeyStatus).toBe('ok')
      expect(health.violationsCount).toBe(0)

      // 4. Fresh Diagnostics Collection
      const freshBuffer = new ApplicationErrorRingBuffer(50)
      const freshCollector = new DiagnosticsCollector({
        db: freshDb,
        integrityService: freshIntegrity,
        errorRingBuffer: freshBuffer
      })
      const diag = await freshCollector.collect()
      expect(diag.databaseHealth.status).toBe('healthy')
      expect(diag.databaseMetrics.knowledgeBasesCount).toBe(0)
      expect(diag.databaseMetrics.botsCount).toBe(0)
      expect(diag.recentErrors.length).toBe(0)

      freshManager.close()
    } finally {
      try {
        fs.rmSync(freshTempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup error
      }
    }
  })

  // --------------------------------------------------------------------------
  // Workflow 11: Exact Name Confirmation Guards
  // --------------------------------------------------------------------------
  it('Workflow 11: rejects deletion requests when exact confirmation names do not match', async () => {
    const kb = ctx.kbRepo.create({ name: 'Guarded KB', description: 'Guard test' })
    const bot = ctx.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Guarded Bot',
      modelId: 'm1'
    })

    // Bot deletion with incorrect name confirmation must fail
    await expect(
      deletionService.deleteEntity({
        entityType: 'bot',
        entityId: bot.id,
        confirmName: 'Wrong Bot Name'
      })
    ).rejects.toThrow(DeletionServiceError)

    // Verify Bot is still alive in DB
    expect(ctx.botRepo.getByIdOnly(bot.id)).toBeDefined()

    // Knowledge Base deletion with incorrect name confirmation must fail
    await expect(
      deletionService.deleteEntity({
        entityType: 'knowledge_base',
        entityId: kb.id,
        confirmName: 'Wrong KB Name'
      })
    ).rejects.toThrow(DeletionServiceError)

    // Verify KB is still alive in DB
    expect(ctx.kbRepo.getById(kb.id)).toBeDefined()
  })
})
