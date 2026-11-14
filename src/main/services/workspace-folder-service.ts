import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue
} from 'electron'
import { WorkspacePathGuard, WorkspaceSecurityError } from '../security/workspace-path-guard'

// ============================================================================
// Service Contracts & Types
// ============================================================================

export interface BrowserWindowLike {
  isDestroyed?: () => boolean
}

export interface WorkspaceDialogOperations {
  showOpenDialog(
    browserWindow: BrowserWindowLike | BrowserWindow,
    options: OpenDialogOptions
  ): Promise<OpenDialogReturnValue>
}

export interface WorkspaceGrant {
  readonly agentRunId: string
  readonly botId: string
  readonly canonicalRoot: string
  readonly grantedAt: number
}

export type WorkspaceAuthorizationResult =
  | { readonly status: 'authorized'; readonly agentRunId: string; readonly botId: string }
  | { readonly status: 'cancelled' }

export interface WorkspaceFolderServiceOptions {
  readonly dialogOps?: WorkspaceDialogOperations
}

// ============================================================================
// WorkspaceFolderService Implementation
// ============================================================================

/**
 * Main-process service managing in-memory workspace directory authorizations.
 * Authorizations are bound strictly to an (agentRunId, botId) tuple, never persisted
 * to SQLite, never accepted from untrusted inputs, and revoked when runs terminate.
 */
export class WorkspaceFolderService {
  private readonly grants = new Map<string, WorkspaceGrant>()
  private readonly dialogOps?: WorkspaceDialogOperations

  constructor(options?: WorkspaceFolderServiceOptions) {
    this.dialogOps = options?.dialogOps
  }

  /**
   * Prompts the user through Electron's native folder picker to authorize a workspace root.
   * Resolves the selected path canonically and binds the grant strictly in process memory.
   */
  public async requestWorkspaceAuthorization(
    window: BrowserWindowLike | BrowserWindow | null | undefined,
    agentRunId: string,
    botId: string
  ): Promise<WorkspaceAuthorizationResult> {
    if (!agentRunId || typeof agentRunId !== 'string' || agentRunId.trim().length === 0) {
      throw new WorkspaceSecurityError(
        'A valid agentRunId is required for workspace authorization.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    if (!botId || typeof botId !== 'string' || botId.trim().length === 0) {
      throw new WorkspaceSecurityError(
        'A valid botId is required for workspace authorization.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    if (!window) {
      throw new WorkspaceSecurityError(
        'Active BrowserWindow is required to prompt for workspace selection.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) {
      throw new WorkspaceSecurityError(
        'Cannot prompt workspace dialog: window has been destroyed.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    const openDialogFn = this.dialogOps?.showOpenDialog ?? dialog.showOpenDialog

    const dialogResult = await openDialogFn(window as BrowserWindow, {
      title: 'Authorize Workspace Directory for Bot',
      buttonLabel: 'Authorize Folder',
      properties: ['openDirectory', 'dontAddToRecent']
    })

    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
      return { status: 'cancelled' }
    }

    const rawPath = dialogResult.filePaths[0]
    const canonicalRoot = WorkspacePathGuard.validateRootDirectory(rawPath)

    this.grants.set(agentRunId, {
      agentRunId,
      botId,
      canonicalRoot,
      grantedAt: Date.now()
    })

    return {
      status: 'authorized',
      agentRunId,
      botId
    }
  }

  /**
   * Retrieves the canonical root directory granted to an agent run, verifying
   * that the calling Bot matches the authorized Bot identity.
   */
  public getApprovedRoot(agentRunId: string, botId: string): string {
    if (!agentRunId || !botId) {
      throw new WorkspaceSecurityError(
        'Workspace access denied: agentRunId and botId are required.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    const grant = this.grants.get(agentRunId)
    if (!grant) {
      throw new WorkspaceSecurityError(
        'No active workspace authorization found for this agent run. User must select a folder.',
        'WORKSPACE_GRANT_NOT_FOUND'
      )
    }

    if (grant.botId !== botId) {
      throw new WorkspaceSecurityError(
        'Workspace authorization mismatch: Bot does not match the authorized grant.',
        'WORKSPACE_GRANT_NOT_FOUND'
      )
    }

    // Re-verify that canonical root still exists on disk
    return WorkspacePathGuard.validateRootDirectory(grant.canonicalRoot)
  }

  /**
   * Checks whether an active grant exists for an agent run and bot.
   */
  public hasGrant(agentRunId: string, botId: string): boolean {
    const grant = this.grants.get(agentRunId)
    if (!grant) {
      return false
    }
    return grant.botId === botId
  }

  /**
   * Revokes a specific workspace grant (e.g. on agent run completion or cancellation).
   */
  public revoke(agentRunId: string): boolean {
    return this.grants.delete(agentRunId)
  }

  /**
   * Clears all in-memory workspace grants.
   */
  public clear(): void {
    this.grants.clear()
  }
}
