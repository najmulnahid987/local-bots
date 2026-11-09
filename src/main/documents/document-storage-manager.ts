import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { DocumentErrors } from './document-errors'
import { SUPPORTED_EXTENSIONS, type SupportedExtension } from './document-file-validator'

/**
 * Regex validating standard RFC 4122 UUIDv4 identifiers.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Interface defining pluggable filesystem operations for DocumentStorageManager.
 * Defaults to Node.js fs.promises / fs streams; facilitates fault-injection testing.
 */
export interface DocumentStorageFilesystemOperations {
  mkdir(path: string, options?: fs.MakeDirectoryOptions): Promise<string | undefined>
  rm(path: string, options?: fs.RmOptions): Promise<void>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  lstat(path: string): Promise<fs.Stats>
  stat(path: string): Promise<fs.Stats>
  access(path: string, mode?: number): Promise<void>
  realpath(path: string): Promise<string>
  createReadStream(path: string): fs.ReadStream
  createWriteStream(path: string, options?: { flags?: string; mode?: number }): fs.WriteStream
}

export const defaultStorageFilesystemOperations: DocumentStorageFilesystemOperations = {
  mkdir: (p, opts) => fs.promises.mkdir(p, opts),
  rm: (p, opts) => fs.promises.rm(p, opts),
  unlink: (p) => fs.promises.unlink(p),
  rename: (oldP, newP) => fs.promises.rename(oldP, newP),
  lstat: (p) => fs.promises.lstat(p),
  stat: (p) => fs.promises.stat(p),
  access: (p, mode) => fs.promises.access(p, mode),
  realpath: (p) => fs.promises.realpath(p),
  createReadStream: (p) => fs.createReadStream(p),
  createWriteStream: (p, opts) => fs.createWriteStream(p, opts)
}

/**
 * Options for configuring DocumentStorageManager.
 */
export interface DocumentStorageManagerOptions {
  readonly userDataPath?: string
  readonly documentsDir?: string
  readonly fsOps?: Partial<DocumentStorageFilesystemOperations>
}

/**
 * Trusted internal request to persist an original source document.
 */
export interface StoreOriginalRequest {
  readonly knowledgeBaseId: string
  readonly sourceId: string
  readonly extension: SupportedExtension
  readonly sourcePath: string
  readonly expectedSize: number
  readonly expectedHash: string
  readonly expectedMtimeMs?: number
  readonly expectedIno?: number
}

/**
 * Result emitted upon successful original document persistence.
 */
export interface StoredDocumentResult {
  readonly storagePath: string
  readonly relativeFilePath: string
  readonly fileSizeBytes: number
  readonly contentHash: string
}

/**
 * Main-process service responsible for Knowledge Base-scoped original document storage.
 *
 * Enforces:
 * 1. Physical original layout: <userData>/documents/<kbId>/originals/<sourceId>.<ext>.
 * 2. Immutable, UUID-based file naming (user filenames are never used as physical filenames).
 * 3. Strict directory boundary safety preventing path traversal and symlink escapes.
 * 4. Atomic copy-and-rename semantics on the same volume (prevents partial files).
 * 5. Pre- and post-copy TOCTOU validation (detects source modifications).
 * 6. Automatic cleanup of transient files on failure.
 */
export class DocumentStorageManager {
  private readonly documentsDir: string
  private readonly fsOps: DocumentStorageFilesystemOperations

  constructor(options: DocumentStorageManagerOptions = {}) {
    if (options.documentsDir) {
      this.documentsDir = path.resolve(options.documentsDir)
    } else if (options.userDataPath) {
      this.documentsDir = path.resolve(options.userDataPath, 'documents')
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          this.documentsDir = path.resolve(app.getPath('userData'), 'documents')
        } else {
          this.documentsDir = path.resolve(process.cwd(), 'documents')
        }
      } catch {
        this.documentsDir = path.resolve(process.cwd(), 'documents')
      }
    }

    this.fsOps = {
      ...defaultStorageFilesystemOperations,
      ...(options.fsOps ?? {})
    }
  }

  /**
   * Returns canonical root documents directory path.
   */
  public getDocumentsDirectory(): string {
    return this.documentsDir
  }

  /**
   * Validates a Knowledge Base UUID and resolves its managed directory.
   */
  public resolveKnowledgeBaseDirectory(knowledgeBaseId: string): string {
    if (!knowledgeBaseId || !UUID_V4_REGEX.test(knowledgeBaseId)) {
      throw DocumentErrors.invalidKnowledgeBaseId(knowledgeBaseId || '(none)')
    }

    const kbDir = path.resolve(this.documentsDir, knowledgeBaseId)
    const rel = path.relative(this.documentsDir, kbDir)

    if (rel !== knowledgeBaseId || rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
      throw DocumentErrors.securityError(
        `Path traversal detected for Knowledge Base ID '${knowledgeBaseId}'`
      )
    }

    return kbDir
  }

  /**
   * Validates Knowledge Base UUID and resolves its 'originals' directory.
   */
  public resolveOriginalsDirectory(knowledgeBaseId: string): string {
    const kbDir = this.resolveKnowledgeBaseDirectory(knowledgeBaseId)
    const originalsDir = path.resolve(kbDir, 'originals')
    const rel = path.relative(kbDir, originalsDir)

    if (rel !== 'originals' || rel.includes('..') || path.isAbsolute(rel)) {
      throw DocumentErrors.securityError(
        `Path traversal detected for originals directory in KB '${knowledgeBaseId}'`
      )
    }

    return originalsDir
  }

  /**
   * Validates all path components and resolves the destination path for an original document.
   */
  public resolveOriginalPath(knowledgeBaseId: string, sourceId: string, extension: string): string {
    if (!sourceId || !UUID_V4_REGEX.test(sourceId)) {
      throw DocumentErrors.invalidSourceId(sourceId || '(none)')
    }

    const normalizedExt = extension.toLowerCase().replace(/^\./, '')
    if (!SUPPORTED_EXTENSIONS.includes(normalizedExt as SupportedExtension)) {
      throw DocumentErrors.unsupportedFileType(extension)
    }

    const originalsDir = this.resolveOriginalsDirectory(knowledgeBaseId)
    const fileName = `${sourceId}.${normalizedExt}`
    const targetPath = path.resolve(originalsDir, fileName)
    const rel = path.relative(originalsDir, targetPath)

    if (rel !== fileName || rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
      throw DocumentErrors.securityError(
        `Path traversal detected for file '${fileName}' in KB '${knowledgeBaseId}'`
      )
    }

    return targetPath
  }

  /**
   * Safely ensures that the managed originals directory exists and contains no symlinks.
   */
  public async ensureOriginalsDirectory(knowledgeBaseId: string): Promise<string> {
    const originalsDir = this.resolveOriginalsDirectory(knowledgeBaseId)
    const kbDir = this.resolveKnowledgeBaseDirectory(knowledgeBaseId)

    // 1. Ensure documentsDir root
    try {
      await this.fsOps.mkdir(this.documentsDir, { recursive: true })
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'EACCES' || code === 'EPERM') {
        throw DocumentErrors.storagePermissionDenied()
      }
      throw DocumentErrors.internalStorageError(
        `Failed to create documents root: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // 2. Ensure KB dir
    await this.fsOps.mkdir(kbDir, { recursive: true })

    // 3. Ensure originals dir
    await this.fsOps.mkdir(originalsDir, { recursive: true })

    // 4. Verify no component in the path is a symbolic link
    await this.assertNotSymbolicLink(this.documentsDir, 'documents root')
    await this.assertNotSymbolicLink(kbDir, 'Knowledge Base directory')
    await this.assertNotSymbolicLink(originalsDir, 'originals directory')

    return originalsDir
  }

  /**
   * Stores a validated source document original atomically into managed storage.
   */
  public async storeOriginal(request: StoreOriginalRequest): Promise<StoredDocumentResult> {
    const {
      knowledgeBaseId,
      sourceId,
      extension,
      sourcePath,
      expectedSize,
      expectedHash,
      expectedMtimeMs
    } = request

    // 1. Validate destination path
    const finalPath = this.resolveOriginalPath(knowledgeBaseId, sourceId, extension)
    const originalsDir = await this.ensureOriginalsDirectory(knowledgeBaseId)

    // 2. Prevent overwriting existing managed target
    try {
      const existingStat = await this.fsOps.lstat(finalPath)
      if (existingStat) {
        throw DocumentErrors.duplicateStorageTarget(sourceId)
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code !== 'ENOENT') {
        throw err
      }
    }

    // 3. TOCTOU Pre-Copy Validation: Verify source file identity and size
    let sourceStat: fs.Stats
    try {
      sourceStat = await this.fsOps.lstat(sourcePath)
    } catch {
      throw DocumentErrors.fileNotFound()
    }

    if (sourceStat.isSymbolicLink()) {
      throw DocumentErrors.symlinkNotAllowed()
    }

    if (!sourceStat.isFile()) {
      throw DocumentErrors.invalidFileType()
    }

    if (sourceStat.size !== expectedSize) {
      throw DocumentErrors.fileChangedDuringImport()
    }

    if (expectedMtimeMs !== undefined && Math.abs(sourceStat.mtimeMs - expectedMtimeMs) > 10) {
      throw DocumentErrors.fileChangedDuringImport()
    }

    // 4. Create Unique Temporary File on the Same Volume
    const tempFileName = `.${sourceId}.${crypto.randomUUID()}.tmp`
    const tempPath = path.resolve(originalsDir, tempFileName)

    let tempFileCreated = false

    try {
      // 5. Streaming Copy with Checksum & Size Calculation
      const { bytesWritten, contentHash } = await this.streamCopyAndHash(sourcePath, tempPath)
      tempFileCreated = true

      // 6. Post-Copy Verification
      if (bytesWritten !== expectedSize || contentHash !== expectedHash) {
        throw DocumentErrors.fileChangedDuringImport()
      }

      // 7. Atomic Rename to Final Filename
      await this.fsOps.rename(tempPath, finalPath)
      tempFileCreated = false

      // 8. Return relative path formatted with standard forward slash
      const relativeFilePath = `originals/${sourceId}.${extension}`

      return {
        storagePath: finalPath,
        relativeFilePath,
        fileSizeBytes: bytesWritten,
        contentHash
      }
    } catch (err) {
      // Clean up temporary file on failure
      if (tempFileCreated) {
        try {
          await this.fsOps.unlink(tempPath)
        } catch (cleanupErr: unknown) {
          const code = (cleanupErr as { code?: string })?.code
          if (code !== 'ENOENT') {
            throw DocumentErrors.storageCleanupFailed(cleanupErr)
          }
        }
      }
      throw err
    }
  }

  /**
   * Removes an existing original document file.
   * Returns true if deleted, false if file did not exist.
   */
  public async removeOriginal(
    knowledgeBaseId: string,
    sourceId: string,
    extension: string
  ): Promise<boolean> {
    const targetPath = this.resolveOriginalPath(knowledgeBaseId, sourceId, extension)

    try {
      const stat = await this.fsOps.lstat(targetPath)
      if (stat.isSymbolicLink()) {
        throw DocumentErrors.securityError('Cannot remove symbolic link in storage')
      }
      await this.fsOps.unlink(targetPath)
      return true
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'ENOENT') {
        return false
      }
      throw DocumentErrors.internalStorageError(
        `Failed to delete original: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Safely deletes a temporary file, ignoring ENOENT.
   */
  public async removeTemporaryFile(tempPath: string): Promise<void> {
    try {
      await this.fsOps.unlink(tempPath)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code !== 'ENOENT') {
        throw DocumentErrors.storageCleanupFailed(err)
      }
    }
  }

  /**
   * Verifies a directory path is not a symbolic link.
   */
  private async assertNotSymbolicLink(targetPath: string, label: string): Promise<void> {
    try {
      const stat = await this.fsOps.lstat(targetPath)
      if (stat.isSymbolicLink()) {
        throw DocumentErrors.securityError(
          `${label} is a symbolic link, which is strictly prohibited.`
        )
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'ENOENT') {
        return
      }
      throw err
    }
  }

  /**
   * Stream file from source to destination temporary file while calculating hash and byte count.
   */
  private async streamCopyAndHash(
    sourcePath: string,
    tempPath: string
  ): Promise<{ bytesWritten: number; contentHash: string }> {
    const readStream = this.fsOps.createReadStream(sourcePath)
    // Use wx flag for exclusive creation to ensure temporary file does not overwrite existing file
    const writeStream = this.fsOps.createWriteStream(tempPath, { flags: 'wx' })
    const hash = crypto.createHash('sha256')

    let bytesWritten = 0

    readStream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesWritten += buffer.length
      hash.update(buffer)
    })

    try {
      await pipeline(readStream, writeStream)
      const contentHash = hash.digest('hex').toLowerCase()
      return { bytesWritten, contentHash }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'EACCES' || code === 'EPERM') {
        throw DocumentErrors.storagePermissionDenied()
      }
      throw err
    }
  }
}
