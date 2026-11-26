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
  type ExportConversationSegmentDto,
  type ExportMessageDto,
  type ExportConversationBundleDto,
  type ExportAgentRunDto,
  type ExportToolEventDto,
  type ExportKnowledgeBaseResultDto
} from '../../shared/export-archive'
import { toAppAgentRunStatus, type DbAgentRunStatus } from '../../shared/agents'
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
    let agentRunsData: ExportAgentRunDto[]
    let toolEventsData: ExportToolEventDto[]

    try {
      const snapshot = this.readKnowledgeBaseSnapshot(knowledgeBaseId)
      kbData = snapshot.kbData
      botsData = snapshot.botsData
      memoriesData = snapshot.memoriesData
      sourcesData = snapshot.sourcesData
      conversationBundles = snapshot.conversationBundles
      agentRunsData = snapshot.agentRunsData
      toolEventsData = snapshot.toolEventsData
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
    const serializedPayloads = [
      kbData,
      botsData,
      memoriesData,
      sourcesData,
      conversationBundles,
      agentRunsData,
      toolEventsData
    ]

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
    const segmentsCount = conversationBundles.reduce((acc, c) => acc + (c.segments?.length ?? 0), 0)
    const counts: ExportCountsDto = {
      bots: botsData.length,
      memories: memoriesData.length,
      sources: sourcesData.length,
      conversations: conversationBundles.length,
      segments: segmentsCount,
      messages: conversationBundles.reduce((acc, c) => acc + c.messages.length, 0),
      agentRuns: agentRunsData.length,
      toolEvents: toolEventsData.length,
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
      {
        path: 'agent-runs.json',
        data: Buffer.from(JSON.stringify({ agentRuns: agentRunsData }, null, 2), 'utf8')
      },
      {
        path: 'tool-events.json',
        data: Buffer.from(JSON.stringify({ toolEvents: toolEventsData }, null, 2), 'utf8')
      },
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
    agentRunsData: ExportAgentRunDto[]
    toolEventsData: ExportToolEventDto[]
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

          const segmentsRows = this.db
            .prepare(
              `SELECT id, conversation_id, original_conversation_id, title, segment_order,
                      first_message_created_at, last_message_created_at, message_count, created_at, archived_at
               FROM conversation_segments
               WHERE conversation_id = ?
               ORDER BY segment_order ASC, created_at ASC`
            )
            .all(conv.id) as Array<{
            id: string
            conversation_id: string
            original_conversation_id: string
            title: string
            segment_order: number
            first_message_created_at: number | null
            last_message_created_at: number | null
            message_count: number
            created_at: number
            archived_at: number | null
          }>

          const segmentsDto: ExportConversationSegmentDto[] = segmentsRows.map((seg) => ({
            id: seg.id,
            conversationId: seg.conversation_id,
            originalConversationId: seg.original_conversation_id,
            title: seg.title,
            segmentOrder: seg.segment_order,
            firstMessageCreatedAt: seg.first_message_created_at,
            lastMessageCreatedAt: seg.last_message_created_at,
            messageCount: seg.message_count,
            createdAt: seg.created_at,
            archivedAt: seg.archived_at
          }))

          const messages = this.messageRepository.listByConversation(
            conv.id,
            bot.id,
            knowledgeBaseId
          )
          const messagesDto: ExportMessageDto[] = messages.map((msg) => ({
            id: msg.id,
            conversationId: msg.conversationId,
            segmentId: msg.segmentId ?? null,
            role: msg.role,
            content: msg.content,
            contentFormat: msg.contentFormat,
            metadata: msg.metadata ? { ...msg.metadata } : null,
            tokenUsage: msg.tokenUsage ? { ...msg.tokenUsage } : null,
            createdAt: msg.createdAt
          }))

          conversationBundles.push({
            conversation: convDto,
            segments: segmentsDto,
            messages: messagesDto
          })
        }
      }

      const agentRunRows = this.db
        .prepare(
          `SELECT id, bot_id, conversation_id, status, selected_model, iteration_count,
                  error_summary, started_at, completed_at
           FROM agent_runs
           WHERE knowledge_base_id = ?
           ORDER BY started_at ASC`
        )
        .all(knowledgeBaseId) as Array<{
        id: string
        bot_id: string
        conversation_id: string | null
        status: DbAgentRunStatus
        selected_model: string
        iteration_count: number
        error_summary: string | null
        started_at: number
        completed_at: number | null
      }>

      const agentRunsData: ExportAgentRunDto[] = agentRunRows.map((run) => ({
        id: run.id,
        botId: run.bot_id,
        conversationId: run.conversation_id,
        status: toAppAgentRunStatus(run.status),
        selectedModel: run.selected_model,
        iterationCount: run.iteration_count,
        errorSummary: run.error_summary,
        startedAt: run.started_at,
        completedAt: run.completed_at
      }))

      const toolEventRows = this.db
        .prepare(
          `SELECT te.id, te.agent_run_id, te.sequence_number, te.tool_name, te.status,
                  te.approval_status, te.arguments_summary, te.result_summary,
                  te.error_message, te.started_at, te.completed_at
           FROM tool_events te
           INNER JOIN agent_runs ar ON te.agent_run_id = ar.id
           WHERE ar.knowledge_base_id = ?
           ORDER BY te.started_at ASC, te.sequence_number ASC`
        )
        .all(knowledgeBaseId) as Array<{
        id: string
        agent_run_id: string
        sequence_number: number
        tool_name: string
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
        approval_status:
          'not_required' | 'auto_approved' | 'pending_approval' | 'user_approved' | 'user_rejected'
        arguments_summary: string
        result_summary: string
        error_message: string | null
        started_at: number
        completed_at: number | null
      }>

      const toolEventsData: ExportToolEventDto[] = toolEventRows.map((ev) => ({
        id: ev.id,
        agentRunId: ev.agent_run_id,
        sequenceNumber: ev.sequence_number,
        toolName: ev.tool_name,
        status: ev.status,
        approvalStatus: ev.approval_status,
        argumentsSummary: ev.arguments_summary,
        resultSummary: ev.result_summary,
        errorMessage: ev.error_message,
        startedAt: ev.started_at,
        completedAt: ev.completed_at
      }))

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
        errorMessage: s.error_message ?? null,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        indexedAt: s.indexed_at
      }))

      return {
        kbData,
        botsData,
        memoriesData,
        sourcesData,
        conversationBundles,
        agentRunsData,
        toolEventsData
      }
    })

    return readTx()
  }
}
