// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { SaveReportApprovalModal } from './SaveReportApprovalModal'
import type { ApprovalDetailsDto } from '../../../../shared/agents'

describe('Renderer: SaveReportApprovalModal (Human in the loop report approval)', () => {
  const sampleApproval: ApprovalDetailsDto = {
    requestId: 'req-1111-2222',
    agentRunId: 'run-3333-4444',
    botId: 'bot-01',
    title: 'Financial Q4 Executive Summary',
    markdownContent: '# Summary\n\n- Revenue: $1.2M\n- Net Profit: 24%',
    contentSizeBytes: 1024,
    createdAt: 1700000000000,
    expiresAt: 1700000300000,
    status: 'pending'
  }

  beforeEach(() => {
    window.api = {
      agents: {
        getApprovalDetails: vi.fn(async () => sampleApproval),
        respondToApproval: vi.fn(async () => ({
          success: true,
          requestId: sampleApproval.requestId,
          status: 'approved' as const
        }))
      }
    } as never
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not render when isOpen is false', () => {
    render(
      <SaveReportApprovalModal
        isOpen={false}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByTestId('save-report-approval-modal')).toBeNull()
  })

  it('loads and renders approval details and markdown preview safely', async () => {
    render(
      <SaveReportApprovalModal
        isOpen={true}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('save-report-title')).toBeDefined()
    })

    expect(screen.getByText('Approve Report: Financial Q4 Executive Summary')).toBeDefined()
    expect(screen.getByTestId('report-content-size').textContent).toContain('1.0 KB')
    expect(screen.getByTestId('report-markdown-preview')).toBeDefined()
    expect(screen.getByText('Summary')).toBeDefined()
    expect(screen.getByText('Revenue: $1.2M')).toBeDefined()
  })

  it('approves report and invokes onDecisionSubmitted with approve', async () => {
    const handleClose = vi.fn()
    const handleSubmitted = vi.fn()

    render(
      <SaveReportApprovalModal
        isOpen={true}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={handleClose}
        onDecisionSubmitted={handleSubmitted}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('approve-report-btn')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('approve-report-btn'))

    await waitFor(() => {
      expect(window.api.agents!.respondToApproval).toHaveBeenCalledWith({
        agentRunId: 'run-3333-4444',
        approvalRequestId: 'req-1111-2222',
        decision: 'approve',
        reason: undefined
      })
      expect(handleSubmitted).toHaveBeenCalledWith('approve')
      expect(handleClose).toHaveBeenCalled()
    })
  })

  it('rejects report with optional reason and invokes onDecisionSubmitted with reject', async () => {
    ;(window.api.agents!.respondToApproval as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      requestId: sampleApproval.requestId,
      status: 'rejected'
    })

    const handleClose = vi.fn()
    const handleSubmitted = vi.fn()

    render(
      <SaveReportApprovalModal
        isOpen={true}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={handleClose}
        onDecisionSubmitted={handleSubmitted}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('reject-report-btn')).toBeDefined()
    })

    const reasonInput = screen.getByTestId('rejection-reason-input')
    fireEvent.change(reasonInput, { target: { value: 'Incomplete financial data' } })

    fireEvent.click(screen.getByTestId('reject-report-btn'))

    await waitFor(() => {
      expect(window.api.agents!.respondToApproval).toHaveBeenCalledWith({
        agentRunId: 'run-3333-4444',
        approvalRequestId: 'req-1111-2222',
        decision: 'reject',
        reason: 'Incomplete financial data'
      })
      expect(handleSubmitted).toHaveBeenCalledWith('reject')
      expect(handleClose).toHaveBeenCalled()
    })
  })

  it('displays error message when approval details fetch fails', async () => {
    ;(window.api.agents!.getApprovalDetails as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Approval request has expired.')
    )

    render(
      <SaveReportApprovalModal
        isOpen={true}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('report-details-error')).toBeDefined()
      expect(screen.getByText('Approval request has expired.')).toBeDefined()
    })
  })

  it('closes on Escape key press without approving', async () => {
    const handleClose = vi.fn()

    render(
      <SaveReportApprovalModal
        isOpen={true}
        agentRunId="run-3333-4444"
        approvalRequestId="req-1111-2222"
        onClose={handleClose}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('save-report-approval-modal')).toBeDefined()
    })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(handleClose).toHaveBeenCalled()
    expect(window.api.agents!.respondToApproval).not.toHaveBeenCalled()
  })
})
