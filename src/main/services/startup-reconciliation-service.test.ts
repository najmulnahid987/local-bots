import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations/index'
import { ImportRecoveryRepository } from '../database/repositories/import-recovery-repository'
import { ImportRecoveryService } from './import-recovery-service'
import { StartupReconciliationService } from './startup-reconciliation-service'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'

describe('StartupReconciliationService', () => {
  let db: Database.Database
  let importRepo: ImportRecoveryRepository
  let sourceRepo: KnowledgeSourceRepository
  let storageManager: DocumentStorageManager
  let importRecoveryService: ImportRecoveryService
  let service: StartupReconciliationService
  let tmpDir: string
  let docsDir: string
  let tempBaseDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-startup-recon-${randomUUID()}`)
    docsDir = path.join(tmpDir, 'documents')
    tempBaseDir = path.join(tmpDir, 'temp')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.mkdirSync(tempBaseDir, { recursive: true })

    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    importRepo = new ImportRecoveryRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)
    storageManager = new DocumentStorageManager({ documentsDir: docsDir })
    importRecoveryService = new ImportRecoveryService({
      db,
      journalRepository: importRepo,
      storageManager,
      tempBaseDir
    })
    service = new StartupReconciliationService({
      db,
      importRecoveryService,
      storageManager,
      sourceRepository: sourceRepo,
      tempBaseDir,
      stagingTtlMs: 0 // Immediate expiration for test
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

  it('1. reconciles interrupted document indexing jobs to failed state with clear explanation', async () => {
    const kbId = randomUUID()
    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Test KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    const source1Id = randomUUID()
    const source2Id = randomUUID()
    const source3Id = randomUUID()

    // Source 1: 'processing' with file existing on disk
    const originalsDir = storageManager.resolveOriginalsDirectory(kbId)
    fs.mkdirSync(originalsDir, { recursive: true })
    const file1Path = path.join(originalsDir, `${source1Id}.txt`)
    fs.writeFileSync(file1Path, 'Valid file content')

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'file1.txt', 'file1.txt', ?, 'txt', 'text/plain', 18, ?, 'processing', ?, ?)
    `
    ).run(source1Id, kbId, `originals/${source1Id}.txt`, 'a'.repeat(64), now, now)

    // Source 2: 'queued' with file missing from disk
    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'missing.txt', 'missing.txt', ?, 'txt', 'text/plain', 10, ?, 'queued', ?, ?)
    `
    ).run(source2Id, kbId, `originals/${source2Id}.txt`, 'b'.repeat(64), now, now)

    // Source 3: 'completed' should not be touched
    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (?, ?, 'done.txt', 'done.txt', ?, 'txt', 'text/plain', 10, ?, 'completed', ?, ?)
    `
    ).run(source3Id, kbId, `originals/${source3Id}.txt`, 'c'.repeat(64), now, now)

    const report = await service.reconcile()
    expect(report.reconciledSourcesCount).toBe(2)

    const row1 = db
      .prepare('SELECT indexing_status, error_message FROM knowledge_sources WHERE id = ?')
      .get(source1Id) as {
      indexing_status: string
      error_message: string
    }
    expect(row1.indexing_status).toBe('failed')
    expect(row1.error_message).toContain(
      'INTERRUPTED: Indexing was interrupted by an unexpected application restart.'
    )

    const row2 = db
      .prepare('SELECT indexing_status, error_message FROM knowledge_sources WHERE id = ?')
      .get(source2Id) as {
      indexing_status: string
      error_message: string
    }
    expect(row2.indexing_status).toBe('failed')
    expect(row2.error_message).toContain('missing from storage')

    const row3 = db
      .prepare('SELECT indexing_status FROM knowledge_sources WHERE id = ?')
      .get(source3Id) as {
      indexing_status: string
    }
    expect(row3.indexing_status).toBe('completed')
  })

  it('2. reconciles interrupted agent runs and pending tool events without executing unapproved tools', async () => {
    const kbId = randomUUID()
    const botId = randomUUID()
    const now = Date.now()

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Agent KB', 'Desc', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    db.prepare(
      `
      INSERT INTO bots (id, knowledge_base_id, name, model_id, created_at, updated_at)
      VALUES (?, ?, 'Test Bot', 'gpt-4o', ?, ?)
    `
    ).run(botId, kbId, now, now)

    const run1Id = randomUUID()
    const run2Id = randomUUID()
    const run3Id = randomUUID()

    // Run 1: 'running' with a pending tool event
    db.prepare(
      `
      INSERT INTO agent_runs (id, bot_id, knowledge_base_id, status, selected_model, started_at)
      VALUES (?, ?, ?, 'running', 'gpt-4o', ?)
    `
    ).run(run1Id, botId, kbId, now)

    db.prepare(
      `
      INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, status, approval_status, started_at)
      VALUES (?, ?, 1, 'read_file', 'pending', 'pending_approval', ?)
    `
    ).run(randomUUID(), run1Id, now)

    // Run 2: 'awaiting_approval' with running tool event
    db.prepare(
      `
      INSERT INTO agent_runs (id, bot_id, knowledge_base_id, status, selected_model, started_at)
      VALUES (?, ?, ?, 'awaiting_approval', 'gpt-4o', ?)
    `
    ).run(run2Id, botId, kbId, now)

    db.prepare(
      `
      INSERT INTO tool_events (id, agent_run_id, sequence_number, tool_name, status, approval_status, started_at)
      VALUES (?, ?, 1, 'search_files', 'running', 'user_approved', ?)
    `
    ).run(randomUUID(), run2Id, now)

    // Run 3: 'completed' should not be touched
    db.prepare(
      `
      INSERT INTO agent_runs (id, bot_id, knowledge_base_id, status, selected_model, started_at, completed_at)
      VALUES (?, ?, ?, 'completed', 'gpt-4o', ?, ?)
    `
    ).run(run3Id, botId, kbId, now, now)

    const report = await service.reconcile()
    expect(report.reconciledAgentRunsCount).toBe(2)
    expect(report.reconciledToolEventsCount).toBe(2)

    const r1 = db
      .prepare('SELECT status, error_summary, completed_at FROM agent_runs WHERE id = ?')
      .get(run1Id) as {
      status: string
      error_summary: string
      completed_at: number
    }
    expect(r1.status).toBe('failed')
    expect(r1.error_summary).toContain(
      'Task was interrupted because the application exited before completion.'
    )
    expect(r1.completed_at).toBeGreaterThan(0)

    const t1 = db
      .prepare('SELECT status, error_message FROM tool_events WHERE agent_run_id = ?')
      .get(run1Id) as {
      status: string
      error_message: string
    }
    expect(t1.status).toBe('failed')
    expect(t1.error_message).toContain(
      'Task was interrupted because the application exited before completion.'
    )

    const r3 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(run3Id) as {
      status: string
    }
    expect(r3.status).toBe('completed')
  })

  it('3. cleans up abandoned staging directories while protecting active or recovery_required directories', async () => {
    // Directory 1: abandoned import staging
    const abandonedDir1 = path.join(tempBaseDir, 'import-staging-abandoned-1')
    fs.mkdirSync(abandonedDir1, { recursive: true })
    fs.writeFileSync(path.join(abandonedDir1, 'temp.txt'), 'Abandoned')

    // Directory 2: protected import staging referenced by recovery_required journal
    const protectedDir = path.join(tempBaseDir, 'import-staging-protected')
    fs.mkdirSync(protectedDir, { recursive: true })
    fs.writeFileSync(path.join(protectedDir, 'important.txt'), 'Important')

    importRepo.create({
      id: randomUUID(),
      strategy: 'replace',
      targetKnowledgeBaseName: 'Protected KB',
      archiveSha256: '0'.repeat(64),
      archiveName: 'protected.zip',
      state: 'recovery_required',
      stagingDirName: 'import-staging-protected'
    })

    // Directory 3: non-staging directory (must not be deleted)
    const otherDir = path.join(tempBaseDir, 'unrelated-dir')
    fs.mkdirSync(otherDir, { recursive: true })

    const report = await service.reconcile()
    expect(report.cleanedStagingDirsCount).toBe(1)

    expect(fs.existsSync(abandonedDir1)).toBe(false)
    expect(fs.existsSync(protectedDir)).toBe(true)
    expect(fs.existsSync(otherDir)).toBe(true)
  })
})
