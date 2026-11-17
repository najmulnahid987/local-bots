// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TaskActivityTimeline } from './TaskActivityTimeline'
import type { ReconciledToolActivity } from '../../hooks/useAgentTaskEvents'

describe('Renderer: TaskActivityTimeline', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleToolActivities: ReconciledToolActivity[] = [
    {
      id: 'act-1',
      sequenceNumber: 1,
      toolName: 'search_knowledge_base',
      status: 'completed',
      argumentsSummary: '{"query":"contract clauses"}',
      resultSummary: 'Found 2 matching clauses.',
      errorMessage: null,
      durationMs: 320
    },
    {
      id: 'act-2',
      sequenceNumber: 2,
      toolName: 'read_workspace_file',
      status: 'completed',
      argumentsSummary: '{"targetPath":"terms.md"}',
      resultSummary: 'Read 45 lines from terms.md',
      errorMessage: null,
      durationMs: 180
    }
  ]

  it('renders timeline with running status, iteration step, and tool cards', () => {
    const handleStop = vi.fn()

    render(
      <TaskActivityTimeline
        agentRunId="run-1234"
        status="running"
        iteration={2}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        startedAt={Date.now() - 5000}
        onStop={handleStop}
      />
    )

    expect(screen.getByTestId('task-timeline-run-1234')).toBeDefined()
    expect(screen.getByTestId('timeline-iteration-run-1234').textContent).toContain('Step 2/5')
    expect(screen.getByTestId('stop-task-btn-run-1234')).toBeDefined()

    // Invoking stop button
    fireEvent.click(screen.getByTestId('stop-task-btn-run-1234'))
    expect(handleStop).toHaveBeenCalled()

    // Tool cards rendered
    expect(screen.getByText('Search Knowledge Base')).toBeDefined()
    expect(screen.getByText('Read Workspace File')).toBeDefined()
  })

  it('renders pending approval banner and invokes onReviewApproval', () => {
    const handleReview = vi.fn()

    render(
      <TaskActivityTimeline
        agentRunId="run-5678"
        status="waiting_approval"
        iteration={3}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        onReviewApproval={handleReview}
        hasPendingApproval={true}
      />
    )

    expect(screen.getByTestId('pending-approval-banner-run-5678')).toBeDefined()
    const reviewBtn = screen.getByTestId('review-approval-btn-run-5678')
    expect(reviewBtn).toBeDefined()

    fireEvent.click(reviewBtn)
    expect(handleReview).toHaveBeenCalled()
  })

  it('renders error banner when errorSummary is provided', () => {
    render(
      <TaskActivityTimeline
        agentRunId="run-fail"
        status="failed"
        iteration={1}
        maxIterations={5}
        errorSummary="Maximum 5 tool execution iterations exceeded without conclusion."
      />
    )

    expect(screen.getByTestId('timeline-error-run-fail')).toBeDefined()
    expect(
      screen.getByText('Maximum 5 tool execution iterations exceeded without conclusion.')
    ).toBeDefined()
  })

  it('toggles expansion of timeline content', () => {
    render(
      <TaskActivityTimeline
        agentRunId="run-toggle"
        status="completed"
        iteration={2}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        defaultExpanded={true}
      />
    )

    expect(screen.getByText('Search Knowledge Base')).toBeDefined()

    const toggleBtn = screen.getByTestId('timeline-toggle-run-toggle')
    fireEvent.click(toggleBtn)

    expect(screen.queryByText('Search Knowledge Base')).toBeNull()
  })

  it('renders save memory action banner when status is completed and onSaveAsMemory is provided', () => {
    const handleSaveAsMemory = vi.fn()

    render(
      <TaskActivityTimeline
        agentRunId="run-done-1"
        status="completed"
        iteration={3}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        onSaveAsMemory={handleSaveAsMemory}
      />
    )

    expect(screen.getByTestId('timeline-save-memory-banner-run-done-1')).toBeDefined()
    expect(screen.getByText(/Save key findings to this Bot's persistent memory\?/)).toBeDefined()

    const saveBtn = screen.getByTestId('save-task-memory-btn-run-done-1')
    expect(saveBtn).toBeDefined()

    fireEvent.click(saveBtn)
    expect(handleSaveAsMemory).toHaveBeenCalledTimes(1)
  })

  it('does not render save memory banner when status is running or failed', () => {
    const handleSaveAsMemory = vi.fn()

    const { rerender } = render(
      <TaskActivityTimeline
        agentRunId="run-running-1"
        status="running"
        iteration={1}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        onSaveAsMemory={handleSaveAsMemory}
      />
    )

    expect(screen.queryByTestId('timeline-save-memory-banner-run-running-1')).toBeNull()

    rerender(
      <TaskActivityTimeline
        agentRunId="run-failed-1"
        status="failed"
        iteration={2}
        maxIterations={5}
        toolActivities={sampleToolActivities}
        onSaveAsMemory={handleSaveAsMemory}
      />
    )

    expect(screen.queryByTestId('timeline-save-memory-banner-run-failed-1')).toBeNull()
  })
})
