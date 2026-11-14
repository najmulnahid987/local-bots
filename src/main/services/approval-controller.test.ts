import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ApprovalController,
  type ApprovalDecisionContext,
  MAX_CONTENT_PREVIEW_LENGTH
} from './approval-controller'

describe('ApprovalController (Phase 8 Step 8.4)', () => {
  let controller: ApprovalController

  beforeEach(() => {
    controller = new ApprovalController()
  })

  afterEach(() => {
    controller.clear()
    vi.restoreAllMocks()
  })

  describe('request creation and validation', () => {
    it('1. successfully creates a pending approval request with proper metadata and SHA-256 hash', async () => {
      const promise = controller.requestApproval({
        agentRunId: 'run-1',
        botId: 'bot-1',
        title: 'Q4 Financial Report',
        markdownContent: '# Q4 Report\n\nRevenue grew by 25%.',
        timeoutMs: 10_000
      })

      const requests = controller.listRequests('run-1')
      expect(requests).toHaveLength(1)
      const req = requests[0]

      expect(req.agentRunId).toBe('run-1')
      expect(req.botId).toBe('bot-1')
      expect(req.title).toBe('Q4 Financial Report')
      expect(req.status).toBe('pending')
      expect(req.contentPreview).toBe('# Q4 Report\n\nRevenue grew by 25%.')
      expect(req.contentSizeBytes).toBe(
        Buffer.byteLength('# Q4 Report\n\nRevenue grew by 25%.', 'utf-8')
      )
      expect(req.expiresAt).toBeDefined()
      expect(req.expiresAt).toBeGreaterThan(req.createdAt)

      // Approve to complete promise
      controller.approve(req.requestId, { agentRunId: 'run-1', botId: 'bot-1' })
      const decision = await promise
      expect(decision.status).toBe('approved')
    })

    it('2. truncates contentPreview to MAX_CONTENT_PREVIEW_LENGTH (300 chars) with ellipsis', async () => {
      const longContent = 'A'.repeat(500)
      const promise = controller.requestApproval({
        agentRunId: 'run-1',
        botId: 'bot-1',
        title: 'Long Report',
        markdownContent: longContent
      })

      const req = controller.listRequests('run-1')[0]
      expect(req.contentPreview.length).toBe(MAX_CONTENT_PREVIEW_LENGTH + 3)
      expect(req.contentPreview.endsWith('...')).toBe(true)
      expect(req.contentSizeBytes).toBe(500)

      controller.cancel(req.requestId)
      await promise
    })

    it('3. throws error if agentRunId or botId are missing', async () => {
      await expect(
        controller.requestApproval({
          agentRunId: '',
          botId: 'bot-1',
          title: 'Test',
          markdownContent: 'Test'
        })
      ).rejects.toThrow('agentRunId and botId are required')

      await expect(
        controller.requestApproval({
          agentRunId: 'run-1',
          botId: '',
          title: 'Test',
          markdownContent: 'Test'
        })
      ).rejects.toThrow('agentRunId and botId are required')
    })

    it('4. immediately resolves with cancelled status if AbortSignal is already aborted', async () => {
      const abortController = new AbortController()
      abortController.abort()

      const decision = await controller.requestApproval({
        agentRunId: 'run-1',
        botId: 'bot-1',
        title: 'Test',
        markdownContent: 'Test',
        signal: abortController.signal
      })

      expect(decision.status).toBe('cancelled')
      expect(controller.listRequests('run-1')).toHaveLength(0)
    })
  })

  describe('approval workflow', () => {
    const context: ApprovalDecisionContext = {
      agentRunId: 'run-123',
      botId: 'bot-456'
    }

    it('5. resolves pending promise with status approved on valid caller context', async () => {
      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Approved Report',
        markdownContent: 'Report content here.'
      })

      const req = controller.listRequests(context.agentRunId)[0]
      const approved = controller.approve(req.requestId, context)
      expect(approved).toBe(true)

      const decision = await requestPromise
      expect(decision.status).toBe('approved')
      expect(decision.requestId).toBe(req.requestId)

      const updatedDto = controller.getRequest(req.requestId)
      expect(updatedDto?.status).toBe('approved')
    })

    it('6. rejects approval attempt if caller context has mismatched agentRunId or botId', async () => {
      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Mismatch Test',
        markdownContent: 'Content'
      })

      const req = controller.listRequests(context.agentRunId)[0]

      // Wrong botId
      const approvedWrongBot = controller.approve(req.requestId, {
        agentRunId: context.agentRunId,
        botId: 'different-bot'
      })
      expect(approvedWrongBot).toBe(false)

      // Wrong agentRunId
      const approvedWrongRun = controller.approve(req.requestId, {
        agentRunId: 'different-run',
        botId: context.botId
      })
      expect(approvedWrongRun).toBe(false)

      // Request remains pending
      expect(controller.getRequest(req.requestId)?.status).toBe('pending')

      // Now approve with correct context
      controller.approve(req.requestId, context)
      const decision = await requestPromise
      expect(decision.status).toBe('approved')
    })

    it('7. returns false when approving a non-existent or already finalized request', async () => {
      expect(controller.approve('non-existent-id', context)).toBe(false)

      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Duplicate Test',
        markdownContent: 'Content'
      })

      const req = controller.listRequests(context.agentRunId)[0]
      expect(controller.approve(req.requestId, context)).toBe(true)
      await requestPromise

      // Second approval attempt on already approved request must return false
      expect(controller.approve(req.requestId, context)).toBe(false)
    })
  })

  describe('rejection workflow', () => {
    const context: ApprovalDecisionContext = {
      agentRunId: 'run-123',
      botId: 'bot-456'
    }

    it('8. resolves pending promise with status rejected and purges raw content from memory', async () => {
      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Rejection Test',
        markdownContent: 'Secret draft data that should be purged'
      })

      const req = controller.listRequests(context.agentRunId)[0]
      const rejected = controller.reject(req.requestId, context, 'Report lacks sufficient analysis')
      expect(rejected).toBe(true)

      const decision = await requestPromise
      expect(decision.status).toBe('rejected')
      expect(decision.reason).toBe('Report lacks sufficient analysis')

      const updatedDto = controller.getRequest(req.requestId)
      expect(updatedDto?.status).toBe('rejected')
      expect(updatedDto?.decisionReason).toBe('Report lacks sufficient analysis')

      // Content must NOT be retrievable
      const content = controller.getApprovedContent(req.requestId, context)
      expect(content).toBeNull()
    })

    it('9. reject returns false if caller context does not match', async () => {
      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Mismatch Test',
        markdownContent: 'Content'
      })

      const req = controller.listRequests(context.agentRunId)[0]
      const rejected = controller.reject(req.requestId, {
        agentRunId: 'wrong',
        botId: context.botId
      })
      expect(rejected).toBe(false)

      controller.cancel(req.requestId)
      await requestPromise
    })
  })

  describe('cancellation and abort handling', () => {
    const context: ApprovalDecisionContext = {
      agentRunId: 'run-999',
      botId: 'bot-999'
    }

    it('10. cancel resolves pending request with status cancelled and purges raw content', async () => {
      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Cancel Test',
        markdownContent: 'Sensitive markdown content'
      })

      const req = controller.listRequests(context.agentRunId)[0]
      const cancelled = controller.cancel(req.requestId, 'User clicked Cancel')
      expect(cancelled).toBe(true)

      const decision = await requestPromise
      expect(decision.status).toBe('cancelled')
      expect(decision.reason).toBe('User clicked Cancel')

      expect(controller.getApprovedContent(req.requestId, context)).toBeNull()
    })

    it('11. cancelForRun cancels all pending requests belonging to a specific agent run', async () => {
      const p1 = controller.requestApproval({
        agentRunId: 'run-batch',
        botId: 'bot-1',
        title: 'Report 1',
        markdownContent: 'Content 1'
      })
      const p2 = controller.requestApproval({
        agentRunId: 'run-batch',
        botId: 'bot-1',
        title: 'Report 2',
        markdownContent: 'Content 2'
      })
      const pOther = controller.requestApproval({
        agentRunId: 'run-other',
        botId: 'bot-2',
        title: 'Report Other',
        markdownContent: 'Content Other'
      })

      const cancelledCount = controller.cancelForRun('run-batch', 'Agent run stopped')
      expect(cancelledCount).toBe(2)

      const [d1, d2] = await Promise.all([p1, p2])
      expect(d1.status).toBe('cancelled')
      expect(d2.status).toBe('cancelled')

      // Other run must remain pending
      const otherReq = controller.listRequests('run-other')[0]
      expect(otherReq.status).toBe('pending')

      controller.cancel(otherReq.requestId)
      await pOther
    })

    it('12. AbortSignal abort event cancels pending request immediately', async () => {
      const abortController = new AbortController()

      const requestPromise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'AbortSignal Test',
        markdownContent: 'Abort me',
        signal: abortController.signal
      })

      const req = controller.listRequests(context.agentRunId)[0]
      expect(req.status).toBe('pending')

      abortController.abort()

      const decision = await requestPromise
      expect(decision.status).toBe('cancelled')
      expect(decision.reason).toContain('aborted')

      const updatedDto = controller.getRequest(req.requestId)
      expect(updatedDto?.status).toBe('cancelled')
    })
  })

  describe('expiration / timeout handling', () => {
    it('13. transitions request to expired when timeout fires and purges content', async () => {
      vi.useFakeTimers()

      try {
        const promise = controller.requestApproval({
          agentRunId: 'run-timeout',
          botId: 'bot-timeout',
          title: 'Expiring Report',
          markdownContent: 'Will expire soon',
          timeoutMs: 5000
        })

        const req = controller.listRequests('run-timeout')[0]
        expect(req.status).toBe('pending')

        // Fast-forward past timeout
        vi.advanceTimersByTime(5001)

        const decision = await promise
        expect(decision.status).toBe('expired')
        expect(decision.reason).toContain('timed out')

        const updated = controller.getRequest(req.requestId)
        expect(updated?.status).toBe('expired')

        // Content must be purged
        expect(
          controller.getApprovedContent(req.requestId, {
            agentRunId: 'run-timeout',
            botId: 'bot-timeout'
          })
        ).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('content security and consumption', () => {
    const context: ApprovalDecisionContext = {
      agentRunId: 'run-sec',
      botId: 'bot-sec'
    }

    it('14. getApprovedContent returns content and SHA-256 hash only when approved and caller verified', async () => {
      const markdown = '# Financial Summary\n\nAll metrics green.'
      const promise = controller.requestApproval({
        agentRunId: context.agentRunId,
        botId: context.botId,
        title: 'Financial Summary',
        markdownContent: markdown
      })

      const req = controller.listRequests(context.agentRunId)[0]

      // Not approved yet -> returns null
      expect(controller.getApprovedContent(req.requestId, context)).toBeNull()

      controller.approve(req.requestId, context)
      await promise

      // Approved with matching context -> returns exact content and hash
      const approvedData = controller.getApprovedContent(req.requestId, context)
      expect(approvedData).not.toBeNull()
      expect(approvedData?.content).toBe(markdown)
      expect(approvedData?.contentHash).toHaveLength(64)

      // Wrong botId -> returns null
      expect(
        controller.getApprovedContent(req.requestId, {
          agentRunId: context.agentRunId,
          botId: 'intruder-bot'
        })
      ).toBeNull()

      // Consume content
      controller.consumeContent(req.requestId)
      const afterConsume = controller.getApprovedContent(req.requestId, context)
      expect(afterConsume?.content).toBe('')
    })
  })
})
