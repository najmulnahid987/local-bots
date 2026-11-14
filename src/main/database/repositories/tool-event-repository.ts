import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type CanonicalBotTool,
  type ToolEventDto,
  type ToolEventStatus,
  type ToolApprovalStatus,
  normalizeToolName,
  toAppAgentRunStatus,
  MAX_ARGUMENTS_SUMMARY_LENGTH,
  MAX_RESULT_SUMMARY_LENGTH,
  MAX_ERROR_SUMMARY_LENGTH
} from '../../../shared/agents'
import {
  type CreateToolEventRepositoryInput,
  type UpdateToolEventSummariesInput,
  ValidationError,
  RepositoryError,
  idSchema
} from './types'

interface ToolEventRow {
  id: string
  agent_run_id: string
  sequence_number: number
  tool_name: string
  status: ToolEventStatus
  approval_status: ToolApprovalStatus
  arguments_summary: string
  result_summary: string
  error_message: string | null
  started_at: number
  completed_at: number | null
}

const TERMINAL_TOOL_STATUSES: readonly ToolEventStatus[] = ['completed', 'failed', 'cancelled']
const FINAL_APPROVAL_STATUSES: readonly ToolApprovalStatus[] = ['user_approved', 'user_rejected']

/**
 * Main-process repository managing persistence, sequential event allocation,
 * and lifecycle queries for Tool Events in SQLite.
 *
 * Security & Integrity Invariants:
 * 1. Every event must belong to an existing, non-terminal agent run.
 * 2. Sequence numbers are strictly increasing and uniquely allocated inside an atomic transaction.
 * 3. Events cannot be moved between agent runs (immutable agent_run_id).
 * 4. Tool names are validated and normalized to canonical Phase 8 identifiers.
 * 5. Length caps and JSON validation prevent leaking oversized files or credentials.
 * 6. Terminal tool events cannot transition back to active.
 * 7. Historical records are strictly retained for auditability; no deletion operations.
 */
export class ToolEventRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for ToolEventRepository.')
    }
    this.db = db
  }

  /**
   * Creates and persists a new tool execution event for an active agent run.
   * Atomically allocates the next sequential sequence_number within the run.
   */
  public create(input: CreateToolEventRepositoryInput): ToolEventDto {
    this.validateUuid(input.agentRunId, 'Agent run')

    // 1. Tool name validation & normalization
    const normalizedToolName = normalizeToolName(input.toolName)
    if (!normalizedToolName) {
      throw new ValidationError(
        `Invalid tool identifier: '${input.toolName}'. Must be a recognized canonical or legacy tool.`
      )
    }

    // 2. Validate summaries
    let argumentsSummary = '{}'
    if (input.argumentsSummary !== undefined) {
      if (typeof input.argumentsSummary !== 'string') {
        throw new ValidationError('argumentsSummary must be a string.')
      }
      if (input.argumentsSummary.length > MAX_ARGUMENTS_SUMMARY_LENGTH) {
        throw new ValidationError(
          `argumentsSummary cannot exceed ${MAX_ARGUMENTS_SUMMARY_LENGTH} characters.`
        )
      }
      try {
        JSON.parse(input.argumentsSummary)
      } catch {
        throw new ValidationError('argumentsSummary must be a valid JSON string.')
      }
      argumentsSummary = input.argumentsSummary
    }

    const initialStatus: ToolEventStatus = input.initialStatus ?? 'pending'
    if (initialStatus !== 'pending' && initialStatus !== 'running') {
      throw new ValidationError(
        `Initial tool event status must be 'pending' or 'running'. Received: '${initialStatus}'.`
      )
    }

    const initialApprovalStatus: ToolApprovalStatus = input.initialApprovalStatus ?? 'auto_approved'

    return this.db.transaction(() => {
      // 3. Verify parent agent run exists and is not in a terminal state
      const runRow = this.db
        .prepare('SELECT id, status FROM agent_runs WHERE id = ?')
        .get(input.agentRunId) as { id: string; status: string } | undefined

      if (!runRow) {
        throw new ValidationError(`Parent agent run with ID '${input.agentRunId}' does not exist.`)
      }

      const runStatus = toAppAgentRunStatus(runRow.status)
      if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
        throw new ValidationError(
          `Cannot create tool event for agent run '${input.agentRunId}' in terminal state '${runStatus}'.`
        )
      }

      // 4. Atomically allocate sequence number
      let sequenceNumber: number
      if (input.sequenceNumber !== undefined) {
        if (
          typeof input.sequenceNumber !== 'number' ||
          !Number.isInteger(input.sequenceNumber) ||
          input.sequenceNumber < 1
        ) {
          throw new ValidationError('sequenceNumber must be an integer >= 1.')
        }

        const existingSeq = this.db
          .prepare('SELECT 1 FROM tool_events WHERE agent_run_id = ? AND sequence_number = ?')
          .get(input.agentRunId, input.sequenceNumber)

        if (existingSeq) {
          throw new ValidationError(
            `Tool event with sequence number ${input.sequenceNumber} already exists in agent run '${input.agentRunId}'.`
          )
        }
        sequenceNumber = input.sequenceNumber
      } else {
        const seqRow = this.db
          .prepare(
            'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM tool_events WHERE agent_run_id = ?'
          )
          .get(input.agentRunId) as { next_seq: number }
        sequenceNumber = seqRow.next_seq
      }

      const id = randomUUID()
      const now = Date.now()

      const stmt = this.db.prepare(`
        INSERT INTO tool_events (
          id,
          agent_run_id,
          sequence_number,
          tool_name,
          status,
          approval_status,
          arguments_summary,
          result_summary,
          error_message,
          started_at,
          completed_at
        ) VALUES (
          @id,
          @agent_run_id,
          @sequence_number,
          @tool_name,
          @status,
          @approval_status,
          @arguments_summary,
          @result_summary,
          @error_message,
          @started_at,
          @completed_at
        )
      `)

      stmt.run({
        id,
        agent_run_id: input.agentRunId,
        sequence_number: sequenceNumber,
        tool_name: normalizedToolName,
        status: initialStatus,
        approval_status: initialApprovalStatus,
        arguments_summary: argumentsSummary,
        result_summary: '',
        error_message: null,
        started_at: now,
        completed_at: null
      })

      return {
        id,
        agentRunId: input.agentRunId,
        sequenceNumber,
        toolName: normalizedToolName,
        status: initialStatus,
        approvalStatus: initialApprovalStatus,
        argumentsSummary,
        resultSummary: '',
        errorMessage: null,
        startedAt: now,
        completedAt: null
      }
    })()
  }

  /**
   * Retrieves a tool event by ID.
   */
  public getById(id: string): ToolEventDto | null {
    this.validateUuid(id, 'Tool event')

    const row = this.db.prepare('SELECT * FROM tool_events WHERE id = ?').get(id) as
      ToolEventRow | undefined

    return row ? this.mapRowToToolEvent(row) : null
  }

  /**
   * Lists tool events for an agent run in deterministic sequence order (ascending).
   */
  public listByAgentRun(agentRunId: string): ToolEventDto[] {
    this.validateUuid(agentRunId, 'Agent run')

    const rows = this.db
      .prepare('SELECT * FROM tool_events WHERE agent_run_id = ? ORDER BY sequence_number ASC')
      .all(agentRunId) as ToolEventRow[]

    return rows.map((r) => this.mapRowToToolEvent(r))
  }

  /**
   * Updates the execution status of a tool event with state transition protection.
   */
  public updateStatus(
    id: string,
    newStatus: ToolEventStatus,
    errorMessage?: string | null
  ): ToolEventDto {
    this.validateUuid(id, 'Tool event')

    if (errorMessage !== undefined && errorMessage !== null) {
      if (typeof errorMessage !== 'string') {
        throw new ValidationError('errorMessage must be a string or null.')
      }
      if (errorMessage.length > MAX_ERROR_SUMMARY_LENGTH) {
        throw new ValidationError(
          `errorMessage cannot exceed ${MAX_ERROR_SUMMARY_LENGTH} characters.`
        )
      }
    }

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tool_events WHERE id = ?').get(id) as
        ToolEventRow | undefined

      if (!row) {
        throw new ValidationError(`Tool event with ID '${id}' does not exist.`)
      }

      // No-op if identical
      if (
        row.status === newStatus &&
        (errorMessage === undefined || row.error_message === errorMessage)
      ) {
        return this.mapRowToToolEvent(row)
      }

      // Terminal protection
      if (TERMINAL_TOOL_STATUSES.includes(row.status)) {
        throw new ValidationError(
          `Cannot transition tool event '${id}' from terminal state '${row.status}' to '${newStatus}'.`
        )
      }

      // State transition validation
      this.assertValidStatusTransition(row.status, newStatus)

      const isTerminal = TERMINAL_TOOL_STATUSES.includes(newStatus)
      const now = Date.now()
      const completedAt = isTerminal ? Math.max(now, row.started_at) : null
      const effectiveErrorMessage = errorMessage !== undefined ? errorMessage : row.error_message

      this.db
        .prepare(
          `
          UPDATE tool_events
          SET status = @newStatus,
              error_message = @errorMessage,
              completed_at = @completedAt
          WHERE id = @id
        `
        )
        .run({
          id,
          newStatus,
          errorMessage: effectiveErrorMessage,
          completedAt
        })

      return {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequenceNumber: row.sequence_number,
        toolName: this.resolveCanonicalToolName(row.tool_name),
        status: newStatus,
        approvalStatus: row.approval_status,
        argumentsSummary: row.arguments_summary,
        resultSummary: row.result_summary,
        errorMessage: effectiveErrorMessage,
        startedAt: row.started_at,
        completedAt
      }
    })()
  }

  /**
   * Updates approval status of a tool event.
   */
  public updateApprovalStatus(id: string, newApprovalStatus: ToolApprovalStatus): ToolEventDto {
    this.validateUuid(id, 'Tool event')

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tool_events WHERE id = ?').get(id) as
        ToolEventRow | undefined

      if (!row) {
        throw new ValidationError(`Tool event with ID '${id}' does not exist.`)
      }

      if (row.approval_status === newApprovalStatus) {
        return this.mapRowToToolEvent(row)
      }

      if (FINAL_APPROVAL_STATUSES.includes(row.approval_status)) {
        throw new ValidationError(
          `Cannot transition tool event approval status from final state '${row.approval_status}' to '${newApprovalStatus}'.`
        )
      }

      this.db
        .prepare('UPDATE tool_events SET approval_status = ? WHERE id = ?')
        .run(newApprovalStatus, id)

      return {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequenceNumber: row.sequence_number,
        toolName: this.resolveCanonicalToolName(row.tool_name),
        status: row.status,
        approvalStatus: newApprovalStatus,
        argumentsSummary: row.arguments_summary,
        resultSummary: row.result_summary,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at
      }
    })()
  }

  /**
   * Updates safe arguments and result summaries for a tool event.
   */
  public updateSafeSummaries(id: string, summaries: UpdateToolEventSummariesInput): ToolEventDto {
    this.validateUuid(id, 'Tool event')

    if (summaries.argumentsSummary !== undefined) {
      if (typeof summaries.argumentsSummary !== 'string') {
        throw new ValidationError('argumentsSummary must be a string.')
      }
      if (summaries.argumentsSummary.length > MAX_ARGUMENTS_SUMMARY_LENGTH) {
        throw new ValidationError(
          `argumentsSummary cannot exceed ${MAX_ARGUMENTS_SUMMARY_LENGTH} characters.`
        )
      }
      try {
        JSON.parse(summaries.argumentsSummary)
      } catch {
        throw new ValidationError('argumentsSummary must be a valid JSON string.')
      }
    }

    if (summaries.resultSummary !== undefined) {
      if (typeof summaries.resultSummary !== 'string') {
        throw new ValidationError('resultSummary must be a string.')
      }
      if (summaries.resultSummary.length > MAX_RESULT_SUMMARY_LENGTH) {
        throw new ValidationError(
          `resultSummary cannot exceed ${MAX_RESULT_SUMMARY_LENGTH} characters.`
        )
      }
    }

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tool_events WHERE id = ?').get(id) as
        ToolEventRow | undefined

      if (!row) {
        throw new ValidationError(`Tool event with ID '${id}' does not exist.`)
      }

      const effectiveArguments =
        summaries.argumentsSummary !== undefined
          ? summaries.argumentsSummary
          : row.arguments_summary
      const effectiveResult =
        summaries.resultSummary !== undefined ? summaries.resultSummary : row.result_summary

      this.db
        .prepare(
          `
          UPDATE tool_events
          SET arguments_summary = @argumentsSummary,
              result_summary = @resultSummary
          WHERE id = @id
        `
        )
        .run({
          id,
          argumentsSummary: effectiveArguments,
          resultSummary: effectiveResult
        })

      return {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequenceNumber: row.sequence_number,
        toolName: this.resolveCanonicalToolName(row.tool_name),
        status: row.status,
        approvalStatus: row.approval_status,
        argumentsSummary: effectiveArguments,
        resultSummary: effectiveResult,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at
      }
    })()
  }

  /**
   * Convenience method to mark a tool event completed with an optional result summary.
   */
  public markCompleted(id: string, resultSummary?: string): ToolEventDto {
    this.validateUuid(id, 'Tool event')

    if (resultSummary !== undefined) {
      if (typeof resultSummary !== 'string') {
        throw new ValidationError('resultSummary must be a string.')
      }
      if (resultSummary.length > MAX_RESULT_SUMMARY_LENGTH) {
        throw new ValidationError(
          `resultSummary cannot exceed ${MAX_RESULT_SUMMARY_LENGTH} characters.`
        )
      }
    }

    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tool_events WHERE id = ?').get(id) as
        ToolEventRow | undefined

      if (!row) {
        throw new ValidationError(`Tool event with ID '${id}' does not exist.`)
      }

      if (TERMINAL_TOOL_STATUSES.includes(row.status)) {
        throw new ValidationError(
          `Cannot transition tool event '${id}' from terminal state '${row.status}' to 'completed'.`
        )
      }

      const now = Date.now()
      const effectiveResult = resultSummary !== undefined ? resultSummary : row.result_summary

      this.db
        .prepare(
          `
          UPDATE tool_events
          SET status = 'completed',
              result_summary = @resultSummary,
              completed_at = @completedAt
          WHERE id = @id
        `
        )
        .run({
          id,
          resultSummary: effectiveResult,
          completedAt: Math.max(now, row.started_at)
        })

      return {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequenceNumber: row.sequence_number,
        toolName: this.resolveCanonicalToolName(row.tool_name),
        status: 'completed' as const,
        approvalStatus: row.approval_status,
        argumentsSummary: row.arguments_summary,
        resultSummary: effectiveResult,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: Math.max(now, row.started_at)
      }
    })()
  }

  /**
   * Convenience method to mark a tool event failed with an error message.
   */
  public markFailed(id: string, errorMessage: string): ToolEventDto {
    if (!errorMessage || typeof errorMessage !== 'string' || errorMessage.trim().length === 0) {
      throw new ValidationError('errorMessage is required when marking a tool event failed.')
    }
    return this.updateStatus(id, 'failed', errorMessage.trim())
  }

  /**
   * Convenience method to mark a tool event cancelled.
   */
  public markCancelled(id: string): ToolEventDto {
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

  private resolveCanonicalToolName(rawName: string): CanonicalBotTool {
    return normalizeToolName(rawName) ?? (rawName as CanonicalBotTool)
  }

  private mapRowToToolEvent(row: ToolEventRow): ToolEventDto {
    return {
      id: row.id,
      agentRunId: row.agent_run_id,
      sequenceNumber: row.sequence_number,
      toolName: this.resolveCanonicalToolName(row.tool_name),
      status: row.status,
      approvalStatus: row.approval_status,
      argumentsSummary: row.arguments_summary,
      resultSummary: row.result_summary,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at
    }
  }

  private assertValidStatusTransition(current: ToolEventStatus, next: ToolEventStatus): void {
    const allowedTransitions: Record<ToolEventStatus, readonly ToolEventStatus[]> = {
      pending: ['running', 'completed', 'failed', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: []
    }

    const permitted = allowedTransitions[current]
    if (!permitted.includes(next)) {
      throw new ValidationError(
        `Invalid tool event state transition from '${current}' to '${next}'.`
      )
    }
  }
}
