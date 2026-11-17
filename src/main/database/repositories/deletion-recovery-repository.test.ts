import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { DeletionRecoveryRepository } from './deletion-recovery-repository'

describe('DeletionRecoveryRepository', () => {
  let db: Database.Database
  let repo: DeletionRecoveryRepository

  const validUuid = '11111111-2222-4333-8444-555555555555'
  const kbUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const sourceUuid = '22222222-3333-4444-8555-666666666666'

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repo = new DeletionRecoveryRepository(db)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('creates and retrieves a deletion recovery journal record', () => {
    const entry = repo.create({
      id: validUuid,
      entityType: 'knowledge_base',
      entityId: kbUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'Engineering Docs',
      quarantinePathName: '.quarantine_kb_test',
      originalRelPath: kbUuid,
      state: 'preparing'
    })

    expect(entry.id).toBe(validUuid)
    expect(entry.entityType).toBe('knowledge_base')
    expect(entry.state).toBe('preparing')
    expect(entry.quarantinePathName).toBe('.quarantine_kb_test')

    const fetched = repo.getById(validUuid)
    expect(fetched).toEqual(entry)
  })

  it('updates state and error message accurately', () => {
    repo.create({
      id: validUuid,
      entityType: 'knowledge_source',
      entityId: sourceUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'spec.pdf',
      quarantinePathName: '.quarantine_source_test',
      originalRelPath: 'originals/spec.pdf'
    })

    const updated = repo.updateState(validUuid, 'quarantining')
    expect(updated.state).toBe('quarantining')

    const failed = repo.updateState(validUuid, 'failed', 'Permission denied')
    expect(failed.state).toBe('failed')
    expect(failed.errorMessage).toBe('Permission denied')
  })

  it('lists active entries excluding completed and failed', () => {
    const id1 = '11111111-1111-4111-8111-111111111111'
    const id2 = '22222222-2222-4222-8222-222222222222'
    const id3 = '33333333-3333-4333-8333-333333333333'

    repo.create({
      id: id1,
      entityType: 'knowledge_base',
      entityId: kbUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'KB 1',
      quarantinePathName: '.quarantine_1',
      state: 'quarantining'
    })

    repo.create({
      id: id2,
      entityType: 'knowledge_source',
      entityId: sourceUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'file.txt',
      quarantinePathName: '.quarantine_2',
      state: 'database_deleting'
    })

    repo.create({
      id: id3,
      entityType: 'knowledge_base',
      entityId: kbUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'KB 2',
      quarantinePathName: '.quarantine_3',
      state: 'completed'
    })

    const active = repo.listActive()
    expect(active.length).toBe(2)
    expect(active.map((a) => a.id)).toEqual([id1, id2])
  })

  it('deletes an entry and cleans completed older than TTL', () => {
    repo.create({
      id: validUuid,
      entityType: 'knowledge_base',
      entityId: kbUuid,
      knowledgeBaseId: kbUuid,
      entityName: 'KB to delete',
      quarantinePathName: '.quarantine_del',
      state: 'completed'
    })

    expect(repo.delete(validUuid)).toBe(true)
    expect(repo.getById(validUuid)).toBeNull()
  })
})
