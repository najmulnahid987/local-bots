import {
  toBotDto,
  createBotRequestSchema,
  updateBotRequestSchema,
  botIdSchema,
  listBotsRequestSchema,
  type BotDto,
  type CreateBotRequest,
  type UpdateBotRequest,
  type ListBotsRequest,
  type DeleteBotResultDto
} from '../../shared/bots'
import {
  type CreateBotInput,
  type UpdateBotInput,
  type KnowledgeBase
} from '../database/repositories/types'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ProviderConnectionRepository } from '../database/repositories/provider-connection-repository'
import { ProviderRegistry, providerRegistry } from '../providers/provider-registry'
import { assertBotModelCompatibility } from '../providers/capability-validator'
import { ProviderManagerError } from '../providers/provider-manager/errors'
import { ActiveWorkspaceContext, type SessionId } from './active-workspace-context'
import {
  BotManagerError,
  BotNotFoundError,
  BotValidationError,
  type BotManagerErrorCode
} from './bot-errors'

export interface BotManagerServiceOptions {
  readonly botRepo: BotRepository
  readonly kbRepo: KnowledgeBaseRepository
  readonly connectionRepo: ProviderConnectionRepository
  readonly registry?: ProviderRegistry
  readonly activeContext?: ActiveWorkspaceContext
}

/**
 * Main-process service managing the lifecycle, configuration, and execution boundaries
 * of AI Bots inside their parent Knowledge Bases.
 *
 * Core Security Invariants:
 * 1. The Main process authoritatively determines the parent Knowledge Base using ActiveWorkspaceContext.
 * 2. The Renderer is NEVER trusted to choose or supply a Bot's parent Knowledge Base.
 * 3. Bot retrieval and mutations strictly enforce KB-scoped queries.
 * 4. Model and provider compatibility is strictly validated before any persistent modification.
 * 5. Calculating effective provider/model state on updates guarantees incompatible pairs cannot be saved.
 */
export class BotManagerService {
  private readonly botRepo: BotRepository
  private readonly kbRepo: KnowledgeBaseRepository
  private readonly connectionRepo: ProviderConnectionRepository
  private readonly registry: ProviderRegistry
  private readonly activeContext: ActiveWorkspaceContext

  constructor(options: BotManagerServiceOptions) {
    this.botRepo = options.botRepo
    this.kbRepo = options.kbRepo
    this.connectionRepo = options.connectionRepo
    this.registry = options.registry ?? providerRegistry
    this.activeContext =
      options.activeContext ?? new ActiveWorkspaceContext({ kbRepo: this.kbRepo })
  }

  // ==========================================================================
  // Active Workspace Context Management
  // ==========================================================================

  /**
   * Activates a Knowledge Base workspace for a renderer session.
   * Validates that the Knowledge Base exists in SQLite and is not archived.
   */
  public activateWorkspace(sessionId: SessionId, knowledgeBaseId: string): KnowledgeBase {
    return this.activeContext.activateWorkspace(sessionId, knowledgeBaseId)
  }

  /**
   * Clears the active workspace for a renderer session.
   */
  public clearWorkspace(sessionId: SessionId): boolean {
    return this.activeContext.clearActiveWorkspace(sessionId)
  }

  /**
   * Resolves the authoritative active Knowledge Base ID for a renderer session.
   */
  public getActiveKnowledgeBaseId(sessionId: SessionId): string {
    return this.activeContext.getActiveWorkspaceId(sessionId)
  }

  // ==========================================================================
  // Bot CRUD & Lifecycle Operations
  // ==========================================================================

  /**
   * Lists all Bots belonging to the session's active Knowledge Base.
   * Never exposes Bots belonging to other Knowledge Bases.
   */
  public listBots(sessionId: SessionId, options?: ListBotsRequest): BotDto[] {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const parseResult = listBotsRequestSchema.safeParse(options)
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues.map((i) => i.message).join('; ')
      throw new BotValidationError(`Invalid list filter options: ${errorDetails}`)
    }

    const bots = this.botRepo.listByKnowledgeBase(activeKbId, {
      status: parseResult.data?.status
    })

    return bots.map((b) => toBotDto(b))
  }

  /**
   * Retrieves a Bot strictly scoped by the session's active Knowledge Base.
   * Returns null if the Bot does not exist or belongs to another Knowledge Base.
   */
  public getBot(sessionId: SessionId, botId: string): BotDto | null {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const idResult = botIdSchema.safeParse(botId)
    if (!idResult.success) {
      throw new BotValidationError(`Invalid Bot ID: ${idResult.error.issues[0].message}`)
    }

    const bot = this.botRepo.getById(idResult.data, activeKbId)
    return bot ? toBotDto(bot) : null
  }

  /**
   * Retrieves a Bot strictly scoped by the active Knowledge Base, throwing BotNotFoundError if missing.
   */
  public getBotOrThrow(sessionId: SessionId, botId: string): BotDto {
    const bot = this.getBot(sessionId, botId)
    if (!bot) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }
    return bot
  }

  /**
   * Creates a new Bot inside the session's active Knowledge Base.
   * Invariant: knowledgeBaseId is resolved exclusively from the active context.
   */
  public createBot(sessionId: SessionId, input: CreateBotRequest): BotDto {
    // 1. Resolve authoritative parent Knowledge Base
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    // 2. Validate input with strict schema (rejects knowledgeBaseId or unexpected fields)
    const parseResult = createBotRequestSchema.safeParse(input)
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues.map((i) => i.message).join('; ')
      throw new BotValidationError(`Invalid Bot creation payload: ${errorDetails}`)
    }
    const data = parseResult.data

    // 3. Validate provider and model compatibility
    try {
      assertBotModelCompatibility({
        providerConnectionId: data.providerConnectionId,
        modelId: data.modelId,
        connectionRepo: this.connectionRepo,
        registry: this.registry
      })
    } catch (err) {
      if (err instanceof ProviderManagerError) {
        throw new BotManagerError(err.message, err.code as BotManagerErrorCode)
      }
      throw err
    }

    // 4. Construct internal repository input bound strictly to activeKbId
    const createInput: CreateBotInput = {
      knowledgeBaseId: activeKbId,
      name: data.name,
      modelId: data.modelId,
      description: data.description,
      systemPrompt: data.systemPrompt,
      providerConnectionId: data.providerConnectionId,
      toolPermissions: data.enabledTools,
      status: 'active'
    }

    const created = this.botRepo.create(createInput)
    return toBotDto(created)
  }

  /**
   * Updates mutable Bot configuration in the session's active Knowledge Base.
   * Enforces effective final provider/model configuration validation before persisting.
   */
  public updateBot(sessionId: SessionId, botId: string, input: UpdateBotRequest): BotDto {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const idResult = botIdSchema.safeParse(botId)
    if (!idResult.success) {
      throw new BotValidationError(`Invalid Bot ID: ${idResult.error.issues[0].message}`)
    }

    const parseResult = updateBotRequestSchema.safeParse(input)
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues.map((i) => i.message).join('; ')
      throw new BotValidationError(`Invalid Bot update payload: ${errorDetails}`)
    }
    const data = parseResult.data

    // Verify Bot ownership against active Knowledge Base
    const existing = this.botRepo.getById(idResult.data, activeKbId)
    if (!existing) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    // Calculate effective final provider connection and model ID
    const finalProviderConnectionId =
      data.providerConnectionId !== undefined
        ? data.providerConnectionId
        : existing.providerConnectionId

    const finalModelId = data.modelId !== undefined ? data.modelId : existing.modelId

    // Validate the effective final combination
    try {
      assertBotModelCompatibility({
        providerConnectionId: finalProviderConnectionId,
        modelId: finalModelId,
        connectionRepo: this.connectionRepo,
        registry: this.registry
      })
    } catch (err) {
      if (err instanceof ProviderManagerError) {
        throw new BotManagerError(err.message, err.code as BotManagerErrorCode)
      }
      throw err
    }

    // Construct update input containing only mutable fields
    const updateInput: UpdateBotInput = {}
    if (data.name !== undefined) updateInput.name = data.name
    if (data.description !== undefined) updateInput.description = data.description
    if (data.systemPrompt !== undefined) updateInput.systemPrompt = data.systemPrompt
    if (data.modelId !== undefined) updateInput.modelId = data.modelId
    if (data.providerConnectionId !== undefined) {
      updateInput.providerConnectionId = data.providerConnectionId
    }
    if (data.enabledTools !== undefined) {
      updateInput.toolPermissions = data.enabledTools
    }

    const updated = this.botRepo.update(idResult.data, activeKbId, updateInput)
    if (!updated) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    return toBotDto(updated)
  }

  /**
   * Soft-archives a Bot in the session's active Knowledge Base.
   * Preserves all conversations, messages, runs, and memories in the database.
   */
  public archiveBot(sessionId: SessionId, botId: string): BotDto {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const idResult = botIdSchema.safeParse(botId)
    if (!idResult.success) {
      throw new BotValidationError(`Invalid Bot ID: ${idResult.error.issues[0].message}`)
    }

    const existing = this.botRepo.getById(idResult.data, activeKbId)
    if (!existing) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    const updated = this.botRepo.update(idResult.data, activeKbId, { status: 'archived' })
    if (!updated) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    return toBotDto(updated)
  }

  /**
   * Restores an archived Bot back to active status in the session's active Knowledge Base.
   */
  public unarchiveBot(sessionId: SessionId, botId: string): BotDto {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const idResult = botIdSchema.safeParse(botId)
    if (!idResult.success) {
      throw new BotValidationError(`Invalid Bot ID: ${idResult.error.issues[0].message}`)
    }

    const existing = this.botRepo.getById(idResult.data, activeKbId)
    if (!existing) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    const updated = this.botRepo.update(idResult.data, activeKbId, { status: 'active' })
    if (!updated) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    return toBotDto(updated)
  }

  /**
   * Permanently deletes a Bot from the session's active Knowledge Base.
   * SQLite foreign key cascades delete dependent conversations, messages, runs, and memories.
   * Sibling Bots, documents, and the parent Knowledge Base remain completely untouched.
   */
  public deleteBot(sessionId: SessionId, botId: string): DeleteBotResultDto {
    const activeKbId = this.activeContext.getActiveWorkspaceId(sessionId)

    const idResult = botIdSchema.safeParse(botId)
    if (!idResult.success) {
      throw new BotValidationError(`Invalid Bot ID: ${idResult.error.issues[0].message}`)
    }

    const existing = this.botRepo.getById(idResult.data, activeKbId)
    if (!existing) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    const deleted = this.botRepo.delete(idResult.data, activeKbId)
    if (!deleted) {
      throw new BotNotFoundError(`Bot with ID '${botId}' not found in the active Knowledge Base.`)
    }

    return {
      success: true,
      botId: idResult.data
    }
  }
}
