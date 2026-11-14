import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../testing/test-database'
import { AgentRunRepository } from './agent-run-repository'
import { ToolEventRepository } from './tool-event-repository'

interface RawEventRow {
  id: string
  agent_run_id: string
  sequence_number: number
  tool_name: string
  status: string
  approval_status: string
  arguments_summary: string
  result_summary: string
  error_message: string | null
  started_at: number
  completed_at: number | null
}

describe('ToolEventRepository (Phase 8 Step 8.1)', () => {
  let ctx: MigratedTestDatabaseContext
  let agentRunRepo: AgentRunRepository
  let toolEventRepo: ToolEventRepository

  let botId: string
  let runId: string

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    agentRunRepo = new AgentRunRepository(ctx.db)
    toolEventRepo = new ToolEventRepository(ctx.db)

    const kb = ctx.kbRepo.create({ name: 'Knowledge Base Main' })
    const bot = ctx.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Agent Analyst',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base', 'save_report', 'search_workspace_files']
    })
    botId = bot.id

    const run = agentRunRepo.create({
      botId,
      selectedModel: 'gpt-4o',
      initialStatus: 'running'
    })
    runId = run.id
  })

  afterEach(() => {
    ctx.cleanup()
  })

  // ==========================================================================
  // Event Creation & Sequential Numbering
  // ==========================================================================

  describe('Event Creation & Sequence Allocation', () => {
    it('1. successfully creates a tool event with auto-incremented sequence number 1', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base',
        argumentsSummary: '{"query":"invoice total"}'
      })

      expect(event.id).toBeDefined()
      expect(event.agentRunId).toBe(runId)
      expect(event.sequenceNumber).toBe(1)
      expect(event.toolName).toBe('search_knowledge_base')
      expect(event.status).toBe('pending')
      expect(event.approvalStatus).toBe('auto_approved')
      expect(event.argumentsSummary).toBe('{"query":"invoice total"}')
      expect(event.resultSummary).toBe('')
      expect(event.errorMessage).toBeNull()
      expect(event.startedAt).toBeGreaterThan(0)
      expect(event.completedAt).toBeNull()

      // Direct SQLite verification
      const raw = ctx.db
        .prepare('SELECT * FROM tool_events WHERE id = ?')
        .get(event.id) as RawEventRow
      expect(raw).toBeDefined()
      expect(raw.sequence_number).toBe(1)
      expect(raw.tool_name).toBe('search_knowledge_base')
    })

    it('2. automatically allocates strictly increasing sequence numbers (1, 2, 3)', () => {
      const event1 = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base'
      })
      const event2 = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'read_knowledge_source'
      })
      const event3 = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'save_report'
      })

      expect(event1.sequenceNumber).toBe(1)
      expect(event2.sequenceNumber).toBe(2)
      expect(event3.sequenceNumber).toBe(3)
    })

    it('3. normalizes legacy tool names into canonical Phase 8 tool names on creation', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'read_knowledge_base_document' // Legacy name!
      })

      expect(event.toolName).toBe('read_knowledge_source') // Canonical Phase 8 name!

      const raw = ctx.db
        .prepare('SELECT tool_name FROM tool_events WHERE id = ?')
        .get(event.id) as { tool_name: string }
      expect(raw.tool_name).toBe('read_knowledge_source')
    })

    it('4. rejects unknown or invalid tool names', () => {
      expect(() => {
        toolEventRepo.create({
          agentRunId: runId,
          toolName: 'unauthorized_shell_command'
        })
      }).toThrow(/Invalid tool identifier/)
    })

    it('5. rejects non-existent parent agentRunId', () => {
      expect(() => {
        toolEventRepo.create({
          agentRunId: '00000000-0000-4000-8000-000000000099',
          toolName: 'search_knowledge_base'
        })
      }).toThrow(/Parent agent run with ID '.*' does not exist/)
    })

    it('6. rejects creating tool events for an agent run in terminal state', () => {
      agentRunRepo.markCompleted(runId)

      expect(() => {
        toolEventRepo.create({
          agentRunId: runId,
          toolName: 'search_knowledge_base'
        })
      }).toThrow(/Cannot create tool event for agent run '.*' in terminal state 'completed'/)
    })

    it('7. validates argumentsSummary is valid JSON string and under length limit', () => {
      expect(() => {
        toolEventRepo.create({
          agentRunId: runId,
          toolName: 'search_knowledge_base',
          argumentsSummary: 'invalid-not-json'
        })
      }).toThrow(/argumentsSummary must be a valid JSON string/)

      expect(() => {
        toolEventRepo.create({
          agentRunId: runId,
          toolName: 'search_knowledge_base',
          argumentsSummary: JSON.stringify({ huge: 'a'.repeat(2100) })
        })
      }).toThrow(/argumentsSummary cannot exceed 2000 characters/)
    })

    it('8. rejects duplicate sequenceNumber when manually provided', () => {
      toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base',
        sequenceNumber: 1
      })

      expect(() => {
        toolEventRepo.create({
          agentRunId: runId,
          toolName: 'read_knowledge_source',
          sequenceNumber: 1
        })
      }).toThrow(/already exists in agent run/)
    })
  })

  // ==========================================================================
  // Deterministic Ordering & Listing
  // ==========================================================================

  describe('Retrieval & Deterministic Sequence Ordering', () => {
    it('9. listByAgentRun returns events in strictly ascending sequence number order', () => {
      toolEventRepo.create({ agentRunId: runId, toolName: 'search_knowledge_base' })
      toolEventRepo.create({ agentRunId: runId, toolName: 'read_knowledge_source' })
      toolEventRepo.create({ agentRunId: runId, toolName: 'save_report' })

      const events = toolEventRepo.listByAgentRun(runId)
      expect(events).toHaveLength(3)
      expect(events[0].sequenceNumber).toBe(1)
      expect(events[1].sequenceNumber).toBe(2)
      expect(events[2].sequenceNumber).toBe(3)
    })

    it('10. isolates tool events strictly to their parent agent run', () => {
      const run2 = agentRunRepo.create({ botId, selectedModel: 'gpt-4o', initialStatus: 'running' })

      toolEventRepo.create({ agentRunId: runId, toolName: 'search_knowledge_base' })
      toolEventRepo.create({ agentRunId: run2.id, toolName: 'save_report' })

      const run1Events = toolEventRepo.listByAgentRun(runId)
      const run2Events = toolEventRepo.listByAgentRun(run2.id)

      expect(run1Events).toHaveLength(1)
      expect(run1Events[0].agentRunId).toBe(runId)

      expect(run2Events).toHaveLength(1)
      expect(run2Events[0].agentRunId).toBe(run2.id)
    })
  })

  // ==========================================================================
  // Status Transitions & Lifecycle
  // ==========================================================================

  describe('Status Transitions & Terminal Protection', () => {
    it('11. transitions tool event pending -> running -> completed', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base'
      })
      expect(event.status).toBe('pending')

      const running = toolEventRepo.updateStatus(event.id, 'running')
      expect(running.status).toBe('running')
      expect(running.completedAt).toBeNull()

      const completed = toolEventRepo.markCompleted(event.id, 'Found 5 records.')
      expect(completed.status).toBe('completed')
      expect(completed.resultSummary).toBe('Found 5 records.')
      expect(completed.completedAt).toBeGreaterThanOrEqual(completed.startedAt)

      const raw = ctx.db
        .prepare('SELECT * FROM tool_events WHERE id = ?')
        .get(event.id) as RawEventRow
      expect(raw.status).toBe('completed')
      expect(raw.result_summary).toBe('Found 5 records.')
      expect(raw.completed_at).toBe(completed.completedAt)
    })

    it('12. transitions tool event running -> failed with error message', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'read_workspace_file',
        initialStatus: 'running'
      })

      const failed = toolEventRepo.markFailed(event.id, 'File not found.')
      expect(failed.status).toBe('failed')
      expect(failed.errorMessage).toBe('File not found.')
      expect(failed.completedAt).toBeGreaterThanOrEqual(failed.startedAt)

      const raw = ctx.db
        .prepare('SELECT * FROM tool_events WHERE id = ?')
        .get(event.id) as RawEventRow
      expect(raw.status).toBe('failed')
      expect(raw.error_message).toBe('File not found.')
    })

    it('13. transitions tool event pending -> cancelled', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'save_report'
      })

      const cancelled = toolEventRepo.markCancelled(event.id)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.completedAt).toBeGreaterThanOrEqual(cancelled.startedAt)
    })

    it('14. prevents terminal tool events from returning to active states', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base',
        initialStatus: 'running'
      })
      toolEventRepo.markCompleted(event.id)

      expect(() => {
        toolEventRepo.updateStatus(event.id, 'running')
      }).toThrow(/Cannot transition tool event '.*' from terminal state 'completed'/)
    })
  })

  // ==========================================================================
  // Approval Status Transitions
  // ==========================================================================

  describe('Approval Status Transitions', () => {
    it('15. transitions pending_approval -> user_approved', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'save_report',
        initialApprovalStatus: 'pending_approval'
      })
      expect(event.approvalStatus).toBe('pending_approval')

      const approved = toolEventRepo.updateApprovalStatus(event.id, 'user_approved')
      expect(approved.approvalStatus).toBe('user_approved')

      const raw = ctx.db
        .prepare('SELECT approval_status FROM tool_events WHERE id = ?')
        .get(event.id) as { approval_status: string }
      expect(raw.approval_status).toBe('user_approved')
    })

    it('16. transitions pending_approval -> user_rejected', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'save_report',
        initialApprovalStatus: 'pending_approval'
      })

      const rejected = toolEventRepo.updateApprovalStatus(event.id, 'user_rejected')
      expect(rejected.approvalStatus).toBe('user_rejected')
    })

    it('17. disallows changing approval status once final (user_approved or user_rejected)', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'save_report',
        initialApprovalStatus: 'pending_approval'
      })
      toolEventRepo.updateApprovalStatus(event.id, 'user_approved')

      expect(() => {
        toolEventRepo.updateApprovalStatus(event.id, 'pending_approval')
      }).toThrow(/Cannot transition tool event approval status from final state 'user_approved'/)
    })
  })

  // ==========================================================================
  // Safe Summaries Updates
  // ==========================================================================

  describe('Summary Updates & Sanitization', () => {
    it('18. updates safe arguments and result summaries', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_workspace_files'
      })

      const updated = toolEventRepo.updateSafeSummaries(event.id, {
        argumentsSummary: '{"extension":".ts"}',
        resultSummary: 'Found 12 TypeScript source files.'
      })

      expect(updated.argumentsSummary).toBe('{"extension":".ts"}')
      expect(updated.resultSummary).toBe('Found 12 TypeScript source files.')
    })

    it('19. rejects result summary exceeding 4000 characters', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_workspace_files'
      })

      expect(() => {
        toolEventRepo.updateSafeSummaries(event.id, {
          resultSummary: 'a'.repeat(4001)
        })
      }).toThrow(/resultSummary cannot exceed 4000 characters/)
    })
  })

  // ==========================================================================
  // Foreign Key Cascades & Immutability
  // ==========================================================================

  describe('Foreign Key Constraints and Immutability', () => {
    it('20. verifies deleting agent run cascades and deletes associated tool events in SQLite', () => {
      const event = toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base'
      })

      expect(toolEventRepo.getById(event.id)).not.toBeNull()

      // Delete parent agent run
      ctx.db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId)

      // Tool event must be gone due to ON DELETE CASCADE
      expect(toolEventRepo.getById(event.id)).toBeNull()
    })

    it('21. verifies SQLite UNIQUE constraint enforces (agent_run_id, sequence_number) in SQL', () => {
      toolEventRepo.create({
        agentRunId: runId,
        toolName: 'search_knowledge_base',
        sequenceNumber: 1
      })

      expect(() => {
        ctx.db
          .prepare(
            `
          INSERT INTO tool_events (
            id, agent_run_id, sequence_number, tool_name, status, approval_status,
            arguments_summary, result_summary, started_at
          ) VALUES (
            'f0000000-0000-4000-8000-000000000001', ?, 1, 'search_knowledge_base', 'pending', 'auto_approved',
            '{}', '', 1700000000000
          )
        `
          )
          .run(runId)
      }).toThrow(/UNIQUE constraint failed/)
    })
  })
})
