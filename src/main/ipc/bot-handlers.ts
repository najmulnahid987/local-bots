import { ipcMain, BrowserWindow } from 'electron'
import { BOT_IPC_CHANNELS, type BotDto, type DeleteBotResultDto } from '../../shared/ipc'
import { toKnowledgeBaseDto, type KnowledgeBaseDto } from '../../shared/knowledge-bases'
import { BotManagerService } from '../services/bot-manager'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateBotIpcPayload,
  botByIdIpcSchema,
  botCreateIpcSchema,
  botUpdateIpcSchema,
  botListIpcSchema,
  workspaceActivateIpcSchema
} from './bot-validation'
import { sanitizeBotErrorMessage } from '../services/bot-errors'

export interface BotErrorDto {
  code: string
  message: string
}

/**
 * Formats any caught error into a safe JSON-stringified BotErrorDto.
 * Strips secrets, filesystem paths, and internal stack traces.
 */
export function formatBotIpcError(err: unknown): Error {
  if (typeof err === 'string') {
    const safeDto: BotErrorDto = {
      code: 'BOT_OPERATION_FAILED',
      message: sanitizeBotErrorMessage(err)
    }
    return new Error(JSON.stringify(safeDto))
  }

  if (err && typeof err === 'object') {
    if ('message' in err && typeof err.message === 'string') {
      try {
        const parsed = JSON.parse(err.message) as { code?: string; message?: string }
        if (parsed.code && parsed.message) {
          const safeDto: BotErrorDto = {
            code: parsed.code,
            message: sanitizeBotErrorMessage(parsed.message)
          }
          return new Error(JSON.stringify(safeDto))
        }
      } catch {
        // Not JSON, continue below
      }
    }

    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'BOT_OPERATION_FAILED'
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    const safeDto: BotErrorDto = {
      code,
      message: sanitizeBotErrorMessage(rawMessage)
    }
    return new Error(JSON.stringify(safeDto))
  }
  const fallback: BotErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the Bot operation.'
  }
  return new Error(JSON.stringify(fallback))
}

const monitoredSenders = new Set<number | string>()

export interface DestroyableSenderLike {
  id?: number | string
  isDestroyed?: () => boolean
  once?: (event: string, listener: () => void) => void
}

/**
 * Attaches a one-time destruction listener to the renderer's webContents.
 * When the webContents is destroyed, its active workspace context is automatically purged.
 */
export function attachSessionCleanup(
  sender: DestroyableSenderLike | null | undefined,
  activeContext?: ActiveWorkspaceContext
): void {
  if (!sender || !activeContext) return
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
    return
  }

  const senderId = sender.id ?? 1
  if (monitoredSenders.has(senderId)) {
    return
  }

  if (typeof sender.once === 'function') {
    monitoredSenders.add(senderId)
    sender.once('destroyed', () => {
      monitoredSenders.delete(senderId)
      activeContext.clearActiveWorkspace(senderId)
    })
  }
}

/**
 * Resets the monitored senders registry (primarily for isolated test tear-downs).
 */
export function resetMonitoredSenders(): void {
  monitoredSenders.clear()
}

export interface BotIpcHandlerOptions {
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  botManager: BotManagerService
  activeContext?: ActiveWorkspaceContext
}

/**
 * Registers secure, type-safe Main process IPC handlers for Bot management and workspace context.
 * Enforces sender validation, session isolation, and strict input schema validation on every call.
 */
export function registerBotIpcHandlers(options: BotIpcHandlerOptions): void {
  const { getMainWindow, botManager, activeContext } = options

  const assertAuthorizedSender = (
    event: IpcSenderEventLike
  ): { mainWindow: BrowserWindowLike; sessionId: number | string } => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.'
        })
      )
    }

    const sender = event.sender as DestroyableSenderLike
    attachSessionCleanup(sender, activeContext)

    const sessionId = sender?.id ?? 1
    return { mainWindow: mainWindow!, sessionId }
  }

  // 1. List Bots
  ipcMain.removeHandler(BOT_IPC_CHANNELS.LIST)
  ipcMain.handle(
    BOT_IPC_CHANNELS.LIST,
    async (event, rawPayload: unknown): Promise<readonly BotDto[]> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotIpcPayload(botListIpcSchema, rawPayload ?? {})
        return botManager.listBots(sessionId, payload)
      } catch (err) {
        throw formatBotIpcError(err)
      }
    }
  )

  // 2. Get Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.GET)
  ipcMain.handle(
    BOT_IPC_CHANNELS.GET,
    async (event, rawPayload: unknown): Promise<BotDto | null> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { id } = validateBotIpcPayload(botByIdIpcSchema, rawPayload)
        return botManager.getBot(sessionId, id)
      } catch (err) {
        throw formatBotIpcError(err)
      }
    }
  )

  // 3. Create Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.CREATE)
  ipcMain.handle(BOT_IPC_CHANNELS.CREATE, async (event, rawPayload: unknown): Promise<BotDto> => {
    try {
      const { sessionId } = assertAuthorizedSender(event)
      const payload = validateBotIpcPayload(botCreateIpcSchema, rawPayload)
      return botManager.createBot(sessionId, payload)
    } catch (err) {
      throw formatBotIpcError(err)
    }
  })

  // 4. Update Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.UPDATE)
  ipcMain.handle(BOT_IPC_CHANNELS.UPDATE, async (event, rawPayload: unknown): Promise<BotDto> => {
    try {
      const { sessionId } = assertAuthorizedSender(event)
      const { id, input } = validateBotIpcPayload(botUpdateIpcSchema, rawPayload)
      return botManager.updateBot(sessionId, id, input)
    } catch (err) {
      throw formatBotIpcError(err)
    }
  })

  // 5. Archive Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.ARCHIVE)
  ipcMain.handle(BOT_IPC_CHANNELS.ARCHIVE, async (event, rawPayload: unknown): Promise<BotDto> => {
    try {
      const { sessionId } = assertAuthorizedSender(event)
      const { id } = validateBotIpcPayload(botByIdIpcSchema, rawPayload)
      return botManager.archiveBot(sessionId, id)
    } catch (err) {
      throw formatBotIpcError(err)
    }
  })

  // 6. Unarchive Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.UNARCHIVE)
  ipcMain.handle(
    BOT_IPC_CHANNELS.UNARCHIVE,
    async (event, rawPayload: unknown): Promise<BotDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { id } = validateBotIpcPayload(botByIdIpcSchema, rawPayload)
        return botManager.unarchiveBot(sessionId, id)
      } catch (err) {
        throw formatBotIpcError(err)
      }
    }
  )

  // 7. Delete Bot
  ipcMain.removeHandler(BOT_IPC_CHANNELS.DELETE)
  ipcMain.handle(
    BOT_IPC_CHANNELS.DELETE,
    async (event, rawPayload: unknown): Promise<DeleteBotResultDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { id } = validateBotIpcPayload(botByIdIpcSchema, rawPayload)
        return botManager.deleteBot(sessionId, id)
      } catch (err) {
        throw formatBotIpcError(err)
      }
    }
  )

  // Workspace Activation (Registers both BOT and KB channels for maximum compatibility)
  const handleActivateWorkspace = async (
    event: IpcSenderEventLike,
    rawPayload: unknown
  ): Promise<KnowledgeBaseDto> => {
    try {
      const { sessionId } = assertAuthorizedSender(event)
      const { id } = validateBotIpcPayload(workspaceActivateIpcSchema, rawPayload)
      const kb = botManager.activateWorkspace(sessionId, id)
      return toKnowledgeBaseDto(kb)
    } catch (err) {
      throw formatBotIpcError(err)
    }
  }

  ipcMain.removeHandler(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE)
  ipcMain.handle(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, handleActivateWorkspace)

  // Workspace Deactivation
  const handleDeactivateWorkspace = async (
    event: IpcSenderEventLike
  ): Promise<{ success: boolean }> => {
    try {
      const { sessionId } = assertAuthorizedSender(event)
      const cleared = botManager.clearWorkspace(sessionId)
      return { success: cleared }
    } catch (err) {
      throw formatBotIpcError(err)
    }
  }

  ipcMain.removeHandler(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)
  ipcMain.handle(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE, handleDeactivateWorkspace)
}

/**
 * Registers safe stub handlers when the Bot subsystem fails during initialization.
 */
export function registerFailingBotIpcHandlers(
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
        code: 'BOT_SUBSYSTEM_FAILED',
        message: sanitizeBotErrorMessage(reason)
      })
    )
    throw formatBotIpcError(err)
  }

  const channels = [
    BOT_IPC_CHANNELS.LIST,
    BOT_IPC_CHANNELS.GET,
    BOT_IPC_CHANNELS.CREATE,
    BOT_IPC_CHANNELS.UPDATE,
    BOT_IPC_CHANNELS.ARCHIVE,
    BOT_IPC_CHANNELS.UNARCHIVE,
    BOT_IPC_CHANNELS.DELETE,
    BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE,
    BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE
  ]

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
