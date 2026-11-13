import type {
  PingRequest,
  PingResponse,
  ProviderApi,
  KnowledgeBaseApi,
  KnowledgeDocumentApi,
  BotApi,
  ConversationApi
} from '../shared/ipc'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
  knowledgeBases: KnowledgeBaseApi
  knowledgeDocuments?: KnowledgeDocumentApi
  bots?: BotApi
  conversation?: ConversationApi
  conversations?: ConversationApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
