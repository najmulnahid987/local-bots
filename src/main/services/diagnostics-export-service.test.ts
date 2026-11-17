import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations/index'
import { DatabaseIntegrityService } from './database-integrity-service'
import { ApplicationErrorRingBuffer } from './error-ring-buffer'
import { DiagnosticsCollector } from './diagnostics-collector'
import { DiagnosticsExportService } from './diagnostics-export-service'
import { SecretScanner } from './secret-scanner'
import { DIAGNOSTICS_FORMAT, DIAGNOSTICS_SCHEMA_VERSION } from '../../shared/diagnostics'

describe('DiagnosticsExportService & DiagnosticsCollector (Phase 9 Step 9.7)', () => {
  let db: Database.Database
  let tmpDir: string
  let integrityService: DatabaseIntegrityService
  let ringBuffer: ApplicationErrorRingBuffer
  let collector: DiagnosticsCollector
  let exportService: DiagnosticsExportService
  let selectedSavePath: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-diagnostics-export-${randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.sqlite')
    selectedSavePath = path.join(tmpDir, 'exported-diagnostics.json')

    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    // Seed some test rows
    const now = Date.now()
    const kbId = randomUUID()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, description, storage_path, created_at, updated_at)
      VALUES (?, 'Sample KB', 'Description', ?, ?, ?)
    `
    ).run(kbId, `documents/${kbId}`, now, now)

    db.prepare(
      `
      INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at)
      VALUES (?, 'openai', 'My OpenAI', 'cred_12345678-1234-4234-8234-123456789abc', 'active', ?, ?)
    `
    ).run(randomUUID(), now, now)

    integrityService = new DatabaseIntegrityService({ db, databaseFilePath: dbPath })
    ringBuffer = new ApplicationErrorRingBuffer()
    ringBuffer.addError({
      code: 'NETWORK_TIMEOUT',
      category: 'provider',
      message: 'Failed to contact provider service within timeout.'
    })

    collector = new DiagnosticsCollector({
      db,
      integrityService,
      errorRingBuffer: ringBuffer,
      tempBaseDir: tmpDir,
      appVersion: '1.2.3'
    })

    exportService = new DiagnosticsExportService({
      collector,
      showSaveDialog: async () => ({
        canceled: false,
        filePath: selectedSavePath
      })
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

  it('1. collects and exports valid, schema-compliant technical diagnostics file', async () => {
    const result = await exportService.exportDiagnostics()

    expect(result.success).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(result.filename).toBe('exported-diagnostics.json')
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.verified).toBe(true)

    // Confirm file exists on disk and parses cleanly
    expect(fs.existsSync(selectedSavePath)).toBe(true)
    const fileContent = fs.readFileSync(selectedSavePath, 'utf8')
    const parsed = JSON.parse(fileContent)

    expect(parsed.format).toBe(DIAGNOSTICS_FORMAT)
    expect(parsed.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION)
    expect(parsed.environment.appVersion).toBe('1.2.3')
    expect(parsed.databaseMetrics.knowledgeBasesCount).toBe(1)
    expect(parsed.providerStatus.configuredProviders).toEqual(['openai'])
    expect(parsed.providerStatus.hasActiveConnection).toBe(true)
    expect(parsed.recentErrors).toHaveLength(1)
    expect(parsed.recentErrors[0].code).toBe('NETWORK_TIMEOUT')
  })

  it('2. handles native Save As dialog cancellation cleanly without writing file', async () => {
    const cancelService = new DiagnosticsExportService({
      collector,
      showSaveDialog: async () => ({
        canceled: true,
        filePath: undefined
      })
    })

    const result = await cancelService.exportDiagnostics()
    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(result.filename).toBeUndefined()
    expect(fs.existsSync(selectedSavePath)).toBe(false)
  })

  it('3. blocks export and throws if secret scanner detects credential patterns', async () => {
    // Custom mock scanner that simulates finding a secret
    const strictScanner = new SecretScanner([
      {
        name: 'Mock Leak Detector',
        regex: /forbidden_token/
      }
    ])

    // Mock collector output containing forbidden token
    const mockCollector = {
      collect: async () => {
        const raw = await collector.collect()
        return {
          ...raw,
          environment: {
            ...raw.environment,
            appVersion: 'forbidden_token_123'
          }
        }
      }
    } as unknown as DiagnosticsCollector

    const strictExportService = new DiagnosticsExportService({
      collector: mockCollector,
      secretScanner: strictScanner,
      showSaveDialog: async () => ({
        canceled: false,
        filePath: selectedSavePath
      })
    })

    await expect(strictExportService.exportDiagnostics()).rejects.toThrow(
      /Security check failed: Diagnostics output matched forbidden credential signature/
    )

    // Ensure file was NEVER written to disk
    expect(fs.existsSync(selectedSavePath)).toBe(false)
  })

  it('4. strictly verifies that private user content and absolute paths are absent', async () => {
    const result = await exportService.exportDiagnostics()
    expect(result.success).toBe(true)

    const fileContent = fs.readFileSync(selectedSavePath, 'utf8')
    const parsed = JSON.parse(fileContent)

    // Verify forbidden content fields are absent
    expect(parsed.conversations).toBeUndefined()
    expect(parsed.messages).toBeUndefined()
    expect(parsed.prompts).toBeUndefined()
    expect(parsed.credentials).toBeUndefined()
    expect(parsed.apiKeys).toBeUndefined()

    // Confirm provider connection credential_ref or labels are not exposed
    expect(fileContent).not.toContain('cred_12345678-1234-4234-8234-123456789abc')
    expect(fileContent).not.toContain('My OpenAI')

    // Confirm no machine-specific absolute database paths exist in JSON
    expect(fileContent).not.toContain(tmpDir)
  })
})
