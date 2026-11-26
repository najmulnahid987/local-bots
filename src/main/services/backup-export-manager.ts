import fs from 'node:fs'
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  EXPORT_ARCHIVE_FORMAT,
  EXPORT_ARCHIVE_SCHEMA_VERSION,
  EXCLUDED_EXPORT_CATEGORIES,
  type ExportManifestDto,
  type ExportFileEntryDto,
  type ExportCountsDto,
  type ExportKnowledgeBaseDto,
  type ExportBotDto,
  type ExportBotMemoryDto,
  type ExportKnowledgeSourceDto,
  type ExportConversationDto,
  type ExportMessageDto,
  type ExportConversationBundleDto,
  type ExportKnowledgeBaseResultDto
} from '../../shared/export-archive'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ExtractedDocumentRepository } from '../database/repositories/extracted-document-repository'
import { DocumentValidationRepository } from '../database/repositories/document-validation-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { SecretScanner, defaultSecretScanner } from './secret-scanner'
import { ZipArchiveWriter, verifyZipArchive } from './zip-archive'

export interface SaveDialogOptionsLike {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface SaveDialogReturnValueLike {
  canceled: boolean
  filePath?: string
}

export interface BackupExportManagerOptions {
  readonly db: Database.Database
  readonly kbRepository: KnowledgeBaseRepository
  readonly botRepository: BotRepository
  readonly botMemoryRepository: BotMemoryRepository
  readonly knowledgeSourceRepository: KnowledgeSourceRepository
  readonly conversationRepository: ConversationRepository
  readonly messageRepository: MessageRepository
  readonly storageManager: DocumentStorageManager
  readonly extractedDocumentRepository?: ExtractedDocumentRepository
  readonly documentValidationRepository?: DocumentValidationRepository
  readonly secretScanner?: SecretScanner
  readonly showSaveDialog?: (options: SaveDialogOptionsLike) => Promise<SaveDialogReturnValueLike>
  readonly appVersion?: string
}

/**
 * Calculates SHA-256 hash of a buffer or string.
 */
function sha256Hash(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Sanitizes a string into a safe file name component.
 */
export function sanitizeArchiveFileName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized.length > 0 ? sanitized : 'knowledge-base'
}

/**
 * Main-process service responsible for exporting an entire Knowledge Base into a
 * secure, self-contained, portable ZIP archive.
 */
export class BackupExportManager {
  private readonly db: Database.Database
  private readonly kbRepository: KnowledgeBaseRepository
  private readonly botRepository: BotRepository
  private readonly botMemoryRepository: BotMemoryRepository
  private readonly knowledgeSourceRepository: KnowledgeSourceRepository
  private readonly conversationRepository: ConversationRepository
  private readonly messageRepository: MessageRepository
  private readonly storageManager: DocumentStorageManager
  private readonly extractedDocRepo: ExtractedDocumentRepository
  private readonly validationRepo?: DocumentValidationRepository
  private readonly secretScanner: SecretScanner
  private readonly showSaveDialog: (
    options: SaveDialogOptionsLike
  ) => Promise<SaveDialogReturnValueLike>
  private readonly appVersion: string

  constructor(options: BackupExportManagerOptions) {
    this.db = options.db
    this.kbRepository = options.kbRepository
    this.botRepository = options.botRepository
    this.botMemoryRepository = options.botMemoryRepository
    this.knowledgeSourceRepository = options.knowledgeSourceRepository
    this.conversationRepository = options.conversationRepository
    this.messageRepository = options.messageRepository
    this.storageManager = options.storageManager
    this.extractedDocRepo =
      options.extractedDocumentRepository ?? new ExtractedDocumentRepository(options.db)
    this.validationRepo =
      options.documentValidationRepository ?? new DocumentValidationRepository(options.db)
    this.secretScanner = options.secretScanner ?? defaultSecretScanner
    this.appVersion = options.appVersion ?? '1.0.0'

    this.showSaveDialog =
      options.showSaveDialog ??
      (async (opts) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { dialog } = require('electron')
        return await dialog.showSaveDialog(opts)
      })
  }

  /**
   * Executes the full Knowledge Base export sequence.
   * If customSavePath is omitted, prompts the user via native OS Save As dialog.
   */
  public async exportKnowledgeBase(
    knowledgeBaseId: string,
    customSavePath?: string
  ): Promise<ExportKnowledgeBaseResultDto> {
    if (!knowledgeBaseId || typeof knowledgeBaseId !== 'string') {
      return {
        success: false,
        knowledgeBaseId,
        code: 'INVALID_INPUT',
        error: 'A valid Knowledge Base ID is required for export.'
      }
    }

    // 1. Atomic read snapshot of all relational data
    let kbData: ExportKnowledgeBaseDto
    let botsData: ExportBotDto[]
    let memoriesData: ExportBotMemoryDto[]
    let sourcesData: ExportKnowledgeSourceDto[]
    let conversationBundles: ExportConversationBundleDto[]

    try {
      const snapshot = this.readKnowledgeBaseSnapshot(knowledgeBaseId)
      kbData = snapshot.kbData
      botsData = snapshot.botsData
      memoriesData = snapshot.memoriesData
      sourcesData = snapshot.sourcesData
      conversationBundles = snapshot.conversationBundles
    } catch (err) {
      return {
        success: false,
        knowledgeBaseId,
        code: 'KNOWLEDGE_BASE_NOT_FOUND',
        error: err instanceof Error ? err.message : String(err)
      }
    }

    // 2. Validate original documents and path containment
    const documentFilesToBundle: Array<{
      archivePath: string
      localFsPath: string
      sizeBytes: number
      sha256: string
    }> = []

    let totalSourceBytes = 0

    for (const source of sourcesData) {
      try {
        const localFsPath = this.storageManager.resolveOriginalPath(
          knowledgeBaseId,
          source.id,
          source.fileType
        )

        if (!fs.existsSync(localFsPath)) {
          return {
            success: false,
            knowledgeBaseId,
            code: 'DOCUMENT_FILE_MISSING',
            error: `Original file for document '${source.originalFileName}' (${source.id}) is missing from disk.`
          }
        }

        const fileBuffer = await fs.promises.readFile(localFsPath)
        const computedHash = sha256Hash(fileBuffer)

        if (computedHash.toLowerCase() !== source.contentHash.toLowerCase()) {
          return {
            success: false,
            knowledgeBaseId,
            code: 'DOCUMENT_HASH_MISMATCH',
            error: `Integrity check failed: content hash mismatch for document '${source.originalFileName}'.`
          }
        }

        totalSourceBytes += fileBuffer.length
        documentFilesToBundle.push({
          archivePath: `documents/${source.id}.${source.fileType}`,
          localFsPath,
          sizeBytes: fileBuffer.length,
          sha256: computedHash
        })
      } catch (err) {
        return {
          success: false,
          knowledgeBaseId,
          code: 'STORAGE_RESOLUTION_FAILED',
          error: `Failed to resolve document path: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    // 3. Post-Export Secret Scanner: Inspect all serialized data
    const serializedPayloads = [kbData, botsData, memoriesData, sourcesData, conversationBundles]

    for (const payload of serializedPayloads) {
      const scanResult = this.secretScanner.scanObject(payload)
      if (scanResult.hasSecret) {
        return {
          success: false,
          knowledgeBaseId,
          code: 'CREDENTIAL_LEAK_PREVENTED',
          error: `Export blocked: high-confidence credential detected in workspace data (${scanResult.patternName ?? 'Secret'}).`
        }
      }
    }

    // 4. Determine destination save path
    let destinationPath = customSavePath
    if (!destinationPath) {
      const defaultFileName = `${sanitizeArchiveFileName(kbData.name)}-export.voyaro-kb.zip`
      const dialogResult = await this.showSaveDialog({
        title: `Export Knowledge Base — ${kbData.name}`,
        defaultPath: defaultFileName,
        filters: [
          {
            name: 'Voyaro Knowledge Base Archive (*.voyaro-kb.zip)',
            extensions: ['voyaro-kb.zip', 'zip']
          },
          { name: 'All Files (*.*)', extensions: ['*'] }
        ]
      })

      if (dialogResult.canceled || !dialogResult.filePath) {
        return {
          success: false,
          cancelled: true,
          knowledgeBaseId
        }
      }

      destinationPath = dialogResult.filePath
    }

    // 5. Gather Extracted Documents & Preservation Reports for sources
    let extractedDocsCount = 0
    let preservationReportsCount = 0
    const extraDocEntries: Array<{ path: string; data: Buffer }> = []

    const enrichedSourcesData: ExportKnowledgeSourceDto[] = sourcesData.map((src) => {
      let docHash: string | null = null
      let preservationStatus: string | null = null

      const extractedDoc = this.extractedDocRepo.get(src.id, knowledgeBaseId)
      if (extractedDoc) {
        const docBuf = Buffer.from(JSON.stringify(extractedDoc, null, 2), 'utf8')
        docHash = sha256Hash(docBuf)
        extraDocEntries.push({
          path: `extracted-documents/${src.id}.json`,
          data: docBuf
        })
        extractedDocsCount++
      }

      if (this.validationRepo) {
        const report = this.validationRepo.getReport(src.id, knowledgeBaseId)
        if (report) {
          const reportBuf = Buffer.from(JSON.stringify(report, null, 2), 'utf8')
          preservationStatus = report.status
          extraDocEntries.push({
            path: `preservation-reports/${src.id}.json`,
            data: reportBuf
          })
          preservationReportsCount++
        }
      }

      return {
        ...src,
        documentHash: docHash,
        preservationStatus
      }
    })

    // 6. Build ZIP Archive
    const counts: ExportCountsDto = {
      bots: botsData.length,
      memories: memoriesData.length,
      sources: sourcesData.length,
      conversations: conversationBundles.length,
      messages: conversationBundles.reduce((acc, c) => acc + c.messages.length, 0),
      totalSourceBytes
    }
    if (extractedDocsCount > 0) {
      ;(counts as { extractedDocuments: number }).extractedDocuments = extractedDocsCount
    }
    if (preservationReportsCount > 0) {
      ;(counts as { preservationReports: number }).preservationReports = preservationReportsCount
    }

    const archiveWriter = new ZipArchiveWriter()
    const fileInventory: ExportFileEntryDto[] = []

    // Prepare JSON payload buffers
    const kbJsonBuffer = Buffer.from(JSON.stringify(kbData, null, 2), 'utf8')
    const botsJsonBuffer = Buffer.from(JSON.stringify(botsData, null, 2), 'utf8')
    const memoriesJsonBuffer = Buffer.from(JSON.stringify(memoriesData, null, 2), 'utf8')
    const sourcesJsonBuffer = Buffer.from(JSON.stringify(enrichedSourcesData, null, 2), 'utf8')
    const conversationsJsonBuffer = Buffer.from(
      JSON.stringify(conversationBundles, null, 2),
      'utf8'
    )

    const jsonEntries: Array<{ path: string; data: Buffer }> = [
      { path: 'knowledge-base.json', data: kbJsonBuffer },
      { path: 'bots.json', data: botsJsonBuffer },
      { path: 'bot-memories.json', data: memoriesJsonBuffer },
      { path: 'sources.json', data: sourcesJsonBuffer },
      { path: 'conversations.json', data: conversationsJsonBuffer },
      ...extraDocEntries
    ]

    for (const jsonEntry of jsonEntries) {
      fileInventory.push({
        path: jsonEntry.path,
        sizeBytes: jsonEntry.data.length,
        sha256: sha256Hash(jsonEntry.data)
      })
    }

    for (const doc of documentFilesToBundle) {
      fileInventory.push({
        path: doc.archivePath,
        sizeBytes: doc.sizeBytes,
        sha256: doc.sha256
      })
    }

    // Construct manifest.json
    const manifest: ExportManifestDto = {
      format: EXPORT_ARCHIVE_FORMAT,
      schemaVersion: EXPORT_ARCHIVE_SCHEMA_VERSION,
      exportedAt: Date.now(),
      appVersion: this.appVersion,
      knowledgeBase: {
        id: kbData.id,
        name: kbData.name
      },
      counts,
      files: fileInventory,
      excludedCategories: [...EXCLUDED_EXPORT_CATEGORIES]
    }

    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')

    // Add entries to writer
    archiveWriter.addEntry('manifest.json', manifestBuffer)
    for (const jsonEntry of jsonEntries) {
      archiveWriter.addEntry(jsonEntry.path, jsonEntry.data)
    }
    for (const doc of documentFilesToBundle) {
      archiveWriter.addFile(doc.archivePath, doc.localFsPath)
    }

    // 6. Write to destination file atomically
    let archiveSizeBytes: number
    try {
      archiveSizeBytes = await archiveWriter.writeToFile(destinationPath)
    } catch (writeErr) {
      return {
        success: false,
        knowledgeBaseId,
        code: 'FILE_WRITE_ERROR',
        error: `Failed to write export archive: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
      }
    }

    // 7. Post-Export Archive Verification
    try {
      const { entryCount } = await verifyZipArchive(destinationPath)
      if (entryCount < fileInventory.length + 1) {
        throw new Error(
          `Archive integrity check failed: expected at least ${fileInventory.length + 1} files, found ${entryCount}`
        )
      }
    } catch (verifyErr) {
      try {
        if (fs.existsSync(destinationPath)) {
          await fs.promises.unlink(destinationPath)
        }
      } catch {
        // Ignore cleanup error
      }
      return {
        success: false,
        knowledgeBaseId,
        code: 'ARCHIVE_VERIFICATION_FAILED',
        error: `Generated archive failed structural integrity verification: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
      }
    }

    return {
      success: true,
      knowledgeBaseId,
      archivePath: destinationPath,
      archiveSizeBytes,
      counts
    }
  }

  /**
   * Reads an atomic, isolated snapshot of all relational records for the Knowledge Base.
   */
  private readKnowledgeBaseSnapshot(knowledgeBaseId: string): {
    kbData: ExportKnowledgeBaseDto
    botsData: ExportBotDto[]
    memoriesData: ExportBotMemoryDto[]
    sourcesData: ExportKnowledgeSourceDto[]
    conversationBundles: ExportConversationBundleDto[]
  } {
    const readTx = this.db.transaction(() => {
      const kb = this.kbRepository.getById(knowledgeBaseId)
      if (!kb) {
        throw new Error(`Knowledge Base '${knowledgeBaseId}' not found.`)
      }

      const kbData: ExportKnowledgeBaseDto = {
        id: kb.id,
        name: kb.name,
        description: kb.description ?? '',
        createdAt: kb.created_at,
        updatedAt: kb.updated_at,
        archivedAt: kb.archived_at
      }

      const bots = this.botRepository.listByKnowledgeBase(knowledgeBaseId)
      const botsData: ExportBotDto[] = bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.description,
        systemPrompt: bot.systemPrompt,
        modelId: bot.modelId,
        status: bot.status,
        responsePolicy: bot.responsePolicy,
        toolPermissions: [...bot.toolPermissions],
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt
      }))

      const memoriesData: ExportBotMemoryDto[] = []
      const conversationBundles: ExportConversationBundleDto[] = []

      for (const bot of bots) {
        const botMemories = this.botMemoryRepository.listByBot(bot.id, knowledgeBaseId)
        for (const memory of botMemories) {
          memoriesData.push({
            id: memory.id,
            botId: memory.botId,
            memoryType: memory.memoryType,
            content: memory.content,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt
          })
        }

        const botConversations = this.conversationRepository.listByBot(bot.id, knowledgeBaseId, {
          includeArchived: true
        })

        for (const conv of botConversations) {
          const convDto: ExportConversationDto = {
            id: conv.id,
            botId: conv.botId,
            title: conv.title,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            archivedAt: conv.archivedAt
          }

          const messages = this.messageRepository.listByConversation(
            conv.id,
            bot.id,
            knowledgeBaseId
          )
          const messagesDto: ExportMessageDto[] = messages.map((msg) => ({
            id: msg.id,
            conversationId: msg.conversationId,
            role: msg.role,
            content: msg.content,
            contentFormat: msg.contentFormat,
            metadata: msg.metadata ? { ...msg.metadata } : null,
            createdAt: msg.createdAt
          }))

          conversationBundles.push({
            conversation: convDto,
            messages: messagesDto
          })
        }
      }

      const sources = this.knowledgeSourceRepository.listByKnowledgeBase(knowledgeBaseId)
      const sourcesData: ExportKnowledgeSourceDto[] = sources.map((s) => ({
        id: s.id,
        fileName: s.file_name,
        originalFileName: s.original_file_name,
        fileType: s.file_type,
        mimeType: s.mime_type,
        fileSizeBytes: s.file_size,
        contentHash: s.content_hash,
        indexingStatus: s.indexing_status,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        indexedAt: s.indexed_at
      }))

      return {
        kbData,
        botsData,
        memoriesData,
        sourcesData,
        conversationBundles
      }
    })

    return readTx()
  }
}
