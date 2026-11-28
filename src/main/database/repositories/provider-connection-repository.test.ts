import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations, migrations } from '../migrations'
import { type CredentialRef } from '../../security/credential-vault'
import {
  ProviderConnectionRepository,
  type ProviderId,
  type ProviderConnectionStatus,
  RepositoryError,
  ValidationError
} from './index'

describe('ProviderConnectionRepository (Phase 3 Step 3.2)', () => {
  let db: Database.Database
  let repo: ProviderConnectionRepository

  const makeCredRef = (): CredentialRef => `cred_${randomUUID()}` as CredentialRef

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repo = new ProviderConnectionRepository(db)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('1. creates a new provider connection with valid metadata and defaults to active status', () => {
    const credRef = makeCredRef()
    const conn = repo.create({
      providerId: 'openai',
      label: 'My Work OpenAI Key',
      credentialRef: credRef
    })

    expect(conn.id).toBeDefined()
    expect(conn.providerId).toBe('openai')
    expect(conn.label).toBe('My Work OpenAI Key')
    expect(conn.credentialRef).toBe(credRef)
    expect(conn.status).toBe('active')
    expect(conn.createdAt).toBeGreaterThan(0)
    expect(conn.updatedAt).toBe(conn.createdAt)
  })

  it('2. creates connections for all approved first-wave providers (openai, anthropic, google)', () => {
    const providers: ProviderId[] = ['openai', 'anthropic', 'google']

    for (const p of providers) {
      const conn = repo.create({
        providerId: p,
        label: `${p} connection`,
        credentialRef: makeCredRef()
      })
      expect(conn.providerId).toBe(p)
      expect(conn.status).toBe('active')
      const fetched = repo.getById(conn.id)
      expect(fetched).toEqual(conn)
    }
  })

  it('3. rejects creation with invalid or blank labels', () => {
    const credRef = makeCredRef()

    expect(() =>
      repo.create({
        providerId: 'anthropic',
        label: '',
        credentialRef: credRef
      })
    ).toThrow(ValidationError)

    expect(() =>
      repo.create({
        providerId: 'anthropic',
        label: '   ',
        credentialRef: credRef
      })
    ).toThrow(ValidationError)

    expect(() =>
      repo.create({
        providerId: 'anthropic',
        label: 'a'.repeat(256),
        credentialRef: credRef
      })
    ).toThrow(ValidationError)
  })

  it('4. rejects creation with unsupported provider IDs', () => {
    const credRef = makeCredRef()

    expect(() =>
      repo.create({
        providerId: 'unsupported_vendor' as unknown as ProviderId,
        label: 'Bad Provider',
        credentialRef: credRef
      })
    ).toThrow(ValidationError)

    // xAI remains deferred at application level
    expect(() =>
      repo.create({
        providerId: 'xai' as unknown as ProviderId,
        label: 'xAI',
        credentialRef: credRef
      })
    ).toThrow(ValidationError)
  })

  it('5. rejects creation with malformed credential references', () => {
    const invalidRefs = [
      'not-a-cred-ref',
      'cred_123',
      'sk-ant-api-key-plaintext',
      '../path-traversal',
      'cred_550e8400-e29b-41d4-a716-446655440000/extra',
      ''
    ]

    for (const badRef of invalidRefs) {
      expect(() =>
        repo.create({
          providerId: 'google',
          label: 'Google Gemini',
          credentialRef: badRef as unknown as CredentialRef
        })
      ).toThrow(ValidationError)
    }
  })

  it('6. enforces unique credential references across connections', () => {
    const duplicateRef = makeCredRef()

    repo.create({
      providerId: 'openai',
      label: 'First Connection',
      credentialRef: duplicateRef
    })

    expect(() =>
      repo.create({
        providerId: 'google',
        label: 'Second Connection with Same Ref',
        credentialRef: duplicateRef
      })
    ).toThrow(RepositoryError)
  })

  it('7. returns null when querying a non-existent connection ID', () => {
    const nonExistentId = randomUUID()
    expect(repo.getById(nonExistentId)).toBeNull()
  })

  it('8. throws ValidationError when passing a non-UUID ID to getById', () => {
    expect(() => repo.getById('invalid-uuid')).toThrow(ValidationError)
  })

  it('9. lists all provider connections ordered by createdAt descending', async () => {
    expect(repo.list()).toEqual([])

    const conn1 = repo.create({
      providerId: 'openai',
      label: 'OpenAI 1',
      credentialRef: makeCredRef()
    })

    // Brief delay to ensure distinct timestamp
    await new Promise((r) => setTimeout(r, 5))

    const conn2 = repo.create({
      providerId: 'anthropic',
      label: 'Claude 2',
      credentialRef: makeCredRef()
    })

    const list = repo.list()
    expect(list.length).toBe(2)
    expect(list[0].id).toBe(conn2.id)
    expect(list[1].id).toBe(conn1.id)
  })

  it('10. updates connection label successfully and updates timestamp', async () => {
    const conn = repo.create({
      providerId: 'anthropic',
      label: 'Original Label',
      credentialRef: makeCredRef()
    })

    await new Promise((r) => setTimeout(r, 5))

    const updated = repo.updateLabel(conn.id, 'Renamed Claude Key')
    expect(updated.label).toBe('Renamed Claude Key')
    expect(updated.updatedAt).toBeGreaterThan(conn.updatedAt)

    // Rejects empty label
    expect(() => repo.updateLabel(conn.id, '   ')).toThrow(ValidationError)

    // Throws on non-existent connection
    expect(() => repo.updateLabel(randomUUID(), 'New Name')).toThrow(ValidationError)
  })

  it('11. updates credential reference during key replacement and enforces uniqueness', () => {
    const refA = makeCredRef()
    const refB = makeCredRef()

    const connA = repo.create({
      providerId: 'openai',
      label: 'Key A',
      credentialRef: refA
    })

    repo.create({
      providerId: 'openai',
      label: 'Key B',
      credentialRef: refB
    })

    const newRef = makeCredRef()
    const updatedA = repo.updateCredentialRef(connA.id, newRef)
    expect(updatedA.credentialRef).toBe(newRef)

    // Attempting to assign connB's existing credentialRef to connA must fail
    expect(() => repo.updateCredentialRef(connA.id, refB)).toThrow(RepositoryError)

    // Throws on non-existent connection
    expect(() => repo.updateCredentialRef(randomUUID(), makeCredRef())).toThrow(ValidationError)
  })

  it('12. updates status between active, revoked, and error states', () => {
    const conn = repo.create({
      providerId: 'google',
      label: 'Gemini Key',
      credentialRef: makeCredRef(),
      status: 'active'
    })

    const revoked = repo.updateStatus(conn.id, 'revoked')
    expect(revoked.status).toBe('revoked')

    const errored = repo.updateStatus(conn.id, 'error')
    expect(errored.status).toBe('error')

    expect(() =>
      repo.updateStatus(conn.id, 'invalid_status' as unknown as ProviderConnectionStatus)
    ).toThrow(ValidationError)
  })

  it('13. deletes connection successfully when no Bot references it', () => {
    const conn = repo.create({
      providerId: 'openai',
      label: 'Unused Key',
      credentialRef: makeCredRef()
    })

    const deleted = repo.delete(conn.id)
    expect(deleted).toBe(true)
    expect(repo.getById(conn.id)).toBeNull()

    // Deleting again returns false (not found)
    expect(repo.delete(conn.id)).toBe(false)
  })

  it('14. prevents deletion (ON DELETE RESTRICT) when a Bot references the provider connection', () => {
    const conn = repo.create({
      providerId: 'anthropic',
      label: 'Referenced Key',
      credentialRef: makeCredRef()
    })

    const kbId = randomUUID()
    const now = Date.now()
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Test KB', `documents/${kbId}`, now, now)

    const botId = randomUUID()
    db.prepare(
      'INSERT INTO bots (id, knowledge_base_id, provider_connection_id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(botId, kbId, conn.id, 'Attached Bot', 'claude-3-5-sonnet-20241022', now, now)

    // Deletion must be blocked
    expect(() => repo.delete(conn.id)).toThrow(RepositoryError)

    // After deleting or unlinking the Bot, provider connection can be deleted
    db.prepare('DELETE FROM bots WHERE id = ?').run(botId)
    expect(repo.delete(conn.id)).toBe(true)
  })

  it('15. verifies repository data contains zero secret bytes, passwords, or raw keys', () => {
    const credRef = makeCredRef()
    const conn = repo.create({
      providerId: 'openai',
      label: 'Sanitized Connection',
      credentialRef: credRef
    })

    const rawRow = db
      .prepare('SELECT * FROM provider_connections WHERE id = ?')
      .get(conn.id) as Record<string, unknown>

    expect(rawRow.encrypted_credentials).toBeUndefined()
    expect(rawRow.key_preview).toBeUndefined()
    expect(rawRow.api_key).toBeUndefined()
    expect(rawRow.password).toBeUndefined()
    expect(rawRow.credential_ref).toBe(credRef)
  })
})
