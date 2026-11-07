import type { KnowledgeBaseRepository, BotRepository, KnowledgeBase, Bot } from '../repositories'
import { createKnowledgeBaseFixture, createBotFixture } from './fixtures'

export interface TestWorkspace {
  kbA: KnowledgeBase
  botAlpha: Bot
  botBeta: Bot
  kbB: KnowledgeBase
  botGamma: Bot
}

export interface SeedContext {
  kbRepo: KnowledgeBaseRepository
  botRepo: BotRepository
}

/**
 * Seeds a standard test workspace using real repositories:
 * Knowledge Base A:
 *   - Bot Alpha
 *   - Bot Beta
 * Knowledge Base B:
 *   - Bot Gamma
 */
export function seedTestWorkspace(context: SeedContext): TestWorkspace {
  const { kbRepo, botRepo } = context

  // 1. Knowledge Base A
  const kbA = createKnowledgeBaseFixture(kbRepo, {
    name: 'Workspace Alpha KB',
    description: 'Primary workspace knowledge base'
  })

  const botAlpha = createBotFixture(botRepo, kbA.id, {
    name: 'Bot Alpha',
    modelId: 'gpt-6-luna',
    description: 'Lead research agent',
    toolPermissions: ['read_knowledge_base_document', 'prepare_report']
  })

  const botBeta = createBotFixture(botRepo, kbA.id, {
    name: 'Bot Beta',
    modelId: 'claude-sonnet-5-5',
    description: 'Code reviewer agent',
    toolPermissions: ['search_knowledge_base', 'read_project_file']
  })

  // 2. Knowledge Base B
  const kbB = createKnowledgeBaseFixture(kbRepo, {
    name: 'Workspace Beta KB',
    description: 'Secondary isolated knowledge base'
  })

  const botGamma = createBotFixture(botRepo, kbB.id, {
    name: 'Bot Gamma',
    modelId: 'gemini-3.8-flash',
    description: 'Compliance reviewer agent',
    toolPermissions: ['list_knowledge_base_documents']
  })

  return {
    kbA,
    botAlpha,
    botBeta,
    kbB,
    botGamma
  }
}
