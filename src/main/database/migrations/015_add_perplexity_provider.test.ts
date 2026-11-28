import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations, getMigrationStatus } from './runner'
import { migrations } from './index'

describe('Migration 015: Add Perplexity Provider Support', () => {
  let db: Database.Database
  const v14Migrations = migrations.slice(0, 14)
  const v15Migrations = migrations.slice(0, 15)

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. preserves all existing provider connections and bot FK links across v14 -> v15 upgrade', () => {
    runMigrations(db, v14Migrations)

    const now = Date.now()
    const kbId = randomUUID()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Research KB', 'Docs', '/tmp/research-kb', ?, ?)
      `
    ).run(kbId, now, now)

    const existingProviders = [
      'openai',
      'anthropic',
      'google',
      'groq',
      'xai',
      'openrouter'
    ] as const
    const connectionIds: Record<string, string> = {}

    for (const provider of existingProviders) {
      const id = randomUUID()
      connectionIds[provider] = id
      db.prepare(
        `
        INSERT INTO provider_connections (
          id, provider_id, label, credential_ref, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
        `
      ).run(id, provider, `${provider} key`, `cred_${id}`, now, now)
    }

    const botId = randomUUID()
    db.prepare(
      `
      INSERT INTO bots (
        id, knowledge_base_id, provider_connection_id, name, description,
        system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'Groq Bot', 'Desc', 'Sys', 'llama-3.3-70b-versatile', 'active', 'balanced_kb_first', '[]', ?, ?)
      `
    ).run(botId, kbId, connectionIds.groq, now, now)

    // Verify perplexity is rejected prior to Migration 015
    expect(() =>
      db
        .prepare(
          `
          INSERT INTO provider_connections (
            id, provider_id, label, credential_ref, status, created_at, updated_at
          ) VALUES (?, 'perplexity', 'Pre-migration Perplexity', 'cred_pre_perplexity', 'active', ?, ?)
          `
        )
        .run(randomUUID(), now, now)
    ).toThrow()

    runMigrations(db, v15Migrations)

    const rows = db
      .prepare('SELECT id, provider_id, label, credential_ref, status FROM provider_connections')
      .all() as Array<{
      id: string
      provider_id: string
      label: string
      credential_ref: string
      status: string
    }>

    expect(rows).toHaveLength(existingProviders.length)
    for (const provider of existingProviders) {
      expect(rows.some((r) => r.id === connectionIds[provider] && r.provider_id === provider)).toBe(
        true
      )
    }

    const bot = db
      .prepare('SELECT id, provider_connection_id FROM bots WHERE id = ?')
      .get(botId) as { id: string; provider_connection_id: string | null }
    expect(bot.provider_connection_id).toBe(connectionIds.groq)

    const status = getMigrationStatus(db, v15Migrations)
    expect(status.currentVersion).toBe(15)
    expect(status.pendingCount).toBe(0)
  })

  it('2. allows inserting perplexity provider_connections while still rejecting unknown providers and recreating indexes', () => {
    runMigrations(db, v15Migrations)

    const now = Date.now()
    const pplxConnId = randomUUID()
    db.prepare(
      `
      INSERT INTO provider_connections (
        id, provider_id, label, credential_ref, status, created_at, updated_at
      ) VALUES (?, 'perplexity', 'Perplexity Primary', 'cred_pplx_1', 'active', ?, ?)
      `
    ).run(pplxConnId, now, now)

    const stored = db
      .prepare('SELECT id, provider_id, label FROM provider_connections WHERE id = ?')
      .get(pplxConnId) as { id: string; provider_id: string; label: string }
    expect(stored).toEqual({
      id: pplxConnId,
      provider_id: 'perplexity',
      label: 'Perplexity Primary'
    })

    for (const invalidProvider of ['cohere', 'mistral', 'unknown']) {
      expect(() =>
        db
          .prepare(
            `
            INSERT INTO provider_connections (
              id, provider_id, label, credential_ref, status, created_at, updated_at
            ) VALUES (?, ?, 'Bad', ?, 'active', ?, ?)
            `
          )
          .run(randomUUID(), invalidProvider, `cred_bad_${invalidProvider}`, now, now)
      ).toThrow()
    }

    const indexes = db.prepare("PRAGMA index_list('provider_connections')").all() as Array<{
      name: string
      unique: number
    }>
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_provider_connections_provider')
    expect(indexNames).toContain('idx_provider_connections_ref')
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('3. is idempotent when runMigrations is invoked repeatedly on fresh and upgraded databases', () => {
    runMigrations(db, v15Migrations)
    runMigrations(db, v15Migrations)

    const status = getMigrationStatus(db, v15Migrations)
    expect(status.currentVersion).toBe(15)
    expect(status.appliedCount).toBe(15)
    expect(status.pendingCount).toBe(0)
  })
})
