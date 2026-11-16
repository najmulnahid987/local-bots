import type {
  PingRequest,
  PingResponse,
  ProviderApi,
  KnowledgeBaseApi,
  KnowledgeDocumentApi,
  BotApi,
  ConversationApi,
  BotMemoryApi
} from '../shared/ipc'
import type { AgentApi } from './index'

export interface AppApi {
  ping(request: PingRequest): Promise<PingResponse>
  providers: ProviderApi
  knowledgeBases: KnowledgeBaseApi
  knowledgeDocuments?: KnowledgeDocumentApi
  bots?: BotApi
  botMemories?: BotMemoryApi
  memories?: BotMemoryApi
  conversation?: ConversationApi
  conversations?: ConversationApi
  agents?: AgentApi
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
