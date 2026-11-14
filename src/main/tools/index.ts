import type { BrowserWindow } from 'electron'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import type { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import type { BotRagService } from '../services/bot-rag-service'
import type {
  WorkspaceFolderService,
  BrowserWindowLike
} from '../services/workspace-folder-service'
import type { ApprovalController } from '../services/approval-controller'
import { ToolRegistry } from './tool-registry'
import {
  SearchKnowledgeBaseTool,
  ReadKnowledgeSourceTool,
  ListKnowledgeSourcesTool
} from './knowledge-base'
import { SearchWorkspaceFilesTool, ReadWorkspaceFileTool } from './workspace'
import { SaveReportTool, type SaveReportDialogOperations } from './report'

export * from './agent-tool'
export * from './tool-registry'
export * from './knowledge-base'
export * from './workspace'
export * from './report'

export interface CreateToolRegistryOptions {
  readonly botRepository: BotRepository
  readonly knowledgeBaseRepository: KnowledgeBaseRepository
  readonly knowledgeSourceRepository: KnowledgeSourceRepository
  readonly botRagService: BotRagService
  readonly workspaceFolderService?: WorkspaceFolderService
  readonly approvalController?: ApprovalController
  readonly saveReportDialogOps?: SaveReportDialogOperations
  readonly getMainWindow?: () => BrowserWindowLike | BrowserWindow | null
}

/**
 * Creates and initializes a ToolRegistry configured with the canonical Phase 8
 * Knowledge Base scoped tools, optional workspace filesystem tools, and optional save_report tool.
 */
export function createDefaultToolRegistry(options: CreateToolRegistryOptions): ToolRegistry {
  if (
    !options.botRepository ||
    !options.knowledgeBaseRepository ||
    !options.knowledgeSourceRepository ||
    !options.botRagService
  ) {
    throw new Error('All repository and service dependencies are required to create ToolRegistry.')
  }

  const registry = new ToolRegistry({
    botRepository: options.botRepository,
    knowledgeBaseRepository: options.knowledgeBaseRepository
  })

  // 1. Knowledge Base Scoped Tools (Phase 8 Step 8.2)
  registry.register(new SearchKnowledgeBaseTool(options.botRagService))
  registry.register(new ReadKnowledgeSourceTool(options.knowledgeSourceRepository))
  registry.register(new ListKnowledgeSourcesTool(options.knowledgeSourceRepository))

  // 2. Workspace Filesystem Tools (Phase 8 Step 8.3)
  if (options.workspaceFolderService) {
    registry.register(new SearchWorkspaceFilesTool(options.workspaceFolderService))
    registry.register(new ReadWorkspaceFileTool(options.workspaceFolderService))
  }

  // 3. Save Report Tool (Phase 8 Step 8.4)
  if (options.approvalController) {
    registry.register(
      new SaveReportTool(
        options.approvalController,
        options.saveReportDialogOps,
        options.getMainWindow
      )
    )
  }

  return registry
}
