import type { PingRequest, PingResponse, ProviderApi, KnowledgeBaseApi } from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
  knowledgeBases: KnowledgeBaseApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
