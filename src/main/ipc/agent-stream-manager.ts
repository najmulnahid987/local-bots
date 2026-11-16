import { AGENT_IPC_CHANNELS, type AgentStreamEvent } from '../../shared/agents'
import { type BrowserWindowLike } from '../security'
import {
  type MessagePortMainLike,
  type MessageChannelFactory,
  type WebFrameWithPostMessage
} from './provider-stream-manager'
import { sanitizeAgentErrorMessage } from './agent-validation'

export const MAX_CONCURRENT_AGENT_STREAMS_PER_WINDOW = 5

export interface AgentStreamSession {
  readonly agentRunId: string
  readonly conversationId: string
  readonly window: BrowserWindowLike
  readonly senderFrame: WebFrameWithPostMessage
  readonly abortController: AbortController
  readonly port: MessagePortMainLike
  sequenceNumber: number
  isCleanedUp: boolean
}

export interface AgentStreamManagerOptions {
  maxStreams?: number
  channelFactory?: MessageChannelFactory
}

export type AgentStreamEventInput =
  | {
      type: 'agent_run_started'
      botId: string
      selectedModel: string
    }
  | {
      type: 'agent_iteration_started'
      iteration: number
      maxIterations: number
    }
  | {
      type: 'tool_call_started'
      toolEventId: string
      toolName: import('../../shared/agents').CanonicalBotTool
      argumentsSummary: string
    }
  | {
      type: 'tool_call_completed'
      toolEventId: string
      toolName: import('../../shared/agents').CanonicalBotTool
      resultSummary: string
    }
  | {
      type: 'tool_call_failed'
      toolEventId: string
      toolName: import('../../shared/agents').CanonicalBotTool
      errorMessage: string
    }
  | {
      type: 'approval_requested'
      approvalRequestId: string
      title: string
      contentPreview: string
      contentSizeBytes: number
      expiresAt?: number
    }
  | {
      type: 'approval_resolved'
      approvalRequestId: string
      status: 'approved' | 'rejected' | 'cancelled' | 'expired'
      reason?: string
    }
  | {
      type: 'agent_run_completed'
      finalResponse: string
      iterations: number
      toolEventsCount: number
      citationsCount: number
      workspaceFilesCount: number
    }
  | {
      type: 'agent_run_failed'
      error: {
        code: string
        message: string
        retryable?: boolean
      }
    }
  | {
      type: 'agent_run_cancelled'
      reason: string
    }

/**
 * Manages active agent task streaming sessions, MessagePortMain transport,
 * lifecycle cleanup, monotonic sequence generation, and cancellation.
 */
export class AgentStreamManager {
  private readonly maxStreams: number
  private readonly channelFactory: MessageChannelFactory
  private readonly activeStreams = new Map<string, AgentStreamSession>()
  private readonly windowListeners = new WeakSet<BrowserWindowLike>()

  constructor(options?: AgentStreamManagerOptions) {
    this.maxStreams = options?.maxStreams ?? MAX_CONCURRENT_AGENT_STREAMS_PER_WINDOW
    this.channelFactory =
      options?.channelFactory ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MessageChannelMain } = require('electron')
        return new MessageChannelMain()
      })
  }

  /**
   * Returns the count of active agent streams, optionally filtered by window.
   */
  public getActiveStreamCount(window?: BrowserWindowLike): number {
    if (!window) {
      return this.activeStreams.size
    }
    let count = 0
    for (const session of this.activeStreams.values()) {
      if (session.window === window) {
        count++
      }
    }
    return count
  }

  /**
   * Returns whether a specific agentRunId has an active stream.
   */
  public hasStream(agentRunId: string): boolean {
    return this.activeStreams.has(agentRunId)
  }

  /**
   * Starts a new streaming session for an agent task run:
   * 1. Validates window stream capacity and unique agentRunId.
   * 2. Instantiates MessageChannelMain.
   * 3. Sets up lifecycle handlers on port1.
   * 4. Transfers port2 to verified senderFrame via AGENT_IPC_CHANNELS.STREAM_PORT.
   * 5. Returns session controllers for event emission and cancellation.
   */
  public startStream(
    window: BrowserWindowLike,
    senderFrame: WebFrameWithPostMessage,
    agentRunId: string,
    conversationId: string,
    onCancelRequested?: (agentRunId: string) => void
  ): {
    abortSignal: AbortSignal
    emitEvent: (input: AgentStreamEventInput) => void
    close: () => void
  } {
    this.assertCapacity(window, agentRunId)

    const { port1, port2 } = this.channelFactory()
    const abortController = new AbortController()

    const session: AgentStreamSession = {
      agentRunId,
      conversationId,
      window,
      senderFrame,
      abortController,
      port: port1,
      sequenceNumber: 1,
      isCleanedUp: false
    }

    this.activeStreams.set(agentRunId, session)
    this.attachWindowLifecycle(window)

    // Listen on port1 for cancel message or disconnect
    port1.on('message', (event) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type === 'cancel') {
        this.cancelStream(agentRunId, window, 'Stream cancelled by client.')
        onCancelRequested?.(agentRunId)
      }
    })

    port1.on('close', () => {
      this.cleanupSession(agentRunId)
    })

    port1.start()

    // Transfer port2 to sender frame
    try {
      senderFrame.postMessage(AGENT_IPC_CHANNELS.STREAM_PORT, { agentRunId }, [port2])
    } catch (err: unknown) {
      this.cleanupSession(agentRunId)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to transfer agent stream port to sender frame: ${msg}`, {
        cause: err
      })
    }

    const emitEvent = (input: AgentStreamEventInput): void => {
      this.postEvent(agentRunId, input)
    }

    const close = (): void => {
      this.cleanupSession(agentRunId)
    }

    return {
      abortSignal: abortController.signal,
      emitEvent,
      close
    }
  }

  /**
   * Posts a formatted, monotonically sequenced AgentStreamEvent to the active port.
   * Automatically closes the port when a terminal event is emitted.
   */
  public postEvent(agentRunId: string, input: AgentStreamEventInput): void {
    const session = this.activeStreams.get(agentRunId)
    if (!session || session.isCleanedUp) {
      return
    }

    const event: AgentStreamEvent = {
      ...input,
      agentRunId: session.agentRunId,
      conversationId: session.conversationId,
      sequenceNumber: session.sequenceNumber++,
      timestamp: Date.now()
    } as AgentStreamEvent

    try {
      session.port.postMessage(event)
    } catch {
      // Port might be closed; cleanup session
      this.cleanupSession(agentRunId)
      return
    }

    // Check if terminal event
    const isTerminal =
      input.type === 'agent_run_completed' ||
      input.type === 'agent_run_failed' ||
      input.type === 'agent_run_cancelled'

    if (isTerminal) {
      // Allow the message to flush before closing
      setTimeout(() => {
        this.cleanupSession(agentRunId)
      }, 20)
    }
  }

  /**
   * Cancels an active stream and aborts its AbortController.
   */
  public cancelStream(agentRunId: string, window?: BrowserWindowLike, reason?: string): boolean {
    const session = this.activeStreams.get(agentRunId)
    if (!session || session.isCleanedUp) {
      return false
    }

    if (window && session.window !== window) {
      return false
    }

    session.abortController.abort(reason ?? 'Agent task stream cancelled.')

    this.postEvent(agentRunId, {
      type: 'agent_run_cancelled',
      reason: sanitizeAgentErrorMessage(reason ?? 'Agent task stream cancelled.')
    })

    return true
  }

  /**
   * Closes and cleans up all active streams for a window.
   */
  public closeWindowStreams(window: BrowserWindowLike): void {
    for (const [id, session] of this.activeStreams.entries()) {
      if (session.window === window) {
        session.abortController.abort('Window closed.')
        this.cleanupSession(id)
      }
    }
  }

  /**
   * Cleans up an individual stream session safely.
   */
  public cleanupSession(agentRunId: string): void {
    const session = this.activeStreams.get(agentRunId)
    if (!session || session.isCleanedUp) {
      return
    }

    session.isCleanedUp = true
    try {
      session.port.close()
    } catch {
      // Ignore close errors
    }
    this.activeStreams.delete(agentRunId)
  }

  private assertCapacity(window: BrowserWindowLike, agentRunId: string): void {
    if (this.activeStreams.has(agentRunId)) {
      throw new Error(`A stream is already active for agent run '${agentRunId}'.`)
    }

    const currentCount = this.getActiveStreamCount(window)
    if (currentCount >= this.maxStreams) {
      throw new Error(
        `Maximum concurrent agent streams (${this.maxStreams}) reached for this window.`
      )
    }
  }

  private attachWindowLifecycle(window: BrowserWindowLike): void {
    if (this.windowListeners.has(window)) {
      return
    }
    this.windowListeners.add(window)

    // Check if electron BrowserWindow with EventEmitter
    if (window && typeof (window as { once?: unknown }).once === 'function') {
      const emitter = window as unknown as { once: (event: string, listener: () => void) => void }
      emitter.once('closed', () => {
        this.closeWindowStreams(window)
      })
    }
  }
}
