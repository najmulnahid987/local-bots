import {
  CONVERSATION_IPC_CHANNELS,
  type SendMessageIpcRequest,
  type RetryTurnIpcRequest,
  type PublicTextDeltaEvent,
  type PublicFinishEvent,
  type PublicErrorEvent
} from '../../shared/conversations'
import {
  type ConversationTurnService,
  type ConversationTurnStream,
  type ConversationTurnResult
} from '../services/conversation-turn-service'
import { type SessionId } from '../services/active-workspace-context'
import { sanitizeConversationErrorMessage } from './conversation-validation'
import { type BrowserWindowLike } from '../security'
import {
  type MessagePortMainLike,
  type MessageChannelFactory,
  type WebFrameWithPostMessage
} from './provider-stream-manager'

export const MAX_CONCURRENT_CONVERSATION_STREAMS_PER_WINDOW = 5

export interface ConversationStreamSession {
  readonly requestId: string
  readonly window: BrowserWindowLike
  readonly senderFrame: WebFrameWithPostMessage
  readonly abortController: AbortController
  readonly port: MessagePortMainLike
  readonly conversationId: string
  isCleanedUp: boolean
}

/**
 * Normalizes an unknown error into a safe PublicErrorEvent structure.
 */
export function toSafeConversationErrorDto(err: unknown): {
  code: string
  message: string
  retryable: boolean
} {
  if (err && typeof err === 'object') {
    const code =
      'code' in err && typeof err.code === 'string' ? err.code : 'CONVERSATION_STREAM_ERROR'
    const retryable =
      'retryable' in err && typeof err.retryable === 'boolean' ? err.retryable : false
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    return {
      code,
      message: sanitizeConversationErrorMessage(rawMessage),
      retryable
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred during conversation streaming.',
    retryable: false
  }
}

export interface ConversationStreamManagerOptions {
  maxStreams?: number
  channelFactory?: MessageChannelFactory
}

/**
 * Manages active streaming conversation turns, MessagePortMain transport,
 * lifecycle cleanup, and scoped cancellation.
 */
export class ConversationStreamManager {
  private readonly maxStreams: number
  private readonly channelFactory: MessageChannelFactory
  private readonly activeStreams = new Map<string, ConversationStreamSession>()
  private readonly windowListeners = new WeakSet<BrowserWindowLike>()

  constructor(options?: ConversationStreamManagerOptions) {
    this.maxStreams = options?.maxStreams ?? MAX_CONCURRENT_CONVERSATION_STREAMS_PER_WINDOW
    this.channelFactory =
      options?.channelFactory ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MessageChannelMain } = require('electron')
        return new MessageChannelMain()
      })
  }

  /**
   * Returns the count of active streams, optionally filtered by window.
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
   * Returns whether a specific requestId is currently streaming.
   */
  public hasStream(requestId: string): boolean {
    return this.activeStreams.has(requestId)
  }

  /**
   * Starts a new streaming send-message turn:
   * 1. Validates window stream concurrency and unique requestId.
   * 2. Instantiates MessageChannelMain.
   * 3. Transfers port2 to verified senderFrame.
   * 4. Invokes ConversationTurnService.sendMessage.
   * 5. Forwards sanitized turn events across port1.
   * 6. Manages cancellation, error handling, and resource cleanup.
   */
  public async startSendStream(
    window: BrowserWindowLike,
    senderFrame: WebFrameWithPostMessage,
    payload: SendMessageIpcRequest,
    sessionId: SessionId,
    turnService: ConversationTurnService
  ): Promise<{ started: true }> {
    const { requestId, conversationId, content, contentFormat } = payload

    this.assertCapacity(window, requestId)

    const { port1, port2 } = this.channelFactory()
    const abortController = new AbortController()

    const session: ConversationStreamSession = {
      requestId,
      window,
      senderFrame,
      abortController,
      port: port1,
      conversationId,
      isCleanedUp: false
    }

    this.activeStreams.set(requestId, session)
    this.attachWindowLifecycle(window)

    // Listen on port1 for cancel message or disconnect
    port1.on('message', (event) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type === 'cancel') {
        this.cancelStream(requestId, window)
      }
    })

    port1.on('close', () => {
      this.cleanupSession(requestId)
    })

    port1.start()

    // Transfer port2 to sender frame
    try {
      senderFrame.postMessage(CONVERSATION_IPC_CHANNELS.STREAM_PORT, { requestId }, [port2])
    } catch (err: unknown) {
      this.cleanupSession(requestId)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to transfer stream port to sender frame: ${msg}`, { cause: err })
    }

    // Initiate turn in ConversationTurnService
    let turnStream: ConversationTurnStream
    try {
      turnStream = turnService.sendMessage(
        sessionId,
        {
          conversationId,
          content,
          contentFormat
        },
        { abortSignal: abortController.signal }
      )
    } catch (err) {
      this.cleanupSession(requestId)
      throw err
    }

    // Asynchronously consume stream
    this.consumeTurnStream(session, turnStream).catch((err) => {
      if (!session.isCleanedUp) {
        try {
          const errorEvent: PublicErrorEvent = {
            type: 'error',
            error: toSafeConversationErrorDto(err)
          }
          port1.postMessage(errorEvent)
        } catch {
          // Port closed
        }
        this.cleanupSession(requestId)
      }
    })

    return { started: true }
  }

  /**
   * Starts a streaming retry turn for the latest unanswered user message.
   */
  public async startRetryStream(
    window: BrowserWindowLike,
    senderFrame: WebFrameWithPostMessage,
    payload: RetryTurnIpcRequest,
    sessionId: SessionId,
    turnService: ConversationTurnService
  ): Promise<{ started: true }> {
    const { requestId, conversationId, messageId } = payload

    this.assertCapacity(window, requestId)

    const { port1, port2 } = this.channelFactory()
    const abortController = new AbortController()

    const session: ConversationStreamSession = {
      requestId,
      window,
      senderFrame,
      abortController,
      port: port1,
      conversationId,
      isCleanedUp: false
    }

    this.activeStreams.set(requestId, session)
    this.attachWindowLifecycle(window)

    port1.on('message', (event) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type === 'cancel') {
        this.cancelStream(requestId, window)
      }
    })

    port1.on('close', () => {
      this.cleanupSession(requestId)
    })

    port1.start()

    try {
      senderFrame.postMessage(CONVERSATION_IPC_CHANNELS.STREAM_PORT, { requestId }, [port2])
    } catch (err: unknown) {
      this.cleanupSession(requestId)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to transfer stream port to sender frame: ${msg}`, { cause: err })
    }

    let turnStream: ConversationTurnStream
    try {
      turnStream = turnService.retryLastUserMessage(
        sessionId,
        {
          conversationId,
          messageId
        },
        { abortSignal: abortController.signal }
      )
    } catch (err) {
      this.cleanupSession(requestId)
      throw err
    }

    this.consumeTurnStream(session, turnStream).catch((err) => {
      if (!session.isCleanedUp) {
        try {
          const errorEvent: PublicErrorEvent = {
            type: 'error',
            error: toSafeConversationErrorDto(err)
          }
          port1.postMessage(errorEvent)
        } catch {
          // Port closed
        }
        this.cleanupSession(requestId)
      }
    })

    return { started: true }
  }

  /**
   * Explicitly cancels an active conversation generation turn.
   * Verifies that the calling window owns the stream before aborting.
   */
  public cancelStream(requestId: string, window?: BrowserWindowLike): boolean {
    const session = this.activeStreams.get(requestId)
    if (!session) {
      // Harmless duplicate or already completed cancel
      return false
    }

    if (window && session.window !== window) {
      const err = new Error('Unauthorized: cannot cancel a generation belonging to another window.')
      ;(err as unknown as { code: string }).code = 'UNAUTHORIZED'
      throw err
    }

    session.abortController.abort()
    this.cleanupSession(requestId)
    return true
  }

  /**
   * Aborts all active streams associated with a specific BrowserWindow.
   */
  public abortWindowStreams(window: BrowserWindowLike): number {
    let abortedCount = 0
    for (const [requestId, session] of this.activeStreams.entries()) {
      if (session.window === window) {
        session.abortController.abort()
        this.cleanupSession(requestId)
        abortedCount++
      }
    }
    return abortedCount
  }

  private assertCapacity(window: BrowserWindowLike, requestId: string): void {
    const currentWindowStreams = this.getActiveStreamCount(window)
    if (currentWindowStreams >= this.maxStreams) {
      const err = new Error(
        `Maximum concurrent streams limit (${this.maxStreams}) exceeded for this window.`
      )
      ;(err as unknown as { code: string }).code = 'CONCURRENT_TURN_ACTIVE'
      throw err
    }

    if (this.activeStreams.has(requestId)) {
      const err = new Error(`A generation turn with request ID '${requestId}' is already active.`)
      ;(err as unknown as { code: string }).code = 'INVALID_INPUT'
      throw err
    }
  }

  /**
   * Consumes ConversationTurnStream and emits typed public events across MessagePortMain.
   */
  private async consumeTurnStream(
    session: ConversationStreamSession,
    turnStream: ConversationTurnStream
  ): Promise<void> {
    const { requestId, abortController, port } = session

    try {
      let turnResult: ConversationTurnResult | undefined

      for await (const event of turnStream) {
        if (session.isCleanedUp || abortController.signal.aborted) {
          break
        }

        if (event.type === 'text_delta') {
          const deltaEvent: PublicTextDeltaEvent = {
            type: 'text_delta',
            textDelta: event.textDelta
          }
          port.postMessage(deltaEvent)
        } else if (event.type === 'finish') {
          try {
            turnResult = await turnStream.getResult()
          } catch {
            // Best effort
          }

          const finishEvent: PublicFinishEvent = {
            type: 'finish',
            finishReason: event.finishReason,
            usage: event.usage
              ? {
                  promptTokens: event.usage.promptTokens,
                  completionTokens: event.usage.completionTokens,
                  totalTokens: event.usage.totalTokens
                }
              : null,
            totalTextLength: event.totalTextLength,
            durationMs: event.durationMs,
            message: event.message,
            userMessage: turnResult?.userMessage
          }
          port.postMessage(finishEvent)
          break
        } else if (event.type === 'error') {
          const errorEvent: PublicErrorEvent = {
            type: 'error',
            error: {
              code: event.error.code,
              message: sanitizeConversationErrorMessage(event.error.message),
              retryable: event.error.retryable
            }
          }
          port.postMessage(errorEvent)
          break
        }
      }
    } catch (err: unknown) {
      if (!session.isCleanedUp && !abortController.signal.aborted) {
        try {
          const errorEvent: PublicErrorEvent = {
            type: 'error',
            error: toSafeConversationErrorDto(err)
          }
          port.postMessage(errorEvent)
        } catch {
          // Port closed
        }
      }
    } finally {
      this.cleanupSession(requestId)
    }
  }

  /**
   * Safely closes port and removes session from active map.
   */
  private cleanupSession(requestId: string): void {
    const session = this.activeStreams.get(requestId)
    if (!session || session.isCleanedUp) {
      return
    }

    session.isCleanedUp = true
    this.activeStreams.delete(requestId)

    try {
      session.port.close()
    } catch {
      // Ignore errors closing already-closed ports
    }
  }

  /**
   * Attaches window closure and navigation listeners to safely cancel streams.
   */
  private attachWindowLifecycle(window: BrowserWindowLike): void {
    if (this.windowListeners.has(window)) {
      return
    }
    this.windowListeners.add(window)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any
    if (typeof win.on === 'function') {
      win.on('closed', () => {
        this.abortWindowStreams(window)
      })
    }

    if (win.webContents && typeof win.webContents.on === 'function') {
      win.webContents.on('did-start-navigation', () => {
        this.abortWindowStreams(window)
      })
      win.webContents.on('destroyed', () => {
        this.abortWindowStreams(window)
      })
    }
  }
}
