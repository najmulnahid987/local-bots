import { ipcMain, BrowserWindow } from 'electron'
import {
  DELETION_IPC_CHANNELS,
  getDeletionPreviewRequestSchema,
  deleteEntityRequestSchema,
  type DeletionPreviewDto,
  type DeleteEntityResultDto
} from '../../shared/deletion'
import {
  KB_IPC_CHANNELS,
  KB_DOCS_IPC_CHANNELS,
  BOT_IPC_CHANNELS,
  CONVERSATION_IPC_CHANNELS
} from '../../shared/ipc'
import type { DeletionService } from '../services/deletion-service'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import { DiagnosticSanitizer } from '../services/diagnostic-sanitizer'
import { z } from 'zod'

export interface DeletionIpcHandlerOptions {
  readonly getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  readonly deletionService: DeletionService
}

const entityIdPayloadSchema = z
  .object({
    id: z.string().uuid()
  })
  .strict()

/**
 * Registers secure, sender-validated IPC handlers for deletion previews and deletion execution.
 */
export function registerDeletionIpcHandlers(options: DeletionIpcHandlerOptions): void {
  const { getMainWindow, deletionService } = options

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

  // 1. Unified Get Deletion Preview
  ipcMain.removeHandler(DELETION_IPC_CHANNELS.GET_PREVIEW)
  ipcMain.handle(
    DELETION_IPC_CHANNELS.GET_PREVIEW,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeletionPreviewDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = getDeletionPreviewRequestSchema.parse(rawPayload)
        return await deletionService.getPreview(payload.entityType, payload.entityId)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_PREVIEW_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  // 2. Unified Execute Entity Deletion
  ipcMain.removeHandler(DELETION_IPC_CHANNELS.DELETE_ENTITY)
  ipcMain.handle(
    DELETION_IPC_CHANNELS.DELETE_ENTITY,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeleteEntityResultDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = deleteEntityRequestSchema.parse(rawPayload)
        return await deletionService.deleteEntity(payload)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  // 3. Entity-specific convenience preview handlers
  ipcMain.removeHandler(KB_IPC_CHANNELS.GET_DELETION_PREVIEW)
  ipcMain.handle(
    KB_IPC_CHANNELS.GET_DELETION_PREVIEW,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeletionPreviewDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = entityIdPayloadSchema.parse(rawPayload)
        return await deletionService.getPreview('knowledge_base', payload.id)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_PREVIEW_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  ipcMain.removeHandler(BOT_IPC_CHANNELS.GET_DELETION_PREVIEW)
  ipcMain.handle(
    BOT_IPC_CHANNELS.GET_DELETION_PREVIEW,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeletionPreviewDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = entityIdPayloadSchema.parse(rawPayload)
        return await deletionService.getPreview('bot', payload.id)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_PREVIEW_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeletionPreviewDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = entityIdPayloadSchema.parse(rawPayload)
        return await deletionService.getPreview('conversation', payload.id)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_PREVIEW_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )

  ipcMain.removeHandler(KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW)
  ipcMain.handle(
    KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW,
    async (event: IpcSenderEventLike, rawPayload: unknown): Promise<DeletionPreviewDto> => {
      assertAuthorizedSender(event)
      try {
        const payload = entityIdPayloadSchema.parse(rawPayload)
        return await deletionService.getPreview('knowledge_source', payload.id)
      } catch (err: unknown) {
        const sanitized = DiagnosticSanitizer.sanitizeError(err, 'DELETION_PREVIEW_FAILED')
        throw new Error(JSON.stringify(sanitized), { cause: err })
      }
    }
  )
}

/**
 * Registers safe fallback handlers for all Deletion channels if subsystem initialization fails.
 */
export function registerFailingDeletionIpcHandlers(
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
    const sanitized = DiagnosticSanitizer.sanitizeError(reason, 'SUBSYSTEM_INITIALIZATION_FAILED')
    throw new Error(JSON.stringify(sanitized))
  }

  const channels = [
    DELETION_IPC_CHANNELS.GET_PREVIEW,
    DELETION_IPC_CHANNELS.DELETE_ENTITY,
    KB_IPC_CHANNELS.GET_DELETION_PREVIEW,
    BOT_IPC_CHANNELS.GET_DELETION_PREVIEW,
    CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW,
    KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW
  ]

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
