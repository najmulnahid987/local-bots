import zlib from 'node:zlib'
import { calculateCrc32 } from '../../../services/zip-archive'
import { DocumentErrors } from '../../document-errors'

/**
 * Defensive limits applied to PPTX ZIP packages to prevent denial-of-service,
 * decompression bombs, memory exhaustion, and archive directory floods.
 */
export interface PptxArchiveLimits {
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
   * Maximum permitted number of slides in a single presentation (default: 250).
   */
  readonly maxSlides?: number
}

export const DEFAULT_PPTX_ARCHIVE_LIMITS: Required<PptxArchiveLimits> = {
  maxCompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxEntries: 1000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024, // 50 MiB
  maxEntryUncompressedBytes: 20 * 1024 * 1024, // 20 MiB
  maxCompressionRatio: 100,
  maxSlides: 250
} as const

/**
 * Parsed metadata for a single entry in a PPTX ZIP central directory.
 */
export interface PptxZipEntryMetadata {
  readonly fileName: string
  readonly compressionMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly crc32: number
  readonly localHeaderOffset: number
  readonly isEncrypted: boolean
}

/**
 * Result emitted by PptxArchiveValidator upon successful preflight audit.
 */
export interface PptxArchiveValidationResult {
  readonly valid: true
  readonly entryCount: number
  readonly totalUncompressedSize: number
  readonly slideCount: number
  readonly slideEntries: readonly string[]
  readonly entries: readonly string[]
  readonly hasMedia: boolean
  readonly mediaEntries: readonly string[]
  readonly entriesMetadata: ReadonlyMap<string, PptxZipEntryMetadata>
}

/**
 * Access interface for reading verified, safe OpenXML PPTX package parts.
 */
export interface PptxPackage {
  readonly validationResult: PptxArchiveValidationResult
  getEntryText(entryPath: string): string | null
  getEntryBuffer(entryPath: string): Buffer | null
  hasEntry(entryPath: string): boolean
  getEntries(): readonly string[]
}

/**
 * PptxArchiveValidator performs exhaustive, zero-dependency, memory-bounded
 * preflight validation of Microsoft PowerPoint (.pptx) OpenXML ZIP packages.
 *
 * Enforces:
 * 1. Strict ZIP header and central directory boundary validation.
 * 2. Rejection of legacy binary (.ppt) presentations.
 * 3. Rejection of encrypted, password-protected archives.
 * 4. Rejection of macro-enabled files (.pptm, vbaProject.bin, vbaData.xml).
 * 5. Rejection of other Office types (DOCX, XLSX) disguised with .pptx extensions.
 * 6. Decompression bomb (Zip bomb) prevention via ratio and size caps.
 * 7. Protection against XML External Entity (XXE) and billion-laughs expansions in XML parts.
 * 8. Path traversal prevention (disallows '..', leading slashes, drive letters, NUL bytes).
 * 9. Structural verification of OpenXML PresentationML package parts.
 */
export class PptxArchiveValidator {
  /**
   * Validates a candidate PPTX buffer against all defensive rules.
   * Throws DocumentExtractionError on any violation.
   */
  public static validate(
    bytes: Uint8Array | Buffer,
    limits?: PptxArchiveLimits
  ): PptxArchiveValidationResult {
    return this.openPackage(bytes, limits).validationResult
  }

  /**
   * Validates a candidate PPTX buffer and returns a PptxPackage instance
   * providing secure, bounds-checked entry extraction.
   */
  public static openPackage(bytes: Uint8Array | Buffer, limits?: PptxArchiveLimits): PptxPackage {
    const effectiveLimits: Required<PptxArchiveLimits> = {
      maxCompressedBytes:
        limits?.maxCompressedBytes ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxCompressedBytes,
      maxEntries: limits?.maxEntries ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxEntries,
      maxTotalUncompressedBytes:
        limits?.maxTotalUncompressedBytes ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
      maxEntryUncompressedBytes:
        limits?.maxEntryUncompressedBytes ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxEntryUncompressedBytes,
      maxCompressionRatio:
        limits?.maxCompressionRatio ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxCompressionRatio,
      maxSlides: limits?.maxSlides ?? DEFAULT_PPTX_ARCHIVE_LIMITS.maxSlides
    }

    if (!bytes || bytes.length === 0) {
      throw DocumentErrors.extractionEmptyContent('The document content is empty.')
    }

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

    // Check size limit
    if (buf.length > effectiveLimits.maxCompressedBytes) {
      throw DocumentErrors.fileTooLarge(effectiveLimits.maxCompressedBytes)
    }

    // 1. Check for legacy OLE2 compound binary (.ppt) header (0xD0CF11E0A1B11AE1)
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
        'Legacy binary PowerPoint (.ppt) files are not supported. Only OpenXML (.pptx) presentations are supported.'
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
    const entriesMetadata = new Map<string, PptxZipEntryMetadata>()
    const slideEntries: string[] = []
    const mediaEntries: string[] = []

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
          `Duplicate entry name detected in PPTX archive: "${normalizedPath}".`
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

      // Collect slide entries (e.g. ppt/slides/slide1.xml)
      if (normalizedPath.startsWith('ppt/slides/') && normalizedPath.endsWith('.xml')) {
        slideEntries.push(normalizedPath)
      }

      // Collect media entries (e.g. ppt/media/image1.png)
      if (normalizedPath.startsWith('ppt/media/')) {
        mediaEntries.push(normalizedPath)
      }

      currentCdOffset += 46 + fileNameLength + extraFieldLength + commentLength
    }

    // 5. Reject macro-enabled documents (.pptm / VBA projects)
    if (
      seenEntryNames.has('ppt/vbaProject.bin') ||
      seenEntryNames.has('vbaProject.bin') ||
      seenEntryNames.has('ppt/vbaData.xml') ||
      seenEntryNames.has('word/vbaProject.bin') ||
      seenEntryNames.has('xl/vbaProject.bin')
    ) {
      throw DocumentErrors.extractionMacroNotAllowed(
        'VBA macro binary part detected in PPTX archive.'
      )
    }

    // 6. Reject mismatched office formats (DOCX, XLSX)
    if (seenEntryNames.has('word/document.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is a Word document (.docx), not a PowerPoint presentation (.pptx).'
      )
    }
    if (seenEntryNames.has('xl/workbook.xml')) {
      throw DocumentErrors.extractionInvalidArchive(
        'Archive is an Excel spreadsheet (.xlsx), not a PowerPoint presentation (.pptx).'
      )
    }

    // 7. Verify required OpenXML package parts
    const requiredParts = ['[Content_Types].xml', 'ppt/presentation.xml']
    const missingParts = requiredParts.filter((part) => !seenEntryNames.has(part))

    if (missingParts.length > 0) {
      throw DocumentErrors.extractionMissingPptxParts(missingParts)
    }

    // Must have at least one slide part
    if (slideEntries.length === 0) {
      throw DocumentErrors.extractionMissingPptxParts(['ppt/slides/slide*.xml'])
    }

    // Validate slide count limit
    if (slideEntries.length > effectiveLimits.maxSlides) {
      throw DocumentErrors.extractionArchiveLimitExceeded(
        `Presentation contains ${slideEntries.length} slides, exceeding maximum limit of ${effectiveLimits.maxSlides}.`
      )
    }

    // 8. Extract and inspect critical XML entries for XXE & ContentType verification
    const contentTypesEntry = entriesMetadata.get('[Content_Types].xml')!
    const presentationEntry = entriesMetadata.get('ppt/presentation.xml')!

    const contentTypesXml = this.extractEntryText(buf, contentTypesEntry)
    const presentationXml = this.extractEntryText(buf, presentationEntry)

    // XXE detection (check for DOCTYPE and ENTITY declarations)
    if (/<!DOCTYPE/i.test(contentTypesXml) || /<!ENTITY/i.test(contentTypesXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in [Content_Types].xml.'
      )
    }
    if (/<!DOCTYPE/i.test(presentationXml) || /<!ENTITY/i.test(presentationXml)) {
      throw DocumentErrors.extractionXxeDetected(
        'External entity or DOCTYPE detected in ppt/presentation.xml.'
      )
    }

    // Also inspect presentation relationships if present
    const relsEntry = entriesMetadata.get('ppt/_rels/presentation.xml.rels')
    if (relsEntry) {
      const relsXml = this.extractEntryText(buf, relsEntry)
      if (/<!DOCTYPE/i.test(relsXml) || /<!ENTITY/i.test(relsXml)) {
        throw DocumentErrors.extractionXxeDetected(
          'External entity or DOCTYPE detected in ppt/_rels/presentation.xml.rels.'
        )
      }
      // Check for external target modes with dangerous targets
      if (/TargetMode\s*=\s*["']External["']/i.test(relsXml)) {
        // Disallow dangerous or local filesystem references in external targets
        if (/Target\s*=\s*["'](file:|javascript:|data:|cmd:|powershell:|sh:)/i.test(relsXml)) {
          throw DocumentErrors.extractionInvalidArchive(
            'Forbidden external relationship target detected in presentation.xml.rels.'
          )
        }
      }
    }

    // Also inspect slide XMLs for XXE (up to first 15 slides)
    const slidesToCheck = slideEntries.slice(0, 15)
    for (const slideEntryName of slidesToCheck) {
      const entry = entriesMetadata.get(slideEntryName)
      if (entry) {
        const slideXml = this.extractEntryText(buf, entry)
        if (/<!DOCTYPE/i.test(slideXml) || /<!ENTITY/i.test(slideXml)) {
          throw DocumentErrors.extractionXxeDetected(
            `External entity or DOCTYPE detected in ${slideEntryName}.`
          )
        }
      }
    }

    // 9. Validate PresentationML content type in [Content_Types].xml
    const isPresentationDocument =
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
      ) ||
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'
      ) ||
      contentTypesXml.includes(
        'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'
      )

    if (!isPresentationDocument) {
      if (
        contentTypesXml.includes(
          'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'
        ) ||
        contentTypesXml.includes('application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml') ||
        contentTypesXml.includes('application/vnd.ms-powerpoint.template.macroEnabled.main+xml')
      ) {
        throw DocumentErrors.extractionMacroNotAllowed(
          'Macro-enabled PowerPoint content type declared in [Content_Types].xml.'
        )
      }
      throw DocumentErrors.extractionInvalidArchive(
        '[Content_Types].xml does not declare a valid PresentationML main document part.'
      )
    }

    const validationResult: PptxArchiveValidationResult = {
      valid: true,
      entryCount: totalEntries,
      totalUncompressedSize,
      slideCount: slideEntries.length,
      slideEntries,
      entries: Array.from(seenEntryNames),
      hasMedia: mediaEntries.length > 0,
      mediaEntries,
      entriesMetadata
    }

    return new PptxPackageImpl(buf, entriesMetadata, validationResult)
  }

  /**
   * Helper extracting the decompressed text of an entry in-memory with strict CRC32 validation.
   */
  public static extractEntryText(buf: Buffer, entry: PptxZipEntryMetadata): string {
    const decompressed = this.extractEntryBuffer(buf, entry)
    return decompressed.toString('utf8')
  }

  /**
   * Helper extracting the decompressed binary Buffer of an entry in-memory with strict CRC32 validation.
   */
  public static extractEntryBuffer(buf: Buffer, entry: PptxZipEntryMetadata): Buffer {
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
}

/**
 * Concrete implementation of PptxPackage providing safe, bounded access to ZIP parts.
 */
class PptxPackageImpl implements PptxPackage {
  constructor(
    private readonly buf: Buffer,
    private readonly entriesMetadata: Map<string, PptxZipEntryMetadata>,
    public readonly validationResult: PptxArchiveValidationResult
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
    return PptxArchiveValidator.extractEntryBuffer(this.buf, entry)
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
