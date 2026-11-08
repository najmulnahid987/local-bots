import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import {
  type KnowledgeBaseDto,
  type KnowledgeBaseOverviewDto,
  type CreateKnowledgeBaseRequest,
  type UpdateKnowledgeBaseRequest,
  type KnowledgeBaseListRequest,
  type DeleteKnowledgeBaseResult,
  createKnowledgeBaseRequestSchema,
  updateKnowledgeBaseRequestSchema,
  knowledgeBaseListRequestSchema,
  knowledgeBaseIdSchema,
  toKnowledgeBaseDto
} from '../../shared/knowledge-bases'

/**
 * Pluggable filesystem operations interface for KnowledgeBaseManager.
 * Defaults to native Node.js fs.promises; allows deterministic fault injection in test suites.
 */
export interface KnowledgeBaseFilesystemOperations {
  mkdir(path: string, options?: fs.MakeDirectoryOptions): Promise<string | undefined>
  rm(path: string, options?: fs.RmOptions): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  lstat(path: string): Promise<fs.Stats>
  stat(path: string): Promise<fs.Stats>
  access(path: string, mode?: number): Promise<void>
  realpath(path: string): Promise<string>
}

export const defaultFilesystemOperations: KnowledgeBaseFilesystemOperations = {
  mkdir: (p, opts) => fs.promises.mkdir(p, opts),
  rm: (p, opts) => fs.promises.rm(p, opts),
  rename: (oldP, newP) => fs.promises.rename(oldP, newP),
  lstat: (p) => fs.promises.lstat(p),
  stat: (p) => fs.promises.stat(p),
  access: (p, mode) => fs.promises.access(p, mode),
  realpath: (p) => fs.promises.realpath(p)
}

/**
 * Configuration options for initializing KnowledgeBaseManager.
 */
export interface KnowledgeBaseManagerOptions {
  readonly repository: KnowledgeBaseRepository
  readonly userDataPath?: string
  readonly documentsDir?: string
  readonly fsOps?: Partial<KnowledgeBaseFilesystemOperations>
}

/**
 * Error classifications emitted by KnowledgeBaseManager.
 */
export type KnowledgeBaseManagerErrorCode =
  | 'VALIDATION_ERROR'
  | 'SECURITY_ERROR'
  | 'CREATION_FAILED'
  | 'COMPENSATION_FAILED'
  | 'DELETION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'NOT_FOUND'
  | 'INITIALIZATION_ERROR'
  | 'CLEANUP_PENDING'
  | 'INTERNAL_ERROR'

/**
 * Base application error for Knowledge Base manager operations.
 */
export class KnowledgeBaseManagerError extends Error {
  readonly code: KnowledgeBaseManagerErrorCode
  readonly details?: unknown

  constructor(
    message: string,
    code: KnowledgeBaseManagerErrorCode = 'INTERNAL_ERROR',
    details?: unknown
  ) {
    super(message)
    this.name = 'KnowledgeBaseManagerError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, KnowledgeBaseManagerError.prototype)
  }
}

export class KnowledgeBaseValidationError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details)
    this.name = 'KnowledgeBaseValidationError'
    Object.setPrototypeOf(this, KnowledgeBaseValidationError.prototype)
  }
}

export class KnowledgeBaseSecurityError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'SECURITY_ERROR', details)
    this.name = 'KnowledgeBaseSecurityError'
    Object.setPrototypeOf(this, KnowledgeBaseSecurityError.prototype)
  }
}

export class KnowledgeBaseCreationError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'CREATION_FAILED', details)
    this.name = 'KnowledgeBaseCreationError'
    Object.setPrototypeOf(this, KnowledgeBaseCreationError.prototype)
  }
}

export class KnowledgeBaseCompensationError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'COMPENSATION_FAILED', details)
    this.name = 'KnowledgeBaseCompensationError'
    Object.setPrototypeOf(this, KnowledgeBaseCompensationError.prototype)
  }
}

export class KnowledgeBaseDeletionError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'DELETION_FAILED', details)
    this.name = 'KnowledgeBaseDeletionError'
    Object.setPrototypeOf(this, KnowledgeBaseDeletionError.prototype)
  }
}

export class KnowledgeBaseRollbackError extends KnowledgeBaseManagerError {
  constructor(message: string, details?: unknown) {
    super(message, 'ROLLBACK_FAILED', details)
    this.name = 'KnowledgeBaseRollbackError'
    Object.setPrototypeOf(this, KnowledgeBaseRollbackError.prototype)
  }
}

/**
 * Main-process service coordinating Knowledge Base persistence and physical filesystem storage.
 *
 * Enforces:
 * 1. Physical directories are keyed strictly by immutable UUIDs (<userData>/documents/<id>/).
 * 2. Renaming a Knowledge Base never moves or renames its directory.
 * 3. Physical directory creation failure triggers automatic database record compensation.
 * 4. Deletion uses a two-stage quarantine process with automatic rollback on DB failure.
 * 5. Strict directory boundary validation prevents path traversal and symlink escapes.
 * 6. Sibling Knowledge Bases and global provider connections remain strictly isolated.
 */
export class KnowledgeBaseManager {
  private readonly repository: KnowledgeBaseRepository
  private readonly documentsDir: string
  private readonly fsOps: KnowledgeBaseFilesystemOperations

  constructor(options: KnowledgeBaseManagerOptions) {
    if (!options || !options.repository) {
      throw new KnowledgeBaseManagerError(
        'KnowledgeBaseRepository is required for KnowledgeBaseManager.',
        'INITIALIZATION_ERROR'
      )
    }

    this.repository = options.repository

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
      ...defaultFilesystemOperations,
      ...(options.fsOps ?? {})
    }
  }

  /**
   * Returns the canonical documents root directory.
   */
  public getDocumentsDirectory(): string {
    return this.documentsDir
  }

  /**
   * Resolves, canonicalizes, and verifies the physical directory for a Knowledge Base.
   * Enforces strict UUID formatting and guarantees the path is an immediate child of documentsDir.
   */
  public resolveKnowledgeBaseDirectory(kbId: string): string {
    const parseResult = knowledgeBaseIdSchema.safeParse(kbId)
    if (!parseResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${kbId}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const targetDir = path.resolve(this.documentsDir, kbId)
    const rel = path.relative(this.documentsDir, targetDir)

    // targetDir must be an immediate child whose relative path matches the UUID exactly
    if (rel !== kbId || rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
      throw new KnowledgeBaseSecurityError(
        `Directory safety check failed: target directory path traversal detected for ID '${kbId}'.`
      )
    }

    if (targetDir === this.documentsDir || targetDir === path.dirname(this.documentsDir)) {
      throw new KnowledgeBaseSecurityError(
        'Directory safety check failed: target cannot be the root documents directory or a parent directory.'
      )
    }

    return targetDir
  }

  /**
   * Creates a new Knowledge Base.
   *
   * Lifecycle:
   * 1. Validates input schema.
   * 2. Inserts database record using KnowledgeBaseRepository.
   * 3. Creates dedicated directory <documentsDir>/<id>/.
   * 4. If directory creation fails, compensates by deleting the database record.
   * 5. Returns public KnowledgeBaseDto.
   */
  public async create(input: CreateKnowledgeBaseRequest): Promise<KnowledgeBaseDto> {
    const parseResult = createKnowledgeBaseRequestSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new KnowledgeBaseValidationError(`Failed to create Knowledge Base: ${messages}`)
    }

    const { name, description } = parseResult.data

    // 1. Create database record
    const createdRecord = this.repository.create({
      name,
      description
    })

    // 2. Resolve directory from generated UUID
    const targetDir = this.resolveKnowledgeBaseDirectory(createdRecord.id)

    // 3. Attempt physical directory creation
    try {
      await this.ensureDocumentsRoot()

      // Reject symlink if an object already exists at the target path
      try {
        const existingStat = await this.fsOps.lstat(targetDir)
        if (existingStat.isSymbolicLink()) {
          throw new KnowledgeBaseSecurityError(
            `Target storage path for Knowledge Base '${createdRecord.id}' is an existing symbolic link.`
          )
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'ENOENT' && !(e instanceof KnowledgeBaseSecurityError)) {
          throw e
        }
        if (e instanceof KnowledgeBaseSecurityError) {
          throw e
        }
      }

      await this.fsOps.mkdir(targetDir, { recursive: true })
    } catch (fsErr) {
      // 4. Compensation: Attempt to rollback the database record
      let compensationSuccess: boolean
      try {
        compensationSuccess = this.repository.delete(createdRecord.id)
      } catch (compErr) {
        throw new KnowledgeBaseCompensationError(
          `Directory creation failed and database record rollback encountered an error. Orphaned Knowledge Base ID: '${createdRecord.id}'.`,
          { fsError: fsErr, compensationError: compErr, kbId: createdRecord.id }
        )
      }

      if (!compensationSuccess) {
        throw new KnowledgeBaseCompensationError(
          `Directory creation failed and database record rollback failed to delete record with ID '${createdRecord.id}'.`,
          { fsError: fsErr, kbId: createdRecord.id }
        )
      }

      if (fsErr instanceof KnowledgeBaseManagerError) {
        throw fsErr
      }

      throw new KnowledgeBaseCreationError(
        `Failed to create physical storage directory for Knowledge Base: ${fsErr instanceof Error ? fsErr.message : String(fsErr)}`,
        { fsError: fsErr, kbId: createdRecord.id }
      )
    }

    return toKnowledgeBaseDto(createdRecord)
  }

  /**
   * Retrieves a single Knowledge Base by its UUID primary key.
   */
  public async getById(id: string): Promise<KnowledgeBaseDto | null> {
    const parseResult = knowledgeBaseIdSchema.safeParse(id)
    if (!parseResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const row = this.repository.getById(id)
    return row ? toKnowledgeBaseDto(row) : null
  }

  /**
   * Retrieves aggregated Overview statistics and recent activity for a Knowledge Base.
   * Scoped strictly to the target Knowledge Base UUID.
   * Throws NOT_FOUND if the Knowledge Base does not exist.
   */
  public async getOverview(id: string): Promise<KnowledgeBaseOverviewDto> {
    const parseResult = knowledgeBaseIdSchema.safeParse(id)
    if (!parseResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const existing = this.repository.getById(id)
    if (!existing) {
      throw new KnowledgeBaseManagerError(
        `Knowledge Base with ID '${id}' does not exist.`,
        'NOT_FOUND'
      )
    }

    return this.repository.getOverview(id)
  }

  /**
   * Lists Knowledge Bases ordered by created_at DESC.
   * By default, returns active Knowledge Bases (archivedAt is null).
   */
  public async list(options?: KnowledgeBaseListRequest): Promise<KnowledgeBaseDto[]> {
    const parseResult = knowledgeBaseListRequestSchema.safeParse(options)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new KnowledgeBaseValidationError(`Invalid Knowledge Base list options: ${messages}`)
    }

    const includeArchived = parseResult.data?.includeArchived ?? false
    const rows = this.repository.list({ includeArchived })
    return rows.map(toKnowledgeBaseDto)
  }

  /**
   * Updates mutable fields (name, description) of a Knowledge Base.
   * Preserves immutable UUID and physical storage path without moving the directory.
   */
  public async update(
    id: string,
    input: UpdateKnowledgeBaseRequest
  ): Promise<KnowledgeBaseDto | null> {
    const idResult = knowledgeBaseIdSchema.safeParse(id)
    if (!idResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const parseResult = updateKnowledgeBaseRequestSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new KnowledgeBaseValidationError(`Failed to update Knowledge Base: ${messages}`)
    }

    const updated = this.repository.update(id, parseResult.data)
    return updated ? toKnowledgeBaseDto(updated) : null
  }

  /**
   * Archives a Knowledge Base by setting its archived_at timestamp.
   * Preserves all physical files and child entities.
   */
  public async archive(id: string): Promise<KnowledgeBaseDto | null> {
    const idResult = knowledgeBaseIdSchema.safeParse(id)
    if (!idResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const archived = this.repository.archive(id)
    return archived ? toKnowledgeBaseDto(archived) : null
  }

  /**
   * Unarchives a Knowledge Base by resetting its archived_at timestamp to null.
   */
  public async unarchive(id: string): Promise<KnowledgeBaseDto | null> {
    const idResult = knowledgeBaseIdSchema.safeParse(id)
    if (!idResult.success) {
      throw new KnowledgeBaseValidationError(
        `Invalid Knowledge Base identifier: '${id}'. Must be a valid RFC 4122 UUIDv4.`
      )
    }

    const unarchived = this.repository.unarchive(id)
    return unarchived ? toKnowledgeBaseDto(unarchived) : null
  }

  /**
   * Deletes a Knowledge Base and its physical storage directory.
   *
   * Two-stage quarantine lifecycle:
   * 1. Validates ID and checks database record existence.
   * 2. Inspects target directory (rejects symlinks).
   * 3. Atomically renames existing directory to unique quarantine path inside documentsDir.
   * 4. Executes database deletion (cascading across child tables).
   * 5. If database deletion fails, restores the quarantined directory.
   * 6. If database deletion succeeds, recursively removes only the quarantined directory.
   * 7. If quarantine cleanup fails, reports database deletion success with cleanupPending: true.
   */
  public async delete(id: string): Promise<DeleteKnowledgeBaseResult> {
    const targetDir = this.resolveKnowledgeBaseDirectory(id)

    // Verify database record exists before mutating storage
    const existing = this.repository.getById(id)
    if (!existing) {
      return {
        success: false,
        directoryCleaned: false,
        cleanupPending: false,
        code: 'NOT_FOUND',
        error: `Knowledge Base with ID '${id}' does not exist.`
      }
    }

    let directoryExisted: boolean
    let isQuarantined = false
    const quarantineName = `.quarantine_${id}_${randomUUID()}`
    const quarantineDir = path.resolve(this.documentsDir, quarantineName)

    try {
      const stat = await this.fsOps.lstat(targetDir)
      if (stat.isSymbolicLink()) {
        throw new KnowledgeBaseSecurityError(
          `Directory safety check failed: target directory for Knowledge Base '${id}' is a symbolic link.`
        )
      }
      if (!stat.isDirectory()) {
        throw new KnowledgeBaseSecurityError(
          `Directory safety check failed: target path for Knowledge Base '${id}' is not a directory.`
        )
      }
      directoryExisted = true
    } catch (statErr: unknown) {
      const err = statErr as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        directoryExisted = false
      } else {
        if (statErr instanceof KnowledgeBaseManagerError) {
          throw statErr
        }
        throw new KnowledgeBaseManagerError(
          `Failed to inspect Knowledge Base directory: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
          'INTERNAL_ERROR',
          statErr
        )
      }
    }

    // Atomically quarantine directory prior to SQLite deletion
    if (directoryExisted) {
      try {
        await this.ensureDocumentsRoot()
        await this.fsOps.rename(targetDir, quarantineDir)
        isQuarantined = true
      } catch (renameErr) {
        throw new KnowledgeBaseDeletionError(
          `Failed to quarantine Knowledge Base directory prior to deletion: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
          renameErr
        )
      }
    }

    // Execute SQLite deletion (cascades to all child rows)
    let dbDeleted: boolean
    try {
      dbDeleted = this.repository.delete(id)
    } catch (dbErr) {
      // Rollback quarantine on database failure
      if (isQuarantined) {
        try {
          await this.fsOps.rename(quarantineDir, targetDir)
        } catch (restoreErr) {
          throw new KnowledgeBaseRollbackError(
            `Database deletion failed for Knowledge Base '${id}' and directory restoration also failed. Quarantined directory remains at: ${quarantineDir}`,
            { dbError: dbErr, restoreError: restoreErr }
          )
        }
      }
      throw new KnowledgeBaseDeletionError(
        `Failed to delete Knowledge Base database record: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        dbErr
      )
    }

    if (!dbDeleted) {
      // Database record was missing or no rows deleted
      if (isQuarantined) {
        try {
          await this.fsOps.rename(quarantineDir, targetDir)
        } catch (restoreErr) {
          throw new KnowledgeBaseRollbackError(
            `Knowledge Base record '${id}' was not deleted and directory restoration failed. Quarantined directory remains at: ${quarantineDir}`,
            { restoreError: restoreErr }
          )
        }
      }
      return {
        success: false,
        directoryCleaned: false,
        cleanupPending: false,
        code: 'NOT_FOUND',
        error: `Knowledge Base with ID '${id}' was not found in the database.`
      }
    }

    // Clean up quarantined directory
    if (isQuarantined) {
      // Guard against deleting outside documentsDir
      if (
        quarantineDir === this.documentsDir ||
        !quarantineDir.startsWith(this.documentsDir + path.sep) ||
        !path.basename(quarantineDir).startsWith('.quarantine_')
      ) {
        throw new KnowledgeBaseSecurityError(
          `Quarantine directory path violation: attempted to delete unsafe path: ${quarantineDir}`
        )
      }

      try {
        await this.fsOps.rm(quarantineDir, { recursive: true, force: true })
        return {
          success: true,
          directoryCleaned: true,
          cleanupPending: false
        }
      } catch (rmErr) {
        // Successful DB deletion cannot be reversed; report cleanup pending
        return {
          success: true,
          directoryCleaned: false,
          cleanupPending: true,
          code: 'CLEANUP_PENDING',
          error: `Knowledge Base record deleted, but directory cleanup encountered an error: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
        }
      }
    }

    // Original directory did not exist on disk
    return {
      success: true,
      directoryCleaned: true,
      cleanupPending: false
    }
  }

  /**
   * Ensures the root documents directory exists.
   */
  private async ensureDocumentsRoot(): Promise<string> {
    await this.fsOps.mkdir(this.documentsDir, { recursive: true })
    return this.documentsDir
  }
}
