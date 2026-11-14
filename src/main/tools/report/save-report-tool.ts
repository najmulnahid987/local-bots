import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import {
  dialog,
  type BrowserWindow,
  type SaveDialogOptions,
  type SaveDialogReturnValue
} from 'electron'
import { z } from 'zod'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import { ToolExecutionError } from '../agent-tool'
import type { ApprovalController, ApprovalStatus } from '../../services/approval-controller'
import type { BrowserWindowLike } from '../../services/workspace-folder-service'

// ============================================================================
// Limits & Types
// ============================================================================

export const MAX_REPORT_TITLE_LENGTH = 120
export const MAX_REPORT_CONTENT_BYTES = 256 * 1024 // 256 KB

export interface SaveReportDialogOperations {
  showSaveDialog(
    browserWindow: BrowserWindowLike | BrowserWindow,
    options: SaveDialogOptions
  ): Promise<SaveDialogReturnValue>
}

// ============================================================================
// Input Schema
// ============================================================================

export const saveReportInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Report title cannot be empty')
      .max(
        MAX_REPORT_TITLE_LENGTH,
        `Report title cannot exceed ${MAX_REPORT_TITLE_LENGTH} characters`
      ),
    markdownContent: z
      .string()
      .min(1, 'Report markdown content cannot be empty')
      .refine(
        (val) => Buffer.byteLength(val, 'utf-8') <= MAX_REPORT_CONTENT_BYTES,
        `Report content exceeds maximum limit of 256 KB`
      )
  })
  .strict()

export type SaveReportInput = z.infer<typeof saveReportInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface SaveReportResult {
  readonly status: 'saved' | 'rejected' | 'cancelled' | 'expired'
  readonly title: string
  readonly fileName?: string
  readonly bytesWritten?: number
  readonly approvalStatus: ApprovalStatus
  readonly message?: string
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class SaveReportTool implements AgentTool<SaveReportInput, SaveReportResult> {
  public readonly name = 'save_report' as const
  public readonly description =
    'Request human approval to save an analytical Markdown report via native Save As dialog.'
  public readonly schema = saveReportInputSchema
  public readonly requiredPermission = 'save_report' as const

  private readonly approvalController: ApprovalController
  private readonly dialogOps?: SaveReportDialogOperations
  private readonly getMainWindow?: () => BrowserWindowLike | BrowserWindow | null

  constructor(
    approvalController: ApprovalController,
    dialogOps?: SaveReportDialogOperations,
    getMainWindow?: () => BrowserWindowLike | BrowserWindow | null
  ) {
    if (!approvalController) {
      throw new Error('ApprovalController is required for SaveReportTool.')
    }
    this.approvalController = approvalController
    this.dialogOps = dialogOps
    this.getMainWindow = getMainWindow
  }

  public async execute(
    args: SaveReportInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<SaveReportResult>> {
    // 1. Verify agent run and bot context
    if (!context.agentRunId || !context.botId) {
      throw new ToolExecutionError(
        'save_report requires an authorized agentRunId and botId context.',
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 2. Request explicit human approval before any filesystem action
    const decision = await this.approvalController.requestApproval({
      agentRunId: context.agentRunId,
      botId: context.botId,
      title: args.title,
      markdownContent: args.markdownContent,
      signal: context.signal
    })

    // 3. Handle non-approved decisions (rejected, cancelled, expired)
    if (decision.status !== 'approved') {
      const message =
        decision.reason ??
        (decision.status === 'rejected'
          ? 'User rejected report saving.'
          : decision.status === 'cancelled'
            ? 'Report saving was cancelled.'
            : 'Report approval timed out.')

      const result: SaveReportResult = {
        status: decision.status,
        title: args.title,
        approvalStatus: decision.status,
        message
      }

      return {
        result,
        resultSummary: `Report saving was ${decision.status}: "${args.title}"`
      }
    }

    // 4. Retrieve approved content from private memory
    const approvedData = this.approvalController.getApprovedContent(decision.requestId, {
      agentRunId: context.agentRunId,
      botId: context.botId
    })

    if (!approvedData) {
      throw new ToolExecutionError(
        'Approved report content was not found or has been purged.',
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 5. Verify content integrity hash against the approved request
    const computedHash = createHash('sha256').update(approvedData.content).digest('hex')
    if (computedHash !== approvedData.contentHash) {
      this.approvalController.consumeContent(decision.requestId)
      throw new ToolExecutionError(
        'Report content integrity verification failed. Saved content does not match approved request.',
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 6. Check cancellation before triggering native Save As dialog
    if (context.signal?.aborted) {
      this.approvalController.consumeContent(decision.requestId)
      throw new ToolExecutionError('Operation aborted.', 'ABORTED', this.name)
    }

    // 7. Prompt user with native Save As dialog in Main process
    const openDialogFn = this.dialogOps?.showSaveDialog ?? dialog.showSaveDialog
    const mainWindow = this.getMainWindow?.() ?? null

    const sanitizedTitle = args.title
      .replace(/[\\/:*?"<>|]/g, '-')
      .trim()
      .slice(0, 60)
    const suggestedFileName = `${sanitizedTitle || 'report'}.md`

    let dialogResult: SaveDialogReturnValue
    try {
      dialogResult = await openDialogFn(mainWindow as BrowserWindow, {
        title: 'Save Generated Report As',
        defaultPath: suggestedFileName,
        buttonLabel: 'Save Report',
        filters: [{ name: 'Markdown Document', extensions: ['md'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent']
      })
    } catch (err) {
      this.approvalController.consumeContent(decision.requestId)
      throw new ToolExecutionError(
        `Failed to open native Save As dialog: ${err instanceof Error ? err.message : String(err)}`,
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 8. Handle dialog cancellation
    if (dialogResult.canceled || !dialogResult.filePath) {
      this.approvalController.consumeContent(decision.requestId)
      const result: SaveReportResult = {
        status: 'cancelled',
        title: args.title,
        approvalStatus: 'approved',
        message: 'User cancelled destination file selection in Save As dialog.'
      }
      return {
        result,
        resultSummary: `User cancelled Save As dialog for report "${args.title}"`
      }
    }

    // 9. Normalize destination path and ensure .md extension
    let destinationPath = dialogResult.filePath
    if (!destinationPath.toLowerCase().endsWith('.md')) {
      destinationPath += '.md'
    }

    // 10. Check cancellation before filesystem write
    if (context.signal?.aborted) {
      this.approvalController.consumeContent(decision.requestId)
      throw new ToolExecutionError('Operation aborted before writing file.', 'ABORTED', this.name)
    }

    // 11. Exclusive file writing ('wx' flag prevents silent overwrites)
    let fd: number | null = null
    const buffer = Buffer.from(approvedData.content, 'utf-8')

    try {
      fd = fs.openSync(destinationPath, 'wx')
      fs.writeSync(fd, buffer)
      fs.fsyncSync(fd)
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'EEXIST'
      ) {
        throw new ToolExecutionError(
          `Destination file already exists: '${path.basename(destinationPath)}'. Overwriting existing files is prohibited.`,
          'EXECUTION_FAILED',
          this.name
        )
      }

      // Cleanup newly created partial file on unexpected failure
      if (fd !== null) {
        try {
          fs.unlinkSync(destinationPath)
        } catch {
          // Ignore cleanup error
        }
      }

      throw new ToolExecutionError(
        `Failed to write report file: ${err instanceof Error ? err.message : String(err)}`,
        'EXECUTION_FAILED',
        this.name
      )
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Ignore close error
        }
      }
      this.approvalController.consumeContent(decision.requestId)
    }

    // 12. Return safe result with basename only
    const safeFileName = path.basename(destinationPath)
    const result: SaveReportResult = {
      status: 'saved',
      title: args.title,
      fileName: safeFileName,
      bytesWritten: buffer.length,
      approvalStatus: 'approved'
    }

    return {
      result,
      resultSummary: `Saved report "${args.title}" to file "${safeFileName}" (${buffer.length} bytes)`
    }
  }
}
