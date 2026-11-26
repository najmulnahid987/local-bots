import { ipcMain, BrowserWindow } from 'electron'
import {
  CONVERSATION_IPC_CHANNELS,
  type ConversationDto,
  type ConversationSegmentDto,
  type BotConversationWorkspaceDto,
  type ClearConversationPreviewDto,
  type ClearConversationResultDto,
  type MessageDto,
  type DeleteConversationResultDto,
  type ResolvedCitationTargetDto
} from '../../shared/conversations'
import { ConversationManagerService } from '../services/conversation-manager'
import { ConversationTurnService } from '../services/conversation-turn-service'
import { ConversationStreamManager } from './conversation-stream-manager'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateConversationIpcPayload,
  conversationGetForBotIpcSchema,
  conversationGetSegmentsIpcSchema,
  conversationClearIpcSchema,
  conversationListIpcSchema,
  conversationGetMessagesIpcSchema,
  conversationRenameIpcSchema,
  conversationDeleteIpcSchema,
  conversationSendMessageIpcSchema,
  conversationRetryIpcSchema,
  conversationCancelIpcSchema,
  conversationResolveCitationIpcSchema,
  formatConversationIpcError,
  sanitizeConversationErrorMessage
} from './conversation-validation'
import { attachSessionCleanup, type DestroyableSenderLike } from './bot-handlers'
import { type WebFrameWithPostMessage } from './provider-stream-manager'

export interface ConversationIpcHandlerOptions {
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null
  conversationManager: ConversationManagerService
  turnService: ConversationTurnService
  streamManager?: ConversationStreamManager
  activeContext?: ActiveWorkspaceContext
}

/**
 * Registers secure, type-safe Main process IPC handlers for conversation management,
 * message retrieval, streaming generation, explicit retry, and cancellation.
 *
 * Invariants enforced on every invocation:
 * 1. IPC sender and frame validation (rejects untrusted windows, child frames, popups).
 * 2. Active workspace resolution strictly from sender session (rejects client-provided KB IDs).
 * 3. Strict schema validation rejecting unauthorized fields and mutations.
 * 4. Scoped cancellation restricted strictly to the requesting window.
 */
export function registerConversationIpcHandlers(options: ConversationIpcHandlerOptions): void {
  const { getMainWindow, conversationManager, turnService, activeContext } = options
  let streamManager = options.streamManager
  if (!streamManager) {
    const resolvedConversationRepo =
      (
        conversationManager as unknown as {
          conversationRepo?: import('../database/repositories/conversation-repository').ConversationRepository
        }
      ).conversationRepo ??
      (
        turnService as unknown as {
          conversationRepo?: import('../database/repositories/conversation-repository').ConversationRepository
        }
      ).conversationRepo
    if (!resolvedConversationRepo) {
      throw new Error('ConversationRepository is required to initialize ConversationStreamManager.')
    }
    streamManager = new ConversationStreamManager({
      conversationRepo: resolvedConversationRepo
    })
  }

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

  // Ensure legacy renderer conversation creation channel is explicitly removed
  ipcMain.removeHandler('conversation:create')

  // 1. Open Canonical Conversation for Bot (1:1 invariant)
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.GET_FOR_BOT)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.GET_FOR_BOT,
    async (event, rawPayload: unknown): Promise<BotConversationWorkspaceDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(conversationGetForBotIpcSchema, rawPayload)
        return conversationManager.openBotConversation(sessionId, payload.botId)
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 1b. Load Historical Conversation Segments
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.GET_SEGMENTS)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.GET_SEGMENTS,
    async (event, rawPayload: unknown): Promise<readonly ConversationSegmentDto[]> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(conversationGetSegmentsIpcSchema, rawPayload)
        return conversationManager.getSegments(sessionId, payload.conversationId)
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 2. List Conversations
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.LIST)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.LIST,
    async (event, rawPayload: unknown): Promise<readonly ConversationDto[]> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(conversationListIpcSchema, rawPayload)
        return conversationManager.listConversations(sessionId, payload)
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 3. Load Message History
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.GET_MESSAGES)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.GET_MESSAGES,
    async (event, rawPayload: unknown): Promise<readonly MessageDto[]> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const parsed = validateConversationIpcPayload(conversationGetMessagesIpcSchema, rawPayload)
        const conversationId = parsed.conversationId
        const limit = 'limit' in parsed ? parsed.limit : undefined
        const offset = 'offset' in parsed ? parsed.offset : undefined
        return conversationManager.getMessages(sessionId, conversationId, { limit, offset })
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 4. Rename Conversation
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.RENAME)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.RENAME,
    async (event, rawPayload: unknown): Promise<ConversationDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { conversationId, title } = validateConversationIpcPayload(
          conversationRenameIpcSchema,
          rawPayload
        )
        return conversationManager.renameConversation(sessionId, conversationId, title)
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 5. Get Clear Conversation Preview
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.GET_CLEAR_PREVIEW)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.GET_CLEAR_PREVIEW,
    async (event, rawPayload: unknown): Promise<ClearConversationPreviewDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { conversationId } = validateConversationIpcPayload(
          conversationClearIpcSchema,
          rawPayload
        )
        return conversationManager.getClearPreview(sessionId, conversationId, {
          isGenerating: turnService.isGenerating(conversationId),
          isDeleting: turnService.isDeleting(conversationId)
        })
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 5b. Clear Conversation (retains canonical conversation ID and preserves Agent Task audit trail)
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.CLEAR)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.CLEAR,
    async (event, rawPayload: unknown): Promise<ClearConversationResultDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { conversationId } = validateConversationIpcPayload(
          conversationClearIpcSchema,
          rawPayload
        )
        turnService.acquireDeletionLock(conversationId)
        try {
          return conversationManager.clearConversation(sessionId, conversationId)
        } finally {
          turnService.releaseDeletionLock(conversationId)
        }
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 5c. Delete Conversation
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.DELETE)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.DELETE,
    async (event, rawPayload: unknown): Promise<DeleteConversationResultDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const { conversationId } = validateConversationIpcPayload(
          conversationDeleteIpcSchema,
          rawPayload
        )
        turnService.acquireDeletionLock(conversationId)
        try {
          return conversationManager.deleteConversation(sessionId, conversationId)
        } finally {
          turnService.releaseDeletionLock(conversationId)
        }
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 6. Send Message (Streaming)
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.SEND_MESSAGE,
    async (event, rawPayload: unknown): Promise<{ started: true }> => {
      try {
        const { mainWindow, sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(conversationSendMessageIpcSchema, rawPayload)
        const senderFrame = event.senderFrame as unknown as WebFrameWithPostMessage
        return await streamManager.startSendStream(
          mainWindow,
          senderFrame,
          payload,
          sessionId,
          turnService
        )
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 7. Retry Last User Message (Streaming)
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.RETRY_LAST_USER_MESSAGE)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.RETRY_LAST_USER_MESSAGE,
    async (event, rawPayload: unknown): Promise<{ started: true }> => {
      try {
        const { mainWindow, sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(conversationRetryIpcSchema, rawPayload)
        const senderFrame = event.senderFrame as unknown as WebFrameWithPostMessage
        return await streamManager.startRetryStream(
          mainWindow,
          senderFrame,
          payload,
          sessionId,
          turnService
        )
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 8. Cancel Generation
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.CANCEL_GENERATION)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.CANCEL_GENERATION,
    async (event, rawPayload: unknown): Promise<{ success: boolean }> => {
      try {
        const { mainWindow } = assertAuthorizedSender(event)
        const { requestId } = validateConversationIpcPayload(
          conversationCancelIpcSchema,
          rawPayload
        )
        const success = streamManager.cancelStream(requestId, mainWindow)
        return { success }
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )

  // 9. Resolve Citation Reference
  ipcMain.removeHandler(CONVERSATION_IPC_CHANNELS.RESOLVE_CITATION)
  ipcMain.handle(
    CONVERSATION_IPC_CHANNELS.RESOLVE_CITATION,
    async (event, rawPayload: unknown): Promise<ResolvedCitationTargetDto> => {
      try {
        const { sessionId } = assertAuthorizedSender(event)
        const payload = validateConversationIpcPayload(
          conversationResolveCitationIpcSchema,
          rawPayload
        )
        return conversationManager.resolveCitation(sessionId, payload)
      } catch (err) {
        throw formatConversationIpcError(err)
      }
    }
  )
}

/**
 * Registers safe fallback handlers for all conversation channels in the event of
 * Main process subsystem initialization failure.
 */
export function registerFailingConversationIpcHandlers(
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
        code: 'CONVERSATION_SUBSYSTEM_FAILED',
        message: sanitizeConversationErrorMessage(reason),
        retryable: false
      })
    )
    throw formatConversationIpcError(err)
  }

  ipcMain.removeHandler('conversation:create')

  const channels = [
    CONVERSATION_IPC_CHANNELS.GET_FOR_BOT,
    CONVERSATION_IPC_CHANNELS.GET_SEGMENTS,
    CONVERSATION_IPC_CHANNELS.LIST,
    CONVERSATION_IPC_CHANNELS.GET_MESSAGES,
    CONVERSATION_IPC_CHANNELS.RENAME,
    CONVERSATION_IPC_CHANNELS.GET_CLEAR_PREVIEW,
    CONVERSATION_IPC_CHANNELS.CLEAR,
    CONVERSATION_IPC_CHANNELS.DELETE,
    CONVERSATION_IPC_CHANNELS.SEND_MESSAGE,
    CONVERSATION_IPC_CHANNELS.RETRY_LAST_USER_MESSAGE,
    CONVERSATION_IPC_CHANNELS.CANCEL_GENERATION,
    CONVERSATION_IPC_CHANNELS.RESOLVE_CITATION
  ]

  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failingHandler)
  }
}
