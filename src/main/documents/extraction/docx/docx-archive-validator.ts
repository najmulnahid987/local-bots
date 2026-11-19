import zlib from 'node:zlib'
import { calculateCrc32 } from '../../../services/zip-archive'
import { DocumentErrors } from '../../document-errors'

/**
 * Defensive limits applied to DOCX ZIP packages to prevent denial-of-service,
 * decompression bombs, memory exhaustion, and archive directory floods.
 */
export interface DocxArchiveLimits {
  /**
   * Maximum compressed input size in bytes (default: 20 MiB).
   */
  readonly maxCompressedBytes?: number

  /**
   * Maximum permitted number of archive entries (default: 1,000).
   */
  readonly maxEntries?: number

  /**
   * Maximum total uncompressed size across all entries (default: 50 MiB).
   */
  readonly maxTotalUncompressedBytes?: number

  /**
   * Maximum uncompressed size for any single archive entry (default: 20 MiB).
   */
  readonly maxEntryUncompressedBytes?: number

  /**
   * Maximum compression ratio (uncompressed / compressed) before triggering zip-bomb rejection (default: 100).
   */
  readonly maxCompressionRatio?: number
}

export const DEFAULT_DOCX_ARCHIVE_LIMITS: Required<DocxArchiveLimits> = {
  maxCompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxEntries: 1000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024, // 50 MiB
  maxEntryUncompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxCompressionRatio: 100
} as const

/**
 * Parsed metadata for a single entry in a ZIP central directory.
 */
export interface DocxZipEntryMetadata {
  readonly fileName: string
  readonly compressionMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly crc32: number
  readonly localHeaderOffset: number
  readonly isEncrypted: boolean
}

/**
 * Result emitted by DocxArchiveValidator upon successful preflight audit.
 */
export interface DocxArchiveValidationResult {
  readonly valid: true
  readonly entryCount: number
  readonly totalUncompressedSize: number
  readonly hasImages: boolean
  readonly imageEntries: readonly string[]
  readonly entries: readonly string[]
}

/**
 * DocxArchiveValidator performs exhaustive, zero-dependency, memory-bounded
 * preflight validation of Microsoft Word (.docx) ZIP packages.
 *
 * Enforces:
 * 1. Strict ZIP header and central directory boundary validation.
 * 2. Rejection of encrypted, password-protected archives.
 * 3. Rejection of macro-enabled files (.docm, vbaProject.bin).
 * 4. Rejection of other Office types (XLSX, PPTX) disguised with .docx extensions.
 * 5. Decompression bomb (Zip bomb) prevention via ratio and size caps.
 * 6. Protection against XML External Entity (XXE) and billion-laughs entity expansions.
 * 7. Path traversal prevention (disallows '..', leading slashes, NUL bytes).
 */
export class DocxArchiveValidator {
  /**
   * Validates a candidate DOCX buffer against all defensive rules.
   * Throws DocumentExtractionError on any violation.
   */
  public static validate(
    bytes: Uint8Array | Buffer,
    limits?: DocxArchiveLimits
  ): DocxArchiveValidationResult {
    const effectiveLimits: Required<DocxArchiveLimits> = {
      maxCompressedBytes:
        limits?.maxCompressedBytes ?? DEFAULT_DOCX_ARCHIVE_LIMITS.maxCompressedBytes,
      maxEntries: limits?.maxEntries ?? DEFAULT_DOCX_ARCHIVE_LIMITS.maxEntries,
      maxTotalUncompressedBytes:
        limits?.maxTotalUncompressedBytes ?? DEFAULT_DOCX_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
      maxEntryUncompressedBytes:
        limits?.maxEntryUncompressedBytes ?? DEFAULT_DOCX_ARCHIVE_LIMITS.maxEntryUncompressedBytes,
      maxCompressionRatio:
        limits?.maxCompressionRatio ?? DEFAULT_DOCX_ARCHIVE_LIMITS.maxCompressionRatio
    }

    if (!bytes || bytes.length === 0) {
      throw DocumentErrors.extractionEmptyContent('The document content is empty.')
    }

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

    if (buf.length > effectiveLimits.maxCompressedBytes) {
      throw DocumentErrors.fileTooLarge(effectiveLimits.maxCompressedBytes)
    }

    // 1. Verify ZIP local file header magic bytes (0x04034b50 -> 'PK\x03\x04')
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
      throw DocumentErrors.extractionInvalidArchive(
        'File does not start with standard PKZIP signature.'
      )
    }

    // 2. Locate End of Central Directory (EOCD) signature (0x06054b50)
    // EOCD is minimum 22 bytes long and located within last 65,557 bytes (22 + max comment length of 65,535)
    const searchRange = Math.min(buf.length, 65557)
    let eocdOffset = -1

    for (let i = buf.length - 22; i >= buf.length - searchRange; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i
        break
      }
    }

    if (eocdOffset === -1) {
      throw DocumentErrors.extractionInvalidArchive(
        'Malformed ZIP package: End of Central Directory record not found.'
      )
    }

    // Read EOCD record
    const diskNumber = buf.readUInt16LE(eocdOffset + 4)
    const cdStartDisk = buf.readUInt16LE(eocdOffset + 6)
    const totalEntries = buf.readUInt16LE(eocdOffset + 10)
    const cdSize = buf.readUInt32LE(eocdOffset + 12)
    const cdOffset = buf.readUInt32LE(eocdOffset + 16)

    if (diskNumber !== 0 || cdStartDisk !== 0) {
      throw DocumentErrors.extractionInvalidArchive(
        'Spanned or multi-disk ZIP archives are not supported.'
      )
    }

    if (cdOffset + cdSize > eocdOffset || cdOffset + cdSize > buf.length) {
      throw DocumentErrors.extractionInvalidArchive(
        'Malformed ZIP package: Central Directory bounds exceed file size.'
      )
    }

    if (totalEntries > effectiveLimits.maxEntries) {
      throw DocumentErrors.extractionArchiveLimitExceeded(
        `Archive contains ${totalEntries} entries, exceeding maximum limit of ${effectiveLimits.maxEntries}.`
      )
    }

    // 3. Parse Central Directory entries
    let currentCdOffset = cdOffset
    let totalUncompressedSize = 0
    const seenEntryNames = new Set<string>()
    const entriesMetadata = new Map<string, DocxZipEntryMetadata>()
    const imageEntries: string[] = []

    for (let entryIdx = 0; entryIdx < totalEntries; entryIdx++) {
      if (currentCdOffset + 46 > cdOffset + cdSize) {
        throw DocumentErrors.extractionInvalidArchive(
          'Malformed Central Directory header: Unexpected truncation.'
        )
      }

      const cdSignature = buf.readUInt32LE(currentCdOffset)
      if (cdSignature !== 0x02014b50) {
        throw DocumentErrors.extractionInvalidArchive(
          `Invalid Central Directory header signature at offset ${currentCdOffset}.`
        )
      }

      const flags = buf.readUInt16LE(currentCdOffset + 8)
      const compressionMethod = buf.readUInt16LE(currentCdOffset + 10)
      const crc32 = buf.readUInt32LE(currentCdOffset + 16)
      const compressedSize = buf.readUInt32LE(currentCdOffset + 20)
      const uncompressedSize = buf.readUInt32LE(currentCdOffset + 24)
      const fileNameLength = buf.readUInt16LE(currentCdOffset + 28)
      const extraFieldLength = buf.readUInt16LE(currentCdOffset + 30)
      const commentLength = buf.readUInt16LE(currentCdOffset + 32)
      const localHeaderOffset = buf.readUInt32LE(currentCdOffset + 42)

      const isEncrypted = (flags & 0x0001) !== 0
      if (isEncrypted) {
        throw DocumentErrors.extractionEncryptedArchive(
          'Entry is encrypted in ZIP central directory.'
        )
      }

      // Method 0 = Stored, Method 8 = Deflate
      if (compressionMethod !== 0 && compressionMethod !== 8) {
        throw DocumentErrors.extractionInvalidArchive(
          `Unsupported compression method (${compressionMethod}). Only Stored (0) and Deflate (8) are supported.`
        )
      }

      // Defensive size and ratio checks
      if (uncompressedSize > effectiveLimits.maxEntryUncompressedBytes) {
        throw DocumentErrors.extractionArchiveLimitExceeded(
          `Archive entry uncompressed size of ${uncompressedSize} bytes exceeds limit of ${effectiveLimits.maxEntryUncompressedBytes} bytes.`
        )
      }

      totalUncompressedSize += uncompressedSize
      if (totalUncompressedSize > effectiveLimits.maxTotalUncompressedBytes) {
        throw DocumentErrors.extractionArchiveLimitExceeded(
          `Total uncompressed size of ${totalUncompressedSize} bytes exceeds maximum limit of ${effectiveLimits.maxTotalUncompressedBytes} bytes.`
        )
      }

      if (compressedSize > 0) {
        const ratio = uncompressedSize / compressedSize
        if (ratio > effectiveLimits.maxCompressionRatio) {
          throw DocumentErrors.extractionArchiveLimitExceeded(
            `Suspicious compression ratio (${ratio.toFixed(1)}:1) indicates potential decompression bomb.`
          )
        }
      }

      // Read filename
      const fileNameStart = currentCdOffset + 46
      if (fileNameStart + fileNameLength > buf.length) {
        throw DocumentErrors.extractionInvalidArchive('Entry filename exceeds archive bounds.')
      }
      const rawFileName = buf.toString('utf8', fileNameStart, fileNameStart + fileNameLength)

      // Path traversal security check
      const normalizedPath = rawFileName.replace(/\\/g, '/').trim()
      if (
        normalizedPath.startsWith('/') ||
        normalizedPath.includes('../') ||
        normalizedPath.includes('/..') ||
        normalizedPath === '..' ||
        normalizedPath.includes('\0') ||
        /^[a-zA-Z]:/.test(normalizedPath)
      ) {
        throw DocumentErrors.extractionInvalidArchive(
          `Malicious archive entry path detected: "${rawFileName}". Path traversal is forbidden.`
        )
      }

      if (seenEntryNames.has(normalizedPath)) {
        throw DocumentErrors.extractionInvalidArchive(
          `Duplicate entry name detected in DOCX archive: "${normalizedPath}".`
        )
      }
      seenEntryNames.add(normalizedPath)

      entriesMetadata.set(normalizedPath, {
        fileName: normalizedPath,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        crc32,
        localHeaderOffset,
        isEncrypted
      })

      if (normalizedPath.startsWith('word/media/')) {
        imageEntries.push(normalizedPath)
      }

      currentCdOffset += 46 + fileNameLength + extraFieldLength + commentLength
    }

    // 4. Verify required OpenXML package parts
    const requiredParts = ['[Content_Types].xml', 'word/document.xml']
    const missingParts = requiredParts.filter((part) => !seenEntryNames.has(part))

    if (missingParts.length > 0) {
      throw DocumentErrors.extractionMissingDocxParts(missingParts)
    }

    // 5. Reject macro-enabled documents (.docm / VBA projects)
    if (seenEntryNames.has('word/vbaProject.bin') || seenEntryNames.has('word/vbaData.xml')) {
      throw DocumentErrors.extractionMacroNotAllowed(
        'VBA macro binary part detected in DOCX archive.'
      )
    }

    // 6. Reject mismatched office formats (XLSX, PPTX)
    if (seenEntryNames.has('xl/workbook.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is an Excel spreadsheet (.xlsx), not a Word document (.docx).'
      )
    }
    if (seenEntryNames.has('ppt/presentation.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is a PowerPoint presentation (.pptx), not a Word document (.docx).'
      )
    }

    // 7. Extract and inspect critical XML entries for XXE & ContentType verification
    const contentTypesEntry = entriesMetadata.get('[Content_Types].xml')!
    const documentEntry = entriesMetadata.get('word/document.xml')!

    const contentTypesXml = this.extractEntryText(buf, contentTypesEntry)
    const documentXml = this.extractEntryText(buf, documentEntry)

    // XXE detection (check for DOCTYPE and ENTITY declarations)
    if (/<!DOCTYPE/i.test(contentTypesXml) || /<!ENTITY/i.test(contentTypesXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in [Content_Types].xml.'
      )
    }
    if (/<!DOCTYPE/i.test(documentXml) || /<!ENTITY/i.test(documentXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in word/document.xml.'
      )
    }

    // Validate WordprocessingML content type
    const isWordDocument =
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      ) ||
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
      )

    if (!isWordDocument) {
      if (contentTypesXml.includes('application/vnd.ms-word.document.macroEnabled.main+xml')) {
        throw DocumentErrors.extractionMacroNotAllowed(
          'Macro-enabled Word content type declared in [Content_Types].xml.'
        )
      }
      throw DocumentErrors.extractionInvalidArchive(
        '[Content_Types].xml does not declare a valid WordprocessingML main document part.'
      )
    }

    return {
      valid: true,
      entryCount: totalEntries,
      totalUncompressedSize,
      hasImages: imageEntries.length > 0,
      imageEntries,
      entries: Array.from(seenEntryNames)
    }
  }

  /**
   * Helper extracting the decompressed text of a critical ZIP entry in-memory.
   */
  private static extractEntryText(buf: Buffer, entry: DocxZipEntryMetadata): string {
    const localOffset = entry.localHeaderOffset
    if (localOffset + 30 > buf.length) {
      throw DocumentErrors.extractionInvalidArchive('Local file header offset exceeds buffer.')
    }

    const localSig = buf.readUInt32LE(localOffset)
    if (localSig !== 0x04034b50) {
      throw DocumentErrors.extractionInvalidArchive('Corrupted local file header signature.')
    }

    const fileNameLen = buf.readUInt16LE(localOffset + 26)
    const extraLen = buf.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + fileNameLen + extraLen

    if (dataOffset + entry.compressedSize > buf.length) {
      throw DocumentErrors.extractionInvalidArchive('Local file data exceeds buffer bounds.')
    }

    const compressedSlice = buf.subarray(dataOffset, dataOffset + entry.compressedSize)
    let decompressed: Buffer

    if (entry.compressionMethod === 0) {
      decompressed = Buffer.from(compressedSlice)
    } else if (entry.compressionMethod === 8) {
      try {
        decompressed = zlib.inflateRawSync(compressedSlice)
      } catch (inflateErr) {
        throw DocumentErrors.extractionInvalidArchive(
          `Failed to decompress entry ${entry.fileName}: ${inflateErr instanceof Error ? inflateErr.message : String(inflateErr)}`
        )
      }
    } else {
      throw DocumentErrors.extractionInvalidArchive(
        `Unsupported compression method ${entry.compressionMethod}.`
      )
    }

    // Verify CRC-32
    const actualCrc = calculateCrc32(decompressed)
    if (actualCrc !== entry.crc32) {
      throw DocumentErrors.extractionInvalidArchive(
        `CRC32 mismatch for entry ${entry.fileName} (expected ${entry.crc32}, got ${actualCrc}).`
      )
    }

    return decompressed.toString('utf8')
  }
}
