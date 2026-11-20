import zlib from 'node:zlib'
import { calculateCrc32 } from '../../../services/zip-archive'
import { DocumentErrors } from '../../document-errors'

/**
 * Defensive limits applied to XLSX ZIP packages to prevent denial-of-service,
 * decompression bombs, memory exhaustion, and archive directory floods.
 */
export interface XlsxArchiveLimits {
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

  /**
   * Maximum permitted number of worksheets in a single workbook (default: 50).
   */
  readonly maxSheets?: number
}

export const DEFAULT_XLSX_ARCHIVE_LIMITS: Required<XlsxArchiveLimits> = {
  maxCompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxEntries: 1000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024, // 50 MiB
  maxEntryUncompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxCompressionRatio: 100,
  maxSheets: 50
} as const

/**
 * Parsed metadata for a single entry in an XLSX ZIP central directory.
 */
export interface XlsxZipEntryMetadata {
  readonly fileName: string
  readonly compressionMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly crc32: number
  readonly localHeaderOffset: number
  readonly isEncrypted: boolean
}

/**
 * Result emitted by XlsxArchiveValidator upon successful preflight audit.
 */
export interface XlsxArchiveValidationResult {
  readonly valid: true
  readonly entryCount: number
  readonly totalUncompressedSize: number
  readonly sheetCount: number
  readonly sheetEntries: readonly string[]
  readonly entries: readonly string[]
}

/**
 * Handle providing safe, verified access to XLSX archive package parts.
 */
export interface XlsxPackage {
  readonly validationResult: XlsxArchiveValidationResult
  hasEntry(entryPath: string): boolean
  getEntries(): readonly string[]
  getEntryBuffer(entryPath: string): Buffer | null
  getEntryText(entryPath: string): string | null
}

/**
 * XlsxArchiveValidator performs exhaustive, zero-dependency, memory-bounded
 * preflight validation of Microsoft Excel (.xlsx) OpenXML ZIP packages.
 *
 * Enforces:
 * 1. Strict ZIP header and central directory boundary validation.
 * 2. Rejection of legacy binary (.xls) and Excel binary (.xlsb) workbooks.
 * 3. Rejection of encrypted, password-protected archives.
 * 4. Rejection of macro-enabled files (.xlsm, vbaProject.bin, vbaData.xml).
 * 5. Rejection of other Office types (DOCX, PPTX) disguised with .xlsx extensions.
 * 6. Decompression bomb (Zip bomb) prevention via ratio and size caps.
 * 7. Protection against XML External Entity (XXE) and billion-laughs expansions in XML parts.
 * 8. Path traversal prevention (disallows '..', leading slashes, drive letters, NUL bytes).
 * 9. Structural verification of OpenXML SpreadsheetML package parts.
 */
export class XlsxArchiveValidator {
  /**
   * Validates a candidate XLSX buffer against all defensive rules.
   * Throws DocumentExtractionError on any violation.
   */
  public static validate(
    bytes: Uint8Array | Buffer,
    limits?: XlsxArchiveLimits
  ): XlsxArchiveValidationResult {
    return this.openPackage(bytes, limits).validationResult
  }

  /**
   * Validates a candidate XLSX buffer and returns an XlsxPackage instance
   * providing secure, bounds-checked entry extraction.
   */
  public static openPackage(bytes: Uint8Array | Buffer, limits?: XlsxArchiveLimits): XlsxPackage {
    const effectiveLimits: Required<XlsxArchiveLimits> = {
      maxCompressedBytes:
        limits?.maxCompressedBytes ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxCompressedBytes,
      maxEntries: limits?.maxEntries ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxEntries,
      maxTotalUncompressedBytes:
        limits?.maxTotalUncompressedBytes ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
      maxEntryUncompressedBytes:
        limits?.maxEntryUncompressedBytes ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxEntryUncompressedBytes,
      maxCompressionRatio:
        limits?.maxCompressionRatio ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxCompressionRatio,
      maxSheets: limits?.maxSheets ?? DEFAULT_XLSX_ARCHIVE_LIMITS.maxSheets
    }

    if (!bytes || bytes.length === 0) {
      throw DocumentErrors.extractionEmptyContent('The document content is empty.')
    }

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

    // Check size limit
    if (buf.length > effectiveLimits.maxCompressedBytes) {
      throw DocumentErrors.fileTooLarge(effectiveLimits.maxCompressedBytes)
    }

    // 1. Check for legacy OLE2 compound binary (.xls) header (0xD0CF11E0A1B11AE1)
    if (
      buf.length >= 8 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0 &&
      buf[4] === 0xa1 &&
      buf[5] === 0xb1 &&
      buf[6] === 0x1a &&
      buf[7] === 0xe1
    ) {
      throw DocumentErrors.extractionInvalidArchive(
        'Legacy binary Excel (.xls) files are not supported. Only OpenXML (.xlsx) workbooks are supported.'
      )
    }

    // 2. Verify ZIP local file header magic bytes (0x04034b50 -> 'PK\x03\x04')
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
      throw DocumentErrors.extractionInvalidArchive(
        'File does not start with standard PKZIP signature.'
      )
    }

    // 3. Locate End of Central Directory (EOCD) signature (0x06054b50)
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

    // 4. Parse Central Directory entries
    let currentCdOffset = cdOffset
    let totalUncompressedSize = 0
    const seenEntryNames = new Set<string>()
    const entriesMetadata = new Map<string, XlsxZipEntryMetadata>()
    const sheetEntries: string[] = []

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
          `Duplicate entry name detected in XLSX archive: "${normalizedPath}".`
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

      // Collect worksheet entries
      if (normalizedPath.startsWith('xl/worksheets/') && normalizedPath.endsWith('.xml')) {
        sheetEntries.push(normalizedPath)
      }

      currentCdOffset += 46 + fileNameLength + extraFieldLength + commentLength
    }

    // 5. Reject macro-enabled documents (.xlsm / VBA projects)
    if (
      seenEntryNames.has('xl/vbaProject.bin') ||
      seenEntryNames.has('xl/vbaData.xml') ||
      seenEntryNames.has('word/vbaProject.bin')
    ) {
      throw DocumentErrors.extractionMacroNotAllowed(
        'VBA macro binary part detected in XLSX archive.'
      )
    }

    // 6. Reject mismatched office formats (DOCX, PPTX, XLSB)
    if (seenEntryNames.has('word/document.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is a Word document (.docx), not an Excel spreadsheet (.xlsx).'
      )
    }
    if (seenEntryNames.has('ppt/presentation.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is a PowerPoint presentation (.pptx), not an Excel spreadsheet (.xlsx).'
      )
    }
    if (seenEntryNames.has('xl/workbook.bin')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is a binary Excel workbook (.xlsb), not an OpenXML spreadsheet (.xlsx).'
      )
    }

    // 7. Verify required OpenXML package parts
    const requiredParts = ['[Content_Types].xml', 'xl/workbook.xml']
    const missingParts = requiredParts.filter((part) => !seenEntryNames.has(part))

    if (missingParts.length > 0) {
      throw DocumentErrors.extractionMissingXlsxParts(missingParts)
    }

    // Must have at least one worksheet part
    if (sheetEntries.length === 0) {
      throw DocumentErrors.extractionMissingXlsxParts(['xl/worksheets/sheet*.xml'])
    }

    // Validate worksheet count limit
    if (sheetEntries.length > effectiveLimits.maxSheets) {
      throw DocumentErrors.extractionArchiveLimitExceeded(
        `Workbook contains ${sheetEntries.length} worksheets, exceeding maximum limit of ${effectiveLimits.maxSheets}.`
      )
    }

    // 8. Extract and inspect critical XML entries for XXE & ContentType verification
    const contentTypesEntry = entriesMetadata.get('[Content_Types].xml')!
    const workbookEntry = entriesMetadata.get('xl/workbook.xml')!

    const contentTypesXml = this.extractEntryText(buf, contentTypesEntry)
    const workbookXml = this.extractEntryText(buf, workbookEntry)

    // XXE detection (check for DOCTYPE and ENTITY declarations)
    if (/<!DOCTYPE/i.test(contentTypesXml) || /<!ENTITY/i.test(contentTypesXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in [Content_Types].xml.'
      )
    }
    if (/<!DOCTYPE/i.test(workbookXml) || /<!ENTITY/i.test(workbookXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in xl/workbook.xml.'
      )
    }

    // Also inspect worksheet XMLs for XXE (up to first 10 sheets)
    const sheetsToCheck = sheetEntries.slice(0, 10)
    for (const sheetEntryName of sheetsToCheck) {
      const entry = entriesMetadata.get(sheetEntryName)
      if (entry) {
        const sheetXml = this.extractEntryText(buf, entry)
        if (/<!DOCTYPE/i.test(sheetXml) || /<!ENTITY/i.test(sheetXml)) {
          throw DocumentErrors.extractionXxeDetected(
            `External entity or DOCTYPE detected in ${sheetEntryName}.`
          )
        }
      }
    }

    // 9. Validate SpreadsheetML content type in [Content_Types].xml
    const isSpreadsheetDocument =
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
      ) ||
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'
      )

    if (!isSpreadsheetDocument) {
      if (
        contentTypesXml.includes('application/vnd.ms-excel.sheet.macroEnabled.main+xml') ||
        contentTypesXml.includes('application/vnd.ms-excel.template.macroEnabled.main+xml')
      ) {
        throw DocumentErrors.extractionMacroNotAllowed(
          'Macro-enabled Excel content type declared in [Content_Types].xml.'
        )
      }
      throw DocumentErrors.extractionInvalidArchive(
        '[Content_Types].xml does not declare a valid SpreadsheetML main document part.'
      )
    }

    const validationResult: XlsxArchiveValidationResult = {
      valid: true,
      entryCount: totalEntries,
      totalUncompressedSize,
      sheetCount: sheetEntries.length,
      sheetEntries,
      entries: Array.from(seenEntryNames)
    }

    return new XlsxPackageImpl(buf, entriesMetadata, validationResult)
  }

  /**
   * Helper extracting the decompressed buffer of a ZIP entry in-memory.
   */
  public static extractEntryBuffer(buf: Buffer, entry: XlsxZipEntryMetadata): Buffer {
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

    return decompressed
  }

  /**
   * Helper extracting the decompressed text of a critical ZIP entry in-memory.
   */
  private static extractEntryText(buf: Buffer, entry: XlsxZipEntryMetadata): string {
    return this.extractEntryBuffer(buf, entry).toString('utf8')
  }
}

/**
 * Concrete implementation of XlsxPackage providing safe, bounded access to ZIP parts.
 */
class XlsxPackageImpl implements XlsxPackage {
  constructor(
    private readonly buf: Buffer,
    private readonly entriesMetadata: Map<string, XlsxZipEntryMetadata>,
    public readonly validationResult: XlsxArchiveValidationResult
  ) {}

  public hasEntry(entryPath: string): boolean {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\//, '').trim()
    return this.entriesMetadata.has(normalized)
  }

  public getEntries(): readonly string[] {
    return Array.from(this.entriesMetadata.keys())
  }

  public getEntryBuffer(entryPath: string): Buffer | null {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\//, '').trim()
    const entry = this.entriesMetadata.get(normalized)
    if (!entry) return null
    return XlsxArchiveValidator.extractEntryBuffer(this.buf, entry)
  }

  public getEntryText(entryPath: string): string | null {
    const decompressed = this.getEntryBuffer(entryPath)
    if (!decompressed) return null
    const text = decompressed.toString('utf8')
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\//, '').trim()
    if (normalized.endsWith('.xml') || normalized.endsWith('.rels')) {
      if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
        throw DocumentErrors.extractionXxeDetected(
          `External entity or DOCTYPE detected in ${normalized}.`
        )
      }
    }
    return text
  }
}
