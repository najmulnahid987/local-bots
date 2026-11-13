import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { BotRepository } from './bot-repository'
import { ConversationRepository } from './conversation-repository'
import { MessageRepository } from './message-repository'
import { ValidationError } from './types'
import {
  type CitationDto,
  type MessageMetadataDto,
  type MessageTokenUsageDto,
  MAX_MESSAGE_CONTENT_LENGTH
} from '../../../shared/conversations'

describe('MessageRepository (Phase 7 Step 7.2)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository

  let kbAId: string
  let kbBId: string
  let botAId: string
  let botBId: string
  let convAId: string
  let convBId: string

  const validSourceId = '44444444-4444-4444-8444-444444444444'
  const validChunkId = '55555555-5555-4555-8555-555555555555'

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    convRepo = new ConversationRepository(db)
    msgRepo = new MessageRepository(db)

    const kbA = kbRepo.create({ name: 'Knowledge Base A' })
    const kbB = kbRepo.create({ name: 'Knowledge Base B' })
    kbAId = kbA.id
    kbBId = kbB.id

    const botA = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A',
      modelId: 'gpt-6-luna'
    })
    const botB = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot B',
      modelId: 'claude-sonnet-5-5'
    })
    botAId = botA.id
    botBId = botB.id

    const convA = convRepo.create({
      botId: botAId,
      knowledgeBaseId: kbAId,
      title: 'Thread A'
    })
    const convB = convRepo.create({
      botId: botBId,
      knowledgeBaseId: kbBId,
      title: 'Thread B'
    })
    convAId = convA.id
    convBId = convB.id
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // ==========================================================================
  // Role & Content Format Tests
  // ==========================================================================

  it('1. creates a user message successfully', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'What is our Q3 revenue?'
    })

    expect(msg).toBeDefined()
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('What is our Q3 revenue?')
    expect(msg.contentFormat).toBe('markdown')
    expect(msg.conversationId).toBe(convAId)
    expect(msg.createdAt).toBeGreaterThan(0)
  })

  it('2. creates an assistant message successfully', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'According to the financial report, Q3 revenue was $14.2M.'
    })

    expect(msg.role).toBe('assistant')
    expect(msg.content).toContain('$14.2M')
  })

  it('3. creates a system message successfully', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'system',
      content: 'System instruction: Answer with brevity.'
    })

    expect(msg.role).toBe('system')
  })

  it('4. creates a tool message successfully', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'tool',
      content: '{"chunks_found": 3}'
    })

    expect(msg.role).toBe('tool')
  })

  it('5. creates a message with markdown format', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: '### Executive Summary\n\n- Finding 1\n- Finding 2',
      contentFormat: 'markdown'
    })

    expect(msg.contentFormat).toBe('markdown')
  })

  it('6. creates a message with json format', () => {
    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: '{"status": "ok", "items": [1, 2, 3]}',
      contentFormat: 'json'
    })

    expect(msg.contentFormat).toBe('json')
  })

  it('7. rejects invalid message roles', () => {
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        // @ts-expect-error Testing invalid role
        role: 'operator',
        content: 'Invalid role message'
      })
    ).toThrow(ValidationError)
  })

  it('8. rejects invalid content formats', () => {
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'HTML format',
        // @ts-expect-error Testing invalid format
        contentFormat: 'html'
      })
    ).toThrow(ValidationError)
  })

  it('9. rejects content exceeding the maximum allowed length', () => {
    const overlong = 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: overlong
      })
    ).toThrow(ValidationError)
  })

  // ==========================================================================
  // Ownership Chain Verification
  // ==========================================================================

  it('10. rejects message creation for a nonexistent conversation', () => {
    const fakeConvId = '99999999-9999-4999-8999-999999999999'
    expect(() =>
      msgRepo.create({
        conversationId: fakeConvId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Orphan message'
      })
    ).toThrow(ValidationError)
  })

  it('11. rejects message creation with mismatched Bot ownership', () => {
    // convA belongs to botA, attempt insertion specifying botB
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botBId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Cross-bot attempt'
      })
    ).toThrow(ValidationError)
  })

  it('12. rejects message creation with mismatched Knowledge Base ownership', () => {
    // convA belongs to kbA, attempt insertion specifying kbB
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbBId,
        role: 'user',
        content: 'Cross-KB attempt'
      })
    ).toThrow(ValidationError)
  })

  // ==========================================================================
  // Retrieval & Scoped Listing
  // ==========================================================================

  it('13. retrieves message using complete ownership chain (Message -> Conv -> Bot -> KB)', () => {
    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Detailed explanation.'
    })

    const retrieved = msgRepo.getById(created.id, convAId, botAId, kbAId)
    expect(retrieved).toEqual(created)
  })

  it('14. rejects message retrieval from another conversation', () => {
    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Private message'
    })

    const retrieved = msgRepo.getById(created.id, convBId, botAId, kbAId)
    expect(retrieved).toBeNull()
  })

  it('15. rejects message retrieval from another Bot', () => {
    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Bot A only message'
    })

    const retrieved = msgRepo.getById(created.id, convAId, botBId, kbAId)
    expect(retrieved).toBeNull()
  })

  it('16. lists conversation history in deterministic oldest-first order (created_at ASC, id ASC)', () => {
    const msg1 = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'First'
    })
    const msg2 = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Second'
    })

    db.prepare('UPDATE messages SET created_at = 1000 WHERE id = ?').run(msg1.id)
    db.prepare('UPDATE messages SET created_at = 2000 WHERE id = ?').run(msg2.id)

    const list = msgRepo.listByConversation(convAId, botAId, kbAId)
    expect(list.length).toBe(2)
    expect(list[0].id).toBe(msg1.id)
    expect(list[1].id).toBe(msg2.id)
  })

  it('17. enforces deterministic secondary sort on id ASC for identical timestamps', () => {
    const msg1 = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Same time 1'
    })
    const msg2 = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Same time 2'
    })

    // Set identical timestamps
    db.prepare('UPDATE messages SET created_at = 5000 WHERE id IN (?, ?)').run(msg1.id, msg2.id)

    const list = msgRepo.listByConversation(convAId, botAId, kbAId)
    const expectedFirstId = [msg1.id, msg2.id].sort()[0]
    expect(list[0].id).toBe(expectedFirstId)
  })

  it('18. handles limit and offset pagination correctly when listing messages', () => {
    for (let i = 1; i <= 6; i++) {
      const msg = msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: `Message ${i}`
      })
      db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(1000 + i * 10, msg.id)
    }

    const page1 = msgRepo.listByConversation(convAId, botAId, kbAId, { limit: 3, offset: 0 })
    expect(page1.length).toBe(3)
    expect(page1[0].content).toBe('Message 1')
    expect(page1[2].content).toBe('Message 3')

    const page2 = msgRepo.listByConversation(convAId, botAId, kbAId, { limit: 3, offset: 3 })
    expect(page2.length).toBe(3)
    expect(page2[0].content).toBe('Message 4')
    expect(page2[2].content).toBe('Message 6')
  })

  // ==========================================================================
  // Metadata, Citations and Token Usage
  // ==========================================================================

  it('19. persists and round-trips structured message metadata', () => {
    const metadata: MessageMetadataDto = {
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      generation: {
        finishReason: 'stop',
        durationMs: 350,
        temperature: 0.5
      }
    }

    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Response with metadata',
      metadata
    })

    const retrieved = msgRepo.getById(created.id, convAId, botAId, kbAId)
    expect(retrieved?.metadata).toEqual(metadata)
  })

  it('20. persists and round-trips citation metadata with page numbers and heading paths', () => {
    const citation1: CitationDto = {
      citationNumber: 1,
      sourceId: validSourceId,
      chunkId: validChunkId,
      fileName: 'report.pdf',
      fileType: 'pdf',
      pageNumber: 12,
      headingPath: null,
      chunkIndex: 2
    }

    const citation2: CitationDto = {
      citationNumber: 2,
      sourceId: validSourceId,
      chunkId: validChunkId,
      fileName: 'design.md',
      fileType: 'md',
      pageNumber: null,
      headingPath: ['System Architecture', 'Storage Layer'],
      chunkIndex: 4
    }

    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Answer citing [1] and [2].',
      metadata: {
        citations: [citation1, citation2]
      }
    })

    const retrieved = msgRepo.getById(created.id, convAId, botAId, kbAId)
    expect(retrieved?.metadata.citations).toHaveLength(2)
    expect(retrieved?.metadata.citations?.[0]).toEqual(citation1)
    expect(retrieved?.metadata.citations?.[1]).toEqual(citation2)
  })

  it('21. persists and round-trips token usage metrics', () => {
    const tokenUsage: MessageTokenUsageDto = {
      promptTokens: 250,
      completionTokens: 85,
      totalTokens: 335
    }

    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Answer with usage',
      tokenUsage
    })

    const retrieved = msgRepo.getById(created.id, convAId, botAId, kbAId)
    expect(retrieved?.tokenUsage).toEqual(tokenUsage)
  })

  it('22. safely handles malformed persisted metadata in SQLite without throwing or crashing', () => {
    const created = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'assistant',
      content: 'Raw test'
    })

    // Corrupt the metadata_json in SQLite
    db.prepare(
      'UPDATE messages SET metadata_json = \'{"citations": "corrupted_string"}\' WHERE id = ?'
    ).run(created.id)

    // Retrieval must not throw and must return safe fallback {}
    const retrieved = msgRepo.getById(created.id, convAId, botAId, kbAId)
    expect(retrieved?.metadata).toEqual({})
  })

  it('23. rejects invalid new metadata prior to database insertion', () => {
    // Malformed citation (non-positive citationNumber, path in fileName)
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'assistant',
        content: 'Invalid citation test',
        metadata: {
          citations: [
            {
              citationNumber: -1,
              sourceId: validSourceId,
              chunkId: validChunkId,
              fileName: '/etc/shadow',
              fileType: 'txt',
              pageNumber: null,
              headingPath: null,
              chunkIndex: 0
            }
          ]
        }
      })
    ).toThrow(ValidationError)
  })

  it('24. advances conversation updated_at monotonically when a message is inserted', () => {
    const convBefore = convRepo.getById(convAId, botAId, kbAId)

    const msg = msgRepo.create({
      conversationId: convAId,
      botId: botAId,
      knowledgeBaseId: kbAId,
      role: 'user',
      content: 'Advancing timestamp'
    })

    const convAfter = convRepo.getById(convAId, botAId, kbAId)
    expect(convAfter?.updatedAt).toBeGreaterThanOrEqual(convBefore!.updatedAt)
    expect(convAfter?.updatedAt).toBeGreaterThanOrEqual(msg.createdAt)
  })

  it('25. guarantees atomic transaction: failure during message creation does not mutate conversation timestamp', () => {
    const convBefore = convRepo.getById(convAId, botAId, kbAId)

    // Overlong content fails validation before insertion
    const overlong = 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 10)
    expect(() =>
      msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: overlong
      })
    ).toThrow(ValidationError)

    const convAfter = convRepo.getById(convAId, botAId, kbAId)
    expect(convAfter?.updatedAt).toBe(convBefore?.updatedAt)
  })

  // ==========================================================================
  // Cross-KB Isolation Tests
  // ==========================================================================

  describe('Cross-Knowledge-Base Message Isolation Invariants', () => {
    it('verifies complete cross-KB message isolation between Bot A (KB A) and Bot B (KB B)', () => {
      const msgA = msgRepo.create({
        conversationId: convAId,
        botId: botAId,
        knowledgeBaseId: kbAId,
        role: 'user',
        content: 'Confidential message in KB A'
      })
      const msgB = msgRepo.create({
        conversationId: convBId,
        botId: botBId,
        knowledgeBaseId: kbBId,
        role: 'user',
        content: 'Confidential message in KB B'
      })

      // 1. Bot A cannot retrieve Bot B's message
      expect(msgRepo.getById(msgB.id, convAId, botAId, kbAId)).toBeNull()
      expect(msgRepo.getById(msgB.id, convBId, botAId, kbAId)).toBeNull()

      // 2. Bot B cannot retrieve Bot A's message
      expect(msgRepo.getById(msgA.id, convBId, botBId, kbBId)).toBeNull()
      expect(msgRepo.getById(msgA.id, convAId, botBId, kbBId)).toBeNull()

      // 3. Bot A cannot list messages from Bot B's conversation
      expect(() => msgRepo.listByConversation(convBId, botAId, kbAId)).toThrow(ValidationError)

      // 4. Bot B cannot list messages from Bot A's conversation
      expect(() => msgRepo.listByConversation(convAId, botBId, kbBId)).toThrow(ValidationError)

      // 5. Deleting Bot A's conversation does not affect Bot B's messages
      convRepo.delete(convAId, botAId, kbAId)
      expect(msgRepo.getById(msgA.id, convAId, botAId, kbAId)).toBeNull()
      expect(msgRepo.getById(msgB.id, convBId, botBId, kbBId)).not.toBeNull()
    })
  })
})
