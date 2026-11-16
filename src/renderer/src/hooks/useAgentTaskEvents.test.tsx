// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAgentTaskEvents } from './useAgentTaskEvents'
import type { AgentStreamEvent } from '../../../shared/agents'

describe('Renderer: useAgentTaskEvents hook', () => {
  let streamListener: ((event: AgentStreamEvent) => void) | null = null
  let unsubscribeMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    unsubscribeMock = vi.fn()
    streamListener = null

    window.api = {
      agents: {
        getRun: vi.fn(),
        listRuns: vi.fn(),
        listToolEvents: vi.fn(),
        getApprovalDetails: vi.fn(async (req) => ({
          requestId: req.approvalRequestId,
          agentRunId: req.agentRunId,
          botId: 'bot-01',
          title: 'Project Budget Report',
          markdownContent: '# Budget',
          contentSizeBytes: 2048,
          createdAt: Date.now(),
          status: 'pending' as const
        })),
        respondToApproval: vi.fn(),
        dispatchTask: vi.fn(),
        cancelTask: vi.fn(),
        subscribeToTaskEvents: vi.fn(
          (_runId: string, listener: (event: AgentStreamEvent) => void) => {
            streamListener = listener
            return unsubscribeMock
          }
        )
      }
    } as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('subscribes to task event stream and reconciles tool lifecycle', async () => {
    const onCompleted = vi.fn()
    const { result } = renderHook(() =>
      useAgentTaskEvents({
        agentRunId: 'run-stream-01',
        onRunCompleted: onCompleted
      })
    )

    expect(window.api.agents!.subscribeToTaskEvents).toHaveBeenCalledWith(
      'run-stream-01',
      expect.any(Function)
    )

    // Emit tool_call_started
    act(() => {
      streamListener?.({
        type: 'tool_call_started',
        agentRunId: 'run-stream-01',
        sequenceNumber: 1,
        timestamp: 1000,
        toolEventId: 'call-01',
        toolName: 'search_knowledge_base',
        argumentsSummary: '{"query":"operating budget"}'
      })
    })

    expect(result.current.toolActivities.length).toBe(1)
    expect(result.current.toolActivities[0].toolName).toBe('search_knowledge_base')
    expect(result.current.toolActivities[0].status).toBe('running')

    // Emit tool_call_completed
    act(() => {
      streamListener?.({
        type: 'tool_call_completed',
        agentRunId: 'run-stream-01',
        sequenceNumber: 1,
        timestamp: 1500,
        toolEventId: 'call-01',
        toolName: 'search_knowledge_base',
        resultSummary: 'Found 3 chunks.'
      })
    })

    expect(result.current.toolActivities[0].status).toBe('completed')
    expect(result.current.toolActivities[0].resultSummary).toBe('Found 3 chunks.')

    // Emit agent_run_completed
    act(() => {
      streamListener?.({
        type: 'agent_run_completed',
        agentRunId: 'run-stream-01',
        sequenceNumber: 2,
        timestamp: 1600,
        finalResponse: 'Budget summary report completed.',
        iterations: 1,
        toolEventsCount: 1,
        citationsCount: 0,
        workspaceFilesCount: 0
      })
    })

    expect(result.current.runStatus).toBe('completed')
    expect(result.current.finalResponse).toBe('Budget summary report completed.')
    expect(onCompleted).toHaveBeenCalledWith('Budget summary report completed.')
  })

  it('handles approval_requested stream event and invokes onApprovalRequested', async () => {
    const onApproval = vi.fn()
    const { result } = renderHook(() =>
      useAgentTaskEvents({
        agentRunId: 'run-stream-02',
        onApprovalRequested: onApproval
      })
    )

    act(() => {
      streamListener?.({
        type: 'approval_requested',
        agentRunId: 'run-stream-02',
        sequenceNumber: 1,
        timestamp: 2000,
        approvalRequestId: 'req-01',
        title: 'Project Budget Report',
        contentPreview: '# Budget',
        contentSizeBytes: 2048,
        expiresAt: 2000 + 300000
      })
    })

    await waitFor(() => {
      expect(result.current.pendingApproval).toBeDefined()
      expect(result.current.pendingApproval?.requestId).toBe('req-01')
      expect(result.current.pendingApproval?.title).toBe('Project Budget Report')
      expect(onApproval).toHaveBeenCalled()
    })
  })

  it('unsubscribes when unmounted or agentRunId changes', () => {
    let runId = 'run-stream-03'
    const { rerender, unmount } = renderHook(() => useAgentTaskEvents({ agentRunId: runId }))

    expect(window.api.agents!.subscribeToTaskEvents).toHaveBeenCalledWith(
      'run-stream-03',
      expect.any(Function)
    )

    // Change runId
    runId = 'run-stream-04'
    rerender()

    expect(unsubscribeMock).toHaveBeenCalled()
    expect(window.api.agents!.subscribeToTaskEvents).toHaveBeenCalledWith(
      'run-stream-04',
      expect.any(Function)
    )

    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(2)
  })
})
