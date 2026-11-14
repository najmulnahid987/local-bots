import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { SaveDialogReturnValue } from 'electron'
import {
  SaveReportTool,
  saveReportInputSchema,
  MAX_REPORT_TITLE_LENGTH,
  MAX_REPORT_CONTENT_BYTES,
  type SaveReportDialogOperations
} from './save-report-tool'
import { ApprovalController } from '../../services/approval-controller'
import { ToolExecutionError, type ToolExecutionContext } from '../agent-tool'

describe('SaveReportTool (Phase 8 Step 8.4)', () => {
  let approvalController: ApprovalController
  let tool: SaveReportTool
  let testOutputDir: string
  let mockDialogOps: SaveReportDialogOperations
  let mockDialogReturnValue: SaveDialogReturnValue

  const validContext: ToolExecutionContext = {
    botId: 'bot-report-1',
    knowledgeBaseId: 'kb-report-1',
    agentRunId: 'run-report-1'
  }

  beforeEach(() => {
    approvalController = new ApprovalController()
    testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-report-test-'))

    mockDialogReturnValue = {
      canceled: false,
      filePath: path.join(testOutputDir, 'output-report.md')
    }

    mockDialogOps = {
      showSaveDialog: vi.fn(async () => mockDialogReturnValue)
    }

    tool = new SaveReportTool(approvalController, mockDialogOps)
  })

  afterEach(() => {
    approvalController.clear()
    try {
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks()
  })

  describe('schema validation', () => {
    it('1. accepts valid report title and markdown content', () => {
      const parsed = saveReportInputSchema.parse({
        title: 'Quarterly Executive Summary',
        markdownContent: '# Summary\n\nPerformance highlights for Q3.'
      })
      expect(parsed.title).toBe('Quarterly Executive Summary')
      expect(parsed.markdownContent).toContain('Performance highlights')
    })

    it('2. rejects empty or whitespace-only title', () => {
      expect(() =>
        saveReportInputSchema.parse({
          title: '',
          markdownContent: '# Valid content'
        })
      ).toThrow('Report title cannot be empty')

      expect(() =>
        saveReportInputSchema.parse({
          title: '   ',
          markdownContent: '# Valid content'
        })
      ).toThrow('Report title cannot be empty')
    })

    it('3. rejects title exceeding MAX_REPORT_TITLE_LENGTH (120 chars)', () => {
      const longTitle = 'T'.repeat(MAX_REPORT_TITLE_LENGTH + 1)
      expect(() =>
        saveReportInputSchema.parse({
          title: longTitle,
          markdownContent: '# Valid content'
        })
      ).toThrow(`Report title cannot exceed ${MAX_REPORT_TITLE_LENGTH} characters`)
    })

    it('4. rejects empty markdownContent', () => {
      expect(() =>
        saveReportInputSchema.parse({
          title: 'Valid Title',
          markdownContent: ''
        })
      ).toThrow('Report markdown content cannot be empty')
    })

    it('5. rejects markdownContent exceeding 256 KB', () => {
      const largeContent = 'A'.repeat(MAX_REPORT_CONTENT_BYTES + 1)
      expect(() =>
        saveReportInputSchema.parse({
          title: 'Valid Title',
          markdownContent: largeContent
        })
      ).toThrow('Report content exceeds maximum limit of 256 KB')
    })

    it('6. rejects unexpected fields (strict schema blocks model-proposed paths)', () => {
      expect(() =>
        saveReportInputSchema.parse({
          title: 'Valid Title',
          markdownContent: 'Content',
          outputPath: 'C:/Windows/malicious.md'
        } as unknown)
      ).toThrow()

      expect(() =>
        saveReportInputSchema.parse({
          title: 'Valid Title',
          markdownContent: 'Content',
          destinationPath: '/etc/passwd'
        } as unknown)
      ).toThrow()
    })
  })

  describe('execution context authorization', () => {
    it('7. rejects execution if agentRunId is missing', async () => {
      const invalidContext: ToolExecutionContext = {
        botId: 'bot-1',
        knowledgeBaseId: 'kb-1'
      }

      await expect(
        tool.execute({ title: 'Test Report', markdownContent: 'Content' }, invalidContext)
      ).rejects.toThrow('save_report requires an authorized agentRunId and botId context.')
    })

    it('8. rejects execution if botId is missing', async () => {
      const invalidContext = {
        knowledgeBaseId: 'kb-1',
        agentRunId: 'run-1'
      } as unknown as ToolExecutionContext

      await expect(
        tool.execute({ title: 'Test Report', markdownContent: 'Content' }, invalidContext)
      ).rejects.toThrow('save_report requires an authorized agentRunId and botId context.')
    })
  })

  describe('human approval gate & decisions', () => {
    it('9. returns rejected result when user explicitly rejects the report', async () => {
      const executePromise = tool.execute(
        { title: 'Rejected Report', markdownContent: 'Draft content' },
        validContext
      )

      // Retrieve pending request from controller and reject it
      const requests = approvalController.listRequests(validContext.agentRunId)
      expect(requests).toHaveLength(1)

      approvalController.reject(
        requests[0].requestId,
        { agentRunId: validContext.agentRunId!, botId: validContext.botId },
        'User rejected: incomplete metrics'
      )

      const output = await executePromise
      expect(output.result.status).toBe('rejected')
      expect(output.result.approvalStatus).toBe('rejected')
      expect(output.result.message).toBe('User rejected: incomplete metrics')
      expect(output.result.fileName).toBeUndefined()

      // Verify no file was written
      expect(mockDialogOps.showSaveDialog).not.toHaveBeenCalled()
      expect(fs.readdirSync(testOutputDir)).toHaveLength(0)
    })

    it('10. returns cancelled result when approval request is cancelled', async () => {
      const executePromise = tool.execute(
        { title: 'Cancelled Report', markdownContent: 'Draft content' },
        validContext
      )

      const requests = approvalController.listRequests(validContext.agentRunId)
      approvalController.cancel(requests[0].requestId, 'Agent run was stopped')

      const output = await executePromise
      expect(output.result.status).toBe('cancelled')
      expect(output.result.approvalStatus).toBe('cancelled')
      expect(output.result.message).toBe('Agent run was stopped')

      expect(mockDialogOps.showSaveDialog).not.toHaveBeenCalled()
      expect(fs.readdirSync(testOutputDir)).toHaveLength(0)
    })

    it('11. returns cancelled result when user cancels native Save As dialog', async () => {
      // Mock dialog cancellation
      mockDialogReturnValue = { canceled: true, filePath: '' }

      const executePromise = tool.execute(
        { title: 'Dialog Cancelled Report', markdownContent: '# Summary\n\nCancelled by user' },
        validContext
      )

      const requests = approvalController.listRequests(validContext.agentRunId)
      approvalController.approve(requests[0].requestId, {
        agentRunId: validContext.agentRunId!,
        botId: validContext.botId
      })

      const output = await executePromise
      expect(output.result.status).toBe('cancelled')
      expect(output.result.approvalStatus).toBe('approved')
      expect(output.result.message).toContain('User cancelled destination file selection')

      // No file created
      expect(fs.readdirSync(testOutputDir)).toHaveLength(0)
    })
  })

  describe('successful save and exclusive file writing', () => {
    it('12. writes approved markdown content to chosen destination and returns safe basename only', async () => {
      const targetFilePath = path.join(testOutputDir, 'quarterly-report.md')
      mockDialogReturnValue = { canceled: false, filePath: targetFilePath }

      const reportTitle = 'Quarterly Executive Summary'
      const markdown = '# Summary\n\nRevenue grew by 18% in Q3.'

      const executePromise = tool.execute(
        { title: reportTitle, markdownContent: markdown },
        validContext
      )

      const requests = approvalController.listRequests(validContext.agentRunId)
      approvalController.approve(requests[0].requestId, {
        agentRunId: validContext.agentRunId!,
        botId: validContext.botId
      })

      const output = await executePromise
      expect(output.result.status).toBe('saved')
      expect(output.result.approvalStatus).toBe('approved')
      expect(output.result.title).toBe(reportTitle)
      expect(output.result.fileName).toBe('quarterly-report.md') // Basename only!
      expect(output.result.fileName).not.toContain(testOutputDir) // No absolute path leaked
      expect(output.result.bytesWritten).toBe(Buffer.byteLength(markdown, 'utf-8'))

      // Verify file was actually written to disk with exact content
      expect(fs.existsSync(targetFilePath)).toBe(true)
      const fileOnDisk = fs.readFileSync(targetFilePath, 'utf-8')
      expect(fileOnDisk).toBe(markdown)

      // Verify private memory content was consumed
      const contentInController = approvalController.getApprovedContent(requests[0].requestId, {
        agentRunId: validContext.agentRunId!,
        botId: validContext.botId
      })
      expect(contentInController?.content).toBe('')
    })

    it('13. automatically appends .md extension if dialog returns filename without .md', async () => {
      const targetFilePath = path.join(testOutputDir, 'report-no-ext')
      mockDialogReturnValue = { canceled: false, filePath: targetFilePath }

      const executePromise = tool.execute(
        { title: 'No Ext Report', markdownContent: 'Content without extension' },
        validContext
      )

      const requests = approvalController.listRequests(validContext.agentRunId)
      approvalController.approve(requests[0].requestId, {
        agentRunId: validContext.agentRunId!,
        botId: validContext.botId
      })

      const output = await executePromise
      expect(output.result.status).toBe('saved')
      expect(output.result.fileName).toBe('report-no-ext.md')
      expect(fs.existsSync(path.join(testOutputDir, 'report-no-ext.md'))).toBe(true)
    })

    it('14. prevents silent overwrite when destination file already exists (EEXIST collision guard)', async () => {
      const existingFilePath = path.join(testOutputDir, 'existing-report.md')
      fs.writeFileSync(existingFilePath, 'ORIGINAL SENSITIVE CONTENT', 'utf-8')

      mockDialogReturnValue = { canceled: false, filePath: existingFilePath }

      const executePromise = tool.execute(
        { title: 'Collision Report', markdownContent: 'NEW OVERWRITE ATTEMPT' },
        validContext
      )

      const requests = approvalController.listRequests(validContext.agentRunId)
      approvalController.approve(requests[0].requestId, {
        agentRunId: validContext.agentRunId!,
        botId: validContext.botId
      })

      await expect(executePromise).rejects.toThrow(ToolExecutionError)
      await expect(executePromise).rejects.toThrow(
        "Destination file already exists: 'existing-report.md'. Overwriting existing files is prohibited."
      )

      // Crucial: original file must not be modified or truncated
      const contentAfter = fs.readFileSync(existingFilePath, 'utf-8')
      expect(contentAfter).toBe('ORIGINAL SENSITIVE CONTENT')
    })

    it('15. aborts execution if AbortSignal is triggered before file write', async () => {
      const abortController = new AbortController()
      const contextWithSignal: ToolExecutionContext = {
        ...validContext,
        signal: abortController.signal
      }

      const executePromise = tool.execute(
        { title: 'Abort Signal Report', markdownContent: 'Content to abort' },
        contextWithSignal
      )

      // Trigger abort while pending approval
      abortController.abort()

      const output = await executePromise
      expect(output.result.status).toBe('cancelled')
      expect(fs.readdirSync(testOutputDir)).toHaveLength(0)
    })
  })
})
