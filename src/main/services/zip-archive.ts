import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Precomputed CRC-32 lookup table for fast fallback computation.
 */
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c >>> 0
}

/**
 * Calculates 32-bit unsigned CRC of a buffer.
 */
export function calculateCrc32(buf: Buffer): number {
  if (typeof (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32 === 'function') {
    return (zlib as unknown as { crc32: (data: Buffer) => number }).crc32(buf) >>> 0
  }
  let crc = 0 ^ -1
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/**
 * Converts a JS Date to MS-DOS date and time (16-bit uints).
 */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const safeYear = Math.max(1980, Math.min(2099, date.getFullYear()))
  const dosTime =
    ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) &
    0xffff
  const dosDate =
    (((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { dosTime, dosDate }
}

/**
 * Normalizes and validates an archive relative path.
 * Enforces POSIX forward slashes, forbids leading slashes and path traversal ('..').
 */
export function normalizeArchivePath(entryPath: string): string {
  if (!entryPath || typeof entryPath !== 'string') {
    throw new Error('Archive entry path must be a non-empty string.')
  }

  // Replace all backslashes with forward slashes
  let normalized = entryPath.replace(/\\/g, '/').trim()

  // Remove leading slashes
  normalized = normalized.replace(/^\/+/, '')

  if (normalized.length === 0) {
    throw new Error('Archive entry path cannot be empty or root.')
  }

  // Check for path traversal segments
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new Error(`Archive entry path contains invalid segment '${segment}': ${entryPath}`)
    }
  }

  return normalized
}

export interface ZipArchiveEntry {
  readonly archivePath: string
  readonly rawData: Buffer
  readonly compressedData: Buffer
  readonly crc32: number
  readonly uncompressedSize: number
  readonly compressedSize: number
  readonly dosTime: number
  readonly dosDate: number
}

/**
 * Lightweight, zero-dependency PKZIP 2.0 archive writer.
 * Employs standard DEFLATE compression via node:zlib and validates path boundaries.
 */
export class ZipArchiveWriter {
  private readonly entries: ZipArchiveEntry[] = []
  private readonly seenPaths = new Set<string>()

  /**
   * Adds an entry to the ZIP archive from an in-memory string or Buffer.
   */
  public addEntry(archivePath: string, content: Buffer | string, mtime: Date = new Date()): void {
    const normalizedPath = normalizeArchivePath(archivePath)
    if (this.seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate archive entry path: ${normalizedPath}`)
    }

    const rawData = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const uncompressedSize = rawData.length
    const crc = calculateCrc32(rawData)
    const compressedData = zlib.deflateRawSync(rawData, { level: 6 })
    const compressedSize = compressedData.length
    const { dosTime, dosDate } = toDosDateTime(mtime)

    this.seenPaths.add(normalizedPath)
    this.entries.push({
      archivePath: normalizedPath,
      rawData,
      compressedData,
      crc32: crc,
      uncompressedSize,
      compressedSize,
      dosTime,
      dosDate
    })
  }

  /**
   * Adds an entry to the ZIP archive from a local filesystem file.
   */
  public addFile(
    archivePath: string,
    localFsPath: string,
    fsOps: { statSync?: typeof fs.statSync; readFileSync?: typeof fs.readFileSync } = fs
  ): void {
    const statFn = fsOps.statSync ?? fs.statSync
    const readFn = fsOps.readFileSync ?? fs.readFileSync

    if (!fs.existsSync(localFsPath)) {
      throw new Error(`File to archive does not exist: ${localFsPath}`)
    }

    const stat = statFn(localFsPath)
    if (!stat.isFile()) {
      throw new Error(`Path to archive is not a regular file: ${localFsPath}`)
    }

    const content = readFn(localFsPath)
    this.addEntry(archivePath, content, stat.mtime)
  }

  /**
   * Returns list of entries currently added to the writer.
   */
  public getEntries(): readonly ZipArchiveEntry[] {
    return this.entries
  }

  /**
   * Builds and returns the complete ZIP archive as a single Buffer.
   */
  public build(): Buffer {
    const localHeadersAndData: Buffer[] = []
    const centralDirectoryHeaders: Buffer[] = []
    let currentOffset = 0

    const entryOffsets: number[] = []

    // 1. Generate Local File Headers & File Data
    for (const entry of this.entries) {
      entryOffsets.push(currentOffset)

      const nameBytes = Buffer.from(entry.archivePath, 'utf8')
      const localHeader = Buffer.alloc(30)

      localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
      localHeader.writeUInt16LE(20, 4) // Version needed to extract (2.0)
      localHeader.writeUInt16LE(0x0800, 6) // General purpose bit flag (UTF-8 filename)
      localHeader.writeUInt16LE(8, 8) // Compression method: 8 (DEFLATE)
      localHeader.writeUInt16LE(entry.dosTime, 10)
      localHeader.writeUInt16LE(entry.dosDate, 12)
      localHeader.writeUInt32LE(entry.crc32, 14)
      localHeader.writeUInt32LE(entry.compressedSize, 18)
      localHeader.writeUInt32LE(entry.uncompressedSize, 22)
      localHeader.writeUInt16LE(nameBytes.length, 26) // File name length
      localHeader.writeUInt16LE(0, 28) // Extra field length

      localHeadersAndData.push(localHeader, nameBytes, entry.compressedData)
      currentOffset += localHeader.length + nameBytes.length + entry.compressedData.length
    }

    const centralDirectoryOffset = currentOffset

    // 2. Generate Central Directory Headers
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]
      const offset = entryOffsets[i]
      const nameBytes = Buffer.from(entry.archivePath, 'utf8')
      const cdHeader = Buffer.alloc(46)

      cdHeader.writeUInt32LE(0x02014b50, 0) // Central directory file header signature
      cdHeader.writeUInt16LE(0x0314, 4) // Version made by (Unix, 2.0)
      cdHeader.writeUInt16LE(20, 6) // Version needed to extract (2.0)
      cdHeader.writeUInt16LE(0x0800, 8) // General purpose bit flag (UTF-8)
      cdHeader.writeUInt16LE(8, 10) // Compression method: 8 (DEFLATE)
      cdHeader.writeUInt16LE(entry.dosTime, 12)
      cdHeader.writeUInt16LE(entry.dosDate, 14)
      cdHeader.writeUInt32LE(entry.crc32, 16)
      cdHeader.writeUInt32LE(entry.compressedSize, 20)
      cdHeader.writeUInt32LE(entry.uncompressedSize, 24)
      cdHeader.writeUInt16LE(nameBytes.length, 28) // File name length
      cdHeader.writeUInt16LE(0, 30) // Extra field length
      cdHeader.writeUInt16LE(0, 32) // File comment length
      cdHeader.writeUInt16LE(0, 34) // Disk number start
      cdHeader.writeUInt16LE(0, 36) // Internal file attributes
      cdHeader.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38) // External file attributes (regular file -rw-r--r--)
      cdHeader.writeUInt32LE(offset, 42) // Relative offset of local header

      centralDirectoryHeaders.push(cdHeader, nameBytes)
      currentOffset += cdHeader.length + nameBytes.length
    }

    const centralDirectorySize = currentOffset - centralDirectoryOffset

    // 3. Generate End of Central Directory Record (EOCD)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0) // End of central dir signature
    eocd.writeUInt16LE(0, 4) // Number of this disk
    eocd.writeUInt16LE(0, 6) // Disk where central directory starts
    eocd.writeUInt16LE(this.entries.length, 8) // Number of central directory records on this disk
    eocd.writeUInt16LE(this.entries.length, 10) // Total number of central directory records
    eocd.writeUInt32LE(centralDirectorySize, 12) // Size of central directory
    eocd.writeUInt32LE(centralDirectoryOffset, 16) // Offset of start of central directory
    eocd.writeUInt16LE(0, 20) // Comment length

    return Buffer.concat([...localHeadersAndData, ...centralDirectoryHeaders, eocd])
  }

  /**
   * Writes the ZIP archive to a destination file atomically via a temporary file.
   */
  public async writeToFile(destinationPath: string): Promise<number> {
    const buffer = this.build()
    const targetDir = path.dirname(destinationPath)
    await fs.promises.mkdir(targetDir, { recursive: true })

    const tempPath = `${destinationPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    try {
      await fs.promises.writeFile(tempPath, buffer)
      await fs.promises.rename(tempPath, destinationPath)
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath)
        }
      } catch {
        // Ignore cleanup error
      }
      throw err
    }

    return buffer.length
  }
}

/**
 * Verifies that a file is a structurally valid PKZIP archive by validating
 * the End of Central Directory (EOCD) record and central directory boundaries.
 */
export async function verifyZipArchive(
  filePath: string
): Promise<{ valid: boolean; entryCount: number }> {
  const stat = await fs.promises.stat(filePath)
  if (stat.size < 22) {
    throw new Error('File is too small to be a valid ZIP archive.')
  }

  // Read end of file to find EOCD
  const readSize = Math.min(stat.size, 65557)
  const buffer = Buffer.alloc(readSize)
  const fd = await fs.promises.open(filePath, 'r')
  try {
    await fd.read(buffer, 0, readSize, stat.size - readSize)
  } finally {
    await fd.close()
  }

  // Search backwards for EOCD signature (0x06054b50)
  let eocdOffset = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Corrupt ZIP archive: End of Central Directory record not found.')
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const cdSize = buffer.readUInt32LE(eocdOffset + 12)
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)

  if (cdOffset + cdSize > stat.size) {
    throw new Error('Corrupt ZIP archive: Central directory extends beyond file bounds.')
  }

  return { valid: true, entryCount }
}
