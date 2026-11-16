// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentTask } from './useAgentTask'
import type { DispatchAgentTaskResponse } from '../../../shared/agents'

describe('Renderer: useAgentTask hook', () => {
  const sampleDispatchResponse: DispatchAgentTaskResponse = {
    accepted: true,
    agentRunId: 'run-1111-2222',
    conversationId: 'conv-1111',
    status: 'queued'
  }

  beforeEach(() => {
    window.api = {
      agents: {
        dispatchTask: vi.fn(async () => sampleDispatchResponse),
        cancelTask: vi.fn(async () => ({ success: true, agentRunId: 'run-1111-2222' })),
        getRun: vi.fn(),
        listRuns: vi.fn(),
        listToolEvents: vi.fn(),
        getApprovalDetails: vi.fn(),
        respondToApproval: vi.fn(),
        subscribeToTaskEvents: vi.fn(() => () => {})
      }
    } as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes with idle status and null activeRunId', () => {
    const { result } = renderHook(() =>
      useAgentTask({ conversationId: 'conv-1111', botId: 'bot-1111' })
    )

    expect(result.current.status).toBe('idle')
    expect(result.current.activeRunId).toBeNull()
    expect(result.current.isDispatching).toBe(false)
    expect(result.current.isCancelling).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('dispatches task successfully and tracks activeRunId', async () => {
    const onAccepted = vi.fn()
    const { result } = renderHook(() =>
      useAgentTask({
        conversationId: 'conv-1111',
        botId: 'bot-1111',
        onTaskAccepted: onAccepted
      })
    )

    await act(async () => {
      const res = await result.current.dispatchTask('Analyze recent changes', true)
      expect(res).toEqual(sampleDispatchResponse)
    })

    expect(window.api.agents!.dispatchTask).toHaveBeenCalledWith({
      conversationId: 'conv-1111',
      botId: 'bot-1111',
      taskPrompt: 'Analyze recent changes',
      workspaceAccessRequested: true
    })

    expect(result.current.activeRunId).toBe('run-1111-2222')
    expect(result.current.status).toBe('running')
    expect(onAccepted).toHaveBeenCalledWith(sampleDispatchResponse)
  })

  it('prevents concurrent task dispatch while a task is already active', async () => {
    const { result } = renderHook(() =>
      useAgentTask({ conversationId: 'conv-1111', botId: 'bot-1111' })
    )

    await act(async () => {
      await result.current.dispatchTask('Task 1')
    })

    expect(result.current.activeRunId).toBe('run-1111-2222')

    // Second dispatch while first is active should be rejected
    await act(async () => {
      const res2 = await result.current.dispatchTask('Task 2')
      expect(res2).toBeNull()
    })

    expect(result.current.error).toContain('already in progress')
    expect(window.api.agents!.dispatchTask).toHaveBeenCalledTimes(1)
  })

  it('cancels active task and invokes onTaskCancelled', async () => {
    const onCancelled = vi.fn()
    const { result } = renderHook(() =>
      useAgentTask({
        conversationId: 'conv-1111',
        botId: 'bot-1111',
        onTaskCancelled: onCancelled
      })
    )

    await act(async () => {
      await result.current.dispatchTask('Task to cancel')
    })

    await act(async () => {
      const cancelled = await result.current.cancelTask()
      expect(cancelled).toBe(true)
    })

    expect(window.api.agents!.cancelTask).toHaveBeenCalledWith('run-1111-2222')
    expect(result.current.status).toBe('cancelled')
    expect(onCancelled).toHaveBeenCalledWith('run-1111-2222')
  })

  it('resets state when conversationId changes', async () => {
    let convId = 'conv-1111'
    const { result, rerender } = renderHook(() =>
      useAgentTask({ conversationId: convId, botId: 'bot-1111' })
    )

    await act(async () => {
      await result.current.dispatchTask('Task on conv 1')
    })

    expect(result.current.activeRunId).toBe('run-1111-2222')

    // Change conversation
    convId = 'conv-2222'
    rerender()

    expect(result.current.activeRunId).toBeNull()
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })
})
