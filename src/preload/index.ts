import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, PingRequest, PingResponse } from '../shared/ipc'

// Bounded, typed APIs exposed to the Renderer
const api = {
  ping: (request: PingRequest): Promise<PingResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING, request)
  }
}

// Expose safe, bounded APIs using contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload APIs via contextBridge:', error)
  }
}
