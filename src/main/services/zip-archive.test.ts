import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import unzipper from 'unzipper'
import {
  ZipArchiveWriter,
  calculateCrc32,
  toDosDateTime,
  normalizeArchivePath,
  verifyZipArchive
} from './zip-archive'

describe('ZipArchiveWriter', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zip-archive-test-'))
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('calculates consistent CRC32 values', () => {
    const data = Buffer.from('hello world', 'utf8')
    const crc = calculateCrc32(data)
    expect(typeof crc).toBe('number')
    expect(crc).toBeGreaterThan(0)
    // Same buffer produces identical CRC
    expect(calculateCrc32(data)).toBe(crc)
  })

  it('converts JS Date to valid DOS date and time', () => {
    const date = new Date(2026, 10, 16, 14, 30, 20)
    const { dosTime, dosDate } = toDosDateTime(date)
    expect(dosTime).toBeGreaterThan(0)
    expect(dosDate).toBeGreaterThan(0)
  })

  it('normalizes archive paths and rejects traversal attempts', () => {
    expect(normalizeArchivePath('foo/bar.txt')).toBe('foo/bar.txt')
    expect(normalizeArchivePath('foo\\bar.txt')).toBe('foo/bar.txt')
    expect(normalizeArchivePath('/leading/slash.txt')).toBe('leading/slash.txt')

    expect(() => normalizeArchivePath('')).toThrow('Archive entry path must be a non-empty string.')
    expect(() => normalizeArchivePath('../outside.txt')).toThrow('invalid segment')
    expect(() => normalizeArchivePath('foo/../../bar.txt')).toThrow('invalid segment')
    expect(() => normalizeArchivePath('foo/./bar.txt')).toThrow('invalid segment')
  })

  it('prevents adding duplicate entry paths', () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('file.txt', 'first')
    expect(() => writer.addEntry('file.txt', 'second')).toThrow('Duplicate archive entry path')
  })

  it('builds a valid ZIP archive that unzipper can extract with 100% fidelity', async () => {
    const writer = new ZipArchiveWriter()
    const textContent = JSON.stringify({ message: 'Hello from Voyaro export!' }, null, 2)
    const binaryContent = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0xaa, 0xbb, 0xcc])

    writer.addEntry('manifest.json', textContent)
    writer.addEntry('documents/source-1.bin', binaryContent)

    // Also add a local file
    const localFilePath = path.join(tmpDir, 'test-doc.txt')
    await fs.promises.writeFile(localFilePath, 'Original document content here', 'utf8')
    writer.addFile('documents/test-doc.txt', localFilePath)

    const zipBuffer = writer.build()
    expect(zipBuffer.length).toBeGreaterThan(0)

    // Verify extraction with unzipper
    const directory = await unzipper.Open.buffer(zipBuffer)
    expect(directory.files.length).toBe(3)

    const manifestFile = directory.files.find((f) => f.path === 'manifest.json')
    expect(manifestFile).toBeDefined()
    const manifestExtracted = (await manifestFile!.buffer()).toString('utf8')
    expect(manifestExtracted).toBe(textContent)

    const binFile = directory.files.find((f) => f.path === 'documents/source-1.bin')
    expect(binFile).toBeDefined()
    const binExtracted = await binFile!.buffer()
    expect(binExtracted.equals(binaryContent)).toBe(true)

    const docFile = directory.files.find((f) => f.path === 'documents/test-doc.txt')
    expect(docFile).toBeDefined()
    const docExtracted = (await docFile!.buffer()).toString('utf8')
    expect(docExtracted).toBe('Original document content here')
  })

  it('writes archive atomically to destination path', async () => {
    const writer = new ZipArchiveWriter()
    writer.addEntry('readme.txt', 'Atomically written archive')

    const outPath = path.join(tmpDir, 'subfolder', 'test.zip')
    const size = await writer.writeToFile(outPath)
    expect(size).toBeGreaterThan(0)
    expect(fs.existsSync(outPath)).toBe(true)

    const stat = await fs.promises.stat(outPath)
    expect(stat.size).toBe(size)

    const dir = await unzipper.Open.file(outPath)
    expect(dir.files.length).toBe(1)
    expect(dir.files[0].path).toBe('readme.txt')
    expect((await dir.files[0].buffer()).toString('utf8')).toBe('Atomically written archive')

    // Test verifyZipArchive
    const verification = await verifyZipArchive(outPath)
    expect(verification.valid).toBe(true)
    expect(verification.entryCount).toBe(1)
  })

  it('verifyZipArchive rejects invalid or corrupt files', async () => {
    const corruptPath = path.join(tmpDir, 'corrupt.zip')
    await fs.promises.writeFile(corruptPath, 'This is definitely not a zip file', 'utf8')
    await expect(verifyZipArchive(corruptPath)).rejects.toThrow('Corrupt ZIP archive')

    const emptyPath = path.join(tmpDir, 'empty.zip')
    await fs.promises.writeFile(emptyPath, Buffer.alloc(10))
    await expect(verifyZipArchive(emptyPath)).rejects.toThrow('too small')
  })
})
