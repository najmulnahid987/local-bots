import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { BotManagerService } from './bot-manager'
import { ConversationManagerService, ConversationManagerError } from './conversation-manager'

describe('Phase 12 Step 12.1: Single Conversation per Bot Lifecycle', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let connectionRepo: ProviderConnectionRepository
  let activeContext: ActiveWorkspaceContext
  let botManager: BotManagerService
  let convManager: ConversationManagerService

  const sessionId = 'session-phase12-test'
  let kbAId: string
  let kbBId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    convRepo = new ConversationRepository(db)
    msgRepo = new MessageRepository(db)
    connectionRepo = new ProviderConnectionRepository(db)

    activeContext = new ActiveWorkspaceContext({ kbRepo })

    botManager = new BotManagerService({
      botRepo,
      kbRepo,
      connectionRepo,
      conversationRepo: convRepo,
      db,
      activeContext
    })

    convManager = new ConversationManagerService({
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      botRepo,
      activeContext,
      db
    })

    const kbA = kbRepo.create({ name: 'Knowledge Base Alpha' })
    const kbB = kbRepo.create({ name: 'Knowledge Base Beta' })
    kbAId = kbA.id
    kbBId = kbB.id

    activeContext.activateWorkspace(sessionId, kbAId)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. createBot automatically and atomically provisions the single canonical conversation and initial segment', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Researcher Bot',
      modelId: 'gpt-6-luna'
    })

    // Bot exists
    expect(bot.id).toBeDefined()
    expect(bot.name).toBe('Researcher Bot')

    // Canonical conversation was automatically created in SQLite
    const conv = convRepo.getByBotId(bot.id, kbAId)
    expect(conv).not.toBeNull()
    expect(conv!.botId).toBe(bot.id)
    expect(conv!.knowledgeBaseId).toBe(kbAId)
    expect(conv!.title).toBe('Researcher Bot Conversation')

    // Initial conversation segment was created
    const segments = convRepo.getSegments(conv!.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].conversationId).toBe(conv!.id)
    expect(segments[0].segmentOrder).toBe(0)
    expect(segments[0].title).toBe('Researcher Bot Conversation')
    expect(segments[0].messageCount).toBe(0)
  })

  it('2. getConversationForBot retrieves the existing canonical conversation', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Analyst Bot',
      modelId: 'gpt-6-luna'
    })

    const conv = convManager.getConversationForBot(sessionId, bot.id)
    expect(conv).not.toBeNull()
    expect(conv!.botId).toBe(bot.id)
    expect(conv!.title).toBe('Analyst Bot Conversation')
  })

  it('3. repeated calls to createConversation or getOrCreate return existing conversation without duplicate creation', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Coder Bot',
      modelId: 'gpt-6-luna'
    })

    const initialConv = convRepo.getByBotId(bot.id, kbAId)!

    // Calling createConversation through ConversationManagerService
    const convFromManager = convManager.createConversation(sessionId, {
      botId: bot.id,
      title: 'Ignored New Title'
    })

    expect(convFromManager.id).toBe(initialConv.id)

    // Direct repo getOrCreate call
    const convFromRepo = convRepo.getOrCreate({
      botId: bot.id,
      knowledgeBaseId: kbAId,
      title: 'Another Ignored Title'
    })

    expect(convFromRepo.id).toBe(initialConv.id)

    // Verify exactly ONE conversation exists in SQLite for this bot
    const allConvs = db.prepare('SELECT * FROM conversations WHERE bot_id = ?').all(bot.id)
    expect(allConvs).toHaveLength(1)
  })

  it('4. messages persist into the canonical conversation, update timestamps and segment counts', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Support Bot',
      modelId: 'gpt-6-luna'
    })

    const conv = convRepo.getByBotId(bot.id, kbAId)!

    // Insert user message
    const msg1 = msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Hello, need help'
    })

    // Insert assistant message
    const msg2 = msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Sure, I am here to help.'
    })

    expect(msg1.conversationId).toBe(conv.id)
    expect(msg2.conversationId).toBe(conv.id)
    expect(msg1.segmentId).toBeDefined()
    expect(msg2.segmentId).toBe(msg1.segmentId)

    // Verify messages listed chronologically
    const msgs = msgRepo.listByConversation(conv.id, bot.id, kbAId)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('Hello, need help')
    expect(msgs[1].content).toBe('Sure, I am here to help.')

    // Verify segment message count updated
    const segments = convRepo.getSegments(conv.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].messageCount).toBe(2)
    expect(segments[0].firstMessageCreatedAt).toBe(msg1.createdAt)
    expect(segments[0].lastMessageCreatedAt).toBe(msg2.createdAt)
  })

  it('5. getSegments retrieves historical segments in chronological segmentOrder', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Historian Bot',
      modelId: 'gpt-6-luna'
    })

    const conv = convRepo.getByBotId(bot.id, kbAId)!

    // Retrieve segments through service
    const segments = convManager.getSegments(sessionId, conv.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].conversationId).toBe(conv.id)
    expect(segments[0].segmentOrder).toBe(0)
  })

  it('6. enforces strict Knowledge Base isolation: cross-KB conversation access is blocked', () => {
    // Create Bot in KB Alpha
    const botAlpha = botManager.createBot(sessionId, {
      name: 'Bot Alpha',
      modelId: 'gpt-6-luna'
    })
    const convAlpha = convRepo.getByBotId(botAlpha.id, kbAId)!

    // Switch workspace to KB Beta
    activeContext.activateWorkspace(sessionId, kbBId)

    // Cannot get conversation for Bot Alpha from KB Beta session
    expect(convManager.getConversationForBot(sessionId, botAlpha.id)).toBeNull()

    // Cannot get segments for convAlpha from KB Beta session
    expect(() => {
      convManager.getSegments(sessionId, convAlpha.id)
    }).toThrowError(ConversationManagerError)

    // Cannot create conversation for Bot Alpha in KB Beta session
    expect(() => {
      convManager.createConversation(sessionId, { botId: botAlpha.id })
    }).toThrowError(ConversationManagerError)
  })

  it('7. deleting a bot cascades to its canonical conversation, segments, and messages cleanly', () => {
    const bot = botManager.createBot(sessionId, {
      name: 'Doomed Bot',
      modelId: 'gpt-6-luna'
    })
    const conv = convRepo.getByBotId(bot.id, kbAId)!

    msgRepo.create({
      conversationId: conv.id,
      botId: bot.id,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Final words'
    })

    // Delete the bot
    botManager.deleteBot(sessionId, bot.id)

    // Bot is gone
    expect(botRepo.getById(bot.id, kbAId)).toBeNull()

    // Conversation is gone
    expect(convRepo.getByBotId(bot.id, kbAId)).toBeNull()

    // Segments are gone
    expect(
      db
        .prepare('SELECT count(*) as c FROM conversation_segments WHERE conversation_id = ?')
        .get(conv.id)
    ).toEqual({ c: 0 })

    // Messages are gone
    expect(
      db.prepare('SELECT count(*) as c FROM messages WHERE conversation_id = ?').get(conv.id)
    ).toEqual({ c: 0 })

    // PRAGMA foreign_key_check passes
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
