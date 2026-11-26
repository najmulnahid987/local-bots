import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentRunDto, ToolEventDto } from '../../../shared/agents'

export interface UseAgentRunsOptions {
  readonly conversationId?: string | null
  readonly botId?: string | null
  readonly enabled?: boolean
}

export interface UseAgentRunsState {
  readonly runs: readonly AgentRunDto[]
  readonly runsById: ReadonlyMap<string, AgentRunDto>
  readonly toolEventsByRunId: ReadonlyMap<string, readonly ToolEventDto[]>
  readonly isLoading: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly loadToolEventsForRun: (agentRunId: string) => Promise<readonly ToolEventDto[]>
}

/**
 * Custom React hook for managing historical agent runs and on-demand tool event retrieval.
 */
export function useAgentRuns(options?: UseAgentRunsOptions): UseAgentRunsState {
  const conversationId = options?.conversationId
  const botId = options?.botId
  const enabled = options?.enabled ?? true

  const [runs, setRuns] = useState<readonly AgentRunDto[]>([])
  const [runsById, setRunsById] = useState<ReadonlyMap<string, AgentRunDto>>(new Map())
  const [toolEventsByRunId, setToolEventsByRunId] = useState<
    ReadonlyMap<string, readonly ToolEventDto[]>
  >(new Map())
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(conversationId && enabled))
  const [error, setError] = useState<string | null>(null)

  // Track conversationId changes to reset state
  const [prevConversationId, setPrevConversationId] = useState<string | null | undefined>(
    conversationId
  )
  if (conversationId !== prevConversationId) {
    setPrevConversationId(conversationId)
    setRuns([])
    setRunsById(new Map())
    setToolEventsByRunId(new Map())
    setIsLoading(Boolean(conversationId && enabled))
    setError(null)
  }

  const activeConvIdRef = useRef<string | null | undefined>(conversationId)
  const requestIdRef = useRef<number>(0)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    activeConvIdRef.current = conversationId
  }, [conversationId])

  const fetchRuns = useCallback(async (): Promise<void> => {
    if (!conversationId || !enabled) {
      setRuns([])
      setRunsById(new Map())
      setIsLoading(false)
      return
    }

    const agentsApi = window.api?.agents
    if (!agentsApi?.listRuns) {
      setIsLoading(false)
      return
    }

    const reqId = ++requestIdRef.current
    const targetConvId = conversationId
    setIsLoading(true)
    setError(null)

    try {
      const res = await agentsApi.listRuns({
        conversationId: targetConvId,
        botId: botId ?? undefined,
        limit: 100
      })

      if (
        mountedRef.current &&
        reqId === requestIdRef.current &&
        activeConvIdRef.current === targetConvId
      ) {
        setRuns(res.runs)
        const map = new Map<string, AgentRunDto>()
        for (const run of res.runs) {
          map.set(run.id, run)
        }
        setRunsById(map)
      }
    } catch (err: unknown) {
      if (
        mountedRef.current &&
        reqId === requestIdRef.current &&
        activeConvIdRef.current === targetConvId
      ) {
        setError(err instanceof Error ? err.message : 'Failed to load agent runs.')
      }
    } finally {
      if (
        mountedRef.current &&
        reqId === requestIdRef.current &&
        activeConvIdRef.current === targetConvId
      ) {
        setIsLoading(false)
      }
    }
  }, [conversationId, botId, enabled])

  useEffect(() => {
    if (!conversationId || !enabled) {
      return
    }

    let isCurrent = true
    const reqId = ++requestIdRef.current
    const targetConvId = conversationId

    const loadRuns = async (): Promise<void> => {
      try {
        const agentsApi = window.api?.agents
        if (!agentsApi?.listRuns) return

        const res = await agentsApi.listRuns({
          conversationId: targetConvId,
          botId: botId ?? undefined,
          limit: 100
        })

        if (
          !isCurrent ||
          !mountedRef.current ||
          reqId !== requestIdRef.current ||
          activeConvIdRef.current !== targetConvId
        ) {
          return
        }
        setRuns(res.runs)
        const map = new Map<string, AgentRunDto>()
        for (const run of res.runs) {
          map.set(run.id, run)
        }
        setRunsById(map)
      } catch (err: unknown) {
        if (
          !isCurrent ||
          !mountedRef.current ||
          reqId !== requestIdRef.current ||
          activeConvIdRef.current !== targetConvId
        ) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load agent runs.')
      } finally {
        if (
          isCurrent &&
          mountedRef.current &&
          reqId === requestIdRef.current &&
          activeConvIdRef.current === targetConvId
        ) {
          setIsLoading(false)
        }
      }
    }

    void loadRuns()

    return () => {
      isCurrent = false
    }
  }, [conversationId, botId, enabled])

  const loadToolEventsForRun = useCallback(
    async (agentRunId: string): Promise<readonly ToolEventDto[]> => {
      // Check cache first
      const cached = toolEventsByRunId.get(agentRunId)
      if (cached) {
        return cached
      }

      const agentsApi = window.api?.agents
      if (!agentsApi?.listToolEvents) {
        return []
      }

      try {
        const res = await agentsApi.listToolEvents({ agentRunId, limit: 100 })
        setToolEventsByRunId((prev) => {
          const next = new Map(prev)
          next.set(agentRunId, res.events)
          return next
        })
        return res.events
      } catch {
        return []
      }
    },
    [toolEventsByRunId]
  )

  return {
    runs,
    runsById,
    toolEventsByRunId,
    isLoading,
    error,
    refresh: fetchRuns,
    loadToolEventsForRun
  }
}
