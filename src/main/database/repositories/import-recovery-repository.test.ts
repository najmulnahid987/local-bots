import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations/index'
import { ImportRecoveryRepository } from './import-recovery-repository'

describe('ImportRecoveryRepository', () => {
  let db: Database.Database
  let repo: ImportRecoveryRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repo = new ImportRecoveryRepository(db)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('creates and retrieves a new import recovery journal entry', () => {
    const id = randomUUID()
    const entry = repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseId: randomUUID(),
      targetKnowledgeBaseName: 'Alpha KB',
      archiveSha256: 'a'.repeat(64),
      archiveName: 'alpha.voyaro-kb.zip',
      state: 'preparing',
      stagingDirName: `import-staging-${id}`
    })

    expect(entry.id).toBe(id)
    expect(entry.strategy).toBe('replace')
    expect(entry.targetKnowledgeBaseName).toBe('Alpha KB')
    expect(entry.state).toBe('preparing')
    expect(entry.promotedFiles).toEqual([])
    expect(entry.remapping).toEqual({})

    const fetched = repo.getById(id)
    expect(fetched).toEqual(entry)
  })

  it('transitions state and updates metadata', () => {
    const id = randomUUID()
    repo.create({
      id,
      strategy: 'replace',
      targetKnowledgeBaseName: 'Alpha KB',
      archiveSha256: 'a'.repeat(64),
      archiveName: 'alpha.voyaro-kb.zip',
      stagingDirName: `import-staging-${id}`
    })

    const updated = repo.updateState(id, 'quarantining', {
      quarantineDirName: '.quarantine_originals_123',
      promotedFiles: ['originals/file1.txt'],
      remapping: { bots: { 'old-1': 'new-1' } }
    })

    expect(updated.state).toBe('quarantining')
    expect(updated.quarantineDirName).toBe('.quarantine_originals_123')
    expect(updated.promotedFiles).toEqual(['originals/file1.txt'])
    expect(updated.remapping).toEqual({ bots: { 'old-1': 'new-1' } })

    const fetched = repo.getById(id)
    expect(fetched?.state).toBe('quarantining')
  })

  it('filters pending operations excluding completed, cancelled, failed', () => {
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()
    const id4 = randomUUID()

    repo.create({
      id: id1,
      strategy: 'new',
      targetKnowledgeBaseName: 'KB 1',
      archiveSha256: 'b'.repeat(64),
      archiveName: 'kb1.zip',
      stagingDirName: 'stage-1',
      state: 'staging'
    })

    repo.create({
      id: id2,
      strategy: 'merge',
      targetKnowledgeBaseName: 'KB 2',
      archiveSha256: 'c'.repeat(64),
      archiveName: 'kb2.zip',
      stagingDirName: 'stage-2',
      state: 'database_committing'
    })

    repo.create({
      id: id3,
      strategy: 'replace',
      targetKnowledgeBaseName: 'KB 3',
      archiveSha256: 'd'.repeat(64),
      archiveName: 'kb3.zip',
      stagingDirName: 'stage-3',
      state: 'completed'
    })

    repo.create({
      id: id4,
      strategy: 'replace',
      targetKnowledgeBaseName: 'KB 4',
      archiveSha256: 'e'.repeat(64),
      archiveName: 'kb4.zip',
      stagingDirName: 'stage-4',
      state: 'failed'
    })

    const pending = repo.listPending()
    expect(pending.map((p) => p.id)).toEqual([id1, id2])
  })

  it('prunes completed entries older than threshold', () => {
    const id1 = randomUUID()
    const id2 = randomUUID()

    repo.create({
      id: id1,
      strategy: 'new',
      targetKnowledgeBaseName: 'Old KB',
      archiveSha256: 'f'.repeat(64),
      archiveName: 'old.zip',
      stagingDirName: 'stage-old',
      state: 'completed'
    })

    repo.create({
      id: id2,
      strategy: 'new',
      targetKnowledgeBaseName: 'Active KB',
      archiveSha256: '0'.repeat(64),
      archiveName: 'active.zip',
      stagingDirName: 'stage-active',
      state: 'staging'
    })

    // Set created_at and updated_at back
    db.prepare(
      'UPDATE import_recovery_journal SET created_at = 500, updated_at = 500 WHERE id = ?'
    ).run(id1)

    const pruned = repo.deleteCompletedBefore(1000)
    expect(pruned).toBe(1)
    expect(repo.getById(id1)).toBeNull()
    expect(repo.getById(id2)).not.toBeNull()
  })
})
