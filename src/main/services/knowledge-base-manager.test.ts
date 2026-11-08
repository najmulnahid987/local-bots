import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { createBotFixture, createProviderConnectionFixture } from '../database/testing/fixtures'
import {
  KnowledgeBaseManager,
  KnowledgeBaseValidationError,
  KnowledgeBaseSecurityError,
  KnowledgeBaseCreationError,
  KnowledgeBaseCompensationError,
  KnowledgeBaseDeletionError
} from './knowledge-base-manager'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'

describe('KnowledgeBaseManager (Phase 4 Step 4.1)', () => {
  let testCtx: MigratedTestDatabaseContext
  let documentsDir: string
  let manager: KnowledgeBaseManager

  beforeEach(() => {
    testCtx = createMigratedTestDatabase()
    documentsDir = path.join(testCtx.tempDir, 'documents')
    manager = new KnowledgeBaseManager({
      repository: testCtx.kbRepo,
      documentsDir
    })
  })

  afterEach(() => {
    testCtx.cleanup()
  })

  // =========================================================================
  // 1. Creation Lifecycle
  // =========================================================================
  describe('1. Creation Lifecycle', () => {
    it('1.1 creates a database record and matching physical directory on disk', async () => {
      const created = await manager.create({
        name: 'Engineering Specs',
        description: 'Architecture specs and RFCs'
      })

      expect(created).toBeDefined()
      expect(created.name).toBe('Engineering Specs')
      expect(created.description).toBe('Architecture specs and RFCs')
      expect(created.archivedAt).toBeNull()
      expect(created.createdAt).toBeGreaterThan(0)
      expect(created.updatedAt).toBe(created.createdAt)

      // Storage directory must physically exist on disk matching the UUID
      const expectedDir = path.join(documentsDir, created.id)
      expect(fs.existsSync(expectedDir)).toBe(true)
      const stat = fs.statSync(expectedDir)
      expect(stat.isDirectory()).toBe(true)

      // Database record must match
      const dbRecord = testCtx.kbRepo.getById(created.id)
      expect(dbRecord).not.toBeNull()
      expect(dbRecord?.id).toBe(created.id)
      expect(dbRecord?.storage_path).toBe(`documents/${created.id}`)
    })

    it('1.2 assigns distinct UUIDs and distinct directories to two Knowledge Bases', async () => {
      const kb1 = await manager.create({ name: 'First KB' })
      const kb2 = await manager.create({ name: 'Second KB' })

      expect(kb1.id).not.toBe(kb2.id)

      const dir1 = path.join(documentsDir, kb1.id)
      const dir2 = path.join(documentsDir, kb2.id)

      expect(fs.existsSync(dir1)).toBe(true)
      expect(fs.existsSync(dir2)).toBe(true)
      expect(dir1).not.toBe(dir2)
    })

    it('1.3 allows creating a Knowledge Base with an empty description', async () => {
      const created = await manager.create({ name: 'Minimal KB' })

      expect(created.description).toBe('')
      expect(fs.existsSync(path.join(documentsDir, created.id))).toBe(true)
    })

    it('1.4 rejects invalid creation requests and does not touch DB or disk', async () => {
      // Empty name
      await expect(manager.create({ name: '' })).rejects.toThrow(KnowledgeBaseValidationError)
      // Whitespace-only name
      await expect(manager.create({ name: '   ' })).rejects.toThrow(KnowledgeBaseValidationError)
      // Overlong name (> 255 chars)
      await expect(manager.create({ name: 'x'.repeat(256) })).rejects.toThrow(
        KnowledgeBaseValidationError
      )
      // Overlong description (> 2000 chars)
      await expect(
        manager.create({ name: 'Valid Name', description: 'd'.repeat(2001) })
      ).rejects.toThrow(KnowledgeBaseValidationError)
      // Unexpected extra properties
      await expect(
        // @ts-expect-error - testing runtime rejection of extra fields
        manager.create({ name: 'Valid Name', unexpectedField: 'malicious' })
      ).rejects.toThrow(KnowledgeBaseValidationError)

      // Verify no records created
      expect(testCtx.kbRepo.list()).toHaveLength(0)
    })

    it('1.5 triggers database record compensation if physical directory creation fails', async () => {
      // Inject failing fsOps where mkdir fails for the KB directory
      const failingManager = new KnowledgeBaseManager({
        repository: testCtx.kbRepo,
        documentsDir,
        fsOps: {
          mkdir: async (targetPath, options) => {
            if (targetPath !== documentsDir) {
              throw new Error('Simulated EACCES: Permission denied creating directory')
            }
            return fs.promises.mkdir(targetPath, options)
          }
        }
      })

      await expect(failingManager.create({ name: 'Compensation Test KB' })).rejects.toThrow(
        KnowledgeBaseCreationError
      )

      // Database record must have been rolled back cleanly
      const rows = testCtx.kbRepo.list()
      expect(rows).toHaveLength(0)
    })

    it('1.6 safely reports compensation failure if rollback also encounters an error', async () => {
      // Force repository.delete to fail during compensation
      const failingRepo = {
        ...testCtx.kbRepo,
        create: testCtx.kbRepo.create.bind(testCtx.kbRepo),
        delete: () => {
          throw new Error('Simulated SQLite fatal rollback failure')
        }
      } as unknown as KnowledgeBaseRepository

      const failingManager = new KnowledgeBaseManager({
        repository: failingRepo,
        documentsDir,
        fsOps: {
          mkdir: async (targetPath) => {
            if (targetPath !== documentsDir) {
              throw new Error('Simulated filesystem failure')
            }
            return undefined
          }
        }
      })

      await expect(failingManager.create({ name: 'Fatal Compensation KB' })).rejects.toThrow(
        KnowledgeBaseCompensationError
      )
    })
  })

  // =========================================================================
  // 2. Rename and Update Lifecycle
  // =========================================================================
  describe('2. Rename and Update Lifecycle', () => {
    it('2.1 updating a KB name preserves its immutable UUID and does not move its directory', async () => {
      const created = await manager.create({
        name: 'Original Name',
        description: 'Original Description'
      })
      const originalDir = path.join(documentsDir, created.id)

      // Write a sample document inside the KB directory
      const docFile = path.join(originalDir, 'spec.txt')
      fs.writeFileSync(docFile, 'Initial content', 'utf8')

      const updated = await manager.update(created.id, {
        name: 'Renamed Knowledge Base'
      })

      expect(updated).not.toBeNull()
      expect(updated?.id).toBe(created.id)
      expect(updated?.name).toBe('Renamed Knowledge Base')
      expect(updated?.description).toBe('Original Description')
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

      // Directory must remain at original UUID path with file intact
      expect(fs.existsSync(originalDir)).toBe(true)
      expect(fs.existsSync(docFile)).toBe(true)
      expect(fs.readFileSync(docFile, 'utf8')).toBe('Initial content')
    })

    it('2.2 updating description preserves directory identity and metadata', async () => {
      const created = await manager.create({ name: 'Description KB' })

      const updated = await manager.update(created.id, {
        description: 'New updated description'
      })

      expect(updated?.description).toBe('New updated description')
      expect(updated?.name).toBe('Description KB')
      expect(fs.existsSync(path.join(documentsDir, created.id))).toBe(true)
    })

    it('2.3 returns null when attempting to update a non-existent Knowledge Base', async () => {
      const nonExistentId = '00000000-0000-4000-8000-000000000000'
      const updated = await manager.update(nonExistentId, { name: 'Ghost KB' })

      expect(updated).toBeNull()
    })

    it('2.4 rejects invalid update inputs with validation errors', async () => {
      const created = await manager.create({ name: 'Valid KB' })

      // Empty name
      await expect(manager.update(created.id, { name: '' })).rejects.toThrow(
        KnowledgeBaseValidationError
      )
      // Whitespace name
      await expect(manager.update(created.id, { name: '   ' })).rejects.toThrow(
        KnowledgeBaseValidationError
      )
      // No fields provided
      await expect(manager.update(created.id, {})).rejects.toThrow(KnowledgeBaseValidationError)
      // Malformed UUID
      await expect(manager.update('not-a-uuid', { name: 'New Name' })).rejects.toThrow(
        KnowledgeBaseValidationError
      )
    })
  })

  // =========================================================================
  // 3. Archive and Unarchive Lifecycle
  // =========================================================================
  describe('3. Archive and Unarchive Lifecycle', () => {
    it('3.1 archiving a Knowledge Base preserves its physical storage directory', async () => {
      const created = await manager.create({ name: 'Archive Target' })
      const kbDir = path.join(documentsDir, created.id)
      fs.writeFileSync(path.join(kbDir, 'doc.txt'), 'archived data')

      const archived = await manager.archive(created.id)
      expect(archived).not.toBeNull()
      expect(archived?.archivedAt).toBeGreaterThan(0)

      // Physical files must remain completely intact
      expect(fs.existsSync(kbDir)).toBe(true)
      expect(fs.existsSync(path.join(kbDir, 'doc.txt'))).toBe(true)
    })

    it('3.2 unarchiving restores active status and resets archivedAt to null', async () => {
      const created = await manager.create({ name: 'Lifecycle KB' })
      await manager.archive(created.id)

      const unarchived = await manager.unarchive(created.id)
      expect(unarchived).not.toBeNull()
      expect(unarchived?.archivedAt).toBeNull()

      // Appears in default list
      const activeList = await manager.list()
      expect(activeList.some((k) => k.id === created.id)).toBe(true)
    })

    it('3.3 preserves repository list filtering behavior for archived items', async () => {
      const activeKb = await manager.create({ name: 'Active KB' })
      const archivedKb = await manager.create({ name: 'Archived KB' })
      await manager.archive(archivedKb.id)

      // Default list excludes archived
      const defaultList = await manager.list()
      expect(defaultList.some((k) => k.id === activeKb.id)).toBe(true)
      expect(defaultList.some((k) => k.id === archivedKb.id)).toBe(false)

      // includeArchived: true includes both
      const fullList = await manager.list({ includeArchived: true })
      expect(fullList.some((k) => k.id === activeKb.id)).toBe(true)
      expect(fullList.some((k) => k.id === archivedKb.id)).toBe(true)
    })

    it('3.4 returns null when archiving or unarchiving non-existent Knowledge Base', async () => {
      const nonExistentId = '00000000-0000-4000-8000-000000000000'
      expect(await manager.archive(nonExistentId)).toBeNull()
      expect(await manager.unarchive(nonExistentId)).toBeNull()
    })
  })

  // =========================================================================
  // 4. Safe Deletion Lifecycle
  // =========================================================================
  describe('4. Safe Deletion Lifecycle', () => {
    it('4.1 deletes physical directory and cascades to all child database records', async () => {
      const created = await manager.create({ name: 'Delete Target' })
      const kbDir = path.join(documentsDir, created.id)
      fs.writeFileSync(path.join(kbDir, 'sample.pdf'), 'binary content')

      // Attach child Bot to Knowledge Base
      const bot = createBotFixture(testCtx.botRepo, created.id, { name: 'Resident Bot' })
      expect(testCtx.botRepo.getById(bot.id, created.id)).not.toBeNull()

      const result = await manager.delete(created.id)

      expect(result.success).toBe(true)
      expect(result.directoryCleaned).toBe(true)
      expect(result.cleanupPending).toBe(false)

      // Directory must be gone from disk
      expect(fs.existsSync(kbDir)).toBe(false)

      // Database rows must be gone (both KB and cascaded child bot)
      expect(testCtx.kbRepo.getById(created.id)).toBeNull()
      expect(testCtx.botRepo.getById(bot.id, created.id)).toBeNull()
      expect(testCtx.db.prepare('SELECT count(*) as c FROM bots WHERE id = ?').get(bot.id)).toEqual(
        { c: 0 }
      )
    })

    it('4.2 leaves sibling Knowledge Bases, their directories, and their Bots untouched', async () => {
      const kbA = await manager.create({ name: 'KB A' })
      const kbB = await manager.create({ name: 'KB B' })

      const dirA = path.join(documentsDir, kbA.id)
      const dirB = path.join(documentsDir, kbB.id)

      fs.writeFileSync(path.join(dirA, 'fileA.txt'), 'Data A')
      fs.writeFileSync(path.join(dirB, 'fileB.txt'), 'Data B')

      const botB = createBotFixture(testCtx.botRepo, kbB.id, { name: 'Bot in KB B' })

      // Delete KB A
      const result = await manager.delete(kbA.id)
      expect(result.success).toBe(true)

      // KB A gone
      expect(fs.existsSync(dirA)).toBe(false)
      expect(testCtx.kbRepo.getById(kbA.id)).toBeNull()

      // KB B and its contents completely intact
      expect(fs.existsSync(dirB)).toBe(true)
      expect(fs.readFileSync(path.join(dirB, 'fileB.txt'), 'utf8')).toBe('Data B')
      expect(testCtx.kbRepo.getById(kbB.id)).not.toBeNull()
      expect(testCtx.botRepo.getById(botB.id, kbB.id)).not.toBeNull()
    })

    it('4.3 leaves global provider connections untouched when deleting Knowledge Base', async () => {
      const provFixture = createProviderConnectionFixture(testCtx.db, {
        providerId: 'anthropic',
        label: 'Global Claude Key'
      })

      const kb = await manager.create({ name: 'KB with Bot and Provider' })
      createBotFixture(testCtx.botRepo, kb.id, {
        name: 'Claude Bot',
        providerConnectionId: provFixture.id
      })

      const result = await manager.delete(kb.id)
      expect(result.success).toBe(true)

      // Provider connection must remain completely intact
      const provRow = testCtx.db
        .prepare('SELECT id, label FROM provider_connections WHERE id = ?')
        .get(provFixture.id)
      expect(provRow).toBeDefined()
    })

    it('4.4 restores the quarantined directory if database deletion throws an error', async () => {
      const kb = await manager.create({ name: 'Rollback Target' })
      const kbDir = path.join(documentsDir, kb.id)
      const testFile = path.join(kbDir, 'important-doc.md')
      fs.writeFileSync(testFile, '# Critical Information', 'utf8')

      // Mock repository.delete to fail
      const originalDelete = testCtx.kbRepo.delete.bind(testCtx.kbRepo)
      testCtx.kbRepo.delete = () => {
        throw new Error('Simulated SQLite disk write lock failure')
      }

      await expect(manager.delete(kb.id)).rejects.toThrow(KnowledgeBaseDeletionError)

      // Original directory and contents must have been restored from quarantine
      expect(fs.existsSync(kbDir)).toBe(true)
      expect(fs.existsSync(testFile)).toBe(true)
      expect(fs.readFileSync(testFile, 'utf8')).toBe('# Critical Information')

      // Database record still exists
      expect(testCtx.kbRepo.getById(kb.id)).not.toBeNull()

      // Clean up mock
      testCtx.kbRepo.delete = originalDelete
    })

    it('4.5 reports cleanup pending if database deletion succeeds but final quarantine cleanup fails', async () => {
      const kb = await manager.create({ name: 'Quarantine Cleanup Failure' })
      const kbDir = path.join(documentsDir, kb.id)
      fs.writeFileSync(path.join(kbDir, 'data.txt'), 'data')

      const customManager = new KnowledgeBaseManager({
        repository: testCtx.kbRepo,
        documentsDir,
        fsOps: {
          rm: async () => {
            throw new Error('Simulated EBUSY: file locked by background antivirus scanner')
          }
        }
      })

      const result = await customManager.delete(kb.id)

      // Database deletion succeeded (cannot be reversed)
      expect(result.success).toBe(true)
      expect(result.directoryCleaned).toBe(false)
      expect(result.cleanupPending).toBe(true)
      expect(result.code).toBe('CLEANUP_PENDING')
      expect(result.error).toContain('EBUSY')

      // DB record is gone
      expect(testCtx.kbRepo.getById(kb.id)).toBeNull()
    })

    it('4.6 handles safely when physical directory is already missing', async () => {
      const kb = await manager.create({ name: 'Missing Directory KB' })
      const kbDir = path.join(documentsDir, kb.id)

      // Manually remove directory
      fs.rmSync(kbDir, { recursive: true, force: true })
      expect(fs.existsSync(kbDir)).toBe(false)

      const result = await manager.delete(kb.id)
      expect(result.success).toBe(true)
      expect(result.directoryCleaned).toBe(true)
      expect(result.cleanupPending).toBe(false)

      // Database record deleted cleanly
      expect(testCtx.kbRepo.getById(kb.id)).toBeNull()
    })

    it('4.7 returns not found when attempting to delete a non-existent Knowledge Base', async () => {
      const nonExistentId = '00000000-0000-4000-8000-000000000000'
      const result = await manager.delete(nonExistentId)

      expect(result.success).toBe(false)
      expect(result.directoryCleaned).toBe(false)
      expect(result.cleanupPending).toBe(false)
      expect(result.code).toBe('NOT_FOUND')
    })
  })

  // =========================================================================
  // 5. Filesystem Security and Boundary Enforcement
  // =========================================================================
  describe('5. Filesystem Security & Boundary Enforcement', () => {
    it('5.1 rejects malformed IDs before performing any filesystem operations', async () => {
      await expect(manager.getById('invalid-uuid')).rejects.toThrow(KnowledgeBaseValidationError)
      await expect(manager.delete('not-a-valid-uuid')).rejects.toThrow(KnowledgeBaseValidationError)
      await expect(manager.archive('../../escape')).rejects.toThrow(KnowledgeBaseValidationError)
      await expect(manager.unarchive('')).rejects.toThrow(KnowledgeBaseValidationError)
    })

    it('5.2 rejects symlink target directories during deletion safety check', async () => {
      const kb = await manager.create({ name: 'Symlink Defense KB' })
      const kbDir = path.join(documentsDir, kb.id)

      // Replace target directory with a simulated symlink via custom fsOps
      const symlinkManager = new KnowledgeBaseManager({
        repository: testCtx.kbRepo,
        documentsDir,
        fsOps: {
          lstat: async (p) => {
            if (p === kbDir) {
              return {
                isSymbolicLink: () => true,
                isDirectory: () => true,
                isFile: () => false
              } as unknown as fs.Stats
            }
            return fs.promises.lstat(p)
          }
        }
      })

      await expect(symlinkManager.delete(kb.id)).rejects.toThrow(KnowledgeBaseSecurityError)

      // Database record must NOT have been deleted
      expect(testCtx.kbRepo.getById(kb.id)).not.toBeNull()
    })

    it('5.3 resolveKnowledgeBaseDirectory strictly verifies target is immediate child of documentsDir', () => {
      const validId = '11111111-2222-4333-8444-555555555555'
      const resolved = manager.resolveKnowledgeBaseDirectory(validId)

      expect(resolved).toBe(path.resolve(documentsDir, validId))
      expect(path.relative(documentsDir, resolved)).toBe(validId)
    })
  })

  // =========================================================================
  // 6. Retrieval and Listing
  // =========================================================================
  describe('6. Retrieval and Listing', () => {
    it('6.1 getById retrieves public DTO without exposing internal storage_path', async () => {
      const created = await manager.create({
        name: 'Public Retrieval KB',
        description: 'Safe DTO test'
      })

      const retrieved = await manager.getById(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(created.id)
      expect(retrieved?.name).toBe('Public Retrieval KB')
      expect(retrieved?.description).toBe('Safe DTO test')

      // Ensure storage_path is not exposed on DTO
      expect('storage_path' in (retrieved ?? {})).toBe(false)
    })

    it('6.2 list returns all active DTOs ordered by createdAt DESC', async () => {
      const kb1 = await manager.create({ name: 'KB 1' })
      await new Promise((r) => setTimeout(r, 10))
      const kb2 = await manager.create({ name: 'KB 2' })

      const list = await manager.list()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe(kb2.id)
      expect(list[1].id).toBe(kb1.id)
    })
  })

  // =========================================================================
  // 7. Isolation Invariants
  // =========================================================================
  describe('7. Isolation Invariants', () => {
    it('7.1 creates KB A and KB B with different bots, deletes KB A, and leaves KB B intact', async () => {
      const kbA = await manager.create({ name: 'Alpha KB' })
      const kbB = await manager.create({ name: 'Beta KB' })

      const botA1 = createBotFixture(testCtx.botRepo, kbA.id, { name: 'Bot Alpha 1' })
      const botA2 = createBotFixture(testCtx.botRepo, kbA.id, { name: 'Bot Alpha 2' })
      const botB1 = createBotFixture(testCtx.botRepo, kbB.id, { name: 'Bot Beta 1' })

      // Verify all exist
      expect(testCtx.botRepo.listByKnowledgeBase(kbA.id)).toHaveLength(2)
      expect(testCtx.botRepo.listByKnowledgeBase(kbB.id)).toHaveLength(1)

      // Delete KB A
      const deleteResult = await manager.delete(kbA.id)
      expect(deleteResult.success).toBe(true)

      // KB A and its bots are completely gone
      expect(await manager.getById(kbA.id)).toBeNull()
      expect(testCtx.botRepo.getById(botA1.id, kbA.id)).toBeNull()
      expect(testCtx.botRepo.getById(botA2.id, kbA.id)).toBeNull()
      expect(
        testCtx.db.prepare('SELECT count(*) as c FROM bots WHERE knowledge_base_id = ?').get(kbA.id)
      ).toEqual({ c: 0 })
      expect(fs.existsSync(path.join(documentsDir, kbA.id))).toBe(false)

      // KB B, its bots, and its physical directory remain 100% operational
      expect(await manager.getById(kbB.id)).not.toBeNull()
      expect(testCtx.botRepo.getById(botB1.id, kbB.id)).not.toBeNull()
      expect(fs.existsSync(path.join(documentsDir, kbB.id))).toBe(true)
    })
  })

  // =========================================================================
  // 8. Concurrency and Initialization
  // =========================================================================
  describe('8. Concurrency & Initialization', () => {
    it('8.1 handles concurrent creation of multiple Knowledge Bases with unique directories', async () => {
      const names = ['Concurrent 1', 'Concurrent 2', 'Concurrent 3', 'Concurrent 4', 'Concurrent 5']
      const results = await Promise.all(names.map((name) => manager.create({ name })))

      expect(results).toHaveLength(5)
      const ids = results.map((r) => r.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(5)

      for (const res of results) {
        const dir = path.join(documentsDir, res.id)
        expect(fs.existsSync(dir)).toBe(true)
      }
    })

    it('8.2 constructor throws KnowledgeBaseManagerError when repository is missing', () => {
      // @ts-expect-error - testing missing repository runtime check
      expect(() => new KnowledgeBaseManager({})).toThrow(/KnowledgeBaseRepository is required/)
    })

    it('8.3 getDocumentsDirectory returns canonical documents root path', () => {
      expect(manager.getDocumentsDirectory()).toBe(path.resolve(documentsDir))
    })
  })
})
