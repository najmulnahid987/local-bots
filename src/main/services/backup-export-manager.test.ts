import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import unzipper from 'unzipper'
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
import { BackupExportManager } from './backup-export-manager'
import {
  EXPORT_ARCHIVE_FORMAT,
  EXPORT_ARCHIVE_SCHEMA_VERSION,
  exportManifestDtoSchema
} from '../../shared/export-archive'

describe('BackupExportManager', () => {
  let testCtx: MigratedTestDatabaseContext
  let tmpDir: string
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let botMemoryRepo: BotMemoryRepository
  let sourceRepo: KnowledgeSourceRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let storageManager: DocumentStorageManager

  beforeEach(async () => {
    testCtx = createMigratedTestDatabase()
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'export-mgr-test-'))

    kbRepo = new KnowledgeBaseRepository(testCtx.db)
    botRepo = new BotRepository(testCtx.db)
    botMemoryRepo = new BotMemoryRepository(testCtx.db)
    sourceRepo = new KnowledgeSourceRepository(testCtx.db)
    convRepo = new ConversationRepository(testCtx.db)
    msgRepo = new MessageRepository(testCtx.db)
    storageManager = new DocumentStorageManager({ userDataPath: tmpDir })
  })

  afterEach(async () => {
    testCtx.cleanup()
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('successfully exports a complete Knowledge Base into a verified ZIP archive', async () => {
    // 1. Create Knowledge Base A
    const kbA = kbRepo.create({
      name: 'Alpha Research KB',
      description: 'Alpha research workspace'
    })

    // 2. Create Bot in KB A
    const botA = botRepo.create({
      knowledgeBaseId: kbA.id,
      name: 'Alpha Bot',
      description: 'Bot for alpha research',
      modelId: 'gpt-4o',
      systemPrompt: 'You are an alpha researcher.',
      toolPermissions: ['search_knowledge_base']
    })

    // 3. Create Bot Memory in KB A
    const mem1 = botMemoryRepo.create({
      botId: botA.id,
      knowledgeBaseId: kbA.id,
      memoryType: 'pinned_instruction',
      content: 'Always format citations in APA style.'
    })
    const mem2 = botMemoryRepo.create({
      botId: botA.id,
      knowledgeBaseId: kbA.id,
      memoryType: 'user_note',
      content: 'User prefers concise summaries.'
    })

    // 4. Create Document in KB A and write original file to disk
    const docSourceId = crypto.randomUUID()
    const docContent = 'This is an authentic research document content.'
    const docHash = crypto.createHash('sha256').update(docContent).digest('hex')
    const originalPath = storageManager.resolveOriginalPath(kbA.id, docSourceId, 'txt')
    await fs.promises.mkdir(path.dirname(originalPath), { recursive: true })
    await fs.promises.writeFile(originalPath, docContent, 'utf8')

    sourceRepo.create({
      id: docSourceId,
      knowledge_base_id: kbA.id,
      file_name: `${docSourceId}.txt`,
      original_file_name: 'alpha-paper.txt',
      relative_file_path: `documents/${kbA.id}/originals/${docSourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: Buffer.byteLength(docContent),
      content_hash: docHash,
      indexing_status: 'completed'
    })

    // 5. Create Conversation and Message in KB A
    const conv = convRepo.create({
      botId: botA.id,
      knowledgeBaseId: kbA.id,
      title: 'Initial Discussion'
    })
    msgRepo.create({
      conversationId: conv.id,
      botId: botA.id,
      knowledgeBaseId: kbA.id,
      role: 'user',
      content: 'What is the main finding?',
      contentFormat: 'text'
    })
    msgRepo.create({
      conversationId: conv.id,
      botId: botA.id,
      knowledgeBaseId: kbA.id,
      role: 'assistant',
      content: 'The main finding is verified in alpha paper.',
      contentFormat: 'markdown'
    })

    // 6. Also create Knowledge Base B to verify Cross-KB isolation
    const kbB = kbRepo.create({ name: 'Beta KB', description: 'Unrelated Beta KB' })
    const botB = botRepo.create({
      knowledgeBaseId: kbB.id,
      name: 'Beta Bot',
      modelId: 'claude-3-5-sonnet',
      systemPrompt: 'Beta only.'
    })
    botMemoryRepo.create({
      botId: botB.id,
      knowledgeBaseId: kbB.id,
      memoryType: 'user_note',
      content: 'Beta secret note that should NEVER appear in Alpha export.'
    })

    // Instantiate Export Manager
    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      appVersion: '2.0.0'
    })

    const exportOutPath = path.join(tmpDir, 'alpha-export.voyaro-kb.zip')
    const result = await exportManager.exportKnowledgeBase(kbA.id, exportOutPath)

    expect(result.success).toBe(true)
    expect(result.knowledgeBaseId).toBe(kbA.id)
    expect(result.archivePath).toBe(exportOutPath)
    expect(result.archiveSizeBytes).toBeGreaterThan(0)
    expect(result.counts).toEqual({
      bots: 1,
      memories: 2,
      sources: 1,
      conversations: 1,
      segments: 1,
      messages: 2,
      agentRuns: 0,
      toolEvents: 0,
      totalSourceBytes: Buffer.byteLength(docContent)
    })

    // Inspect the generated ZIP archive with unzipper
    const zipArchive = await unzipper.Open.file(exportOutPath)
    const filePaths = zipArchive.files.map((f) => f.path)

    expect(filePaths).toContain('manifest.json')
    expect(filePaths).toContain('knowledge-base.json')
    expect(filePaths).toContain('bots.json')
    expect(filePaths).toContain('bot-memories.json')
    expect(filePaths).toContain('sources.json')
    expect(filePaths).toContain('conversations.json')
    expect(filePaths).toContain(`documents/${docSourceId}.txt`)

    // Verify manifest
    const manifestFile = zipArchive.files.find((f) => f.path === 'manifest.json')!
    const manifestJson = JSON.parse((await manifestFile.buffer()).toString('utf8'))
    const manifestValidation = exportManifestDtoSchema.safeParse(manifestJson)
    expect(manifestValidation.success).toBe(true)
    expect(manifestJson.format).toBe(EXPORT_ARCHIVE_FORMAT)
    expect(manifestJson.schemaVersion).toBe(EXPORT_ARCHIVE_SCHEMA_VERSION)
    expect(manifestJson.appVersion).toBe('2.0.0')
    expect(manifestJson.knowledgeBase.name).toBe('Alpha Research KB')

    // Verify knowledge-base.json does NOT contain storage_path
    const kbFile = zipArchive.files.find((f) => f.path === 'knowledge-base.json')!
    const kbJson = JSON.parse((await kbFile.buffer()).toString('utf8'))
    expect(kbJson.id).toBe(kbA.id)
    expect(kbJson.name).toBe('Alpha Research KB')
    expect(kbJson).not.toHaveProperty('storage_path')

    // Verify bots.json does NOT contain credentials or provider_connection_id
    const botsFile = zipArchive.files.find((f) => f.path === 'bots.json')!
    const botsJson = JSON.parse((await botsFile.buffer()).toString('utf8'))
    expect(botsJson.length).toBe(1)
    expect(botsJson[0].id).toBe(botA.id)
    expect(botsJson[0].name).toBe('Alpha Bot')
    expect(botsJson[0]).not.toHaveProperty('providerConnectionId')
    expect(botsJson[0]).not.toHaveProperty('provider_connection_id')

    // Verify bot-memories.json
    const memFile = zipArchive.files.find((f) => f.path === 'bot-memories.json')!
    const memJson = JSON.parse((await memFile.buffer()).toString('utf8'))
    expect(memJson.length).toBe(2)
    const memIds = memJson.map((m: { id: string }) => m.id)
    expect(memIds).toContain(mem1.id)
    expect(memIds).toContain(mem2.id)

    // Cross-KB check: ensure Beta note is NOT anywhere in the archive
    for (const f of zipArchive.files) {
      const content = (await f.buffer()).toString('utf8')
      expect(content).not.toContain('Beta secret note')
      expect(content).not.toContain(botB.id)
      expect(content).not.toContain(kbB.id)
    }

    // Verify document content matches
    const docFile = zipArchive.files.find((f) => f.path === `documents/${docSourceId}.txt`)!
    expect((await docFile.buffer()).toString('utf8')).toBe(docContent)
  })

  it('fails gracefully when a source file is missing from disk', async () => {
    const kb = kbRepo.create({ name: 'Missing Doc KB' })
    const missingSourceId = crypto.randomUUID()
    sourceRepo.create({
      id: missingSourceId,
      knowledge_base_id: kb.id,
      file_name: `${missingSourceId}.txt`,
      original_file_name: 'missing.txt',
      relative_file_path: `documents/${kb.id}/originals/${missingSourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 100,
      content_hash: 'a'.repeat(64),
      indexing_status: 'completed'
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager
    })

    const result = await exportManager.exportKnowledgeBase(kb.id, path.join(tmpDir, 'missing.zip'))
    expect(result.success).toBe(false)
    expect(result.code).toBe('DOCUMENT_FILE_MISSING')
    expect(result.error).toContain('missing.txt')
  })

  it('fails gracefully when document content hash does not match stored hash', async () => {
    const kb = kbRepo.create({ name: 'Tampered Doc KB' })
    const sourceId = crypto.randomUUID()
    const filePath = storageManager.resolveOriginalPath(kb.id, sourceId, 'txt')
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, 'tampered content', 'utf8')

    sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kb.id,
      file_name: `${sourceId}.txt`,
      original_file_name: 'tampered.txt',
      relative_file_path: `documents/${kb.id}/originals/${sourceId}.txt`,
      file_type: 'txt',
      mime_type: 'text/plain',
      file_size: 16,
      content_hash: 'f'.repeat(64), // Mismatched hash
      indexing_status: 'completed'
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager
    })

    const result = await exportManager.exportKnowledgeBase(kb.id, path.join(tmpDir, 'tampered.zip'))
    expect(result.success).toBe(false)
    expect(result.code).toBe('DOCUMENT_HASH_MISMATCH')
  })

  it('aborts export if secret scanner detects credential in user message or memory', async () => {
    const kb = kbRepo.create({ name: 'Secret Leak KB' })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Leaky Bot',
      modelId: 'gpt-4o',
      systemPrompt: 'Leaky prompt'
    })
    botMemoryRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      memoryType: 'user_note',
      content: 'Here is my OpenAI key sk-proj-1234567890abcdef1234567890'
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager
    })

    const result = await exportManager.exportKnowledgeBase(kb.id, path.join(tmpDir, 'leaky.zip'))
    expect(result.success).toBe(false)
    expect(result.code).toBe('CREDENTIAL_LEAK_PREVENTED')
    expect(result.error).toContain('high-confidence credential detected')
    // Ensure destination archive was NOT created
    expect(fs.existsSync(path.join(tmpDir, 'leaky.zip'))).toBe(false)
  })

  it('handles user cancellation in native save dialog', async () => {
    const kb = kbRepo.create({ name: 'Cancel KB' })
    const mockShowSaveDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePath: undefined
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      showSaveDialog: mockShowSaveDialog
    })

    const result = await exportManager.exportKnowledgeBase(kb.id)
    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(mockShowSaveDialog).toHaveBeenCalled()
  })

  it('bundles canonical UniversalDocument and DocumentPreservationReport with verified hashes in manifest', async () => {
    const kb = kbRepo.create({ name: 'Preserved KB' })
    const sourceId = crypto.randomUUID()
    const docContent = 'Document markdown body'
    const docHash = crypto.createHash('sha256').update(docContent).digest('hex')

    const originalFilePath = storageManager.resolveOriginalPath(kb.id, sourceId, 'md')
    await fs.promises.mkdir(path.dirname(originalFilePath), { recursive: true })
    await fs.promises.writeFile(originalFilePath, docContent, 'utf8')

    const source = sourceRepo.create({
      id: sourceId,
      knowledge_base_id: kb.id,
      file_name: `${sourceId}.md`,
      original_file_name: 'doc.md',
      relative_file_path: `documents/${kb.id}/originals/${sourceId}.md`,
      file_type: 'md',
      mime_type: 'text/markdown',
      file_size: Buffer.byteLength(docContent),
      content_hash: docHash,
      indexing_status: 'completed'
    })

    // Persist canonical UniversalDocument
    const extractedRepo = new ExtractedDocumentRepository(testCtx.db)
    extractedRepo.save(
      source.id,
      {
        id: source.id,
        format: 'md',
        extractedAt: Date.now(),
        extractor: { id: 'md-ext', name: 'MD Extractor', version: '2.0.0' },
        text: 'Document markdown body',
        blocks: [
          {
            id: 'b1',
            type: 'paragraph',
            orderIndex: 0,
            text: 'Document markdown body'
          }
        ],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'high', isLossy: false, isOcr: false }
      },
      Date.now(),
      kb.id
    )

    // Persist DocumentPreservationReport
    const validationRepo = new DocumentValidationRepository(testCtx.db)
    validationRepo.saveReport(
      source.id,
      {
        schemaVersion: '1.0.0',
        sourceId: source.id,
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
          totalElements: 1,
          elementCountsByType: { paragraph: 1 },
          dispositionCounts: {
            fully_extracted: 1,
            text_preserved_unparsed: 0,
            reference_only: 0,
            partially_extracted: 0,
            unsupported: 0,
            failed: 0,
            unknown: 0
          },
          textualCoverage: {
            expectedChars: 22,
            extractedChars: 22,
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
          totalBlocks: 1,
          coveredBlocks: 1,
          missingBlockIds: [],
          nonSearchableBlocks: [],
          primaryCharacterCoverage: {
            expectedChars: 22,
            coveredChars: 22,
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
      kb.id
    )

    const exportOutPath = path.join(tmpDir, 'preserved-export.voyaro-kb.zip')
    const exportManager = new BackupExportManager({
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

    const result = await exportManager.exportKnowledgeBase(kb.id, exportOutPath)
    expect(result.success).toBe(true)
    expect(result.counts?.extractedDocuments).toBe(1)
    expect(result.counts?.preservationReports).toBe(1)

    // Verify ZIP archive entries
    const zipArchive = await unzipper.Open.file(exportOutPath)
    const fileNames = zipArchive.files.map((f) => f.path)
    expect(fileNames).toContain(`extracted-documents/${source.id}.json`)
    expect(fileNames).toContain(`preservation-reports/${source.id}.json`)

    // Verify manifest
    const manifestFile = zipArchive.files.find((f) => f.path === 'manifest.json')!
    const manifestJson = JSON.parse((await manifestFile.buffer()).toString('utf8'))
    expect(manifestJson.counts.extractedDocuments).toBe(1)
    expect(manifestJson.counts.preservationReports).toBe(1)

    const declaredExtracted = manifestJson.files.find(
      (f: { path: string }) => f.path === `extracted-documents/${source.id}.json`
    )
    expect(declaredExtracted).toBeDefined()
    expect(declaredExtracted.sha256).toMatch(/^[0-9a-f]{64}$/i)

    const declaredReport = manifestJson.files.find(
      (f: { path: string }) => f.path === `preservation-reports/${source.id}.json`
    )
    expect(declaredReport).toBeDefined()
    expect(declaredReport.sha256).toMatch(/^[0-9a-f]{64}$/i)
  })

  it('serializes configured Bot responsePolicy accurately in bots.json (Step 12.3)', async () => {
    const kbRepo = new KnowledgeBaseRepository(testCtx.db)
    const botRepo = new BotRepository(testCtx.db)
    const botMemoryRepo = new BotMemoryRepository(testCtx.db)
    const sourceRepo = new KnowledgeSourceRepository(testCtx.db)
    const convRepo = new ConversationRepository(testCtx.db)
    const msgRepo = new MessageRepository(testCtx.db)

    const kb = kbRepo.create({ name: 'Policy Export KB' })
    const strictBot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Strict Bot',
      modelId: 'gpt-4o',
      responsePolicy: 'strict_kb_only'
    })
    const balancedBot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Balanced Bot',
      modelId: 'gpt-4o',
      responsePolicy: 'balanced_kb_first'
    })
    const generalBot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'General Bot',
      modelId: 'gpt-4o',
      responsePolicy: 'general_ai_chat'
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      appVersion: '2.0.0'
    })

    const outPath = path.join(tmpDir, 'policy-export.voyaro-kb.zip')
    const res = await exportManager.exportKnowledgeBase(kb.id, outPath)
    expect(res.success).toBe(true)

    const zipArchive = await unzipper.Open.file(outPath)
    const botsFile = zipArchive.files.find((f) => f.path === 'bots.json')!
    const botsJson = JSON.parse((await botsFile.buffer()).toString('utf8')) as Array<{
      id: string
      responsePolicy?: string
    }>

    expect(botsJson.find((b) => b.id === strictBot.id)?.responsePolicy).toBe('strict_kb_only')
    expect(botsJson.find((b) => b.id === balancedBot.id)?.responsePolicy).toBe('balanced_kb_first')
    expect(botsJson.find((b) => b.id === generalBot.id)?.responsePolicy).toBe('general_ai_chat')
  })

  it('Step 12.5: exports message claim-level provenance metadata cleanly alongside citations', async () => {
    const kb = kbRepo.create({ name: 'Claim Export KB' })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Claim Export Bot',
      modelId: 'gpt-4o',
      responsePolicy: 'balanced_kb_first'
    })
    const conv = convRepo.create({
      botId: bot.id,
      knowledgeBaseId: kb.id,
      title: 'Canonical Thread'
    })
    msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kb.id,
      role: 'assistant',
      content: 'Session timeout is 30 seconds [1].',
      metadata: {
        groundingMode: 'kb_grounded',
        claims: [
          {
            claimId: 'claim-1',
            claimText: 'Session timeout is 30 seconds.',
            provenance: 'kb_supported',
            validationStatus: 'validated',
            evidenceReferences: [
              {
                knowledgeBaseId: kb.id,
                sourceId: '11111111-1111-4111-8111-111111111111',
                chunkId: '22222222-2222-4222-8222-222222222222',
                citationNumber: 1,
                fileName: 'timeouts.md',
                fileType: 'md',
                pageNumber: null,
                headingPath: ['Timeouts'],
                chunkIndex: 0
              }
            ]
          }
        ]
      }
    })

    const exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      appVersion: '2.0.0'
    })

    const outPath = path.join(tmpDir, 'claims-export.voyaro-kb.zip')
    const res = await exportManager.exportKnowledgeBase(kb.id, outPath)
    expect(res.success).toBe(true)

    const zipArchive = await unzipper.Open.file(outPath)
    const convFile = zipArchive.files.find((f) => f.path === 'conversations.json')!
    const bundles = JSON.parse((await convFile.buffer()).toString('utf8')) as Array<{
      messages: Array<{ metadata?: { claims?: Array<{ provenance: string }> } }>
    }>
    expect(bundles[0].messages[0].metadata?.claims).toHaveLength(1)
    expect(bundles[0].messages[0].metadata?.claims?.[0].provenance).toBe('kb_supported')
  })
})
