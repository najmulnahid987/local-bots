import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations/index'
import { DatabaseIntegrityService } from './database-integrity-service'

describe('DatabaseIntegrityService (Phase 9 Step 9.7)', () => {
  let db: Database.Database
  let tmpDir: string
  let dbPath: string
  let service: DatabaseIntegrityService

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-db-integrity-${randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    dbPath = path.join(tmpDir, 'test.sqlite')

    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    service = new DatabaseIntegrityService({
      db,
      databaseFilePath: dbPath
    })
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('1. reports healthy status for a newly migrated and consistent database', async () => {
    const health = await service.runIntegrityCheck()

    expect(health.status).toBe('healthy')
    expect(health.integrityStatus).toBe('ok')
    expect(health.foreignKeyStatus).toBe('ok')
    expect(health.databaseAvailable).toBe(true)
    expect(health.databaseSizeBytes).toBeGreaterThan(0)
    expect(health.violationsCount).toBe(0)
    expect(health.violations).toEqual([])
    expect(health.diagnosticCodes).toEqual([])
    expect(health.recoveryGuidance).toEqual([])
  })

  it('2. safely reports critical health when database is unavailable or closed', async () => {
    db.close()

    const health = await service.runIntegrityCheck()

    expect(health.status).toBe('critical')
    expect(health.integrityStatus).toBe('error')
    expect(health.foreignKeyStatus).toBe('error')
    expect(health.databaseAvailable).toBe(false)
    expect(health.diagnosticCodes).toContain('DB_UNAVAILABLE')
    expect(health.recoveryGuidance.length).toBeGreaterThan(0)
    expect(health.summary).toContain('unavailable or closed')
  })

  it('3. identifies foreign key violations and returns warning status with guidance', async () => {
    // Intentionally inject an invalid foreign key violation by disabling FK pragma temporarily
    db.pragma('foreign_keys = OFF')
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at)
      VALUES (?, ?, 'Orphan Bot', 'gpt-4o', ?, ?)
    `
    ).run(randomUUID(), 'non-existent-kb-id', now, now)
    db.pragma('foreign_keys = ON')

    const health = await service.runIntegrityCheck()

    expect(health.status).toBe('warning')
    expect(health.foreignKeyStatus).toBe('violations_detected')
    expect(health.violationsCount).toBe(1)
    expect(health.violations[0].table).toBe('bots')
    expect(health.violations[0].parent).toBe('knowledge_bases')
    expect(health.diagnosticCodes).toContain('DB_FK_VIOLATIONS')
    expect(health.recoveryGuidance).toContain(
      'Referential integrity violations detected across one or more tables.'
    )
  })

  it('4. guarantees read-only behavior: running checks does not mutate database records', async () => {
    const kbId = randomUUID()
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Read Only Test KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const beforeCount = db.prepare('SELECT count(*) as c FROM knowledge_bases').get() as {
      c: number
    }

    await service.runIntegrityCheck()
    await service.getDatabaseHealth()

    const afterCount = db.prepare('SELECT count(*) as c FROM knowledge_bases').get() as {
      c: number
    }
    expect(afterCount.c).toBe(beforeCount.c)
  })

  it('5. returns cached result via getDatabaseHealth if already verified', async () => {
    const first = await service.runIntegrityCheck()
    const second = await service.getDatabaseHealth()

    expect(second).toEqual(first)
  })
})
