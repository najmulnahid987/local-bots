/**
 * Shared IPC channel definitions and message contracts.
 * Strictly independent of Electron and Node.js APIs.
 */

export const IPC_CHANNELS = {
  PING: 'app:ping'
} as const

export const PROVIDER_IPC_CHANNELS = {
  GET_CATALOG: 'provider:get-catalog',
  LIST_CONNECTIONS: 'provider:list-connections',
  TEST_DRAFT_CONNECTION: 'provider:test-draft-connection',
  CREATE_CONNECTION: 'provider:create-connection',
  TEST_CONNECTION: 'provider:test-connection',
  UPDATE_LABEL: 'provider:update-label',
  REPLACE_CREDENTIAL: 'provider:replace-credential',
  REMOVE_CONNECTION: 'provider:remove-connection',
  GENERATE_TEXT: 'provider:generate-text',
  STREAM_START: 'provider:stream-start',
  STREAM_PORT: 'provider:stream-port'
} as const

export type ProviderIpcChannel = (typeof PROVIDER_IPC_CHANNELS)[keyof typeof PROVIDER_IPC_CHANNELS]

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS] | ProviderIpcChannel

export * from './providers'

export interface PingRequest {
  requestId: string
}

export interface PingResponse {
  ok: true
  message: 'pong'
  requestId: string
  timestamp: number
}
