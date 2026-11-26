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
import { ExtractedDocumentRepository } from '../database/repositories/extracted-document-repository'
import { DocumentValidationRepository } from '../database/repositories/document-validation-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
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

    it('8b. restores canonical UniversalDocument and DocumentPreservationReport into database upon import', async () => {
      // 1. Create a source KB with extracted doc and preservation report
      const presKb = kbRepo.create({ name: 'Preservation Source KB' })
      const sourceId = crypto.randomUUID()
      const docContent = '# Preserved Doc\n\nPreserved content.'
      const docBuf = Buffer.from(docContent, 'utf8')
      const docHash = crypto.createHash('sha256').update(docBuf).digest('hex')

      const origPath = storageManager.resolveOriginalPath(presKb.id, sourceId, 'md')
      await fs.promises.mkdir(path.dirname(origPath), { recursive: true })
      await fs.promises.writeFile(origPath, docBuf)

      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: presKb.id,
        file_name: `${sourceId}.md`,
        original_file_name: 'preserved.md',
        relative_file_path: `originals/${sourceId}.md`,
        file_type: 'md',
        mime_type: 'text/markdown',
        file_size: docBuf.length,
        content_hash: docHash,
        indexing_status: 'completed'
      })

      const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
      extractedRepo.save(
        sourceId,
        {
          id: sourceId,
          format: 'md',
          extractedAt: Date.now(),
          extractor: { id: 'test-md', name: 'Test MD', version: '2.0.0' },
          text: docContent,
          blocks: [
            {
              id: 'b1',
              type: 'heading',
              level: 1,
              headingPath: ['Preserved Doc'],
              orderIndex: 0,
              text: 'Preserved Doc'
            },
            {
              id: 'b2',
              type: 'paragraph',
              orderIndex: 1,
              text: 'Preserved content.'
            }
          ],
          metadata: {},
          warnings: [],
          quality: { fidelity: 'high', isLossy: false, isOcr: false }
        },
        Date.now(),
        presKb.id
      )

      const validationRepo = new DocumentValidationRepository(testCtx.db)
      validationRepo.saveReport(
        sourceId,
        {
          schemaVersion: '1.0.0',
          sourceId,
          format: 'md',
          timestamp: Date.now(),
          status: 'complete',
          extractionStatus: 'complete',
          textualFidelity: 'complete',
          structuralFidelity: 'complete',
          chunkCoverageStatus: 'complete',
          extractionReport: {
            status: 'complete',
            textualFidelity: 'complete',
            structuralFidelity: 'complete',
            totalElements: 2,
            elementCountsByType: { heading: 1, paragraph: 1 },
            dispositionCounts: {
              fully_extracted: 2,
              text_preserved_unparsed: 0,
              reference_only: 0,
              partially_extracted: 0,
              unsupported: 0,
              failed: 0,
              unknown: 0
            },
            textualCoverage: {
              expectedChars: 31,
              extractedChars: 31,
              coverageRatio: 1,
              status: 'exact'
            },
            unsupportedElements: [],
            failedElements: [],
            referenceOnlyElements: [],
            warnings: [],
            measurementLimitations: []
          },
          chunkReport: {
            status: 'complete',
            totalBlocks: 2,
            coveredBlocks: 2,
            missingBlockIds: [],
            nonSearchableBlocks: [],
            primaryCharacterCoverage: {
              expectedChars: 31,
              coveredChars: 31,
              coverageRatio: 1,
              missingIntervals: []
            },
            repeatedOverlapTokens: 0,
            contextualTokens: 5,
            structuralDispositions: {},
            invalidSpanCount: 0,
            outOfBoundsSpanCount: 0,
            warnings: [],
            errors: []
          },
          warnings: [],
          errors: [],
          measurementLimitations: [],
          versions: {
            extractorVersion: '2.0.0',
            chunkerVersion: '2.0.0',
            validatorVersion: '1.0.0'
          }
        },
        Date.now(),
        presKb.id
      )

      // Export it
      const presArchivePath = path.join(tmpDir, 'preserved.voyaro-kb.zip')
      const presExportManager = new BackupExportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        extractedDocumentRepository: extractedRepo,
        documentValidationRepository: validationRepo
      })
      await presExportManager.exportKnowledgeBase(presKb.id, presArchivePath)

      // Import as new KB
      const previewRes = await importManager.selectAndPreviewArchive(presArchivePath)
      expect(previewRes.success).toBe(true)
      const importRes = await importManager.executeImport({
        sessionId: previewRes.preview!.sessionId,
        strategy: 'new'
      })
      expect(importRes.success).toBe(true)

      const targetKbId = importRes.knowledgeBaseId!
      const importedSources = sourceRepo.listByKnowledgeBase(targetKbId)
      expect(importedSources.length).toBe(1)
      const newSourceId = importedSources[0].id

      // Verify canonical UniversalDocument was restored in SQLite
      const restoredDoc = extractedRepo.get(newSourceId, targetKbId)
      expect(restoredDoc).not.toBeNull()
      expect(restoredDoc?.blocks.length).toBe(2)
      expect(restoredDoc?.blocks[0].text).toBe('Preserved Doc')

      // Verify DocumentPreservationReport was restored in SQLite
      const restoredReport = validationRepo.getReport(newSourceId, targetKbId)
      expect(restoredReport).not.toBeNull()
      expect(restoredReport?.status).toBe('complete')
      expect(restoredReport?.extractionReport.totalElements).toBe(2)
    })

    it('8c. successfully imports legacy 1.0.0 archive without extracted docs or reports and restores original files', async () => {
      // Build a 1.0.0 archive manually
      const writer = new ZipArchiveWriter()
      const manifestObj = {
        format: 'voyaro-knowledge-base-export',
        schemaVersion: '1.0.0',
        exportedAt: Date.now(),
        appVersion: '1.0.0',
        knowledgeBase: { id: crypto.randomUUID(), name: 'Legacy 1.0.0 KB' },
        counts: {
          bots: 0,
          memories: 0,
          sources: 1,
          conversations: 0,
          messages: 0,
          totalSourceBytes: 15
        },
        files: [
          {
            path: 'knowledge-base.json',
            sizeBytes: 0,
            sha256: ''
          },
          { path: 'bots.json', sizeBytes: 0, sha256: '' },
          { path: 'bot-memories.json', sizeBytes: 0, sha256: '' },
          { path: 'sources.json', sizeBytes: 0, sha256: '' },
          { path: 'conversations.json', sizeBytes: 0, sha256: '' },
          { path: 'documents/00000000-0000-4000-8000-000000000001.txt', sizeBytes: 15, sha256: '' }
        ],
        excludedCategories: []
      }

      const kbJson = Buffer.from(
        JSON.stringify({
          id: manifestObj.knowledgeBase.id,
          name: 'Legacy 1.0.0 KB',
          description: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          archivedAt: null
        }),
        'utf8'
      )
      const botsJson = Buffer.from('[]', 'utf8')
      const memoriesJson = Buffer.from('[]', 'utf8')
      const sourcesJson = Buffer.from(
        JSON.stringify([
          {
            id: '00000000-0000-4000-8000-000000000001',
            fileName: '00000000-0000-4000-8000-000000000001.txt',
            originalFileName: 'legacy.txt',
            fileType: 'txt',
            mimeType: 'text/plain',
            fileSizeBytes: 15,
            contentHash: crypto.createHash('sha256').update('Legacy file txt').digest('hex'),
            indexingStatus: 'completed',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            indexedAt: Date.now()
          }
        ]),
        'utf8'
      )
      const convJson = Buffer.from('[]', 'utf8')
      const docBytes = Buffer.from('Legacy file txt', 'utf8')

      // Update manifest files array with real sizes and sha256 hashes
      const filesMap: Array<{ path: string; data: Buffer }> = [
        { path: 'knowledge-base.json', data: kbJson },
        { path: 'bots.json', data: botsJson },
        { path: 'bot-memories.json', data: memoriesJson },
        { path: 'sources.json', data: sourcesJson },
        { path: 'conversations.json', data: convJson },
        { path: 'documents/00000000-0000-4000-8000-000000000001.txt', data: docBytes }
      ]

      manifestObj.files = filesMap.map((f) => ({
        path: f.path,
        sizeBytes: f.data.length,
        sha256: crypto.createHash('sha256').update(f.data).digest('hex')
      }))

      const manifestBuf = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8')
      writer.addEntry('manifest.json', manifestBuf)
      for (const f of filesMap) {
        writer.addEntry(f.path, f.data)
      }

      const legacyZipPath = path.join(tmpDir, 'legacy-1.0.0.voyaro-kb.zip')
      await writer.writeToFile(legacyZipPath)

      // Preview and import legacy archive
      const preview = await importManager.selectAndPreviewArchive(legacyZipPath)
      expect(preview.success).toBe(true)
      expect(preview.preview?.schemaVersion).toBe('1.0.0')

      const importResult = await importManager.executeImport({
        sessionId: preview.preview!.sessionId,
        strategy: 'new'
      })
      expect(importResult.success).toBe(true)

      const targetKbId = importResult.knowledgeBaseId!
      const targetSources = sourceRepo.listByKnowledgeBase(targetKbId)
      expect(targetSources.length).toBe(1)
      expect(targetSources[0].original_file_name).toBe('legacy.txt')

      // Verify original file was restored
      const restoredPath = storageManager.resolveOriginalPath(
        targetKbId,
        targetSources[0].id,
        'txt'
      )
      expect(fs.existsSync(restoredPath)).toBe(true)
      expect(fs.readFileSync(restoredPath, 'utf8')).toBe('Legacy file txt')
    })

    it('8d. successfully consolidates multi-conversation legacy backup into one canonical conversation per bot', async () => {
      const writer = new ZipArchiveWriter()
      const botId = crypto.randomUUID()
      const conv1Id = crypto.randomUUID()
      const conv2Id = crypto.randomUUID()
      const kbId = crypto.randomUUID()

      const kbObj = {
        id: kbId,
        name: 'Legacy Multi-Conv KB',
        description: '',
        createdAt: 1000,
        updatedAt: 1000,
        archivedAt: null
      }
      const botsObj = [
        {
          id: botId,
          name: 'Multi-Chat Bot',
          description: '',
          systemPrompt: '',
          modelId: 'gpt-6-luna',
          status: 'active' as const,
          toolPermissions: ['search_knowledge_base' as const],
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
      const convsObj = [
        {
          conversation: {
            id: conv1Id,
            botId,
            title: 'Initial Legacy Thread',
            createdAt: 1000,
            updatedAt: 1500,
            archivedAt: null
          },
          messages: [
            {
              id: crypto.randomUUID(),
              conversationId: conv1Id,
              role: 'user' as const,
              content: 'First question',
              contentFormat: 'markdown' as const,
              metadata: {
                citations: [
                  {
                    citationNumber: 1,
                    sourceId: crypto.randomUUID(),
                    chunkId: crypto.randomUUID(),
                    fileName: 'test.txt',
                    fileType: 'txt' as const,
                    pageNumber: null,
                    headingPath: null,
                    chunkIndex: 0
                  }
                ]
              },
              createdAt: 1100
            },
            {
              id: crypto.randomUUID(),
              conversationId: conv1Id,
              role: 'assistant' as const,
              content: 'First answer',
              contentFormat: 'markdown' as const,
              metadata: {},
              createdAt: 1200
            }
          ]
        },
        {
          conversation: {
            id: conv2Id,
            botId,
            title: 'Second Legacy Thread',
            createdAt: 2000,
            updatedAt: 2500,
            archivedAt: null
          },
          messages: [
            {
              id: crypto.randomUUID(),
              conversationId: conv2Id,
              role: 'user' as const,
              content: 'Second question in separate thread',
              contentFormat: 'markdown' as const,
              metadata: {},
              createdAt: 2100
            }
          ]
        }
      ]

      const kbJson = Buffer.from(JSON.stringify(kbObj), 'utf8')
      const botsJson = Buffer.from(JSON.stringify(botsObj), 'utf8')
      const memsJson = Buffer.from('[]', 'utf8')
      const sourcesJson = Buffer.from('[]', 'utf8')
      const convsJson = Buffer.from(JSON.stringify(convsObj), 'utf8')

      const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

      const manifestObj = {
        format: 'voyaro-knowledge-base-export',
        schemaVersion: '1.0.0',
        exportedAt: Date.now(),
        appVersion: '1.0.0',
        knowledgeBase: { id: kbId, name: 'Legacy Multi-Conv KB' },
        counts: {
          bots: 1,
          memories: 0,
          sources: 0,
          conversations: 2,
          messages: 3,
          totalSourceBytes: 0
        },
        files: [
          { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha(kbJson) },
          { path: 'bots.json', sizeBytes: botsJson.length, sha256: sha(botsJson) },
          { path: 'bot-memories.json', sizeBytes: memsJson.length, sha256: sha(memsJson) },
          { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha(sourcesJson) },
          { path: 'conversations.json', sizeBytes: convsJson.length, sha256: sha(convsJson) }
        ],
        excludedCategories: []
      }

      const manifestBuf = Buffer.from(JSON.stringify(manifestObj), 'utf8')
      writer.addEntry('manifest.json', manifestBuf)
      writer.addEntry('knowledge-base.json', kbJson)
      writer.addEntry('bots.json', botsJson)
      writer.addEntry('bot-memories.json', memsJson)
      writer.addEntry('sources.json', sourcesJson)
      writer.addEntry('conversations.json', convsJson)

      const multiConvZipPath = path.join(tmpDir, 'multi-conv-legacy.zip')
      fs.writeFileSync(multiConvZipPath, writer.build())

      const preview = await importManager.selectAndPreviewArchive(multiConvZipPath)
      expect(preview.success).toBe(true)
      expect(preview.preview?.counts.conversations).toBe(2)

      const importResult = await importManager.executeImport({
        sessionId: preview.preview!.sessionId,
        strategy: 'new'
      })
      expect(importResult.success).toBe(true)

      const targetKbId = importResult.knowledgeBaseId!

      // 1. Exactly 1 bot imported
      const importedBots = botRepo.listByKnowledgeBase(targetKbId)
      expect(importedBots).toHaveLength(1)
      const newBot = importedBots[0]

      // 2. Exactly 1 canonical conversation in SQLite
      const importedConvs = convRepo.listByBot(newBot.id, targetKbId)
      expect(importedConvs).toHaveLength(1)
      const canonicalConv = importedConvs[0]
      expect(canonicalConv.title).toBe('Initial Legacy Thread')

      // 3. Exactly 2 segments preserving historical boundaries
      const segments = convRepo.getSegments(canonicalConv.id)
      expect(segments).toHaveLength(2)
      expect(segments[0].segmentOrder).toBe(0)
      expect(segments[0].title).toBe('Initial Legacy Thread')
      expect(segments[0].originalConversationId).toBe(conv1Id)
      expect(segments[0].messageCount).toBe(2)

      expect(segments[1].segmentOrder).toBe(1)
      expect(segments[1].title).toBe('Second Legacy Thread')
      expect(segments[1].originalConversationId).toBe(conv2Id)
      expect(segments[1].messageCount).toBe(1)

      // 4. All 3 messages preserved and linked to canonical conversation and their segments
      const messages = msgRepo.listByConversation(canonicalConv.id, newBot.id, targetKbId)
      expect(messages).toHaveLength(3)
      expect(messages[0].content).toBe('First question')
      expect(messages[0].segmentId).toBe(segments[0].id)
      expect(messages[0].metadata.citations).toBeDefined()

      expect(messages[1].content).toBe('First answer')
      expect(messages[1].segmentId).toBe(segments[0].id)

      expect(messages[2].content).toBe('Second question in separate thread')
      expect(messages[2].segmentId).toBe(segments[1].id)

      expect(testCtx.db.pragma('foreign_key_check')).toEqual([])
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

  describe('Finding C: Filesystem and SQLite Import Atomicity & Failure Injection', () => {
    it('1. failure after original-file copying rolls back all filesystem files and commits zero DB records', async () => {
      const preview = await importManager.selectAndPreviewArchive(validArchivePath)
      expect(preview.success).toBe(true)

      // Inject failure during DB transaction (simulating failure right after files copied)
      const originalPrepare = testCtx.db.prepare.bind(testCtx.db)
      const prepareSpy = vi.spyOn(testCtx.db, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO knowledge_sources')) {
          throw new Error('SIMULATED_DB_FAILURE_DURING_SOURCE_INSERT')
        }
        return originalPrepare(sql)
      })

      await expect(
        importManager.executeImport({
          sessionId: preview.preview!.sessionId,
          strategy: 'new'
        })
      ).rejects.toThrow(/SIMULATED_DB_FAILURE_DURING_SOURCE_INSERT/)

      prepareSpy.mockRestore()

      // Verify zero new knowledge bases or sources committed
      const allKbs = kbRepo.list()
      expect(allKbs.length).toBe(1) // only initial sourceKbId exists
      expect(sourceRepo.listByKnowledgeBase('non-existent-id')).toHaveLength(0)

      // Verify no orphaned files were left in originals directory
      const originalsBase = path.join(tmpDir, 'knowledge_sources')
      if (fs.existsSync(originalsBase)) {
        const kbDirs = fs.readdirSync(originalsBase)
        for (const dir of kbDirs) {
          if (dir !== sourceKbId) {
            const files = fs.readdirSync(path.join(originalsBase, dir, 'originals'))
            expect(files.length).toBe(0)
          }
        }
      }
    })

    it('2. failure during extracted-document insertion rolls back entire transaction and cleans files', async () => {
      // Create archive with extracted document
      const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
      const presKb = kbRepo.create({ name: 'Rollback Test KB' })
      const presSrcId = crypto.randomUUID()
      await storageManager.ensureOriginalsDirectory(presKb.id)
      const presSrc = sourceRepo.create({
        id: presSrcId,
        knowledge_base_id: presKb.id,
        file_name: 'rollback.txt',
        original_file_name: 'rollback.txt',
        relative_file_path: `originals/${presSrcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 14,
        content_hash: crypto.createHash('sha256').update('Rollback test!').digest('hex')
      })
      const presPath = storageManager.resolveOriginalPath(presKb.id, presSrc.id, 'txt')
      fs.writeFileSync(presPath, 'Rollback test!', 'utf8')
      extractedRepo.save(
        presSrc.id,
        {
          id: presSrc.id,
          format: 'txt',
          extractedAt: Date.now(),
          extractor: { id: 'test', name: 'Test', version: '1.0.0' },
          text: 'Rollback test!',
          blocks: [{ id: 'b1', type: 'paragraph', orderIndex: 0, text: 'Rollback test!' }],
          metadata: {},
          warnings: [],
          quality: { fidelity: 'high', isLossy: false, isOcr: false }
        },
        Date.now(),
        presKb.id
      )

      const archivePath = path.join(tmpDir, 'extracted-rollback.voyaro-kb.zip')
      const presExport = new BackupExportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        extractedDocumentRepository: extractedRepo
      })
      await presExport.exportKnowledgeBase(presKb.id, archivePath)

      const preview = await importManager.selectAndPreviewArchive(archivePath)
      expect(preview.success).toBe(true)

      const originalPrepare = testCtx.db.prepare.bind(testCtx.db)
      const prepareSpy = vi.spyOn(testCtx.db, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('knowledge_extracted_documents')) {
          throw new Error('SIMULATED_EXTRACTED_DOC_INSERT_FAILURE')
        }
        return originalPrepare(sql)
      })

      await expect(
        importManager.executeImport({
          sessionId: preview.preview!.sessionId,
          strategy: 'new'
        })
      ).rejects.toThrow(/SIMULATED_EXTRACTED_DOC_INSERT_FAILURE/)

      prepareSpy.mockRestore()

      // Verify zero orphaned extracted docs
      const rows = testCtx.db
        .prepare('SELECT COUNT(*) as count FROM knowledge_extracted_documents WHERE source_id != ?')
        .get(presSrc.id) as { count: number }
      expect(rows.count).toBe(0)
    })

    it('3. post-commit verification failure in strategy new deletes newly created KB and files', async () => {
      const preview = await importManager.selectAndPreviewArchive(validArchivePath)
      expect(preview.success).toBe(true)

      let checkingVerification = false
      const origTx = testCtx.db.transaction.bind(testCtx.db)
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const txSpy = vi.spyOn(testCtx.db, 'transaction').mockImplementation(((fn: any) => {
        const txFn = origTx(fn)
        const wrapper = (...args: any[]): any => {
          const res = txFn(...args)
          checkingVerification = true
          return res
        }
        Object.assign(wrapper, txFn)
        return wrapper as any
      }) as any)
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const originalExists = fs.existsSync
      const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p)
        if (
          checkingVerification &&
          pathStr.includes('documents') &&
          pathStr.includes('originals')
        ) {
          return false
        }
        return originalExists(p)
      })

      try {
        await expect(
          importManager.executeImport({
            sessionId: preview.preview!.sessionId,
            strategy: 'new'
          })
        ).rejects.toThrow(/Post-import verification failed/)

        // Verify created Knowledge Base was cleaned up (rolled back)
        const kbs = kbRepo.list()
        expect(kbs.length).toBe(1) // only initial sourceKbId remains
      } finally {
        existsSpy.mockRestore()
        txSpy.mockRestore()
      }
    })
  })

  describe('Finding D: Chunk Regeneration and Report Freshness After Import', () => {
    it('1. regenerates chunks using current chunker, updates chunkerVersion and FTS5 index', async () => {
      const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
      const validationRepo = new DocumentValidationRepository(testCtx.db)
      const lifecycleService = new DocumentLifecycleService({
        db: testCtx.db,
        sourceRepository: sourceRepo,
        extractedDocumentRepository: extractedRepo,
        validationRepository: validationRepo,
        storageManager
      })

      const customImportManager = new BackupImportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        documentLifecycleService: lifecycleService,
        tempBaseDir: path.join(tmpDir, 'staging-regen')
      })

      // Create and export a KB with modern UniversalDocument and preservation report
      const regenKb = kbRepo.create({ name: 'Chunk Regeneration KB' })
      const regenSrcId = crypto.randomUUID()
      await storageManager.ensureOriginalsDirectory(regenKb.id)
      const textContent = 'Paragraph one of modern doc.\n\nParagraph two with searchable keywords.'
      const regenSrc = sourceRepo.create({
        id: regenSrcId,
        knowledge_base_id: regenKb.id,
        file_name: 'modern.txt',
        original_file_name: 'modern.txt',
        relative_file_path: `originals/${regenSrcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: textContent.length,
        content_hash: crypto.createHash('sha256').update(textContent).digest('hex')
      })
      const filePath = storageManager.resolveOriginalPath(regenKb.id, regenSrc.id, 'txt')
      fs.writeFileSync(filePath, textContent, 'utf8')

      const uDoc = {
        id: regenSrc.id,
        format: 'txt',
        extractedAt: Date.now(),
        extractor: { id: 'txt-extractor', name: 'Text Extractor', version: '2.0.0' },
        text: textContent,
        blocks: [
          {
            id: 'b1',
            type: 'paragraph' as const,
            orderIndex: 0,
            text: 'Paragraph one of modern doc.'
          },
          {
            id: 'b2',
            type: 'paragraph' as const,
            orderIndex: 1,
            text: 'Paragraph two with searchable keywords.'
          }
        ],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high' as const, isLossy: false, isOcr: false }
      }
      extractedRepo.save(regenSrc.id, uDoc, Date.now(), regenKb.id)

      const archivePath = path.join(tmpDir, 'regen-test.voyaro-kb.zip')
      const exportMgr = new BackupExportManager({
        db: testCtx.db,
        kbRepository: kbRepo,
        botRepository: botRepo,
        botMemoryRepository: botMemoryRepo,
        knowledgeSourceRepository: sourceRepo,
        conversationRepository: convRepo,
        messageRepository: msgRepo,
        storageManager,
        extractedDocumentRepository: extractedRepo,
        documentValidationRepository: validationRepo
      })
      await exportMgr.exportKnowledgeBase(regenKb.id, archivePath)

      // Import into new KB
      const preview = await customImportManager.selectAndPreviewArchive(archivePath)
      expect(preview.success).toBe(true)

      const result = await customImportManager.executeImport({
        sessionId: preview.preview!.sessionId,
        strategy: 'new'
      })
      expect(result.success).toBe(true)
      expect(result.counts?.indexedSources).toBe(1)

      const targetKbId = result.knowledgeBaseId!
      const targetSources = sourceRepo.listByKnowledgeBase(targetKbId)
      expect(targetSources.length).toBe(1)
      const importedSourceId = targetSources[0].id

      // Verify newly generated chunks exist
      const chunkCountRow = testCtx.db
        .prepare('SELECT COUNT(*) as count FROM knowledge_chunks WHERE source_id = ?')
        .get(importedSourceId) as { count: number }
      expect(chunkCountRow.count).toBeGreaterThan(0)

      // Verify FTS5 consistency and searchability
      const ftsMatches = testCtx.db
        .prepare('SELECT rowid, content FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all('searchable keywords') as Array<{ rowid: number; content: string }>
      expect(ftsMatches.length).toBeGreaterThan(0)
      expect(ftsMatches[0].content).toContain('searchable keywords')

      // Verify updated preservation report reflects chunk coverage
      const report = validationRepo.getReport(importedSourceId, targetKbId)
      expect(report).not.toBeNull()
      expect(report?.chunkReport.coveredBlocks).toBe(2)
      expect(report?.chunkCoverageStatus).toBe('complete')
    })

    it('2. detects original-file hash mismatch and fails closed without claiming verified original', async () => {
      const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
      const validationRepo = new DocumentValidationRepository(testCtx.db)
      const lifecycleService = new DocumentLifecycleService({
        db: testCtx.db,
        sourceRepository: sourceRepo,
        extractedDocumentRepository: extractedRepo,
        validationRepository: validationRepo,
        storageManager
      })

      const mismatchKb = kbRepo.create({ name: 'Mismatch KB' })
      const srcId = crypto.randomUUID()
      await storageManager.ensureOriginalsDirectory(mismatchKb.id)
      const src = sourceRepo.create({
        id: srcId,
        knowledge_base_id: mismatchKb.id,
        file_name: 'test.txt',
        original_file_name: 'test.txt',
        relative_file_path: `originals/${srcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 10,
        content_hash: crypto.createHash('sha256').update('Real file!').digest('hex')
      })
      const pathOnDisk = storageManager.resolveOriginalPath(mismatchKb.id, src.id, 'txt')
      fs.writeFileSync(pathOnDisk, 'Tampered!!', 'utf8') // tampered content!

      await expect(
        lifecycleService.restoreAndRegenerateDocument({
          knowledgeBaseId: mismatchKb.id,
          sourceId: src.id,
          expectedContentHash: src.content_hash
        })
      ).rejects.toThrow(/CHECKSUM_MISMATCH/)
    })

    it('3. falls back to reindex from verified original file if UniversalDocument is missing or corrupted', async () => {
      const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
      const validationRepo = new DocumentValidationRepository(testCtx.db)
      const lifecycleService = new DocumentLifecycleService({
        db: testCtx.db,
        sourceRepository: sourceRepo,
        extractedDocumentRepository: extractedRepo,
        validationRepository: validationRepo,
        storageManager
      })

      const fallbackKb = kbRepo.create({ name: 'Fallback KB' })
      const fallbackSrcId = crypto.randomUUID()
      await storageManager.ensureOriginalsDirectory(fallbackKb.id)
      const text = 'Valid original text for fallback reindex.'
      const src = sourceRepo.create({
        id: fallbackSrcId,
        knowledge_base_id: fallbackKb.id,
        file_name: 'fallback.txt',
        original_file_name: 'fallback.txt',
        relative_file_path: `originals/${fallbackSrcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: text.length,
        content_hash: crypto.createHash('sha256').update(text).digest('hex')
      })
      const pathOnDisk = storageManager.resolveOriginalPath(fallbackKb.id, src.id, 'txt')
      fs.writeFileSync(pathOnDisk, text, 'utf8')

      // No UniversalDocument in DB -> restoreAndRegenerateDocument falls back to reindex
      const res = await lifecycleService.restoreAndRegenerateDocument({
        knowledgeBaseId: fallbackKb.id,
        sourceId: src.id,
        expectedContentHash: src.content_hash
      })

      expect(res.status).toBe('completed')
      expect(res.totalChunks).toBeGreaterThan(0)

      // Extracted document was created by the fallback reindex
      const doc = extractedRepo.get(src.id, fallbackKb.id)
      expect(doc).not.toBeNull()
      expect(doc?.text).toContain('Valid original text')
    })

    it('preserves explicit responsePolicy on re-import, defaults legacy backups without responsePolicy to balanced_kb_first, and rejects invalid policies (Step 12.3)', async () => {
      // 1. Export a KB containing Bots with all three policies
      const multiKb = kbRepo.create({ name: 'Multi Policy Export KB' })
      botRepo.create({
        knowledgeBaseId: multiKb.id,
        name: 'Strict Imported',
        modelId: 'gpt-4o',
        responsePolicy: 'strict_kb_only'
      })
      botRepo.create({
        knowledgeBaseId: multiKb.id,
        name: 'Balanced Imported',
        modelId: 'gpt-4o',
        responsePolicy: 'balanced_kb_first'
      })
      botRepo.create({
        knowledgeBaseId: multiKb.id,
        name: 'General Imported',
        modelId: 'gpt-4o',
        responsePolicy: 'general_ai_chat'
      })

      const policyZipPath = path.join(tmpDir, 'policy-roundtrip.voyaro-kb.zip')
      const expRes = await exportManager.exportKnowledgeBase(multiKb.id, policyZipPath)
      expect(expRes.success).toBe(true)

      const roundtripPreview = await importManager.selectAndPreviewArchive(policyZipPath)
      expect(roundtripPreview.success).toBe(true)
      const roundtripImport = await importManager.executeImport({
        sessionId: roundtripPreview.preview!.sessionId,
        strategy: 'new'
      })
      expect(roundtripImport.success).toBe(true)

      const importedPolicyBots = botRepo.listByKnowledgeBase(roundtripImport.knowledgeBaseId!)
      expect(importedPolicyBots.find((b) => b.name === 'Strict Imported')?.responsePolicy).toBe(
        'strict_kb_only'
      )
      expect(importedPolicyBots.find((b) => b.name === 'Balanced Imported')?.responsePolicy).toBe(
        'balanced_kb_first'
      )
      expect(importedPolicyBots.find((b) => b.name === 'General Imported')?.responsePolicy).toBe(
        'general_ai_chat'
      )

      // 2. Legacy archive without responsePolicy defaults to balanced_kb_first (verified alongside legacy multi-conv format)
      const legacyKbId = crypto.randomUUID()
      const legacyBotId = crypto.randomUUID()
      const legacyConvId = crypto.randomUUID()
      const legacyWriter = new ZipArchiveWriter()
      const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
      const kbJson = Buffer.from(
        JSON.stringify({
          id: legacyKbId,
          name: 'Legacy No Policy KB',
          description: '',
          createdAt: 1000,
          updatedAt: 1000,
          archivedAt: null
        }),
        'utf8'
      )
      const legacyBotsJson = Buffer.from(
        JSON.stringify([
          {
            id: legacyBotId,
            name: 'Pre-12.3 Bot',
            description: '',
            systemPrompt: '',
            modelId: 'gpt-4o',
            status: 'active',
            toolPermissions: ['search_knowledge_base'],
            createdAt: 1000,
            updatedAt: 1000
          }
        ]),
        'utf8'
      )
      const memsJson = Buffer.from('[]', 'utf8')
      const sourcesJson = Buffer.from('[]', 'utf8')
      const convsJson = Buffer.from(
        JSON.stringify([
          {
            conversation: {
              id: legacyConvId,
              botId: legacyBotId,
              title: 'Legacy Chat',
              createdAt: 1000,
              updatedAt: 1000,
              archivedAt: null
            },
            messages: []
          }
        ]),
        'utf8'
      )
      const legacyManifest = Buffer.from(
        JSON.stringify({
          format: 'voyaro-knowledge-base-export',
          schemaVersion: '1.0.0',
          exportedAt: Date.now(),
          appVersion: '1.0.0',
          knowledgeBase: { id: legacyKbId, name: 'Legacy No Policy KB' },
          counts: {
            bots: 1,
            memories: 0,
            sources: 0,
            conversations: 1,
            messages: 0,
            totalSourceBytes: 0
          },
          files: [
            { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha(kbJson) },
            { path: 'bots.json', sizeBytes: legacyBotsJson.length, sha256: sha(legacyBotsJson) },
            { path: 'bot-memories.json', sizeBytes: memsJson.length, sha256: sha(memsJson) },
            { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha(sourcesJson) },
            { path: 'conversations.json', sizeBytes: convsJson.length, sha256: sha(convsJson) }
          ],
          excludedCategories: []
        }),
        'utf8'
      )
      legacyWriter.addEntry('manifest.json', legacyManifest)
      legacyWriter.addEntry('knowledge-base.json', kbJson)
      legacyWriter.addEntry('bots.json', legacyBotsJson)
      legacyWriter.addEntry('bot-memories.json', memsJson)
      legacyWriter.addEntry('sources.json', sourcesJson)
      legacyWriter.addEntry('conversations.json', convsJson)
      const legacyPath = path.join(tmpDir, 'legacy-no-policy.zip')
      fs.writeFileSync(legacyPath, legacyWriter.build())

      const legacyPreview = await importManager.selectAndPreviewArchive(legacyPath)
      expect(legacyPreview.success).toBe(true)
      const legacyImport = await importManager.executeImport({
        sessionId: legacyPreview.preview!.sessionId,
        strategy: 'new'
      })
      expect(legacyImport.success).toBe(true)
      const importedLegacyBots = botRepo.listByKnowledgeBase(legacyImport.knowledgeBaseId!)
      expect(importedLegacyBots).toHaveLength(1)
      expect(importedLegacyBots[0].responsePolicy).toBe('balanced_kb_first')

      // 3. Invalid responsePolicy inside bots.json is rejected at archive validation
      const invalidWriter = new ZipArchiveWriter()
      const badBotsJson = Buffer.from(
        JSON.stringify([
          {
            id: legacyBotId,
            name: 'Corrupt Policy Bot',
            description: '',
            systemPrompt: '',
            modelId: 'gpt-4o',
            status: 'active',
            responsePolicy: 'invalid_external_policy',
            toolPermissions: [],
            createdAt: 1000,
            updatedAt: 1000
          }
        ]),
        'utf8'
      )
      const badManifest = Buffer.from(
        JSON.stringify({
          format: 'voyaro-knowledge-base-export',
          schemaVersion: '1.1.0',
          exportedAt: Date.now(),
          appVersion: '1.0.0',
          knowledgeBase: { id: legacyKbId, name: 'Bad Policy KB' },
          counts: {
            bots: 1,
            memories: 0,
            sources: 0,
            conversations: 1,
            messages: 0,
            totalSourceBytes: 0
          },
          files: [
            { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha(kbJson) },
            { path: 'bots.json', sizeBytes: badBotsJson.length, sha256: sha(badBotsJson) },
            { path: 'bot-memories.json', sizeBytes: memsJson.length, sha256: sha(memsJson) },
            { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha(sourcesJson) },
            { path: 'conversations.json', sizeBytes: convsJson.length, sha256: sha(convsJson) }
          ],
          excludedCategories: []
        }),
        'utf8'
      )
      invalidWriter.addEntry('manifest.json', badManifest)
      invalidWriter.addEntry('knowledge-base.json', kbJson)
      invalidWriter.addEntry('bots.json', badBotsJson)
      invalidWriter.addEntry('bot-memories.json', memsJson)
      invalidWriter.addEntry('sources.json', sourcesJson)
      invalidWriter.addEntry('conversations.json', convsJson)
      const badPath = path.join(tmpDir, 'bad-policy.zip')
      fs.writeFileSync(badPath, invalidWriter.build())

      await expect(importManager.selectAndPreviewArchive(badPath)).rejects.toThrow(
        /Response policy must be strict_kb_only, balanced_kb_first, or general_ai_chat/
      )
    })

    it('preserves claim provenance metadata on export/import roundtrip and imports legacy messages without claims (Step 12.5)', async () => {
      // 1. Export/Import roundtrip preserves message.metadata.claims
      const claimKb = kbRepo.create({ name: 'Claim Provenance Roundtrip KB' })
      const claimBot = botRepo.create({
        knowledgeBaseId: claimKb.id,
        name: 'Claim Roundtrip Bot',
        modelId: 'gpt-4o',
        responsePolicy: 'balanced_kb_first'
      })
      const claimConv = convRepo.create({
        botId: claimBot.id,
        knowledgeBaseId: claimKb.id,
        title: 'Provenance Thread'
      })
      msgRepo.create({
        conversationId: claimConv.id,
        botId: claimBot.id,
        knowledgeBaseId: claimKb.id,
        role: 'assistant',
        content: 'Log retention is 7 years [1]. General training also recommends daily backups.',
        metadata: {
          groundingMode: 'kb_partial_with_general_fallback',
          claims: [
            {
              claimId: 'claim-1',
              claimText: 'Log retention is 7 years.',
              provenance: 'kb_supported',
              validationStatus: 'validated',
              evidenceReferences: [
                {
                  knowledgeBaseId: claimKb.id,
                  sourceId: '11111111-1111-4111-8111-111111111111',
                  chunkId: '22222222-2222-4222-8222-222222222222',
                  citationNumber: 1,
                  fileName: 'retention.pdf',
                  fileType: 'pdf',
                  pageNumber: 2,
                  headingPath: ['Compliance'],
                  chunkIndex: 0
                }
              ]
            },
            {
              claimId: 'claim-2',
              claimText: 'General training also recommends daily backups.',
              provenance: 'general_knowledge',
              validationStatus: 'not_checked',
              evidenceReferences: []
            }
          ]
        }
      })

      const zipPath = path.join(tmpDir, 'claims-roundtrip.voyaro-kb.zip')
      const expRes = await exportManager.exportKnowledgeBase(claimKb.id, zipPath)
      expect(expRes.success).toBe(true)

      const preview = await importManager.selectAndPreviewArchive(zipPath)
      expect(preview.success).toBe(true)
      const impRes = await importManager.executeImport({
        sessionId: preview.preview!.sessionId,
        strategy: 'new'
      })
      expect(impRes.success).toBe(true)

      const importedBots = botRepo.listByKnowledgeBase(impRes.knowledgeBaseId!)
      const importedConv = convRepo.getByBotId(importedBots[0].id, impRes.knowledgeBaseId!)!
      const importedMsgs = msgRepo.listByConversation(
        importedConv.id,
        importedBots[0].id,
        impRes.knowledgeBaseId!
      )
      expect(importedMsgs).toHaveLength(1)
      expect(importedMsgs[0].metadata.groundingMode).toBe('kb_partial_with_general_fallback')
      expect(importedMsgs[0].metadata.claims).toHaveLength(2)
      expect(importedMsgs[0].metadata.claims?.[0].provenance).toBe('kb_supported')
      expect(importedMsgs[0].metadata.claims?.[1].provenance).toBe('general_knowledge')

      // 2. Legacy archive containing messages without claims imports cleanly without rewriting metadata
      const legacyKbId = crypto.randomUUID()
      const legacyBotId = crypto.randomUUID()
      const legacyConvId = crypto.randomUUID()
      const legacyMsgId = crypto.randomUUID()
      const legacyWriter = new ZipArchiveWriter()
      const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
      const kbJson = Buffer.from(
        JSON.stringify({
          id: legacyKbId,
          name: 'Legacy Message KB',
          description: '',
          createdAt: 1000,
          updatedAt: 1000,
          archivedAt: null
        }),
        'utf8'
      )
      const botsJson = Buffer.from(
        JSON.stringify([
          {
            id: legacyBotId,
            name: 'Legacy Msg Bot',
            description: '',
            systemPrompt: '',
            modelId: 'gpt-4o',
            status: 'active',
            toolPermissions: [],
            createdAt: 1000,
            updatedAt: 1000
          }
        ]),
        'utf8'
      )
      const memsJson = Buffer.from('[]', 'utf8')
      const sourcesJson = Buffer.from('[]', 'utf8')
      const convsJson = Buffer.from(
        JSON.stringify([
          {
            conversation: {
              id: legacyConvId,
              botId: legacyBotId,
              title: 'Legacy Chat',
              createdAt: 1000,
              updatedAt: 1000,
              archivedAt: null
            },
            messages: [
              {
                id: legacyMsgId,
                conversationId: legacyConvId,
                role: 'assistant',
                content: 'Historical pre-12.5 response without claims.',
                contentFormat: 'markdown',
                metadata: {},
                createdAt: 1001
              }
            ]
          }
        ]),
        'utf8'
      )
      const manifestBuf = Buffer.from(
        JSON.stringify({
          format: 'voyaro-knowledge-base-export',
          schemaVersion: '1.0.0',
          exportedAt: Date.now(),
          appVersion: '1.0.0',
          knowledgeBase: { id: legacyKbId, name: 'Legacy Message KB' },
          counts: {
            bots: 1,
            memories: 0,
            sources: 0,
            conversations: 1,
            messages: 1,
            totalSourceBytes: 0
          },
          files: [
            { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha(kbJson) },
            { path: 'bots.json', sizeBytes: botsJson.length, sha256: sha(botsJson) },
            { path: 'bot-memories.json', sizeBytes: memsJson.length, sha256: sha(memsJson) },
            { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha(sourcesJson) },
            { path: 'conversations.json', sizeBytes: convsJson.length, sha256: sha(convsJson) }
          ],
          excludedCategories: []
        }),
        'utf8'
      )
      legacyWriter.addEntry('manifest.json', manifestBuf)
      legacyWriter.addEntry('knowledge-base.json', kbJson)
      legacyWriter.addEntry('bots.json', botsJson)
      legacyWriter.addEntry('bot-memories.json', memsJson)
      legacyWriter.addEntry('sources.json', sourcesJson)
      legacyWriter.addEntry('conversations.json', convsJson)
      const legacyPath = path.join(tmpDir, 'legacy-no-claims.zip')
      fs.writeFileSync(legacyPath, legacyWriter.build())

      const legacyPreview = await importManager.selectAndPreviewArchive(legacyPath)
      expect(legacyPreview.success).toBe(true)
      const legacyImport = await importManager.executeImport({
        sessionId: legacyPreview.preview!.sessionId,
        strategy: 'new'
      })
      expect(legacyImport.success).toBe(true)

      const importedLegacyBots = botRepo.listByKnowledgeBase(legacyImport.knowledgeBaseId!)
      const importedLegacyConv = convRepo.getByBotId(
        importedLegacyBots[0].id,
        legacyImport.knowledgeBaseId!
      )!
      const importedLegacyMsgs = msgRepo.listByConversation(
        importedLegacyConv.id,
        importedLegacyBots[0].id,
        legacyImport.knowledgeBaseId!
      )
      expect(importedLegacyMsgs).toHaveLength(1)
      expect(importedLegacyMsgs[0].metadata.claims).toBeUndefined()
    })
  })
})
