import type { MessageDto } from '../../shared/conversations'
import type { BotRagRetrievalResult } from './bot-rag-service'
import { RagPromptBuilder, type RagPromptResult, type BotPromptConfig } from './rag-prompt-builder'

// ============================================================================
// Service Constants & Limits
// ============================================================================

export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096
export const MIN_RESERVED_OUTPUT_TOKENS = 1
export const MAX_RESERVED_OUTPUT_TOKENS = 128000

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1000
export const MIN_SAFETY_MARGIN_TOKENS = 0

export const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 4 // Per-message framing overhead (~4 tokens)

// ============================================================================
// Error Types
// ============================================================================

export type ConversationContextManagerErrorCode =
  'INVALID_INPUT' | 'INVALID_CONTEXT_WINDOW' | 'CONTEXT_LENGTH_EXCEEDED' | 'RETRIEVAL_ERROR'

export class ConversationContextManagerError extends Error {
  public readonly code: ConversationContextManagerErrorCode

  constructor(message: string, code: ConversationContextManagerErrorCode) {
    super(message)
    this.name = 'ConversationContextManagerError'
    this.code = code
    Object.setPrototypeOf(this, ConversationContextManagerError.prototype)
  }
}

// ============================================================================
// Context Manager Contracts
// ============================================================================

export interface ConversationContextManagerInput {
  readonly bot: BotPromptConfig
  readonly history: readonly MessageDto[]
  readonly question: string
  readonly retrievalResult: BotRagRetrievalResult
  readonly modelContextLimit: number
  readonly reservedOutputTokens?: number
  readonly safetyMarginTokens?: number
  readonly messageOverheadTokens?: number
}

export interface ConversationTurn {
  readonly turnIndex: number
  readonly messages: readonly MessageDto[]
}

export interface ConversationContextResult {
  readonly promptResult: RagPromptResult
  readonly selectedHistory: readonly MessageDto[]
  readonly includedMessageCount: number
  readonly excludedMessageCount: number
  readonly estimatedInputTokens: number
  readonly availableInputTokens: number
  readonly reservedOutputTokens: number
  readonly modelContextLimit: number
  readonly historyTrimmingOccurred: boolean
  readonly fitsWithinBudget: boolean
}

// ============================================================================
// Turn Grouping Helper
// ============================================================================

/**
 * Groups historical messages into atomic conversation turns.
 * A turn begins with a user message and includes all assistant/tool messages
 * that follow until the next user message arrives.
 * Preserves strict chronological order and prevents splitting user/assistant pairs.
 */
export function groupMessagesIntoTurns(history: readonly MessageDto[]): ConversationTurn[] {
  if (history.length === 0) {
    return []
  }

  const turns: ConversationTurn[] = []
  let currentTurnMessages: MessageDto[] = []

  for (const msg of history) {
    if (msg.role === 'user' && currentTurnMessages.length > 0) {
      turns.push({
        turnIndex: turns.length,
        messages: Object.freeze([...currentTurnMessages])
      })
      currentTurnMessages = []
    }
    currentTurnMessages.push(msg)
  }

  if (currentTurnMessages.length > 0) {
    turns.push({
      turnIndex: turns.length,
      messages: Object.freeze([...currentTurnMessages])
    })
  }

  return turns
}

// ============================================================================
// ConversationContextManager Implementation
// ============================================================================

/**
 * Deterministic Main-process context manager that selects historical conversation turns
 * to fit within the authoritative model's context window budget.
 */
export class ConversationContextManager {
  /**
   * Selects historical messages and builds the final RAG prompt within budget.
   */
  public static selectContext(input: ConversationContextManagerInput): ConversationContextResult {
    if (!input || typeof input !== 'object') {
      throw new ConversationContextManagerError(
        'Context manager input must be an object.',
        'INVALID_INPUT'
      )
    }

    // 1. Validate model context window limit
    if (
      typeof input.modelContextLimit !== 'number' ||
      !Number.isInteger(input.modelContextLimit) ||
      input.modelContextLimit <= 0
    ) {
      throw new ConversationContextManagerError(
        `modelContextLimit must be a positive integer. Received: ${input.modelContextLimit}`,
        'INVALID_INPUT'
      )
    }
    const modelContextLimit = input.modelContextLimit

    // 2. Validate reserved output tokens
    const reservedOutputTokens =
      input.reservedOutputTokens !== undefined
        ? input.reservedOutputTokens
        : DEFAULT_RESERVED_OUTPUT_TOKENS

    if (
      typeof reservedOutputTokens !== 'number' ||
      !Number.isInteger(reservedOutputTokens) ||
      reservedOutputTokens < MIN_RESERVED_OUTPUT_TOKENS
    ) {
      throw new ConversationContextManagerError(
        `reservedOutputTokens must be an integer >= ${MIN_RESERVED_OUTPUT_TOKENS}. Received: ${reservedOutputTokens}`,
        'INVALID_INPUT'
      )
    }

    if (reservedOutputTokens >= modelContextLimit) {
      throw new ConversationContextManagerError(
        `Reserved output tokens (${reservedOutputTokens}) cannot equal or exceed total model context window (${modelContextLimit}).`,
        'INVALID_INPUT'
      )
    }

    // 3. Validate safety margin tokens
    const safetyMarginTokens =
      input.safetyMarginTokens !== undefined
        ? input.safetyMarginTokens
        : DEFAULT_SAFETY_MARGIN_TOKENS

    if (
      typeof safetyMarginTokens !== 'number' ||
      !Number.isInteger(safetyMarginTokens) ||
      safetyMarginTokens < MIN_SAFETY_MARGIN_TOKENS
    ) {
      throw new ConversationContextManagerError(
        `safetyMarginTokens must be a non-negative integer. Received: ${safetyMarginTokens}`,
        'INVALID_INPUT'
      )
    }

    // 4. Validate message framing overhead
    const messageOverheadPerMsg =
      input.messageOverheadTokens !== undefined
        ? input.messageOverheadTokens
        : DEFAULT_MESSAGE_OVERHEAD_TOKENS

    if (
      typeof messageOverheadPerMsg !== 'number' ||
      !Number.isInteger(messageOverheadPerMsg) ||
      messageOverheadPerMsg < 0
    ) {
      throw new ConversationContextManagerError(
        `messageOverheadTokens must be a non-negative integer. Received: ${messageOverheadPerMsg}`,
        'INVALID_INPUT'
      )
    }

    // 5. Calculate available input token budget
    const availableInputTokens = modelContextLimit - reservedOutputTokens - safetyMarginTokens
    if (availableInputTokens <= 0) {
      throw new ConversationContextManagerError(
        `Available input tokens (${availableInputTokens}) must be positive after deducting reserved output (${reservedOutputTokens}) and safety margin (${safetyMarginTokens}).`,
        'INVALID_CONTEXT_WINDOW'
      )
    }

    // 6. Group historical messages into atomic conversation turns
    const turns = groupMessagesIntoTurns(input.history)

    // 7. Deterministic turn selection loop (oldest turns removed first if over budget)
    let selectedTurns = turns
    let promptResult: RagPromptResult | null = null
    let totalEstimatedInputTokens = 0
    let startTurnIndex = 0

    while (startTurnIndex <= turns.length) {
      selectedTurns = turns.slice(startTurnIndex)
      const candidateMessages = selectedTurns.flatMap((t) => t.messages)

      try {
        promptResult = RagPromptBuilder.build({
          bot: input.bot,
          history: candidateMessages,
          question: input.question,
          retrievalResult: input.retrievalResult
        })
      } catch (err) {
        throw new ConversationContextManagerError(
          `Failed to construct candidate prompt: ${err instanceof Error ? err.message : String(err)}`,
          'INVALID_INPUT'
        )
      }

      // Calculate total input tokens including message framing overhead
      const framingOverhead = promptResult.messages.length * messageOverheadPerMsg
      totalEstimatedInputTokens = promptResult.tokenEstimates.totalEstimatedTokens + framingOverhead

      if (totalEstimatedInputTokens <= availableInputTokens) {
        // Fits within budget!
        break
      }

      // If over budget and there are turns to remove, trim the oldest complete turn
      if (startTurnIndex < turns.length) {
        startTurnIndex++
      } else {
        // Even with 0 historical turns, mandatory prompt exceeds budget
        break
      }
    }

    // 8. If mandatory prompt alone exceeds available budget, reject with typed overflow error
    if (!promptResult || totalEstimatedInputTokens > availableInputTokens) {
      throw new ConversationContextManagerError(
        `Mandatory prompt components (${totalEstimatedInputTokens} estimated tokens) exceed the available input token budget (${availableInputTokens} tokens).`,
        'CONTEXT_LENGTH_EXCEEDED'
      )
    }

    const selectedHistory = selectedTurns.flatMap((t) => t.messages)
    const includedMessageCount = selectedHistory.length
    const excludedMessageCount = input.history.length - includedMessageCount
    const historyTrimmingOccurred = excludedMessageCount > 0

    return {
      promptResult,
      selectedHistory: Object.freeze([...selectedHistory]),
      includedMessageCount,
      excludedMessageCount,
      estimatedInputTokens: totalEstimatedInputTokens,
      availableInputTokens,
      reservedOutputTokens,
      modelContextLimit,
      historyTrimmingOccurred,
      fitsWithinBudget: true
    }
  }
}

/**
 * Functional shorthand for ConversationContextManager.selectContext.
 */
export function selectConversationContext(
  input: ConversationContextManagerInput
): ConversationContextResult {
  return ConversationContextManager.selectContext(input)
}
