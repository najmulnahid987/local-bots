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
  GET_AVAILABLE_MODELS: 'provider:get-available-models',
  UPDATE_LABEL: 'provider:update-label',
  REPLACE_CREDENTIAL: 'provider:replace-credential',
  REMOVE_CONNECTION: 'provider:remove-connection',
  GENERATE_TEXT: 'provider:generate-text',
  STREAM_START: 'provider:stream-start',
  STREAM_PORT: 'provider:stream-port'
} as const

export type ProviderIpcChannel = (typeof PROVIDER_IPC_CHANNELS)[keyof typeof PROVIDER_IPC_CHANNELS]

export const KB_IPC_CHANNELS = {
  LIST: 'kb:list',
  GET_BY_ID: 'kb:get-by-id',
  CREATE: 'kb:create',
  UPDATE: 'kb:update',
  ARCHIVE: 'kb:archive',
  UNARCHIVE: 'kb:unarchive',
  DELETE: 'kb:delete',
  GET_DELETION_PREVIEW: 'kb:get-deletion-preview',
  GET_OVERVIEW: 'kb:get-overview',
  EXPORT: 'kb:export',
  IMPORT_SELECT_AND_PREVIEW: 'kb:import:select-and-preview',
  IMPORT_EXECUTE: 'kb:import:execute',
  IMPORT_CANCEL: 'kb:import:cancel'
} as const

export type KbIpcChannel = (typeof KB_IPC_CHANNELS)[keyof typeof KB_IPC_CHANNELS]

export const KB_DOCS_IPC_CHANNELS = {
  SELECT_AND_IMPORT: 'kb:docs:select-and-import',
  LIST: 'kb:docs:list',
  GET: 'kb:docs:get',
  PREVIEW: 'kb:docs:preview',
  SEARCH: 'kb:docs:search',
  REINDEX: 'kb:docs:reindex',
  DELETE: 'kb:docs:delete',
  GET_DELETION_PREVIEW: 'kb:docs:get-deletion-preview',
  GET_PRESERVATION_REPORT: 'kb:docs:get-preservation-report'
} as const

export type KbDocsIpcChannel = (typeof KB_DOCS_IPC_CHANNELS)[keyof typeof KB_DOCS_IPC_CHANNELS]

export type IpcChannel =
  | (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
  | ProviderIpcChannel
  | KbIpcChannel
  | KbDocsIpcChannel
  | import('./diagnostics').DiagnosticsIpcChannel
  | import('./deletion').DeletionIpcChannel
  | import('./bots').BotIpcChannel
  | import('./conversations').ConversationIpcChannel
  | import('./agents').AgentIpcChannel
  | import('./bot-memories').BotMemoryIpcChannel
  | import('./privacy').PrivacyIpcChannel

export * from './providers'
export * from './knowledge-bases'
export * from './knowledge-documents'
export * from './bots'
export * from './conversations'
export * from './agents'
export * from './bot-memories'
export * from './export-archive'
export * from './diagnostics'
export * from './deletion'
export * from './privacy'

export interface PingRequest {
  requestId: string
}

export interface PingResponse {
  ok: true
  message: 'pong'
  requestId: string
  timestamp: number
}
