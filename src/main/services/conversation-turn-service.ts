import { z } from 'zod'
import type Database from 'better-sqlite3'
import {
  sendMessageRequestSchema,
  type SendMessageRequest,
  type MessageDto
} from '../../shared/conversations'
import { idSchema } from '../database/repositories/types'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ActiveWorkspaceContext, type SessionId } from './active-workspace-context'
import { ConversationService, ConversationServiceError } from './conversation-service'
import {
  ConversationExecutionService,
  ConversationExecutionError,
  type TextDeltaEvent,
  type ConversationExecutionResult
} from './conversation-execution-service'
import {
  ConversationPersistenceService,
  ConversationPersistenceError
} from './conversation-persistence-service'
import { KnowledgeBaseOnlyPolicy } from './knowledge-base-only-policy'
import type { TokenUsage } from '../providers/types'

// ============================================================================
// Error Contracts
// ============================================================================

export type ConversationTurnErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_ABORTED'
  | 'CONCURRENT_TURN_ACTIVE'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ARCHIVED'
  | 'BOT_MISMATCH'
  | 'NO_ACTIVE_WORKSPACE'
  | 'NO_RETRYABLE_MESSAGE'
  | 'PERSISTENCE_ERROR'
  | 'EXECUTION_ERROR'
  | 'TIMEOUT'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'AUTHENTICATION_FAILED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SERVICE_UNAVAILABLE'

export class ConversationTurnError extends Error {
  public readonly code: ConversationTurnErrorCode
  public readonly retryable: boolean

  constructor(message: string, code: ConversationTurnErrorCode, retryable = false) {
    super(message)
    this.name = 'ConversationTurnError'
    this.code = code
    this.retryable = retryable
    Object.setPrototypeOf(this, ConversationTurnError.prototype)
  }
}

// ============================================================================
// Turn Event & Result Contracts
// ============================================================================

export interface TurnFinishEvent {
  readonly type: 'finish'
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly usage?: TokenUsage
  readonly totalTextLength: number
  readonly durationMs: number
  readonly message: MessageDto
}

export interface TurnErrorEvent {
  readonly type: 'error'
  readonly error: {
    readonly code: ConversationTurnErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export type ConversationTurnEvent = TextDeltaEvent | TurnFinishEvent | TurnErrorEvent

export interface ConversationTurnResult {
  readonly userMessage: MessageDto
  readonly assistantMessage: MessageDto
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly durationMs: number
  readonly usage?: TokenUsage
}

export interface ConversationTurnStream extends AsyncIterable<ConversationTurnEvent> {
  getResult(): Promise<ConversationTurnResult>
}

// ============================================================================
// Helper Wrapper
// ============================================================================

class TurnStreamWrapper implements ConversationTurnStream {
  private readonly generator: AsyncGenerator<ConversationTurnEvent>
  private readonly resultPromise: Promise<ConversationTurnResult>

  constructor(
    generator: AsyncGenerator<ConversationTurnEvent>,
    resultPromise: Promise<ConversationTurnResult>
  ) {
    this.generator = generator
    this.resultPromise = resultPromise
  }

  [Symbol.asyncIterator](): AsyncGenerator<ConversationTurnEvent> {
    return this.generator
  }

  public getResult(): Promise<ConversationTurnResult> {
    return this.resultPromise
  }
}

// ============================================================================
// Options and Request Contracts
// ============================================================================

export interface TurnExecutionOptions {
  readonly abortSignal?: AbortSignal
  readonly temperature?: number
  readonly topK?: number
  readonly maxContextTokens?: number
  readonly reservedOutputTokens?: number
}

export interface RetryTurnRequest {
  readonly conversationId: string
  readonly messageId?: string
}

export const retryTurnRequestSchema = z
  .object({
    conversationId: idSchema,
    messageId: idSchema.optional()
  })
  .strict()

// ============================================================================
// Service Dependencies
// ============================================================================

export interface ConversationTurnServiceDependencies {
  readonly conversationService?: ConversationService
  readonly executionService?: ConversationExecutionService
  readonly persistenceService?: ConversationPersistenceService
  readonly conversationRepo?: ConversationRepository
  readonly messageRepo?: MessageRepository
  readonly activeWorkspaceContext?: ActiveWorkspaceContext
  readonly db?: Database.Database
}

// ============================================================================
// ConversationTurnService Implementation
// ============================================================================

/**
 * Main-process orchestrator managing the complete lifecycle of conversation turns:
 * pre-flight validation, turn preparation, user persistence, streaming provider execution,
 * assistant persistence with authentic citations, cancellation, timeout recovery,
 * explicit retry, and concurrent-turn protection.
 */
export class ConversationTurnService {
  private readonly conversationService: ConversationService
  private readonly executionService: ConversationExecutionService
  private readonly persistenceService: ConversationPersistenceService
  private readonly conversationRepo: ConversationRepository
  private readonly messageRepo: MessageRepository
  private readonly activeWorkspaceContext?: ActiveWorkspaceContext

  /**
   * Tracks in-memory conversation IDs currently performing active generation.
   * Prevents simultaneous generation turns on the same conversation thread.
   */
  private readonly activeTurns = new Set<string>()

  /**
   * Tracks in-memory conversation IDs currently undergoing deletion.
   * Prevents race conditions between active generation and deletion.
   */
  private readonly deletingConversations = new Set<string>()

  constructor(deps: ConversationTurnServiceDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new ConversationTurnError(
        'Dependencies object is required for ConversationTurnService.',
        'INVALID_INPUT'
      )
    }

    if (deps.db) {
      this.conversationRepo = deps.conversationRepo ?? new ConversationRepository(deps.db)
      this.messageRepo = deps.messageRepo ?? new MessageRepository(deps.db)
      this.activeWorkspaceContext = deps.activeWorkspaceContext
      this.persistenceService =
        deps.persistenceService ??
        new ConversationPersistenceService({
          db: deps.db,
          conversationRepo: this.conversationRepo,
          messageRepo: this.messageRepo
        })
      this.conversationService =
        deps.conversationService ??
        new ConversationService({
          db: deps.db,
          conversationRepo: this.conversationRepo,
          messageRepo: this.messageRepo,
          activeWorkspaceContext: this.activeWorkspaceContext
        })
    } else {
      if (!deps.conversationRepo) {
        throw new ConversationTurnError(
          'ConversationRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.messageRepo) {
        throw new ConversationTurnError(
          'MessageRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.persistenceService) {
        throw new ConversationTurnError(
          'ConversationPersistenceService is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.conversationService) {
        throw new ConversationTurnError(
          'ConversationService is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      this.conversationRepo = deps.conversationRepo
      this.messageRepo = deps.messageRepo
      this.persistenceService = deps.persistenceService
      this.conversationService = deps.conversationService
      this.activeWorkspaceContext = deps.activeWorkspaceContext
    }

    if (!deps.executionService) {
      throw new ConversationTurnError(
        'ConversationExecutionService is required for ConversationTurnService.',
        'INVALID_INPUT'
      )
    }
    this.executionService = deps.executionService
  }

  /**
   * Returns whether a conversation currently has an active turn in progress.
   */
  public isGenerating(conversationId: string): boolean {
    return this.activeTurns.has(conversationId)
  }

  /**
   * Returns whether a conversation is currently undergoing deletion.
   */
  public isDeleting(conversationId: string): boolean {
    return this.deletingConversations.has(conversationId)
  }

  /**
   * Acquires an in-memory deletion lock on a conversation.
   * Throws CONCURRENT_TURN_ACTIVE if generation is in progress or if deletion is already underway.
   */
  public acquireDeletionLock(conversationId: string): void {
    if (this.activeTurns.has(conversationId)) {
      throw new ConversationTurnError(
        'Cannot delete conversation while generation is in progress. Please stop generation first.',
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    if (this.deletingConversations.has(conversationId)) {
      throw new ConversationTurnError(
        'Conversation deletion is already in progress.',
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    this.deletingConversations.add(conversationId)
  }

  /**
   * Releases an in-memory deletion lock on a conversation.
   */
  public releaseDeletionLock(conversationId: string): void {
    this.deletingConversations.delete(conversationId)
  }

  /**
   * Acquires an in-memory lock for an agent task on a conversation.
   * Throws CONCURRENT_TURN_ACTIVE if chat generation, an agent task, or deletion is in progress.
   */
  public acquireAgentTaskLock(conversationId: string): void {
    if (this.activeTurns.has(conversationId)) {
      throw new ConversationTurnError(
        `A generation is already in progress for conversation '${conversationId}'.`,
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    if (this.deletingConversations.has(conversationId)) {
      throw new ConversationTurnError(
        `Conversation '${conversationId}' is currently undergoing deletion.`,
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    this.activeTurns.add(conversationId)
  }

  /**
   * Releases an in-memory lock for an agent task on a conversation.
   */
  public releaseAgentTaskLock(conversationId: string): void {
    this.activeTurns.delete(conversationId)
  }

  /**
   * Returns the number of currently active generation operations across all conversations.
   */
  public getActiveTurnCount(): number {
    return this.activeTurns.size
  }

  /**
   * Initiates a new conversation turn:
   * 1. Pre-flight validation & abort check.
   * 2. Turn preparation via ConversationService.
   * 3. User message persistence into SQLite.
   * 4. Streaming execution via ConversationExecutionService.
   * 5. Assistant message persistence with authentic citations.
   * 6. Turn completion.
   */
  public sendMessage(
    sessionId: SessionId,
    request: SendMessageRequest,
    options?: TurnExecutionOptions
  ): ConversationTurnStream {
    // 1. Check early cancellation before any action
    if (options?.abortSignal?.aborted) {
      throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
    }

    // 2. Validate request
    const parsedRequest = sendMessageRequestSchema.safeParse(request)
    if (!parsedRequest.success) {
      const msg = parsedRequest.error.issues.map((i) => i.message).join('; ')
      throw new ConversationTurnError(`Invalid send message request: ${msg}`, 'INVALID_INPUT')
    }
    const validatedRequest = parsedRequest.data

    // 3. Acquire concurrent turn lock
    if (
      this.activeTurns.has(validatedRequest.conversationId) ||
      this.deletingConversations.has(validatedRequest.conversationId)
    ) {
      throw new ConversationTurnError(
        `A generation is already in progress for conversation '${validatedRequest.conversationId}'.`,
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    this.activeTurns.add(validatedRequest.conversationId)

    // 4. Resolve authoritative conversation record
    const conversation = this.conversationRepo.getByIdOnly(validatedRequest.conversationId)
    if (!conversation) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `Conversation with ID '${validatedRequest.conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }
    if (conversation.archivedAt !== null) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `Conversation '${conversation.title}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    // 5. Setup result promise & cancellation controller
    let resolveResult!: (result: ConversationTurnResult) => void
    let rejectResult!: (err: Error) => void
    const resultPromise = new Promise<ConversationTurnResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    resultPromise.catch(() => {})

    const internalController = new AbortController()
    const onCallerAbort = (): void => {
      internalController.abort()
    }
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', onCallerAbort)
    }

    // 6. Return stream wrapper with asynchronous generator
    const generator = this.executeSendTurn(
      sessionId,
      conversation,
      validatedRequest,
      options,
      internalController,
      onCallerAbort,
      resolveResult,
      rejectResult
    )

    return new TurnStreamWrapper(generator, resultPromise)
  }

  /**
   * Retries the latest unanswered user message in a conversation.
   * Reuses the stored user message without duplication, prepares a fresh turn,
   * executes generation, and persists only the resulting assistant response.
   */
  public retryLastUserMessage(
    sessionId: SessionId,
    request: RetryTurnRequest,
    options?: TurnExecutionOptions
  ): ConversationTurnStream {
    // 1. Check early cancellation
    if (options?.abortSignal?.aborted) {
      throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
    }

    // 2. Validate request
    const parsedRequest = retryTurnRequestSchema.safeParse(request)
    if (!parsedRequest.success) {
      const msg = parsedRequest.error.issues.map((i) => i.message).join('; ')
      throw new ConversationTurnError(`Invalid retry turn request: ${msg}`, 'INVALID_INPUT')
    }
    const validatedRequest = parsedRequest.data

    // 3. Acquire concurrent turn lock
    if (
      this.activeTurns.has(validatedRequest.conversationId) ||
      this.deletingConversations.has(validatedRequest.conversationId)
    ) {
      throw new ConversationTurnError(
        `A generation is already in progress for conversation '${validatedRequest.conversationId}'.`,
        'CONCURRENT_TURN_ACTIVE'
      )
    }
    this.activeTurns.add(validatedRequest.conversationId)

    // 4. Resolve authoritative conversation record
    const conversation = this.conversationRepo.getByIdOnly(validatedRequest.conversationId)
    if (!conversation) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `Conversation with ID '${validatedRequest.conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }
    if (conversation.archivedAt !== null) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `Conversation '${conversation.title}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    // 5. Verify message history eligibility
    const history = this.messageRepo.listByConversation(
      conversation.id,
      conversation.botId,
      conversation.knowledgeBaseId
    )
    if (history.length === 0) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        'No messages found in conversation to retry.',
        'NO_RETRYABLE_MESSAGE'
      )
    }

    const latestMessage = history[history.length - 1]
    if (latestMessage.role !== 'user') {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `The latest message in the conversation has role '${latestMessage.role}' and cannot be retried. An assistant response may already exist.`,
        'NO_RETRYABLE_MESSAGE'
      )
    }

    if (validatedRequest.messageId && latestMessage.id !== validatedRequest.messageId) {
      this.activeTurns.delete(validatedRequest.conversationId)
      throw new ConversationTurnError(
        `Message '${validatedRequest.messageId}' is not the latest message in this conversation.`,
        'NO_RETRYABLE_MESSAGE'
      )
    }

    // 6. Setup result promise & cancellation controller
    let resolveResult!: (result: ConversationTurnResult) => void
    let rejectResult!: (err: Error) => void
    const resultPromise = new Promise<ConversationTurnResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    resultPromise.catch(() => {})

    const internalController = new AbortController()
    const onCallerAbort = (): void => {
      internalController.abort()
    }
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', onCallerAbort)
    }

    // 7. Return stream wrapper with asynchronous generator
    const generator = this.executeRetryTurn(
      sessionId,
      conversation,
      latestMessage,
      options,
      internalController,
      onCallerAbort,
      resolveResult,
      rejectResult
    )

    return new TurnStreamWrapper(generator, resultPromise)
  }

  // ==========================================================================
  // Internal Execution Generators
  // ==========================================================================

  private async *executeSendTurn(
    sessionId: SessionId,
    conversation: { id: string; botId: string; knowledgeBaseId: string; title: string },
    request: SendMessageRequest,
    options: TurnExecutionOptions | undefined,
    internalController: AbortController,
    onCallerAbort: () => void,
    resolveResult: (result: ConversationTurnResult) => void,
    rejectResult: (err: Error) => void
  ): AsyncGenerator<ConversationTurnEvent> {
    let userMessage: MessageDto | undefined
    let assistantMessage: MessageDto | undefined
    let completedSuccessfully = false

    try {
      if (internalController.signal.aborted) {
        throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
      }

      // Step 2: Prepare turn
      const preparedTurn = this.conversationService.prepareTurn(sessionId, {
        botId: conversation.botId,
        conversationId: conversation.id,
        question: request.content,
        topK: options?.topK,
        maxContextTokens: options?.maxContextTokens,
        reservedOutputTokens: options?.reservedOutputTokens
      })

      if (internalController.signal.aborted) {
        throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
      }

      // Step 3: Persist user message before contacting provider
      userMessage = this.persistenceService.persistUserMessage(preparedTurn, request)

      if (internalController.signal.aborted) {
        throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
      }

      // Step 3.5: Knowledge Base Only Pre-Flight Guard:
      // If retrieval produces NO_RESULTS, RETRIEVAL_DISABLED, or EMPTY_QUERY,
      // DO NOT call the AI provider. Produce a deterministic application-owned refusal.
      if (
        preparedTurn.retrievalStatus === 'NO_RESULTS' ||
        preparedTurn.retrievalStatus === 'RETRIEVAL_DISABLED' ||
        preparedTurn.retrievalStatus === 'EMPTY_QUERY'
      ) {
        const refusalText =
          preparedTurn.retrievalStatus === 'NO_RESULTS'
            ? KnowledgeBaseOnlyPolicy.getNoResultsResponse()
            : preparedTurn.retrievalStatus === 'RETRIEVAL_DISABLED'
              ? KnowledgeBaseOnlyPolicy.getRetrievalDisabledResponse()
              : KnowledgeBaseOnlyPolicy.getEmptyQueryResponse()

        yield {
          type: 'text_delta',
          textDelta: refusalText
        }

        const syntheticResult: ConversationExecutionResult = {
          assistantText: refusalText,
          finishReason: 'stop',
          durationMs: 0,
          providerId: preparedTurn.providerId,
          modelId: preparedTurn.modelId,
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          citationCandidates: [],
          citationMap: new Map()
        }

        assistantMessage = this.persistenceService.persistAssistantMessage(
          preparedTurn,
          syntheticResult
        )

        completedSuccessfully = true
        const finalResult: ConversationTurnResult = {
          userMessage,
          assistantMessage,
          finishReason: 'stop',
          durationMs: 0
        }

        resolveResult(finalResult)

        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: undefined,
          totalTextLength: refusalText.length,
          durationMs: 0,
          message: assistantMessage
        }
        return
      }

      // Step 4: Execute provider generation
      const execStream = this.executionService.streamPreparedTurn(preparedTurn, {
        abortSignal: internalController.signal,
        temperature: options?.temperature
      })

      for await (const event of execStream) {
        if (event.type === 'text_delta') {
          yield event
        } else if (event.type === 'error') {
          const turnError = new ConversationTurnError(
            event.error.message,
            (event.error.code as ConversationTurnErrorCode) ?? 'EXECUTION_ERROR',
            event.error.retryable
          )
          rejectResult(turnError)
          yield {
            type: 'error',
            error: {
              code: turnError.code,
              message: turnError.message,
              retryable: turnError.retryable
            }
          }
          return
        }
      }

      // Step 5: Obtain execution result and validate grounding
      const executionResult = await execStream.getResult()

      const validation = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        executionResult.assistantText,
        preparedTurn.citationMap,
        preparedTurn.retrievalStatus
      )

      const effectiveResult: ConversationExecutionResult = validation.isValid
        ? executionResult
        : {
            ...executionResult,
            assistantText: validation.sanitizedContent
          }

      try {
        assistantMessage = this.persistenceService.persistAssistantMessage(
          preparedTurn,
          effectiveResult
        )
      } catch (persistErr) {
        const turnError = new ConversationTurnError(
          persistErr instanceof Error ? persistErr.message : String(persistErr),
          'PERSISTENCE_ERROR',
          false
        )
        rejectResult(turnError)
        yield {
          type: 'error',
          error: {
            code: 'PERSISTENCE_ERROR',
            message: turnError.message,
            retryable: false
          }
        }
        return
      }

      // Step 6: Complete the turn
      completedSuccessfully = true
      const finalResult: ConversationTurnResult = {
        userMessage,
        assistantMessage,
        finishReason: effectiveResult.finishReason,
        durationMs: effectiveResult.durationMs,
        usage: effectiveResult.usage
      }

      resolveResult(finalResult)

      yield {
        type: 'finish',
        finishReason: effectiveResult.finishReason,
        usage: effectiveResult.usage,
        totalTextLength: effectiveResult.assistantText.length,
        durationMs: effectiveResult.durationMs,
        message: assistantMessage
      }
    } catch (err) {
      const normalized = this.normalizeTurnError(err, internalController.signal.aborted)
      rejectResult(normalized)
      yield {
        type: 'error',
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable
        }
      }
    } finally {
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onCallerAbort)
      }
      if (!completedSuccessfully) {
        internalController.abort()
      }
      this.activeTurns.delete(request.conversationId)
    }
  }

  private async *executeRetryTurn(
    sessionId: SessionId,
    conversation: { id: string; botId: string; knowledgeBaseId: string; title: string },
    userMessage: MessageDto,
    options: TurnExecutionOptions | undefined,
    internalController: AbortController,
    onCallerAbort: () => void,
    resolveResult: (result: ConversationTurnResult) => void,
    rejectResult: (err: Error) => void
  ): AsyncGenerator<ConversationTurnEvent> {
    let assistantMessage: MessageDto | undefined
    let completedSuccessfully = false

    try {
      if (internalController.signal.aborted) {
        throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
      }

      // Step 1: Rebuild fresh turn without duplicating trailing user message
      const preparedTurn = this.conversationService.prepareTurn(sessionId, {
        botId: conversation.botId,
        conversationId: conversation.id,
        question: userMessage.content,
        topK: options?.topK,
        maxContextTokens: options?.maxContextTokens,
        reservedOutputTokens: options?.reservedOutputTokens,
        excludeTrailingMessageId: userMessage.id
      })

      if (internalController.signal.aborted) {
        throw new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
      }

      // Step 1.5: Knowledge Base Only Pre-Flight Guard:
      // If retrieval produces NO_RESULTS, RETRIEVAL_DISABLED, or EMPTY_QUERY,
      // DO NOT call the AI provider. Produce a deterministic application-owned refusal.
      if (
        preparedTurn.retrievalStatus === 'NO_RESULTS' ||
        preparedTurn.retrievalStatus === 'RETRIEVAL_DISABLED' ||
        preparedTurn.retrievalStatus === 'EMPTY_QUERY'
      ) {
        const refusalText =
          preparedTurn.retrievalStatus === 'NO_RESULTS'
            ? KnowledgeBaseOnlyPolicy.getNoResultsResponse()
            : preparedTurn.retrievalStatus === 'RETRIEVAL_DISABLED'
              ? KnowledgeBaseOnlyPolicy.getRetrievalDisabledResponse()
              : KnowledgeBaseOnlyPolicy.getEmptyQueryResponse()

        yield {
          type: 'text_delta',
          textDelta: refusalText
        }

        const syntheticResult: ConversationExecutionResult = {
          assistantText: refusalText,
          finishReason: 'stop',
          durationMs: 0,
          providerId: preparedTurn.providerId,
          modelId: preparedTurn.modelId,
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          citationCandidates: [],
          citationMap: new Map()
        }

        assistantMessage = this.persistenceService.persistAssistantMessage(
          preparedTurn,
          syntheticResult
        )

        completedSuccessfully = true
        const finalResult: ConversationTurnResult = {
          userMessage,
          assistantMessage,
          finishReason: 'stop',
          durationMs: 0
        }

        resolveResult(finalResult)

        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: undefined,
          totalTextLength: refusalText.length,
          durationMs: 0,
          message: assistantMessage
        }
        return
      }

      // Step 2: Execute provider generation (user message is already persisted)
      const execStream = this.executionService.streamPreparedTurn(preparedTurn, {
        abortSignal: internalController.signal,
        temperature: options?.temperature
      })

      for await (const event of execStream) {
        if (event.type === 'text_delta') {
          yield event
        } else if (event.type === 'error') {
          const turnError = new ConversationTurnError(
            event.error.message,
            (event.error.code as ConversationTurnErrorCode) ?? 'EXECUTION_ERROR',
            event.error.retryable
          )
          rejectResult(turnError)
          yield {
            type: 'error',
            error: {
              code: turnError.code,
              message: turnError.message,
              retryable: turnError.retryable
            }
          }
          return
        }
      }

      // Step 3: Obtain execution result and validate grounding
      const executionResult = await execStream.getResult()

      const validation = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        executionResult.assistantText,
        preparedTurn.citationMap,
        preparedTurn.retrievalStatus
      )

      const effectiveResult: ConversationExecutionResult = validation.isValid
        ? executionResult
        : {
            ...executionResult,
            assistantText: validation.sanitizedContent
          }

      try {
        assistantMessage = this.persistenceService.persistAssistantMessage(
          preparedTurn,
          effectiveResult
        )
      } catch (persistErr) {
        const turnError = new ConversationTurnError(
          persistErr instanceof Error ? persistErr.message : String(persistErr),
          'PERSISTENCE_ERROR',
          false
        )
        rejectResult(turnError)
        yield {
          type: 'error',
          error: {
            code: 'PERSISTENCE_ERROR',
            message: turnError.message,
            retryable: false
          }
        }
        return
      }

      // Step 4: Complete the turn
      completedSuccessfully = true
      const finalResult: ConversationTurnResult = {
        userMessage,
        assistantMessage,
        finishReason: effectiveResult.finishReason,
        durationMs: effectiveResult.durationMs,
        usage: effectiveResult.usage
      }

      resolveResult(finalResult)

      yield {
        type: 'finish',
        finishReason: effectiveResult.finishReason,
        usage: effectiveResult.usage,
        totalTextLength: effectiveResult.assistantText.length,
        durationMs: effectiveResult.durationMs,
        message: assistantMessage
      }
    } catch (err) {
      const normalized = this.normalizeTurnError(err, internalController.signal.aborted)
      rejectResult(normalized)
      yield {
        type: 'error',
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable
        }
      }
    } finally {
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onCallerAbort)
      }
      if (!completedSuccessfully) {
        internalController.abort()
      }
      this.activeTurns.delete(conversation.id)
    }
  }

  // ==========================================================================
  // Private Error Normalization
  // ==========================================================================

  private normalizeTurnError(err: unknown, wasAborted: boolean): ConversationTurnError {
    if (wasAborted) {
      return new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
    }

    if (err instanceof ConversationTurnError) {
      return err
    }

    if (err instanceof ConversationExecutionError) {
      return new ConversationTurnError(
        err.message,
        (err.code as ConversationTurnErrorCode) ?? 'EXECUTION_ERROR',
        err.retryable
      )
    }

    if (err instanceof ConversationServiceError) {
      return new ConversationTurnError(
        err.message,
        (err.code as ConversationTurnErrorCode) ?? 'INVALID_INPUT',
        false
      )
    }

    if (err instanceof ConversationPersistenceError) {
      return new ConversationTurnError(
        err.message,
        (err.code as ConversationTurnErrorCode) ?? 'PERSISTENCE_ERROR',
        false
      )
    }

    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('abort') || message.includes('Abort')) {
      return new ConversationTurnError('Operation was aborted by client.', 'OPERATION_ABORTED')
    }

    return new ConversationTurnError(message, 'EXECUTION_ERROR', false)
  }
}
