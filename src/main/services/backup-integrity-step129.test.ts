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
import { AgentRunRepository } from '../database/repositories/agent-run-repository'
import { ToolEventRepository } from '../database/repositories/tool-event-repository'
import { ExtractedDocumentRepository } from '../database/repositories/extracted-document-repository'
import { DocumentValidationRepository } from '../database/repositories/document-validation-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import type { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import { BackupExportManager } from './backup-export-manager'
import { BackupImportManager } from './backup-import-manager'
import { ArchiveExtractor } from './archive-extractor'
import { ZipArchiveWriter, calculateCrc32 } from './zip-archive'
import { EXPORT_ARCHIVE_FORMAT } from '../../shared/export-archive'

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

describe('Step 12.9: Complete Backup, Export & Import Integrity', () => {
  let testCtx: MigratedTestDatabaseContext
  let tmpDir: string
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let botMemoryRepo: BotMemoryRepository
  let sourceRepo: KnowledgeSourceRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let agentRunRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository
  let extractedDocRepo: ExtractedDocumentRepository
  let validationRepo: DocumentValidationRepository
  let storageManager: DocumentStorageManager
  let exportManager: BackupExportManager
  let importManager: BackupImportManager
  let reindexMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    testCtx = createMigratedTestDatabase()
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'step129-backup-test-'))

    kbRepo = new KnowledgeBaseRepository(testCtx.db)
    botRepo = new BotRepository(testCtx.db)
    botMemoryRepo = new BotMemoryRepository(testCtx.db)
    sourceRepo = new KnowledgeSourceRepository(testCtx.db)
    convRepo = new ConversationRepository(testCtx.db)
    msgRepo = new MessageRepository(testCtx.db)
    agentRunRepo = new AgentRunRepository(testCtx.db)
    toolEventRepo = new ToolEventRepository(testCtx.db)
    extractedDocRepo = new ExtractedDocumentRepository(testCtx.db)
    validationRepo = new DocumentValidationRepository(testCtx.db)
    storageManager = new DocumentStorageManager({ userDataPath: tmpDir })

    reindexMock = vi.fn().mockResolvedValue({ success: true })
    const mockLifecycle = {
      reindex: reindexMock
    } as unknown as DocumentLifecycleService

    exportManager = new BackupExportManager({
      db: testCtx.db,
      kbRepository: kbRepo,
      botRepository: botRepo,
      botMemoryRepository: botMemoryRepo,
      knowledgeSourceRepository: sourceRepo,
      conversationRepository: convRepo,
      messageRepository: msgRepo,
      storageManager,
      extractedDocumentRepository: extractedDocRepo,
      documentValidationRepository: validationRepo
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
      documentLifecycleService: mockLifecycle,
      tempBaseDir: path.join(tmpDir, 'import-temp')
    })
  })

  afterEach(async () => {
    testCtx.cleanup()
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('roundtrips full workspace: KBs, Bots, policies, memories, files, segments, tokenUsage, citations, claims, and agent/tool audit history', async () => {
    const kb = kbRepo.create({
      name: 'Complete Workspace KB',
      description: 'Full fidelity backup test'
    })

    // Insert a provider connection so we can verify credentials are NEVER exported
    const connId = crypto.randomUUID()
    testCtx.db
      .prepare(
        `INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at)
         VALUES (?, 'openai', 'My Key', ?, 'active', ?, ?)`
      )
      .run(connId, `safeStorage:test:${connId}`, Date.now(), Date.now())

    const botStrict = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Strict Analyst',
      modelId: 'gpt-4o',
      systemPrompt: 'Strictly cite KB.',
      responsePolicy: 'strict_kb_only',
      providerConnectionId: connId,
      toolPermissions: ['search_knowledge_base', 'read_knowledge_source']
    })

    botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Balanced Assistant',
      modelId: 'claude-3-5-sonnet',
      systemPrompt: 'KB first.',
      responsePolicy: 'balanced_kb_first',
      toolPermissions: ['search_knowledge_base']
    })

    botMemoryRepo.create({
      botId: botStrict.id,
      knowledgeBaseId: kb.id,
      memoryType: 'pinned_instruction',
      content: 'Always verify dates.'
    })

    // Ready document with original file
    const readySourceId = crypto.randomUUID()
    const readyContent = 'Original PDF-equivalent binary content \x00\x01\x02'
    const readyHash = sha256(readyContent)
    const readyPath = storageManager.resolveOriginalPath(kb.id, readySourceId, 'txt')
    await fs.promises.mkdir(path.dirname(readyPath), { recursive: true })
    await fs.promises.writeFile(readyPath, readyContent, 'utf8')
    testCtx.db
      .prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          error_message, created_at, updated_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, 'txt', 'text/plain', ?, ?, 'completed', NULL, ?, ?, ?)`
      )
      .run(
        readySourceId,
        kb.id,
        'policy.txt',
        'policy.txt',
        `originals/${readySourceId}.txt`,
        Buffer.byteLength(readyContent),
        readyHash,
        Date.now(),
        Date.now(),
        Date.now()
      )

    // Failed document with error_message (must NOT be falsely reindexed or marked ready)
    const failedSourceId = crypto.randomUUID()
    const failedContent = 'Unparseable source bytes'
    const failedHash = sha256(failedContent)
    const failedPath = storageManager.resolveOriginalPath(kb.id, failedSourceId, 'txt')
    await fs.promises.writeFile(failedPath, failedContent, 'utf8')
    testCtx.db
      .prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          error_message, created_at, updated_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, 'txt', 'text/plain', ?, ?, 'failed', ?, ?, ?, NULL)`
      )
      .run(
        failedSourceId,
        kb.id,
        'broken.txt',
        'broken.txt',
        `originals/${failedSourceId}.txt`,
        Buffer.byteLength(failedContent),
        failedHash,
        'Corrupt file structure',
        Date.now(),
        Date.now()
      )

    // Canonical conversation + 2 historical segments
    const conv = convRepo.getOrCreate({ botId: botStrict.id, knowledgeBaseId: kb.id })
    const seg1Id = conv.id
    const seg2Id = crypto.randomUUID()
    const now = Date.now()
    testCtx.db
      .prepare(
        `INSERT INTO conversation_segments (
          id, conversation_id, original_conversation_id, title, segment_order,
          first_message_created_at, last_message_created_at, message_count, created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        seg2Id,
        conv.id,
        crypto.randomUUID(),
        'Archived Research Thread',
        1,
        now - 5000,
        now - 1000,
        1,
        now - 6000
      )

    // Agent run + tool event
    const run = agentRunRepo.create({
      botId: botStrict.id,
      conversationId: conv.id,
      selectedModel: 'gpt-4o',
      initialStatus: 'running'
    })
    const toolEv = toolEventRepo.create({
      agentRunId: run.id,
      toolName: 'search_knowledge_base',
      argumentsSummary: JSON.stringify({ query: 'retention policy' }),
      initialStatus: 'running'
    })
    toolEventRepo.markCompleted(toolEv.id, JSON.stringify({ matchCount: 1 }))
    agentRunRepo.updateIterationCount(run.id, 1)
    agentRunRepo.markCompleted(run.id)

    // Messages in seg1 and seg2 with tokenUsage, citations, claims, and agentRunId
    msgRepo.create({
      conversationId: conv.id,
      botId: botStrict.id,
      knowledgeBaseId: kb.id,
      segmentId: seg1Id,
      role: 'user',
      content: 'Summarize retention policy.',
      contentFormat: 'markdown'
    })

    msgRepo.create({
      conversationId: conv.id,
      botId: botStrict.id,
      knowledgeBaseId: kb.id,
      segmentId: seg2Id,
      role: 'assistant',
      content: 'Retention is 7 years [1].',
      contentFormat: 'markdown',
      tokenUsage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
      metadata: {
        executionMode: 'agent',
        agentRunId: run.id,
        citations: [
          {
            citationNumber: 1,
            sourceId: readySourceId,
            chunkId: crypto.randomUUID(),
            fileName: 'policy.txt',
            fileType: 'txt',
            pageNumber: null,
            headingPath: null,
            chunkIndex: 0
          }
        ],
        claims: [
          {
            claimId: 'claim-1',
            claimText: 'Retention is 7 years',
            provenance: 'kb_supported',
            validationStatus: 'validated',
            evidenceReferences: [
              {
                knowledgeBaseId: kb.id,
                sourceId: readySourceId,
                chunkId: crypto.randomUUID(),
                citationNumber: 1,
                fileName: 'policy.txt',
                fileType: 'txt',
                pageNumber: null,
                headingPath: null,
                chunkIndex: 0
              }
            ]
          }
        ]
      }
    })

    // Export
    const archivePath = path.join(tmpDir, 'full-backup.voyaro-kb.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, archivePath)
    expect(exportRes.success).toBe(true)
    expect(exportRes.counts?.agentRuns).toBe(1)
    expect(exportRes.counts?.toolEvents).toBe(1)
    expect(exportRes.counts?.segments).toBe(2)

    // Preview & Import as 'new'
    const previewRes = await importManager.selectAndPreviewArchive(archivePath)
    expect(previewRes.success).toBe(true)
    expect(previewRes.preview!.counts.agentRuns).toBe(1)
    expect(previewRes.preview!.counts.toolEvents).toBe(1)

    const importRes = await importManager.executeImport({
      sessionId: previewRes.preview!.sessionId,
      strategy: 'new'
    })
    expect(importRes.success).toBe(true)
    const restoredKbId = importRes.knowledgeBaseId!
    expect(restoredKbId).not.toBe(kb.id)

    // Verify Bots + responsePolicies + zero credential leakage
    const restoredBots = botRepo.listByKnowledgeBase(restoredKbId)
    expect(restoredBots).toHaveLength(2)
    const restoredStrict = restoredBots.find((b) => b.name === 'Strict Analyst')!
    const restoredBalanced = restoredBots.find((b) => b.name === 'Balanced Assistant')!
    expect(restoredStrict.responsePolicy).toBe('strict_kb_only')
    expect(restoredStrict.providerConnectionId).toBeNull()
    expect(restoredStrict.toolPermissions).toEqual([
      'search_knowledge_base',
      'read_knowledge_source'
    ])
    expect(restoredBalanced.responsePolicy).toBe('balanced_kb_first')

    // Verify Sources: ready source reindexed, failed source preserved as failed & skipped by reindex
    const restoredSources = sourceRepo.listByKnowledgeBase(restoredKbId)
    const restoredReady = restoredSources.find((s) => s.original_file_name === 'policy.txt')!
    const restoredFailed = restoredSources.find((s) => s.original_file_name === 'broken.txt')!
    expect(restoredFailed.indexing_status).toBe('failed')
    expect(restoredFailed.error_message).toBe('Corrupt file structure')
    expect(reindexMock).toHaveBeenCalledTimes(1)
    expect(reindexMock).toHaveBeenCalledWith({
      knowledgeBaseId: restoredKbId,
      sourceId: restoredReady.id
    })

    // Verify original file bytes preserved identically
    const restoredFilePath = storageManager.resolveOriginalPath(
      restoredKbId,
      restoredReady.id,
      'txt'
    )
    const restoredFileBytes = await fs.promises.readFile(restoredFilePath, 'utf8')
    expect(restoredFileBytes).toBe(readyContent)
    expect(sha256(restoredFileBytes)).toBe(readyHash)

    // Verify historical conversation segments & message metadata remapping + tokenUsage
    const restoredConv = convRepo.getOrCreate({
      botId: restoredStrict.id,
      knowledgeBaseId: restoredKbId
    })
    const restoredSegments = convRepo.getSegments(restoredConv.id)
    expect(restoredSegments).toHaveLength(2)
    expect(restoredSegments[1].title).toBe('Archived Research Thread')

    const restoredMessages = msgRepo.listByConversation(
      restoredConv.id,
      restoredStrict.id,
      restoredKbId
    )
    expect(restoredMessages).toHaveLength(2)
    const assistantMsg = restoredMessages.find((m) => m.role === 'assistant')!
    expect(assistantMsg.segmentId).toBe(restoredSegments[1].id)
    expect(assistantMsg.tokenUsage).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165
    })

    // Citations, claims, and agentRunId must point to NEW restored IDs, not pre-import IDs!
    const restoredRuns = agentRunRepo.listByBot(restoredStrict.id)
    expect(restoredRuns).toHaveLength(1)
    expect(restoredRuns[0].id).not.toBe(run.id)
    expect(restoredRuns[0].conversationId).toBe(restoredConv.id)
    expect(restoredRuns[0].status).toBe('completed')

    const restoredToolEvents = toolEventRepo.listByAgentRun(restoredRuns[0].id)
    expect(restoredToolEvents).toHaveLength(1)
    expect(restoredToolEvents[0].toolName).toBe('search_knowledge_base')
    expect(restoredToolEvents[0].status).toBe('completed')

    const meta = assistantMsg.metadata as {
      agentRunId?: string
      citations?: Array<{ sourceId: string }>
      claims?: Array<{
        evidenceReferences: Array<{ sourceId: string; knowledgeBaseId?: string }>
      }>
    }
    expect(meta.agentRunId).toBe(restoredRuns[0].id)
    expect(meta.citations?.[0].sourceId).toBe(restoredReady.id)
    expect(meta.claims?.[0].evidenceReferences[0].sourceId).toBe(restoredReady.id)
    expect(meta.claims?.[0].evidenceReferences[0].knowledgeBaseId).toBe(restoredKbId)
  })

  it('maintains backward compatibility with v1.0.0 archives and rejects unsupported future versions', async () => {
    const legacyKbId = crypto.randomUUID()
    const legacyBotId = crypto.randomUUID()
    const legacyConvId = crypto.randomUUID()
    const legacyMsgId = crypto.randomUUID()
    const now = Date.now()

    const kbJson = Buffer.from(
      JSON.stringify({
        id: legacyKbId,
        name: 'Legacy v1.0 KB',
        description: 'Created before responsePolicy or segments',
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      })
    )
    const botsJson = Buffer.from(
      JSON.stringify([
        {
          id: legacyBotId,
          name: 'Legacy Bot',
          description: '',
          systemPrompt: 'Hello',
          modelId: 'gpt-4o',
          status: 'active',
          toolPermissions: ['search_knowledge_base'],
          createdAt: now,
          updatedAt: now
        }
      ])
    )
    const memoriesJson = Buffer.from('[]')
    const sourcesJson = Buffer.from('[]')
    const conversationsJson = Buffer.from(
      JSON.stringify([
        {
          conversation: {
            id: legacyConvId,
            botId: legacyBotId,
            title: 'Legacy Thread',
            createdAt: now,
            updatedAt: now,
            archivedAt: null
          },
          messages: [
            {
              id: legacyMsgId,
              conversationId: legacyConvId,
              role: 'user',
              content: 'Legacy question',
              contentFormat: 'markdown',
              createdAt: now
            }
          ]
        }
      ])
    )

    const manifestV1 = Buffer.from(
      JSON.stringify({
        format: EXPORT_ARCHIVE_FORMAT,
        schemaVersion: '1.0.0',
        exportedAt: now,
        appVersion: '1.0.0',
        knowledgeBase: { id: legacyKbId, name: 'Legacy v1.0 KB' },
        counts: {
          bots: 1,
          memories: 0,
          sources: 0,
          conversations: 1,
          messages: 1,
          totalSourceBytes: 0
        },
        files: [
          { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha256(kbJson) },
          { path: 'bots.json', sizeBytes: botsJson.length, sha256: sha256(botsJson) },
          {
            path: 'bot-memories.json',
            sizeBytes: memoriesJson.length,
            sha256: sha256(memoriesJson)
          },
          { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha256(sourcesJson) },
          {
            path: 'conversations.json',
            sizeBytes: conversationsJson.length,
            sha256: sha256(conversationsJson)
          }
        ],
        excludedCategories: ['provider_credentials']
      })
    )

    const v1ArchivePath = path.join(tmpDir, 'legacy-v1.voyaro-kb.zip')
    const writer = new ZipArchiveWriter()
    writer.addEntry('manifest.json', manifestV1)
    writer.addEntry('knowledge-base.json', kbJson)
    writer.addEntry('bots.json', botsJson)
    writer.addEntry('bot-memories.json', memoriesJson)
    writer.addEntry('sources.json', sourcesJson)
    writer.addEntry('conversations.json', conversationsJson)
    await writer.writeToFile(v1ArchivePath)

    const previewRes = await importManager.selectAndPreviewArchive(v1ArchivePath)
    expect(previewRes.success).toBe(true)
    const importRes = await importManager.executeImport({
      sessionId: previewRes.preview!.sessionId,
      strategy: 'new'
    })
    expect(importRes.success).toBe(true)
    const bots = botRepo.listByKnowledgeBase(importRes.knowledgeBaseId!)
    expect(bots[0].responsePolicy).toBe('balanced_kb_first')

    // Future unsupported version 9.9.0 must be rejected
    const futureManifest = Buffer.from(
      JSON.stringify({
        ...JSON.parse(manifestV1.toString('utf8')),
        schemaVersion: '9.9.0'
      })
    )
    const futurePath = path.join(tmpDir, 'future-v9.voyaro-kb.zip')
    const futureWriter = new ZipArchiveWriter()
    futureWriter.addEntry('manifest.json', futureManifest)
    futureWriter.addEntry('knowledge-base.json', kbJson)
    futureWriter.addEntry('bots.json', botsJson)
    futureWriter.addEntry('bot-memories.json', memoriesJson)
    futureWriter.addEntry('sources.json', sourcesJson)
    futureWriter.addEntry('conversations.json', conversationsJson)
    await futureWriter.writeToFile(futurePath)

    await expect(importManager.selectAndPreviewArchive(futurePath)).rejects.toThrow(/schemaVersion/)
  })

  it('rejects ZIP archives containing Unix symlink entries (0o120000)', async () => {
    // Build a minimal single-entry ZIP with versionMadeBy = Unix (3) and externalAttrs = 0o120777 << 16
    const filename = Buffer.from('manifest.json', 'utf8')
    const data = Buffer.from('{}', 'utf8')
    const crc = calculateCrc32(data)

    const lfh = Buffer.alloc(30 + filename.length)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6)
    lfh.writeUInt16LE(0, 8)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(filename.length, 26)
    filename.copy(lfh, 30)

    const cdOffset = lfh.length + data.length
    const cd = Buffer.alloc(46 + filename.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // Unix host OS
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(filename.length, 28)
    cd.writeUInt32LE((0o120777 << 16) >>> 0, 38) // Symlink mode
    cd.writeUInt32LE(0, 42)
    filename.copy(cd, 46)

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)

    const symlinkZipPath = path.join(tmpDir, 'symlink.voyaro-kb.zip')
    await fs.promises.writeFile(symlinkZipPath, Buffer.concat([lfh, data, cd, eocd]))

    const extractor = new ArchiveExtractor()
    await expect(
      extractor.extractAndValidate(symlinkZipPath, path.join(tmpDir, 'extract-symlink'))
    ).rejects.toThrow(/Symlink/)
  })

  it('blocks export and import when secret scanner detects credential in agent run or tool event', async () => {
    const kb = kbRepo.create({ name: 'Secret Test KB', description: '' })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Agent Bot',
      modelId: 'gpt-4o'
    })
    const run = agentRunRepo.create({
      botId: bot.id,
      selectedModel: 'gpt-4o',
      initialStatus: 'running'
    })
    agentRunRepo.markFailed(run.id, 'Failed with key sk-proj-abcdefghijklmnopqrstuvwxyz123456')

    const outPath = path.join(tmpDir, 'blocked-secret.voyaro-kb.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, outPath)
    expect(exportRes.success).toBe(false)
    expect(exportRes.code).toBe('CREDENTIAL_LEAK_PREVENTED')
    expect(fs.existsSync(outPath)).toBe(false)
  })

  it('preserves byte-for-byte original files across multiple formats (.md, .csv, and 256KB binary .pdf)', async () => {
    const kb = kbRepo.create({ name: 'Multi-Format Originals KB', description: '' })

    const fixtures = [
      {
        id: crypto.randomUUID(),
        name: 'notes.md',
        type: 'md',
        mime: 'text/markdown',
        bytes: Buffer.from('# Architecture\n\nExact UTF-8 bytes: αβγ 🚀\n', 'utf8')
      },
      {
        id: crypto.randomUUID(),
        name: 'metrics.csv',
        type: 'csv',
        mime: 'text/csv',
        bytes: Buffer.from('id,score\n1,99.5\n2,87.25\n', 'utf8')
      },
      {
        id: crypto.randomUUID(),
        name: 'manual.pdf',
        type: 'pdf',
        mime: 'application/pdf',
        bytes: Buffer.concat([
          Buffer.from('%PDF-1.4\n', 'ascii'),
          crypto.randomBytes(256 * 1024),
          Buffer.from('\n%%EOF\n', 'ascii')
        ])
      }
    ]

    for (const f of fixtures) {
      const origPath = storageManager.resolveOriginalPath(kb.id, f.id, f.type)
      await fs.promises.mkdir(path.dirname(origPath), { recursive: true })
      await fs.promises.writeFile(origPath, f.bytes)
      testCtx.db
        .prepare(
          `INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status,
            error_message, created_at, updated_at, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?, ?)`
        )
        .run(
          f.id,
          kb.id,
          f.name,
          f.name,
          `originals/${f.id}.${f.type}`,
          f.type,
          f.mime,
          f.bytes.length,
          sha256(f.bytes),
          Date.now(),
          Date.now(),
          Date.now()
        )
    }

    const archivePath = path.join(tmpDir, 'multiformat.voyaro-kb.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, archivePath)
    expect(exportRes.success).toBe(true)

    const previewRes = await importManager.selectAndPreviewArchive(archivePath)
    expect(previewRes.success).toBe(true)
    const importRes = await importManager.executeImport({
      sessionId: previewRes.preview!.sessionId,
      strategy: 'new'
    })
    expect(importRes.success).toBe(true)

    const restoredSources = sourceRepo.listByKnowledgeBase(importRes.knowledgeBaseId!)
    expect(restoredSources).toHaveLength(3)

    for (const f of fixtures) {
      const restored = restoredSources.find((s) => s.original_file_name === f.name)!
      expect(restored).toBeDefined()
      expect(restored.file_type).toBe(f.type)
      expect(restored.mime_type).toBe(f.mime)
      expect(restored.file_size).toBe(f.bytes.length)
      expect(restored.content_hash).toBe(sha256(f.bytes))

      const restoredPath = storageManager.resolveOriginalPath(
        importRes.knowledgeBaseId!,
        restored.id,
        f.type
      )
      const restoredBytes = await fs.promises.readFile(restoredPath)
      expect(restoredBytes.length).toBe(f.bytes.length)
      expect(Buffer.compare(restoredBytes, f.bytes)).toBe(0)
      expect(sha256(restoredBytes)).toBe(sha256(f.bytes))
    }
  })

  it('does not mutate workspace on preview, supports repeated new imports, and guards replace with confirmationName', async () => {
    const kb = kbRepo.create({ name: 'Target Workspace', description: 'Original' })
    const bot = botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Existing Bot',
      modelId: 'gpt-4o'
    })
    const conv = convRepo.getOrCreate({ botId: bot.id, knowledgeBaseId: kb.id })
    msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kb.id,
      role: 'user',
      content: 'Original message',
      contentFormat: 'markdown'
    })

    const archivePath = path.join(tmpDir, 'repeat-check.voyaro-kb.zip')
    const exportRes = await exportManager.exportKnowledgeBase(kb.id, archivePath)
    expect(exportRes.success).toBe(true)

    // Preview must not mutate database counts
    const preview1 = await importManager.selectAndPreviewArchive(archivePath)
    expect(preview1.success).toBe(true)
    expect(kbRepo.list()).toHaveLength(1)
    expect(botRepo.listByKnowledgeBase(kb.id)).toHaveLength(1)

    // Replace with wrong confirmationName must be rejected without mutating target KB
    await expect(
      importManager.executeImport({
        sessionId: preview1.preview!.sessionId,
        strategy: 'replace',
        targetKnowledgeBaseId: kb.id,
        confirmationName: 'Wrong Name'
      })
    ).rejects.toThrow(/Confirmation name does not match/)
    expect(kbRepo.getById(kb.id)?.name).toBe('Target Workspace')
    expect(msgRepo.listByConversation(conv.id, bot.id, kb.id)).toHaveLength(1)

    // Repeated 'new' imports must succeed without PK collisions
    const import1 = await importManager.executeImport({
      sessionId: preview1.preview!.sessionId,
      strategy: 'new'
    })
    expect(import1.success).toBe(true)

    const preview2 = await importManager.selectAndPreviewArchive(archivePath)
    const import2 = await importManager.executeImport({
      sessionId: preview2.preview!.sessionId,
      strategy: 'new'
    })
    expect(import2.success).toBe(true)
    expect(import1.knowledgeBaseId).not.toBe(import2.knowledgeBaseId)
    expect(kbRepo.list()).toHaveLength(3)
  })

  it('rolls back filesystem and database cleanly if a DB failure occurs during import', async () => {
    const sourceKb = kbRepo.create({ name: 'Rollback Source KB', description: '' })
    const docId = crypto.randomUUID()
    const docBytes = Buffer.from('Rollback test document', 'utf8')
    const origPath = storageManager.resolveOriginalPath(sourceKb.id, docId, 'txt')
    await fs.promises.mkdir(path.dirname(origPath), { recursive: true })
    await fs.promises.writeFile(origPath, docBytes)
    testCtx.db
      .prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status,
          error_message, created_at, updated_at, indexed_at
        ) VALUES (?, ?, 'doc.txt', 'doc.txt', ?, 'txt', 'text/plain', ?, ?, 'completed', NULL, ?, ?, ?)`
      )
      .run(
        docId,
        sourceKb.id,
        `originals/${docId}.txt`,
        docBytes.length,
        sha256(docBytes),
        Date.now(),
        Date.now(),
        Date.now()
      )

    const archivePath = path.join(tmpDir, 'rollback-test.voyaro-kb.zip')
    await exportManager.exportKnowledgeBase(sourceKb.id, archivePath)

    const preview = await importManager.selectAndPreviewArchive(archivePath)
    const kbCountBefore = kbRepo.list().length

    const sourceKbWithBot = kbRepo.create({ name: 'Rollback With Bot', description: '' })
    botRepo.create({ knowledgeBaseId: sourceKbWithBot.id, name: 'Trigger Bot', modelId: 'gpt-4o' })
    const archiveWithBot = path.join(tmpDir, 'rollback-bot.voyaro-kb.zip')
    await exportManager.exportKnowledgeBase(sourceKbWithBot.id, archiveWithBot)

    const previewWithBot = await importManager.selectAndPreviewArchive(archiveWithBot)
    const kbsBeforeFail = kbRepo.list().length
    expect(kbsBeforeFail).toBe(kbCountBefore + 1)

    // Force SQLite insert failure on bots table during import transaction
    testCtx.db.exec(`
      CREATE TRIGGER fail_bot_insert_step129 BEFORE INSERT ON bots
      BEGIN
        SELECT RAISE(ABORT, 'Simulated DB failure during import');
      END;
    `)

    await expect(
      importManager.executeImport({
        sessionId: previewWithBot.preview!.sessionId,
        strategy: 'new'
      })
    ).rejects.toThrow(/Simulated DB failure/)

    testCtx.db.exec('DROP TRIGGER IF EXISTS fail_bot_insert_step129;')
    await importManager.cancelImport({ sessionId: preview.preview!.sessionId })

    // No orphan KB created on failed import
    expect(kbRepo.list()).toHaveLength(kbsBeforeFail)
  })

  it('consolidates v1.1.0 multi-conversation-per-Bot archives and preserves partial/cancelled/interrupted messages', async () => {
    const legacyKbId = crypto.randomUUID()
    const legacyBotId = crypto.randomUUID()
    const conv1Id = crypto.randomUUID()
    const conv2Id = crypto.randomUUID()
    const now = Date.now()

    const kbJson = Buffer.from(
      JSON.stringify({
        id: legacyKbId,
        name: 'Legacy v1.1 Multi-Conv KB',
        description: '',
        createdAt: now - 10000,
        updatedAt: now,
        archivedAt: null
      })
    )
    const botsJson = Buffer.from(
      JSON.stringify([
        {
          id: legacyBotId,
          name: 'Multi-Conv Bot',
          description: '',
          systemPrompt: 'Hello',
          modelId: 'gpt-4o',
          status: 'active',
          responsePolicy: 'general_ai_chat',
          toolPermissions: [],
          createdAt: now - 10000,
          updatedAt: now
        }
      ])
    )
    const memoriesJson = Buffer.from('[]')
    const sourcesJson = Buffer.from('[]')
    const conversationsJson = Buffer.from(
      JSON.stringify([
        {
          conversation: {
            id: conv1Id,
            botId: legacyBotId,
            title: 'Earlier Thread',
            createdAt: now - 8000,
            updatedAt: now - 7000,
            archivedAt: null
          },
          messages: [
            {
              id: crypto.randomUUID(),
              conversationId: conv1Id,
              role: 'assistant',
              content: 'Partial cancelled response...',
              contentFormat: 'markdown',
              metadata: {
                isPartial: true,
                status: 'cancelled',
                interruptedReason: 'User stopped generation'
              },
              createdAt: now - 7500
            }
          ]
        },
        {
          conversation: {
            id: conv2Id,
            botId: legacyBotId,
            title: 'Later Thread',
            createdAt: now - 4000,
            updatedAt: now - 1000,
            archivedAt: null
          },
          messages: [
            {
              id: crypto.randomUUID(),
              conversationId: conv2Id,
              role: 'assistant',
              content: 'Failed response',
              contentFormat: 'markdown',
              metadata: {
                status: 'failed',
                groundingMode: 'general_chat'
              },
              createdAt: now - 2000
            }
          ]
        }
      ])
    )

    const manifestV11 = Buffer.from(
      JSON.stringify({
        format: EXPORT_ARCHIVE_FORMAT,
        schemaVersion: '1.1.0',
        exportedAt: now,
        appVersion: '1.1.0',
        knowledgeBase: { id: legacyKbId, name: 'Legacy v1.1 Multi-Conv KB' },
        counts: {
          bots: 1,
          memories: 0,
          sources: 0,
          conversations: 2,
          messages: 2,
          totalSourceBytes: 0
        },
        files: [
          { path: 'knowledge-base.json', sizeBytes: kbJson.length, sha256: sha256(kbJson) },
          { path: 'bots.json', sizeBytes: botsJson.length, sha256: sha256(botsJson) },
          {
            path: 'bot-memories.json',
            sizeBytes: memoriesJson.length,
            sha256: sha256(memoriesJson)
          },
          { path: 'sources.json', sizeBytes: sourcesJson.length, sha256: sha256(sourcesJson) },
          {
            path: 'conversations.json',
            sizeBytes: conversationsJson.length,
            sha256: sha256(conversationsJson)
          }
        ],
        excludedCategories: ['provider_credentials']
      })
    )

    const v11Path = path.join(tmpDir, 'legacy-v11.voyaro-kb.zip')
    const writer = new ZipArchiveWriter()
    writer.addEntry('manifest.json', manifestV11)
    writer.addEntry('knowledge-base.json', kbJson)
    writer.addEntry('bots.json', botsJson)
    writer.addEntry('bot-memories.json', memoriesJson)
    writer.addEntry('sources.json', sourcesJson)
    writer.addEntry('conversations.json', conversationsJson)
    await writer.writeToFile(v11Path)

    const preview = await importManager.selectAndPreviewArchive(v11Path)
    expect(preview.success).toBe(true)
    const importRes = await importManager.executeImport({
      sessionId: preview.preview!.sessionId,
      strategy: 'new'
    })
    expect(importRes.success).toBe(true)

    const restoredBot = botRepo.listByKnowledgeBase(importRes.knowledgeBaseId!)[0]
    expect(restoredBot.responsePolicy).toBe('general_ai_chat')

    // Exactly 1 canonical conversation with 2 deterministic segments
    const allConvs = convRepo.listByBot(restoredBot.id, importRes.knowledgeBaseId!, {
      includeArchived: true
    })
    expect(allConvs).toHaveLength(1)

    const segments = convRepo.getSegments(allConvs[0].id)
    expect(segments).toHaveLength(2)
    expect(segments[0].title).toBe('Earlier Thread')
    expect(segments[1].title).toBe('Later Thread')

    const messages = msgRepo.listByConversation(
      allConvs[0].id,
      restoredBot.id,
      importRes.knowledgeBaseId!
    )
    expect(messages).toHaveLength(2)
    expect(messages[0].metadata.isPartial).toBe(true)
    expect(messages[0].metadata.status).toBe('cancelled')
    expect(messages[0].metadata.interruptedReason).toBe('User stopped generation')
    expect(messages[1].metadata.status).toBe('failed')
    expect(messages[1].metadata.groundingMode).toBe('general_chat')
  })
})
