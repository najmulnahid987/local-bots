import type {
  PingRequest,
  PingResponse,
  ProviderApi,
  KnowledgeBaseApi,
  KnowledgeDocumentApi,
  BotApi
} from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
  knowledgeBases: KnowledgeBaseApi
  knowledgeDocuments?: KnowledgeDocumentApi
  bots?: BotApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
