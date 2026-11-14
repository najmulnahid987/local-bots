import { z } from 'zod'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import { ToolExecutionError } from '../agent-tool'
import type { WorkspaceFolderService } from '../../services/workspace-folder-service'
import { WorkspacePathGuard, WorkspaceSecurityError } from '../../security/workspace-path-guard'

// ============================================================================
// Limits & Constants
// ============================================================================

export const DEFAULT_READ_WORKSPACE_MAX_LINES = 200
export const MAX_READ_WORKSPACE_MAX_LINES = 1000

// ============================================================================
// Input Schema
// ============================================================================

export const readWorkspaceFileInputSchema = z
  .object({
    relativePath: z
      .string()
      .trim()
      .min(1, 'relativePath cannot be empty')
      .max(500, 'relativePath cannot exceed 500 characters'),
    maxLines: z
      .number()
      .int('maxLines must be an integer')
      .min(1, 'maxLines must be at least 1')
      .max(MAX_READ_WORKSPACE_MAX_LINES, `maxLines cannot exceed ${MAX_READ_WORKSPACE_MAX_LINES}`)
      .optional()
  })
  .strict()

export type ReadWorkspaceFileInput = z.infer<typeof readWorkspaceFileInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface WorkspaceFileLine {
  readonly lineNumber: number
  readonly content: string
}

export interface ReadWorkspaceFileResult {
  readonly relativePath: string
  readonly totalLines: number
  readonly linesRead: number
  readonly isTruncated: boolean
  readonly lines: readonly WorkspaceFileLine[]
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class ReadWorkspaceFileTool implements AgentTool<
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult
> {
  public readonly name = 'read_workspace_file' as const
  public readonly description =
    'Read text content and line numbers of a safe file in the authorized workspace.'
  public readonly schema = readWorkspaceFileInputSchema
  public readonly requiredPermission = 'read_workspace_file' as const

  private readonly folderService: WorkspaceFolderService

  constructor(folderService: WorkspaceFolderService) {
    if (!folderService) {
      throw new Error('WorkspaceFolderService is required for ReadWorkspaceFileTool.')
    }
    this.folderService = folderService
  }

  public async execute(
    args: ReadWorkspaceFileInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<ReadWorkspaceFileResult>> {
    // 1. Verify agentRunId presence
    if (!context.agentRunId) {
      throw new ToolExecutionError(
        'Workspace file reading requires an authorized agent run context.',
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 2. Resolve approved canonical root directory
    let canonicalRoot: string
    try {
      canonicalRoot = this.folderService.getApprovedRoot(context.agentRunId, context.botId)
    } catch (err) {
      if (err instanceof WorkspaceSecurityError) {
        throw new ToolExecutionError(err.message, 'EXECUTION_FAILED', this.name)
      }
      throw err
    }

    if (context.signal?.aborted) {
      throw new ToolExecutionError('Operation aborted.', 'ABORTED', this.name)
    }

    // 3. Validate relative path, containment, symlink absence, sensitive checks, extension, and size
    let validationResult: { canonicalPath: string; normalizedRelativePath: string }
    try {
      validationResult = WorkspacePathGuard.validatePath(canonicalRoot, args.relativePath)
    } catch (err) {
      if (err instanceof WorkspaceSecurityError) {
        throw new ToolExecutionError(err.message, 'EXECUTION_FAILED', this.name)
      }
      throw err
    }

    if (context.signal?.aborted) {
      throw new ToolExecutionError('Operation aborted.', 'ABORTED', this.name)
    }

    // 4. Read text strictly as UTF-8
    let content: string
    try {
      content = WorkspacePathGuard.readTextFileStrict(validationResult.canonicalPath)
    } catch (err) {
      if (err instanceof WorkspaceSecurityError) {
        throw new ToolExecutionError(err.message, 'EXECUTION_FAILED', this.name)
      }
      throw err
    }

    // 5. Parse lines and bound by maxLines
    const allLines = content.split(/\r?\n/)
    const effectiveMaxLines = args.maxLines ?? DEFAULT_READ_WORKSPACE_MAX_LINES
    const isTruncated = allLines.length > effectiveMaxLines
    const selectedLines = allLines.slice(0, effectiveMaxLines)

    const lines: WorkspaceFileLine[] = selectedLines.map((lineContent, idx) => ({
      lineNumber: idx + 1,
      content: lineContent
    }))

    const result: ReadWorkspaceFileResult = {
      relativePath: validationResult.normalizedRelativePath,
      totalLines: allLines.length,
      linesRead: lines.length,
      isTruncated,
      lines
    }

    const truncatedNote = isTruncated ? ', truncated' : ''
    return {
      result,
      resultSummary: `Read ${lines.length} line(s) from "${validationResult.normalizedRelativePath}" (total: ${allLines.length} lines${truncatedNote})`
    }
  }
}
