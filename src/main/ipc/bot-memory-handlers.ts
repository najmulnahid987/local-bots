import { ipcMain, BrowserWindow } from 'electron'
import {
  BOT_MEMORY_IPC_CHANNELS,
  type BotMemoryDto,
  type DeleteBotMemoryResultDto,
  type BotMemoryCountDto,
  toBotMemoryDto
} from '../../shared/bot-memories'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { type Bot } from '../database/repositories/types'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateBotMemoryIpcPayload,
  botMemoryCreateIpcSchema,
  botMemoryGetIpcSchema,
  botMemoryListIpcSchema,
  botMemoryUpdateIpcSchema,
  botMemoryDeleteIpcSchema,
  botMemoryCountIpcSchema,
  formatBotMemoryIpcError,
  sanitizeBotMemoryErrorMessage
} from './bot-memory-validation'
import { attachSessionCleanup, type DestroyableSenderLike } from './bot-handlers'

export interface BotMemoryIpcHandlerOptions {
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  botMemoryRepo: BotMemoryRepository
  botRepo: BotRepository
  activeContext?: ActiveWorkspaceContext
}

/**
 * Registers secure, type-safe Main process IPC handlers for Bot Memory persistence.
 *
 * Enforces:
 * 1. IPC sender and frame validation (rejects untrusted windows, child frames, popups).
 * 2. Authoritative Bot scoping: resolves the parent Knowledge Base ID from the Bot record in SQLite.
 * 3. Never trusts renderer-supplied knowledgeBaseId.
 * 4. Active workspace verification against sender session when set.
 * 5. Lifecycle integrity: blocks mutating archived bots.
 * 6. Cross-Bot isolation: prevents access, update, or deletion across different Bots.
 * 7. Error sanitization: strips stack traces, file paths, and SQL details before IPC returns.
 */
export function registerBotMemoryIpcHandlers(options: BotMemoryIpcHandlerOptions): void {
  const { getMainWindow, botMemoryRepo, botRepo, activeContext } = options

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

  const resolveAuthoritativeBot = (botId: string, sessionId: number | string): Bot => {
    const bot = botRepo.getByIdOnly(botId)
    if (!bot) {
      throw new Error(
        JSON.stringify({
          code: 'BOT_NOT_FOUND',
          message: `Bot with ID '${botId}' not found.`
        })
      )
    }

    if (activeContext?.hasActiveWorkspace(sessionId)) {
      const activeKbId = activeContext.getActiveWorkspaceId(sessionId)
      if (bot.knowledgeBaseId !== activeKbId) {
        throw new Error(
          JSON.stringify({
            code: 'BOT_KB_MISMATCH',
            message: `Bot '${bot.id}' does not belong to active Knowledge Base.`
          })
        )
      }
    }

    return bot
  }

  // 1. Create Bot Memory
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.CREATE)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.CREATE,
    async (event, rawPayload: unknown): Promise<BotMemoryDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryCreateIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        if (bot.status === 'archived') {
          throw new Error(
            JSON.stringify({
              code: 'BOT_ARCHIVED',
              message: `Cannot create memory: Bot '${bot.name}' is archived.`
            })
          )
        }

        const created = botMemoryRepo.create({
          botId: bot.id,
          knowledgeBaseId: bot.knowledgeBaseId,
          memoryType: payload.memoryType,
          content: payload.content
        })

        return toBotMemoryDto(created)
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )

  // 2. Get Bot Memory by ID
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.GET)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.GET,
    async (event, rawPayload: unknown): Promise<BotMemoryDto | null> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryGetIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        const memory = botMemoryRepo.getById(payload.memoryId, bot.id, bot.knowledgeBaseId)
        return memory ? toBotMemoryDto(memory) : null
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )

  // 3. List Bot Memories
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.LIST)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.LIST,
    async (event, rawPayload: unknown): Promise<readonly BotMemoryDto[]> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryListIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        const list = botMemoryRepo.listByBot(bot.id, bot.knowledgeBaseId, {
          memoryType: payload.memoryType
        })

        return list.map(toBotMemoryDto)
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )

  // 4. Update Bot Memory
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.UPDATE)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.UPDATE,
    async (event, rawPayload: unknown): Promise<BotMemoryDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryUpdateIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        if (bot.status === 'archived') {
          throw new Error(
            JSON.stringify({
              code: 'BOT_ARCHIVED',
              message: `Cannot update memory: Bot '${bot.name}' is archived.`
            })
          )
        }

        const updated = botMemoryRepo.update(
          payload.memoryId,
          bot.id,
          bot.knowledgeBaseId,
          payload.input
        )

        if (!updated) {
          throw new Error(
            JSON.stringify({
              code: 'BOT_MEMORY_NOT_FOUND',
              message: `Memory with ID '${payload.memoryId}' not found for Bot '${bot.name}'.`
            })
          )
        }

        return toBotMemoryDto(updated)
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )

  // 5. Delete Bot Memory
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.DELETE)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.DELETE,
    async (event, rawPayload: unknown): Promise<DeleteBotMemoryResultDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryDeleteIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        if (bot.status === 'archived') {
          throw new Error(
            JSON.stringify({
              code: 'BOT_ARCHIVED',
              message: `Cannot delete memory: Bot '${bot.name}' is archived.`
            })
          )
        }

        const success = botMemoryRepo.delete(payload.memoryId, bot.id, bot.knowledgeBaseId)
        if (!success) {
          throw new Error(
            JSON.stringify({
              code: 'BOT_MEMORY_NOT_FOUND',
              message: `Memory with ID '${payload.memoryId}' not found for Bot '${bot.name}'.`
            })
          )
        }

        return {
          success: true,
          memoryId: payload.memoryId
        }
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )

  // 6. Count Bot Memories
  ipcMain.removeHandler(BOT_MEMORY_IPC_CHANNELS.COUNT)
  ipcMain.handle(
    BOT_MEMORY_IPC_CHANNELS.COUNT,
    async (event, rawPayload: unknown): Promise<BotMemoryCountDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateBotMemoryIpcPayload(botMemoryCountIpcSchema, rawPayload)
        const bot = resolveAuthoritativeBot(payload.botId, sessionId)

        const count = botMemoryRepo.countByBot(bot.id, bot.knowledgeBaseId)
        return {
          botId: bot.id,
          count
        }
      } catch (err) {
        throw formatBotMemoryIpcError(err)
      }
    }
  )
}

/**
 * Registers safe fallback handlers for all Bot Memory channels if
 * Main process subsystem initialization fails.
 */
export function registerFailingBotMemoryIpcHandlers(
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
    const err = {
      code: 'SUBSYSTEM_INITIALIZATION_FAILED',
      message: sanitizeBotMemoryErrorMessage(reason)
    }
    throw formatBotMemoryIpcError(err)
  }

  const channels = [
    BOT_MEMORY_IPC_CHANNELS.CREATE,
    BOT_MEMORY_IPC_CHANNELS.GET,
    BOT_MEMORY_IPC_CHANNELS.LIST,
    BOT_MEMORY_IPC_CHANNELS.UPDATE,
    BOT_MEMORY_IPC_CHANNELS.DELETE,
    BOT_MEMORY_IPC_CHANNELS.COUNT
  ]

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
