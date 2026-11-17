import { ipcMain, BrowserWindow } from 'electron'
import {
  KB_IPC_CHANNELS,
  type KnowledgeBaseDto,
  type KnowledgeBaseOverviewDto,
  type DeleteKnowledgeBaseResult,
  type ExportKnowledgeBaseResultDto,
  type ImportPreviewResultDto,
  type ExecuteImportResultDto,
  type CancelImportResultDto
} from '../../shared/ipc'
import { KnowledgeBaseManager } from '../services/knowledge-base-manager'
import type { BackupExportManager } from '../services/backup-export-manager'
import type { BackupImportManager } from '../services/backup-import-manager'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateKnowledgeBaseIpcPayload,
  sanitizeKnowledgeBaseErrorMessage,
  knowledgeBaseByIdIpcSchema,
  knowledgeBaseCreateIpcSchema,
  knowledgeBaseUpdateIpcSchema,
  knowledgeBaseArchiveIpcSchema,
  knowledgeBaseUnarchiveIpcSchema,
  knowledgeBaseDeleteIpcSchema,
  knowledgeBaseListIpcSchema,
  knowledgeBaseOverviewIpcSchema,
  knowledgeBaseExportIpcSchema,
  knowledgeBaseImportExecuteIpcSchema,
  knowledgeBaseImportCancelIpcSchema
} from './knowledge-base-validation'

export interface KnowledgeBaseErrorDto {
  code: string
  message: string
}

/**
 * Formats any caught error into a safe JSON-stringified KnowledgeBaseErrorDto.
 * Strips secrets, filesystem paths, and internal stack traces.
 */
export function formatKnowledgeBaseIpcError(err: unknown): Error {
  if (err && typeof err === 'object') {
    // Check if error message is already serialized JSON (e.g. from assertAuthorizedSender or validation)
    if ('message' in err && typeof err.message === 'string') {
      try {
        const parsed = JSON.parse(err.message) as { code?: string; message?: string }
        if (parsed.code && parsed.message) {
          const safeDto: KnowledgeBaseErrorDto = {
            code: parsed.code,
            message: sanitizeKnowledgeBaseErrorMessage(parsed.message)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not JSON, continue below
      }
    }

    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'KNOWLEDGE_BASE_OPERATION_FAILED'
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    const safeDto: KnowledgeBaseErrorDto = {
      code,
      message: sanitizeKnowledgeBaseErrorMessage(rawMessage)
    }
    return new Error(JSON.stringify(safeDto))
  }
  const fallback: KnowledgeBaseErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the Knowledge Base operation.'
  }
  return new Error(JSON.stringify(fallback))
}

/**
 * Registers secure, type-safe Main process IPC handlers for Knowledge Base operations.
 * Enforces sender validation and strict input schema validation on every call.
 */
export function registerKnowledgeBaseIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  kbManager: KnowledgeBaseManager,
  exportManager?: BackupExportManager | (() => BackupExportManager | undefined),
  importManager?: BackupImportManager | (() => BackupImportManager | undefined)
): void {
  const resolveExportManager = (): BackupExportManager | undefined => {
    if (typeof exportManager === 'function') {
      return exportManager()
    }
    return exportManager
  }

  const resolveImportManager = (): BackupImportManager | undefined => {
    if (typeof importManager === 'function') {
      return importManager()
    }
    return importManager
  }

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

  // 1. List
  ipcMain.removeHandler(KB_IPC_CHANNELS.LIST)
  ipcMain.handle(
    KB_IPC_CHANNELS.LIST,
    async (event, rawPayload: unknown): Promise<readonly KnowledgeBaseDto[]> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(
          knowledgeBaseListIpcSchema,
          rawPayload ?? {}
        )
        return await kbManager.list(payload)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 2. Get by ID
  ipcMain.removeHandler(KB_IPC_CHANNELS.GET_BY_ID)
  ipcMain.handle(
    KB_IPC_CHANNELS.GET_BY_ID,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseDto | null> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseByIdIpcSchema, rawPayload)
        return await kbManager.getById(payload.id)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 3. Create
  ipcMain.removeHandler(KB_IPC_CHANNELS.CREATE)
  ipcMain.handle(
    KB_IPC_CHANNELS.CREATE,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseDto> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseCreateIpcSchema, rawPayload)
        return await kbManager.create(payload)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 4. Update
  ipcMain.removeHandler(KB_IPC_CHANNELS.UPDATE)
  ipcMain.handle(
    KB_IPC_CHANNELS.UPDATE,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseDto | null> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseUpdateIpcSchema, rawPayload)
        return await kbManager.update(payload.id, payload.input)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 5. Archive
  ipcMain.removeHandler(KB_IPC_CHANNELS.ARCHIVE)
  ipcMain.handle(
    KB_IPC_CHANNELS.ARCHIVE,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseDto | null> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseArchiveIpcSchema, rawPayload)
        return await kbManager.archive(payload.id)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 6. Unarchive
  ipcMain.removeHandler(KB_IPC_CHANNELS.UNARCHIVE)
  ipcMain.handle(
    KB_IPC_CHANNELS.UNARCHIVE,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseDto | null> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseUnarchiveIpcSchema, rawPayload)
        return await kbManager.unarchive(payload.id)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 7. Delete
  ipcMain.removeHandler(KB_IPC_CHANNELS.DELETE)
  ipcMain.handle(
    KB_IPC_CHANNELS.DELETE,
    async (event, rawPayload: unknown): Promise<DeleteKnowledgeBaseResult> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseDeleteIpcSchema, rawPayload)
        return await kbManager.delete(payload.id)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 8. Get Overview
  ipcMain.removeHandler(KB_IPC_CHANNELS.GET_OVERVIEW)
  ipcMain.handle(
    KB_IPC_CHANNELS.GET_OVERVIEW,
    async (event, rawPayload: unknown): Promise<KnowledgeBaseOverviewDto> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseOverviewIpcSchema, rawPayload)
        return await kbManager.getOverview(payload.id)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 9. Export
  ipcMain.removeHandler(KB_IPC_CHANNELS.EXPORT)
  ipcMain.handle(
    KB_IPC_CHANNELS.EXPORT,
    async (event, rawPayload: unknown): Promise<ExportKnowledgeBaseResultDto> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(knowledgeBaseExportIpcSchema, rawPayload)
        const manager = resolveExportManager()
        if (!manager) {
          throw new Error('Export subsystem is not initialized.')
        }
        return await manager.exportKnowledgeBase(payload.knowledgeBaseId)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 10. Import: Select and Preview
  ipcMain.removeHandler(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)
  ipcMain.handle(
    KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW,
    async (event): Promise<ImportPreviewResultDto> => {
      try {
        assertAuthorizedSender(event)
        const manager = resolveImportManager()
        if (!manager) {
          throw new Error('Import subsystem is not initialized.')
        }
        return await manager.selectAndPreviewArchive()
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 11. Import: Execute
  ipcMain.removeHandler(KB_IPC_CHANNELS.IMPORT_EXECUTE)
  ipcMain.handle(
    KB_IPC_CHANNELS.IMPORT_EXECUTE,
    async (event, rawPayload: unknown): Promise<ExecuteImportResultDto> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(
          knowledgeBaseImportExecuteIpcSchema,
          rawPayload
        )
        const manager = resolveImportManager()
        if (!manager) {
          throw new Error('Import subsystem is not initialized.')
        }
        return await manager.executeImport(payload)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )

  // 12. Import: Cancel
  ipcMain.removeHandler(KB_IPC_CHANNELS.IMPORT_CANCEL)
  ipcMain.handle(
    KB_IPC_CHANNELS.IMPORT_CANCEL,
    async (event, rawPayload: unknown): Promise<CancelImportResultDto> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateKnowledgeBaseIpcPayload(
          knowledgeBaseImportCancelIpcSchema,
          rawPayload
        )
        const manager = resolveImportManager()
        if (!manager) {
          throw new Error('Import subsystem is not initialized.')
        }
        return await manager.cancelImport(payload)
      } catch (err) {
        throw formatKnowledgeBaseIpcError(err)
      }
    }
  )
}

/**
 * Registers fallback handlers when Knowledge Base subsystem initialization fails.
 */
export function registerFailingKnowledgeBaseIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  failureReason: string
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
    throw new Error(
      JSON.stringify({
        code: 'SUBSYSTEM_INITIALIZATION_FAILED',
        message: sanitizeKnowledgeBaseErrorMessage(failureReason)
      })
    )
  }

  const allChannels = Object.values(KB_IPC_CHANNELS)

  for (const channel of allChannels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
