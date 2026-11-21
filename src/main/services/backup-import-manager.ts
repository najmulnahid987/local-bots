import fs from 'node:fs'
import path from 'node:path'
import crypto, { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  EXPORT_ARCHIVE_FORMAT,
  EXPORT_ARCHIVE_SCHEMA_VERSION,
  type ExportManifestDto,
  type ExportKnowledgeBaseDto,
  type ExportBotDto,
  type ExportBotMemoryDto,
  type ExportKnowledgeSourceDto,
  type ExportConversationBundleDto,
  type ImportPreviewDto,
  type ImportPreviewResultDto,
  type ExecuteImportRequest,
  type ExecuteImportResultDto,
  type CancelImportRequest,
  type CancelImportResultDto,
  exportManifestDtoSchema,
  exportKnowledgeBaseDtoSchema,
  exportBotDtoSchema,
  exportBotMemoryDtoSchema,
  exportKnowledgeSourceDtoSchema,
  exportConversationBundleDtoSchema,
  executeImportRequestSchema,
  cancelImportRequestSchema
} from '../../shared/export-archive'
import { z } from 'zod'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import type { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import { universalDocumentSchema } from '../documents/model/schema'
import { documentPreservationReportSchema } from '../documents/validation/types'
import { ArchiveExtractor, type StagedDocumentFile } from './archive-extractor'
import { SecretScanner, defaultSecretScanner } from './secret-scanner'
import type { ImportRecoveryService } from './import-recovery-service'

export interface OpenDialogOptionsLike {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}

export interface OpenDialogReturnValueLike {
  canceled: boolean
  filePaths: string[]
}

export interface BackupImportManagerOptions {
  readonly db: Database.Database
  readonly kbRepository: KnowledgeBaseRepository
  readonly botRepository: BotRepository
  readonly botMemoryRepository: BotMemoryRepository
  readonly knowledgeSourceRepository: KnowledgeSourceRepository
  readonly conversationRepository: ConversationRepository
  readonly messageRepository: MessageRepository
  readonly storageManager: DocumentStorageManager
  readonly documentLifecycleService?: DocumentLifecycleService
  readonly importRecoveryService?: ImportRecoveryService
  readonly archiveExtractor?: ArchiveExtractor
  readonly secretScanner?: SecretScanner
  readonly showOpenDialog?: (options: OpenDialogOptionsLike) => Promise<OpenDialogReturnValueLike>
  readonly tempBaseDir?: string
  readonly sessionTtlMs?: number
}

interface StagedImportSession {
  readonly sessionId: string
  readonly archivePath: string
  readonly archiveMtimeMs: number
  readonly archiveSizeBytes: number
  readonly stagingDir: string
  readonly manifest: ExportManifestDto
  readonly kbData: ExportKnowledgeBaseDto
  readonly botsData: ExportBotDto[]
  readonly memoriesData: ExportBotMemoryDto[]
  readonly sourcesData: ExportKnowledgeSourceDto[]
  readonly conversationBundles: ExportConversationBundleDto[]
  readonly stagedDocuments: Map<string, StagedDocumentFile>
  readonly stagedExtractedDocuments?: Map<string, string>
  readonly stagedPreservationReports?: Map<string, string>
  readonly createdAt: number
}

const MAX_ARCHIVE_FILE_SIZE = 500 * 1024 * 1024 // 500 MB

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Main-process service responsible for importing and restoring Knowledge Bases
 * from versioned ZIP archives.
 */
export class BackupImportManager {
  private readonly db: Database.Database
  private readonly kbRepository: KnowledgeBaseRepository
  protected readonly botRepository: BotRepository
  protected readonly botMemoryRepository: BotMemoryRepository
  protected readonly knowledgeSourceRepository: KnowledgeSourceRepository
  protected readonly conversationRepository: ConversationRepository
  protected readonly messageRepository: MessageRepository
  private readonly storageManager: DocumentStorageManager
  private readonly documentLifecycleService?: DocumentLifecycleService
  private readonly importRecoveryService?: ImportRecoveryService
  private readonly archiveExtractor: ArchiveExtractor
  private readonly secretScanner: SecretScanner
  private readonly showOpenDialog: (
    options: OpenDialogOptionsLike
  ) => Promise<OpenDialogReturnValueLike>
  private readonly tempBaseDir: string
  private readonly sessionTtlMs: number

  private readonly sessions = new Map<string, StagedImportSession>()

  constructor(options: BackupImportManagerOptions) {
    this.db = options.db
    this.kbRepository = options.kbRepository
    this.botRepository = options.botRepository
    this.botMemoryRepository = options.botMemoryRepository
    this.knowledgeSourceRepository = options.knowledgeSourceRepository
    this.conversationRepository = options.conversationRepository
    this.messageRepository = options.messageRepository
    this.storageManager = options.storageManager
    this.documentLifecycleService = options.documentLifecycleService
    this.importRecoveryService = options.importRecoveryService
    this.archiveExtractor = options.archiveExtractor ?? new ArchiveExtractor()
    this.secretScanner = options.secretScanner ?? defaultSecretScanner
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 60 * 1000 // 30 minutes default

    this.showOpenDialog =
      options.showOpenDialog ??
      (async (opts) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { dialog } = require('electron')
        return await dialog.showOpenDialog(opts)
      })

    if (options.tempBaseDir) {
      this.tempBaseDir = path.resolve(options.tempBaseDir)
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          this.tempBaseDir = path.resolve(app.getPath('temp'))
        } else {
          this.tempBaseDir = path.resolve(process.cwd(), 'temp')
        }
      } catch {
        this.tempBaseDir = path.resolve(process.cwd(), 'temp')
      }
    }
  }

  /**
   * Prompts the user to select a .voyaro-kb.zip archive, extracts it into
   * isolated temporary staging, validates manifest and integrity, and returns
   * a high-level preview.
   */
  public async selectAndPreviewArchive(
    customArchivePath?: string
  ): Promise<ImportPreviewResultDto> {
    this.pruneStaleSessions()

    let archivePath = customArchivePath
    if (!archivePath) {
      const dialogResult = await this.showOpenDialog({
        title: 'Select Knowledge Base Archive',
        filters: [
          {
            name: 'Voyaro Knowledge Base Archive (*.voyaro-kb.zip, *.zip)',
            extensions: ['voyaro-kb.zip', 'zip']
          },
          { name: 'All Files (*.*)', extensions: ['*'] }
        ],
        properties: ['openFile']
      })

      if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
        return {
          success: false,
          cancelled: true
        }
      }

      archivePath = dialogResult.filePaths[0]
    }

    // 1. Verify archive file existence and size limits
    let stat: fs.Stats
    try {
      stat = fs.statSync(archivePath)
    } catch {
      const err = new Error('The selected archive file could not be read or does not exist.')
      ;(err as unknown as { code: string }).code = 'ARCHIVE_NOT_FOUND'
      throw err
    }

    if (!stat.isFile()) {
      const err = new Error('The selected archive path is not a valid regular file.')
      ;(err as unknown as { code: string }).code = 'INVALID_ARCHIVE_FILE'
      throw err
    }

    if (stat.size > MAX_ARCHIVE_FILE_SIZE) {
      const err = new Error(
        `Archive file size (${Math.round(stat.size / 1024 / 1024)} MB) exceeds maximum allowed limit of ${MAX_ARCHIVE_FILE_SIZE / 1024 / 1024} MB.`
      )
      ;(err as unknown as { code: string }).code = 'ARCHIVE_TOO_LARGE'
      throw err
    }

    // 2. Extract and structurally validate ZIP entries into isolated staging
    const bundle = await this.archiveExtractor.extractAndValidate(archivePath, this.tempBaseDir)
    const { stagingDir, stagedDocuments } = bundle

    try {
      // 3. Parse manifest
      const manifestRaw = JSON.parse(bundle.manifestRaw)
      const manifestParsed = exportManifestDtoSchema.safeParse(manifestRaw)
      if (!manifestParsed.success) {
        const issueMsg = manifestParsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
        throw new Error(`Archive manifest validation failed: ${issueMsg}`)
      }
      const manifest = manifestParsed.data

      if (manifest.format !== EXPORT_ARCHIVE_FORMAT) {
        throw new Error(
          `Unsupported archive format: '${manifest.format}'. Expected '${EXPORT_ARCHIVE_FORMAT}'.`
        )
      }

      if (
        manifest.schemaVersion !== '1.0.0' &&
        manifest.schemaVersion !== '1.1.0' &&
        manifest.schemaVersion !== EXPORT_ARCHIVE_SCHEMA_VERSION
      ) {
        throw new Error(
          `Unsupported archive schema version: '${manifest.schemaVersion}'. Expected '1.0.0' or '1.1.0'.`
        )
      }

      // 4. Parse and validate metadata JSON files
      const kbData = exportKnowledgeBaseDtoSchema.parse(JSON.parse(bundle.knowledgeBaseRaw))
      const botsData = z.array(exportBotDtoSchema).parse(JSON.parse(bundle.botsRaw))
      const memoriesData = z
        .array(exportBotMemoryDtoSchema)
        .parse(JSON.parse(bundle.botMemoriesRaw))
      const sourcesData = z
        .array(exportKnowledgeSourceDtoSchema)
        .parse(JSON.parse(bundle.sourcesRaw))
      const conversationBundles = z
        .array(exportConversationBundleDtoSchema)
        .parse(JSON.parse(bundle.conversationsRaw))

      // 5. Verify checksums of all declared files in manifest
      for (const declaredFile of manifest.files) {
        const entryPath = path.join(stagingDir, declaredFile.path)
        if (!fs.existsSync(entryPath)) {
          throw new Error(
            `Archive integrity check failed: missing declared file '${declaredFile.path}'.`
          )
        }

        const entryStat = fs.statSync(entryPath)
        if (entryStat.size !== declaredFile.sizeBytes) {
          throw new Error(
            `Archive integrity check failed for '${declaredFile.path}': size mismatch (expected ${declaredFile.sizeBytes}, got ${entryStat.size}).`
          )
        }

        const calculatedSha256 = sha256File(entryPath)
        if (calculatedSha256.toLowerCase() !== declaredFile.sha256.toLowerCase()) {
          throw new Error(
            `Archive integrity check failed for '${declaredFile.path}': SHA-256 hash mismatch.`
          )
        }
      }

      // 6. Security Scan: Ensure no API keys or private keys are in metadata or documents
      const metadataToScan = [
        manifest,
        kbData,
        botsData,
        memoriesData,
        sourcesData,
        conversationBundles
      ]

      for (const obj of metadataToScan) {
        const scanResult = this.secretScanner.scanObject(obj)
        if (scanResult.hasSecret) {
          throw new Error(
            `Security check failed: Archive metadata contains potential credentials (${scanResult.patternName}). Import rejected.`
          )
        }
      }

      // Scan text documents in staging
      for (const doc of stagedDocuments.values()) {
        const lower = doc.fileType.toLowerCase()
        if (lower === 'txt' || lower === 'md') {
          const content = fs.readFileSync(doc.stagedPath, 'utf8')
          const scanResult = this.secretScanner.scanText(content)
          if (scanResult.hasSecret) {
            throw new Error(
              `Security check failed: Document '${doc.sourceId}.${doc.fileType}' contains potential credentials (${scanResult.patternName}). Import rejected.`
            )
          }
        }
      }

      // 7. Cache session
      const sessionId = path.basename(stagingDir).replace(/^import-staging-/, '')
      const session: StagedImportSession = {
        sessionId,
        archivePath,
        archiveMtimeMs: stat.mtimeMs,
        archiveSizeBytes: stat.size,
        stagingDir,
        manifest,
        kbData,
        botsData,
        memoriesData,
        sourcesData,
        conversationBundles,
        stagedDocuments,
        stagedExtractedDocuments: bundle.stagedExtractedDocuments,
        stagedPreservationReports: bundle.stagedPreservationReports,
        createdAt: Date.now()
      }
      this.sessions.set(sessionId, session)

      if (this.importRecoveryService) {
        this.importRecoveryService.recordOperationStart({
          id: sessionId,
          strategy: 'new',
          targetKnowledgeBaseName: kbData.name,
          archiveSha256: sha256File(archivePath),
          archiveName: path.basename(archivePath),
          state: 'validated',
          stagingDirName: path.basename(stagingDir)
        })
      }

      // 8. Build Preview DTO
      const preview: ImportPreviewDto = {
        sessionId,
        archiveName: path.basename(archivePath),
        archiveSizeBytes: stat.size,
        format: manifest.format,
        schemaVersion: manifest.schemaVersion,
        exportedAt: manifest.exportedAt,
        appVersion: manifest.appVersion,
        knowledgeBase: {
          id: kbData.id,
          name: kbData.name,
          description: kbData.description
        },
        counts: manifest.counts,
        documentFiles: sourcesData.map((s) => ({
          id: s.id,
          originalFileName: s.originalFileName,
          fileType: s.fileType,
          sizeBytes: s.fileSizeBytes
        })),
        securityNotice:
          'All bot provider connections will be reset to disconnected state. API keys and credential references are never imported.'
      }

      return {
        success: true,
        cancelled: false,
        preview
      }
    } catch (err) {
      // Clean up staging directory on any failure
      await this.archiveExtractor.cleanStagingDirectory(stagingDir)
      throw err
    }
  }

  /**
   * Executes the staged import after user strategy selection and confirmation.
   */
  public async executeImport(rawRequest: ExecuteImportRequest): Promise<ExecuteImportResultDto> {
    const parseResult = executeImportRequestSchema.safeParse(rawRequest)
    if (!parseResult.success) {
      const issueMsg = parseResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      const err = new Error(`Invalid import execution request: ${issueMsg}`)
      ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
      throw err
    }

    const request = parseResult.data
    const session = this.sessions.get(request.sessionId)
    if (!session) {
      const err = new Error('Import session expired or not found. Please select the archive again.')
      ;(err as unknown as { code: string }).code = 'IMPORT_SESSION_EXPIRED'
      throw err
    }

    // TOCTOU check: verify archive file still exists and has not been modified
    try {
      const currentStat = fs.statSync(session.archivePath)
      if (Math.abs(currentStat.mtimeMs - session.archiveMtimeMs) > 10) {
        throw new Error(
          'Archive file was modified on disk after preview. Please reselect the file.'
        )
      }
    } catch (err: unknown) {
      await this.cancelImportInternal(session.sessionId)
      const errorMsg = err instanceof Error ? err.message : 'Archive file verification failed.'
      const e = new Error(errorMsg)
      ;(e as unknown as { code: string }).code = 'ARCHIVE_MODIFIED'
      throw e
    }

    const { strategy, targetKnowledgeBaseId, confirmationName } = request

    // Validate strategy requirements
    let finalKnowledgeBaseId: string
    let finalKnowledgeBaseName: string

    if (strategy === 'new') {
      finalKnowledgeBaseId = randomUUID()
      finalKnowledgeBaseName = session.kbData.name
    } else {
      if (!targetKnowledgeBaseId) {
        const err = new Error(`Target Knowledge Base ID is required for '${strategy}' strategy.`)
        ;(err as unknown as { code: string }).code = 'TARGET_KB_REQUIRED'
        throw err
      }

      const existingKb = this.kbRepository.getById(targetKnowledgeBaseId)
      if (!existingKb) {
        const err = new Error(`Target Knowledge Base '${targetKnowledgeBaseId}' not found.`)
        ;(err as unknown as { code: string }).code = 'TARGET_KB_NOT_FOUND'
        throw err
      }
      finalKnowledgeBaseId = targetKnowledgeBaseId

      if (strategy === 'replace') {
        if (!confirmationName || confirmationName.trim() !== existingKb.name.trim()) {
          const err = new Error(
            `Confirmation name does not match target Knowledge Base name '${existingKb.name}'. Replacement aborted.`
          )
          ;(err as unknown as { code: string }).code = 'CONFIRMATION_MISMATCH'
          throw err
        }
        finalKnowledgeBaseName = session.kbData.name
      } else {
        // merge keeps existing name
        finalKnowledgeBaseName = existingKb.name
      }
    }

    // Prepare destination originals storage
    const targetOriginalsDir =
      await this.storageManager.ensureOriginalsDirectory(finalKnowledgeBaseId)

    // For replace strategy: quarantine existing target originals directory so we can rollback on failure
    let quarantineDir: string | null = null
    if (strategy === 'replace') {
      try {
        const existingFiles = fs.readdirSync(targetOriginalsDir)
        if (existingFiles.length > 0) {
          const parentDir = path.dirname(targetOriginalsDir)
          quarantineDir = path.join(parentDir, `.quarantine_originals_${Date.now()}`)
          fs.renameSync(targetOriginalsDir, quarantineDir)
          await this.storageManager.ensureOriginalsDirectory(finalKnowledgeBaseId)
          this.importRecoveryService?.transition(session.sessionId, 'quarantining', {
            strategy,
            targetKnowledgeBaseId: finalKnowledgeBaseId,
            quarantineDirName: path.basename(quarantineDir)
          })
        }
      } catch (err: unknown) {
        // If quarantine fails, abort before touching DB
        throw new Error(
          `Failed to create originals quarantine: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        )
      }
    }

    // Build ID remapping tables
    const botIdMap = new Map<string, string>() // oldBotId -> newBotId
    const sourceIdMap = new Map<string, string>() // oldSourceId -> newSourceId
    const conversationIdMap = new Map<string, string>() // oldConvId -> newConvId

    for (const bot of session.botsData) {
      botIdMap.set(bot.id, randomUUID())
    }

    for (const source of session.sourcesData) {
      sourceIdMap.set(source.id, randomUUID())
    }

    for (const bundle of session.conversationBundles) {
      conversationIdMap.set(bundle.conversation.id, randomUUID())
    }

    // Filesystem promotion: copy original source documents into managed storage
    const copiedFiles: string[] = []
    let isDbCommitted = false
    try {
      this.importRecoveryService?.transition(session.sessionId, 'files_promoting', {
        strategy,
        targetKnowledgeBaseId: finalKnowledgeBaseId,
        remapping: {
          bots: Object.fromEntries(botIdMap),
          sources: Object.fromEntries(sourceIdMap),
          conversations: Object.fromEntries(conversationIdMap)
        }
      })
      for (const source of session.sourcesData) {
        const newSourceId = sourceIdMap.get(source.id)!
        const stagedDoc = session.stagedDocuments.get(source.id)

        if (!stagedDoc || !fs.existsSync(stagedDoc.stagedPath)) {
          throw new Error(`Source file '${source.fileName}' not found in staged archive.`)
        }

        const destPath = this.storageManager.resolveOriginalPath(
          finalKnowledgeBaseId,
          newSourceId,
          source.fileType
        )

        fs.copyFileSync(stagedDoc.stagedPath, destPath)
        copiedFiles.push(destPath)

        // Verify copy integrity
        const destStat = fs.statSync(destPath)
        if (destStat.size !== source.fileSizeBytes) {
          throw new Error(`Integrity check failed while copying '${source.fileName}'.`)
        }
        const copiedHash = sha256File(destPath)
        if (copiedHash.toLowerCase() !== source.contentHash.toLowerCase()) {
          throw new Error(`SHA-256 hash mismatch after copying '${source.fileName}'.`)
        }
      }

      this.importRecoveryService?.transition(session.sessionId, 'database_committing', {
        promotedFiles: copiedFiles
      })

      // Execute atomic database mutations
      const now = Date.now()
      const dbTx = this.db.transaction(() => {
        if (strategy === 'new') {
          // 1. Insert new Knowledge Base row
          const insertKbStmt = this.db.prepare(`
            INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at, archived_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
          `)
          insertKbStmt.run(
            finalKnowledgeBaseId,
            finalKnowledgeBaseName,
            session.kbData.description,
            `documents/${finalKnowledgeBaseId}`,
            now,
            now
          )
        } else if (strategy === 'replace') {
          // 1. Cascade delete existing bots and knowledge_sources in target KB
          // SQLite PRAGMA foreign_keys = ON cascades deletion to:
          // bots -> bot_memories, conversations, messages, agent_runs, tool_events
          // knowledge_sources -> knowledge_chunks (triggers delete knowledge_fts)
          this.db.prepare('DELETE FROM bots WHERE knowledge_base_id = ?').run(finalKnowledgeBaseId)
          this.db
            .prepare('DELETE FROM knowledge_sources WHERE knowledge_base_id = ?')
            .run(finalKnowledgeBaseId)

          // Update Knowledge Base row
          this.db
            .prepare(
              `
            UPDATE knowledge_bases
            SET name = ?, description = ?, updated_at = ?
            WHERE id = ?
          `
            )
            .run(finalKnowledgeBaseName, session.kbData.description, now, finalKnowledgeBaseId)
        } else {
          // merge: update KB updated_at
          this.db
            .prepare('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?')
            .run(now, finalKnowledgeBaseId)
        }

        // 2. Insert Bots (MANDATORY SECURITY INVARIANT: provider_connection_id is ALWAYS NULL)
        const insertBotStmt = this.db.prepare(`
          INSERT INTO bots (
            id, knowledge_base_id, provider_connection_id, name, description,
            system_prompt, model_id, status, tool_permissions_json, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const bot of session.botsData) {
          const newBotId = botIdMap.get(bot.id)!
          insertBotStmt.run(
            newBotId,
            finalKnowledgeBaseId,
            bot.name,
            bot.description ?? '',
            bot.systemPrompt ?? '',
            bot.modelId,
            bot.status ?? 'active',
            JSON.stringify(bot.toolPermissions ?? []),
            now,
            now
          )
        }

        // 3. Insert Bot Memories
        const insertMemoryStmt = this.db.prepare(`
          INSERT INTO bot_memories (
            id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)

        for (const memory of session.memoriesData) {
          const newBotId = botIdMap.get(memory.botId)
          if (newBotId) {
            insertMemoryStmt.run(
              randomUUID(),
              newBotId,
              finalKnowledgeBaseId,
              memory.memoryType,
              memory.content,
              memory.createdAt || now,
              memory.updatedAt || now
            )
          }
        }

        // 4. Insert Knowledge Sources (initial status 'queued', indexed_at NULL)
        const insertSourceStmt = this.db.prepare(`
          INSERT INTO knowledge_sources (
            id, knowledge_base_id, file_name, original_file_name, relative_file_path,
            file_type, mime_type, file_size, content_hash, indexing_status,
            error_message, created_at, updated_at, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL)
        `)

        const insertExtractedDocStmt = this.db.prepare(`
          INSERT INTO knowledge_extracted_documents (
            source_id, schema_version, document_json, document_hash, document_size_bytes, block_count, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
        `)

        const insertValidationReportStmt = this.db.prepare(`
          INSERT INTO knowledge_document_validation (
            source_id, schema_version, status, extraction_status, chunk_coverage_status, report_json, report_hash, created_at, updated_at
          ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const source of session.sourcesData) {
          const newSourceId = sourceIdMap.get(source.id)!
          insertSourceStmt.run(
            newSourceId,
            finalKnowledgeBaseId,
            source.fileName,
            source.originalFileName,
            `originals/${newSourceId}.${source.fileType}`,
            source.fileType,
            source.mimeType,
            source.fileSizeBytes,
            source.contentHash,
            now,
            now
          )

          // Restore extracted document if bundled
          const stagedDocPath = session.stagedExtractedDocuments?.get(source.id)
          if (stagedDocPath && fs.existsSync(stagedDocPath)) {
            try {
              const rawJson = fs.readFileSync(stagedDocPath, 'utf8')
              const parsedDoc = universalDocumentSchema.parse(JSON.parse(rawJson))
              const updatedDoc = {
                ...parsedDoc,
                id: newSourceId,
                sourceInfo: {
                  ...parsedDoc.sourceInfo,
                  sourceId: newSourceId,
                  knowledgeBaseId: finalKnowledgeBaseId
                }
              }
              const serializedJson = JSON.stringify(updatedDoc)
              const hash = crypto.createHash('sha256').update(serializedJson).digest('hex')
              insertExtractedDocStmt.run(
                newSourceId,
                serializedJson,
                hash,
                Buffer.byteLength(serializedJson, 'utf8'),
                updatedDoc.blocks.length,
                now,
                now
              )
            } catch (docErr) {
              console.warn(`Failed to restore extracted document for source ${source.id}:`, docErr)
            }
          }

          // Restore preservation report if bundled
          const stagedReportPath = session.stagedPreservationReports?.get(source.id)
          if (stagedReportPath && fs.existsSync(stagedReportPath)) {
            try {
              const rawJson = fs.readFileSync(stagedReportPath, 'utf8')
              const parsedReport = documentPreservationReportSchema.parse(JSON.parse(rawJson))
              const updatedReport = {
                ...parsedReport,
                sourceId: newSourceId
              }
              const serializedJson = JSON.stringify(updatedReport)
              const hash = crypto.createHash('sha256').update(serializedJson).digest('hex')
              insertValidationReportStmt.run(
                newSourceId,
                updatedReport.status,
                updatedReport.extractionStatus,
                updatedReport.chunkCoverageStatus,
                serializedJson,
                hash,
                now,
                now
              )
            } catch (repErr) {
              console.warn(`Failed to restore preservation report for source ${source.id}:`, repErr)
            }
          }
        }

        // 5. Insert Conversations and Messages
        const insertConvStmt = this.db.prepare(`
          INSERT INTO conversations (
            id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)

        const insertMsgStmt = this.db.prepare(`
          INSERT INTO messages (
            id, conversation_id, role, content, content_format,
            metadata_json, token_usage_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const bundle of session.conversationBundles) {
          const newBotId = botIdMap.get(bundle.conversation.botId)
          if (newBotId) {
            const newConvId = conversationIdMap.get(bundle.conversation.id)!
            insertConvStmt.run(
              newConvId,
              newBotId,
              finalKnowledgeBaseId,
              bundle.conversation.title,
              bundle.conversation.createdAt || now,
              bundle.conversation.updatedAt || now,
              bundle.conversation.archivedAt ?? null
            )

            for (const msg of bundle.messages) {
              insertMsgStmt.run(
                randomUUID(),
                newConvId,
                msg.role,
                msg.content,
                msg.contentFormat ?? 'markdown',
                JSON.stringify(msg.metadata ?? {}),
                JSON.stringify({}),
                msg.createdAt || now
              )
            }
          }
        }
      })

      dbTx()
      isDbCommitted = true
      this.importRecoveryService?.transition(session.sessionId, 'database_committed')
    } catch (err) {
      if (!isDbCommitted) {
        this.importRecoveryService?.transition(session.sessionId, 'rolling_back')
        // Rollback filesystem changes
        for (const f of copiedFiles) {
          try {
            fs.unlinkSync(f)
          } catch {
            // Ignore
          }
        }

        // If quarantine existed, restore it
        if (quarantineDir) {
          try {
            fs.rmSync(targetOriginalsDir, { recursive: true, force: true })
            fs.renameSync(quarantineDir, targetOriginalsDir)
          } catch {
            this.importRecoveryService?.transition(session.sessionId, 'recovery_required', {
              errorMessage: 'Failed to restore originals from quarantine during rollback.'
            })
          }
        }

        this.importRecoveryService?.transition(session.sessionId, 'failed', {
          errorMessage: err instanceof Error ? err.message : String(err)
        })
      }

      await this.cancelImportInternal(session.sessionId)
      throw err
    }

    // 8. Rebuild document chunks and SQLite FTS5 indexes from restored original files
    let reindexSuccessCount = 0
    let reindexFailCount = 0

    this.importRecoveryService?.transition(session.sessionId, 'indexing')
    if (this.documentLifecycleService) {
      for (const source of session.sourcesData) {
        const newSourceId = sourceIdMap.get(source.id)!
        try {
          await this.documentLifecycleService.reindex({
            knowledgeBaseId: finalKnowledgeBaseId,
            sourceId: newSourceId
          })
          reindexSuccessCount++
        } catch {
          reindexFailCount++
        }
      }
    } else {
      reindexSuccessCount = session.sourcesData.length
    }

    // 9. Verification & Durable Quarantine Cleanup
    this.importRecoveryService?.transition(session.sessionId, 'verifying')
    let verificationPassed = true
    for (const filePath of copiedFiles) {
      if (!fs.existsSync(filePath)) {
        verificationPassed = false
        break
      }
    }

    if (!verificationPassed) {
      this.importRecoveryService?.transition(session.sessionId, 'recovery_required', {
        errorMessage: 'Post-import verification failed: one or more promoted files missing.'
      })
      throw new Error('Post-import verification failed: promoted files missing.')
    }

    // Clean up quarantine ONLY after verification passes
    if (quarantineDir) {
      try {
        fs.rmSync(quarantineDir, { recursive: true, force: true })
      } catch {
        // Non-critical cleanup
      }
    }

    this.importRecoveryService?.transition(session.sessionId, 'completed')

    // 10. Clean up staging directory and remove session
    await this.cancelImportInternal(session.sessionId)

    const totalMessages = session.conversationBundles.reduce((acc, c) => acc + c.messages.length, 0)

    return {
      success: true,
      cancelled: false,
      strategy,
      knowledgeBaseId: finalKnowledgeBaseId,
      knowledgeBaseName: finalKnowledgeBaseName,
      counts: {
        bots: session.botsData.length,
        memories: session.memoriesData.length,
        sources: session.sourcesData.length,
        conversations: session.conversationBundles.length,
        messages: totalMessages,
        indexedSources: reindexSuccessCount,
        failedSources: reindexFailCount
      }
    }
  }

  /**
   * Cancels a pending import session and cleans up its temporary staging files.
   */
  public async cancelImport(rawRequest: CancelImportRequest): Promise<CancelImportResultDto> {
    const parseResult = cancelImportRequestSchema.safeParse(rawRequest)
    if (!parseResult.success) {
      const issueMsg = parseResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      const err = new Error(`Invalid cancel import request: ${issueMsg}`)
      ;(err as unknown as { code: string }).code = 'VALIDATION_ERROR'
      throw err
    }

    const { sessionId } = parseResult.data
    await this.cancelImportInternal(sessionId)
    return { success: true }
  }

  /**
   * Internal session cleanup helper.
   */
  private async cancelImportInternal(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.delete(sessionId)
      try {
        const currentEntry = this.importRecoveryService?.getJournalEntry(sessionId)
        if (
          currentEntry &&
          !['completed', 'failed', 'recovery_required'].includes(currentEntry.state)
        ) {
          this.importRecoveryService?.transition(sessionId, 'cancelled', {
            errorMessage: 'Import session cancelled.'
          })
        }
      } catch {
        // Non-critical journal update
      }
      await this.archiveExtractor.cleanStagingDirectory(session.stagingDir)
    }
  }

  /**
   * Automatically clears expired staging sessions.
   */
  private pruneStaleSessions(): void {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.sessionTtlMs) {
        void this.cancelImportInternal(sessionId)
      }
    }
  }
}
