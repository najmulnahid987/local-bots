import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type AgentRunDto,
  type AgentRunStatus,
  type DbAgentRunStatus,
  toAppAgentRunStatus,
  toDbAgentRunStatus,
  MAX_AGENT_RUN_ITERATIONS,
  MAX_ERROR_SUMMARY_LENGTH
} from '../../../shared/agents'
import {
  type CreateAgentRunRepositoryInput,
  type ListAgentRunsRepositoryOptions,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'

interface AgentRunRow {
  id: string
  bot_id: string
  conversation_id: string | null
  knowledge_base_id: string
  status: DbAgentRunStatus
  selected_model: string
  iteration_count: number
  error_summary: string | null
  started_at: number
  completed_at: number | null
}

const TERMINAL_STATUSES: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled']

/**
 * Main-process repository managing persistence, state transitions,
 * and lifecycle queries for Agent Runs in SQLite.
 *
 * Security & Integrity Invariants:
 * 1. Derives authoritative parent Knowledge Base ID from the Bot database record.
 * 2. Never accepts or trusts a caller-supplied knowledgeBaseId.
 * 3. Validates that an optional conversationId belongs to the exact same Bot and KB.
 * 4. Strictly validates allowed lifecycle state transitions.
 * 5. Prevents terminal runs (completed, failed, cancelled) from transitioning back to active.
 * 6. Enforces maximum iteration count bounds (0 <= count <= 5).
 * 7. Executes multi-step operations inside atomic transactions.
 */
export class AgentRunRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for AgentRunRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new agent run scoped authoritatively to a Bot and its parent Knowledge Base.
   */
  public create(input: CreateAgentRunRepositoryInput): AgentRunDto {
    if (input.id !== undefined && input.id !== null) {
      this.validateUuid(input.id, 'AgentRun')
    }
    this.validateUuid(input.botId, 'Bot')

    if (input.conversationId !== undefined && input.conversationId !== null) {
      this.validateUuid(input.conversationId, 'Conversation')
    }

    const trimmedModel = typeof input.selectedModel === 'string' ? input.selectedModel.trim() : ''
    if (trimmedModel.length === 0) {
      throw new ValidationError('selectedModel cannot be blank.')
    }
    if (trimmedModel.length > 100) {
      throw new ValidationError('selectedModel cannot exceed 100 characters.')
    }

    const initialAppStatus: AgentRunStatus = input.initialStatus ?? 'queued'
    if (initialAppStatus !== 'queued' && initialAppStatus !== 'running') {
      throw new ValidationError(
        `Initial agent run status must be 'queued' or 'running'. Received: '${initialAppStatus}'.`
      )
    }

    return this.db.transaction(() => {
      // 1. Resolve Bot and authoritative parent Knowledge Base
      const botRow = this.db
        .prepare('SELECT id, knowledge_base_id FROM bots WHERE id = ?')
        .get(input.botId) as { id: string; knowledge_base_id: string } | undefined

      if (!botRow) {
        throw new ValidationError(`Parent Bot with ID '${input.botId}' does not exist.`)
      }

      const authoritativeKbId = botRow.knowledge_base_id

      // 2. If conversationId is provided, verify it belongs to the same Bot and Knowledge Base
      if (input.conversationId) {
        const convRow = this.db
          .prepare('SELECT id, bot_id, knowledge_base_id FROM conversations WHERE id = ?')
          .get(input.conversationId) as
          { id: string; bot_id: string; knowledge_base_id: string } | undefined

        if (!convRow) {
          throw new ValidationError(
            `Conversation with ID '${input.conversationId}' does not exist.`
          )
        }

        if (convRow.bot_id !== input.botId || convRow.knowledge_base_id !== authoritativeKbId) {
          throw new ValidationError(
            `Conversation '${input.conversationId}' does not belong to Bot '${input.botId}' and Knowledge Base '${authoritativeKbId}'.`
          )
        }
      }

      const id = input.id ?? randomUUID()
      const now = Date.now()
      const dbStatus = toDbAgentRunStatus(initialAppStatus)

      const stmt = this.db.prepare(`
        INSERT INTO agent_runs (
          id,
          bot_id,
          conversation_id,
          knowledge_base_id,
          status,
          selected_model,
          iteration_count,
          error_summary,
          started_at,
          completed_at
        ) VALUES (
          @id,
          @bot_id,
          @conversation_id,
          @knowledge_base_id,
          @status,
          @selected_model,
          @iteration_count,
          @error_summary,
          @started_at,
          @completed_at
        )
      `)

      stmt.run({
        id,
        bot_id: input.botId,
        conversation_id: input.conversationId ?? null,
        knowledge_base_id: authoritativeKbId,
        status: dbStatus,
        selected_model: trimmedModel,
        iteration_count: 0,
        error_summary: null,
        started_at: now,
        completed_at: null
      })

      return {
        id,
        botId: input.botId,
        conversationId: input.conversationId ?? null,
        status: initialAppStatus,
        selectedModel: trimmedModel,
        iterationCount: 0,
        errorSummary: null,
        startedAt: now,
        completedAt: null
      }
    })()
  }

  /**
   * Retrieves an agent run by ID.
   */
  public getById(id: string): AgentRunDto | null {
    this.validateUuid(id, 'Agent run')

    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
      AgentRunRow | undefined

    return row ? this.mapRowToAgentRun(row) : null
  }

  /**
   * Retrieves an agent run by ID scoped strictly to a specific Bot.
   */
  public getByIdScopedToBot(id: string, botId: string): AgentRunDto | null {
    this.validateUuid(id, 'Agent run')
    this.validateUuid(botId, 'Bot')

    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id = ? AND bot_id = ?')
      .get(id, botId) as AgentRunRow | undefined

    return row ? this.mapRowToAgentRun(row) : null
  }

  /**
   * Lists agent runs for a conversation ordered newest first.
   */
  public listByConversation(
    conversationId: string,
    options?: ListAgentRunsRepositoryOptions
  ): AgentRunDto[] {
    this.validateUuid(conversationId, 'Conversation')

    const limit = Math.max(1, Math.min(options?.limit ?? 50, 100))
    const offset = Math.max(0, options?.offset ?? 0)

    const rows = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
      )
      .all(conversationId, limit, offset) as AgentRunRow[]

    return rows.map((r) => this.mapRowToAgentRun(r))
  }

  /**
   * Lists agent runs for a Bot ordered newest first.
   */
  public listByBot(botId: string, options?: ListAgentRunsRepositoryOptions): AgentRunDto[] {
    this.validateUuid(botId, 'Bot')

    const limit = Math.max(1, Math.min(options?.limit ?? 50, 100))
    const offset = Math.max(0, options?.offset ?? 0)

    const rows = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
      )
      .all(botId, limit, offset) as AgentRunRow[]

    return rows.map((r) => this.mapRowToAgentRun(r))
  }

  /**
   * Updates status and optional error summary with strict state-transition enforcement.
   */
  public updateStatus(
    id: string,
    newStatus: AgentRunStatus,
    errorSummary?: string | null
  ): AgentRunDto {
    this.validateUuid(id, 'Agent run')

    if (errorSummary !== undefined && errorSummary !== null) {
      if (typeof errorSummary !== 'string') {
        throw new ValidationError('errorSummary must be a string or null.')
      }
      if (errorSummary.length > MAX_ERROR_SUMMARY_LENGTH) {
        throw new ValidationError(
          `errorSummary cannot exceed ${MAX_ERROR_SUMMARY_LENGTH} characters.`
        )
      }
    }

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
        AgentRunRow | undefined

      if (!row) {
        throw new ValidationError(`Agent run with ID '${id}' does not exist.`)
      }

      const currentAppStatus = toAppAgentRunStatus(row.status)

      // No-op if identical status and identical error summary
      if (
        currentAppStatus === newStatus &&
        (errorSummary === undefined || row.error_summary === errorSummary)
      ) {
        return this.mapRowToAgentRun(row)
      }

      // Disallow transitions out of terminal states
      if (TERMINAL_STATUSES.includes(currentAppStatus)) {
        throw new ValidationError(
          `Cannot transition agent run '${id}' from terminal state '${currentAppStatus}' to '${newStatus}'.`
        )
      }

      // Validate allowed transitions
      this.assertValidTransition(currentAppStatus, newStatus)

      const dbStatus = toDbAgentRunStatus(newStatus)
      const isTerminal = TERMINAL_STATUSES.includes(newStatus)
      const now = Date.now()
      const completedAt = isTerminal ? Math.max(now, row.started_at) : null
      const effectiveErrorSummary = errorSummary !== undefined ? errorSummary : row.error_summary

      this.db
        .prepare(
          `
          UPDATE agent_runs
          SET status = @dbStatus,
              error_summary = @errorSummary,
              completed_at = @completedAt
          WHERE id = @id
        `
        )
        .run({
          id,
          dbStatus,
          errorSummary: effectiveErrorSummary,
          completedAt
        })

      return {
        id: row.id,
        botId: row.bot_id,
        conversationId: row.conversation_id,
        status: newStatus,
        selectedModel: row.selected_model,
        iterationCount: row.iteration_count,
        errorSummary: effectiveErrorSummary,
        startedAt: row.started_at,
        completedAt
      }
    })()
  }

  /**
   * Updates iteration count, strictly enforcing the 0 <= count <= 5 bound and non-decreasing invariant.
   */
  public updateIterationCount(id: string, count: number): AgentRunDto {
    this.validateUuid(id, 'Agent run')

    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > MAX_AGENT_RUN_ITERATIONS
    ) {
      throw new ValidationError(
        `Iteration count must be an integer between 0 and ${MAX_AGENT_RUN_ITERATIONS}. Received: ${count}.`
      )
    }

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
        AgentRunRow | undefined

      if (!row) {
        throw new ValidationError(`Agent run with ID '${id}' does not exist.`)
      }

      const currentStatus = toAppAgentRunStatus(row.status)
      if (TERMINAL_STATUSES.includes(currentStatus)) {
        throw new ValidationError(
          `Cannot update iteration count for agent run '${id}' in terminal state '${currentStatus}'.`
        )
      }

      if (count < row.iteration_count) {
        throw new ValidationError(
          `Iteration count cannot decrease (current: ${row.iteration_count}, received: ${count}).`
        )
      }

      this.db.prepare('UPDATE agent_runs SET iteration_count = ? WHERE id = ?').run(count, id)

      return {
        id: row.id,
        botId: row.bot_id,
        conversationId: row.conversation_id,
        status: currentStatus,
        selectedModel: row.selected_model,
        iterationCount: count,
        errorSummary: row.error_summary,
        startedAt: row.started_at,
        completedAt: row.completed_at
      }
    })()
  }

  /**
   * Convenience method to mark an agent run as completed.
   */
  public markCompleted(id: string): AgentRunDto {
    return this.updateStatus(id, 'completed')
  }

  /**
   * Convenience method to mark an agent run as failed with an error summary.
   */
  public markFailed(id: string, errorSummary: string): AgentRunDto {
    if (!errorSummary || typeof errorSummary !== 'string' || errorSummary.trim().length === 0) {
      throw new ValidationError('errorSummary is required when marking an agent run failed.')
    }
    return this.updateStatus(id, 'failed', errorSummary.trim())
  }

  /**
   * Convenience method to mark an agent run as cancelled.
   */
  public markCancelled(id: string): AgentRunDto {
    return this.updateStatus(id, 'cancelled')
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private validateUuid(val: string, label: string): void {
    const parse = idSchema.safeParse(val)
    if (!parse.success) {
      throw new ValidationError(`Invalid ${label} ID '${val}': must be a valid RFC 4122 UUIDv4.`)
    }
  }

  private mapRowToAgentRun(row: AgentRunRow): AgentRunDto {
    return {
      id: row.id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      status: toAppAgentRunStatus(row.status),
      selectedModel: row.selected_model,
      iterationCount: row.iteration_count,
      errorSummary: row.error_summary,
      startedAt: row.started_at,
      completedAt: row.completed_at
    }
  }

  private assertValidTransition(current: AgentRunStatus, next: AgentRunStatus): void {
    const allowedTransitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
      queued: ['running', 'cancelled', 'failed'],
      running: ['waiting_approval', 'completed', 'failed', 'cancelled'],
      waiting_approval: ['running', 'completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: []
    }

    const permitted = allowedTransitions[current]
    if (!permitted.includes(next)) {
      throw new ValidationError(
        `Invalid agent run state transition from '${current}' to '${next}'.`
      )
    }
  }
}
