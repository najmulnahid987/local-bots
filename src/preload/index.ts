import { contextBridge } from 'electron'

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to safely expose bounded APIs to renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload APIs via contextBridge:', error)
  }
}
