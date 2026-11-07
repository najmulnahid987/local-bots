import type { PingRequest, PingResponse, ProviderApi } from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
