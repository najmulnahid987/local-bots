import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DocumentFileValidator } from './document-file-validator'
import { StaticDocumentSettingsProvider } from './document-settings'
import { buildSyntheticDocx } from './benchmarks/fixtures/office-generator'

describe('DocumentFileValidator (Phase 5 Step 5.3)', () => {
  let tempDir: string
  let validator: DocumentFileValidator

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-test-'))
    validator = new DocumentFileValidator(
      new StaticDocumentSettingsProvider({
        maxFileSizeBytes: 10 * 1024 * 1024 // 10 MiB for tests
      })
    )
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
  // 1. Supported Extensions & Normalization
  // -------------------------------------------------------------------------
  describe('1. Supported Extensions & Normalization', () => {
    it('1.1 validates and accepts a standard .txt file', async () => {
      const filePath = path.join(tempDir, 'notes.txt')
      const content = 'Hello world, this is a plain text knowledge document.'
      fs.writeFileSync(filePath, content, 'utf-8')

      const result = await validator.validate(filePath)

      expect(result.originalFileName).toBe('notes.txt')
      expect(result.extension).toBe('txt')
      expect(result.fileType).toBe('txt')
      expect(result.mimeType).toBe('text/plain')
      expect(result.fileSizeBytes).toBe(Buffer.byteLength(content, 'utf-8'))
      expect(result.contentHash).toBe(crypto.createHash('sha256').update(content).digest('hex'))
    })

    it('1.2 validates and accepts a standard .md file', async () => {
      const filePath = path.join(tempDir, 'readme.md')
      const content = '# Project Readme\n\n- Feature 1\n- Feature 2\n\n```ts\nconst x = 1\n```\n'
      fs.writeFileSync(filePath, content, 'utf-8')

      const result = await validator.validate(filePath)

      expect(result.originalFileName).toBe('readme.md')
      expect(result.extension).toBe('md')
      expect(result.fileType).toBe('md')
      expect(result.mimeType).toBe('text/markdown')
      expect(result.fileSizeBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    })

    it('1.3 validates and accepts a valid .pdf file with %PDF- header', async () => {
      const filePath = path.join(tempDir, 'document.pdf')
      const pdfBytes = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')
      ])
      fs.writeFileSync(filePath, pdfBytes)

      const result = await validator.validate(filePath)

      expect(result.originalFileName).toBe('document.pdf')
      expect(result.extension).toBe('pdf')
      expect(result.fileType).toBe('pdf')
      expect(result.mimeType).toBe('application/pdf')
      expect(result.fileSizeBytes).toBe(pdfBytes.length)
      expect(result.contentHash).toBe(crypto.createHash('sha256').update(pdfBytes).digest('hex'))
    })

    it('1.4 validates and accepts a valid .docx file', async () => {
      const docxBytes = buildSyntheticDocx({
        title: 'Validation Test Doc',
        identifier: 'VAL-001',
        headings: ['Heading 1'],
        tableRows: []
      })
      const filePath = path.join(tempDir, 'document.docx')
      fs.writeFileSync(filePath, docxBytes)

      const result = await validator.validate(filePath)

      expect(result.originalFileName).toBe('document.docx')
      expect(result.extension).toBe('docx')
      expect(result.fileType).toBe('docx')
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
      expect(result.fileSizeBytes).toBe(docxBytes.length)
      expect(result.contentHash).toBe(crypto.createHash('sha256').update(docxBytes).digest('hex'))
    })

    it('1.5 normalizes uppercase extensions to lowercase', async () => {
      const txtPath = path.join(tempDir, 'DOCUMENT.TXT')
      fs.writeFileSync(txtPath, 'Text content in uppercase file.', 'utf-8')

      const result = await validator.validate(txtPath)
      expect(result.extension).toBe('txt')
      expect(result.fileType).toBe('txt')
      expect(result.mimeType).toBe('text/plain')

      const pdfPath = path.join(tempDir, 'SPEC.PDF')
      fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\ncontent'))
      const pdfResult = await validator.validate(pdfPath)
      expect(pdfResult.extension).toBe('pdf')
      expect(pdfResult.mimeType).toBe('application/pdf')
    })

    it('1.6 rejects unsupported extensions with UNSUPPORTED_FILE_TYPE', async () => {
      const invalidFiles = [
        'data.xlsx',
        'report.doc',
        'script.py',
        'archive.zip',
        'image.png',
        'executable.exe',
        'no_extension'
      ]

      for (const name of invalidFiles) {
        const filePath = path.join(tempDir, name)
        fs.writeFileSync(filePath, 'dummy content')

        await expect(validator.validate(filePath)).rejects.toThrow(
          expect.objectContaining({
            code: 'UNSUPPORTED_FILE_TYPE'
          })
        )
      }
    })
  })

  // -------------------------------------------------------------------------
  // 2. Filesystem & Object Type Safety
  // -------------------------------------------------------------------------
  describe('2. Filesystem & Object Type Safety', () => {
    it('2.1 rejects nonexistent file with FILE_NOT_FOUND', async () => {
      const missingPath = path.join(tempDir, 'does-not-exist.txt')

      await expect(validator.validate(missingPath)).rejects.toThrow(
        expect.objectContaining({
          code: 'FILE_NOT_FOUND'
        })
      )
    })

    it('2.2 rejects a directory path with INVALID_FILE_TYPE', async () => {
      const subDir = path.join(tempDir, 'nested.txt')
      fs.mkdirSync(subDir)

      await expect(validator.validate(subDir)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_FILE_TYPE'
        })
      )
    })

    it('2.3 rejects symbolic links with SYMLINK_NOT_ALLOWED', async () => {
      const targetPath = path.join(tempDir, 'target.txt')
      fs.writeFileSync(targetPath, 'Original target content.')

      const symlinkPath = path.join(tempDir, 'link.txt')
      try {
        fs.symlinkSync(targetPath, symlinkPath)
      } catch {
        // Symlink creation on Windows may require elevated permissions; skip if not supported
        return
      }

      await expect(validator.validate(symlinkPath)).rejects.toThrow(
        expect.objectContaining({
          code: 'SYMLINK_NOT_ALLOWED'
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // 3. File Size Checks
  // -------------------------------------------------------------------------
  describe('3. File Size Checks', () => {
    it('3.1 rejects empty files (0 bytes) with FILE_EMPTY', async () => {
      const emptyPath = path.join(tempDir, 'empty.txt')
      fs.writeFileSync(emptyPath, '')

      await expect(validator.validate(emptyPath)).rejects.toThrow(
        expect.objectContaining({
          code: 'FILE_EMPTY'
        })
      )
    })

    it('3.2 permits files exactly at the configured maximum size limit', async () => {
      const limitBytes = 1024 * 1024 // 1 MiB limit for this test
      const customValidator = new DocumentFileValidator(
        new StaticDocumentSettingsProvider({
          maxFileSizeBytes: limitBytes
        })
      )

      const filePath = path.join(tempDir, 'exact-limit.txt')
      const buffer = Buffer.alloc(limitBytes, 'a')
      fs.writeFileSync(filePath, buffer)

      const result = await customValidator.validate(filePath)
      expect(result.fileSizeBytes).toBe(limitBytes)
    })

    it('3.3 rejects files exceeding the configured maximum size limit with FILE_TOO_LARGE', async () => {
      const limitBytes = 1024 * 1024 // 1 MiB limit
      const customValidator = new DocumentFileValidator(
        new StaticDocumentSettingsProvider({
          maxFileSizeBytes: limitBytes
        })
      )

      const filePath = path.join(tempDir, 'over-limit.txt')
      const buffer = Buffer.alloc(limitBytes + 1, 'a')
      fs.writeFileSync(filePath, buffer)

      await expect(customValidator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'FILE_TOO_LARGE'
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // 4. PDF Signature Validation
  // -------------------------------------------------------------------------
  describe('4. PDF Signature Validation', () => {
    it('4.1 rejects PDF with invalid magic bytes with INVALID_PDF_SIGNATURE', async () => {
      const filePath = path.join(tempDir, 'fake.pdf')
      fs.writeFileSync(filePath, 'NOT A PDF DOCUMENT BUT HAS PDF EXTENSION')

      await expect(validator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_PDF_SIGNATURE'
        })
      )
    })

    it('4.2 rejects short/corrupt file claiming to be PDF', async () => {
      const filePath = path.join(tempDir, 'short.pdf')
      fs.writeFileSync(filePath, '%PD')

      await expect(validator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_PDF_SIGNATURE'
        })
      )
    })

    it('4.3 accepts PDF with valid %PDF- magic bytes regardless of PDF version', async () => {
      for (const version of ['1.3', '1.4', '1.7', '2.0']) {
        const filePath = path.join(tempDir, `doc-${version}.pdf`)
        fs.writeFileSync(filePath, Buffer.from(`%PDF-${version}\n...trailer...`))

        const result = await validator.validate(filePath)
        expect(result.extension).toBe('pdf')
      }
    })
  })

  // -------------------------------------------------------------------------
  // 5. UTF-8 & Control Character Validation
  // -------------------------------------------------------------------------
  describe('5. UTF-8 & Control Character Validation', () => {
    it('5.1 rejects text files containing invalid UTF-8 byte sequences with INVALID_UTF8', async () => {
      const filePath = path.join(tempDir, 'invalid-utf8.txt')
      // Malformed UTF-8 sequence: standalone continuation byte or invalid byte
      const invalidBytes = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x77])
      fs.writeFileSync(filePath, invalidBytes)

      await expect(validator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_UTF8'
        })
      )
    })

    it('5.2 rejects text files containing null bytes with INVALID_UTF8', async () => {
      const filePath = path.join(tempDir, 'null-byte.md')
      const content = Buffer.concat([
        Buffer.from('# Heading\n'),
        Buffer.from([0x00]),
        Buffer.from('Rest of file')
      ])
      fs.writeFileSync(filePath, content)

      await expect(validator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_UTF8'
        })
      )
    })

    it('5.3 rejects text files containing binary control characters with INVALID_UTF8', async () => {
      const filePath = path.join(tempDir, 'bell-char.txt')
      // 0x07 is ASCII BEL control character
      const content = Buffer.from([0x41, 0x42, 0x07, 0x43])
      fs.writeFileSync(filePath, content)

      await expect(validator.validate(filePath)).rejects.toThrow(
        expect.objectContaining({
          code: 'INVALID_UTF8'
        })
      )
    })

    it('5.4 permits valid text files with tabs, line feeds, carriage returns, and UTF-8 BOM', async () => {
      const filePath = path.join(tempDir, 'valid-whitespace.txt')
      const content = '\uFEFFLine 1\tTabbed\r\nLine 2 with UTF-8 accents: é, ü, ñ, 漢字\n'
      fs.writeFileSync(filePath, content, 'utf-8')

      const result = await validator.validate(filePath)
      expect(result.extension).toBe('txt')
      expect(result.fileSizeBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    })
  })

  // -------------------------------------------------------------------------
  // 6. Checksum & Result Invariants
  // -------------------------------------------------------------------------
  describe('6. Checksum & Result Invariants', () => {
    it('6.1 produces exact SHA-256 matching known cryptographic vectors', async () => {
      const filePath = path.join(tempDir, 'vector.txt')
      const content = 'The quick brown fox jumps over the lazy dog'
      fs.writeFileSync(filePath, content, 'utf-8')

      const result = await validator.validate(filePath)
      // Known SHA-256 for "The quick brown fox jumps over the lazy dog"
      expect(result.contentHash).toBe(
        'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
      )
    })

    it('6.2 captures source metadata for internal TOCTOU verification', async () => {
      const filePath = path.join(tempDir, 'metadata.txt')
      fs.writeFileSync(filePath, 'Document metadata test.')

      const result = await validator.validate(filePath)
      expect(result.sourceMetadata).toBeDefined()
      expect(typeof result.sourceMetadata.dev).toBe('number')
      expect(typeof result.sourceMetadata.ino).toBe('number')
      expect(typeof result.sourceMetadata.mtimeMs).toBe('number')
      expect(result.sourceMetadata.size).toBe(result.fileSizeBytes)
    })
  })
})
