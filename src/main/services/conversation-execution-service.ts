import type { PreparedConversationTurn } from './conversation-service'
import { ProviderManagerService } from '../providers/provider-manager/provider-manager-service'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'
import type {
  ChatMessage,
  ProviderError,
  ProviderErrorCode,
  ProviderId,
  TokenUsage
} from '../providers/types'
import type { CitationDto } from '../../shared/conversations'

// ============================================================================
// Error Contracts
// ============================================================================

export type ConversationExecutionErrorCode =
  ProviderErrorCode | 'INVALID_INPUT' | 'EXECUTION_ERROR' | 'UNEXPECTED_STREAM_TERMINATION'

export class ConversationExecutionError extends Error {
  public readonly code: ConversationExecutionErrorCode
  public readonly retryable: boolean

  constructor(message: string, code: ConversationExecutionErrorCode, retryable: boolean = false) {
    const sanitized = sanitizeErrorMessage(message)
    super(sanitized)
    this.name = 'ConversationExecutionError'
    this.code = code
    this.retryable = retryable
    Object.setPrototypeOf(this, ConversationExecutionError.prototype)
  }
}

// ============================================================================
// Stream Event Contracts
// ============================================================================

export interface TextDeltaEvent {
  readonly type: 'text_delta'
  readonly textDelta: string
}

export interface FinishEvent {
  readonly type: 'finish'
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly usage?: TokenUsage
  readonly totalTextLength: number
  readonly durationMs: number
}

export interface ErrorEvent {
  readonly type: 'error'
  readonly error: {
    readonly code: ConversationExecutionErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export type ConversationExecutionEvent = TextDeltaEvent | FinishEvent | ErrorEvent

// ============================================================================
// Execution Result & Stream Contracts
// ============================================================================

export interface ConversationExecutionResult {
  readonly assistantText: string
  readonly usage?: TokenUsage
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other'
  readonly durationMs: number
  readonly providerId: ProviderId
  readonly modelId: string
  readonly botId: string
  readonly conversationId: string
  readonly citationCandidates: readonly CitationDto[]
  readonly citationMap: ReadonlyMap<number, CitationDto>
}

export interface StreamExecutionOptions {
  readonly abortSignal?: AbortSignal
  readonly temperature?: number
}

export interface ConversationExecutionStream extends AsyncIterable<ConversationExecutionEvent> {
  getResult(): Promise<ConversationExecutionResult>
}

// ============================================================================
// Helper Wrapper
// ============================================================================

class ExecutionStreamWrapper implements ConversationExecutionStream {
  private readonly generator: AsyncGenerator<ConversationExecutionEvent>
  private readonly resultPromise: Promise<ConversationExecutionResult>

  constructor(
    generator: AsyncGenerator<ConversationExecutionEvent>,
    resultPromise: Promise<ConversationExecutionResult>
  ) {
    this.generator = generator
    this.resultPromise = resultPromise
  }

  [Symbol.asyncIterator](): AsyncGenerator<ConversationExecutionEvent> {
    return this.generator
  }

  public getResult(): Promise<ConversationExecutionResult> {
    return this.resultPromise
  }
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface ConversationExecutionServiceDependencies {
  readonly providerManagerService: ProviderManagerService
}

// ============================================================================
// ConversationExecutionService Implementation
// ============================================================================

/**
 * Main-process centralized service for dispatching validated AI generation requests
 * through provider adapters via ProviderManagerService.
 *
 * Invariants:
 * 1. Operates exclusively in the Electron Main process.
 * 2. Only accepts internally prepared, immutable PreparedConversationTurn objects.
 * 3. Never passes tool definitions to AI providers (CURRENT_APPLICATION_CAPABILITIES.tools = false).
 * 4. Never exposes or logs plaintext API keys, authorization headers, or credential references.
 * 5. Never exposes citation maps, source IDs, or chunk IDs to provider SDK request metadata.
 * 6. Accumulates assistant response text deterministically, exactly matching emitted text deltas.
 * 7. Supports graceful cancellation via AbortSignal without emitting false finish events.
 * 8. Never performs database mutations or message persistence in this step.
 */
export class ConversationExecutionService {
  private readonly providerManagerService: ProviderManagerService

  constructor(deps: ConversationExecutionServiceDependencies | ProviderManagerService) {
    if (!deps) {
      throw new ConversationExecutionError(
        'ProviderManagerService dependency is required for ConversationExecutionService.',
        'INVALID_INPUT'
      )
    }

    if ('streamText' in deps) {
      this.providerManagerService = deps
    } else {
      this.providerManagerService = deps.providerManagerService
    }
  }

  /**
   * Dispatches a validated PreparedConversationTurn to the designated AI provider,
   * yielding a normalized stream of execution events (text_delta, finish, error).
   *
   * The returned stream provides a `getResult()` method that resolves with the
   * complete accumulated result upon successful completion, or rejects if cancelled or failed.
   */
  public streamPreparedTurn(
    preparedTurn: PreparedConversationTurn,
    options?: StreamExecutionOptions
  ): ConversationExecutionStream {
    this.validatePreparedTurn(preparedTurn)

    let resolveResult!: (value: ConversationExecutionResult) => void
    let rejectResult!: (reason?: unknown) => void
    const resultPromise = new Promise<ConversationExecutionResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // Prevent unhandled promise rejection if caller consumes only the stream events without getResult()
    resultPromise.catch(() => {})

    const generator = this.createExecutionGenerator(
      preparedTurn,
      options,
      resolveResult,
      rejectResult
    )

    return new ExecutionStreamWrapper(generator, resultPromise)
  }

  /**
   * Executes a validated PreparedConversationTurn and returns the completed result
   * after fully consuming the provider stream.
   */
  public async executePreparedTurn(
    preparedTurn: PreparedConversationTurn,
    options?: StreamExecutionOptions
  ): Promise<ConversationExecutionResult> {
    const stream = this.streamPreparedTurn(preparedTurn, options)
    for await (const event of stream) {
      void event
    }
    return stream.getResult()
  }

  // ==========================================================================
  // Private Generator & Dispatch
  // ==========================================================================

  private async *createExecutionGenerator(
    preparedTurn: PreparedConversationTurn,
    options: StreamExecutionOptions | undefined,
    resolveResult: (value: ConversationExecutionResult) => void,
    rejectResult: (reason?: unknown) => void
  ): AsyncGenerator<ConversationExecutionEvent> {
    // 1. Check immediate cancellation before start
    if (options?.abortSignal?.aborted) {
      const abortErr = new ConversationExecutionError(
        'Generation was cancelled before execution started.',
        'OPERATION_ABORTED'
      )
      rejectResult(abortErr)
      yield {
        type: 'error',
        error: {
          code: 'OPERATION_ABORTED',
          message: abortErr.message,
          retryable: false
        }
      }
      return
    }

    // 2. Setup internal AbortController bridging caller abort signal
    const internalController = new AbortController()
    let onCallerAbort: (() => void) | undefined

    if (options?.abortSignal) {
      onCallerAbort = () => {
        internalController.abort(options.abortSignal?.reason ?? 'Client requested cancellation.')
      }
      options.abortSignal.addEventListener('abort', onCallerAbort, { once: true })
    }

    const startTime = Date.now()
    let accumulatedText = ''
    let finishEventEmitted = false
    let finalUsage: TokenUsage | undefined
    let finalFinishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'abort' | 'other' =
      'stop'
    let hasTerminatedWithError = false

    try {
      // 3. Map chronological messages for provider SDK format
      // Uses conversationMessages (chronological user/assistant turns without the system message)
      const providerMessages: ChatMessage[] = preparedTurn.conversationMessages.map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content: msg.content
      }))

      // 4. Dispatch stream to ProviderManagerService
      const rawStream = this.providerManagerService.streamText(
        preparedTurn.providerConnectionId,
        preparedTurn.modelId,
        {
          systemPrompt: preparedTurn.systemInstruction,
          messages: providerMessages,
          maxTokens: preparedTurn.reservedOutputTokens,
          temperature: options?.temperature,
          abortSignal: internalController.signal
        }
      )

      for await (const chunk of rawStream) {
        // Check if aborted during iteration
        if (internalController.signal.aborted) {
          hasTerminatedWithError = true
          const abortErr = new ConversationExecutionError(
            'Generation was cancelled by client.',
            'OPERATION_ABORTED'
          )
          rejectResult(abortErr)
          yield {
            type: 'error',
            error: {
              code: 'OPERATION_ABORTED',
              message: abortErr.message,
              retryable: false
            }
          }
          return
        }

        if (chunk.type === 'text-delta') {
          accumulatedText += chunk.textDelta
          yield {
            type: 'text_delta',
            textDelta: chunk.textDelta
          }
        } else if (chunk.type === 'finish') {
          // If the finish chunk reports an abort, treat it strictly as cancellation, not success
          if (chunk.finishReason === 'abort' || internalController.signal.aborted) {
            hasTerminatedWithError = true
            const abortErr = new ConversationExecutionError(
              'Generation was cancelled by client.',
              'OPERATION_ABORTED'
            )
            rejectResult(abortErr)
            yield {
              type: 'error',
              error: {
                code: 'OPERATION_ABORTED',
                message: abortErr.message,
                retryable: false
              }
            }
            return
          }

          finishEventEmitted = true
          finalFinishReason = chunk.finishReason
          finalUsage = chunk.usage
          const durationMs = Date.now() - startTime

          yield {
            type: 'finish',
            finishReason: chunk.finishReason,
            usage: chunk.usage,
            totalTextLength: accumulatedText.length,
            durationMs
          }
        } else if (chunk.type === 'error') {
          hasTerminatedWithError = true
          const sanitized = this.normalizeProviderError(chunk.error)
          const execError = new ConversationExecutionError(
            sanitized.message,
            sanitized.code,
            sanitized.retryable
          )
          rejectResult(execError)
          yield {
            type: 'error',
            error: sanitized
          }
          return
        }
      }

      // 5. Handle stream termination without explicit finish event
      if (!finishEventEmitted && !hasTerminatedWithError) {
        if (internalController.signal.aborted) {
          hasTerminatedWithError = true
          const abortErr = new ConversationExecutionError(
            'Generation was cancelled by client.',
            'OPERATION_ABORTED'
          )
          rejectResult(abortErr)
          yield {
            type: 'error',
            error: {
              code: 'OPERATION_ABORTED',
              message: abortErr.message,
              retryable: false
            }
          }
        } else {
          // Stream ended cleanly without finish event
          finishEventEmitted = true
          const durationMs = Date.now() - startTime
          yield {
            type: 'finish',
            finishReason: finalFinishReason,
            usage: finalUsage,
            totalTextLength: accumulatedText.length,
            durationMs
          }
        }
      }

      // 6. Resolve final completed result upon success
      if (finishEventEmitted && !hasTerminatedWithError) {
        resolveResult({
          assistantText: accumulatedText,
          usage: finalUsage,
          finishReason: finalFinishReason,
          durationMs: Date.now() - startTime,
          providerId: preparedTurn.providerId,
          modelId: preparedTurn.modelId,
          botId: preparedTurn.botId,
          conversationId: preparedTurn.conversationId,
          citationCandidates: preparedTurn.citationCandidates,
          citationMap: preparedTurn.citationMap
        })
      }
    } catch (err: unknown) {
      hasTerminatedWithError = true
      const normalized = this.normalizeThrownError(err, internalController.signal.aborted)
      const execError = new ConversationExecutionError(
        normalized.message,
        normalized.code,
        normalized.retryable
      )
      rejectResult(execError)
      yield {
        type: 'error',
        error: normalized
      }
    } finally {
      // 7. Cleanup listeners and abort internal controller if stream was abandoned early
      if (options?.abortSignal && onCallerAbort) {
        options.abortSignal.removeEventListener('abort', onCallerAbort)
      }

      if (!finishEventEmitted && !hasTerminatedWithError) {
        internalController.abort('Consumer closed stream early.')
        rejectResult(
          new ConversationExecutionError(
            'Stream was closed early by consumer.',
            'OPERATION_ABORTED'
          )
        )
      }
    }
  }

  // ==========================================================================
  // Validation and Error Normalization Helpers
  // ==========================================================================

  private validatePreparedTurn(turn: PreparedConversationTurn): void {
    if (!turn || typeof turn !== 'object') {
      throw new ConversationExecutionError(
        'PreparedConversationTurn must be an object.',
        'INVALID_INPUT'
      )
    }

    if (!turn.providerConnectionId || typeof turn.providerConnectionId !== 'string') {
      throw new ConversationExecutionError(
        'PreparedConversationTurn must have a valid providerConnectionId.',
        'INVALID_INPUT'
      )
    }

    if (!turn.modelId || typeof turn.modelId !== 'string') {
      throw new ConversationExecutionError(
        'PreparedConversationTurn must have a valid modelId.',
        'INVALID_INPUT'
      )
    }

    if (!Array.isArray(turn.messages) || !Array.isArray(turn.conversationMessages)) {
      throw new ConversationExecutionError(
        'PreparedConversationTurn messages must be arrays.',
        'INVALID_INPUT'
      )
    }
  }

  private normalizeProviderError(error: ProviderError): {
    readonly code: ConversationExecutionErrorCode
    readonly message: string
    readonly retryable: boolean
  } {
    const rawCode = error.code
    const sanitizedMsg = sanitizeErrorMessage(error.message)

    return {
      code: rawCode ?? 'UNKNOWN_ERROR',
      message: sanitizedMsg,
      retryable: error.retryable ?? false
    }
  }

  private normalizeThrownError(
    err: unknown,
    wasAborted: boolean
  ): {
    readonly code: ConversationExecutionErrorCode
    readonly message: string
    readonly retryable: boolean
  } {
    if (wasAborted) {
      return {
        code: 'OPERATION_ABORTED',
        message: 'Generation was cancelled by client.',
        retryable: false
      }
    }

    if (err instanceof ConversationExecutionError) {
      return {
        code: err.code,
        message: err.message,
        retryable: err.retryable
      }
    }

    if (err && typeof err === 'object') {
      const errorObj = err as Record<string, unknown>
      if (errorObj.name === 'AbortError' || errorObj.code === 'OPERATION_ABORTED') {
        return {
          code: 'OPERATION_ABORTED',
          message: 'Generation was cancelled by client.',
          retryable: false
        }
      }

      if (errorObj.code === 'TIMEOUT' || errorObj.name === 'TimeoutError') {
        return {
          code: 'TIMEOUT',
          message: 'Provider generation request timed out.',
          retryable: true
        }
      }

      if (errorObj.code === 'CONTEXT_LENGTH_EXCEEDED') {
        return {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: sanitizeErrorMessage(String(errorObj.message ?? 'Context length exceeded.')),
          retryable: false
        }
      }

      if (typeof errorObj.message === 'string') {
        const msg = errorObj.message.toLowerCase()
        if (msg.includes('timed out') || msg.includes('timeout')) {
          return {
            code: 'TIMEOUT',
            message: 'Provider generation request timed out.',
            retryable: true
          }
        }
        if (msg.includes('context length') || msg.includes('maximum context')) {
          return {
            code: 'CONTEXT_LENGTH_EXCEEDED',
            message: sanitizeErrorMessage(errorObj.message),
            retryable: false
          }
        }
      }
    }

    const message = err instanceof Error ? err.message : String(err)
    return {
      code: 'EXECUTION_ERROR',
      message: sanitizeErrorMessage(message),
      retryable: false
    }
  }
}
