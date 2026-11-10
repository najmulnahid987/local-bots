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
  type ReindexDocumentResultDto,
  type DeleteDocumentResultDto,
  KnowledgeDocumentBridgeError
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

    getOverview: async (id: string): Promise<KnowledgeBaseOverviewDto> => {
      try {
        return await ipc.invoke(KB_IPC_CHANNELS.GET_OVERVIEW, { id })
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
  knowledgeDocuments: createKnowledgeDocumentsApi(ipcRenderer)
}

// Expose safe, bounded APIs using contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload APIs via contextBridge:', error)
  }
}
