import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  KnowledgeBaseRepository,
  BotRepository,
  KnowledgeBase,
  Bot,
  CreateKnowledgeBaseInput,
  CreateBotInput,
  ToolPermission
} from '../repositories'

let kbCounter = 1
let botCounter = 1
let provCounter = 1

/**
 * Creates a valid Knowledge Base fixture using KnowledgeBaseRepository.
 * Protects immutable system fields from override.
 */
export function createKnowledgeBaseFixture(
  repo: KnowledgeBaseRepository,
  overrides?: Partial<CreateKnowledgeBaseInput>
): KnowledgeBase {
  const name = overrides?.name ?? `Test Knowledge Base ${kbCounter++}`
  const description = overrides?.description ?? 'Test Knowledge Base Fixture'

  return repo.create({
    name,
    description
  })
}

/**
 * Creates a valid Bot fixture using BotRepository.
 * Requires an existing parent Knowledge Base.
 */
export function createBotFixture(
  repo: BotRepository,
  knowledgeBaseId: string,
  overrides?: Partial<Omit<CreateBotInput, 'knowledgeBaseId'>>
): Bot {
  const name = overrides?.name ?? `Test Bot ${botCounter++}`
  const modelId = overrides?.modelId ?? 'gpt-4o'
  const description = overrides?.description ?? 'Test Bot Fixture'
  const systemPrompt = overrides?.systemPrompt ?? 'You are a test assistant.'
  const status = overrides?.status ?? 'active'
  const toolPermissions = (overrides?.toolPermissions ?? [
    'search_knowledge_base',
    'read_knowledge_base_document'
  ]) as readonly ToolPermission[]
  const providerConnectionId = overrides?.providerConnectionId ?? null

  return repo.create({
    knowledgeBaseId,
    name,
    modelId,
    description,
    systemPrompt,
    status,
    toolPermissions,
    providerConnectionId
  })
}

export interface ProviderConnectionFixture {
  id: string
  providerName: string
  connectionName: string
}

/**
 * Inserts a synthetic provider connection record for testing.
 * Uses fake encrypted credential BLOB bytes. Never uses real API keys.
 */
export function createProviderConnectionFixture(
  db: Database.Database,
  overrides?: {
    id?: string
    providerName?: 'openai' | 'anthropic' | 'google' | 'xai' | 'openrouter'
    connectionName?: string
    keyPreview?: string
  }
): ProviderConnectionFixture {
  const id = overrides?.id ?? randomUUID()
  const providerName = overrides?.providerName ?? 'anthropic'
  const connectionName = overrides?.connectionName ?? `Test Provider ${provCounter++}`
  const keyPreview = overrides?.keyPreview ?? 'sk-ant-test-...1234'
  const fakeCiphertext = Buffer.from(`fake-test-ciphertext-${id}`)
  const now = Date.now()

  db.prepare(
    `
    INSERT INTO provider_connections (
      id, provider_name, connection_name, encrypted_credentials, key_preview, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?
    )
  `
  ).run(id, providerName, connectionName, fakeCiphertext, keyPreview, now, now)

  return {
    id,
    providerName,
    connectionName
  }
}
