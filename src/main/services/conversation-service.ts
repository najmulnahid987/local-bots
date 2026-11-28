import { z } from 'zod'
import type Database from 'better-sqlite3'
import { DEFAULT_BOT_RESPONSE_POLICY, type BotResponsePolicy } from '../../shared/bots'
import { idSchema, type ProviderConnection, type Bot } from '../database/repositories/types'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ProviderRegistry, providerRegistry } from '../providers/provider-registry'
import { validateBotModelCompatibility } from '../providers/capability-validator'
import type { ProviderId, ModelDescriptor } from '../providers/types'
import { ActiveWorkspaceContext, type SessionId } from './active-workspace-context'
import { NoActiveWorkspaceError, BotManagerError } from './bot-errors'
import {
  BotRagService,
  type BotRagEvidenceAssessment,
  type BotRagRetrievalResult,
  type BotRagRetrievalStatus,
  type RetrievedChunk,
  BotRagServiceError
} from './bot-rag-service'
import {
  ConversationContextManager,
  ConversationContextManagerError,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  type ConversationContextResult
} from './conversation-context-manager'
import {
  BotMemoryService,
  BotMemoryServiceError,
  type BotMemoryContextSelectionResult
} from './bot-memory-service'
import { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import type { PromptTokenEstimates } from './rag-prompt-builder'
import type {
  CitationDto,
  ConversationDto,
  MessageDto,
  MessageGroundingMode
} from '../../shared/conversations'
import type { ChatMessageDto } from '../../shared/providers'

// ============================================================================
// Error Contracts
// ============================================================================

export type ConversationServiceErrorCode =
  | 'NO_ACTIVE_WORKSPACE'
  | 'BOT_NOT_FOUND'
  | 'BOT_ARCHIVED'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ARCHIVED'
  | 'PROVIDER_CONNECTION_REQUIRED'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_UNAVAILABLE'
  | 'CROSS_PROVIDER_MODEL_MISMATCH'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_CONTEXT_METADATA_UNAVAILABLE'
  | 'RETRIEVAL_ERROR'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'INVALID_INPUT'
  | 'DATABASE_ERROR'

export class ConversationServiceError extends Error {
  public readonly code: ConversationServiceErrorCode

  constructor(message: string, code: ConversationServiceErrorCode) {
    super(message)
    this.name = 'ConversationServiceError'
    this.code = code
    Object.setPrototypeOf(this, ConversationServiceError.prototype)
  }
}

// ============================================================================
// Request and Result Contracts
// ============================================================================

export interface PrepareTurnRequest {
  readonly botId: string
  readonly conversationId: string
  readonly question: string
  readonly topK?: number
  readonly maxContextTokens?: number
  readonly reservedOutputTokens?: number
  readonly excludeTrailingMessageId?: string
}

export const prepareTurnRequestSchema = z.object({
  botId: idSchema,
  conversationId: idSchema,
  question: z.string().trim().min(1, 'Question must be a non-empty string.'),
  topK: z.number().int().min(1).max(50).optional(),
  maxContextTokens: z.number().int().min(1).optional(),
  reservedOutputTokens: z.number().int().min(1).max(128000).optional(),
  excludeTrailingMessageId: idSchema.optional()
})

export interface ContextWindowLimits {
  readonly inputTokens: number
  readonly outputTokens: number
}

export type BotRagStatus = BotRagRetrievalStatus

/**
 * Authoritative Main-process-only prepared conversation turn.
 * Ready for Step 7.6B execution via ProviderManagerService.
 *
 * Invariants:
 * 1. Contains zero credentials, credential references, or filesystem paths.
 * 2. Citation map and candidate citations are derived exclusively from authentic database records.
 * 3. Never exposed in this raw form directly to the Renderer.
 */
export interface PreparedConversationTurn {
  readonly botId: string
  readonly knowledgeBaseId?: string
  readonly conversationId: string
  readonly providerConnectionId: string
  readonly providerId: ProviderId
  readonly modelId: string
  readonly responsePolicy: BotResponsePolicy
  readonly systemInstruction: string
  readonly messages: readonly ChatMessageDto[]
  readonly conversationMessages: readonly ChatMessageDto[]
  readonly retrievalStatus: BotRagStatus
  readonly retrievalAssessment?: BotRagEvidenceAssessment
  readonly groundingMode?: MessageGroundingMode
  readonly citationCandidates: readonly CitationDto[]
  readonly citationMap: ReadonlyMap<number, CitationDto>
  readonly retrievedChunks?: readonly RetrievedChunk[]
  readonly contextWindowLimits: ContextWindowLimits
  readonly reservedOutputTokens: number
  readonly tokenEstimates: PromptTokenEstimates
  readonly includedMessageCount: number
  readonly excludedMessageCount: number
  readonly historyTrimmingOccurred: boolean
  readonly memoryContext?: BotMemoryContextSelectionResult
  readonly timings?: {
    readonly prepareMs: number
    readonly retrievalMs: number
    readonly contextSelectionMs: number
  }
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface ConversationServiceDependencies {
  readonly activeWorkspaceContext?: ActiveWorkspaceContext
  readonly botRepo?: BotRepository
  readonly conversationRepo?: ConversationRepository
  readonly messageRepo?: MessageRepository
  readonly providerConnectionRepo?: ProviderConnectionRepository
  readonly kbRepo?: KnowledgeBaseRepository
  readonly registry?: ProviderRegistry
  readonly botRagService?: BotRagService
  readonly botMemoryService?: BotMemoryService
  readonly botMemoryRepo?: BotMemoryRepository
  readonly db?: Database.Database
}

// ============================================================================
// ConversationService Implementation
// ============================================================================

/**
 * Main-process centralized service for conversation orchestration and request preparation.
 * Coordinates session validation, Bot & conversation ownership, provider/model resolution,
 * Bot-scoped RAG retrieval, prompt assembly, and context window token budgeting.
 */
export class ConversationService {
  private readonly activeWorkspaceContext: ActiveWorkspaceContext
  private readonly botRepo: BotRepository
  private readonly conversationRepo: ConversationRepository
  private readonly messageRepo: MessageRepository
  private readonly providerConnectionRepo: ProviderConnectionRepository
  private readonly registry: ProviderRegistry
  private readonly botRagService: BotRagService
  private readonly botMemoryService?: BotMemoryService

  constructor(deps: ConversationServiceDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new ConversationServiceError(
        'Dependencies object is required for ConversationService.',
        'INVALID_INPUT'
      )
    }

    if (deps.db) {
      const kbRepo = deps.kbRepo ?? new KnowledgeBaseRepository(deps.db)
      this.activeWorkspaceContext =
        deps.activeWorkspaceContext ?? new ActiveWorkspaceContext({ kbRepo })
      this.botRepo = deps.botRepo ?? new BotRepository(deps.db)
      this.conversationRepo = deps.conversationRepo ?? new ConversationRepository(deps.db)
      this.messageRepo = deps.messageRepo ?? new MessageRepository(deps.db)
      this.providerConnectionRepo =
        deps.providerConnectionRepo ?? new ProviderConnectionRepository(deps.db)
      this.registry = deps.registry ?? providerRegistry
      this.botRagService = deps.botRagService ?? new BotRagService({ db: deps.db })
      this.botMemoryService =
        deps.botMemoryService ??
        new BotMemoryService({
          db: deps.db,
          botRepo: this.botRepo,
          botMemoryRepo: deps.botMemoryRepo ?? new BotMemoryRepository(deps.db)
        })
    } else {
      if (!deps.activeWorkspaceContext) {
        throw new ConversationServiceError(
          'ActiveWorkspaceContext is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.botRepo) {
        throw new ConversationServiceError(
          'BotRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.conversationRepo) {
        throw new ConversationServiceError(
          'ConversationRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.messageRepo) {
        throw new ConversationServiceError(
          'MessageRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.providerConnectionRepo) {
        throw new ConversationServiceError(
          'ProviderConnectionRepository is required when db is not provided.',
          'INVALID_INPUT'
        )
      }
      if (!deps.botRagService) {
        throw new ConversationServiceError(
          'BotRagService is required when db is not provided.',
          'INVALID_INPUT'
        )
      }

      this.activeWorkspaceContext = deps.activeWorkspaceContext
      this.botRepo = deps.botRepo
      this.conversationRepo = deps.conversationRepo
      this.messageRepo = deps.messageRepo
      this.providerConnectionRepo = deps.providerConnectionRepo
      this.registry = deps.registry ?? providerRegistry
      this.botRagService = deps.botRagService
      this.botMemoryService =
        deps.botMemoryService ??
        (deps.botMemoryRepo && deps.botRepo
          ? new BotMemoryService({ botMemoryRepo: deps.botMemoryRepo, botRepo: deps.botRepo })
          : undefined)
    }
  }

  /**
   * Prepares a complete, validated conversation turn for model execution.
   *
   * Responsibilities:
   * 1. Validates session ID and derives the active Knowledge Base ID authoritatively.
   * 2. Verifies Bot existence, active KB ownership, and active (non-archived) status.
   * 3. Verifies conversation existence, Bot ownership, active KB ownership, and non-archived status.
   * 4. Resolves the Bot's assigned provider connection and model, verifying catalog compatibility.
   * 5. Validates model context-window metadata and output capacity reservation.
   * 6. Loads chronological conversation history from SQLite.
   * 7. Executes Bot-scoped RAG retrieval from the parent Knowledge Base (without caller KB input).
   * 8. Assembles the RAG prompt and applies ConversationContextManager turn-based token budgeting.
   * 9. Produces a typed PreparedConversationTurn without side effects (no DB writes, no provider calls).
   */
  public prepareTurn(sessionId: SessionId, request: PrepareTurnRequest): PreparedConversationTurn {
    const prepareStartMs = performance.now()
    // 1. Session and input validation
    if (
      sessionId === undefined ||
      sessionId === null ||
      (typeof sessionId === 'string' && sessionId.trim().length === 0)
    ) {
      throw new ConversationServiceError('Session ID is required.', 'INVALID_INPUT')
    }

    const parseResult = prepareTurnRequestSchema.safeParse(request)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ConversationServiceError(
        `Invalid prepare turn request: ${messages}`,
        'INVALID_INPUT'
      )
    }
    const validatedRequest = parseResult.data

    // 2. Resolve active Knowledge Base ID authoritatively
    const activeKbId = this.resolveActiveKnowledgeBaseId(sessionId)

    // 3. Resolve and validate Bot
    const bot = this.resolveActiveBot(validatedRequest.botId, activeKbId)

    // 4. Resolve and validate Conversation
    const conversation = this.resolveActiveConversation(
      validatedRequest.conversationId,
      bot.id,
      activeKbId
    )

    // 5. Resolve and validate Provider Connection and Model
    const { connection, model } = this.resolveProviderAndModel(bot)

    // 6. Validate context window metadata and output reservation
    const contextLimits = this.resolveContextWindowLimits(model)
    const reservedOutputTokens = this.resolveReservedOutputTokens(
      validatedRequest.reservedOutputTokens,
      contextLimits.outputTokens
    )

    // 7. Load conversation history in chronological order
    let history = this.messageRepo.listByConversation(conversation.id, bot.id, activeKbId)
    if (validatedRequest.excludeTrailingMessageId && history.length > 0) {
      const lastMsg = history[history.length - 1]
      if (lastMsg.id === validatedRequest.excludeTrailingMessageId) {
        history = history.slice(0, -1)
      }
    }

    // 8. Execute Bot-scoped RAG retrieval
    const responsePolicy = bot.responsePolicy ?? DEFAULT_BOT_RESPONSE_POLICY
    const retrievalStartMs = performance.now()
    const retrievalResult = this.executeBotRagRetrieval(bot.id, validatedRequest, responsePolicy)
    const retrievalMs = Math.max(0, Math.round(performance.now() - retrievalStartMs))
    const groundingMode = resolvePreparedGroundingMode(responsePolicy, retrievalResult)

    // 8.5. Retrieve Bot memory context
    let memoryContext: BotMemoryContextSelectionResult | undefined
    if (this.botMemoryService) {
      try {
        memoryContext = this.botMemoryService.getMemoryContext(bot.id)
      } catch (err) {
        if (err instanceof BotMemoryServiceError) {
          if (err.code === 'BOT_NOT_FOUND') {
            throw new ConversationServiceError(err.message, 'BOT_NOT_FOUND')
          }
          if (err.code === 'BOT_ARCHIVED') {
            throw new ConversationServiceError(err.message, 'BOT_ARCHIVED')
          }
          throw new ConversationServiceError(
            `Memory retrieval error: ${err.message}`,
            'RETRIEVAL_ERROR'
          )
        }
        throw new ConversationServiceError(
          `Unexpected memory retrieval error: ${err instanceof Error ? err.message : String(err)}`,
          'RETRIEVAL_ERROR'
        )
      }
    }

    // 9. Assemble prompt and budget context window
    const contextStartMs = performance.now()
    const contextResult = this.budgetConversationContext(
      bot,
      history,
      validatedRequest.question,
      retrievalResult,
      contextLimits.inputTokens,
      reservedOutputTokens,
      memoryContext
    )
    const contextSelectionMs = Math.max(0, Math.round(performance.now() - contextStartMs))
    const prepareMs = Math.max(0, Math.round(performance.now() - prepareStartMs))

    // 10. Construct immutable PreparedConversationTurn
    return Object.freeze({
      botId: bot.id,
      knowledgeBaseId: activeKbId,
      conversationId: conversation.id,
      providerConnectionId: connection.id,
      providerId: connection.providerId as ProviderId,
      modelId: model.id,
      responsePolicy,
      systemInstruction: contextResult.promptResult.systemInstruction,
      messages: contextResult.promptResult.messages,
      conversationMessages: contextResult.promptResult.conversationMessages,
      retrievalStatus: retrievalResult.status,
      ...(retrievalResult.assessment ? { retrievalAssessment: retrievalResult.assessment } : {}),
      ...(groundingMode ? { groundingMode } : {}),
      citationCandidates: contextResult.promptResult.citationCandidates,
      citationMap: contextResult.promptResult.citationMap,
      retrievedChunks: retrievalResult.chunks,
      contextWindowLimits: Object.freeze(contextLimits),
      reservedOutputTokens,
      tokenEstimates: contextResult.promptResult.tokenEstimates,
      includedMessageCount: contextResult.includedMessageCount,
      excludedMessageCount: contextResult.excludedMessageCount,
      historyTrimmingOccurred: contextResult.historyTrimmingOccurred,
      memoryContext,
      timings: Object.freeze({
        prepareMs,
        retrievalMs,
        contextSelectionMs
      })
    })
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private resolveActiveKnowledgeBaseId(sessionId: SessionId): string {
    try {
      return this.activeWorkspaceContext.getActiveWorkspaceId(sessionId)
    } catch (err) {
      if (err instanceof NoActiveWorkspaceError) {
        throw new ConversationServiceError(
          'No active Knowledge Base workspace found for this session.',
          'NO_ACTIVE_WORKSPACE'
        )
      }
      if (err instanceof BotManagerError) {
        if (err.code === 'ARCHIVED_WORKSPACE') {
          throw new ConversationServiceError(
            'Active Knowledge Base workspace is archived and cannot authorize operations.',
            'NO_ACTIVE_WORKSPACE'
          )
        }
        if (err.code === 'KB_NOT_FOUND') {
          throw new ConversationServiceError(
            'Active Knowledge Base workspace no longer exists.',
            'NO_ACTIVE_WORKSPACE'
          )
        }
      }
      throw new ConversationServiceError(
        `Failed to resolve active workspace: ${err instanceof Error ? err.message : String(err)}`,
        'NO_ACTIVE_WORKSPACE'
      )
    }
  }

  private resolveActiveBot(botId: string, activeKbId: string): Bot {
    const bot = this.botRepo.getById(botId, activeKbId)
    if (!bot) {
      throw new ConversationServiceError(
        `Bot with ID '${botId}' was not found in the active Knowledge Base.`,
        'BOT_NOT_FOUND'
      )
    }

    if (bot.status === 'archived') {
      throw new ConversationServiceError(
        `Bot '${bot.name}' is archived and cannot participate in conversations.`,
        'BOT_ARCHIVED'
      )
    }

    return bot
  }

  private resolveActiveConversation(
    conversationId: string,
    botId: string,
    activeKbId: string
  ): ConversationDto {
    const conversation = this.conversationRepo.getById(conversationId, botId, activeKbId)
    if (!conversation) {
      throw new ConversationServiceError(
        `Conversation with ID '${conversationId}' was not found for the specified Bot and Knowledge Base.`,
        'CONVERSATION_NOT_FOUND'
      )
    }

    if (conversation.archivedAt !== null) {
      throw new ConversationServiceError(
        `Conversation '${conversation.title}' is archived and cannot receive new messages.`,
        'CONVERSATION_ARCHIVED'
      )
    }

    return conversation
  }

  private resolveProviderAndModel(bot: Bot): {
    readonly connection: ProviderConnection
    readonly model: ModelDescriptor
  } {
    if (!bot.providerConnectionId) {
      throw new ConversationServiceError(
        `Bot '${bot.name}' does not have an assigned provider connection.`,
        'PROVIDER_CONNECTION_REQUIRED'
      )
    }

    const connection = this.providerConnectionRepo.getById(bot.providerConnectionId)
    if (!connection) {
      throw new ConversationServiceError(
        `Referenced provider connection with ID '${bot.providerConnectionId}' does not exist.`,
        'CONNECTION_NOT_FOUND'
      )
    }

    if (connection.status !== 'active') {
      throw new ConversationServiceError(
        `Provider connection '${connection.label}' is not active (status: ${connection.status}).`,
        'CONNECTION_UNAVAILABLE'
      )
    }

    const compatibility = validateBotModelCompatibility({
      providerConnectionId: bot.providerConnectionId,
      modelId: bot.modelId,
      connectionRepo: this.providerConnectionRepo,
      registry: this.registry
    })

    if (!compatibility.valid) {
      const code = compatibility.error?.code
      if (code === 'CROSS_PROVIDER_MODEL_MISMATCH') {
        throw new ConversationServiceError(
          compatibility.error!.message,
          'CROSS_PROVIDER_MODEL_MISMATCH'
        )
      }
      if (code === 'MODEL_NOT_FOUND') {
        throw new ConversationServiceError(compatibility.error!.message, 'MODEL_NOT_FOUND')
      }
      if (code === 'CONNECTION_NOT_FOUND') {
        throw new ConversationServiceError(compatibility.error!.message, 'CONNECTION_NOT_FOUND')
      }
      throw new ConversationServiceError(
        compatibility.error?.message ?? `Model '${bot.modelId}' is not compatible.`,
        'MODEL_NOT_FOUND'
      )
    }

    const model = compatibility.model ?? this.registry.getModel(connection.providerId, bot.modelId)
    if (!model) {
      throw new ConversationServiceError(
        `Model '${bot.modelId}' was not found in the catalog for provider '${connection.providerId}'.`,
        'MODEL_NOT_FOUND'
      )
    }

    return { connection, model }
  }

  private resolveContextWindowLimits(model: ModelDescriptor): ContextWindowLimits {
    if (
      !model.contextWindow ||
      typeof model.contextWindow.inputTokens !== 'number' ||
      !Number.isInteger(model.contextWindow.inputTokens) ||
      model.contextWindow.inputTokens <= 0 ||
      typeof model.contextWindow.outputTokens !== 'number' ||
      !Number.isInteger(model.contextWindow.outputTokens) ||
      model.contextWindow.outputTokens <= 0
    ) {
      throw new ConversationServiceError(
        `Model '${model.id}' does not have valid context-window metadata.`,
        'MODEL_CONTEXT_METADATA_UNAVAILABLE'
      )
    }

    return {
      inputTokens: model.contextWindow.inputTokens,
      outputTokens: model.contextWindow.outputTokens
    }
  }

  private resolveReservedOutputTokens(
    requested: number | undefined,
    modelOutputLimit: number
  ): number {
    if (requested !== undefined) {
      if (requested > modelOutputLimit) {
        throw new ConversationServiceError(
          `Requested reserved output tokens (${requested}) exceeds model maximum output capacity (${modelOutputLimit}).`,
          'INVALID_INPUT'
        )
      }
      return requested
    }

    return Math.min(DEFAULT_RESERVED_OUTPUT_TOKENS, modelOutputLimit)
  }

  private executeBotRagRetrieval(
    botId: string,
    request: z.infer<typeof prepareTurnRequestSchema>,
    responsePolicy: BotResponsePolicy
  ): BotRagRetrievalResult {
    try {
      const result = this.botRagService.retrieve({
        botId,
        query: request.question,
        topK: request.topK,
        maxContextTokens: request.maxContextTokens,
        enablePartialFallback: responsePolicy === 'balanced_kb_first'
      })
      if (
        !result ||
        typeof result !== 'object' ||
        !result.status ||
        !Array.isArray(result.chunks) ||
        !Array.isArray(result.citations)
      ) {
        throw new ConversationServiceError(
          'Knowledge base retrieval returned an invalid payload.',
          'RETRIEVAL_ERROR'
        )
      }
      return result
    } catch (err) {
      if (err instanceof ConversationServiceError) {
        throw err
      }
      if (err instanceof BotRagServiceError) {
        throw new ConversationServiceError(`RAG retrieval error: ${err.message}`, 'RETRIEVAL_ERROR')
      }
      throw new ConversationServiceError(
        `Unexpected retrieval error: ${err instanceof Error ? err.message : String(err)}`,
        'RETRIEVAL_ERROR'
      )
    }
  }

  private budgetConversationContext(
    bot: Bot,
    history: readonly MessageDto[],
    question: string,
    retrievalResult: BotRagRetrievalResult,
    modelInputTokens: number,
    reservedOutputTokens: number,
    memoryContext?: BotMemoryContextSelectionResult
  ): ConversationContextResult {
    try {
      return ConversationContextManager.selectContext({
        bot: {
          name: bot.name,
          systemPrompt: bot.systemPrompt,
          responsePolicy: bot.responsePolicy
        },
        history,
        question,
        retrievalResult,
        modelContextLimit: modelInputTokens,
        reservedOutputTokens,
        memoryContext
      })
    } catch (err) {
      if (err instanceof ConversationContextManagerError) {
        if (err.code === 'CONTEXT_LENGTH_EXCEEDED') {
          throw new ConversationServiceError(err.message, 'CONTEXT_LENGTH_EXCEEDED')
        }
        if (err.code === 'RETRIEVAL_ERROR') {
          throw new ConversationServiceError(err.message, 'RETRIEVAL_ERROR')
        }
        throw new ConversationServiceError(err.message, 'INVALID_INPUT')
      }
      throw new ConversationServiceError(
        `Failed to prepare conversation context: ${err instanceof Error ? err.message : String(err)}`,
        'INVALID_INPUT'
      )
    }
  }
}

function resolvePreparedGroundingMode(
  responsePolicy: BotResponsePolicy,
  retrievalResult: BotRagRetrievalResult
): MessageGroundingMode | undefined {
  const outcome = retrievalResult.assessment?.outcome

  if (responsePolicy === 'strict_kb_only') {
    return retrievalResult.status === 'SUCCESS' ? 'kb_grounded' : undefined
  }

  if (responsePolicy === 'general_ai_chat') {
    return retrievalResult.status === 'SUCCESS' && retrievalResult.chunks.length > 0
      ? 'kb_grounded'
      : 'general_chat'
  }

  if (outcome === 'partial_evidence') {
    return 'kb_partial_with_general_fallback'
  }
  if (outcome === 'relevant_evidence') {
    return 'kb_grounded'
  }
  if (outcome === 'no_usable_kb') {
    return 'general_fallback_no_usable_kb'
  }
  if (outcome === 'no_relevant_evidence') {
    return 'general_fallback_no_kb_evidence'
  }

  if (retrievalResult.status === 'SUCCESS' && retrievalResult.chunks.length > 0) {
    return 'kb_grounded'
  }
  return 'general_fallback_no_kb_evidence'
}
