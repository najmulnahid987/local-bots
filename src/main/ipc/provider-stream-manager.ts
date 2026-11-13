import {
  type ProviderStreamEvent,
  type ProviderErrorDto,
  type StreamStartIpcPayload
} from '../../shared/providers'
import { PROVIDER_IPC_CHANNELS } from '../../shared/ipc'
import { ProviderManagerService } from '../providers/provider-manager/provider-manager-service'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'
import { type BrowserWindowLike, type WebFrameMainLike } from '../security'

export const MAX_CONCURRENT_STREAMS_PER_WINDOW = 5

export interface MessagePortMainLike {
  start(): void
  close(): void
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  removeAllListeners?(): void
}

export interface MessageChannelLike {
  port1: MessagePortMainLike
  port2: unknown
}

export type MessageChannelFactory = () => MessageChannelLike

export interface WebFrameWithPostMessage extends WebFrameMainLike {
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void
}

interface StreamSession {
  readonly streamId: string
  readonly window: BrowserWindowLike
  readonly abortController: AbortController
  readonly port: MessagePortMainLike
  isCleanedUp: boolean
}

/**
 * Normalizes an error into a safe ProviderErrorDto for streaming events.
 */
export function toSafeProviderErrorDto(err: unknown): ProviderErrorDto {
  if (err && typeof err === 'object') {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'PROVIDER_STREAM_ERROR'
    const retryable =
      'retryable' in err && typeof err.retryable === 'boolean' ? err.retryable : false
    const rawMessage =
      'message' in err && typeof err.message === 'string' ? err.message : String(err)
    return {
      code,
      message: sanitizeErrorMessage(rawMessage),
      retryable
    }
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unknown error occurred during stream generation',
    retryable: false
  }
}

/**
 * Manages active streaming generation sessions, port transfer, lifecycle cleanup,
 * and request cancellation over MessageChannelMain.
 */
export class ProviderStreamManager {
  private readonly maxStreams: number
  private readonly channelFactory: MessageChannelFactory
  private readonly activeStreams = new Map<string, StreamSession>()
  private readonly windowListeners = new WeakSet<BrowserWindowLike>()

  constructor(options?: { maxStreams?: number; channelFactory?: MessageChannelFactory }) {
    this.maxStreams = options?.maxStreams ?? MAX_CONCURRENT_STREAMS_PER_WINDOW
    this.channelFactory =
      options?.channelFactory ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MessageChannelMain } = require('electron')
        return new MessageChannelMain()
      })
  }

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

  public hasStream(streamId: string): boolean {
    return this.activeStreams.has(streamId)
  }

  /**
   * Starts a new streaming session:
   * 1. Validates window concurrency limits.
   * 2. Creates MessageChannelMain.
   * 3. Transfers port2 to the verified sender frame.
   * 4. Consumes ProviderManagerService.streamText.
   * 5. Forwards sanitized chunks.
   * 6. Manages cancellation and cleanup.
   */
  public async startStream(
    window: BrowserWindowLike,
    senderFrame: WebFrameWithPostMessage,
    payload: StreamStartIpcPayload,
    providerManager: ProviderManagerService
  ): Promise<{ started: true }> {
    const { streamId, connectionId, modelId, options } = payload

    // 1. Enforce concurrent stream bounds per window
    const currentWindowStreams = this.getActiveStreamCount(window)
    if (currentWindowStreams >= this.maxStreams) {
      throw new Error(
        `Maximum concurrent streams limit (${this.maxStreams}) exceeded for this window.`
      )
    }

    if (this.activeStreams.has(streamId)) {
      throw new Error(`A stream with ID '${streamId}' is already active.`)
    }

    // 2. Setup channel and abort controller
    const { port1, port2 } = this.channelFactory()
    const abortController = new AbortController()

    const session: StreamSession = {
      streamId,
      window,
      abortController,
      port: port1,
      isCleanedUp: false
    }

    this.activeStreams.set(streamId, session)
    this.attachWindowLifecycle(window)

    // 3. Listen for cancellation or disconnection on port1
    port1.on('message', (event) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type === 'cancel') {
        this.cancelStream(streamId, 'User requested cancellation')
      }
    })

    port1.on('close', () => {
      this.cleanupSession(streamId)
    })

    port1.start()

    // 4. Transfer port2 to sender frame
    try {
      senderFrame.postMessage(PROVIDER_IPC_CHANNELS.STREAM_PORT, { streamId }, [port2])
    } catch (err: unknown) {
      this.cleanupSession(streamId)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to transfer stream port to sender frame: ${msg}`, { cause: err })
    }

    // 5. Asynchronously consume provider stream
    this.consumeStream(session, connectionId, modelId, options, providerManager).catch((err) => {
      if (!session.isCleanedUp) {
        try {
          const errorEvent: ProviderStreamEvent = {
            type: 'error',
            error: toSafeProviderErrorDto(err)
          }
          port1.postMessage(errorEvent)
        } catch {
          // Ignore port send failures if port is already closed
        }
        this.cleanupSession(streamId)
      }
    })

    return { started: true }
  }

  /**
   * Explicitly cancels an active stream.
   */
  public cancelStream(streamId: string, reason = 'Cancelled'): boolean {
    void reason
    const session = this.activeStreams.get(streamId)
    if (!session) {
      return false
    }

    session.abortController.abort()
    this.cleanupSession(streamId)
    return true
  }

  /**
   * Aborts all active streams associated with a specific BrowserWindow.
   */
  public abortWindowStreams(window: BrowserWindowLike): number {
    let abortedCount = 0
    for (const [streamId, session] of this.activeStreams.entries()) {
      if (session.window === window) {
        session.abortController.abort()
        this.cleanupSession(streamId)
        abortedCount++
      }
    }
    return abortedCount
  }

  /**
   * Consumes ProviderManagerService.streamText and posts chunks to port1.
   */
  private async consumeStream(
    session: StreamSession,
    connectionId: string,
    modelId: string,
    options: StreamStartIpcPayload['options'],
    providerManager: ProviderManagerService
  ): Promise<void> {
    const { streamId, abortController, port } = session

    try {
      const stream = await providerManager.streamText(connectionId, modelId, {
        messages: options.messages,
        systemPrompt: options.systemPrompt,
        temperature: options.temperature,
        maxTokens: options.maxOutputTokens ?? options.maxTokens,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: options.tools as any,
        jsonSchema: options.jsonSchema as Record<string, unknown> | undefined,
        abortSignal: abortController.signal
      })

      for await (const chunk of stream) {
        if (session.isCleanedUp || abortController.signal.aborted) {
          break
        }

        // Post sanitized chunk to client
        port.postMessage(chunk)

        if (chunk.type === 'finish' || chunk.type === 'error') {
          break
        }
      }
    } catch (err: unknown) {
      if (!session.isCleanedUp && !abortController.signal.aborted) {
        try {
          const errorEvent: ProviderStreamEvent = {
            type: 'error',
            error: toSafeProviderErrorDto(err)
          }
          port.postMessage(errorEvent)
        } catch {
          // Ignore send errors if port is closed
        }
      }
    } finally {
      this.cleanupSession(streamId)
    }
  }

  /**
   * Safely closes port and removes session from active map.
   */
  private cleanupSession(streamId: string): void {
    const session = this.activeStreams.get(streamId)
    if (!session || session.isCleanedUp) {
      return
    }

    session.isCleanedUp = true
    this.activeStreams.delete(streamId)

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
      win.webContents.on(
        'did-start-navigation',
        (_event?: unknown, _url?: unknown, isInPlace?: boolean) => {
          if (isInPlace !== true) {
            this.abortWindowStreams(window)
          }
        }
      )
    }
  }
}
