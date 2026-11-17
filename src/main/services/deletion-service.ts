import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  type DeletableEntityType,
  type DeletionPreviewDto,
  type DeleteEntityRequest,
  type DeleteEntityResultDto
} from '../../shared/deletion'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import type { ConversationRepository } from '../database/repositories/conversation-repository'
import type { MessageRepository } from '../database/repositories/message-repository'
import type { BotMemoryRepository } from '../database/repositories/bot-memory-repository'
import type { KnowledgeBaseManager } from './knowledge-base-manager'
import type { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import type { ConversationManagerService } from './conversation-manager'
import type { SessionId } from './active-workspace-context'
import type { BotManagerService } from './bot-manager'
import type { ConversationTurnService } from './conversation-turn-service'
import type { DeletionRecoveryRepository } from '../database/repositories/deletion-recovery-repository'
import type { ImportRecoveryRepository } from '../database/repositories/import-recovery-repository'
import type { DocumentStorageManager } from '../documents/document-storage-manager'

export class DeletionServiceError extends Error {
  readonly code: string

  constructor(message: string, code = 'DELETION_ERROR') {
    super(message)
    this.name = 'DeletionServiceError'
    this.code = code
    Object.setPrototypeOf(this, DeletionServiceError.prototype)
  }
}

export interface DeletionServiceOptions {
  readonly db: Database.Database
  readonly kbRepo: KnowledgeBaseRepository
  readonly botRepo: BotRepository
  readonly sourceRepo: KnowledgeSourceRepository
  readonly conversationRepo: ConversationRepository
  readonly messageRepo: MessageRepository
  readonly botMemoryRepo: BotMemoryRepository
  readonly kbManager: KnowledgeBaseManager
  readonly docLifecycleService: DocumentLifecycleService
  readonly conversationManager: ConversationManagerService
  readonly botManager: BotManagerService
  readonly turnService: ConversationTurnService
  readonly deletionJournalRepo?: DeletionRecoveryRepository
  readonly importRecoveryRepo?: ImportRecoveryRepository
  readonly storageManager: DocumentStorageManager
}

/**
 * Authoritative Main-process service that provides safe, previewed, and cascade-hardened
 * deletion controls across the application hierarchy:
 * 1. Individual Conversations
 * 2. Individual Bots
 * 3. Individual Knowledge Sources
 * 4. Entire Knowledge Bases
 */
export class DeletionService {
  private readonly db: Database.Database
  private readonly kbManager: KnowledgeBaseManager
  private readonly docLifecycleService: DocumentLifecycleService
  private readonly conversationManager: ConversationManagerService
  private readonly botManager: BotManagerService
  private readonly turnService: ConversationTurnService
  private readonly deletionJournalRepo?: DeletionRecoveryRepository
  private readonly importRecoveryRepo?: ImportRecoveryRepository

  constructor(options: DeletionServiceOptions) {
    if (!options.db) {
      throw new DeletionServiceError('Database is required for DeletionService.', 'INTERNAL_ERROR')
    }
    this.db = options.db
    this.kbManager = options.kbManager
    this.docLifecycleService = options.docLifecycleService
    this.conversationManager = options.conversationManager
    this.botManager = options.botManager
    this.turnService = options.turnService
    this.deletionJournalRepo = options.deletionJournalRepo
    this.importRecoveryRepo = options.importRecoveryRepo
  }

  /**
   * Generates a safe, non-destructive deletion preview detailing dependent records,
   * affected categories, preserved assets, and active operation blocking status.
   */
  public async getPreview(
    entityType: DeletableEntityType,
    entityId: string
  ): Promise<DeletionPreviewDto> {
    switch (entityType) {
      case 'conversation':
        return this.getConversationPreview(entityId)
      case 'bot':
        return this.getBotPreview(entityId)
      case 'knowledge_source':
        return this.getSourcePreview(entityId)
      case 'knowledge_base':
        return this.getKnowledgeBasePreview(entityId)
      default:
        throw new DeletionServiceError(
          `Unsupported entity type: '${entityType}'.`,
          'VALIDATION_ERROR'
        )
    }
  }

  /**
   * Executes a safe, verified deletion for the specified entity with active operation protection
   * and exact-name verification.
   */
  public async deleteEntity(
    request: DeleteEntityRequest,
    sessionId?: SessionId
  ): Promise<DeleteEntityResultDto> {
    switch (request.entityType) {
      case 'conversation':
        return this.executeDeleteConversation(request.entityId, sessionId)
      case 'bot':
        return this.executeDeleteBot(request.entityId, request.confirmName, sessionId)
      case 'knowledge_source':
        return this.executeDeleteSource(request.entityId)
      case 'knowledge_base':
        return this.executeDeleteKnowledgeBase(request.entityId, request.confirmName)
      default:
        throw new DeletionServiceError(
          `Unsupported entity type: '${request.entityType}'.`,
          'VALIDATION_ERROR'
        )
    }
  }

  // ==========================================================================
  // 1. Conversation Deletion & Preview
  // ==========================================================================

  private getConversationPreview(conversationId: string): DeletionPreviewDto {
    const convRow = this.db
      .prepare('SELECT id, bot_id, knowledge_base_id, title FROM conversations WHERE id = ?')
      .get(conversationId) as
      { id: string; bot_id: string; knowledge_base_id: string; title: string } | undefined

    if (!convRow) {
      throw new DeletionServiceError(
        `Conversation '${conversationId}' does not exist.`,
        'ENTITY_NOT_FOUND'
      )
    }

    const botRow = this.db.prepare('SELECT name FROM bots WHERE id = ?').get(convRow.bot_id) as
      { name: string } | undefined

    const messageCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { c: number }
    ).c

    const runCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM agent_runs WHERE conversation_id = ?')
        .get(conversationId) as { c: number }
    ).c

    const toolEventCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM tool_events te
           JOIN agent_runs ar ON te.agent_run_id = ar.id
           WHERE ar.conversation_id = ?`
        )
        .get(conversationId) as { c: number }
    ).c

    const isGenerating = this.turnService.isGenerating(conversationId)
    const isDeleting = this.turnService.isDeleting(conversationId)
    const isBlocked = isGenerating || isDeleting
    const blockReason = isGenerating
      ? 'A generation is currently in progress for this conversation. Please stop generation before deleting.'
      : isDeleting
        ? 'Conversation deletion is already in progress.'
        : undefined

    return {
      entityType: 'conversation',
      entityId: convRow.id,
      displayName: convRow.title,
      parentName: botRow?.name ?? 'Unknown Bot',
      parentId: convRow.bot_id,
      dependentCounts: {
        messages: messageCount,
        agentRuns: runCount,
        toolEvents: toolEventCount
      },
      affectedCategories: [
        'Conversation thread',
        'Message history',
        'Autonomous Agent Task execution runs',
        'Recorded tool events'
      ],
      unaffectedCategories: [
        'Parent Bot profile and system instructions',
        'Saved Bot memories',
        'Other conversation threads',
        'Shared Knowledge Base documents and search indexes',
        'Shared AI provider credentials'
      ],
      backupReversible: true,
      isBlocked,
      blockReason,
      warnings: [
        'All messages and associated task history in this conversation will be permanently removed.'
      ]
    }
  }

  private async executeDeleteConversation(
    conversationId: string,
    sessionId?: SessionId
  ): Promise<DeleteEntityResultDto> {
    const preview = this.getConversationPreview(conversationId)
    if (preview.isBlocked) {
      throw new DeletionServiceError(
        preview.blockReason ?? 'Cannot delete conversation while active operations are running.',
        'OPERATION_BLOCKED'
      )
    }

    this.turnService.acquireDeletionLock(conversationId)
    try {
      if (sessionId) {
        this.conversationManager.deleteConversation(sessionId, conversationId)
      } else {
        // Direct transactional delete if no renderer session
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
        })()
      }

      return {
        success: true,
        entityType: 'conversation',
        entityId: conversationId
      }
    } finally {
      this.turnService.releaseDeletionLock(conversationId)
    }
  }

  // ==========================================================================
  // 2. Bot Deletion & Preview
  // ==========================================================================

  private getBotPreview(botId: string): DeletionPreviewDto {
    const botRow = this.db
      .prepare('SELECT id, knowledge_base_id, name FROM bots WHERE id = ?')
      .get(botId) as { id: string; knowledge_base_id: string; name: string } | undefined

    if (!botRow) {
      throw new DeletionServiceError(`Bot '${botId}' does not exist.`, 'ENTITY_NOT_FOUND')
    }

    const kbRow = this.db
      .prepare('SELECT name FROM knowledge_bases WHERE id = ?')
      .get(botRow.knowledge_base_id) as { name: string } | undefined

    const convCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM conversations WHERE bot_id = ?').get(botId) as {
        c: number
      }
    ).c

    const messageCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           WHERE c.bot_id = ?`
        )
        .get(botId) as { c: number }
    ).c

    const memoryCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM bot_memories WHERE bot_id = ?').get(botId) as {
        c: number
      }
    ).c

    const runCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM agent_runs WHERE bot_id = ?').get(botId) as {
        c: number
      }
    ).c

    const toolEventCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM tool_events te
           JOIN agent_runs ar ON te.agent_run_id = ar.id
           WHERE ar.bot_id = ?`
        )
        .get(botId) as { c: number }
    ).c

    // Active operation check
    const convRows = this.db
      .prepare('SELECT id FROM conversations WHERE bot_id = ?')
      .all(botId) as Array<{ id: string }>

    let isBlocked = false
    let blockReason: string | undefined

    for (const c of convRows) {
      if (this.turnService.isGenerating(c.id)) {
        isBlocked = true
        blockReason =
          'A conversation turn is currently active for this Bot. Please stop active generations before deleting.'
        break
      }
    }

    if (!isBlocked) {
      const activeRuns = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM agent_runs
             WHERE bot_id = ? AND status IN ('running', 'awaiting_approval', 'pending')`
          )
          .get(botId) as { c: number }
      ).c

      if (activeRuns > 0) {
        isBlocked = true
        blockReason =
          'An Agent Task or pending approval is currently active for this Bot. Please stop or cancel tasks before deleting.'
      }
    }

    return {
      entityType: 'bot',
      entityId: botRow.id,
      displayName: botRow.name,
      parentName: kbRow?.name ?? 'Unknown Knowledge Base',
      parentId: botRow.knowledge_base_id,
      dependentCounts: {
        conversations: convCount,
        messages: messageCount,
        memories: memoryCount,
        agentRuns: runCount,
        toolEvents: toolEventCount
      },
      affectedCategories: [
        'Bot profile, prompt instructions, and tool configurations',
        'All conversation threads belonging to this Bot',
        'Complete message histories',
        'All saved Bot memories',
        'All Agent Task execution runs and tool events'
      ],
      unaffectedCategories: [
        'Parent Knowledge Base',
        'All shared source documents and FTS5 search indexes',
        'Sibling Bots in this Knowledge Base',
        'Other Knowledge Bases and their Bots',
        'Shared AI provider connections'
      ],
      backupReversible: true,
      isBlocked,
      blockReason,
      warnings: [
        'Deleting this Bot will permanently remove all of its conversations, messages, and saved memories.',
        'Shared documents and sibling Bots remain completely intact.'
      ]
    }
  }

  private async executeDeleteBot(
    botId: string,
    confirmName?: string,
    sessionId?: SessionId
  ): Promise<DeleteEntityResultDto> {
    const preview = this.getBotPreview(botId)

    if (preview.isBlocked) {
      throw new DeletionServiceError(
        preview.blockReason ?? 'Cannot delete Bot while operations are active.',
        'OPERATION_BLOCKED'
      )
    }

    // Exact-name verification
    if (confirmName !== undefined) {
      if (confirmName.trim() !== preview.displayName.trim()) {
        throw new DeletionServiceError(
          `Confirmation name mismatch. Expected '${preview.displayName}', received '${confirmName}'.`,
          'VALIDATION_ERROR'
        )
      }
    }

    if (sessionId) {
      this.botManager.deleteBot(sessionId, botId)
    } else {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM bots WHERE id = ?').run(botId)
      })()
    }

    return {
      success: true,
      entityType: 'bot',
      entityId: botId
    }
  }

  // ==========================================================================
  // 3. Knowledge Source Deletion & Preview
  // ==========================================================================

  private getSourcePreview(sourceId: string): DeletionPreviewDto {
    const sourceRow = this.db
      .prepare(
        'SELECT id, knowledge_base_id, original_file_name, file_name, indexing_status FROM knowledge_sources WHERE id = ?'
      )
      .get(sourceId) as
      | {
          id: string
          knowledge_base_id: string
          original_file_name: string
          file_name: string
          indexing_status: string
        }
      | undefined

    if (!sourceRow) {
      throw new DeletionServiceError(
        `Knowledge Source '${sourceId}' does not exist.`,
        'ENTITY_NOT_FOUND'
      )
    }

    const kbRow = this.db
      .prepare('SELECT name FROM knowledge_bases WHERE id = ?')
      .get(sourceRow.knowledge_base_id) as { name: string } | undefined

    const chunkCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM knowledge_chunks WHERE source_id = ?')
        .get(sourceId) as { c: number }
    ).c

    const isIndexing =
      sourceRow.indexing_status === 'queued' || sourceRow.indexing_status === 'processing'
    const isBlocked = isIndexing
    const blockReason = isIndexing
      ? 'Document is currently being parsed or indexed. Please wait for indexing to finish.'
      : undefined

    return {
      entityType: 'knowledge_source',
      entityId: sourceRow.id,
      displayName: sourceRow.original_file_name || sourceRow.file_name,
      parentName: kbRow?.name ?? 'Unknown Knowledge Base',
      parentId: sourceRow.knowledge_base_id,
      dependentCounts: {
        chunks: chunkCount
      },
      affectedCategories: [
        'Original managed document file on disk',
        'Extracted document text chunks',
        'Full-text search (FTS5) index entries'
      ],
      unaffectedCategories: [
        'Parent Knowledge Base',
        'All AI Bots and their configurations',
        'All sibling document sources',
        'Historical conversation messages (citations will safely indicate source was removed)'
      ],
      backupReversible: true,
      isBlocked,
      blockReason,
      warnings: [
        'Historical conversation messages remain intact, but citations referencing this document will no longer be able to open the source preview.'
      ]
    }
  }

  private async executeDeleteSource(sourceId: string): Promise<DeleteEntityResultDto> {
    const preview = this.getSourcePreview(sourceId)

    if (preview.isBlocked) {
      throw new DeletionServiceError(
        preview.blockReason ?? 'Cannot delete source while indexing is in progress.',
        'OPERATION_BLOCKED'
      )
    }

    const opId = randomUUID()
    const quarantinePathName = `.quarantine_source_${sourceId}_${opId}`

    if (this.deletionJournalRepo) {
      this.deletionJournalRepo.create({
        id: opId,
        entityType: 'knowledge_source',
        entityId: sourceId,
        knowledgeBaseId: preview.parentId!,
        entityName: preview.displayName,
        quarantinePathName,
        originalRelPath: `originals/${sourceId}`,
        state: 'preparing'
      })
    }

    try {
      const deleteResult = await this.docLifecycleService.delete({
        knowledgeBaseId: preview.parentId!,
        sourceId
      })

      if (this.deletionJournalRepo) {
        this.deletionJournalRepo.updateState(opId, 'completed')
      }

      return {
        success: deleteResult.success,
        entityType: 'knowledge_source',
        entityId: sourceId,
        fileCleaned: deleteResult.fileCleaned,
        cleanupPending: deleteResult.cleanupPending
      }
    } catch (err: unknown) {
      if (this.deletionJournalRepo) {
        this.deletionJournalRepo.updateState(
          opId,
          'failed',
          err instanceof Error ? err.message : String(err)
        )
      }
      throw err
    }
  }

  // ==========================================================================
  // 4. Knowledge Base Deletion & Preview
  // ==========================================================================

  private getKnowledgeBasePreview(knowledgeBaseId: string): DeletionPreviewDto {
    const kbRow = this.db
      .prepare('SELECT id, name FROM knowledge_bases WHERE id = ?')
      .get(knowledgeBaseId) as { id: string; name: string } | undefined

    if (!kbRow) {
      throw new DeletionServiceError(
        `Knowledge Base '${knowledgeBaseId}' does not exist.`,
        'ENTITY_NOT_FOUND'
      )
    }

    const botCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM bots WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const sourceCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM knowledge_sources WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const chunkCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM knowledge_chunks WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const convCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM conversations WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const messageCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           WHERE c.knowledge_base_id = ?`
        )
        .get(knowledgeBaseId) as { c: number }
    ).c

    const memoryCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM bot_memories WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const runCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM agent_runs WHERE knowledge_base_id = ?')
        .get(knowledgeBaseId) as { c: number }
    ).c

    const toolEventCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c
           FROM tool_events te
           JOIN agent_runs ar ON te.agent_run_id = ar.id
           WHERE ar.knowledge_base_id = ?`
        )
        .get(knowledgeBaseId) as { c: number }
    ).c

    // Active operation check
    let isBlocked = false
    let blockReason: string | undefined

    // 1. Check active conversation turns in this KB
    const convRows = this.db
      .prepare('SELECT id FROM conversations WHERE knowledge_base_id = ?')
      .all(knowledgeBaseId) as Array<{ id: string }>

    for (const c of convRows) {
      if (this.turnService.isGenerating(c.id)) {
        isBlocked = true
        blockReason =
          'A chat generation is currently running for a Bot in this Knowledge Base. Please stop active operations before deleting.'
        break
      }
    }

    // 2. Check active agent runs in this KB
    if (!isBlocked) {
      const activeRuns = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM agent_runs
             WHERE knowledge_base_id = ? AND status IN ('running', 'awaiting_approval', 'pending')`
          )
          .get(knowledgeBaseId) as { c: number }
      ).c

      if (activeRuns > 0) {
        isBlocked = true
        blockReason =
          'An Agent Task or pending approval is currently active in this Knowledge Base. Please stop active tasks before deleting.'
      }
    }

    // 3. Check active source indexing in this KB
    if (!isBlocked) {
      const activeIndexing = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM knowledge_sources
             WHERE knowledge_base_id = ? AND indexing_status IN ('queued', 'processing')`
          )
          .get(knowledgeBaseId) as { c: number }
      ).c

      if (activeIndexing > 0) {
        isBlocked = true
        blockReason =
          'One or more documents in this Knowledge Base are currently being indexed. Please wait for indexing to finish.'
      }
    }

    // 4. Check import recovery journals targeting this KB
    if (!isBlocked && this.importRecoveryRepo) {
      const activeJournals = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM import_recovery_journal
             WHERE target_knowledge_base_id = ?
               AND state NOT IN ('completed', 'cancelled', 'failed')`
          )
          .get(knowledgeBaseId) as { c: number }
      ).c

      if (activeJournals > 0) {
        isBlocked = true
        blockReason =
          'An import or restore operation is actively in progress or requires recovery for this Knowledge Base. Please resolve recovery before deleting.'
      }

      const recoveryRequired = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c
             FROM import_recovery_journal
             WHERE target_knowledge_base_id = ?
               AND state = 'recovery_required'`
          )
          .get(knowledgeBaseId) as { c: number }
      ).c

      if (recoveryRequired > 0) {
        isBlocked = true
        blockReason =
          'This Knowledge Base has a pending recovery-required quarantine state. Please resolve or inspect quarantine files before deleting.'
      }
    }

    return {
      entityType: 'knowledge_base',
      entityId: kbRow.id,
      displayName: kbRow.name,
      parentName: null,
      parentId: null,
      dependentCounts: {
        bots: botCount,
        sources: sourceCount,
        chunks: chunkCount,
        conversations: convCount,
        messages: messageCount,
        memories: memoryCount,
        agentRuns: runCount,
        toolEvents: toolEventCount
      },
      affectedCategories: [
        'Knowledge Base configuration and storage root',
        'All child AI Bots and their instructions',
        'All saved Bot memories',
        'All original document files on disk',
        'All extracted chunks and FTS5 search indexes',
        'All conversation threads and complete message history',
        'All Agent Task execution runs and tool events'
      ],
      unaffectedCategories: [
        'All other Knowledge Bases and their independent data',
        'Global AI provider connections and encrypted API credentials',
        'Application configuration settings'
      ],
      backupReversible: true,
      isBlocked,
      blockReason,
      warnings: [
        'This action permanently deletes all Bots, documents, memories, and conversations in this Knowledge Base.',
        'Consider exporting this Knowledge Base (.voyaro-kb.zip) before deleting it.'
      ]
    }
  }

  private async executeDeleteKnowledgeBase(
    knowledgeBaseId: string,
    confirmName?: string
  ): Promise<DeleteEntityResultDto> {
    const preview = this.getKnowledgeBasePreview(knowledgeBaseId)

    if (preview.isBlocked) {
      throw new DeletionServiceError(
        preview.blockReason ?? 'Cannot delete Knowledge Base while active operations are running.',
        'OPERATION_BLOCKED'
      )
    }

    // Exact-name verification
    if (confirmName !== undefined) {
      if (confirmName.trim() !== preview.displayName.trim()) {
        throw new DeletionServiceError(
          `Confirmation name mismatch. Expected '${preview.displayName}', received '${confirmName}'.`,
          'VALIDATION_ERROR'
        )
      }
    }

    const opId = randomUUID()
    const quarantinePathName = `.quarantine_${knowledgeBaseId}_${opId}`

    if (this.deletionJournalRepo) {
      this.deletionJournalRepo.create({
        id: opId,
        entityType: 'knowledge_base',
        entityId: knowledgeBaseId,
        knowledgeBaseId,
        entityName: preview.displayName,
        quarantinePathName,
        originalRelPath: knowledgeBaseId,
        state: 'preparing'
      })
    }

    try {
      const deleteResult = await this.kbManager.delete(knowledgeBaseId)

      if (this.deletionJournalRepo) {
        this.deletionJournalRepo.updateState(opId, 'completed')
      }

      return {
        success: deleteResult.success,
        entityType: 'knowledge_base',
        entityId: knowledgeBaseId,
        directoryCleaned: deleteResult.directoryCleaned,
        cleanupPending: deleteResult.cleanupPending
      }
    } catch (err: unknown) {
      if (this.deletionJournalRepo) {
        this.deletionJournalRepo.updateState(
          opId,
          'failed',
          err instanceof Error ? err.message : String(err)
        )
      }
      throw err
    }
  }
}
