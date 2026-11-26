import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from './knowledge-base-repository'
import { BotRepository } from './bot-repository'
import { ValidationError, RepositoryError } from './types'
import { createProviderConnectionFixture } from '../testing'

describe('BotRepository', () => {
  let db: Database.Database
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let defaultKbId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    kbRepo = new KnowledgeBaseRepository(db)
    botRepo = new BotRepository(db)

    const defaultKb = kbRepo.create({ name: 'Default KB' })
    defaultKbId = defaultKb.id
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  // === Creation Tests ===

  it('1. creates a Bot inside a valid Knowledge Base with default values', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Assistant Bot',
      modelId: 'claude-3-5-sonnet-20241022'
    })

    expect(bot).toBeDefined()
    expect(bot.name).toBe('Assistant Bot')
    expect(bot.modelId).toBe('claude-3-5-sonnet-20241022')
    expect(bot.description).toBe('')
    expect(bot.systemPrompt).toBe('')
    expect(bot.status).toBe('active')
    expect(bot.providerConnectionId).toBeNull()
    expect(bot.toolPermissions).toEqual([])
  })

  it('2. generates a valid RFC 4122 UUIDv4 for the created Bot', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'UUID Test Bot',
      modelId: 'gpt-4o'
    })

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(bot.id).toMatch(uuidRegex)
  })

  it('3. generates valid UTC Unix millisecond timestamps for createdAt and updatedAt', () => {
    const before = Date.now()
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Timestamp Bot',
      modelId: 'gpt-4o'
    })
    const after = Date.now()

    expect(bot.createdAt).toBeGreaterThanOrEqual(before)
    expect(bot.createdAt).toBeLessThanOrEqual(after)
    expect(bot.updatedAt).toBe(bot.createdAt)
  })

  it('4. ensures caller cannot override protected fields (id, createdAt, updatedAt)', () => {
    expect(() => {
      botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Hacked Bot',
        modelId: 'gpt-4o',
        id: '00000000-0000-4000-8000-000000000000',
        createdAt: 1000
      } as unknown as import('./types').CreateBotInput)
    }).toThrow(ValidationError)
  })

  it('5. creates multiple Bots under one Knowledge Base', () => {
    const bot1 = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bot One',
      modelId: 'gpt-4o'
    })
    const bot2 = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bot Two',
      modelId: 'claude-3-5-sonnet-20241022'
    })

    const list = botRepo.listByKnowledgeBase(defaultKbId)
    expect(list).toHaveLength(2)
    expect(list.map((b) => b.id)).toContain(bot1.id)
    expect(list.map((b) => b.id)).toContain(bot2.id)
  })

  it('6. creates Bots under two separate Knowledge Bases without cross-contamination', () => {
    const secondKb = kbRepo.create({ name: 'Second KB' })

    const botKb1 = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bot KB1',
      modelId: 'gpt-4o'
    })
    const botKb2 = botRepo.create({
      knowledgeBaseId: secondKb.id,
      name: 'Bot KB2',
      modelId: 'gemini-1.5-pro'
    })

    const listKb1 = botRepo.listByKnowledgeBase(defaultKbId)
    const listKb2 = botRepo.listByKnowledgeBase(secondKb.id)

    expect(listKb1).toHaveLength(1)
    expect(listKb1[0].id).toBe(botKb1.id)

    expect(listKb2).toHaveLength(1)
    expect(listKb2[0].id).toBe(botKb2.id)
  })

  // === Parent Relationship Tests ===

  it('7. rejects Bot creation when referencing a nonexistent Knowledge Base', () => {
    const nonexistentKbId = '00000000-0000-4000-8000-000000000099'

    expect(() => {
      botRepo.create({
        knowledgeBaseId: nonexistentKbId,
        name: 'Orphan Bot',
        modelId: 'gpt-4o'
      })
    }).toThrow(ValidationError)
  })

  it('8. verifies rejection message when parent Knowledge Base is missing', () => {
    const nonexistentKbId = '00000000-0000-4000-8000-000000000099'

    expect(() => {
      botRepo.create({
        knowledgeBaseId: nonexistentKbId,
        name: 'Orphan Bot',
        modelId: 'gpt-4o'
      })
    }).toThrow(/Parent Knowledge Base with ID .* does not exist/i)
  })

  it('9. verifies a Bot cannot exist without its required parent Knowledge Base', () => {
    expect(() => {
      botRepo.create({
        name: 'No Parent Bot',
        modelId: 'gpt-4o'
      } as unknown as import('./types').CreateBotInput)
    }).toThrow(ValidationError)
  })

  it('10. verifies the parent Knowledge Base ID remains correctly bound', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bound Bot',
      modelId: 'gpt-4o'
    })

    expect(bot.knowledgeBaseId).toBe(defaultKbId)

    const fetched = botRepo.getById(bot.id, defaultKbId)
    expect(fetched?.knowledgeBaseId).toBe(defaultKbId)
  })

  // === Retrieval and Listing Tests ===

  it('11. retrieves a Bot using correct Bot ID and parent Knowledge Base ID', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Findable Bot',
      modelId: 'gpt-4o',
      description: 'Findable'
    })

    const fetched = botRepo.getById(created.id, defaultKbId)
    expect(fetched).toEqual(created)
  })

  it('12. returns null when attempting to retrieve a Bot using another Knowledge Base ID', () => {
    const otherKb = kbRepo.create({ name: 'Other KB' })
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Scoped Bot',
      modelId: 'gpt-4o'
    })

    // Query with wrong parent Knowledge Base
    const result = botRepo.getById(created.id, otherKb.id)
    expect(result).toBeNull()
  })

  it('13. returns null when Bot ID does not exist', () => {
    const nonExistentBotId = '00000000-0000-4000-8000-000000000000'
    const result = botRepo.getById(nonExistentBotId, defaultKbId)
    expect(result).toBeNull()
  })

  it('14. verifies listByKnowledgeBase returns only Bots belonging to the specified Knowledge Base', () => {
    const kbB = kbRepo.create({ name: 'KB B' })

    botRepo.create({ knowledgeBaseId: defaultKbId, name: 'Bot A1', modelId: 'gpt-4o' })
    botRepo.create({ knowledgeBaseId: defaultKbId, name: 'Bot A2', modelId: 'gpt-4o' })
    botRepo.create({ knowledgeBaseId: kbB.id, name: 'Bot B1', modelId: 'gpt-4o' })

    const listA = botRepo.listByKnowledgeBase(defaultKbId)
    const listB = botRepo.listByKnowledgeBase(kbB.id)

    expect(listA).toHaveLength(2)
    expect(listA.map((b) => b.name).sort()).toEqual(['Bot A1', 'Bot A2'])

    expect(listB).toHaveLength(1)
    expect(listB[0].name).toBe('Bot B1')
  })

  it('15. verifies listByKnowledgeBase orders by created_at DESC', async () => {
    const b1 = botRepo.create({ knowledgeBaseId: defaultKbId, name: 'Oldest', modelId: 'gpt-4o' })
    await new Promise((r) => setTimeout(r, 10))
    const b2 = botRepo.create({ knowledgeBaseId: defaultKbId, name: 'Middle', modelId: 'gpt-4o' })
    await new Promise((r) => setTimeout(r, 10))
    const b3 = botRepo.create({ knowledgeBaseId: defaultKbId, name: 'Newest', modelId: 'gpt-4o' })

    const list = botRepo.listByKnowledgeBase(defaultKbId)
    expect(list.map((b) => b.id)).toEqual([b3.id, b2.id, b1.id])
  })

  // === Updates Tests ===

  it('16. updates permitted Bot fields (name, description, systemPrompt, modelId, status, toolPermissions)', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Initial Name',
      modelId: 'gpt-4o',
      description: 'Initial description',
      systemPrompt: 'Initial prompt'
    })

    const updated = botRepo.update(created.id, defaultKbId, {
      name: 'Updated Name',
      description: 'Updated description',
      systemPrompt: 'Updated prompt',
      modelId: 'claude-3-5-sonnet-20241022',
      status: 'archived',
      toolPermissions: ['prepare_report', 'search_knowledge_base']
    })

    expect(updated).not.toBeNull()
    expect(updated?.name).toBe('Updated Name')
    expect(updated?.description).toBe('Updated description')
    expect(updated?.systemPrompt).toBe('Updated prompt')
    expect(updated?.modelId).toBe('claude-3-5-sonnet-20241022')
    expect(updated?.status).toBe('archived')
    expect(updated?.toolPermissions).toEqual(['prepare_report', 'search_knowledge_base'])
  })

  it('17. verifies updatedAt advances when a Bot is updated', async () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Timestamp Bot',
      modelId: 'gpt-4o'
    })

    await new Promise((r) => setTimeout(r, 15))

    const updated = botRepo.update(created.id, defaultKbId, { name: 'New Name' })
    expect(updated).not.toBeNull()
    expect(updated!.updatedAt).toBeGreaterThan(created.createdAt)
  })

  it('18. verifies createdAt remains unchanged after update', async () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Immutable CreatedAt Bot',
      modelId: 'gpt-4o'
    })

    await new Promise((r) => setTimeout(r, 15))

    const updated = botRepo.update(created.id, defaultKbId, { name: 'Renamed' })
    expect(updated!.createdAt).toBe(created.createdAt)
  })

  it('19. rejects attempts to modify Bot ID during update', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Protected ID Bot',
      modelId: 'gpt-4o'
    })

    expect(() => {
      botRepo.update(created.id, defaultKbId, {
        id: '00000000-0000-4000-8000-000000000000'
      } as unknown as import('./types').UpdateBotInput)
    }).toThrow(ValidationError)
  })

  it('20. rejects attempts to modify parent Knowledge Base ownership during update', () => {
    const otherKb = kbRepo.create({ name: 'Another KB' })
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Immovable Bot',
      modelId: 'gpt-4o'
    })

    expect(() => {
      botRepo.update(created.id, defaultKbId, {
        knowledgeBaseId: otherKb.id
      } as unknown as import('./types').UpdateBotInput)
    }).toThrow(ValidationError)
  })

  it('21. rejects unknown properties in update payload', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Strict Bot',
      modelId: 'gpt-4o'
    })

    expect(() => {
      botRepo.update(created.id, defaultKbId, {
        name: 'Valid',
        unauthorizedField: true
      } as unknown as import('./types').UpdateBotInput)
    }).toThrow(ValidationError)
  })

  it('22. rejects empty update objects (requiring at least one editable field)', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Noop Bot',
      modelId: 'gpt-4o'
    })

    expect(() => {
      botRepo.update(created.id, defaultKbId, {})
    }).toThrow(ValidationError)
  })

  it('23. rejects invalid field types on update (e.g., non-string name or invalid status)', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Type Check Bot',
      modelId: 'gpt-4o'
    })

    expect(() => {
      botRepo.update(created.id, defaultKbId, {
        status: 'deleted'
      } as unknown as import('./types').UpdateBotInput)
    }).toThrow(ValidationError)

    expect(() => {
      botRepo.update(created.id, defaultKbId, { name: '   ' })
    }).toThrow(ValidationError)
  })

  // === Tool Permissions Tests ===

  it('24. accepts an empty tool permission list', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'No Tools Bot',
      modelId: 'gpt-4o',
      toolPermissions: []
    })

    expect(bot.toolPermissions).toEqual([])
  })

  it('25. accepts valid approved tool permissions', () => {
    const permissions = [
      'search_knowledge_base',
      'read_knowledge_base_document',
      'list_knowledge_base_documents',
      'search_project_files',
      'read_project_file',
      'prepare_report'
    ] as const

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Full Suite Bot',
      modelId: 'gpt-4o',
      toolPermissions: permissions
    })

    expect(bot.toolPermissions).toEqual(permissions)
  })

  it('26. rejects unknown tool permission identifiers', () => {
    expect(() => {
      botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Illegal Tool Bot',
        modelId: 'gpt-4o',
        toolPermissions: [
          'execute_terminal_command'
        ] as unknown as import('./types').ToolPermission[]
      })
    }).toThrow(ValidationError)
  })

  it('27. rejects malformed tool permissions (objects or non-array values)', () => {
    expect(() => {
      botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Bad Perms Bot',
        modelId: 'gpt-4o',
        toolPermissions: {
          tool: 'search_knowledge_base'
        } as unknown as import('./types').ToolPermission[]
      })
    }).toThrow(ValidationError)
  })

  it('28. rejects duplicate tool permissions', () => {
    expect(() => {
      botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Duplicate Perms Bot',
        modelId: 'gpt-4o',
        toolPermissions: ['prepare_report', 'prepare_report']
      })
    }).toThrow(ValidationError)
  })

  it('29. verifies retrieved Bot permissions are correctly parsed and strongly typed', () => {
    const created = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Typed Perms Bot',
      modelId: 'gpt-4o',
      toolPermissions: ['read_knowledge_base_document', 'prepare_report']
    })

    const fetched = botRepo.getById(created.id, defaultKbId)
    expect(Array.isArray(fetched?.toolPermissions)).toBe(true)
    expect(fetched?.toolPermissions).toEqual(['read_knowledge_base_document', 'prepare_report'])
  })

  // === Provider Relationship Tests ===

  it('30. creates a Bot without a provider connection when null or omitted', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Unconnected Bot',
      modelId: 'gpt-4o'
    })

    expect(bot.providerConnectionId).toBeNull()
  })

  it('31. assigns an existing provider connection to a Bot', () => {
    const prov = createProviderConnectionFixture(db, {
      id: '00000000-0000-4000-8000-000000000010',
      providerName: 'anthropic',
      connectionName: 'Work Claude'
    })

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Connected Bot',
      modelId: 'claude-3-5-sonnet-20241022',
      providerConnectionId: prov.id
    })

    expect(bot.providerConnectionId).toBe(prov.id)
  })

  it('32. rejects assigning a nonexistent provider connection', () => {
    const nonexistentProvId = '00000000-0000-4000-8000-000000000099'

    expect(() => {
      botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Broken Provider Bot',
        modelId: 'gpt-4o',
        providerConnectionId: nonexistentProvId
      })
    }).toThrow(ValidationError)
  })

  it('33. verifies BotRepository never returns encrypted credentials or provider payloads', () => {
    const provId = '00000000-0000-4000-8000-000000000011'
    const now = Date.now()
    db.prepare(
      'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      provId,
      'openai',
      'Secret OpenAI Key',
      'cred_00000000-0000-4000-8000-000000000011',
      'active',
      now,
      now
    )

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Secure Bot',
      modelId: 'gpt-4o',
      providerConnectionId: provId
    })

    expect((bot as unknown as Record<string, unknown>).encrypted_credentials).toBeUndefined()
    expect((bot as unknown as Record<string, unknown>).encryptedCredentials).toBeUndefined()
  })

  it('34. verifies provider connection deletion remains restricted (ON DELETE RESTRICT) when a Bot references it', () => {
    const prov = createProviderConnectionFixture(db, {
      id: '00000000-0000-4000-8000-000000000012',
      providerName: 'openai',
      connectionName: 'Restricted Key'
    })

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Holding Bot',
      modelId: 'gpt-4o',
      providerConnectionId: prov.id
    })

    // Attempting to delete the provider connection while referenced by a bot must throw FOREIGN KEY constraint failed
    expect(() => {
      db.prepare('DELETE FROM provider_connections WHERE id = ?').run(prov.id)
    }).toThrow(/FOREIGN KEY constraint failed/i)

    // After deleting the bot, provider connection can be deleted
    botRepo.delete(bot.id, defaultKbId)
    const delResult = db.prepare('DELETE FROM provider_connections WHERE id = ?').run(prov.id)
    expect(delResult.changes).toBe(1)
  })

  // === Deletion and Isolation Tests ===

  it('35. deletes an existing Bot and returns true', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Ephemeral Bot',
      modelId: 'gpt-4o'
    })

    const deleted = botRepo.delete(bot.id, defaultKbId)
    expect(deleted).toBe(true)
    expect(botRepo.getById(bot.id, defaultKbId)).toBeNull()
  })

  it('36. returns false when deleting a nonexistent Bot', () => {
    const nonExistentBotId = '00000000-0000-4000-8000-000000000000'
    const deleted = botRepo.delete(nonExistentBotId, defaultKbId)
    expect(deleted).toBe(false)
  })

  it('37. verifies deleting a Bot cascades to its dependent conversations and messages', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Conversational Bot',
      modelId: 'gpt-4o'
    })

    const now = Date.now()
    const convId = '00000000-0000-4000-8000-000000000020'
    const msgId = '00000000-0000-4000-8000-000000000021'

    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, bot.id, defaultKbId, 'Thread', now, now)

    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(msgId, convId, 'user', 'Hello Bot', now)

    botRepo.delete(bot.id, defaultKbId)

    expect(db.prepare('SELECT count(*) as c FROM conversations WHERE id = ?').get(convId)).toEqual({
      c: 0
    })
    expect(db.prepare('SELECT count(*) as c FROM messages WHERE id = ?').get(msgId)).toEqual({
      c: 0
    })
  })

  it('38. verifies deleting a Bot cascades to agent runs, tool events, and memories', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Autonomous Bot',
      modelId: 'gpt-4o'
    })

    const now = Date.now()
    const convId = '00000000-0000-4000-8000-000000000030'
    const runId = '00000000-0000-4000-8000-000000000031'
    const eventId = '00000000-0000-4000-8000-000000000032'
    const memId = '00000000-0000-4000-8000-000000000033'

    db.prepare(
      'INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, bot.id, defaultKbId, 'Thread', now, now)

    db.prepare(
      `INSERT INTO agent_runs (id, bot_id, conversation_id, knowledge_base_id, selected_model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(runId, bot.id, convId, defaultKbId, 'gpt-4o', now)

    db.prepare(
      'INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(eventId, runId, 1, 'search_knowledge_base', now)

    db.prepare(
      'INSERT INTO bot_memories (id, bot_id, knowledge_base_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(memId, bot.id, defaultKbId, 'User likes bullet points', now, now)

    botRepo.delete(bot.id, defaultKbId)

    expect(db.prepare('SELECT count(*) as c FROM agent_runs WHERE id = ?').get(runId)).toEqual({
      c: 0
    })
    expect(db.prepare('SELECT count(*) as c FROM tool_events WHERE id = ?').get(eventId)).toEqual({
      c: 0
    })
    expect(db.prepare('SELECT count(*) as c FROM bot_memories WHERE id = ?').get(memId)).toEqual({
      c: 0
    })
  })

  it('39. verifies deleting a Bot leaves Knowledge Base documents untouched', () => {
    const srcId = '00000000-0000-4000-8000-000000000040'
    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      srcId,
      defaultKbId,
      'doc.txt',
      'doc.txt',
      `documents/${defaultKbId}/doc.txt`,
      'txt',
      'text/plain',
      10,
      'd'.repeat(64),
      now,
      now
    )

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Reader Bot',
      modelId: 'gpt-4o'
    })

    botRepo.delete(bot.id, defaultKbId)

    expect(
      db.prepare('SELECT count(*) as c FROM knowledge_sources WHERE id = ?').get(srcId)
    ).toEqual({ c: 1 })
  })

  it('40. verifies deleting a Bot leaves sibling Bots in the same Knowledge Base untouched', () => {
    const bot1 = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Sibling Bot 1',
      modelId: 'gpt-4o'
    })
    const bot2 = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Sibling Bot 2',
      modelId: 'gpt-4o'
    })

    botRepo.delete(bot1.id, defaultKbId)

    expect(botRepo.getById(bot1.id, defaultKbId)).toBeNull()
    expect(botRepo.getById(bot2.id, defaultKbId)).not.toBeNull()
  })

  it('41. verifies deleting a Bot leaves another Knowledge Base and its Bots completely untouched', () => {
    const otherKb = kbRepo.create({ name: 'External KB' })
    const botA = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bot in KB A',
      modelId: 'gpt-4o'
    })
    const botB = botRepo.create({
      knowledgeBaseId: otherKb.id,
      name: 'Bot in KB B',
      modelId: 'gpt-4o'
    })

    botRepo.delete(botA.id, defaultKbId)

    expect(botRepo.getById(botA.id, defaultKbId)).toBeNull()
    expect(botRepo.getById(botB.id, otherKb.id)).not.toBeNull()
  })

  it('42. verifies global provider connections remain intact after Bot deletion', () => {
    const prov = createProviderConnectionFixture(db, {
      id: '00000000-0000-4000-8000-000000000050',
      providerName: 'anthropic',
      connectionName: 'Shared Anthropic'
    })

    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Bot using Shared Key',
      modelId: 'claude-3-5-sonnet-20241022',
      providerConnectionId: prov.id
    })

    botRepo.delete(bot.id, defaultKbId)

    const fetchedProv = db
      .prepare('SELECT id, label FROM provider_connections WHERE id = ?')
      .get(prov.id)
    expect(fetchedProv).toBeDefined()
  })

  // === Final Integrity Tests ===

  it('43. executes PRAGMA foreign_key_check and verifies zero violations', () => {
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toEqual([])
  })

  it('44. rejects instantiation when database instance is not provided', () => {
    expect(() => new BotRepository(null as unknown as Database.Database)).toThrow(RepositoryError)
  })

  // === Authoritative getByIdOnly Tests ===

  it('45. retrieves Bot strictly by botId and resolves its authoritative parent Knowledge Base ID', () => {
    const bot = botRepo.create({
      knowledgeBaseId: defaultKbId,
      name: 'Authoritative Scope Bot',
      modelId: 'gpt-4o'
    })

    const fetched = botRepo.getByIdOnly(bot.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(bot.id)
    expect(fetched?.knowledgeBaseId).toBe(defaultKbId)
    expect(fetched?.name).toBe('Authoritative Scope Bot')
  })

  it('46. returns null when getByIdOnly is given a non-existent Bot UUID', () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000999'
    const fetched = botRepo.getByIdOnly(nonExistentId)
    expect(fetched).toBeNull()
  })

  it('47. throws ValidationError when getByIdOnly is given an invalid UUID string', () => {
    expect(() => botRepo.getByIdOnly('invalid-uuid')).toThrow(ValidationError)
  })

  describe('Step 12.3: Response Policy Persistence & Isolation', () => {
    it('48. defaults omitted responsePolicy to balanced_kb_first on creation', () => {
      const created = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Default Policy Bot',
        modelId: 'gpt-4o'
      })
      expect(created.responsePolicy).toBe('balanced_kb_first')

      const fetched = botRepo.getById(created.id, defaultKbId)
      expect(fetched?.responsePolicy).toBe('balanced_kb_first')
    })

    it('49. persists and reloads all three response policies faithfully', () => {
      const strictBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Strict Policy Bot',
        modelId: 'gpt-4o',
        responsePolicy: 'strict_kb_only'
      })
      const balancedBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Balanced Policy Bot',
        modelId: 'gpt-4o',
        responsePolicy: 'balanced_kb_first'
      })
      const generalBot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'General Policy Bot',
        modelId: 'gpt-4o',
        responsePolicy: 'general_ai_chat'
      })

      expect(botRepo.getById(strictBot.id, defaultKbId)?.responsePolicy).toBe('strict_kb_only')
      expect(botRepo.getByIdOnly(balancedBot.id)?.responsePolicy).toBe('balanced_kb_first')
      const listed = botRepo.listByKnowledgeBase(defaultKbId)
      expect(listed.find((b) => b.id === generalBot.id)?.responsePolicy).toBe('general_ai_chat')
    })

    it('50. updates responsePolicy independently without modifying toolPermissions and vice versa', () => {
      const bot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Independent Policy Bot',
        modelId: 'gpt-4o',
        responsePolicy: 'strict_kb_only',
        toolPermissions: ['search_knowledge_base', 'prepare_report']
      })

      const policyUpdated = botRepo.update(bot.id, defaultKbId, {
        responsePolicy: 'general_ai_chat'
      })
      expect(policyUpdated?.responsePolicy).toBe('general_ai_chat')
      expect(policyUpdated?.toolPermissions).toEqual(['search_knowledge_base', 'prepare_report'])

      const toolsUpdated = botRepo.update(bot.id, defaultKbId, {
        toolPermissions: ['read_project_file']
      })
      expect(toolsUpdated?.responsePolicy).toBe('general_ai_chat')
      expect(toolsUpdated?.toolPermissions).toEqual(['read_project_file'])
    })

    it('51. rejects invalid responsePolicy inputs on create and update', () => {
      expect(() =>
        botRepo.create({
          knowledgeBaseId: defaultKbId,
          name: 'Invalid Policy',
          modelId: 'gpt-4o',
          responsePolicy: 'invalid_mode' as never
        })
      ).toThrow(ValidationError)

      const valid = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Valid Policy Bot',
        modelId: 'gpt-4o'
      })

      expect(() =>
        botRepo.update(valid.id, defaultKbId, {
          responsePolicy: 'invalid_mode' as never
        })
      ).toThrow(ValidationError)
    })

    it('52. rejects corrupted database response_policy rows defensively on read', () => {
      const bot = botRepo.create({
        knowledgeBaseId: defaultKbId,
        name: 'Corruption Check Bot',
        modelId: 'gpt-4o'
      })

      db.prepare('PRAGMA ignore_check_constraints = ON').run()
      db.prepare('UPDATE bots SET response_policy = ? WHERE id = ?').run('corrupt_value', bot.id)
      db.prepare('PRAGMA ignore_check_constraints = OFF').run()

      expect(() => botRepo.getById(bot.id, defaultKbId)).toThrow(RepositoryError)
    })
  })
})
