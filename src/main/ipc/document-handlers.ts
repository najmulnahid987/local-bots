import { ipcMain, BrowserWindow, dialog } from 'electron'
import {
  KB_DOCS_IPC_CHANNELS,
  type KnowledgeSourceDto,
  type DocumentImportResultDto,
  type DocumentSearchResultDto
} from '../../shared/ipc'
import { DocumentIngestionService } from '../documents/ingestion/document-ingestion-service'
import { DocumentSearchService } from '../documents/search'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateDocumentIpcPayload,
  sanitizeDocumentErrorMessage,
  toKnowledgeSourceDto,
  documentSelectAndImportIpcSchema,
  documentListIpcSchema,
  documentGetIpcSchema,
  documentSearchIpcSchema
} from './document-validation'

export interface DocumentErrorDto {
  code: string
  message: string
}

/**
 * Formats any caught error into a safe JSON-stringified DocumentErrorDto.
 * Strips secrets, filesystem paths, and internal stack traces.
 */
export function formatDocumentIpcError(err: unknown): Error {
  if (typeof err === 'string') {
    const safeDto: DocumentErrorDto = {
      code: 'DOCUMENT_OPERATION_FAILED',
      message: sanitizeDocumentErrorMessage(err)
    }
    return new Error(JSON.stringify(safeDto))
  }

  if (err && typeof err === 'object') {
    if ('message' in err && typeof err.message === 'string') {
      try {
        const parsed = JSON.parse(err.message) as { code?: string; message?: string }
        if (parsed.code && parsed.message) {
          const safeDto: DocumentErrorDto = {
            code: parsed.code,
            message: sanitizeDocumentErrorMessage(parsed.message)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not JSON, continue below
      }
    }

    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'DOCUMENT_OPERATION_FAILED'
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    const safeDto: DocumentErrorDto = {
      code,
      message: sanitizeDocumentErrorMessage(rawMessage)
    }
    return new Error(JSON.stringify(safeDto))
  }
  const fallback: DocumentErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the document operation.'
  }
  return new Error(JSON.stringify(fallback))
}

export interface DocumentDialogOperations {
  showOpenDialog(
    browserWindow: BrowserWindowLike | BrowserWindow,
    options: Electron.OpenDialogOptions
  ): Promise<Electron.OpenDialogReturnValue>
}

export interface DocumentIpcHandlerOptions {
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  ingestionService: DocumentIngestionService
  sourceRepository: KnowledgeSourceRepository
  searchService?: DocumentSearchService
  dialogOps?: DocumentDialogOperations
}

/**
 * Registers secure, type-safe Main process IPC handlers for document management operations.
 * Enforces sender validation and strict input schema validation on every call.
 */
export function registerDocumentIpcHandlers(options: DocumentIpcHandlerOptions): void {
  const { getMainWindow, ingestionService, sourceRepository, dialogOps } = options
  const searchService = options.searchService ?? new DocumentSearchService({ sourceRepository })

  const assertAuthorizedSender = (event: IpcSenderEventLike): BrowserWindowLike => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }
    return mainWindow!
  }

  // 1. Select and Import Document via native Main-process file dialog
  ipcMain.removeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT)
  ipcMain.handle(
    KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT,
    async (event, rawPayload: unknown): Promise<DocumentImportResultDto> => {
      try {
        const mainWindow = assertAuthorizedSender(event)
        const payload = validateDocumentIpcPayload(documentSelectAndImportIpcSchema, rawPayload)

        if (!sourceRepository.knowledgeBaseExists(payload.knowledgeBaseId)) {
          throw new Error(
            JSON.stringify({
              code: 'KNOWLEDGE_BASE_NOT_FOUND',
              message: `Knowledge Base '${payload.knowledgeBaseId}' could not be found.`
            })
          )
        }

        const openDialogFn = dialogOps?.showOpenDialog ?? dialog.showOpenDialog
        const dialogResult = await openDialogFn(mainWindow as unknown as BrowserWindow, {
          title: 'Import Knowledge Document',
          buttonLabel: 'Import',
          properties: ['openFile'],
          filters: [
            {
              name: 'Supported Documents (*.txt, *.md, *.pdf)',
              extensions: ['txt', 'md', 'pdf']
            },
            { name: 'All Files (*.*)', extensions: ['*'] }
          ]
        })

        if (
          dialogResult.canceled ||
          !dialogResult.filePaths ||
          dialogResult.filePaths.length === 0
        ) {
          return {
            status: 'cancelled',
            duplicate: false,
            cancelled: true
          }
        }

        const selectedFilePath = dialogResult.filePaths[0]

        const ingestResult = await ingestionService.ingest({
          knowledgeBaseId: payload.knowledgeBaseId,
          filePath: selectedFilePath,
          allowDuplicate: payload.allowDuplicate
        })

        if (ingestResult.status === 'duplicate') {
          return {
            status: 'duplicate',
            duplicate: true,
            cancelled: false,
            existingSource: ingestResult.existingSource
          }
        }

        const sourceWithCount = sourceRepository.getByIdWithChunkCount(
          ingestResult.sourceId,
          payload.knowledgeBaseId
        )

        const sourceDto = sourceWithCount
          ? toKnowledgeSourceDto(sourceWithCount)
          : toKnowledgeSourceDto({
              ...ingestResult.source,
              chunk_count: ingestResult.totalChunks
            })

        return {
          status: 'completed',
          duplicate: false,
          cancelled: false,
          source: sourceDto,
          totalChunks: ingestResult.totalChunks,
          totalTokens: ingestResult.totalTokens
        }
      } catch (err) {
        throw formatDocumentIpcError(err)
      }
    }
  )

  // 2. List Documents in a Knowledge Base
  ipcMain.removeHandler(KB_DOCS_IPC_CHANNELS.LIST)
  ipcMain.handle(
    KB_DOCS_IPC_CHANNELS.LIST,
    async (event, rawPayload: unknown): Promise<readonly KnowledgeSourceDto[]> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateDocumentIpcPayload(documentListIpcSchema, rawPayload)

        if (!sourceRepository.knowledgeBaseExists(payload.knowledgeBaseId)) {
          throw new Error(
            JSON.stringify({
              code: 'KNOWLEDGE_BASE_NOT_FOUND',
              message: `Knowledge Base '${payload.knowledgeBaseId}' could not be found.`
            })
          )
        }

        const rows = sourceRepository.listWithChunkCounts(payload.knowledgeBaseId)
        return rows.map(toKnowledgeSourceDto)
      } catch (err) {
        throw formatDocumentIpcError(err)
      }
    }
  )

  // 3. Get Single Document Metadata
  ipcMain.removeHandler(KB_DOCS_IPC_CHANNELS.GET)
  ipcMain.handle(
    KB_DOCS_IPC_CHANNELS.GET,
    async (event, rawPayload: unknown): Promise<KnowledgeSourceDto | null> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateDocumentIpcPayload(documentGetIpcSchema, rawPayload)

        const row = sourceRepository.getByIdWithChunkCount(
          payload.sourceId,
          payload.knowledgeBaseId
        )
        if (!row) {
          return null
        }
        return toKnowledgeSourceDto(row)
      } catch (err) {
        throw formatDocumentIpcError(err)
      }
    }
  )

  // 4. Search Documents via FTS5
  ipcMain.removeHandler(KB_DOCS_IPC_CHANNELS.SEARCH)
  ipcMain.handle(
    KB_DOCS_IPC_CHANNELS.SEARCH,
    async (event, rawPayload: unknown): Promise<readonly DocumentSearchResultDto[]> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateDocumentIpcPayload(documentSearchIpcSchema, rawPayload)
        return await searchService.search(payload)
      } catch (err) {
        throw formatDocumentIpcError(err)
      }
    }
  )
}

/**
 * Registers fallback handlers when the document subsystem fails to initialize.
 * Ensures any Renderer invocations reject with safe, structured errors.
 */
export function registerFailingDocumentIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  reason: string
): void {
  const assertAuthorizedSender = (event: IpcSenderEventLike): BrowserWindowLike => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }
    return mainWindow!
  }

  const failingHandler = async (event: IpcSenderEventLike): Promise<never> => {
    assertAuthorizedSender(event)
    const err = new Error(
      JSON.stringify({
        code: 'SUBSYSTEM_INITIALIZATION_FAILED',
        message: sanitizeDocumentErrorMessage(reason)
      })
    )
    throw err
  }

  for (const channel of Object.values(KB_DOCS_IPC_CHANNELS)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
