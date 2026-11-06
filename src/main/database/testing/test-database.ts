import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { DatabaseManager } from '../connection'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { KnowledgeBaseRepository } from '../repositories/knowledge-base-repository'
import { BotRepository } from '../repositories/bot-repository'

export interface MigratedTestDatabaseContext {
  readonly db: Database.Database
  readonly manager: DatabaseManager
  readonly dbPath: string
  readonly tempDir: string
  readonly kbRepo: KnowledgeBaseRepository
  readonly botRepo: BotRepository
  readonly cleanup: () => void
}

/**
 * Creates an isolated, file-backed SQLite database in a fresh OS temporary directory,
 * applies the production migration registry, and instantiates repositories.
 */
export function createMigratedTestDatabase(): MigratedTestDatabaseContext {
  const baseTmp = tmpdir()
  const tempDir = mkdtempSync(join(baseTmp, 'local-ai-test-db-'))
  const canonicalTempDir = realpathSync(tempDir)

  const manager = new DatabaseManager()
  const initResult = manager.initialize(canonicalTempDir)

  const db = manager.getDatabase()
  runMigrations(db, migrations)

  const kbRepo = new KnowledgeBaseRepository(db)
  const botRepo = new BotRepository(db)

  let cleanedUp = false

  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true

    try {
      if (manager.isOpen()) {
        manager.close()
      }
    } catch {
      // Ignore close errors during cleanup
    }

    // Safety checks: ensure path is within OS tempDir and matches test prefix
    if (
      existsSync(canonicalTempDir) &&
      canonicalTempDir.startsWith(realpathSync(baseTmp)) &&
      canonicalTempDir.includes('local-ai-test-db-')
    ) {
      try {
        rmSync(canonicalTempDir, { recursive: true, force: true })
      } catch {
        // Silently handle transient Windows file locks during test teardown
      }
    }
  }

  return {
    db,
    manager,
    dbPath: initResult.dbPath,
    tempDir: canonicalTempDir,
    kbRepo,
    botRepo,
    cleanup
  }
}
