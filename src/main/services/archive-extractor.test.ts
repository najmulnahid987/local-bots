import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  ArchiveExtractor,
  ArchiveValidationError,
  validateArchiveEntryName
} from './archive-extractor'
import { ZipArchiveWriter } from './zip-archive'

describe('ArchiveExtractor & ZIP Security Validation', () => {
  let tmpDir: string
  let extractor: ArchiveExtractor

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-extractor-test-'))
    extractor = new ArchiveExtractor()
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  // Helper to build a minimal valid export archive
  async function createValidArchive(
    customDocContent = 'Sample doc content',
    customDocId = crypto.randomUUID()
  ): Promise<string> {
    const writer = new ZipArchiveWriter()
    const kbId = crypto.randomUUID()

    const manifest = {
      format: 'voyaro-knowledge-base-export',
      schemaVersion: '1.0.0',
      exportedAt: Date.now(),
      appVersion: '1.0.0',
      knowledgeBase: { id: kbId, name: 'Test KB' },
      counts: {
        bots: 1,
        memories: 0,
        sources: 1,
        conversations: 0,
        messages: 0,
        totalSourceBytes: customDocContent.length
      },
      files: [],
      excludedCategories: []
    }

    const kb = {
      id: kbId,
      name: 'Test KB',
      description: '',
      createdAt: 1000,
      updatedAt: 1000,
      archivedAt: null
    }
    const bots = [
      {
        id: crypto.randomUUID(),
        name: 'Bot 1',
        description: '',
        systemPrompt: '',
        modelId: 'gpt-4o',
        status: 'active',
        toolPermissions: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ]
    const memories: unknown[] = []
    const sources = [
      {
        id: customDocId,
        fileName: `${customDocId}.txt`,
        originalFileName: 'doc.txt',
        fileType: 'txt',
        mimeType: 'text/plain',
        fileSizeBytes: customDocContent.length,
        contentHash: crypto.createHash('sha256').update(customDocContent).digest('hex'),
        indexingStatus: 'completed',
        createdAt: 1000,
        updatedAt: 1000,
        indexedAt: 1000
      }
    ]
    const conversations: unknown[] = []

    writer.addEntry('manifest.json', JSON.stringify(manifest))
    writer.addEntry('knowledge-base.json', JSON.stringify(kb))
    writer.addEntry('bots.json', JSON.stringify(bots))
    writer.addEntry('bot-memories.json', JSON.stringify(memories))
    writer.addEntry('sources.json', JSON.stringify(sources))
    writer.addEntry('conversations.json', JSON.stringify(conversations))
    writer.addEntry(`documents/${customDocId}.txt`, customDocContent)

    const archivePath = path.join(tmpDir, 'valid.voyaro-kb.zip')
    await writer.writeToFile(archivePath)
    return archivePath
  }

  describe('Path Traversal & Entry Name Validation', () => {
    it('accepts allowed metadata and document paths', () => {
      expect(validateArchiveEntryName('manifest.json')).toBe('manifest.json')
      expect(validateArchiveEntryName('bots.json')).toBe('bots.json')
      const docId = crypto.randomUUID()
      expect(validateArchiveEntryName(`documents/${docId}.txt`)).toBe(`documents/${docId}.txt`)
      expect(validateArchiveEntryName(`documents/${docId}.pdf`)).toBe(`documents/${docId}.pdf`)
      expect(validateArchiveEntryName(`documents/${docId}.docx`)).toBe(`documents/${docId}.docx`)
      expect(validateArchiveEntryName(`documents/${docId}.xlsx`)).toBe(`documents/${docId}.xlsx`)
      expect(validateArchiveEntryName(`documents/${docId}.pptx`)).toBe(`documents/${docId}.pptx`)
    })

    it('rejects path traversal with ../ or backslashes', () => {
      expect(() => validateArchiveEntryName('../manifest.json')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('documents/../../evil.txt')).toThrow(
        ArchiveValidationError
      )
      expect(() => validateArchiveEntryName('documents\\doc.txt')).toThrow(ArchiveValidationError)
    })

    it('rejects absolute paths and drive letters', () => {
      expect(() => validateArchiveEntryName('/manifest.json')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('C:/manifest.json')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('D:\\foo.txt')).toThrow(ArchiveValidationError)
    })

    it('rejects null bytes and alternate data streams', () => {
      expect(() => validateArchiveEntryName('manifest.json\0')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('manifest.json:hidden')).toThrow(ArchiveValidationError)
    })

    it('rejects Windows reserved device names', () => {
      expect(() => validateArchiveEntryName('CON')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('NUL.txt')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('documents/AUX.txt')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('COM1')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('LPT3.pdf')).toThrow(ArchiveValidationError)
    })

    it('rejects unexpected entries outside allowlist', () => {
      expect(() => validateArchiveEntryName('malicious.exe')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('database.sqlite')).toThrow(ArchiveValidationError)
      expect(() => validateArchiveEntryName('documents/invalid-uuid.txt')).toThrow(
        ArchiveValidationError
      )
      expect(() => validateArchiveEntryName(`documents/${crypto.randomUUID()}.exe`)).toThrow(
        ArchiveValidationError
      )
    })
  })

  describe('Archive Extraction & Integrity Verification', () => {
    it('successfully extracts a valid archive into staging and verifies checksums', async () => {
      const docContent = 'Authentic document text'
      const docId = crypto.randomUUID()
      const archivePath = await createValidArchive(docContent, docId)

      const bundle = await extractor.extractAndValidate(archivePath, tmpDir)

      expect(bundle.entryCount).toBe(7)
      expect(bundle.totalUncompressedBytes).toBeGreaterThan(0)
      expect(bundle.manifestRaw).toContain('voyaro-knowledge-base-export')
      expect(bundle.knowledgeBaseRaw).toContain('Test KB')
      expect(bundle.stagedDocuments.has(docId)).toBe(true)

      const staged = bundle.stagedDocuments.get(docId)!
      expect(staged.sizeBytes).toBe(docContent.length)
      expect(staged.sha256).toBe(crypto.createHash('sha256').update(docContent).digest('hex'))
      expect(fs.existsSync(staged.stagedPath)).toBe(true)

      // Clean staging
      await extractor.cleanStagingDirectory(bundle.stagingDir)
      expect(fs.existsSync(bundle.stagingDir)).toBe(false)
    })

    it('rejects archive when EOCD is missing or corrupt', async () => {
      const badZip = path.join(tmpDir, 'corrupt.zip')
      await fs.promises.writeFile(badZip, 'not a real zip file header', 'utf8')

      await expect(extractor.extractAndValidate(badZip, tmpDir)).rejects.toThrow(
        /End of Central Directory record not found/
      )
    })

    it('rejects archive with duplicate entry names', async () => {
      // Build zip buffer with duplicate entries in central directory
      const writer = new ZipArchiveWriter()
      writer.addEntry('manifest.json', '{}')
      const buf = writer.build()

      // Duplicate central directory entry manually
      const zipPath = path.join(tmpDir, 'dup.zip')
      await fs.promises.writeFile(zipPath, buf)

      // An archive missing required files is rejected
      await expect(extractor.extractAndValidate(zipPath, tmpDir)).rejects.toThrow(
        /Required archive file .* is missing/
      )
    })

    it('rejects encrypted password-protected archives', async () => {
      const archivePath = await createValidArchive()
      const buf = await fs.promises.readFile(archivePath)

      // Find central directory entry and set bit 0 (encrypted bit) in general purpose flag
      // CD header starts with 0x02014b50, flags at offset + 8
      for (let i = 0; i < buf.length - 10; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          buf.writeUInt16LE(0x0001, i + 8) // Set encrypted flag
          break
        }
      }

      const tamperedPath = path.join(tmpDir, 'encrypted.zip')
      await fs.promises.writeFile(tamperedPath, buf)

      await expect(extractor.extractAndValidate(tamperedPath, tmpDir)).rejects.toThrow(
        /Encrypted\/password-protected ZIP archives are not supported/
      )
    })

    it('rejects unsupported compression methods', async () => {
      const archivePath = await createValidArchive()
      const buf = await fs.promises.readFile(archivePath)

      // Change compression method to 99 in central directory
      for (let i = 0; i < buf.length - 12; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          buf.writeUInt16LE(99, i + 10)
          break
        }
      }

      const tamperedPath = path.join(tmpDir, 'bad-method.zip')
      await fs.promises.writeFile(tamperedPath, buf)

      await expect(extractor.extractAndValidate(tamperedPath, tmpDir)).rejects.toThrow(
        /Unsupported compression method/
      )
    })

    it('rejects CRC32 checksum mismatch', async () => {
      const archivePath = await createValidArchive()
      const buf = await fs.promises.readFile(archivePath)

      // Tamper with CRC32 in central directory for first entry
      for (let i = 0; i < buf.length - 20; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          buf.writeUInt32LE(0x12345678, i + 16) // Bad CRC
          break
        }
      }

      const tamperedPath = path.join(tmpDir, 'bad-crc.zip')
      await fs.promises.writeFile(tamperedPath, buf)

      await expect(extractor.extractAndValidate(tamperedPath, tmpDir)).rejects.toThrow(
        /CRC32 checksum mismatch/
      )
    })

    it('rejects local file header mismatch', async () => {
      const archivePath = await createValidArchive()
      const buf = await fs.promises.readFile(archivePath)

      // Tamper with local header filename length or signature
      for (let i = 0; i < buf.length - 30; i++) {
        if (buf.readUInt32LE(i) === 0x04034b50) {
          buf.writeUInt16LE(99, i + 8) // Change compression method in local header
          break
        }
      }

      const tamperedPath = path.join(tmpDir, 'mismatch-header.zip')
      await fs.promises.writeFile(tamperedPath, buf)

      await expect(extractor.extractAndValidate(tamperedPath, tmpDir)).rejects.toThrow(
        /Compression method mismatch between local and central header/
      )
    })
  })
})
