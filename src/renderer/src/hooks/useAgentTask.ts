import { useState, useEffect, useCallback, useRef } from 'react'
import type { DispatchAgentTaskResponse, AgentRunStatus } from '../../../shared/agents'
import { AgentBridgeError } from '../../../shared/agents'

export interface UseAgentTaskOptions {
  readonly botId?: string | null
  readonly conversationId?: string | null
  readonly onTaskAccepted?: (response: DispatchAgentTaskResponse) => void
  readonly onTaskCompleted?: (agentRunId: string) => void
  readonly onTaskCancelled?: (agentRunId: string) => void
  readonly onTaskFailed?: (agentRunId: string, error: string) => void
}

export interface UseAgentTaskState {
  readonly activeRunId: string | null
  readonly status: AgentRunStatus | 'idle'
  readonly isDispatching: boolean
  readonly isCancelling: boolean
  readonly error: string | null
  readonly dispatchTask: (
    taskPrompt: string,
    workspaceAccessRequested?: boolean
  ) => Promise<DispatchAgentTaskResponse | null>
  readonly cancelTask: (agentRunId?: string) => Promise<boolean>
  readonly reset: () => void
  readonly setStatus: (status: AgentRunStatus | 'idle') => void
  readonly clearError: () => void
}

function sanitizeAgentUiError(err: unknown): string {
  const rawMsg =
    err instanceof AgentBridgeError ? err.message : err instanceof Error ? err.message : String(err)
  return rawMsg
    .replace(/[a-zA-Z]:\\[^;*?"<>|\r\n\s]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)(?:\/[a-zA-Z0-9_.-]+){2,}/g, ' [REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

/**
 * Custom React hook for dispatching and managing active Phase 8 agent tasks.
 * Strictly communicates via window.api.agents.
 * Never supplies knowledgeBaseId, sessionId, or workspace filesystem paths.
 */
export function useAgentTask(options?: UseAgentTaskOptions): UseAgentTaskState {
  const botId = options?.botId
  const conversationId = options?.conversationId
  const onTaskAccepted = options?.onTaskAccepted
  const onTaskCancelled = options?.onTaskCancelled

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<AgentRunStatus | 'idle'>('idle')
  const [isDispatching, setIsDispatching] = useState<boolean>(false)
  const [isCancelling, setIsCancelling] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Track conversationId changes to reset local task state safely
  const [prevConversationId, setPrevConversationId] = useState<string | null | undefined>(
    conversationId
  )
  if (conversationId !== prevConversationId) {
    setPrevConversationId(conversationId)
    setActiveRunId(null)
    setStatus('idle')
    setIsDispatching(false)
    setIsCancelling(false)
    setError(null)
  }

  const activeRunIdRef = useRef<string | null>(activeRunId)
  useEffect(() => {
    activeRunIdRef.current = activeRunId
  }, [activeRunId])

  const reset = useCallback((): void => {
    setActiveRunId(null)
    setStatus('idle')
    setIsDispatching(false)
    setIsCancelling(false)
    setError(null)
  }, [])

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  const dispatchTask = useCallback(
    async (
      taskPrompt: string,
      workspaceAccessRequested = false
    ): Promise<DispatchAgentTaskResponse | null> => {
      if (!botId) {
        setError('No active Bot selected to execute agent task.')
        return null
      }
      if (!conversationId) {
        setError('No active conversation selected to dispatch task.')
        return null
      }
      if (
        isDispatching ||
        status === 'running' ||
        status === 'queued' ||
        status === 'waiting_approval'
      ) {
        setError('An agent task is already in progress for this conversation.')
        return null
      }
      const trimmed = taskPrompt.trim()
      if (!trimmed) {
        setError('Task prompt cannot be empty.')
        return null
      }

      const agentsApi = window.api?.agents
      if (!agentsApi?.dispatchTask) {
        setError('Agent task API is not available in the current environment.')
        return null
      }

      setIsDispatching(true)
      setError(null)

      try {
        const response = await agentsApi.dispatchTask({
          botId,
          conversationId,
          taskPrompt: trimmed,
          workspaceAccessRequested
        })

        if (!response.accepted) {
          // e.g. folder picker cancelled by user
          setIsDispatching(false)
          if (response.status === 'cancelled') {
            setStatus('idle')
          }
          return response
        }

        setActiveRunId(response.agentRunId)
        setStatus('running')
        onTaskAccepted?.(response)
        return response
      } catch (err: unknown) {
        const msg = sanitizeAgentUiError(err)
        setError(msg)
        setStatus('idle')
        return null
      } finally {
        setIsDispatching(false)
      }
    },
    [botId, conversationId, isDispatching, status, onTaskAccepted]
  )

  const cancelTask = useCallback(
    async (targetRunId?: string): Promise<boolean> => {
      const runIdToCancel = targetRunId ?? activeRunIdRef.current
      if (!runIdToCancel) {
        return false
      }

      const agentsApi = window.api?.agents
      if (!agentsApi?.cancelTask) {
        setError('Agent cancellation API is not available.')
        return false
      }

      setIsCancelling(true)
      try {
        const res = await agentsApi.cancelTask(runIdToCancel)
        if (res.success) {
          setStatus('cancelled')
          onTaskCancelled?.(runIdToCancel)
          return true
        }
        return false
      } catch (err: unknown) {
        setError(sanitizeAgentUiError(err))
        return false
      } finally {
        setIsCancelling(false)
      }
    },
    [onTaskCancelled]
  )

  return {
    activeRunId,
    status,
    isDispatching,
    isCancelling,
    error,
    dispatchTask,
    cancelTask,
    reset,
    setStatus,
    clearError
  }
}
