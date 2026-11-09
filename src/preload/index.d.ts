import type {
  PingRequest,
  PingResponse,
  ProviderApi,
  KnowledgeBaseApi,
  KnowledgeDocumentApi
} from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
  knowledgeBases: KnowledgeBaseApi
  knowledgeDocuments?: KnowledgeDocumentApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
