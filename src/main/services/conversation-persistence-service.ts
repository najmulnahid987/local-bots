import type Database from 'better-sqlite3'
import {
  sendMessageRequestSchema,
  messageTokenUsageSchema,
  type SendMessageRequest,
  type MessageDto,
  type CitationDto,
  type MessageTokenUsageDto,
  type MessageMetadataDto,
  type GenerationMetadataDto
} from '../../shared/conversations'
import type { PreparedConversationTurn } from './conversation-service'
import type { ConversationExecutionResult } from './conversation-execution-service'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ValidationError } from '../database/repositories/types'

// ============================================================================
// Error Contracts
// ============================================================================

export type ConversationPersistenceErrorCode =
  | 'INVALID_INPUT'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ARCHIVED'
  | 'CONVERSATION_MISMATCH'
  | 'BOT_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'MODEL_MISMATCH'
  | 'EXECUTION_FAILED'
  | 'PERSISTENCE_ERROR'

export class ConversationPersistenceError extends Error {
  public readonly code: ConversationPersistenceErrorCode

  constructor(message: string, code: ConversationPersistenceErrorCode) {
    super(message)
    this.name = 'ConversationPersistenceError'
    this.code = code
    Object.setPrototypeOf(this, ConversationPersistenceError.prototype)
  }
}

// ============================================================================
// Citation Parsing and Linking Helper
// ============================================================================

/**
 * Parses citation markers from assistant text and resolves them exclusively
 * against the authoritative prepared-turn citation map.
 *
 * Requirements & Invariants:
 * 1. Matches bracketed citation markers e.g. [1], [2], [1, 2], [1, 3, 5], [1][2].
 * 2. Parses positive integers (>= 1).
 * 3. Resolves each parsed number against `citationMap.get(num)`.
 * 4. Deduplicates repeated references while preserving first-appearance order.
 * 5. Ignores unknown, out-of-range, or negative citation numbers.
 * 6. Markdown numbered lists (e.g. "1. Step") and links (e.g. "[text](url)") are not citations.
 * 7. Never accepts citation source IDs, chunk IDs, or file paths supplied by the model text.
 * 8. Returns an empty array if no authentic citations are found or if assistant text is empty.
 */
export function parseAndLinkCitations(
  assistantText: string,
  citationMap?: ReadonlyMap<number, CitationDto> | null
): CitationDto[] {
  if (
    !assistantText ||
    typeof assistantText !== 'string' ||
    !citationMap ||
    citationMap.size === 0
  ) {
    return []
  }

  // 1. Strip fenced code blocks (``` ... ``` or ~~~ ... ~~~)
  const textWithoutFencedCode = assistantText.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')

  // 2. Strip CommonMark link reference definitions (e.g. [1]: https://example.com)
  const textWithoutRefDefs = textWithoutFencedCode.replace(/^[ ]{0,3}\[\d+\]:\s+\S+.*$/gm, ' ')

  // 3. Strip inline code (`...`)
  const sanitizedText = textWithoutRefDefs.replace(/`[^`\n]*`/g, ' ')

  // 4. Matches bracketed numeric sequences like [1], [2], [1, 2], [1, 3, 5]
  // Negative lookahead (?!\s*\() ensures markdown links like [1](https://...) are ignored,
  // while trailing colons like [1]: in prose (e.g. "as shown below [1]:") are preserved.
  const bracketRegex = /\[([0-9]+(?:\s*,\s*[0-9]+)*)\](?!\s*\()/g
  const seenNumbers = new Set<number>()
  const linkedCitations: CitationDto[] = []

  let match: RegExpExecArray | null
  while ((match = bracketRegex.exec(sanitizedText)) !== null) {
    const numbersGroup = match[1]
    const parts = numbersGroup.split(',')
    for (const part of parts) {
      const num = parseInt(part.trim(), 10)
      if (!Number.isNaN(num) && num > 0 && !seenNumbers.has(num)) {
        seenNumbers.add(num)
        const authentic = citationMap.get(num)
        if (authentic) {
          linkedCitations.push(authentic)
        }
      }
    }
  }

  return linkedCitations
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface PersistPartialAssistantMessageOptions {
  readonly status: 'cancelled' | 'failed' | 'interrupted'
  readonly interruptedReason?: string
  readonly finishReason?: string
  readonly durationMs?: number
  readonly tokenUsage?: MessageTokenUsageDto | null
}

export interface ConversationPersistenceServiceDependencies {
  readonly conversationRepo?: ConversationRepository
  readonly messageRepo?: MessageRepository
  readonly db?: Database.Database
}

// ============================================================================
// ConversationPersistenceService
// ============================================================================

/**
 * Main-process service responsible for persisting user messages and completed
 * assistant responses into SQLite, with authentic citation and token usage linking.
 *
 * Invariants:
 * 1. Main-process only: never called directly by Renderer; invoked via IPC/Orchestrator.
 * 2. Never accepts an untrusted knowledgeBaseId or botId from Renderer.
 * 3. User message is persisted before provider generation starts.
 * 4. Assistant message is persisted only after successful provider generation.
 * 5. Failed or aborted executions are never persisted as assistant messages.
 * 6. Citations link exclusively to authentic database records from PreparedConversationTurn.citationMap.
 * 7. Authentic provider token usage is persisted when available; never substituted with estimates.
 */
export class ConversationPersistenceService {
  private readonly conversationRepo: ConversationRepository
  private readonly messageRepo: MessageRepository

  constructor(deps: ConversationPersistenceServiceDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new ConversationPersistenceError(
        'Dependencies object is required for ConversationPersistenceService.',
        'INVALID_INPUT'
      )
    }

    if (deps.db) {
      this.conversationRepo = deps.conversationRepo ?? new ConversationRepository(deps.db)
      this.messageRepo = deps.messageRepo ?? new MessageRepository(deps.db)
    } else {
      if (!deps.conversationRepo) {
        throw new ConversationPersistenceError(
          'ConversationRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.messageRepo) {
        throw new ConversationPersistenceError(
          'MessageRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      this.conversationRepo = deps.conversationRepo
      this.messageRepo = deps.messageRepo
    }
  }

  /**
   * Persists the user's message before provider generation begins.
   *
   * @param preparedTurn The validated prepared turn from ConversationService.
   * @param request The validated send message request from the caller.
   * @returns The persisted MessageDto.
   */
  public persistUserMessage(
    preparedTurn: PreparedConversationTurn,
    request: SendMessageRequest
  ): MessageDto {
    if (!preparedTurn || typeof preparedTurn !== 'object') {
      throw new ConversationPersistenceError(
        'PreparedConversationTurn is required for persistUserMessage.',
        'INVALID_INPUT'
      )
    }
    if (!request || typeof request !== 'object') {
      throw new ConversationPersistenceError(
        'SendMessageRequest is required for persistUserMessage.',
        'INVALID_INPUT'
      )
    }

    // 1. Validate request with Zod schema (enforces non-blank, max length, strict keys)
    const parseResult = sendMessageRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const msg = parseResult.error.issues.map((i) => i.message).join('; ')
      throw new ConversationPersistenceError(
        `Invalid send message request: ${msg}`,
        'INVALID_INPUT'
      )
    }
    const validatedRequest = parseResult.data

    // 2. Validate conversation ID match
    if (validatedRequest.conversationId !== preparedTurn.conversationId) {
      throw new ConversationPersistenceError(
        `Request conversation ID '${validatedRequest.conversationId}' does not match prepared turn conversation ID '${preparedTurn.conversationId}'.`,
        'CONVERSATION_MISMATCH'
      )
    }

    // 3. Resolve authoritative conversation record
    const conversation = this.conversationRepo.getByIdOnly(preparedTurn.conversationId)
    if (!conversation) {
      throw new ConversationPersistenceError(
        `Conversation with ID '${preparedTurn.conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    // 4. Verify Bot ownership
    if (conversation.botId !== preparedTurn.botId) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' belongs to Bot '${conversation.botId}', not Bot '${preparedTurn.botId}'.`,
        'BOT_MISMATCH'
      )
    }

    // 5. Verify conversation is not archived
    if (conversation.archivedAt !== null) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    // 6. Persist user message via MessageRepository
    try {
      return this.messageRepo.create({
        conversationId: preparedTurn.conversationId,
        botId: preparedTurn.botId,
        knowledgeBaseId: conversation.knowledgeBaseId,
        role: 'user',
        content: validatedRequest.content,
        contentFormat: validatedRequest.contentFormat ?? 'markdown',
        metadata: {
          executionMode: 'chat'
        }
      })
    } catch (err) {
      if (err instanceof ConversationPersistenceError) {
        throw err
      }
      if (err instanceof ValidationError) {
        throw new ConversationPersistenceError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationPersistenceError(
        `Failed to persist user message: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Persists the completed assistant response after provider generation succeeds.
   * Links authentic citations from the prepared turn's citationMap and records authentic token usage.
   *
   * @param preparedTurn The validated prepared turn from ConversationService.
   * @param executionResult The completed execution result from ConversationExecutionService.
   * @returns The persisted MessageDto.
   */
  public persistAssistantMessage(
    preparedTurn: PreparedConversationTurn,
    executionResult: ConversationExecutionResult
  ): MessageDto {
    if (!preparedTurn || typeof preparedTurn !== 'object') {
      throw new ConversationPersistenceError(
        'PreparedConversationTurn is required for persistAssistantMessage.',
        'INVALID_INPUT'
      )
    }
    if (!executionResult || typeof executionResult !== 'object') {
      throw new ConversationPersistenceError(
        'ConversationExecutionResult is required for persistAssistantMessage.',
        'INVALID_INPUT'
      )
    }

    // 1. Verify identity matching
    if (executionResult.botId !== preparedTurn.botId) {
      throw new ConversationPersistenceError(
        `Execution result bot ID '${executionResult.botId}' does not match prepared turn bot ID '${preparedTurn.botId}'.`,
        'BOT_MISMATCH'
      )
    }
    if (executionResult.conversationId !== preparedTurn.conversationId) {
      throw new ConversationPersistenceError(
        `Execution result conversation ID '${executionResult.conversationId}' does not match prepared turn conversation ID '${preparedTurn.conversationId}'.`,
        'CONVERSATION_MISMATCH'
      )
    }
    if (executionResult.providerId !== preparedTurn.providerId) {
      throw new ConversationPersistenceError(
        `Execution result provider ID '${executionResult.providerId}' does not match prepared turn provider ID '${preparedTurn.providerId}'.`,
        'PROVIDER_MISMATCH'
      )
    }
    if (executionResult.modelId !== preparedTurn.modelId) {
      throw new ConversationPersistenceError(
        `Execution result model ID '${executionResult.modelId}' does not match prepared turn model ID '${preparedTurn.modelId}'.`,
        'MODEL_MISMATCH'
      )
    }

    // 2. Reject failed, aborted, or cancelled executions
    if (executionResult.finishReason === 'abort') {
      throw new ConversationPersistenceError(
        'Cannot persist assistant message for aborted or cancelled execution.',
        'EXECUTION_FAILED'
      )
    }

    if (typeof executionResult.assistantText !== 'string') {
      throw new ConversationPersistenceError('Assistant text must be a string.', 'INVALID_INPUT')
    }

    // 3. Resolve authoritative conversation record
    const conversation = this.conversationRepo.getByIdOnly(preparedTurn.conversationId)
    if (!conversation) {
      throw new ConversationPersistenceError(
        `Conversation with ID '${preparedTurn.conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    if (conversation.botId !== preparedTurn.botId) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' belongs to Bot '${conversation.botId}', not Bot '${preparedTurn.botId}'.`,
        'BOT_MISMATCH'
      )
    }

    if (conversation.archivedAt !== null) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    // 4. Parse and link authentic citations from citationMap
    const linkedCitations = parseAndLinkCitations(
      executionResult.assistantText,
      preparedTurn.citationMap
    )

    // 4.5. Harmonize message-level groundingMode with claim-level provenance without breaking mocks
    const validatedClaims = executionResult.validatedClaims
    let effectiveGroundingMode = preparedTurn.groundingMode
    if (
      preparedTurn.responsePolicy === 'balanced_kb_first' &&
      validatedClaims &&
      validatedClaims.length > 0
    ) {
      const hasKbClaim = validatedClaims.some(
        (c) => c.provenance === 'kb_supported' || c.provenance === 'kb_partially_supported'
      )
      const hasGeneralOrUnverified = validatedClaims.some(
        (c) => c.provenance === 'general_knowledge' || c.provenance === 'uncertain'
      )

      if (effectiveGroundingMode === 'kb_grounded' && linkedCitations.length === 0 && !hasKbClaim) {
        effectiveGroundingMode = 'general_fallback_no_kb_evidence'
      } else if (effectiveGroundingMode === 'kb_grounded' && hasKbClaim && hasGeneralOrUnverified) {
        effectiveGroundingMode = 'kb_partial_with_general_fallback'
      }
    }

    // 5. Construct generation and message metadata
    const generation: GenerationMetadataDto = {
      finishReason: executionResult.finishReason,
      durationMs: executionResult.durationMs >= 0 ? executionResult.durationMs : undefined
    }

    const metadata: MessageMetadataDto = {
      providerId: preparedTurn.providerId,
      modelId: preparedTurn.modelId,
      citations: linkedCitations,
      generation,
      executionMode: 'chat',
      ...(effectiveGroundingMode ? { groundingMode: effectiveGroundingMode } : {}),
      ...(validatedClaims && validatedClaims.length > 0 ? { claims: validatedClaims } : {})
    }

    // 6. Map authentic provider token usage (never substitute estimates)
    let tokenUsage: MessageTokenUsageDto | undefined = undefined
    if (executionResult.usage) {
      const parsedUsage = messageTokenUsageSchema.safeParse(executionResult.usage)
      if (parsedUsage.success) {
        tokenUsage = parsedUsage.data
      }
    }

    // 7. Persist assistant message via MessageRepository
    try {
      return this.messageRepo.create({
        conversationId: preparedTurn.conversationId,
        botId: preparedTurn.botId,
        knowledgeBaseId: conversation.knowledgeBaseId,
        role: 'assistant',
        content: executionResult.assistantText,
        contentFormat: 'markdown',
        metadata,
        tokenUsage
      })
    } catch (err) {
      if (err instanceof ConversationPersistenceError) {
        throw err
      }
      if (err instanceof ValidationError) {
        throw new ConversationPersistenceError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationPersistenceError(
        `Failed to persist assistant message: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }

  /**
   * Persists a partial assistant response when generation was cancelled, interrupted, or failed.
   * Stamped with isPartial: true, status, and no citations or ungrounded claims.
   *
   * @param preparedTurn The validated prepared turn from ConversationService.
   * @param partialText The non-empty text accumulated prior to interruption.
   * @param options Options detailing status, reason, duration, and token usage.
   * @returns The persisted MessageDto.
   */
  public persistPartialAssistantMessage(
    preparedTurn: PreparedConversationTurn,
    partialText: string,
    options: PersistPartialAssistantMessageOptions
  ): MessageDto {
    if (!preparedTurn || typeof preparedTurn !== 'object') {
      throw new ConversationPersistenceError(
        'PreparedConversationTurn is required for persistPartialAssistantMessage.',
        'INVALID_INPUT'
      )
    }
    if (typeof partialText !== 'string' || partialText.trim().length === 0) {
      throw new ConversationPersistenceError(
        'Partial assistant text must be a non-empty string.',
        'INVALID_INPUT'
      )
    }
    if (!options || typeof options !== 'object') {
      throw new ConversationPersistenceError(
        'PersistPartialAssistantMessageOptions are required.',
        'INVALID_INPUT'
      )
    }

    // 1. Resolve authoritative conversation record
    const conversation = this.conversationRepo.getByIdOnly(preparedTurn.conversationId)
    if (!conversation) {
      throw new ConversationPersistenceError(
        `Conversation with ID '${preparedTurn.conversationId}' was not found.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    if (conversation.botId !== preparedTurn.botId) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' belongs to Bot '${conversation.botId}', not Bot '${preparedTurn.botId}'.`,
        'BOT_MISMATCH'
      )
    }

    if (conversation.archivedAt !== null) {
      throw new ConversationPersistenceError(
        `Conversation '${preparedTurn.conversationId}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    // 2. Construct partial metadata
    const finishReason =
      options.finishReason ?? (options.status === 'cancelled' ? 'abort' : 'error')
    const generation: GenerationMetadataDto = {
      finishReason,
      durationMs:
        options.durationMs !== undefined && options.durationMs >= 0 ? options.durationMs : undefined
    }

    const metadata: MessageMetadataDto = {
      providerId: preparedTurn.providerId,
      modelId: preparedTurn.modelId,
      citations: [], // Partial answers carry no citations
      generation,
      executionMode: 'chat',
      isPartial: true,
      status: options.status,
      ...(options.interruptedReason ? { interruptedReason: options.interruptedReason } : {})
    }

    // 3. Map token usage if valid
    let tokenUsage: MessageTokenUsageDto | undefined = undefined
    if (options.tokenUsage) {
      const parsedUsage = messageTokenUsageSchema.safeParse(options.tokenUsage)
      if (parsedUsage.success) {
        tokenUsage = parsedUsage.data
      }
    }

    // 4. Persist assistant message
    try {
      return this.messageRepo.create({
        conversationId: preparedTurn.conversationId,
        botId: preparedTurn.botId,
        knowledgeBaseId: conversation.knowledgeBaseId,
        role: 'assistant',
        content: partialText,
        contentFormat: 'markdown',
        metadata,
        tokenUsage
      })
    } catch (err) {
      if (err instanceof ConversationPersistenceError) {
        throw err
      }
      if (err instanceof ValidationError) {
        throw new ConversationPersistenceError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationPersistenceError(
        `Failed to persist partial assistant message: ${err instanceof Error ? err.message : String(err)}`,
        'PERSISTENCE_ERROR'
      )
    }
  }
}
