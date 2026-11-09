import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DocumentStorageManager } from './document-storage-manager'

describe('DocumentStorageManager (Phase 5 Step 5.3)', () => {
  let tempDir: string
  let documentsDir: string
  let manager: DocumentStorageManager

  const validKbId1 = '10000000-0000-4000-8000-000000000001'
  const validKbId2 = '20000000-0000-4000-8000-000000000002'
  const validSourceId1 = '30000000-0000-4000-8000-000000000001'
  const validSourceId2 = '40000000-0000-4000-8000-000000000002'

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'))
    documentsDir = path.join(tempDir, 'documents')
    manager = new DocumentStorageManager({
      documentsDir
    })
  })

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore transient cleanup locks
    }
  })

  // -------------------------------------------------------------------------
  // 1. Directory Layout & Isolation
  // -------------------------------------------------------------------------
  describe('1. Directory Layout & Isolation', () => {
    it('1.1 safely creates <documentsDir>/<kbId>/originals/ directory structure', async () => {
      const originalsDir = await manager.ensureOriginalsDirectory(validKbId1)

      expect(fs.existsSync(originalsDir)).toBe(true)
      const expectedPath = path.join(documentsDir, validKbId1, 'originals')
      expect(originalsDir).toBe(expectedPath)
      expect(fs.statSync(originalsDir).isDirectory()).toBe(true)
    })

    it('1.2 assigns separate, isolated originals directories to distinct Knowledge Bases', async () => {
      const dir1 = await manager.ensureOriginalsDirectory(validKbId1)
      const dir2 = await manager.ensureOriginalsDirectory(validKbId2)

      expect(dir1).not.toBe(dir2)
      expect(path.dirname(dir1)).toBe(path.join(documentsDir, validKbId1))
      expect(path.dirname(dir2)).toBe(path.join(documentsDir, validKbId2))
    })

    it('1.3 formats relative file paths using standard POSIX forward slashes', () => {
      const targetPath = manager.resolveOriginalPath(validKbId1, validSourceId1, 'pdf')
      expect(targetPath).toBe(
        path.join(documentsDir, validKbId1, 'originals', `${validSourceId1}.pdf`)
      )
    })
  })

  // -------------------------------------------------------------------------
  // 2. Storage Operations & Atomic Persistence
  // -------------------------------------------------------------------------
  describe('2. Storage Operations & Atomic Persistence', () => {
    it('2.1 stores a validated document original using UUID-based filename', async () => {
      // Prepare source file with user-provided name
      const sourceFile = path.join(tempDir, 'User Original Document.md')
      const content = '# Knowledge Document\n\nOriginal content body.'
      fs.writeFileSync(sourceFile, content, 'utf-8')
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      const stat = fs.statSync(sourceFile)

      const result = await manager.storeOriginal({
        knowledgeBaseId: validKbId1,
        sourceId: validSourceId1,
        extension: 'md',
        sourcePath: sourceFile,
        expectedSize: stat.size,
        expectedHash: hash,
        expectedMtimeMs: stat.mtimeMs
      })

      // Stored relative path must be originals/<sourceId>.md
      expect(result.relativeFilePath).toBe(`originals/${validSourceId1}.md`)
      expect(result.fileSizeBytes).toBe(stat.size)
      expect(result.contentHash).toBe(hash)

      // Physical file must exist at destination
      expect(fs.existsSync(result.storagePath)).toBe(true)
      const storedContent = fs.readFileSync(result.storagePath, 'utf-8')
      expect(storedContent).toBe(content)

      // User's original filename must NOT appear on physical filesystem in storage
      expect(path.basename(result.storagePath)).toBe(`${validSourceId1}.md`)
      expect(result.storagePath).not.toContain('User Original Document')
    })

    it('2.2 prevents overwriting an existing stored original with DUPLICATE_STORAGE_TARGET', async () => {
      const sourceFile = path.join(tempDir, 'doc1.txt')
      fs.writeFileSync(sourceFile, 'Content A')
      const stat = fs.statSync(sourceFile)
      const hash = crypto.createHash('sha256').update('Content A').digest('hex')

      // First store succeeds
      await manager.storeOriginal({
        knowledgeBaseId: validKbId1,
        sourceId: validSourceId1,
        extension: 'txt',
        sourcePath: sourceFile,
        expectedSize: stat.size,
        expectedHash: hash
      })

      // Second store with same sourceId must fail
      const sourceFile2 = path.join(tempDir, 'doc2.txt')
      fs.writeFileSync(sourceFile2, 'Content B')
      const stat2 = fs.statSync(sourceFile2)
      const hash2 = crypto.createHash('sha256').update('Content B').digest('hex')

      await expect(
        manager.storeOriginal({
          knowledgeBaseId: validKbId1,
          sourceId: validSourceId1,
          extension: 'txt',
          sourcePath: sourceFile2,
          expectedSize: stat2.size,
          expectedHash: hash2
        })
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'DUPLICATE_STORAGE_TARGET'
        })
      )
    })

    it('2.3 cleans up temporary files and rejects if source file size changed before copy', async () => {
      const sourceFile = path.join(tempDir, 'growing.txt')
      fs.writeFileSync(sourceFile, 'Initial size')
      const hash = crypto.createHash('sha256').update('Initial size').digest('hex')

      // Pass wrong expectedSize (simulating modification between validation and copy)
      await expect(
        manager.storeOriginal({
          knowledgeBaseId: validKbId1,
          sourceId: validSourceId1,
          extension: 'txt',
          sourcePath: sourceFile,
          expectedSize: 9999, // Mismatched size
          expectedHash: hash
        })
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'FILE_CHANGED_DURING_IMPORT'
        })
      )

      // Verify no temporary files left in originals directory
      const originalsDir = manager.resolveOriginalsDirectory(validKbId1)
      if (fs.existsSync(originalsDir)) {
        const files = fs.readdirSync(originalsDir)
        expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
      }
    })

    it('2.4 cleans up temporary file if content hash does not match expected hash', async () => {
      const sourceFile = path.join(tempDir, 'corrupted.txt')
      fs.writeFileSync(sourceFile, 'Actual content')
      const stat = fs.statSync(sourceFile)

      await expect(
        manager.storeOriginal({
          knowledgeBaseId: validKbId1,
          sourceId: validSourceId1,
          extension: 'txt',
          sourcePath: sourceFile,
          expectedSize: stat.size,
          expectedHash: '0000000000000000000000000000000000000000000000000000000000000000'
        })
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'FILE_CHANGED_DURING_IMPORT'
        })
      )

      // No partial file visible
      const targetPath = manager.resolveOriginalPath(validKbId1, validSourceId1, 'txt')
      expect(fs.existsSync(targetPath)).toBe(false)
    })

    it('2.5 safely removes an original via removeOriginal', async () => {
      const sourceFile = path.join(tempDir, 'to-delete.pdf')
      fs.writeFileSync(sourceFile, '%PDF-1.4\ncontent')
      const stat = fs.statSync(sourceFile)
      const hash = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex')

      await manager.storeOriginal({
        knowledgeBaseId: validKbId1,
        sourceId: validSourceId1,
        extension: 'pdf',
        sourcePath: sourceFile,
        expectedSize: stat.size,
        expectedHash: hash
      })

      const targetPath = manager.resolveOriginalPath(validKbId1, validSourceId1, 'pdf')
      expect(fs.existsSync(targetPath)).toBe(true)

      // Remove
      const removed = await manager.removeOriginal(validKbId1, validSourceId1, 'pdf')
      expect(removed).toBe(true)
      expect(fs.existsSync(targetPath)).toBe(false)

      // Removing again returns false without error
      const removedAgain = await manager.removeOriginal(validKbId1, validSourceId1, 'pdf')
      expect(removedAgain).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Security Boundary & Path Traversal Guards
  // -------------------------------------------------------------------------
  describe('3. Security Boundary & Path Traversal Guards', () => {
    it('3.1 rejects invalid Knowledge Base IDs before filesystem operations', () => {
      const invalidIds = ['invalid-uuid', '../etc', '12345', '']

      for (const id of invalidIds) {
        expect(() => manager.resolveKnowledgeBaseDirectory(id)).toThrow(
          expect.objectContaining({
            code: 'INVALID_KNOWLEDGE_BASE_ID'
          })
        )
      }
    })

    it('3.2 rejects invalid source document IDs before filesystem operations', () => {
      const invalidIds = ['bad-id', '../../etc/passwd', 'not-a-uuid']

      for (const id of invalidIds) {
        expect(() => manager.resolveOriginalPath(validKbId1, id, 'txt')).toThrow(
          expect.objectContaining({
            code: 'INVALID_SOURCE_ID'
          })
        )
      }
    })

    it('3.3 rejects unsupported extensions in path resolution', () => {
      expect(() => manager.resolveOriginalPath(validKbId1, validSourceId1, 'exe')).toThrow(
        expect.objectContaining({
          code: 'UNSUPPORTED_FILE_TYPE'
        })
      )
    })

    it('3.4 leaves sibling Knowledge Base directories untouched during store or remove', async () => {
      // Store in KB 1
      const file1 = path.join(tempDir, 'file1.txt')
      fs.writeFileSync(file1, 'KB1 Data')
      const stat1 = fs.statSync(file1)
      const hash1 = crypto.createHash('sha256').update('KB1 Data').digest('hex')

      await manager.storeOriginal({
        knowledgeBaseId: validKbId1,
        sourceId: validSourceId1,
        extension: 'txt',
        sourcePath: file1,
        expectedSize: stat1.size,
        expectedHash: hash1
      })

      // Store in KB 2
      const file2 = path.join(tempDir, 'file2.txt')
      fs.writeFileSync(file2, 'KB2 Data')
      const stat2 = fs.statSync(file2)
      const hash2 = crypto.createHash('sha256').update('KB2 Data').digest('hex')

      await manager.storeOriginal({
        knowledgeBaseId: validKbId2,
        sourceId: validSourceId2,
        extension: 'txt',
        sourcePath: file2,
        expectedSize: stat2.size,
        expectedHash: hash2
      })

      // Delete from KB 1
      await manager.removeOriginal(validKbId1, validSourceId1, 'txt')

      // KB 2 file must be 100% intact
      const kb2Target = manager.resolveOriginalPath(validKbId2, validSourceId2, 'txt')
      expect(fs.existsSync(kb2Target)).toBe(true)
      expect(fs.readFileSync(kb2Target, 'utf-8')).toBe('KB2 Data')
    })
  })
})
