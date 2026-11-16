import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { BotRepository } from './bot-repository'
import { BotMemoryRepository } from './bot-memory-repository'
import { ValidationError } from './types'

describe('BotMemoryRepository', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let memoryRepo: BotMemoryRepository

  let kbAId: string
  let kbBId: string
  let botA1Id: string
  let botA2Id: string
  let botB1Id: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)
    memoryRepo = new BotMemoryRepository(db)

    // Knowledge Base A with Bot A1 and Bot A2 (sibling bots)
    const kbA = kbRepo.create({ name: 'Knowledge Base A' })
    kbAId = kbA.id

    const botA1 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A1',
      modelId: 'test-model'
    })
    botA1Id = botA1.id

    const botA2 = botRepo.create({
      knowledgeBaseId: kbAId,
      name: 'Bot A2 (Sibling)',
      modelId: 'test-model'
    })
    botA2Id = botA2.id

    // Knowledge Base B with Bot B1
    const kbB = kbRepo.create({ name: 'Knowledge Base B' })
    kbBId = kbB.id

    const botB1 = botRepo.create({
      knowledgeBaseId: kbBId,
      name: 'Bot B1',
      modelId: 'test-model'
    })
    botB1Id = botB1.id
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // 1. Create a valid user note
  it('1. creates a valid user note for a Bot', () => {
    const memory = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'User prefers concise responses with bullet points.'
    })

    expect(memory).toBeDefined()
    expect(memory.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(memory.botId).toBe(botA1Id)
    expect(memory.knowledgeBaseId).toBe(kbAId)
    expect(memory.memoryType).toBe('user_note')
    expect(memory.content).toBe('User prefers concise responses with bullet points.')
    expect(memory.createdAt).toBeGreaterThan(0)
    expect(memory.updatedAt).toBe(memory.createdAt)
  })

  // 2. Create a valid pinned instruction
  it('2. creates a valid pinned instruction for a Bot', () => {
    const memory = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Always output dates in ISO 8601 format.'
    })

    expect(memory).toBeDefined()
    expect(memory.botId).toBe(botA1Id)
    expect(memory.knowledgeBaseId).toBe(kbAId)
    expect(memory.memoryType).toBe('pinned_instruction')
    expect(memory.content).toBe('Always output dates in ISO 8601 format.')
  })

  // 3. Retrieve a memory by ID
  it('3. retrieves a memory by ID within authoritative Bot and Knowledge Base scope', () => {
    const created = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Test retrieval note'
    })

    const retrieved = memoryRepo.getById(created.id, botA1Id, kbAId)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.id).toBe(created.id)
    expect(retrieved?.content).toBe('Test retrieval note')
    expect(retrieved?.memoryType).toBe('user_note')

    // Access with wrong Bot ID returns null
    const wrongBot = memoryRepo.getById(created.id, botA2Id, kbAId)
    expect(wrongBot).toBeNull()

    // Access with wrong KB ID returns null
    const wrongKb = memoryRepo.getById(created.id, botA1Id, kbBId)
    expect(wrongKb).toBeNull()
  })

  // 4. List memories for one Bot
  it('4. lists memories for one Bot', () => {
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Memory 1'
    })
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Memory 2'
    })

    const list = memoryRepo.listByBot(botA1Id, kbAId)
    expect(list).toHaveLength(2)

    // Optional filter by memoryType
    const userNotes = memoryRepo.listByBot(botA1Id, kbAId, { memoryType: 'user_note' })
    expect(userNotes).toHaveLength(1)
    expect(userNotes[0].content).toBe('Memory 1')

    const pinned = memoryRepo.listByBot(botA1Id, kbAId, { memoryType: 'pinned_instruction' })
    expect(pinned).toHaveLength(1)
    expect(pinned[0].content).toBe('Memory 2')
  })

  // 5. Confirm correct ordering by updated timestamp
  it('5. confirms correct ordering by updated timestamp DESC', async () => {
    const mem1 = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'First Memory'
    })
    db.prepare('UPDATE bot_memories SET created_at = ?, updated_at = ? WHERE id = ?').run(
      1000,
      1000,
      mem1.id
    )

    const mem2 = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Second Memory'
    })
    db.prepare('UPDATE bot_memories SET created_at = ?, updated_at = ? WHERE id = ?').run(
      2000,
      2000,
      mem2.id
    )

    const mem3 = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Third Memory'
    })
    db.prepare('UPDATE bot_memories SET created_at = ?, updated_at = ? WHERE id = ?').run(
      3000,
      3000,
      mem3.id
    )

    const list = memoryRepo.listByBot(botA1Id, kbAId)
    expect(list.map((m) => m.id)).toEqual([mem3.id, mem2.id, mem1.id])

    // Now update mem1's timestamp to be the newest
    db.prepare('UPDATE bot_memories SET updated_at = ? WHERE id = ?').run(4000, mem1.id)
    const reorderedList = memoryRepo.listByBot(botA1Id, kbAId)
    expect(reorderedList.map((m) => m.id)).toEqual([mem1.id, mem3.id, mem2.id])
  })

  // 6. Update memory content
  it('6. updates memory content and advances updated_at', () => {
    const created = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Original Content'
    })

    const updated = memoryRepo.update(created.id, botA1Id, kbAId, {
      content: 'Updated Content'
    })

    expect(updated).not.toBeNull()
    expect(updated?.content).toBe('Updated Content')
    expect(updated?.memoryType).toBe('user_note')
    expect(updated?.id).toBe(created.id)
    expect(updated?.botId).toBe(botA1Id)
    expect(updated?.knowledgeBaseId).toBe(kbAId)
    expect(updated?.createdAt).toBe(created.createdAt)
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  })

  // 7. Update memory type
  it('7. updates memory type', () => {
    const created = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Convert me to instruction'
    })

    const updated = memoryRepo.update(created.id, botA1Id, kbAId, {
      memoryType: 'pinned_instruction'
    })

    expect(updated).not.toBeNull()
    expect(updated?.memoryType).toBe('pinned_instruction')
    expect(updated?.content).toBe('Convert me to instruction')
  })

  // 8. Delete a memory
  it('8. deletes a memory within authoritative Bot scope', () => {
    const created = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Delete me'
    })

    const deleted = memoryRepo.delete(created.id, botA1Id, kbAId)
    expect(deleted).toBe(true)

    // Verify it is gone
    const check = memoryRepo.getById(created.id, botA1Id, kbAId)
    expect(check).toBeNull()

    // Second delete returns false
    const deleteAgain = memoryRepo.delete(created.id, botA1Id, kbAId)
    expect(deleteAgain).toBe(false)
  })

  // 9. Count memories for one Bot
  it('9. counts memories for one Bot accurately', () => {
    expect(memoryRepo.countByBot(botA1Id, kbAId)).toBe(0)

    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Note 1'
    })
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'user_note',
      content: 'Note 2'
    })
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      memoryType: 'pinned_instruction',
      content: 'Instruction 1'
    })

    expect(memoryRepo.countByBot(botA1Id, kbAId)).toBe(3)
    expect(memoryRepo.countByBot(botA1Id, kbAId, { memoryType: 'user_note' })).toBe(2)
    expect(memoryRepo.countByBot(botA1Id, kbAId, { memoryType: 'pinned_instruction' })).toBe(1)
  })

  // 10. Reject empty content
  it('10. rejects empty content or whitespace-only content', () => {
    expect(() =>
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: ''
      })
    ).toThrow(ValidationError)

    expect(() =>
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: '   \n\t  '
      })
    ).toThrow(ValidationError)

    const mem = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Valid content'
    })

    expect(() =>
      memoryRepo.update(mem.id, botA1Id, kbAId, {
        content: '   '
      })
    ).toThrow(ValidationError)
  })

  // 11. Reject unsupported memory types
  it('11. rejects unsupported memory types', () => {
    expect(() =>
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        // @ts-expect-error test invalid type
        memoryType: 'unsupported_type',
        content: 'Valid text'
      })
    ).toThrow(ValidationError)

    const mem = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Valid text'
    })

    expect(() =>
      memoryRepo.update(mem.id, botA1Id, kbAId, {
        // @ts-expect-error test invalid type
        memoryType: 'system_injection'
      })
    ).toThrow(ValidationError)
  })

  // 12. Reject invalid timestamps or IDs where applicable
  it('12. rejects invalid UUID identifiers', () => {
    expect(() =>
      memoryRepo.create({
        id: 'not-a-uuid',
        botId: botA1Id,
        knowledgeBaseId: kbAId,
        content: 'Content'
      })
    ).toThrow(ValidationError)

    expect(() =>
      memoryRepo.create({
        botId: 'invalid-bot-uuid',
        knowledgeBaseId: kbAId,
        content: 'Content'
      })
    ).toThrow(ValidationError)

    expect(() =>
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: 'invalid-kb-uuid',
        content: 'Content'
      })
    ).toThrow(ValidationError)

    expect(() => memoryRepo.getById('bad-id', botA1Id, kbAId)).toThrow(ValidationError)
    expect(() => memoryRepo.delete('bad-id', botA1Id, kbAId)).toThrow(ValidationError)
    expect(() => memoryRepo.update('bad-id', botA1Id, kbAId, { content: 'New' })).toThrow(
      ValidationError
    )
  })

  // 13. Reject an update for a memory belonging to another Bot
  it('13. rejects an update for a memory belonging to another Bot (returns null without modifying)', () => {
    const memA1 = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: "Bot A1's private note"
    })

    // Sibling Bot A2 tries to update Bot A1's memory
    const attemptSiblingUpdate = memoryRepo.update(memA1.id, botA2Id, kbAId, {
      content: 'Tampered by Bot A2'
    })
    expect(attemptSiblingUpdate).toBeNull()

    // Cross-KB Bot B1 tries to update Bot A1's memory
    const attemptCrossKbUpdate = memoryRepo.update(memA1.id, botB1Id, kbBId, {
      content: 'Tampered by Bot B1'
    })
    expect(attemptCrossKbUpdate).toBeNull()

    // Original memory is completely unmodified
    const check = memoryRepo.getById(memA1.id, botA1Id, kbAId)
    expect(check?.content).toBe("Bot A1's private note")
  })

  // 14. Reject a delete for a memory belonging to another Bot
  it('14. rejects a delete for a memory belonging to another Bot (returns false without modifying)', () => {
    const memA1 = memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: "Bot A1's private note"
    })

    // Sibling Bot A2 tries to delete Bot A1's memory
    const deletedBySibling = memoryRepo.delete(memA1.id, botA2Id, kbAId)
    expect(deletedBySibling).toBe(false)

    // Cross-KB Bot B1 tries to delete Bot A1's memory
    const deletedByCrossKb = memoryRepo.delete(memA1.id, botB1Id, kbBId)
    expect(deletedByCrossKb).toBe(false)

    // Original memory is intact
    const check = memoryRepo.getById(memA1.id, botA1Id, kbAId)
    expect(check).not.toBeNull()
  })

  // 15. Confirm Bot A cannot list Bot B's memories
  it("15. confirms Bot A cannot list Bot B's memories (both sibling and cross-KB)", () => {
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Bot A1 Memory'
    })
    memoryRepo.create({
      botId: botA2Id,
      knowledgeBaseId: kbAId,
      content: 'Bot A2 Sibling Memory'
    })
    memoryRepo.create({
      botId: botB1Id,
      knowledgeBaseId: kbBId,
      content: 'Bot B1 Cross-KB Memory'
    })

    const listA1 = memoryRepo.listByBot(botA1Id, kbAId)
    expect(listA1).toHaveLength(1)
    expect(listA1[0].content).toBe('Bot A1 Memory')

    const listA2 = memoryRepo.listByBot(botA2Id, kbAId)
    expect(listA2).toHaveLength(1)
    expect(listA2[0].content).toBe('Bot A2 Sibling Memory')

    const listB1 = memoryRepo.listByBot(botB1Id, kbBId)
    expect(listB1).toHaveLength(1)
    expect(listB1[0].content).toBe('Bot B1 Cross-KB Memory')
  })

  // 16. Confirm invalid Bot/Knowledge Base relationships fail through database constraints
  it('16. confirms invalid Bot/Knowledge Base relationships fail through database constraints', () => {
    // Attempting to create a memory with Bot A1 but specifying Knowledge Base B
    expect(() =>
      memoryRepo.create({
        botId: botA1Id,
        knowledgeBaseId: kbBId, // Mismatched! Bot A1 belongs to kbAId
        content: 'Mismatched KB memory'
      })
    ).toThrow(ValidationError)

    // Attempting direct raw SQL insert with mismatched composite FK fails at SQLite engine level
    expect(() => {
      db.prepare(
        `
        INSERT INTO bot_memories (
          id, bot_id, knowledge_base_id, memory_type, content, created_at, updated_at
        ) VALUES ('fake-id-1', ?, ?, 'user_note', 'Raw test', 1000, 1000)
      `
      ).run(botA1Id, kbBId)
    }).toThrow(/FOREIGN KEY constraint failed/)
  })

  // 17. Confirm deleting a Bot cascades to its memories
  it('17. confirms deleting a Bot cascades to all its memories', () => {
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Note 1 for Bot A1'
    })
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Note 2 for Bot A1'
    })

    expect(memoryRepo.countByBot(botA1Id, kbAId)).toBe(2)

    // Delete Bot A1
    const botDeleted = botRepo.delete(botA1Id, kbAId)
    expect(botDeleted).toBe(true)

    // Check directly in SQLite table
    const remaining = db
      .prepare('SELECT count(*) as count FROM bot_memories WHERE bot_id = ?')
      .get(botA1Id) as { count: number }
    expect(remaining.count).toBe(0)
  })

  // 18. Confirm deleting a Knowledge Base cascades to its memories
  it('18. confirms deleting a Knowledge Base cascades to all its memories', () => {
    memoryRepo.create({
      botId: botA1Id,
      knowledgeBaseId: kbAId,
      content: 'Note for Bot A1'
    })
    memoryRepo.create({
      botId: botA2Id,
      knowledgeBaseId: kbAId,
      content: 'Note for Bot A2'
    })

    const countInKbA = db
      .prepare('SELECT count(*) as count FROM bot_memories WHERE knowledge_base_id = ?')
      .get(kbAId) as { count: number }
    expect(countInKbA.count).toBe(2)

    // Delete Knowledge Base A
    const kbDeleted = kbRepo.delete(kbAId)
    expect(kbDeleted).toBe(true)

    // All memories in Knowledge Base A should be cascaded
    const remainingInKbA = db
      .prepare('SELECT count(*) as count FROM bot_memories WHERE knowledge_base_id = ?')
      .get(kbAId) as { count: number }
    expect(remainingInKbA.count).toBe(0)
  })
})
