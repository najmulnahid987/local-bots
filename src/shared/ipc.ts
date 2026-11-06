/**
 * Shared IPC channel definitions and message contracts.
 * Strictly independent of Electron and Node.js APIs.
 */

export const IPC_CHANNELS = {
  PING: 'app:ping'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface PingRequest {
  requestId: string
}

export interface PingResponse {
  ok: true
  message: 'pong'
  requestId: string
  timestamp: number
}
