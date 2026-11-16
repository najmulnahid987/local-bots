import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  AgentStreamEvent,
  AgentRunStatus,
  ApprovalDetailsDto,
  CanonicalBotTool
} from '../../../shared/agents'

export interface ReconciledToolActivity {
  readonly id: string
  readonly sequenceNumber: number
  readonly toolName: CanonicalBotTool
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly argumentsSummary: string
  readonly resultSummary: string
  readonly errorMessage: string | null
  readonly durationMs?: number
}

export interface UseAgentTaskEventsOptions {
  readonly agentRunId?: string | null
  readonly onRunCompleted?: (finalResponse: string) => void
  readonly onRunFailed?: (error: { code: string; message: string }) => void
  readonly onRunCancelled?: (reason: string) => void
  readonly onApprovalRequested?: (approval: ApprovalDetailsDto) => void
}

export interface UseAgentTaskEventsState {
  readonly events: readonly AgentStreamEvent[]
  readonly toolActivities: readonly ReconciledToolActivity[]
  readonly runStatus: AgentRunStatus | null
  readonly iteration: number
  readonly maxIterations: number
  readonly finalResponse: string | null
  readonly pendingApproval: ApprovalDetailsDto | null
  readonly error: { code: string; message: string } | null
  readonly isConnected: boolean
  readonly isRecovering: boolean
  readonly refreshState: () => Promise<void>
}

/**
 * Custom React hook for monitoring live agent task activity and reconciling
 * streaming events with authoritative persisted records.
 */
export function useAgentTaskEvents(options?: UseAgentTaskEventsOptions): UseAgentTaskEventsState {
  const agentRunId = options?.agentRunId
  const onRunCompleted = options?.onRunCompleted
  const onRunFailed = options?.onRunFailed
  const onRunCancelled = options?.onRunCancelled
  const onApprovalRequested = options?.onApprovalRequested

  const [events, setEvents] = useState<readonly AgentStreamEvent[]>([])
  const [toolMap, setToolMap] = useState<Map<string, ReconciledToolActivity>>(new Map())
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null)
  const [iteration, setIteration] = useState<number>(0)
  const [maxIterations] = useState<number>(5)
  const [finalResponse, setFinalResponse] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<ApprovalDetailsDto | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [isRecovering, setIsRecovering] = useState<boolean>(false)

  // Track run ID changes to reset events
  const [prevRunId, setPrevRunId] = useState<string | null | undefined>(agentRunId)
  if (agentRunId !== prevRunId) {
    setPrevRunId(agentRunId)
    setEvents([])
    setToolMap(new Map())
    setRunStatus(null)
    setIteration(0)
    setFinalResponse(null)
    setPendingApproval(null)
    setError(null)
    setIsConnected(Boolean(agentRunId))
    setIsRecovering(Boolean(agentRunId))
  }

  const runIdRef = useRef<string | null | undefined>(agentRunId)
  useEffect(() => {
    runIdRef.current = agentRunId
  }, [agentRunId])

  // Authoritative snapshot recovery from Main repositories
  const recoverRunState = useCallback(async (targetRunId: string): Promise<void> => {
    const agentsApi = window.api?.agents
    if (!agentsApi) return

    try {
      // 1. Recover authoritative Run status
      const run = await agentsApi.getRun(targetRunId)
      if (runIdRef.current !== targetRunId) return

      setRunStatus(run.status)
      setIteration(run.iterationCount)
      if (run.errorSummary) {
        setError({ code: 'RUN_FAILED', message: run.errorSummary })
      }

      // 2. Recover persisted Tool Events
      const toolEventsRes = await agentsApi.listToolEvents({ agentRunId: targetRunId, limit: 100 })
      if (runIdRef.current !== targetRunId) return

      setToolMap((prev) => {
        const next = new Map(prev)
        for (const te of toolEventsRes.events) {
          const existing = next.get(te.id)
          const duration =
            te.completedAt && te.startedAt ? te.completedAt - te.startedAt : existing?.durationMs
          next.set(te.id, {
            id: te.id,
            sequenceNumber: te.sequenceNumber,
            toolName: te.toolName,
            status: te.status,
            argumentsSummary: te.argumentsSummary,
            resultSummary: te.resultSummary,
            errorMessage: te.errorMessage,
            durationMs: duration
          })
        }
        return next
      })
    } catch {
      // Retain existing state if recovery fails
    } finally {
      if (runIdRef.current === targetRunId) {
        setIsRecovering(false)
      }
    }
  }, [])

  // Subscribe to live MessagePort stream
  useEffect(() => {
    if (!agentRunId) {
      return
    }

    const agentsApi = window.api?.agents
    if (!agentsApi?.subscribeToTaskEvents) {
      return
    }

    let isCurrent = true

    // Initial authoritative state recovery
    const recoverInitialState = async (): Promise<void> => {
      try {
        const run = await agentsApi.getRun(agentRunId)
        if (!isCurrent) return

        setRunStatus(run.status)
        setIteration(run.iterationCount)
        if (run.errorSummary) {
          setError({ code: 'RUN_FAILED', message: run.errorSummary })
        }

        const toolEventsRes = await agentsApi.listToolEvents({ agentRunId, limit: 100 })
        if (!isCurrent) return

        setToolMap((prev) => {
          const next = new Map(prev)
          for (const te of toolEventsRes.events) {
            const existing = next.get(te.id)
            const duration =
              te.completedAt && te.startedAt ? te.completedAt - te.startedAt : existing?.durationMs
            next.set(te.id, {
              id: te.id,
              sequenceNumber: te.sequenceNumber,
              toolName: te.toolName,
              status: te.status,
              argumentsSummary: te.argumentsSummary,
              resultSummary: te.resultSummary,
              errorMessage: te.errorMessage,
              durationMs: duration
            })
          }
          return next
        })
      } catch {
        // Retain existing state if recovery fails
      } finally {
        if (isCurrent) {
          setIsRecovering(false)
        }
      }
    }

    void recoverInitialState()

    const unsubscribe = agentsApi.subscribeToTaskEvents(
      agentRunId,
      (streamEvt: AgentStreamEvent) => {
        if (!isCurrent || runIdRef.current !== streamEvt.agentRunId) {
          return
        }

        setEvents((prev) => [...prev, streamEvt])

        switch (streamEvt.type) {
          case 'agent_run_started': {
            setRunStatus('running')
            break
          }
          case 'agent_iteration_started': {
            setIteration(streamEvt.iteration)
            break
          }
          case 'tool_call_started': {
            setToolMap((prev) => {
              const next = new Map(prev)
              next.set(streamEvt.toolEventId, {
                id: streamEvt.toolEventId,
                sequenceNumber: streamEvt.sequenceNumber,
                toolName: streamEvt.toolName,
                status: 'running',
                argumentsSummary: streamEvt.argumentsSummary,
                resultSummary: '',
                errorMessage: null
              })
              return next
            })
            break
          }
          case 'tool_call_completed': {
            setToolMap((prev) => {
              const next = new Map(prev)
              const existing = next.get(streamEvt.toolEventId)
              next.set(streamEvt.toolEventId, {
                id: streamEvt.toolEventId,
                sequenceNumber: existing?.sequenceNumber ?? streamEvt.sequenceNumber,
                toolName: streamEvt.toolName,
                status: 'completed',
                argumentsSummary: existing?.argumentsSummary ?? '',
                resultSummary: streamEvt.resultSummary,
                errorMessage: null
              })
              return next
            })
            break
          }
          case 'tool_call_failed': {
            setToolMap((prev) => {
              const next = new Map(prev)
              const existing = next.get(streamEvt.toolEventId)
              next.set(streamEvt.toolEventId, {
                id: streamEvt.toolEventId,
                sequenceNumber: existing?.sequenceNumber ?? streamEvt.sequenceNumber,
                toolName: streamEvt.toolName,
                status: 'failed',
                argumentsSummary: existing?.argumentsSummary ?? '',
                resultSummary: '',
                errorMessage: streamEvt.errorMessage
              })
              return next
            })
            break
          }
          case 'approval_requested': {
            setRunStatus('waiting_approval')
            // Fetch exact approval details
            if (agentsApi.getApprovalDetails) {
              void agentsApi
                .getApprovalDetails({
                  agentRunId: streamEvt.agentRunId,
                  approvalRequestId: streamEvt.approvalRequestId
                })
                .then((details) => {
                  if (isCurrent && runIdRef.current === streamEvt.agentRunId) {
                    setPendingApproval(details)
                    onApprovalRequested?.(details)
                  }
                })
                .catch(() => {
                  // Ignore approval details fetch error
                })
            }
            break
          }
          case 'approval_resolved': {
            setPendingApproval(null)
            if (streamEvt.status === 'approved') {
              setRunStatus('running')
            }
            break
          }
          case 'agent_run_completed': {
            setRunStatus('completed')
            setFinalResponse(streamEvt.finalResponse)
            setIteration(streamEvt.iterations)
            setIsConnected(false)
            onRunCompleted?.(streamEvt.finalResponse)
            break
          }
          case 'agent_run_failed': {
            setRunStatus('failed')
            setError(streamEvt.error)
            setIsConnected(false)
            onRunFailed?.(streamEvt.error)
            break
          }
          case 'agent_run_cancelled': {
            setRunStatus('cancelled')
            setIsConnected(false)
            onRunCancelled?.(streamEvt.reason)
            break
          }
        }
      }
    )

    return () => {
      isCurrent = false
      setIsConnected(false)
      unsubscribe()
    }
  }, [
    agentRunId,
    recoverRunState,
    onRunCompleted,
    onRunFailed,
    onRunCancelled,
    onApprovalRequested
  ])

  const refreshState = useCallback(async (): Promise<void> => {
    if (agentRunId) {
      await recoverRunState(agentRunId)
    }
  }, [agentRunId, recoverRunState])

  const toolActivities = Array.from(toolMap.values()).sort(
    (a, b) => a.sequenceNumber - b.sequenceNumber
  )

  return {
    events,
    toolActivities,
    runStatus,
    iteration,
    maxIterations,
    finalResponse,
    pendingApproval,
    error,
    isConnected,
    isRecovering,
    refreshState
  }
}
