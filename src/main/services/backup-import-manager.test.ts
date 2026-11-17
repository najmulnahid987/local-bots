import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { BackupExportManager } from './backup-export-manager'
import { BackupImportManager } from './backup-import-manager'
import { ZipArchiveWriter } from './zip-archive'

describe('BackupImportManager', () => {
  let testCtx: MigratedTestDatabaseContext
  let tmpDir: string
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let botMemoryRepo: BotMemoryRepository
  let sourceRepo: KnowledgeSourceRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let storageManager: DocumentStorageManager
  let exportManager: BackupExportManager
  let importManager: BackupImportManager
  let validArchivePath: string
  let sourceKbId: string

  beforeEach(async () => {
    testCtx = createMigratedTestDatabase()
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'import-mgr-test-'))

    kbRepo = new KnowledgeBaseRepository(testCtx.db)
    botRepo = new BotRepository(testCtx.db)
    botMemoryRepo = new BotMemoryRepository(testCtx.db)
    sourceRepo = new KnowledgeSourceRepository(testCtx.db)
    convRepo = new ConversationRepository(testCtx.db)
    msgRepo = new MessageRepository(testCtx.db)
    storageManager = new DocumentStorageManager({ userDataPath: tmpDir })

    exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      appVersion: '1.0.0'
    })

    importManager = new BackupImportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      tempBaseDir: path.join(tmpDir, 'staging')
    })

    // Setup a populated source Knowledge Base
    const kb = kbRepo.create({
      name: 'Source Project Alpha',
      description: 'Alpha workspace for import tests'
    })
    sourceKbId = kb.id

    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Alpha Analyst',
      description: 'Performs document analysis',
      modelId: 'gpt-4o',
      systemPrompt: 'You are an alpha analyst.',
      toolPermissions: ['search_knowledge_base']
    })

    botMemoryRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      memoryType: 'pinned_instruction',
      content: 'Always format output in bullet points.'
    })
    botMemoryRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      memoryType: 'user_note',
      content: 'User prefers short responses.'
    })

    const sourceDocId = crypto.randomUUID()
    const docContent = '# Alpha Spec\n\nThis is an alpha test specification document.'
    const docBuffer = Buffer.from(docContent, 'utf8')
    const docHash = crypto.createHash('sha256').update(docBuffer).digest('hex')

    await storageManager.ensureOriginalsDirectory(kb.id)
    const originalPath = storageManager.resolveOriginalPath(kb.id, sourceDocId, 'md')
    fs.writeFileSync(originalPath, docBuffer)

    sourceRepo.create({
      id: sourceDocId,
      knowledge_base_id: kb.id,
      file_name: 'alpha-spec.md',
      original_file_name: 'alpha-spec.md',
      relative_file_path: `originals/${sourceDocId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: docBuffer.length,
      content_hash: docHash,
      indexing_status: 'completed'
    })

    const conv = convRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      title: 'Project Inception'
    })

    msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kb.id,
      role: 'user',
      content: 'Can you summarize alpha spec?'
    })
    msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kb.id,
      role: 'assistant',
      content: 'Alpha spec is an alpha test specification document.'
    })

    // Export archive to a file
    validArchivePath = path.join(tmpDir, 'alpha-export.voyaro-kb.zip')
    const exportResult = await exportManager.exportKnowledgeBase(kb.id, validArchivePath)
    expect(exportResult.success).toBe(true)
  })

  afterEach(async () => {
    testCtx.cleanup()
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  describe('selectAndPreviewArchive', () => {
    it('1. successfully previews a valid export archive with sanitized counts and document list', async () => {
      const previewResult = await importManager.selectAndPreviewArchive(validArchivePath)

      expect(previewResult.success).toBe(true)
      expect(previewResult.cancelled).toBe(false)
      expect(previewResult.preview).toBeDefined()

      const preview = previewResult.preview!
      expect(preview.knowledgeBase.name).toBe('Source Project Alpha')
      expect(preview.knowledgeBase.description).toBe('Alpha workspace for import tests')
      expect(preview.counts.bots).toBe(1)
      expect(preview.counts.memories).toBe(2)
      expect(preview.counts.sources).toBe(1)
      expect(preview.counts.conversations).toBe(1)
      expect(preview.counts.messages).toBe(2)
      expect(preview.documentFiles.length).toBe(1)
      expect(preview.documentFiles[0].originalFileName).toBe('alpha-spec.md')
      expect(preview.securityNotice).toContain('disconnected state')
      expect(preview.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('2. handles native dialog cancellation gracefully', async () => {
      const customImportManager = new BackupImportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        showOpenDialog: async () => ({ canceled: true, filePaths: [] })
      })

      const res = await customImportManager.selectAndPreviewArchive()
      expect(res.success).toBe(false)
      expect(res.cancelled).toBe(true)
      expect(res.preview).toBeUndefined()
    })

    it('3. rejects non-existent or inaccessible archive files', async () => {
      const fakePath = path.join(tmpDir, 'does-not-exist.voyaro-kb.zip')
      await expect(importManager.selectAndPreviewArchive(fakePath)).rejects.toThrow(
        /could not be read or does not exist/
      )
    })

    it('4. rejects archives containing embedded credentials or secrets', async () => {
      // Create a malicious archive containing an OpenAI key in a markdown file
      const secretZipPath = path.join(tmpDir, 'secret-leak.voyaro-kb.zip')
      const writer = new ZipArchiveWriter()
      const secretKey = 'sk-proj-' + 'A'.repeat(40)

      const secretDoc = `Here is my key: ${secretKey}`
      const secretSourceId = crypto.randomUUID()
      const secretDocPath = `documents/${secretSourceId}.md`
      const secretDocBuf = Buffer.from(secretDoc, 'utf8')
      const secretDocHash = crypto.createHash('sha256').update(secretDocBuf).digest('hex')

      const kbBuf = Buffer.from(
        JSON.stringify({
          id: crypto.randomUUID(),
          name: 'Secret KB',
          description: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          archivedAt: null
        }),
        'utf8'
      )
      const botsBuf = Buffer.from('[]', 'utf8')
      const memsBuf = Buffer.from('[]', 'utf8')
      const sourcesBuf = Buffer.from(
        JSON.stringify([
          {
            id: secretSourceId,
            fileName: 'secret.md',
            originalFileName: 'secret.md',
            fileType: 'md',
            mimeType: 'text/markdown',
            fileSizeBytes: secretDocBuf.length,
            contentHash: secretDocHash,
            indexingStatus: 'completed',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            indexedAt: Date.now()
          }
        ]),
        'utf8'
      )
      const convsBuf = Buffer.from('[]', 'utf8')

      const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

      const fakeManifest = {
        format: 'voyaro-knowledge-base-export',
        schemaVersion: '1.0.0',
        exportedAt: Date.now(),
        appVersion: '1.0.0',
        knowledgeBase: { id: crypto.randomUUID(), name: 'Secret KB' },
        counts: {
          bots: 0,
          memories: 0,
          sources: 1,
          conversations: 0,
          messages: 0,
          totalSourceBytes: secretDocBuf.length
        },
        files: [
          { path: 'knowledge-base.json', sizeBytes: kbBuf.length, sha256: sha(kbBuf) },
          { path: 'bots.json', sizeBytes: botsBuf.length, sha256: sha(botsBuf) },
          { path: 'bot-memories.json', sizeBytes: memsBuf.length, sha256: sha(memsBuf) },
          { path: 'sources.json', sizeBytes: sourcesBuf.length, sha256: sha(sourcesBuf) },
          { path: 'conversations.json', sizeBytes: convsBuf.length, sha256: sha(convsBuf) },
          { path: secretDocPath, sizeBytes: secretDocBuf.length, sha256: secretDocHash }
        ],
        excludedCategories: []
      }

      const manifestBuf = Buffer.from(JSON.stringify(fakeManifest, null, 2), 'utf8')

      writer.addEntry('manifest.json', manifestBuf)
      writer.addEntry('knowledge-base.json', kbBuf)
      writer.addEntry('bots.json', botsBuf)
      writer.addEntry('bot-memories.json', memsBuf)
      writer.addEntry('sources.json', sourcesBuf)
      writer.addEntry('conversations.json', convsBuf)
      writer.addEntry(secretDocPath, secretDocBuf)

      fs.writeFileSync(secretZipPath, writer.build())

      await expect(importManager.selectAndPreviewArchive(secretZipPath)).rejects.toThrow(
        /Security check failed.*potential credentials/
      )
    })
  })

  describe('executeImport', () => {
    it('5. imports as a new Knowledge Base with remapped IDs and disconnected bots', async () => {
      const previewRes = await importManager.selectAndPreviewArchive(validArchivePath)
      expect(previewRes.success).toBe(true)
      const sessionId = previewRes.preview!.sessionId

      const result = await importManager.executeImport({
        sessionId,
        strategy: 'new'
      })

      expect(result.success).toBe(true)
      expect(result.strategy).toBe('new')
      expect(result.knowledgeBaseId).toBeDefined()
      expect(result.knowledgeBaseId).not.toBe(sourceKbId) // Fresh UUID

      const newKbId = result.knowledgeBaseId!
      const newKb = kbRepo.getById(newKbId)
      expect(newKb).toBeDefined()
      expect(newKb!.name).toBe('Source Project Alpha')

      // Check bots in new KB
      const newBots = botRepo.listByKnowledgeBase(newKbId)
      expect(newBots.length).toBe(1)
      expect(newBots[0].name).toBe('Alpha Analyst')
      expect(newBots[0].knowledgeBaseId).toBe(newKbId)
      // MANDATORY SECURITY INVARIANT: Bot must be disconnected
      expect(newBots[0].providerConnectionId).toBeNull()

      // Check memories in new KB
      const newMemories = botMemoryRepo.listByBot(newBots[0].id, newKbId)
      expect(newMemories.length).toBe(2)

      // Check sources in new KB
      const newSources = sourceRepo.listByKnowledgeBase(newKbId)
      expect(newSources.length).toBe(1)
      expect(newSources[0].file_name).toBe('alpha-spec.md')
      expect(newSources[0].knowledge_base_id).toBe(newKbId)

      // Check file exists in new originals storage
      const newOriginalPath = storageManager.resolveOriginalPath(newKbId, newSources[0].id, 'md')
      expect(fs.existsSync(newOriginalPath)).toBe(true)
      const content = fs.readFileSync(newOriginalPath, 'utf8')
      expect(content).toContain('This is an alpha test specification document.')

      // Check conversations and messages in new KB
      const newConvs = convRepo.listByBot(newBots[0].id, newKbId)
      expect(newConvs.length).toBe(1)
      expect(newConvs[0].title).toBe('Project Inception')

      const newMsgs = msgRepo.listByConversation(newConvs[0].id, newBots[0].id, newKbId)
      expect(newMsgs.length).toBe(2)
      expect(newMsgs[0].role).toBe('user')
      expect(newMsgs[1].role).toBe('assistant')
    })

    it('6. merges into an existing Knowledge Base without overwriting existing data', async () => {
      // Create a target Knowledge Base B with its own existing bot
      const targetKb = kbRepo.create({
        name: 'Target Beta KB',
        description: 'Existing target'
      })
      botRepo.create({
        knowledgeBaseId: targetKb.id,
        name: 'Beta Existing Bot',
        modelId: 'gpt-4o'
      })

      const previewRes = await importManager.selectAndPreviewArchive(validArchivePath)
      const sessionId = previewRes.preview!.sessionId

      const result = await importManager.executeImport({
        sessionId,
        strategy: 'merge',
        targetKnowledgeBaseId: targetKb.id
      })

      expect(result.success).toBe(true)
      expect(result.strategy).toBe('merge')
      expect(result.knowledgeBaseId).toBe(targetKb.id)

      // Check target KB now has 2 bots: original + imported
      const targetBots = botRepo.listByKnowledgeBase(targetKb.id)
      expect(targetBots.length).toBe(2)
      const botNames = targetBots.map((b) => b.name)
      expect(botNames).toContain('Beta Existing Bot')
      expect(botNames).toContain('Alpha Analyst')
    })

    it('7. replaces existing Knowledge Base after exact typed confirmation and wipes old content', async () => {
      // Create a target Knowledge Base with an existing bot and source
      const targetKb = kbRepo.create({
        name: 'Target To Replace',
        description: 'Will be overwritten'
      })
      const oldBot = botRepo.create({
        knowledgeBaseId: targetKb.id,
        name: 'Old Deprecated Bot',
        modelId: 'gpt-4o'
      })
      botMemoryRepo.create({
        botId: oldBot.id,
        knowledgeBaseId: targetKb.id,
        content: 'Old memory'
      })

      const previewRes = await importManager.selectAndPreviewArchive(validArchivePath)
      const sessionId = previewRes.preview!.sessionId

      // Attempt replace with wrong confirmation name
      await expect(
        importManager.executeImport({
          sessionId,
          strategy: 'replace',
          targetKnowledgeBaseId: targetKb.id,
          confirmationName: 'Wrong Name'
        })
      ).rejects.toThrow(/Confirmation name does not match/)

      // Execute replace with exact confirmation name
      const replaceResult = await importManager.executeImport({
        sessionId,
        strategy: 'replace',
        targetKnowledgeBaseId: targetKb.id,
        confirmationName: 'Target To Replace'
      })

      expect(replaceResult.success).toBe(true)
      expect(replaceResult.knowledgeBaseId).toBe(targetKb.id)

      // Check old bot is wiped out and replaced with imported bot
      const targetBots = botRepo.listByKnowledgeBase(targetKb.id)
      expect(targetBots.length).toBe(1)
      expect(targetBots[0].name).toBe('Alpha Analyst')
      expect(targetBots[0].providerConnectionId).toBeNull()

      // Check old memories were wiped out and replaced
      const targetMemories = botMemoryRepo.listByBot(targetBots[0].id, targetKb.id)
      expect(targetMemories.length).toBe(2)
      expect(targetMemories.some((m) => m.content === 'Old memory')).toBe(false)
    })

    it('8. triggers re-indexing via DocumentLifecycleService when available', async () => {
      const mockReindex = vi.fn().mockResolvedValue({ success: true })
      const lifecycleServiceMock = {
        reindex: mockReindex
      } as unknown as import('../documents/lifecycle/document-lifecycle-service').DocumentLifecycleService

      const customImportMgr = new BackupImportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        documentLifecycleService: lifecycleServiceMock,
        tempBaseDir: path.join(tmpDir, 'staging-lifecycle')
      })

      const previewRes = await customImportMgr.selectAndPreviewArchive(validArchivePath)
      const result = await customImportMgr.executeImport({
        sessionId: previewRes.preview!.sessionId,
        strategy: 'new'
      })

      expect(result.success).toBe(true)
      expect(mockReindex).toHaveBeenCalledTimes(1)
      expect(result.counts?.indexedSources).toBe(1)
      expect(result.counts?.failedSources).toBe(0)
    })
  })

  describe('cancelImport', () => {
    it('9. cleans up temporary staging directory and invalidates session on cancel', async () => {
      const previewRes = await importManager.selectAndPreviewArchive(validArchivePath)
      const sessionId = previewRes.preview!.sessionId

      const cancelRes = await importManager.cancelImport({ sessionId })
      expect(cancelRes.success).toBe(true)

      // Attempting to execute with cancelled session should fail
      await expect(
        importManager.executeImport({
          sessionId,
          strategy: 'new'
        })
      ).rejects.toThrow(/Import session expired or not found/)
    })
  })
})
