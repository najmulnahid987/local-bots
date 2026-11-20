import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { calculateCrc32 } from './zip-archive'

/**
 * Conservative resource limits for archive extraction.
 */
export const ARCHIVE_LIMITS = {
  MAX_COMPRESSED_ARCHIVE_SIZE: 500 * 1024 * 1024, // 500 MB
  MAX_TOTAL_UNCOMPRESSED_SIZE: 2 * 1024 * 1024 * 1024, // 2 GB
  MAX_INDIVIDUAL_FILE_SIZE: 500 * 1024 * 1024, // 500 MB
  MAX_METADATA_JSON_SIZE: 50 * 1024 * 1024, // 50 MB
  MAX_ENTRY_COUNT: 10000,
  MAX_COMPRESSION_RATIO: 50 // 50:1
} as const

/**
 * Windows reserved device names that must never be created or referenced.
 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/**
 * Allowed metadata filenames at archive root.
 */
const EXPECTED_METADATA_ENTRIES = new Set([
  'manifest.json',
  'knowledge-base.json',
  'bots.json',
  'bot-memories.json',
  'sources.json',
  'conversations.json'
])

/**
 * Allowed document file extensions.
 */
const ALLOWED_DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx'])

/**
 * UUIDv4 validation regex.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ArchiveValidationError extends Error {
  public readonly code: string

  constructor(message: string, code: string = 'ARCHIVE_VALIDATION_ERROR') {
    super(message)
    this.name = 'ArchiveValidationError'
    this.code = code
  }
}

export interface CentralDirectoryEntry {
  readonly filename: string
  readonly compressionMethod: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
  readonly isEncrypted: boolean
  readonly isUtf8: boolean
}

export interface StagedDocumentFile {
  readonly sourceId: string
  readonly fileType: string
  readonly stagedPath: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface ExtractedArchiveBundle {
  readonly manifestRaw: string
  readonly knowledgeBaseRaw: string
  readonly botsRaw: string
  readonly botMemoriesRaw: string
  readonly sourcesRaw: string
  readonly conversationsRaw: string
  readonly stagedDocuments: Map<string, StagedDocumentFile>
  readonly stagingDir: string
  readonly totalUncompressedBytes: number
  readonly entryCount: number
}

/**
 * Validates an archive entry name against Zip Slip, traversal, Windows devices, and allowlist.
 */
export function validateArchiveEntryName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    throw new ArchiveValidationError('Archive entry path cannot be empty.', 'MALFORMED_ENTRY')
  }

  // Reject null bytes, backslashes, alternate data streams
  if (rawName.includes('\0')) {
    throw new ArchiveValidationError('Archive entry path contains null bytes.', 'MALFORMED_ENTRY')
  }
  if (rawName.includes('\\')) {
    throw new ArchiveValidationError(
      'Archive entry path contains backslashes.',
      'PATH_TRAVERSAL_DETECTED'
    )
  }
  if (rawName.includes(':')) {
    throw new ArchiveValidationError(
      'Archive entry path contains invalid drive or stream delimiter (:).',
      'PATH_TRAVERSAL_DETECTED'
    )
  }

  // Reject absolute paths
  if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) {
    throw new ArchiveValidationError(
      'Archive entry specifies an absolute path.',
      'PATH_TRAVERSAL_DETECTED'
    )
  }

  const segments = rawName.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ArchiveValidationError(
        `Archive entry contains traversal segment '${segment}': ${rawName}`,
        'PATH_TRAVERSAL_DETECTED'
      )
    }
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      throw new ArchiveValidationError(
        `Archive entry contains Windows reserved device name '${segment}': ${rawName}`,
        'UNSAFE_ENTRY_NAME'
      )
    }
  }

  const normalized = segments.join('/')

  // Validate against allowlist
  if (EXPECTED_METADATA_ENTRIES.has(normalized)) {
    return normalized
  }

  // Check document entries: documents/<uuid>.<ext>
  if (normalized.startsWith('documents/')) {
    const docFile = normalized.slice('documents/'.length)
    const dotIndex = docFile.lastIndexOf('.')
    if (dotIndex === -1) {
      throw new ArchiveValidationError(
        `Document entry missing extension: ${normalized}`,
        'UNEXPECTED_ENTRY'
      )
    }
    const sourceId = docFile.slice(0, dotIndex)
    const ext = docFile.slice(dotIndex + 1).toLowerCase()

    if (!UUID_V4_REGEX.test(sourceId)) {
      throw new ArchiveValidationError(
        `Document entry contains invalid UUID: ${sourceId}`,
        'UNEXPECTED_ENTRY'
      )
    }
    if (!ALLOWED_DOCUMENT_EXTENSIONS.has(ext)) {
      throw new ArchiveValidationError(
        `Document entry has unsupported extension '${ext}': ${normalized}`,
        'UNSUPPORTED_FILE_TYPE'
      )
    }
    return normalized
  }

  throw new ArchiveValidationError(
    `Unexpected archive entry outside allowlist: ${normalized}`,
    'UNEXPECTED_ENTRY'
  )
}

/**
 * Validates a PKZIP archive, enforces security bounds, and extracts entries into a safe temporary staging folder.
 */
export class ArchiveExtractor {
  /**
   * Inspects and extracts an archive file into a dedicated staging directory.
   */
  public async extractAndValidate(
    archivePath: string,
    tempBaseDir: string
  ): Promise<ExtractedArchiveBundle> {
    const stat = await fs.promises.stat(archivePath)

    if (stat.size > ARCHIVE_LIMITS.MAX_COMPRESSED_ARCHIVE_SIZE) {
      throw new ArchiveValidationError(
        `Archive exceeds maximum compressed size of ${ARCHIVE_LIMITS.MAX_COMPRESSED_ARCHIVE_SIZE / (1024 * 1024)} MB.`,
        'ARCHIVE_TOO_LARGE'
      )
    }
    if (stat.size < 22) {
      throw new ArchiveValidationError(
        'File is too small to be a valid ZIP archive.',
        'MALFORMED_ARCHIVE'
      )
    }

    const fd = await fs.promises.open(archivePath, 'r')
    try {
      // 1. Locate and validate EOCD
      const eocd = await this.readEocd(fd, stat.size)

      if (eocd.entryCount > ARCHIVE_LIMITS.MAX_ENTRY_COUNT) {
        throw new ArchiveValidationError(
          `Archive contains ${eocd.entryCount} entries, exceeding limit of ${ARCHIVE_LIMITS.MAX_ENTRY_COUNT}.`,
          'TOO_MANY_ENTRIES'
        )
      }

      // 2. Parse Central Directory Entries
      const cdEntries = await this.readCentralDirectory(
        fd,
        eocd.cdOffset,
        eocd.cdSize,
        eocd.entryCount
      )

      // 3. Verify deduplication and name safety
      const seenNames = new Set<string>()
      for (const entry of cdEntries) {
        const canonical = entry.filename.toLowerCase()
        if (seenNames.has(canonical)) {
          throw new ArchiveValidationError(
            `Duplicate or collision-prone entry detected: ${entry.filename}`,
            'DUPLICATE_ENTRY'
          )
        }
        seenNames.add(canonical)
      }

      // Check all required metadata files are present
      for (const required of EXPECTED_METADATA_ENTRIES) {
        if (!seenNames.has(required.toLowerCase())) {
          throw new ArchiveValidationError(
            `Required archive file '${required}' is missing from central directory.`,
            'MISSING_REQUIRED_FILE'
          )
        }
      }

      // 4. Create isolated temporary staging directory
      const sessionId = crypto.randomUUID()
      const stagingDir = path.join(tempBaseDir, `import-staging-${sessionId}`)
      await fs.promises.mkdir(stagingDir, { recursive: true })
      await fs.promises.mkdir(path.join(stagingDir, 'documents'), { recursive: true })

      let totalUncompressedBytes = 0
      const rawMetadataMap = new Map<string, string>()
      const stagedDocuments = new Map<string, StagedDocumentFile>()

      try {
        // 5. Decompress each entry with limits and verification
        for (const entry of cdEntries) {
          // Verify local file header matches CD entry
          const dataOffset = await this.verifyLocalHeader(fd, entry)

          if (entry.uncompressedSize > ARCHIVE_LIMITS.MAX_INDIVIDUAL_FILE_SIZE) {
            throw new ArchiveValidationError(
              `Entry '${entry.filename}' declared uncompressed size exceeds ${ARCHIVE_LIMITS.MAX_INDIVIDUAL_FILE_SIZE / (1024 * 1024)} MB.`,
              'FILE_TOO_LARGE'
            )
          }

          if (EXPECTED_METADATA_ENTRIES.has(entry.filename)) {
            // Decompress metadata JSON in-memory
            const decompressed = await this.decompressEntry(fd, entry, dataOffset)
            totalUncompressedBytes += decompressed.length

            if (decompressed.length > ARCHIVE_LIMITS.MAX_METADATA_JSON_SIZE) {
              throw new ArchiveValidationError(
                `Metadata file '${entry.filename}' exceeds maximum JSON limit.`,
                'METADATA_TOO_LARGE'
              )
            }

            rawMetadataMap.set(entry.filename, decompressed.toString('utf8'))
            await fs.promises.writeFile(path.join(stagingDir, entry.filename), decompressed)
          } else if (entry.filename.startsWith('documents/')) {
            // Decompress document to staging file
            const docFile = entry.filename.slice('documents/'.length)
            const dotIndex = docFile.lastIndexOf('.')
            const sourceId = docFile.slice(0, dotIndex)
            const ext = docFile.slice(dotIndex + 1).toLowerCase()
            const stagedFilePath = path.join(stagingDir, 'documents', `${sourceId}.${ext}`)

            const result = await this.decompressToFile(fd, entry, dataOffset, stagedFilePath)
            totalUncompressedBytes += result.sizeBytes

            if (totalUncompressedBytes > ARCHIVE_LIMITS.MAX_TOTAL_UNCOMPRESSED_SIZE) {
              throw new ArchiveValidationError(
                'Total uncompressed size of archive exceeds 2 GB limit.',
                'DECOMPRESSION_BOMB_DETECTED'
              )
            }

            stagedDocuments.set(sourceId, {
              sourceId,
              fileType: ext,
              stagedPath: stagedFilePath,
              sizeBytes: result.sizeBytes,
              sha256: result.sha256
            })
          }
        }

        return {
          manifestRaw: rawMetadataMap.get('manifest.json')!,
          knowledgeBaseRaw: rawMetadataMap.get('knowledge-base.json')!,
          botsRaw: rawMetadataMap.get('bots.json')!,
          botMemoriesRaw: rawMetadataMap.get('bot-memories.json')!,
          sourcesRaw: rawMetadataMap.get('sources.json')!,
          conversationsRaw: rawMetadataMap.get('conversations.json')!,
          stagedDocuments,
          stagingDir,
          totalUncompressedBytes,
          entryCount: cdEntries.length
        }
      } catch (err) {
        // Cleanup staging on error
        await this.cleanStagingDirectory(stagingDir)
        throw err
      }
    } finally {
      await fd.close()
    }
  }

  /**
   * Safely deletes a staging directory and all its files.
   */
  public async cleanStagingDirectory(stagingDir: string): Promise<void> {
    try {
      if (fs.existsSync(stagingDir)) {
        await fs.promises.rm(stagingDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup error
    }
  }

  /**
   * Reads and verifies the End of Central Directory (EOCD) record.
   */
  private async readEocd(
    fd: fs.promises.FileHandle,
    fileSize: number
  ): Promise<{ entryCount: number; cdSize: number; cdOffset: number }> {
    const searchSize = Math.min(fileSize, 65557)
    const buffer = Buffer.alloc(searchSize)
    await fd.read(buffer, 0, searchSize, fileSize - searchSize)

    // Search backwards for EOCD signature (0x06054b50)
    let eocdOffset = -1
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i
        break
      }
    }

    if (eocdOffset === -1) {
      throw new ArchiveValidationError(
        'Corrupt ZIP archive: End of Central Directory record not found.',
        'MALFORMED_ARCHIVE'
      )
    }

    // Check for ZIP64 indicators
    const diskNumber = buffer.readUInt16LE(eocdOffset + 4)
    const cdDiskNumber = buffer.readUInt16LE(eocdOffset + 6)
    const diskEntries = buffer.readUInt16LE(eocdOffset + 8)
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
    const cdSize = buffer.readUInt32LE(eocdOffset + 12)
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16)

    if (
      diskNumber === 0xffff ||
      cdDiskNumber === 0xffff ||
      diskEntries === 0xffff ||
      totalEntries === 0xffff ||
      cdOffset === 0xffffffff
    ) {
      throw new ArchiveValidationError(
        'ZIP64 archives are not supported: archive exceeds 4 GB / 65535 entry limits.',
        'ZIP64_NOT_SUPPORTED'
      )
    }

    if (diskNumber !== 0 || cdDiskNumber !== 0 || diskEntries !== totalEntries) {
      throw new ArchiveValidationError(
        'Multi-disk spanning ZIP archives are not supported.',
        'MULTI_DISK_NOT_SUPPORTED'
      )
    }

    if (cdOffset + cdSize > fileSize) {
      throw new ArchiveValidationError(
        'Central directory bounds extend beyond archive file size.',
        'MALFORMED_ARCHIVE'
      )
    }

    return { entryCount: totalEntries, cdSize, cdOffset }
  }

  /**
   * Reads all Central Directory entries.
   */
  private async readCentralDirectory(
    fd: fs.promises.FileHandle,
    cdOffset: number,
    cdSize: number,
    expectedCount: number
  ): Promise<CentralDirectoryEntry[]> {
    const cdBuffer = Buffer.alloc(cdSize)
    await fd.read(cdBuffer, 0, cdSize, cdOffset)

    const entries: CentralDirectoryEntry[] = []
    let offset = 0

    while (offset < cdSize) {
      if (offset + 46 > cdSize) {
        throw new ArchiveValidationError(
          'Truncated Central Directory header record.',
          'MALFORMED_ARCHIVE'
        )
      }

      const sig = cdBuffer.readUInt32LE(offset)
      if (sig !== 0x02014b50) {
        throw new ArchiveValidationError(
          `Invalid Central Directory header signature: 0x${sig.toString(16)}`,
          'MALFORMED_ARCHIVE'
        )
      }

      const flags = cdBuffer.readUInt16LE(offset + 8)
      const method = cdBuffer.readUInt16LE(offset + 10)
      const crc32 = cdBuffer.readUInt32LE(offset + 16)
      const compSize = cdBuffer.readUInt32LE(offset + 20)
      const uncompSize = cdBuffer.readUInt32LE(offset + 24)
      const nameLen = cdBuffer.readUInt16LE(offset + 28)
      const extraLen = cdBuffer.readUInt16LE(offset + 30)
      const commentLen = cdBuffer.readUInt16LE(offset + 32)
      const localOffset = cdBuffer.readUInt32LE(offset + 42)

      const isEncrypted = (flags & 0x0001) !== 0
      const isUtf8 = (flags & 0x0800) !== 0

      if (isEncrypted) {
        throw new ArchiveValidationError(
          'Encrypted/password-protected ZIP archives are not supported.',
          'ENCRYPTED_ARCHIVE_NOT_SUPPORTED'
        )
      }

      if (method !== 0 && method !== 8) {
        throw new ArchiveValidationError(
          `Unsupported compression method '${method}'. Only Stored (0) and Deflate (8) are supported.`,
          'UNSUPPORTED_COMPRESSION_METHOD'
        )
      }

      if (offset + 46 + nameLen > cdSize) {
        throw new ArchiveValidationError(
          'Truncated filename in Central Directory entry.',
          'MALFORMED_ARCHIVE'
        )
      }

      const rawFilename = cdBuffer.toString('utf8', offset + 46, offset + 46 + nameLen)
      const safeFilename = validateArchiveEntryName(rawFilename)

      entries.push({
        filename: safeFilename,
        compressionMethod: method,
        crc32,
        compressedSize: compSize,
        uncompressedSize: uncompSize,
        localHeaderOffset: localOffset,
        isEncrypted,
        isUtf8
      })

      offset += 46 + nameLen + extraLen + commentLen
    }

    if (entries.length !== expectedCount) {
      throw new ArchiveValidationError(
        `Central directory entry count mismatch: expected ${expectedCount}, found ${entries.length}`,
        'MALFORMED_ARCHIVE'
      )
    }

    return entries
  }

  /**
   * Reads and verifies the Local File Header at `localHeaderOffset`.
   * Returns data start offset in file.
   */
  private async verifyLocalHeader(
    fd: fs.promises.FileHandle,
    cdEntry: CentralDirectoryEntry
  ): Promise<number> {
    const headerBuffer = Buffer.alloc(30)
    await fd.read(headerBuffer, 0, 30, cdEntry.localHeaderOffset)

    const sig = headerBuffer.readUInt32LE(0)
    if (sig !== 0x04034b50) {
      throw new ArchiveValidationError(
        `Invalid Local File Header signature at offset ${cdEntry.localHeaderOffset} for '${cdEntry.filename}'.`,
        'MALFORMED_LOCAL_HEADER'
      )
    }

    const localMethod = headerBuffer.readUInt16LE(8)
    const nameLen = headerBuffer.readUInt16LE(26)
    const extraLen = headerBuffer.readUInt16LE(28)

    if (localMethod !== cdEntry.compressionMethod) {
      throw new ArchiveValidationError(
        `Compression method mismatch between local and central header for '${cdEntry.filename}'.`,
        'HEADER_MISMATCH'
      )
    }

    const nameBuffer = Buffer.alloc(nameLen)
    await fd.read(nameBuffer, 0, nameLen, cdEntry.localHeaderOffset + 30)
    const localName = nameBuffer.toString('utf8')

    // Local header name must match CD name
    if (validateArchiveEntryName(localName) !== cdEntry.filename) {
      throw new ArchiveValidationError(
        `Filename mismatch between local header ('${localName}') and central directory ('${cdEntry.filename}').`,
        'HEADER_MISMATCH'
      )
    }

    return cdEntry.localHeaderOffset + 30 + nameLen + extraLen
  }

  /**
   * Decompresses an in-memory entry (used for small metadata JSON files).
   */
  private async decompressEntry(
    fd: fs.promises.FileHandle,
    entry: CentralDirectoryEntry,
    dataOffset: number
  ): Promise<Buffer> {
    const rawData = Buffer.alloc(entry.compressedSize)
    await fd.read(rawData, 0, entry.compressedSize, dataOffset)

    let decompressed: Buffer
    if (entry.compressionMethod === 0) {
      decompressed = rawData
    } else {
      try {
        decompressed = zlib.inflateRawSync(rawData, {
          maxOutputLength: ARCHIVE_LIMITS.MAX_METADATA_JSON_SIZE
        })
      } catch (inflateErr) {
        throw new ArchiveValidationError(
          `Decompression failed for '${entry.filename}': ${inflateErr instanceof Error ? inflateErr.message : String(inflateErr)}`,
          'DECOMPRESSION_FAILED'
        )
      }
    }

    // Verify uncompressed size
    if (decompressed.length !== entry.uncompressedSize) {
      throw new ArchiveValidationError(
        `Uncompressed size mismatch for '${entry.filename}': expected ${entry.uncompressedSize}, got ${decompressed.length}`,
        'SIZE_MISMATCH'
      )
    }

    // Verify CRC32
    const computedCrc = calculateCrc32(decompressed)
    if (computedCrc !== entry.crc32) {
      throw new ArchiveValidationError(
        `CRC32 checksum mismatch for '${entry.filename}': expected ${entry.crc32}, computed ${computedCrc}`,
        'CRC_MISMATCH'
      )
    }

    return decompressed
  }

  /**
   * Decompresses an entry to a file while enforcing streaming size limits and calculating checksums.
   */
  private async decompressToFile(
    fd: fs.promises.FileHandle,
    entry: CentralDirectoryEntry,
    dataOffset: number,
    destinationPath: string
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const compressedData = Buffer.alloc(entry.compressedSize)
    await fd.read(compressedData, 0, entry.compressedSize, dataOffset)

    let decompressed: Buffer
    if (entry.compressionMethod === 0) {
      decompressed = compressedData
    } else {
      try {
        decompressed = zlib.inflateRawSync(compressedData, {
          maxOutputLength: ARCHIVE_LIMITS.MAX_INDIVIDUAL_FILE_SIZE
        })
      } catch (inflateErr) {
        throw new ArchiveValidationError(
          `Decompression failed for '${entry.filename}': ${inflateErr instanceof Error ? inflateErr.message : String(inflateErr)}`,
          'DECOMPRESSION_FAILED'
        )
      }
    }

    // Verify uncompressed size
    if (decompressed.length !== entry.uncompressedSize) {
      throw new ArchiveValidationError(
        `Uncompressed size mismatch for '${entry.filename}': expected ${entry.uncompressedSize}, got ${decompressed.length}`,
        'SIZE_MISMATCH'
      )
    }

    // Decompression bomb check: compression ratio must not exceed 50:1
    const ratio = decompressed.length / Math.max(1, entry.compressedSize)
    if (ratio > ARCHIVE_LIMITS.MAX_COMPRESSION_RATIO) {
      throw new ArchiveValidationError(
        `Decompression bomb rejected: ratio ${ratio.toFixed(1)}:1 exceeds limit of ${ARCHIVE_LIMITS.MAX_COMPRESSION_RATIO}:1 for '${entry.filename}'.`,
        'DECOMPRESSION_BOMB_DETECTED'
      )
    }

    // Verify CRC32
    const computedCrc = calculateCrc32(decompressed)
    if (computedCrc !== entry.crc32) {
      throw new ArchiveValidationError(
        `CRC32 checksum mismatch for '${entry.filename}': expected ${entry.crc32}, computed ${computedCrc}`,
        'CRC_MISMATCH'
      )
    }

    const sha256 = crypto.createHash('sha256').update(decompressed).digest('hex')
    await fs.promises.writeFile(destinationPath, decompressed)

    return { sizeBytes: decompressed.length, sha256 }
  }
}
