import type { PingRequest, PingResponse } from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
