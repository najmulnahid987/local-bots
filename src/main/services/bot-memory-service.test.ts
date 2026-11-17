import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import {
  BotMemoryService,
  BotMemoryServiceError,
  MAX_BOT_MEMORY_CONTEXT_TOKENS,
  BOT_MEMORIES_HEADER,
  formatMemoryContextBlock
} from './bot-memory-service'

describe('BotMemoryService (Phase 9 Step 9.2)', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let botMemoryRepo: BotMemoryRepository
  let memoryService: BotMemoryService

  let kbAId: string
  let kbBId: string
  let botA1Id: string
  let botA2Id: string // Sibling Bot in kbA
  let botB1Id: string // Bot in kbB

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    botMemoryRepo = new BotMemoryRepository(db)
    memoryService = new BotMemoryService({ db, botRepo, botMemoryRepo })

    // Seed Knowledge Base A with Bot A1 and Bot A2 (sibling bot)
    const kbA = kbRepo.create({ name: 'Knowledge Base Alpha' })
    kbAId = kbA.id

    const botA1 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Alpha Bot 1',
      modelId: 'test-model'
    })
    botA1Id = botA1.id

    const botA2 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Alpha Bot 2 (Sibling)',
      modelId: 'test-model'
    })
    botA2Id = botA2.id

    // Seed Knowledge Base B with Bot B1
    const kbB = kbRepo.create({ name: 'Knowledge Base Beta' })
    kbBId = kbB.id

    const botB1 = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Beta Bot 1',
      modelId: 'test-model'
    })
    botB1Id = botB1.id
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // Section 11.A Core Test Scenarios (1 - 15)
  // ==========================================================================

  it('1. Retrieve memories for the correct Bot', () => {
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Note for Bot A1'
    })

    const result = memoryService.getMemoryContext(botA1Id)

    expect(result.botId).toBe(botA1Id)
    expect(result.includedCount).toBe(1)
    expect(result.items[0].content).toBe('Note for Bot A1')
    expect(result.formattedText).toContain('Note for Bot A1')
  })

  it('2. Retrieve memories for the correct parent Knowledge Base', () => {
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Pinned note in KB A'
    })

    const result = memoryService.getMemoryContext(botA1Id)

    expect(result.knowledgeBaseId).toBe(kbAId)
    expect(result.items[0].knowledgeBaseId).toBe(kbAId)
  })

  it('3. Never retrieve sibling Bot memories (same KB, different Bot)', () => {
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Bot A1 private context'
    })
    botMemoryRepo.create({
      botId: botA2Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Bot A2 sibling private context'
    })

    const resultA1 = memoryService.getMemoryContext(botA1Id)
    const resultA2 = memoryService.getMemoryContext(botA2Id)

    expect(resultA1.includedCount).toBe(1)
    expect(resultA1.items[0].content).toBe('Bot A1 private context')
    expect(resultA1.formattedText).not.toContain('Bot A2 sibling')

    expect(resultA2.includedCount).toBe(1)
    expect(resultA2.items[0].content).toBe('Bot A2 sibling private context')
    expect(resultA2.formattedText).not.toContain('Bot A1 private')
  })

  it('4. Never retrieve memories from another Knowledge Base', () => {
    botMemoryRepo.create({
      botId: botB1Id,
      knowledgeBaseId: kbBId,
      memoryType: 'pinned_instruction',
      content: 'Confidential knowledge base B memory'
    })

    const resultA1 = memoryService.getMemoryContext(botA1Id)

    expect(resultA1.includedCount).toBe(0)
    expect(resultA1.totalAvailableCount).toBe(0)
    expect(resultA1.formattedText).toBe('')
    expect(resultA1.formattedText).not.toContain('Confidential knowledge base B')
  })

  it('5. Empty-memory result is handled correctly', () => {
    const result = memoryService.getMemoryContext(botA1Id)

    expect(result.botId).toBe(botA1Id)
    expect(result.knowledgeBaseId).toBe(kbAId)
    expect(result.items).toEqual([])
    expect(result.totalAvailableCount).toBe(0)
    expect(result.includedCount).toBe(0)
    expect(result.excludedCount).toBe(0)
    expect(result.estimatedTokens).toBe(0)
    expect(result.configuredBudget).toBe(MAX_BOT_MEMORY_CONTEXT_TOKENS)
    expect(result.formattedText).toBe('')
  })

  it('6. Missing Bot is handled safely (throws BOT_NOT_FOUND)', () => {
    const nonExistentBotId = '00000000-0000-4000-8000-000000000000'

    expect(() => memoryService.getMemoryContext(nonExistentBotId)).toThrow(BotMemoryServiceError)
    try {
      memoryService.getMemoryContext(nonExistentBotId)
    } catch (err) {
      expect((err as BotMemoryServiceError).code).toBe('BOT_NOT_FOUND')
    }
  })

  it('7. Archived Bot handling follows application policy (throws BOT_ARCHIVED)', () => {
    botRepo.update(botA1Id, kbAId, { status: 'archived' })

    expect(() => memoryService.getMemoryContext(botA1Id)).toThrow(BotMemoryServiceError)
    try {
      memoryService.getMemoryContext(botA1Id)
    } catch (err) {
      expect((err as BotMemoryServiceError).code).toBe('BOT_ARCHIVED')
    }
  })

  it('8. Pinned instructions are prioritized ahead of user notes', () => {
    // Insert user_note first with earlier timestamp
    const note = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'General user note preference'
    })

    // Insert pinned_instruction second with later timestamp
    const pinned = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Pinned critical instruction'
    })

    const result = memoryService.getMemoryContext(botA1Id)

    expect(result.items.length).toBe(2)
    expect(result.items[0].id).toBe(pinned.id)
    expect(result.items[0].memoryType).toBe('pinned_instruction')
    expect(result.items[1].id).toBe(note.id)
    expect(result.items[1].memoryType).toBe('user_note')

    // Verify ordering in formattedText
    const pinnedIndex = result.formattedText.indexOf('Pinned critical instruction')
    const noteIndex = result.formattedText.indexOf('General user note preference')
    expect(pinnedIndex).toBeGreaterThan(0)
    expect(noteIndex).toBeGreaterThan(pinnedIndex)
  })

  it('9. Recent memories are preferred within each type (updatedAt DESC)', () => {
    const memOlder = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Older pinned instruction'
    })
    db.prepare('UPDATE bot_memories SET created_at = 1000, updated_at = 1000 WHERE id = ?').run(
      memOlder.id
    )

    const memNewer = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Newer pinned instruction'
    })
    db.prepare('UPDATE bot_memories SET created_at = 2000, updated_at = 2000 WHERE id = ?').run(
      memNewer.id
    )

    const result = memoryService.getMemoryContext(botA1Id)

    expect(result.items[0].id).toBe(memNewer.id)
    expect(result.items[1].id).toBe(memOlder.id)
  })

  it('10. Stable tie-breaking is deterministic (id.localeCompare)', () => {
    // Create two memories and force identical timestamps
    const mem1 = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Note 1'
    })
    const mem2 = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Note 2'
    })

    db.prepare(
      'UPDATE bot_memories SET created_at = 5000, updated_at = 5000 WHERE id IN (?, ?)'
    ).run(mem1.id, mem2.id)

    const result = memoryService.getMemoryContext(botA1Id)
    const expectedFirstId = mem1.id.localeCompare(mem2.id) < 0 ? mem1.id : mem2.id
    const expectedSecondId = mem1.id.localeCompare(mem2.id) < 0 ? mem2.id : mem1.id

    expect(result.items[0].id).toBe(expectedFirstId)
    expect(result.items[1].id).toBe(expectedSecondId)
  })

  it('11. Total selected memory tokens never exceed the configured budget', () => {
    // Add multiple notes that cumulatively exceed a tight 50-token budget
    for (let i = 0; i < 10; i++) {
      botMemoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        memoryType: 'user_note',
        content: `Detailed user memory preference sentence number ${i} with substantial text to consume tokens.`
      })
    }

    const tightBudget = 60
    const result = memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: tightBudget })

    expect(result.configuredBudget).toBe(tightBudget)
    expect(result.estimatedTokens).toBeLessThanOrEqual(tightBudget)
    expect(result.excludedCount).toBeGreaterThan(0)
    expect(result.includedCount + result.excludedCount).toBe(10)
  })

  it('12. Oversized memories are handled according to documented policy (skipped, smaller subsequent notes evaluated)', () => {
    // Memory 1: Massive note that exceeds the 150-token budget alone (~90 header + ~200 content = ~290 tokens)
    const oversizedContent = 'X'.repeat(800)
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: oversizedContent
    })

    // Memory 2: Small note that easily fits in 150 tokens (~90 header + ~10 content = ~100 tokens)
    const smallContent = 'Small concise note that fits.'
    const smallNote = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: smallContent
    })

    const result = memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: 150 })

    // Oversized pinned note was skipped; smaller subsequent note was evaluated and included
    expect(result.totalAvailableCount).toBe(2)
    expect(result.includedCount).toBe(1)
    expect(result.excludedCount).toBe(1)
    expect(result.items[0].id).toBe(smallNote.id)
    expect(result.formattedText).toContain(smallContent)
    expect(result.formattedText).not.toContain(oversizedContent)
  })

  it('13. Pinned memories exceeding the budget are handled deterministically', () => {
    // Two pinned memories; first is recent and fits, second is older and exceeds remaining budget
    const pinned1 = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Pinned instruction one: ' + 'A'.repeat(80) // ~20 tokens -> block is ~110 tokens
    })
    db.prepare('UPDATE bot_memories SET created_at = 2000, updated_at = 2000 WHERE id = ?').run(
      pinned1.id
    )

    const pinned2 = botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Pinned instruction two: ' + 'B'.repeat(300) // ~75 tokens -> block would be ~185 tokens
    })
    db.prepare('UPDATE bot_memories SET created_at = 1000, updated_at = 1000 WHERE id = ?').run(
      pinned2.id
    )

    // With budget 150: pinned1 (~110 tokens with framing) fits, pinned2 cannot fit within 150
    const result = memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: 150 })

    expect(result.includedCount).toBe(1)
    expect(result.items[0].id).toBe(pinned1.id)
    expect(result.excludedCount).toBe(1)
    expect(result.estimatedTokens).toBeLessThanOrEqual(150)
  })

  it('14. Memory retrieval does not mutate persistent records', () => {
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Immutable instruction'
    })

    const countBefore = db.prepare('SELECT COUNT(*) as count FROM bot_memories').get() as {
      count: number
    }
    const recordBefore = db.prepare('SELECT * FROM bot_memories').get()

    memoryService.getMemoryContext(botA1Id)

    const countAfter = db.prepare('SELECT COUNT(*) as count FROM bot_memories').get() as {
      count: number
    }
    const recordAfter = db.prepare('SELECT * FROM bot_memories').get()

    expect(countAfter.count).toBe(countBefore.count)
    expect(recordAfter).toEqual(recordBefore)
  })

  it('15. Retrieval errors are not silently converted to empty memory (throws DATABASE_ERROR)', () => {
    // Simulate database corruption / failure by closing db
    db.close()

    expect(() => memoryService.getMemoryContext(botA1Id)).toThrow(BotMemoryServiceError)
    try {
      memoryService.getMemoryContext(botA1Id)
    } catch (err) {
      expect((err as BotMemoryServiceError).code).toBe('DATABASE_ERROR')
    }
  })

  // ==========================================================================
  // Edge Cases & Formatting Tests (16 - 20)
  // ==========================================================================

  it('16. Non-UUID/invalid botId format throws INVALID_INPUT', () => {
    expect(() => memoryService.getMemoryContext('invalid-id')).toThrow(BotMemoryServiceError)
    try {
      memoryService.getMemoryContext('invalid-id')
    } catch (err) {
      expect((err as BotMemoryServiceError).code).toBe('INVALID_INPUT')
    }
  })

  it('17. Invalid budget (negative, 0, non-integer) throws INVALID_INPUT', () => {
    expect(() => memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: 0 })).toThrow(
      BotMemoryServiceError
    )
    expect(() => memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: -10 })).toThrow(
      BotMemoryServiceError
    )
    expect(() => memoryService.getMemoryContext(botA1Id, { maxMemoryTokens: 12.5 })).toThrow(
      BotMemoryServiceError
    )
  })

  it('18. formatMemoryContextBlock escapes XML delimiters (<, >, &)', () => {
    const rawContent = 'Condition: if <user_input> & <flag> > 0 then proceed'
    const formatted = formatMemoryContextBlock([
      { memoryType: 'pinned_instruction', content: rawContent }
    ])

    expect(formatted).toContain('&lt;user_input&gt; &amp; &lt;flag&gt; &gt; 0')
    expect(formatted).toContain('<bot_memories>')
    expect(formatted).toContain('</bot_memories>')
    expect(formatted).toContain(BOT_MEMORIES_HEADER)
  })

  it('19. retrieveContext produces identical output to getMemoryContext', () => {
    botMemoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Pinned alias test'
    })

    const res1 = memoryService.getMemoryContext(botA1Id)
    const res2 = memoryService.retrieveContext(botA1Id)

    expect(res1).toEqual(res2)
  })
})
