import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
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
  ProviderBridgeError
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

// Bounded, typed APIs exposed to the Renderer
export const api = {
  ping: (request: PingRequest): Promise<PingResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING, request)
  },
  providers: createProvidersApi(ipcRenderer)
}

// Expose safe, bounded APIs using contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload APIs via contextBridge:', error)
  }
}
