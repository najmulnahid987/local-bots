import { ipcMain, BrowserWindow } from 'electron'
import { PROVIDER_IPC_CHANNELS } from '../../shared/ipc'
import {
  type ProviderCatalogDto,
  type ProviderConnectionSummary,
  type ConnectionTestResult,
  type RemoveConnectionResult,
  type GenerateTextResult,
  type ProviderErrorDto,
  type ModelDescriptorDto
} from '../../shared/providers'
import { ProviderManagerService } from '../providers/provider-manager/provider-manager-service'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'
import { validateIpcSender, type BrowserWindowLike, type IpcSenderEventLike } from '../security'
import {
  validateIpcPayload,
  testDraftConnectionIpcSchema,
  createConnectionIpcSchema,
  testConnectionIpcSchema,
  getAvailableModelsIpcSchema,
  updateConnectionLabelIpcSchema,
  replaceCredentialIpcSchema,
  removeConnectionIpcSchema,
  generateTextIpcSchema,
  streamStartIpcSchema
} from './provider-validation'
import { ProviderStreamManager, WebFrameWithPostMessage } from './provider-stream-manager'

/**
 * Formats any caught error into a safe JSON-stringified ProviderErrorDto.
 * Strips secrets, sensitive tokens, and filesystem paths.
 */
export function formatIpcError(err: unknown): Error {
  if (err && typeof err === 'object') {
    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'PROVIDER_OPERATION_FAILED'
    const retryable =
      'retryable' in err && typeof err.retryable === 'boolean' ? err.retryable : false
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    const safeDto: ProviderErrorDto = {
      code,
      message: sanitizeErrorMessage(rawMessage),
      retryable
    }
    return new Error(JSON.stringify(safeDto))
  }
  const fallback: ProviderErrorDto = {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during the provider operation.',
    retryable: false
  }
  return new Error(JSON.stringify(fallback))
}

export interface RegisterProviderIpcOptions {
  streamManager?: ProviderStreamManager
}

/**
 * Registers secure, type-safe Main process IPC handlers for AI provider operations.
 * Enforces sender validation and strict input schema validation on every call.
 */
export function registerProviderIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  providerManager: ProviderManagerService,
  options?: RegisterProviderIpcOptions
): void {
  const streamManager = options?.streamManager ?? new ProviderStreamManager()

  // Helper to validate caller
  const assertAuthorizedSender = (event: IpcSenderEventLike): BrowserWindowLike => {
    const mainWindow = getMainWindow()
    if (!validateIpcSender(event, mainWindow)) {
      throw new Error(
        JSON.stringify({
          code: 'UNAUTHORIZED_SENDER',
          message: 'Unauthorized IPC invocation: invalid or untrusted sender.',
          retryable: false
        })
      )
    }
    return mainWindow!
  }

  // 1. Get Catalog
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.GET_CATALOG)
  ipcMain.handle(PROVIDER_IPC_CHANNELS.GET_CATALOG, async (event): Promise<ProviderCatalogDto> => {
    try {
      assertAuthorizedSender(event)
      return providerManager.getProviderCatalog()
    } catch (err) {
      throw formatIpcError(err)
    }
  })

  // 2. List Connections
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.LIST_CONNECTIONS)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.LIST_CONNECTIONS,
    async (event): Promise<readonly ProviderConnectionSummary[]> => {
      try {
        assertAuthorizedSender(event)
        return providerManager.listConnections()
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 3. Test Draft Connection
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.TEST_DRAFT_CONNECTION,
    async (event, rawPayload: unknown): Promise<ConnectionTestResult> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(testDraftConnectionIpcSchema, rawPayload)
        const testRes = await providerManager.testDraftConnection(payload)
        return {
          ...testRes,
          ok: testRes.success
        }
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 4. Create Connection
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.CREATE_CONNECTION)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.CREATE_CONNECTION,
    async (event, rawPayload: unknown): Promise<ProviderConnectionSummary> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(createConnectionIpcSchema, rawPayload)
        return await providerManager.createConnection(payload)
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 5. Test Connection
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.TEST_CONNECTION)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.TEST_CONNECTION,
    async (event, rawPayload: unknown): Promise<ConnectionTestResult> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(testConnectionIpcSchema, rawPayload)
        const testRes = await providerManager.testConnection(payload.connectionId, payload.modelId)
        return {
          ...testRes,
          ok: testRes.success
        }
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 5B. Get Available Models for Connection
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.GET_AVAILABLE_MODELS)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.GET_AVAILABLE_MODELS,
    async (event, rawPayload: unknown): Promise<readonly ModelDescriptorDto[]> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(getAvailableModelsIpcSchema, rawPayload)
        return await providerManager.getAvailableModels(payload.connectionId)
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 6. Update Label
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.UPDATE_LABEL)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.UPDATE_LABEL,
    async (event, rawPayload: unknown): Promise<ProviderConnectionSummary> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(updateConnectionLabelIpcSchema, rawPayload)
        return providerManager.updateConnectionLabel(payload.connectionId, payload.label)
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 7. Replace Credential
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.REPLACE_CREDENTIAL)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.REPLACE_CREDENTIAL,
    async (event, rawPayload: unknown): Promise<ProviderConnectionSummary> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(replaceCredentialIpcSchema, rawPayload)
        return await providerManager.replaceCredential(
          payload.connectionId,
          payload.apiKey,
          payload.modelId
        )
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 8. Remove Connection
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.REMOVE_CONNECTION)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.REMOVE_CONNECTION,
    async (event, rawPayload: unknown): Promise<RemoveConnectionResult> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(removeConnectionIpcSchema, rawPayload)
        return await providerManager.removeConnection(payload.connectionId)
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 9. Generate Text
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.GENERATE_TEXT)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.GENERATE_TEXT,
    async (event, rawPayload: unknown): Promise<GenerateTextResult> => {
      try {
        assertAuthorizedSender(event)
        const payload = validateIpcPayload(generateTextIpcSchema, rawPayload)
        return await providerManager.generateText(payload.connectionId, payload.modelId, {
          messages: payload.options.messages,
          systemPrompt: payload.options.systemPrompt,
          temperature: payload.options.temperature,
          maxTokens: payload.options.maxOutputTokens,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: payload.options.tools as any,
          jsonSchema: payload.options.jsonSchema as Record<string, unknown> | undefined
        })
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )

  // 10. Stream Start
  ipcMain.removeHandler(PROVIDER_IPC_CHANNELS.STREAM_START)
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.STREAM_START,
    async (event, rawPayload: unknown): Promise<{ started: true }> => {
      try {
        const mainWindow = assertAuthorizedSender(event)
        const payload = validateIpcPayload(streamStartIpcSchema, rawPayload)

        const senderFrame = event.senderFrame as unknown as WebFrameWithPostMessage
        if (!senderFrame || typeof senderFrame.postMessage !== 'function') {
          throw new Error('Sender frame does not support message port transfer.')
        }

        return await streamManager.startStream(mainWindow, senderFrame, payload, providerManager)
      } catch (err) {
        throw formatIpcError(err)
      }
    }
  )
}

/**
 * Registers fail-closed provider IPC handlers when ProviderManagerService fails to initialize.
 */
export function registerFailingProviderIpcHandlers(
  getMainWindow: () => BrowserWindowLike | BrowserWindow | null,
  reason: string
): void {
  const failHandler = async (event: IpcSenderEventLike): Promise<never> => {
    const mainWindow = getMainWindow()
    validateIpcSender(event, mainWindow)
    throw new Error(
      JSON.stringify({
        code: 'PROVIDER_SUBSYSTEM_UNAVAILABLE',
        message: `Provider subsystem is unavailable: ${sanitizeErrorMessage(reason)}`,
        retryable: false
      })
    )
  }

  const channels = Object.values(PROVIDER_IPC_CHANNELS)
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, failHandler)
  }
}
