import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DocumentErrors } from './document-errors'
import { DocxArchiveValidator } from './extraction/docx/docx-archive-validator'
import { XlsxArchiveValidator } from './extraction/xlsx/xlsx-archive-validator'
import { PptxArchiveValidator } from './extraction/pptx/pptx-archive-validator'
import {
  type DocumentSettingsProvider,
  StaticDocumentSettingsProvider,
  type DocumentProcessingSettings
} from './document-settings'

/**
 * Approved document file extensions (without leading dot).
 */
export const SUPPORTED_EXTENSIONS = ['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx', 'csv'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/**
 * Canonical application-controlled MIME type mappings.
 */
export const SUPPORTED_MIME_TYPES: Record<SupportedExtension, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv'
} as const

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[SupportedExtension]

/**
 * File metadata captured during initial stat for TOCTOU verification.
 */
export interface SourceFileMetadata {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Strongly typed result emitted by DocumentFileValidator upon successful validation.
 */
export interface DocumentValidationResult {
  readonly originalFileName: string
  readonly extension: SupportedExtension
  readonly fileType: SupportedExtension
  readonly mimeType: SupportedMimeType
  readonly fileSizeBytes: number
  readonly contentHash: string
  readonly sourcePath: string
  readonly sourceMetadata: SourceFileMetadata
}

/**
 * Validates whether a character code represents a disallowed binary control character.
 * Disallowed: 0x00 (NUL), 0x01-0x08, 0x0B (VT), 0x0C (FF), 0x0E-0x1F, 0x7F (DEL).
 * Allowed whitespace: 0x09 (TAB), 0x0A (LF), 0x0D (CR).
 */
export function isDisallowedControlCharacter(byte: number): boolean {
  if (byte === 0x00) return true
  if (byte >= 0x01 && byte <= 0x08) return true
  if (byte === 0x0b || byte === 0x0c) return true
  if (byte >= 0x0e && byte <= 0x1f) return true
  if (byte === 0x7f) return true
  return false
}

/**
 * Defensive validator for candidate knowledge document files.
 *
 * Enforces:
 * 1. Allowlisted extensions only (.txt, .md, .pdf) - case-insensitive.
 * 2. Regular filesystem objects only - rejects symlinks, directories, sockets, devices.
 * 3. File size limits - rejects 0-byte files and files exceeding document.maxFileSizeBytes.
 * 4. Magic byte verification - PDF files must start with %PDF-.
 * 5. UTF-8 & control character validation - TXT and Markdown files must be valid UTF-8 without binary control bytes.
 * 6. Streaming SHA-256 calculation with concurrent byte-count integrity check.
 */
export class DocumentFileValidator {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  /**
   * Returns current active document processing settings.
   */
  public getSettings(): DocumentProcessingSettings {
    return this.settingsProvider.getSettings()
  }

  /**
   * Validates a candidate source file against all defensive criteria.
   * Throws DocumentValidationError or DocumentError on any violation.
   */
  public async validate(sourcePath: string): Promise<DocumentValidationResult> {
    if (!sourcePath || typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
      throw DocumentErrors.fileNotFound()
    }

    const resolvedPath = path.resolve(sourcePath)
    const originalFileName = path.basename(resolvedPath)
    const rawExt = path.extname(originalFileName).toLowerCase()

    // 1. Extension Allowlist Check
    if (
      rawExt !== '.txt' &&
      rawExt !== '.md' &&
      rawExt !== '.pdf' &&
      rawExt !== '.docx' &&
      rawExt !== '.xlsx' &&
      rawExt !== '.pptx' &&
      rawExt !== '.csv'
    ) {
      throw DocumentErrors.unsupportedFileType(rawExt || '(none)')
    }

    const extension: SupportedExtension = rawExt.slice(1) as SupportedExtension

    // 2. Filesystem Metadata & Symlink Check via lstat
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(resolvedPath)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'ENOENT') {
        throw DocumentErrors.fileNotFound()
      }
      throw DocumentErrors.fileNotFound()
    }

    if (stat.isSymbolicLink()) {
      throw DocumentErrors.symlinkNotAllowed()
    }

    if (!stat.isFile()) {
      throw DocumentErrors.invalidFileType()
    }

    // 3. File Size Checks
    if (stat.size === 0) {
      throw DocumentErrors.fileEmpty()
    }

    const settings = this.getSettings()
    if (stat.size > settings.maxFileSizeBytes) {
      throw DocumentErrors.fileTooLarge(settings.maxFileSizeBytes)
    }

    // 4. Format-Specific Signature & Content Validation
    if (extension === 'pdf') {
      await this.validatePdfHeader(resolvedPath)
    } else if (extension === 'docx') {
      await this.validateDocxArchive(resolvedPath)
    } else if (extension === 'xlsx') {
      await this.validateXlsxArchive(resolvedPath)
    } else if (extension === 'pptx') {
      await this.validatePptxArchive(resolvedPath)
    }

    // 5. Streaming Checksum Calculation & Content Integrity Check
    const { contentHash, bytesRead } = await this.streamAndValidateContent(
      resolvedPath,
      extension,
      stat.size
    )

    if (bytesRead !== stat.size) {
      throw DocumentErrors.fileChangedDuringImport()
    }

    return {
      originalFileName,
      extension,
      fileType: extension,
      mimeType: SUPPORTED_MIME_TYPES[extension],
      fileSizeBytes: stat.size,
      contentHash,
      sourcePath: resolvedPath,
      sourceMetadata: {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
    }
  }

  /**
   * Verifies the initial 5 bytes of a PDF file match the %PDF- signature.
   */
  private async validatePdfHeader(filePath: string): Promise<void> {
    let handle: fs.promises.FileHandle | null = null
    try {
      handle = await fs.promises.open(filePath, 'r')
      const buffer = Buffer.alloc(5)
      const { bytesRead } = await handle.read(buffer, 0, 5, 0)

      if (bytesRead < 5 || buffer.toString('ascii') !== '%PDF-') {
        throw DocumentErrors.invalidPdfSignature()
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'INVALID_PDF_SIGNATURE') {
        throw err
      }
      throw DocumentErrors.invalidPdfSignature()
    } finally {
      if (handle) {
        await handle.close()
      }
    }
  }

  /**
   * Validates a candidate DOCX archive package against defensive preflight rules.
   */
  private async validateDocxArchive(filePath: string): Promise<void> {
    const buffer = await fs.promises.readFile(filePath)
    const settings = this.getSettings()
    DocxArchiveValidator.validate(buffer, {
      maxCompressedBytes: settings.maxFileSizeBytes
    })
  }

  /**
   * Validates a candidate XLSX archive package against defensive preflight rules.
   */
  private async validateXlsxArchive(filePath: string): Promise<void> {
    const buffer = await fs.promises.readFile(filePath)
    const settings = this.getSettings()
    XlsxArchiveValidator.validate(buffer, {
      maxCompressedBytes: settings.maxFileSizeBytes
    })
  }

  /**
   * Validates a candidate PPTX archive package against defensive preflight rules.
   */
  private async validatePptxArchive(filePath: string): Promise<void> {
    const buffer = await fs.promises.readFile(filePath)
    const settings = this.getSettings()
    PptxArchiveValidator.validate(buffer, {
      maxCompressedBytes: settings.maxFileSizeBytes
    })
  }

  /**
   * Streams file bytes to compute SHA-256 while simultaneously validating UTF-8 and control bytes for text.
   */
  private async streamAndValidateContent(
    filePath: string,
    extension: SupportedExtension,
    expectedSize: number
  ): Promise<{ contentHash: string; bytesRead: number }> {
    const isText = extension === 'txt' || extension === 'md' || extension === 'csv'
    const hash = crypto.createHash('sha256')
    const utf8Decoder = isText ? new TextDecoder('utf-8', { fatal: true }) : null

    let totalBytesRead = 0
    let isUtf16Le = false
    let isUtf16Be = false
    let checkedBom = false

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath)

      readStream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytesRead += buffer.length

        // Fail fast if file expanded beyond expected size or max limit
        if (totalBytesRead > expectedSize) {
          readStream.destroy()
          reject(DocumentErrors.fileChangedDuringImport())
          return
        }

        // BOM inspection on first chunk for CSV/text
        if (isText && !checkedBom) {
          checkedBom = true
          if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
            isUtf16Le = true
          } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
            isUtf16Be = true
          }
        }

        // Validate text content
        if (isText && !isUtf16Le && !isUtf16Be && utf8Decoder) {
          // Check for forbidden control characters in raw bytes (skip UTF-8 BOM 0xEF 0xBB 0xBF if at index 0)
          const startIdx =
            totalBytesRead === buffer.length &&
            buffer.length >= 3 &&
            buffer[0] === 0xef &&
            buffer[1] === 0xbb &&
            buffer[2] === 0xbf
              ? 3
              : 0
          for (let i = startIdx; i < buffer.length; i++) {
            if (isDisallowedControlCharacter(buffer[i])) {
              readStream.destroy()
              reject(DocumentErrors.invalidUtf8())
              return
            }
          }

          // Validate UTF-8 byte sequences
          try {
            utf8Decoder.decode(buffer, { stream: true })
          } catch {
            readStream.destroy()
            reject(DocumentErrors.invalidUtf8())
            return
          }
        }

        hash.update(buffer)
      })

      readStream.on('end', () => {
        // Flush any remaining UTF-8 bytes at EOF
        if (isText && !isUtf16Le && !isUtf16Be && utf8Decoder) {
          try {
            utf8Decoder.decode()
          } catch {
            reject(DocumentErrors.invalidUtf8())
            return
          }
        }

        const contentHash = hash.digest('hex').toLowerCase()
        resolve({ contentHash, bytesRead: totalBytesRead })
      })

      readStream.on('error', (err) => {
        reject(err)
      })
    })
  }
}
