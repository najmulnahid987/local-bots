import { randomUUID, createHash } from 'node:crypto'

// ============================================================================
// Types & DTO Contracts
// ============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
export type FinalApprovalStatus = Exclude<ApprovalStatus, 'pending'>

export interface ApprovalRequestDto {
  readonly requestId: string
  readonly agentRunId: string
  readonly botId: string
  readonly title: string
  readonly contentPreview: string
  readonly contentSizeBytes: number
  readonly createdAt: number
  readonly expiresAt?: number
  readonly status: ApprovalStatus
  readonly decisionReason?: string
}

export interface ApprovalDecision {
  readonly requestId: string
  readonly status: FinalApprovalStatus
  readonly reason?: string
}

export interface CreateApprovalRequestOptions {
  readonly agentRunId: string
  readonly botId: string
  readonly title: string
  readonly markdownContent: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface ApprovalDecisionContext {
  readonly agentRunId: string
  readonly botId: string
}

export type ApprovalLifecycleEvent =
  | { readonly type: 'requested'; readonly request: ApprovalRequestDto }
  | {
      readonly type: 'resolved'
      readonly request: ApprovalRequestDto
      readonly decision: ApprovalDecision
    }

export type ApprovalEventListener = (event: ApprovalLifecycleEvent) => void

// ============================================================================
// Internal Request State
// ============================================================================

interface InternalApprovalRequest {
  dto: ApprovalRequestDto
  rawContent: string
  readonly contentHash: string
  readonly resolve: (decision: ApprovalDecision) => void
  timer?: NodeJS.Timeout
  abortListener?: () => void
  signal?: AbortSignal
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_CONTENT_PREVIEW_LENGTH = 300
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// ApprovalController Implementation
// ============================================================================

/**
 * Privileged Main-process controller managing human-in-the-loop approval workflows.
 * Holds pending approval requests and private report content in process memory only.
 * Full report content is never stored in SQLite, never logged, and purged on resolution.
 */
export class ApprovalController {
  private readonly requests = new Map<string, InternalApprovalRequest>()
  private readonly listeners = new Set<ApprovalEventListener>()

  /**
   * Registers a listener for approval lifecycle events (requested, resolved).
   * Returns an unsubscribe function.
   */
  public onEvent(listener: ApprovalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitEvent(event: ApprovalLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Ignore listener errors to protect controller flow
      }
    }
  }

  /**
   * Creates a pending approval request and awaits an explicit human decision.
   * Resolves when approved, rejected, cancelled, or expired.
   */
  public async requestApproval(options: CreateApprovalRequestOptions): Promise<ApprovalDecision> {
    if (!options.agentRunId || !options.botId) {
      throw new Error('agentRunId and botId are required to create an approval request.')
    }

    if (options.signal?.aborted) {
      return {
        requestId: '',
        status: 'cancelled',
        reason: 'Operation was cancelled prior to approval request.'
      }
    }

    const requestId = randomUUID()
    const now = Date.now()
    const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    const expiresAt = timeoutMs > 0 ? now + timeoutMs : undefined

    const contentSizeBytes = Buffer.byteLength(options.markdownContent, 'utf-8')
    const contentPreview =
      options.markdownContent.length > MAX_CONTENT_PREVIEW_LENGTH
        ? options.markdownContent.slice(0, MAX_CONTENT_PREVIEW_LENGTH) + '...'
        : options.markdownContent

    const contentHash = createHash('sha256').update(options.markdownContent).digest('hex')

    const dto: ApprovalRequestDto = {
      requestId,
      agentRunId: options.agentRunId,
      botId: options.botId,
      title: options.title,
      contentPreview,
      contentSizeBytes,
      createdAt: now,
      expiresAt,
      status: 'pending'
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const internalReq: InternalApprovalRequest = {
        dto,
        rawContent: options.markdownContent,
        contentHash,
        resolve,
        signal: options.signal
      }

      // 1. Setup AbortSignal listener
      if (options.signal) {
        const onAbort = (): void => {
          this.terminateRequest(
            requestId,
            'cancelled',
            'Operation aborted by user or agent runtime.'
          )
        }
        internalReq.abortListener = onAbort
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      // 2. Setup expiration timer
      if (timeoutMs > 0) {
        internalReq.timer = setTimeout(() => {
          this.terminateRequest(requestId, 'expired', 'Approval request timed out.')
        }, timeoutMs)
      }

      this.requests.set(requestId, internalReq)
      this.emitEvent({ type: 'requested', request: dto })
    })
  }

  /**
   * Approves a pending request, verifying caller context matches run and bot identity.
   */
  public approve(requestId: string, context: ApprovalDecisionContext): boolean {
    const req = this.requests.get(requestId)
    if (!req || req.dto.status !== 'pending') {
      return false
    }

    if (req.dto.agentRunId !== context.agentRunId || req.dto.botId !== context.botId) {
      return false
    }

    this.cleanupListeners(req)
    req.dto = { ...req.dto, status: 'approved' }
    req.resolve({ requestId, status: 'approved' })
    this.emitEvent({
      type: 'resolved',
      request: req.dto,
      decision: { requestId, status: 'approved' }
    })
    return true
  }

  /**
   * Rejects a pending request with an optional user-facing reason.
   */
  public reject(requestId: string, context: ApprovalDecisionContext, reason?: string): boolean {
    const req = this.requests.get(requestId)
    if (!req || req.dto.status !== 'pending') {
      return false
    }

    if (req.dto.agentRunId !== context.agentRunId || req.dto.botId !== context.botId) {
      return false
    }

    const effectiveReason = reason ?? 'User rejected report saving.'
    this.cleanupListeners(req)
    req.rawContent = '' // Purge private content from memory immediately
    req.dto = { ...req.dto, status: 'rejected', decisionReason: effectiveReason }
    req.resolve({ requestId, status: 'rejected', reason: effectiveReason })
    this.emitEvent({
      type: 'resolved',
      request: req.dto,
      decision: { requestId, status: 'rejected', reason: effectiveReason }
    })
    return true
  }

  /**
   * Cancels a pending request by requestId.
   */
  public cancel(requestId: string, reason?: string): boolean {
    return this.terminateRequest(requestId, 'cancelled', reason ?? 'Approval cancelled.')
  }

  /**
   * Cancels all pending approval requests associated with a specific agent run.
   */
  public cancelForRun(agentRunId: string, reason?: string): number {
    let cancelledCount = 0
    for (const [id, req] of this.requests.entries()) {
      if (req.dto.agentRunId === agentRunId && req.dto.status === 'pending') {
        if (this.terminateRequest(id, 'cancelled', reason ?? 'Agent run terminated.')) {
          cancelledCount++
        }
      }
    }
    return cancelledCount
  }

  /**
   * Retrieves pending report details (including exact in-memory markdown content),
   * verifying that the run and bot ownership match the active pending request.
   */
  public getPendingDetails(
    requestId: string,
    context: ApprovalDecisionContext
  ): {
    readonly title: string
    readonly content: string
    readonly contentSizeBytes: number
    readonly createdAt: number
    readonly expiresAt?: number
  } | null {
    const req = this.requests.get(requestId)
    if (!req || req.dto.status !== 'pending') {
      return null
    }

    if (req.dto.agentRunId !== context.agentRunId || req.dto.botId !== context.botId) {
      return null
    }

    return {
      title: req.dto.title,
      content: req.rawContent,
      contentSizeBytes: req.dto.contentSizeBytes,
      createdAt: req.dto.createdAt,
      expiresAt: req.dto.expiresAt
    }
  }

  /**
   * Retrieves approved markdown content for saving, verifying run and bot ownership.
   */
  public getApprovedContent(
    requestId: string,
    context: ApprovalDecisionContext
  ): { content: string; contentHash: string } | null {
    const req = this.requests.get(requestId)
    if (!req || req.dto.status !== 'approved') {
      return null
    }

    if (req.dto.agentRunId !== context.agentRunId || req.dto.botId !== context.botId) {
      return null
    }

    return {
      content: req.rawContent,
      contentHash: req.contentHash
    }
  }

  /**
   * Consumes and purges the private markdown content after a file write completes.
   */
  public consumeContent(requestId: string): void {
    const req = this.requests.get(requestId)
    if (req) {
      req.rawContent = ''
    }
  }

  /**
   * Returns public DTO representation of a request.
   */
  public getRequest(requestId: string): ApprovalRequestDto | null {
    const req = this.requests.get(requestId)
    return req ? { ...req.dto } : null
  }

  /**
   * Lists all approval requests, optionally filtered by agentRunId.
   */
  public listRequests(agentRunId?: string): readonly ApprovalRequestDto[] {
    const list: ApprovalRequestDto[] = []
    for (const req of this.requests.values()) {
      if (!agentRunId || req.dto.agentRunId === agentRunId) {
        list.push({ ...req.dto })
      }
    }
    return list
  }

  /**
   * Cleans up all requests, timers, and listeners.
   */
  public clear(): void {
    for (const req of this.requests.values()) {
      this.cleanupListeners(req)
      req.rawContent = ''
    }
    this.requests.clear()
    this.listeners.clear()
  }

  private terminateRequest(
    requestId: string,
    terminalStatus: 'cancelled' | 'expired',
    reason: string
  ): boolean {
    const req = this.requests.get(requestId)
    if (!req || req.dto.status !== 'pending') {
      return false
    }

    this.cleanupListeners(req)
    req.rawContent = '' // Purge private content
    req.dto = { ...req.dto, status: terminalStatus, decisionReason: reason }
    req.resolve({ requestId, status: terminalStatus, reason })
    this.emitEvent({
      type: 'resolved',
      request: req.dto,
      decision: { requestId, status: terminalStatus, reason }
    })
    return true
  }

  private cleanupListeners(req: InternalApprovalRequest): void {
    if (req.timer) {
      clearTimeout(req.timer)
      req.timer = undefined
    }
    if (req.signal && req.abortListener) {
      req.signal.removeEventListener('abort', req.abortListener)
      req.abortListener = undefined
    }
  }
}
