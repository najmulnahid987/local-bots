import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import {
  createMigratedTestDatabase,
  createKnowledgeBaseFixture,
  createBotFixture,
  createProviderConnectionFixture,
  seedTestWorkspace
} from './index'

describe('Database Testing Helpers and Fixtures (database/testing)', () => {
  it('1. creates a migrated test database context with active repositories and clean cleanup', () => {
    const context = createMigratedTestDatabase()

    try {
      expect(context.db).toBeDefined()
      expect(context.manager.isOpen()).toBe(true)
      expect(existsSync(context.tempDir)).toBe(true)
      expect(existsSync(context.dbPath)).toBe(true)
      expect(context.kbRepo).toBeDefined()
      expect(context.botRepo).toBeDefined()

      // Verify production WAL and durability pragmas are active
      expect(String(context.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
      expect(Number(context.db.pragma('synchronous', { simple: true }))).toBe(2)
      expect(Number(context.db.pragma('foreign_keys', { simple: true }))).toBe(1)
      expect(Number(context.db.pragma('busy_timeout', { simple: true }))).toBe(5000)
      expect(Number(context.db.pragma('wal_autocheckpoint', { simple: true }))).toBe(1000)

      // Verify migration 001 was applied
      const tables = context.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
        )
        .all() as { name: string }[]
      expect(tables.map((t) => t.name)).toContain('knowledge_bases')
      expect(tables.map((t) => t.name)).toContain('bots')
      expect(tables.map((t) => t.name)).toContain('schema_migrations')
    } finally {
      context.cleanup()
      expect(context.manager.isOpen()).toBe(false)
      expect(existsSync(context.tempDir)).toBe(false)
    }
  })

  it('2. creates knowledge base and bot fixtures with unique names and approved tool permissions', () => {
    const context = createMigratedTestDatabase()

    try {
      const kb = createKnowledgeBaseFixture(context.kbRepo, {
        description: 'Custom Fixture Description'
      })
      expect(kb).toBeDefined()
      expect(kb.name).toContain('Test Knowledge Base')
      expect(kb.description).toBe('Custom Fixture Description')

      const bot = createBotFixture(context.botRepo, kb.id, {
        toolPermissions: ['search_knowledge_base', 'prepare_report']
      })
      expect(bot).toBeDefined()
      expect(bot.knowledgeBaseId).toBe(kb.id)
      expect(bot.toolPermissions).toEqual(['search_knowledge_base', 'prepare_report'])
    } finally {
      context.cleanup()
    }
  })

  it('3. creates a synthetic provider connection fixture with fake BLOB credentials', () => {
    const context = createMigratedTestDatabase()

    try {
      const prov = createProviderConnectionFixture(context.db, {
        providerName: 'openai',
        connectionName: 'Synthetic OpenAI Key'
      })
      expect(prov.id).toBeDefined()
      expect(prov.providerName).toBe('openai')
      expect(prov.connectionName).toBe('Synthetic OpenAI Key')

      // Verify stored in DB
      const row = context.db
        .prepare('SELECT id, encrypted_credentials FROM provider_connections WHERE id = ?')
        .get(prov.id) as { id: string; encrypted_credentials: Buffer }
      expect(row).toBeDefined()
      expect(Buffer.isBuffer(row.encrypted_credentials)).toBe(true)
    } finally {
      context.cleanup()
    }
  })

  it('4. seeds a connected test workspace preserving Knowledge Base isolation', () => {
    const context = createMigratedTestDatabase()

    try {
      const workspace = seedTestWorkspace({
        kbRepo: context.kbRepo,
        botRepo: context.botRepo
      })

      // Verify Knowledge Base A and resident bots
      expect(workspace.kbA.name).toBe('Workspace Alpha KB')
      expect(workspace.botAlpha.knowledgeBaseId).toBe(workspace.kbA.id)
      expect(workspace.botBeta.knowledgeBaseId).toBe(workspace.kbA.id)

      // Verify Knowledge Base B and resident bot
      expect(workspace.kbB.name).toBe('Workspace Beta KB')
      expect(workspace.botGamma.knowledgeBaseId).toBe(workspace.kbB.id)

      // Verify listByKnowledgeBase isolation
      const botsA = context.botRepo.listByKnowledgeBase(workspace.kbA.id)
      const botsB = context.botRepo.listByKnowledgeBase(workspace.kbB.id)

      expect(botsA).toHaveLength(2)
      expect(botsA.map((b) => b.id).sort()).toEqual(
        [workspace.botAlpha.id, workspace.botBeta.id].sort()
      )

      expect(botsB).toHaveLength(1)
      expect(botsB[0].id).toBe(workspace.botGamma.id)

      // Deleting Knowledge Base A deletes Bot Alpha & Beta while leaving KB B and Bot Gamma intact
      context.kbRepo.delete(workspace.kbA.id)
      expect(context.botRepo.getById(workspace.botAlpha.id, workspace.kbA.id)).toBeNull()
      expect(context.botRepo.getById(workspace.botBeta.id, workspace.kbA.id)).toBeNull()
      expect(context.botRepo.getById(workspace.botGamma.id, workspace.kbB.id)).not.toBeNull()
      expect(context.kbRepo.getById(workspace.kbB.id)).not.toBeNull()
    } finally {
      context.cleanup()
    }
  })
})
