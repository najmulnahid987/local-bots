import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  KB_IPC_CHANNELS,
  KB_DOCS_IPC_CHANNELS,
  PingRequest,
  PingResponse,
  type ProviderApi,
  type ProviderCatalogDto,
  type ModelDescriptorDto,
  type ProviderConnectionSummary,
  type ConnectionTestResult,
  type CreateProviderConnectionInput,
  type TestDraftConnectionInput,
  type TestProviderConnectionInput,
  type UpdateConnectionLabelInput,
  type ReplaceCredentialInput,
  type RemoveProviderConnectionInput,
  type RemoveConnectionResult,
  type GenerateTextInput,
  type GenerateTextResult,
  type StreamTextInput,
  type ProviderStreamEvent,
  type ProviderStreamHandle,
  ProviderBridgeError,
  type KnowledgeBaseApi,
  type KnowledgeBaseDto,
  type KnowledgeBaseOverviewDto,
  type CreateKnowledgeBaseRequest,
  type UpdateKnowledgeBaseRequest,
  type KnowledgeBaseListRequest,
  type DeleteKnowledgeBaseResult,
  type ExportKnowledgeBaseResultDto,
  type ImportPreviewResultDto,
  type ExecuteImportRequest,
  type ExecuteImportResultDto,
  type CancelImportRequest,
  type CancelImportResultDto,
  KnowledgeBaseBridgeError,
  type KnowledgeDocumentApi,
  type KnowledgeSourceDto,
  type SelectAndImportDocumentRequest,
  type ListKnowledgeDocumentsRequest,
  type GetKnowledgeDocumentRequest,
  type GetDocumentPreviewRequest,
  type SearchKnowledgeDocumentsRequest,
  type ReindexDocumentRequest,
  type DeleteDocumentRequest,
  type DocumentImportResultDto,
  type DocumentSearchResultDto,
  type DocumentPreviewDto,
  type GetPreservationReportRequest,
  type PreviewPreservationSummaryDto,
  type ReindexDocumentResultDto,
  type DeleteDocumentResultDto,
  KnowledgeDocumentBridgeError,
  BOT_IPC_CHANNELS,
  type BotApi,
  type BotDto,
  type CreateBotRequest,
  type UpdateBotRequest,
  type ListBotsRequest,
  type DeleteBotResultDto,
  BotBridgeError,
  CONVERSATION_IPC_CHANNELS,
  type ConversationApi,
  type ConversationDto,
  type ConversationSegmentDto,
  type BotConversationWorkspaceDto,
  type ClearConversationRequest,
  type ClearConversationPreviewDto,
  type ClearConversationResultDto,
  type GetConversationForBotRequest,
  type GetSegmentsRequest,
  type MessageDto,
  type ListConversationsRequest,
  type ListMessagesRequest,
  type RenameConversationIpcRequest,
  type DeleteConversationIpcRequest,
  type SendMessageRequest,
  type CancelGenerationIpcRequest,
  type ResolveCitationRequest,
  type ResolvedCitationTargetDto,
  type PublicConversationTurnEvent,
  type ConversationTurnResultDto,
  type DeleteConversationResultDto,
  ConversationBridgeError,
  AGENT_IPC_CHANNELS,
  AgentBridgeError,
  type DispatchAgentTaskRequest,
  type DispatchAgentTaskResponse,
  type CancelAgentTaskRequest,
  type CancelAgentTaskResponse,
  type GetAgentRunRequest,
  type ListAgentRunsRequest,
  type ListAgentRunsResponse,
  type AgentRunDto,
  type ListToolEventsRequest,
  type ListToolEventsResponse,
  type GetApprovalDetailsRequest,
  type ApprovalDetailsDto,
  type RespondToApprovalRequest,
  type RespondToApprovalResponse,
  type AgentStreamEvent,
  BOT_MEMORY_IPC_CHANNELS,
  BotMemoryBridgeError,
  type BotMemoryApi,
  type BotMemoryDto,
  type CreateBotMemoryInput,
  type UpdateBotMemoryInput,
  type ListBotMemoriesInput,
  type DeleteBotMemoryResultDto,
  type BotMemoryCountDto,
  DIAGNOSTICS_IPC_CHANNELS,
  DiagnosticsBridgeError,
  type DiagnosticsApi,
  type DatabaseHealthDto,
  type DiagnosticsExportResultDto,
  DELETION_IPC_CHANNELS,
  DeletionBridgeError,
  type DeletionApi,
  type DeletableEntityType,
  type DeletionPreviewDto,
  type DeleteEntityRequest,
  type DeleteEntityResultDto,
  PRIVACY_IPC_CHANNELS,
  PrivacyBridgeError,
  type PrivacyApi,
  type LocalStorageInfoDto,
  type OpenStorageFolderResponse,
  type StorageTarget
} from '../shared/ipc'

/**
 * Parses and normalizes any IPC error rejection into a structured ProviderBridgeError.
 */
export function normalizeBridgeError(error: unknown): ProviderBridgeError {
  if (error instanceof ProviderBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
        retryable?: boolean
      }
      if (parsed.code && parsed.message) {
        return new ProviderBridgeError(parsed.message, parsed.code, Boolean(parsed.retryable))
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new ProviderBridgeError(rawMsg, 'PROVIDER_ERROR', false)
}

/**
 * Creates the typed ProviderApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createProvidersApi(ipc: typeof ipcRenderer): ProviderApi {
  return {
    getCatalog: async (): Promise<ProviderCatalogDto> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.GET_CATALOG)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    listConnections: async (): Promise<readonly ProviderConnectionSummary[]> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.LIST_CONNECTIONS)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    getAvailableModels: async (input: {
      connectionId: string
    }): Promise<readonly ModelDescriptorDto[]> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.GET_AVAILABLE_MODELS, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    testDraftConnection: async (input: TestDraftConnectionInput): Promise<ConnectionTestResult> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    createConnection: async (
      input: CreateProviderConnectionInput
    ): Promise<ProviderConnectionSummary> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    testConnection: async (input: TestProviderConnectionInput): Promise<ConnectionTestResult> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.TEST_CONNECTION, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    updateConnectionLabel: async (
      input: UpdateConnectionLabelInput
    ): Promise<ProviderConnectionSummary> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.UPDATE_LABEL, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    replaceCredential: async (
      input: ReplaceCredentialInput
    ): Promise<ProviderConnectionSummary> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.REPLACE_CREDENTIAL, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    removeConnection: async (
      input: RemoveProviderConnectionInput
    ): Promise<RemoveConnectionResult> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.REMOVE_CONNECTION, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    generateText: async (input: GenerateTextInput): Promise<GenerateTextResult> => {
      try {
        return await ipc.invoke(PROVIDER_IPC_CHANNELS.GENERATE_TEXT, input)
      } catch (err) {
        throw normalizeBridgeError(err)
      }
    },

    streamText: async (
      input: StreamTextInput,
      onEvent: (event: ProviderStreamEvent) => void
    ): Promise<ProviderStreamHandle> => {
      const streamId = crypto.randomUUID()
      let isCancelled = false
      let port: MessagePort | null = null

      const portPromise = new Promise<MessagePort>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onStreamPort = (event: any, data: unknown): void => {
          const payload = data as { streamId?: string } | undefined
          if (payload?.streamId === streamId && event.ports && event.ports[0]) {
            ipc.removeListener(PROVIDER_IPC_CHANNELS.STREAM_PORT, onStreamPort)
            resolve(event.ports[0])
          }
        }
        ipc.on(PROVIDER_IPC_CHANNELS.STREAM_PORT, onStreamPort)

        // Safety timeout
        const timer = setTimeout(() => {
          ipc.removeListener(PROVIDER_IPC_CHANNELS.STREAM_PORT, onStreamPort)
          reject(
            new ProviderBridgeError('Timeout waiting for stream port transfer', 'STREAM_TIMEOUT')
          )
        }, 10000)

        // Cancel timeout if resolved
        portPromise.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer)
        )
      })

      try {
        await ipc.invoke(PROVIDER_IPC_CHANNELS.STREAM_START, {
          streamId,
          ...input
        })
        port = await portPromise
      } catch (err) {
        throw normalizeBridgeError(err)
      }

      port.onmessage = (event: MessageEvent<ProviderStreamEvent>) => {
        if (isCancelled) {
          return
        }
        const chunk = event.data
        onEvent(chunk)
        if (chunk.type === 'finish' || chunk.type === 'error') {
          try {
            port?.close()
          } catch {
            // Ignore port close errors
          }
        }
      }

      if (typeof port.start === 'function') {
        port.start()
      }

      const handle: ProviderStreamHandle = {
        cancel: () => {
          if (isCancelled) {
            return
          }
          isCancelled = true
          try {
            port?.postMessage({ type: 'cancel' })
            port?.close()
          } catch {
            // Ignore errors if port is already closed
          }
        }
      }

      return handle
    }
  }
}

/**
 * Parses and normalizes any Knowledge Base IPC error rejection into a structured KnowledgeBaseBridgeError.
 */
export function normalizeKnowledgeBaseBridgeError(error: unknown): KnowledgeBaseBridgeError {
  if (error instanceof KnowledgeBaseBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new KnowledgeBaseBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new KnowledgeBaseBridgeError(rawMsg, 'KNOWLEDGE_BASE_ERROR')
}

/**
 * Creates the typed KnowledgeBaseApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createKnowledgeBasesApi(ipc: typeof ipcRenderer): KnowledgeBaseApi {
  return {
    list: async (options?: KnowledgeBaseListRequest): Promise<readonly KnowledgeBaseDto[]> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.LIST, options ?? {})
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    getById: async (id: string): Promise<KnowledgeBaseDto | null> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.GET_BY_ID, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    create: async (input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.CREATE, input)
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    update: async (
      id: string,
      input: UpdateKnowledgeBaseRequest
    ): Promise<KnowledgeBaseDto | null> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.UPDATE, { id, input })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    archive: async (id: string): Promise<KnowledgeBaseDto | null> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.ARCHIVE, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    unarchive: async (id: string): Promise<KnowledgeBaseDto | null> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.UNARCHIVE, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    delete: async (id: string): Promise<DeleteKnowledgeBaseResult> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.DELETE, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    getDeletionPreview: async (id: string): Promise<DeletionPreviewDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.GET_DELETION_PREVIEW, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    getOverview: async (id: string): Promise<KnowledgeBaseOverviewDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.GET_OVERVIEW, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    export: async (id: string): Promise<ExportKnowledgeBaseResultDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.EXPORT, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    importSelectAndPreview: async (): Promise<ImportPreviewResultDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.IMPORT_SELECT_AND_PREVIEW)
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    importExecute: async (request: ExecuteImportRequest): Promise<ExecuteImportResultDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.IMPORT_EXECUTE, request)
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    importCancel: async (request: CancelImportRequest): Promise<CancelImportResultDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.IMPORT_CANCEL, request)
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    activateWorkspace: async (id: string): Promise<KnowledgeBaseDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id })
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    },

    deactivateWorkspace: async (): Promise<{ success: boolean }> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)
      } catch (err) {
        throw normalizeKnowledgeBaseBridgeError(err)
      }
    }
  }
}

function sanitizePreloadDocumentErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') return message
  return message
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n]+/g, '[REDACTED_PATH]')
    .replace(/(?:\/|\.\.\/)[a-zA-Z0-9_./-]+/g, '[REDACTED_PATH]')
}

/**
 * Parses and normalizes any document management IPC error rejection into a structured KnowledgeDocumentBridgeError.
 */
export function normalizeKnowledgeDocumentBridgeError(
  error: unknown
): KnowledgeDocumentBridgeError {
  if (error instanceof KnowledgeDocumentBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new KnowledgeDocumentBridgeError(
          sanitizePreloadDocumentErrorMessage(parsed.message),
          parsed.code
        )
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new KnowledgeDocumentBridgeError(
    sanitizePreloadDocumentErrorMessage(rawMsg),
    'DOCUMENT_ERROR'
  )
}

/**
 * Creates the typed KnowledgeDocumentApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createKnowledgeDocumentsApi(ipc: typeof ipcRenderer): KnowledgeDocumentApi {
  return {
    selectAndImport: async (
      request: SelectAndImportDocumentRequest
    ): Promise<DocumentImportResultDto> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    list: async (
      knowledgeBaseIdOrRequest: string | ListKnowledgeDocumentsRequest
    ): Promise<readonly KnowledgeSourceDto[]> => {
      try {
        const payload =
          typeof knowledgeBaseIdOrRequest === 'string'
            ? { knowledgeBaseId: knowledgeBaseIdOrRequest }
            : knowledgeBaseIdOrRequest
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.LIST, payload)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    get: async (request: GetKnowledgeDocumentRequest): Promise<KnowledgeSourceDto | null> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.GET, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    preview: async (request: GetDocumentPreviewRequest): Promise<DocumentPreviewDto | null> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.PREVIEW, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    search: async (
      request: SearchKnowledgeDocumentsRequest
    ): Promise<readonly DocumentSearchResultDto[]> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.SEARCH, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    reindex: async (request: ReindexDocumentRequest): Promise<ReindexDocumentResultDto> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.REINDEX, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    delete: async (request: DeleteDocumentRequest): Promise<DeleteDocumentResultDto> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.DELETE, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    getDeletionPreview: async (request: { id: string } | string): Promise<DeletionPreviewDto> => {
      try {
        const id = typeof request === 'string' ? request : request.id
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.GET_DELETION_PREVIEW, { id })
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    },

    getPreservationReport: async (
      request: GetPreservationReportRequest
    ): Promise<PreviewPreservationSummaryDto | null> => {
      try {
        return await ipc.invoke(KB_DOCS_IPC_CHANNELS.GET_PRESERVATION_REPORT, request)
      } catch (err) {
        throw normalizeKnowledgeDocumentBridgeError(err)
      }
    }
  }
}

/**
 * Parses and normalizes any Bot IPC error rejection into a structured BotBridgeError.
 */
export function normalizeBotBridgeError(error: unknown): BotBridgeError {
  if (error instanceof BotBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new BotBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new BotBridgeError(rawMsg, 'BOT_ERROR')
}

/**
 * Creates the typed BotApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createBotsApi(ipc: typeof ipcRenderer): BotApi {
  return {
    list: async (options?: ListBotsRequest): Promise<readonly BotDto[]> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.LIST, options ?? {})
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    get: async (botId: string): Promise<BotDto | null> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.GET, { id: botId })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    create: async (request: CreateBotRequest): Promise<BotDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.CREATE, request)
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    update: async (botId: string, request: UpdateBotRequest): Promise<BotDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.UPDATE, { id: botId, input: request })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    archive: async (botId: string): Promise<BotDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.ARCHIVE, { id: botId })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    unarchive: async (botId: string): Promise<BotDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.UNARCHIVE, { id: botId })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    delete: async (botId: string): Promise<DeleteBotResultDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.DELETE, { id: botId })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    getDeletionPreview: async (id: string): Promise<DeletionPreviewDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.GET_DELETION_PREVIEW, { id })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    activateWorkspace: async (knowledgeBaseId: string): Promise<KnowledgeBaseDto> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.ACTIVATE_WORKSPACE, { id: knowledgeBaseId })
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    },

    deactivateWorkspace: async (): Promise<{ success: boolean }> => {
      try {
        return await ipc.invoke(BOT_IPC_CHANNELS.DEACTIVATE_WORKSPACE)
      } catch (err) {
        throw normalizeBotBridgeError(err)
      }
    }
  }
}

/**
 * Parses and normalizes any Conversation IPC error rejection into a structured ConversationBridgeError.
 */
export function normalizeConversationBridgeError(error: unknown): ConversationBridgeError {
  if (error instanceof ConversationBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
        retryable?: boolean
      }
      if (parsed.code && parsed.message) {
        return new ConversationBridgeError(parsed.message, parsed.code, Boolean(parsed.retryable))
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new ConversationBridgeError(rawMsg, 'CONVERSATION_ERROR', false)
}

/**
 * Creates the typed ConversationApi bridge wrapping ipcRenderer.
 * Encapsulates MessageChannel port creation, event streaming, cleanup, and cancellation.
 */
export function createConversationApi(ipc: typeof ipcRenderer): ConversationApi {
  return {
    getConversationForBot: async (
      request: GetConversationForBotRequest | string
    ): Promise<BotConversationWorkspaceDto> => {
      try {
        const payload = typeof request === 'string' ? { botId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.GET_FOR_BOT, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    getSegments: async (
      request: GetSegmentsRequest | string
    ): Promise<readonly ConversationSegmentDto[]> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.GET_SEGMENTS, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    listConversations: async (
      request: ListConversationsRequest
    ): Promise<readonly ConversationDto[]> => {
      try {
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.LIST, request)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    listMessages: async (request: ListMessagesRequest | string): Promise<readonly MessageDto[]> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.GET_MESSAGES, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    renameConversation: async (request: RenameConversationIpcRequest): Promise<ConversationDto> => {
      try {
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.RENAME, request)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    getClearPreview: async (
      request: ClearConversationRequest | string
    ): Promise<ClearConversationPreviewDto> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.GET_CLEAR_PREVIEW, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    clearConversation: async (
      request: ClearConversationRequest | string
    ): Promise<ClearConversationResultDto> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.CLEAR, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    deleteConversation: async (
      request: DeleteConversationIpcRequest | string
    ): Promise<DeleteConversationResultDto> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.DELETE, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    getDeletionPreview: async (id: string): Promise<DeletionPreviewDto> => {
      try {
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.GET_DELETION_PREVIEW, { id })
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    sendMessage: async (
      request: SendMessageRequest & { requestId?: string },
      onEvent?: (event: PublicConversationTurnEvent) => void
    ): Promise<ConversationTurnResultDto> => {
      const requestId = request.requestId ?? crypto.randomUUID()
      let port: MessagePort | null = null

      const portPromise = new Promise<MessagePort>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onStreamPort = (event: any, data: unknown): void => {
          const payload = data as { requestId?: string } | undefined
          if (payload?.requestId === requestId && event.ports && event.ports[0]) {
            if (timer) clearTimeout(timer)
            ipc.removeListener(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)
            resolve(event.ports[0])
          }
        }
        ipc.on(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)

        timer = setTimeout(() => {
          ipc.removeListener(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)
          reject(
            new ConversationBridgeError(
              'Timeout waiting for stream port transfer',
              'STREAM_TIMEOUT'
            )
          )
        }, 10000)
      })

      try {
        await ipc.invoke(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE, {
          requestId,
          conversationId: request.conversationId,
          content: request.content,
          contentFormat: request.contentFormat
        })
        port = await portPromise
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }

      return new Promise<ConversationTurnResultDto>((resolve, reject) => {
        let isDone = false

        port!.onmessage = (event: MessageEvent<PublicConversationTurnEvent>) => {
          if (isDone) return
          const chunk = event.data
          if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
            return
          }
          try {
            onEvent?.(chunk)
          } catch {
            // Callback execution error ignored
          }

          if (chunk.type === 'finish') {
            isDone = true
            try {
              port?.close()
            } catch {
              // Ignore port close errors
            }
            resolve({
              userMessage: chunk.userMessage,
              assistantMessage: chunk.message,
              finishReason: chunk.finishReason,
              durationMs: chunk.durationMs,
              usage: chunk.usage
            })
          } else if (chunk.type === 'error') {
            isDone = true
            try {
              port?.close()
            } catch {
              // Ignore port close errors
            }
            const bridgeError = new ConversationBridgeError(
              chunk.error.message,
              chunk.error.code,
              chunk.error.retryable
            )
            if ('partialMessage' in chunk && chunk.partialMessage) {
              ;(bridgeError as unknown as { partialMessage?: MessageDto }).partialMessage =
                chunk.partialMessage
            }
            reject(bridgeError)
          }
        }

        if (typeof port!.start === 'function') {
          port!.start()
        }
      })
    },

    retryLastUserMessage: async (
      request: { conversationId: string; messageId?: string; requestId?: string },
      onEvent?: (event: PublicConversationTurnEvent) => void
    ): Promise<ConversationTurnResultDto> => {
      const requestId = request.requestId ?? crypto.randomUUID()
      let port: MessagePort | null = null

      const portPromise = new Promise<MessagePort>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onStreamPort = (event: any, data: unknown): void => {
          const payload = data as { requestId?: string } | undefined
          if (payload?.requestId === requestId && event.ports && event.ports[0]) {
            if (timer) clearTimeout(timer)
            ipc.removeListener(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)
            resolve(event.ports[0])
          }
        }
        ipc.on(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)

        timer = setTimeout(() => {
          ipc.removeListener(CONVERSATION_IPC_CHANNELS.STREAM_PORT, onStreamPort)
          reject(
            new ConversationBridgeError(
              'Timeout waiting for stream port transfer',
              'STREAM_TIMEOUT'
            )
          )
        }, 10000)
      })

      try {
        await ipc.invoke(CONVERSATION_IPC_CHANNELS.RETRY_LAST_USER_MESSAGE, {
          requestId,
          conversationId: request.conversationId,
          messageId: request.messageId
        })
        port = await portPromise
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }

      return new Promise<ConversationTurnResultDto>((resolve, reject) => {
        let isDone = false

        port!.onmessage = (event: MessageEvent<PublicConversationTurnEvent>) => {
          if (isDone) return
          const chunk = event.data
          if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
            return
          }
          try {
            onEvent?.(chunk)
          } catch {
            // Callback execution error ignored
          }

          if (chunk.type === 'finish') {
            isDone = true
            try {
              port?.close()
            } catch {
              // Ignore port close errors
            }
            resolve({
              userMessage: chunk.userMessage,
              assistantMessage: chunk.message,
              finishReason: chunk.finishReason,
              durationMs: chunk.durationMs,
              usage: chunk.usage
            })
          } else if (chunk.type === 'error') {
            isDone = true
            try {
              port?.close()
            } catch {
              // Ignore port close errors
            }
            const bridgeError = new ConversationBridgeError(
              chunk.error.message,
              chunk.error.code,
              chunk.error.retryable
            )
            if ('partialMessage' in chunk && chunk.partialMessage) {
              ;(bridgeError as unknown as { partialMessage?: MessageDto }).partialMessage =
                chunk.partialMessage
            }
            reject(bridgeError)
          }
        }

        if (typeof port!.start === 'function') {
          port!.start()
        }
      })
    },

    cancelGeneration: async (request: CancelGenerationIpcRequest | string): Promise<void> => {
      try {
        const payload = typeof request === 'string' ? { requestId: request } : request
        await ipc.invoke(CONVERSATION_IPC_CHANNELS.CANCEL_GENERATION, payload)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    },

    resolveCitation: async (
      request: ResolveCitationRequest
    ): Promise<ResolvedCitationTargetDto> => {
      try {
        return await ipc.invoke(CONVERSATION_IPC_CHANNELS.RESOLVE_CITATION, request)
      } catch (err) {
        throw normalizeConversationBridgeError(err)
      }
    }
  }
}

/**
 * Parses and normalizes any IPC error rejection into a structured AgentBridgeError.
 */
export function normalizeAgentBridgeError(error: unknown): AgentBridgeError {
  if (error instanceof AgentBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
        retryable?: boolean
      }
      if (parsed.code && parsed.message) {
        return new AgentBridgeError(parsed.message, parsed.code, Boolean(parsed.retryable))
      }
    } catch {
      // Fall through to default sanitization
    }
  }
  return new AgentBridgeError(rawMsg, 'AGENT_BRIDGE_ERROR')
}

export interface AgentApi {
  dispatchTask(request: DispatchAgentTaskRequest): Promise<DispatchAgentTaskResponse>
  cancelTask(request: CancelAgentTaskRequest | string): Promise<CancelAgentTaskResponse>
  getRun(request: GetAgentRunRequest | string): Promise<AgentRunDto>
  listRuns(request: ListAgentRunsRequest | string): Promise<ListAgentRunsResponse>
  listToolEvents(request: ListToolEventsRequest | string): Promise<ListToolEventsResponse>
  getApprovalDetails(request: GetApprovalDetailsRequest): Promise<ApprovalDetailsDto>
  respondToApproval(request: RespondToApprovalRequest): Promise<RespondToApprovalResponse>
  subscribeToTaskEvents(agentRunId: string, onEvent: (event: AgentStreamEvent) => void): () => void
}

export function createAgentsApi(ipc: typeof ipcRenderer): AgentApi {
  const eventSubscribers = new Map<string, Set<(event: AgentStreamEvent) => void>>()

  // Listen for incoming stream ports transferred via AGENT_IPC_CHANNELS.STREAM_PORT
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onStreamPort = (event: any, data: unknown): void => {
    const payload = data as { agentRunId?: string } | undefined
    const port = event.ports && event.ports[0] ? (event.ports[0] as MessagePort) : null
    if (payload?.agentRunId && port) {
      const runId = payload.agentRunId
      port.onmessage = (msgEvent: MessageEvent<AgentStreamEvent>): void => {
        const streamEvent = msgEvent.data
        if (
          !streamEvent ||
          typeof streamEvent !== 'object' ||
          typeof streamEvent.type !== 'string'
        ) {
          return
        }
        const subscribers = eventSubscribers.get(runId)
        if (subscribers) {
          for (const subscriber of subscribers) {
            try {
              subscriber(streamEvent)
            } catch {
              // Ignore subscriber errors to protect message flow
            }
          }
        }

        const isTerminal =
          streamEvent.type === 'agent_run_completed' ||
          streamEvent.type === 'agent_run_failed' ||
          streamEvent.type === 'agent_run_cancelled'

        if (isTerminal) {
          try {
            port.close()
          } catch {
            // Ignore close errors
          }
          eventSubscribers.delete(runId)
        }
      }

      if (typeof port.start === 'function') {
        port.start()
      }
    }
  }

  ipc.on(AGENT_IPC_CHANNELS.STREAM_PORT, onStreamPort)

  return {
    dispatchTask: async (request: DispatchAgentTaskRequest): Promise<DispatchAgentTaskResponse> => {
      try {
        return await ipc.invoke(AGENT_IPC_CHANNELS.DISPATCH_TASK, request)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    cancelTask: async (
      request: CancelAgentTaskRequest | string
    ): Promise<CancelAgentTaskResponse> => {
      try {
        const payload = typeof request === 'string' ? { agentRunId: request } : request
        return await ipc.invoke(AGENT_IPC_CHANNELS.CANCEL_TASK, payload)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    getRun: async (request: GetAgentRunRequest | string): Promise<AgentRunDto> => {
      try {
        const payload = typeof request === 'string' ? { agentRunId: request } : request
        const res = (await ipc.invoke(AGENT_IPC_CHANNELS.GET_RUN, payload)) as {
          run: AgentRunDto
        }
        return res.run
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    listRuns: async (request: ListAgentRunsRequest | string): Promise<ListAgentRunsResponse> => {
      try {
        const payload = typeof request === 'string' ? { conversationId: request } : request
        return await ipc.invoke(AGENT_IPC_CHANNELS.LIST_RUNS, payload)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    listToolEvents: async (
      request: ListToolEventsRequest | string
    ): Promise<ListToolEventsResponse> => {
      try {
        const payload = typeof request === 'string' ? { agentRunId: request } : request
        return await ipc.invoke(AGENT_IPC_CHANNELS.LIST_TOOL_EVENTS, payload)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    getApprovalDetails: async (request: GetApprovalDetailsRequest): Promise<ApprovalDetailsDto> => {
      try {
        return await ipc.invoke(AGENT_IPC_CHANNELS.GET_APPROVAL_DETAILS, request)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    respondToApproval: async (
      request: RespondToApprovalRequest
    ): Promise<RespondToApprovalResponse> => {
      try {
        return await ipc.invoke(AGENT_IPC_CHANNELS.RESPOND_TO_APPROVAL, request)
      } catch (err) {
        throw normalizeAgentBridgeError(err)
      }
    },

    subscribeToTaskEvents: (
      agentRunId: string,
      onEvent: (event: AgentStreamEvent) => void
    ): (() => void) => {
      let subscribers = eventSubscribers.get(agentRunId)
      if (!subscribers) {
        subscribers = new Set()
        eventSubscribers.set(agentRunId, subscribers)
      }
      subscribers.add(onEvent)

      return () => {
        const current = eventSubscribers.get(agentRunId)
        if (current) {
          current.delete(onEvent)
          if (current.size === 0) {
            eventSubscribers.delete(agentRunId)
          }
        }
      }
    }
  }
}

/**
 * Parses and normalizes any Bot Memory IPC error rejection into a structured BotMemoryBridgeError.
 */
export function normalizeBotMemoryBridgeError(error: unknown): BotMemoryBridgeError {
  if (error instanceof BotMemoryBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new BotMemoryBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new BotMemoryBridgeError(rawMsg, 'BOT_MEMORY_ERROR')
}

/**
 * Creates the typed BotMemoryApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createBotMemoriesApi(ipc: typeof ipcRenderer): BotMemoryApi {
  return {
    create: async (input: CreateBotMemoryInput): Promise<BotMemoryDto> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.CREATE, input)
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    },

    get: async (memoryId: string, botId: string): Promise<BotMemoryDto | null> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.GET, { memoryId, botId })
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    },

    list: async (input: ListBotMemoriesInput): Promise<readonly BotMemoryDto[]> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.LIST, input)
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    },

    update: async (
      memoryId: string,
      botId: string,
      input: UpdateBotMemoryInput
    ): Promise<BotMemoryDto> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.UPDATE, { memoryId, botId, input })
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    },

    delete: async (memoryId: string, botId: string): Promise<DeleteBotMemoryResultDto> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.DELETE, { memoryId, botId })
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    },

    count: async (botId: string): Promise<BotMemoryCountDto> => {
      try {
        return await ipc.invoke(BOT_MEMORY_IPC_CHANNELS.COUNT, { botId })
      } catch (err) {
        throw normalizeBotMemoryBridgeError(err)
      }
    }
  }
}

/**
 * Parses and normalizes any IPC error rejection into a structured DiagnosticsBridgeError.
 */
export function normalizeDiagnosticsBridgeError(error: unknown): DiagnosticsBridgeError {
  if (error instanceof DiagnosticsBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new DiagnosticsBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new DiagnosticsBridgeError(rawMsg, 'DIAGNOSTICS_ERROR')
}

/**
 * Creates the typed DiagnosticsApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createDiagnosticsApi(ipc: typeof ipcRenderer): DiagnosticsApi {
  return {
    getDatabaseHealth: async (): Promise<DatabaseHealthDto> => {
      try {
        return await ipc.invoke(DIAGNOSTICS_IPC_CHANNELS.GET_DATABASE_HEALTH)
      } catch (err) {
        throw normalizeDiagnosticsBridgeError(err)
      }
    },

    runIntegrityCheck: async (): Promise<DatabaseHealthDto> => {
      try {
        return await ipc.invoke(DIAGNOSTICS_IPC_CHANNELS.RUN_INTEGRITY_CHECK)
      } catch (err) {
        throw normalizeDiagnosticsBridgeError(err)
      }
    },

    exportDiagnostics: async (): Promise<DiagnosticsExportResultDto> => {
      try {
        return await ipc.invoke(DIAGNOSTICS_IPC_CHANNELS.EXPORT_DIAGNOSTICS)
      } catch (err) {
        throw normalizeDiagnosticsBridgeError(err)
      }
    }
  }
}

/**
 * Parses and normalizes any Deletion IPC error rejection into a structured DeletionBridgeError.
 */
export function normalizeDeletionBridgeError(error: unknown): DeletionBridgeError {
  if (error instanceof DeletionBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new DeletionBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new DeletionBridgeError(rawMsg, 'DELETION_ERROR')
}

/**
 * Creates the typed DeletionApi bridge wrapping ipcRenderer.
 * Dependency injection allows deterministic unit testing without native Electron handles.
 */
export function createDeletionApi(ipc: typeof ipcRenderer): DeletionApi {
  return {
    getPreview: async (
      entityType: DeletableEntityType,
      entityId: string
    ): Promise<DeletionPreviewDto> => {
      try {
        return await ipc.invoke(DELETION_IPC_CHANNELS.GET_PREVIEW, { entityType, entityId })
      } catch (err) {
        throw normalizeDeletionBridgeError(err)
      }
    },

    deleteEntity: async (request: DeleteEntityRequest): Promise<DeleteEntityResultDto> => {
      try {
        return await ipc.invoke(DELETION_IPC_CHANNELS.DELETE_ENTITY, request)
      } catch (err) {
        throw normalizeDeletionBridgeError(err)
      }
    }
  }
}

/**
 * Normalizes any error thrown during Privacy IPC invocations into a structured PrivacyBridgeError.
 */
export function normalizePrivacyBridgeError(error: unknown): PrivacyBridgeError {
  if (error instanceof PrivacyBridgeError) {
    return error
  }
  const rawMsg = error instanceof Error ? error.message : String(error)
  const jsonMatch = rawMsg.match(/\{[\s\S]*"code"[\s\S]*"message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        code?: string
        message?: string
      }
      if (parsed.code && parsed.message) {
        return new PrivacyBridgeError(parsed.message, parsed.code)
      }
    } catch {
      // Fall through to default sanitization
    }
  }

  return new PrivacyBridgeError(rawMsg, 'PRIVACY_ERROR')
}

/**
 * Creates the typed PrivacyApi bridge wrapping ipcRenderer.
 */
export function createPrivacyApi(ipc: typeof ipcRenderer): PrivacyApi {
  return {
    getStorageInfo: async (): Promise<LocalStorageInfoDto> => {
      try {
        return await ipc.invoke(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO)
      } catch (err) {
        throw normalizePrivacyBridgeError(err)
      }
    },

    openStorageFolder: async (target: StorageTarget): Promise<OpenStorageFolderResponse> => {
      try {
        return await ipc.invoke(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER, { target })
      } catch (err) {
        throw normalizePrivacyBridgeError(err)
      }
    }
  }
}

// Bounded, typed APIs exposed to the Renderer
export const api = {
  ping: (request: PingRequest): Promise<PingResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING, request)
  },
  providers: createProvidersApi(ipcRenderer),
  knowledgeBases: createKnowledgeBasesApi(ipcRenderer),
  knowledgeDocuments: createKnowledgeDocumentsApi(ipcRenderer),
  bots: createBotsApi(ipcRenderer),
  botMemories: createBotMemoriesApi(ipcRenderer),
  memories: createBotMemoriesApi(ipcRenderer),
  conversation: createConversationApi(ipcRenderer),
  conversations: createConversationApi(ipcRenderer),
  agents: createAgentsApi(ipcRenderer),
  diagnostics: createDiagnosticsApi(ipcRenderer),
  deletion: createDeletionApi(ipcRenderer),
  privacy: createPrivacyApi(ipcRenderer)
}

// Expose safe, bounded APIs using contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload APIs via contextBridge:', error)
  }
}
