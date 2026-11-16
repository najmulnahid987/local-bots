// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAgentRuns } from './useAgentRuns'
import type { AgentRunDto, ToolEventDto } from '../../../shared/agents'

describe('Renderer: useAgentRuns hook', () => {
  const sampleRun1: AgentRunDto = {
    id: 'run-hist-01',
    conversationId: 'conv-01',
    botId: 'bot-01',
    status: 'completed',
    selectedModel: 'gpt-6-luna',
    iterationCount: 2,
    startedAt: 1700000000000,
    completedAt: 1700000010000,
    errorSummary: null
  }

  const sampleToolEvent: ToolEventDto = {
    id: 'evt-01',
    agentRunId: 'run-hist-01',
    sequenceNumber: 1,
    toolName: 'search_knowledge_base',
    status: 'completed',
    approvalStatus: 'not_required',
    argumentsSummary: '{"query":"revenue"}',
    resultSummary: 'Found 3 chunks.',
    errorMessage: null,
    startedAt: 1700000001000,
    completedAt: 1700000001250
  }

  beforeEach(() => {
    window.api = {
      agents: {
        listRuns: vi.fn(async () => ({
          runs: [sampleRun1],
          total: 1
        })),
        listToolEvents: vi.fn(async () => ({
          events: [sampleToolEvent],
          total: 1
        })),
        getRun: vi.fn(),
        getApprovalDetails: vi.fn(),
        respondToApproval: vi.fn(),
        dispatchTask: vi.fn(),
        cancelTask: vi.fn(),
        subscribeToTaskEvents: vi.fn(() => () => {})
      }
    } as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches runs for active conversation on mount and populates runsById', async () => {
    const { result } = renderHook(() => useAgentRuns({ conversationId: 'conv-01', enabled: true }))

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })

    expect(window.api.agents!.listRuns).toHaveBeenCalledWith({
      conversationId: 'conv-01',
      botId: undefined,
      limit: 100
    })

    expect(result.current.runs[0].id).toBe('run-hist-01')
    expect(result.current.runsById.get('run-hist-01')).toEqual(sampleRun1)
  })

  it('loads and caches tool events on demand via loadToolEventsForRun', async () => {
    const { result } = renderHook(() => useAgentRuns({ conversationId: 'conv-01', enabled: true }))

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })

    let events: readonly ToolEventDto[] = []
    await act(async () => {
      events = await result.current.loadToolEventsForRun('run-hist-01')
    })

    expect(events.length).toBe(1)
    expect(events[0].toolName).toBe('search_knowledge_base')
    expect(window.api.agents!.listToolEvents).toHaveBeenCalledWith({
      agentRunId: 'run-hist-01',
      limit: 100
    })

    // Calling again returns cached result without second API call
    await act(async () => {
      const cached = await result.current.loadToolEventsForRun('run-hist-01')
      expect(cached).toEqual(events)
    })

    expect(window.api.agents!.listToolEvents).toHaveBeenCalledTimes(1)
  })

  it('refreshes runs when refresh() is invoked', async () => {
    const { result } = renderHook(() => useAgentRuns({ conversationId: 'conv-01', enabled: true }))

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(window.api.agents!.listRuns).toHaveBeenCalledTimes(2)
  })
})
