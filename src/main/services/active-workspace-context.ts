import { idSchema, type KnowledgeBase } from '../database/repositories/types'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotManagerError, NoActiveWorkspaceError, BotValidationError } from './bot-errors'

export type SessionId = string | number

export interface ActiveWorkspaceContextOptions {
  readonly kbRepo: KnowledgeBaseRepository
}

/**
 * Main-process component tracking active Knowledge Base workspace sessions per renderer.
 * Bounded strictly by session ID (e.g. webContents.id) to prevent cross-window state bleed.
 *
 * Invariants:
 * 1. The Main process, not the Renderer, maintains the authoritative active KB mapping.
 * 2. On every resolution, validates against SQLite that the KB still exists and is not archived.
 * 3. Clearing or switching workspace in one session does not impact other concurrent sessions.
 */
export class ActiveWorkspaceContext {
  private readonly kbRepo: KnowledgeBaseRepository
  private readonly sessions = new Map<string, string>()

  constructor(options: ActiveWorkspaceContextOptions | KnowledgeBaseRepository) {
    if ('getById' in options) {
      this.kbRepo = options
    } else {
      this.kbRepo = options.kbRepo
    }
  }

  /**
   * Activates a Knowledge Base for a given renderer session.
   * Validates against SQLite:
   * - Must be a valid UUIDv4 string format.
   * - Knowledge Base must exist in the database.
   * - Knowledge Base must NOT be archived.
   */
  public activateWorkspace(sessionId: SessionId, knowledgeBaseId: string): KnowledgeBase {
    const idParse = idSchema.safeParse(knowledgeBaseId)
    if (!idParse.success) {
      throw new BotValidationError(
        `Invalid Knowledge Base ID '${knowledgeBaseId}': must be a valid UUIDv4 string.`
      )
    }

    const kb = this.kbRepo.getById(idParse.data)
    if (!kb) {
      throw new BotManagerError(
        `Knowledge Base with ID '${knowledgeBaseId}' does not exist.`,
        'KB_NOT_FOUND'
      )
    }

    if (kb.archived_at !== null) {
      throw new BotManagerError(
        `Cannot activate Knowledge Base '${kb.name}' because it is archived.`,
        'ARCHIVED_WORKSPACE'
      )
    }

    this.sessions.set(String(sessionId), kb.id)
    return kb
  }

  /**
   * Resolves the authoritative active Knowledge Base ID for a renderer session.
   * On every call, validates that the active Knowledge Base still exists and is not archived.
   * If stale or invalid, cleans the session from memory and throws.
   */
  public getActiveWorkspaceId(sessionId: SessionId): string {
    const kbId = this.sessions.get(String(sessionId))
    if (!kbId) {
      throw new NoActiveWorkspaceError('No active Knowledge Base workspace found for this session.')
    }

    const kb = this.kbRepo.getById(kbId)
    if (!kb) {
      this.sessions.delete(String(sessionId))
      throw new BotManagerError(
        `Active Knowledge Base with ID '${kbId}' no longer exists.`,
        'KB_NOT_FOUND'
      )
    }

    if (kb.archived_at !== null) {
      this.sessions.delete(String(sessionId))
      throw new BotManagerError(
        `Active Knowledge Base '${kb.name}' has been archived and cannot authorize operations.`,
        'ARCHIVED_WORKSPACE'
      )
    }

    return kb.id
  }

  /**
   * Resolves the full KnowledgeBase entity for the active session.
   */
  public getActiveWorkspace(sessionId: SessionId): KnowledgeBase {
    const kbId = this.getActiveWorkspaceId(sessionId)
    return this.kbRepo.getById(kbId)!
  }

  /**
   * Clears the active workspace for a renderer session.
   */
  public clearActiveWorkspace(sessionId: SessionId): boolean {
    return this.sessions.delete(String(sessionId))
  }

  /**
   * Checks whether a session currently has a valid active workspace.
   */
  public hasActiveWorkspace(sessionId: SessionId): boolean {
    try {
      this.getActiveWorkspaceId(sessionId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Clears all session contexts (useful for tests or application shutdown).
   */
  public clearAll(): void {
    this.sessions.clear()
  }

  /**
   * Number of active sessions currently tracked.
   */
  public get sessionCount(): number {
    return this.sessions.size
  }
}
