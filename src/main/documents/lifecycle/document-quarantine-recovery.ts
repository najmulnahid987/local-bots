import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeSourceRepository } from '../../database/repositories/knowledge-source-repository'
import type { DocumentStorageManager } from '../document-storage-manager'
import { SUPPORTED_EXTENSIONS, type SupportedExtension } from '../document-file-validator'

/**
 * Regex validating standard UUID format (8-4-4-4-12 hex).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Regex matching quarantined document files created during deletion:
 * .quarantine_${sourceId}_${quarantineUuid}.${file_type}
 */
export const QUARANTINE_FILE_REGEX =
  /^\.quarantine_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/i

export interface QuarantineRecoveryError {
  readonly knowledgeBaseId: string
  readonly quarantineFile: string
  readonly error: string
}

export interface QuarantineRecoveryReport {
  readonly recoveredCount: number
  readonly cleanedCount: number
  readonly conflictCount: number
  readonly errors: readonly QuarantineRecoveryError[]
}

/**
 * Pluggable filesystem operations for test isolation and fault injection.
 */
export interface QuarantineRecoveryFilesystemOperations {
  readdir(path: string): Promise<string[]>
  lstat(path: string): Promise<fs.Stats>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const defaultQuarantineFilesystemOperations: QuarantineRecoveryFilesystemOperations = {
  readdir: (p) => fs.promises.readdir(p),
  lstat: (p) => fs.promises.lstat(p),
  rename: (oldP, newP) => fs.promises.rename(oldP, newP),
  unlink: (p) => fs.promises.unlink(p)
}

export interface DocumentQuarantineRecoveryOptions {
  readonly storageManager?: DocumentStorageManager
  readonly documentsDir?: string
  readonly sourceRepository: KnowledgeSourceRepository
  readonly fsOps?: Partial<QuarantineRecoveryFilesystemOperations>
}

/**
 * Service that scans managed document storage on application startup to safely reconcile
 * any lingering quarantined files from previous crashes, aborted transactions, or OS locks.
 *
 * Scenarios handled:
 * - Scenario A: Source record exists in SQLite & original file missing -> Restore quarantine file.
 * - Scenario B: Source record does NOT exist in SQLite -> Purge orphaned quarantine file.
 * - Scenario C: Source record exists & original file already exists -> Preserve both, log conflict.
 */
export class DocumentQuarantineRecoveryService {
  private readonly documentsDir: string
  private readonly sourceRepository: KnowledgeSourceRepository
  private readonly fsOps: QuarantineRecoveryFilesystemOperations

  constructor(options: DocumentQuarantineRecoveryOptions) {
    if (options.documentsDir) {
      this.documentsDir = path.resolve(options.documentsDir)
    } else if (options.storageManager) {
      this.documentsDir = options.storageManager.getDocumentsDirectory()
    } else {
      throw new Error(
        'Either storageManager or documentsDir must be provided to DocumentQuarantineRecoveryService.'
      )
    }

    if (!options.sourceRepository) {
      throw new Error(
        'KnowledgeSourceRepository is required for DocumentQuarantineRecoveryService.'
      )
    }

    this.sourceRepository = options.sourceRepository
    this.fsOps = {
      ...defaultQuarantineFilesystemOperations,
      ...(options.fsOps ?? {})
    }
  }

  /**
   * Scans all Knowledge Base originals directories and reconciles quarantined files.
   */
  public async recover(): Promise<QuarantineRecoveryReport> {
    let recoveredCount = 0
    let cleanedCount = 0
    let conflictCount = 0
    const errors: QuarantineRecoveryError[] = []

    // 1. Verify existence of root documents directory
    try {
      const rootStat = await this.fsOps.lstat(this.documentsDir)
      if (!rootStat.isDirectory()) {
        return { recoveredCount: 0, cleanedCount: 0, conflictCount: 0, errors: [] }
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'ENOENT') {
        return { recoveredCount: 0, cleanedCount: 0, conflictCount: 0, errors: [] }
      }
      errors.push({
        knowledgeBaseId: '',
        quarantineFile: '',
        error: `Failed to inspect documents directory: ${err instanceof Error ? err.message : String(err)}`
      })
      return { recoveredCount: 0, cleanedCount: 0, conflictCount: 0, errors }
    }

    // 2. Discover potential Knowledge Base directories
    let entries: string[]
    try {
      entries = await this.fsOps.readdir(this.documentsDir)
    } catch (err: unknown) {
      errors.push({
        knowledgeBaseId: '',
        quarantineFile: '',
        error: `Failed to read documents directory: ${err instanceof Error ? err.message : String(err)}`
      })
      return { recoveredCount: 0, cleanedCount: 0, conflictCount: 0, errors }
    }

    // 3. Process each Knowledge Base directory
    for (const entry of entries) {
      if (!UUID_REGEX.test(entry)) {
        continue
      }
      const kbId = entry

      // Strict path traversal containment check
      const kbDir = path.resolve(this.documentsDir, kbId)
      if (path.relative(this.documentsDir, kbDir) !== kbId) {
        errors.push({
          knowledgeBaseId: kbId,
          quarantineFile: '',
          error: `Path traversal detected for Knowledge Base directory '${kbId}'`
        })
        continue
      }

      // Resolve originals directory
      const originalsDir = path.resolve(kbDir, 'originals')
      if (path.relative(kbDir, originalsDir) !== 'originals') {
        errors.push({
          knowledgeBaseId: kbId,
          quarantineFile: '',
          error: `Path traversal detected for originals directory in KB '${kbId}'`
        })
        continue
      }

      // Check originals directory existence and reject symlinks
      try {
        const originalsStat = await this.fsOps.lstat(originalsDir)
        if (originalsStat.isSymbolicLink()) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile: '',
            error: `Originals directory in KB '${kbId}' is a symbolic link. Skipping.`
          })
          continue
        }
        if (!originalsStat.isDirectory()) {
          continue
        }
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code
        if (code === 'ENOENT') {
          continue
        }
        errors.push({
          knowledgeBaseId: kbId,
          quarantineFile: '',
          error: `Failed to inspect originals directory in KB '${kbId}': ${err instanceof Error ? err.message : String(err)}`
        })
        continue
      }

      // 4. Discover quarantined files in originals directory
      let files: string[]
      try {
        files = await this.fsOps.readdir(originalsDir)
      } catch (err: unknown) {
        errors.push({
          knowledgeBaseId: kbId,
          quarantineFile: '',
          error: `Failed to read originals directory in KB '${kbId}': ${err instanceof Error ? err.message : String(err)}`
        })
        continue
      }

      const quarantineFiles = files.filter((f) => f.startsWith('.quarantine_'))

      for (const quarantineFile of quarantineFiles) {
        const match = quarantineFile.match(QUARANTINE_FILE_REGEX)
        if (!match) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile,
            error: `Malformed quarantine filename '${quarantineFile}'`
          })
          continue
        }

        const sourceId = match[1]
        const rawExt = match[2].toLowerCase()

        if (!SUPPORTED_EXTENSIONS.includes(rawExt as SupportedExtension)) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile,
            error: `Unsupported file extension in quarantine file '${quarantineFile}'`
          })
          continue
        }

        const quarantinePath = path.resolve(originalsDir, quarantineFile)
        if (path.relative(originalsDir, quarantinePath) !== quarantineFile) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile,
            error: `Path traversal detected for quarantine file '${quarantineFile}'`
          })
          continue
        }

        // Check quarantine file symlink status
        try {
          const qStat = await this.fsOps.lstat(quarantinePath)
          if (qStat.isSymbolicLink()) {
            errors.push({
              knowledgeBaseId: kbId,
              quarantineFile,
              error: `Quarantine file '${quarantineFile}' is a symbolic link. Skipping for security.`
            })
            continue
          }
        } catch (err: unknown) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile,
            error: `Failed to stat quarantine file '${quarantineFile}': ${err instanceof Error ? err.message : String(err)}`
          })
          continue
        }

        // 5. Query authoritative KnowledgeSource record
        let sourceExists: boolean
        try {
          const source = this.sourceRepository.getById(sourceId, kbId)
          sourceExists = source !== null
        } catch (dbErr: unknown) {
          errors.push({
            knowledgeBaseId: kbId,
            quarantineFile,
            error: `Database lookup failed for source '${sourceId}': ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
          })
          continue
        }

        const originalFileName = `${sourceId}.${rawExt}`
        const originalPath = path.resolve(originalsDir, originalFileName)

        if (sourceExists) {
          // Check if original file currently exists
          let originalExists = false
          try {
            const origStat = await this.fsOps.lstat(originalPath)
            if (!origStat.isSymbolicLink()) {
              originalExists = true
            }
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code
            if (code !== 'ENOENT') {
              errors.push({
                knowledgeBaseId: kbId,
                quarantineFile,
                error: `Failed to stat original file target '${originalFileName}': ${err instanceof Error ? err.message : String(err)}`
              })
              continue
            }
          }

          if (originalExists) {
            // Scenario C: Conflict - Both original and quarantine exist while DB record exists
            conflictCount++
            errors.push({
              knowledgeBaseId: kbId,
              quarantineFile,
              error: `Conflict detected: Original file '${originalFileName}' already exists. Preserving quarantine file.`
            })
          } else {
            // Scenario A: Restore - DB record exists and original is missing
            try {
              await this.fsOps.rename(quarantinePath, originalPath)
              recoveredCount++
            } catch (renameErr: unknown) {
              errors.push({
                knowledgeBaseId: kbId,
                quarantineFile,
                error: `Failed to restore quarantine file '${quarantineFile}' to '${originalFileName}': ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
              })
            }
          }
        } else {
          // Scenario B: Cleanup - DB record does not exist; document was deleted from SQLite
          try {
            await this.fsOps.unlink(quarantinePath)
            cleanedCount++
          } catch (unlinkErr: unknown) {
            errors.push({
              knowledgeBaseId: kbId,
              quarantineFile,
              error: `Failed to unlink orphaned quarantine file '${quarantineFile}': ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
            })
          }
        }
      }
    }

    return {
      recoveredCount,
      cleanedCount,
      conflictCount,
      errors
    }
  }
}

/**
 * Convenience helper to run quarantine recovery on startup.
 */
export async function recoverQuarantinedDocuments(
  options: DocumentQuarantineRecoveryOptions
): Promise<QuarantineRecoveryReport> {
  const service = new DocumentQuarantineRecoveryService(options)
  return service.recover()
}
