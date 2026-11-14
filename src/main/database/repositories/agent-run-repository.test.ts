import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../testing/test-database'
import { AgentRunRepository } from './agent-run-repository'
import { ConversationRepository } from './conversation-repository'
import { ValidationError } from './types'

interface RawRunRow {
  id: string
  bot_id: string
  conversation_id: string | null
  knowledge_base_id: string
  status: string
  selected_model: string
  iteration_count: number
  error_summary: string | null
  started_at: number
  completed_at: number | null
}

describe('AgentRunRepository (Phase 8 Step 8.1)', () => {
  let ctx: MigratedTestDatabaseContext
  let agentRunRepo: AgentRunRepository
  let convRepo: ConversationRepository

  let kb1Id: string
  let kb2Id: string
  let bot1Id: string
  let bot2Id: string
  let conv1Id: string

  beforeEach(() => {
    ctx = createMigratedTestDatabase()
    agentRunRepo = new AgentRunRepository(ctx.db)
    convRepo = new ConversationRepository(ctx.db)

    // Setup KB 1 and Bot 1
    const kb1 = ctx.kbRepo.create({ name: 'Knowledge Base Alpha' })
    kb1Id = kb1.id

    const bot1 = ctx.botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Agent Alpha',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base', 'save_report']
    })
    bot1Id = bot1.id

    // Setup KB 2 and Bot 2
    const kb2 = ctx.kbRepo.create({ name: 'Knowledge Base Beta' })
    kb2Id = kb2.id

    const bot2 = ctx.botRepo.create({
      knowledgeBaseId: kb2Id,
      name: 'Agent Beta',
      modelId: 'claude-3-5-sonnet',
      toolPermissions: ['search_workspace_files']
    })
    bot2Id = bot2.id

    // Setup Conversation for Bot 1
    const conv1 = convRepo.create({
      botId: bot1Id,
      knowledgeBaseId: kb1Id,
      title: 'Conversation 1'
    })
    conv1Id = conv1.id
  })

  afterEach(() => {
    ctx.cleanup()
  })

  // ==========================================================================
  // Run Creation & Scoping
  // ==========================================================================

  describe('Run Creation & Knowledge Base Scoping', () => {
    it('1. successfully creates an agent run deriving parent Knowledge Base authoritatively', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o'
      })

      expect(run.id).toBeDefined()
      expect(run.botId).toBe(bot1Id)
      expect(run.conversationId).toBeNull()
      expect(run.status).toBe('queued')
      expect(run.selectedModel).toBe('gpt-4o')
      expect(run.iterationCount).toBe(0)
      expect(run.errorSummary).toBeNull()
      expect(run.startedAt).toBeGreaterThan(0)
      expect(run.completedAt).toBeNull()

      // Verify raw database row in agent_runs
      const raw = ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as RawRunRow
      expect(raw).toBeDefined()
      expect(raw.knowledge_base_id).toBe(kb1Id) // Authoritative KB derived from Bot 1!
      expect(raw.status).toBe('pending') // Database CHECK constraint mapping for 'queued'!
      expect(raw.iteration_count).toBe(0)
    })

    it('2. creates an agent run with a valid associated conversation', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        conversationId: conv1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      expect(run.conversationId).toBe(conv1Id)
      expect(run.status).toBe('running')

      const raw = ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as RawRunRow
      expect(raw.status).toBe('running')
      expect(raw.conversation_id).toBe(conv1Id)
    })

    it('3. rejects non-existent Bot ID with ValidationError', () => {
      expect(() => {
        agentRunRepo.create({
          botId: '00000000-0000-4000-8000-000000000099',
          selectedModel: 'gpt-4o'
        })
      }).toThrow(ValidationError)
    })

    it('4. rejects invalid UUID format for botId or conversationId', () => {
      expect(() => {
        agentRunRepo.create({
          botId: 'not-a-uuid',
          selectedModel: 'gpt-4o'
        })
      }).toThrow(/Invalid Bot ID/)

      expect(() => {
        agentRunRepo.create({
          botId: bot1Id,
          conversationId: 'not-a-uuid',
          selectedModel: 'gpt-4o'
        })
      }).toThrow(/Invalid Conversation ID/)
    })

    it('5. strictly rejects conversation belonging to a different Bot or Knowledge Base', () => {
      // Create conversation for Bot 2 in KB 2
      const conv2 = convRepo.create({
        botId: bot2Id,
        knowledgeBaseId: kb2Id,
        title: 'Conversation 2'
      })

      // Attempt to link Bot 1 with Bot 2's conversation
      expect(() => {
        agentRunRepo.create({
          botId: bot1Id,
          conversationId: conv2.id,
          selectedModel: 'gpt-4o'
        })
      }).toThrow(/does not belong to Bot/)
    })

    it('6. rejects blank or oversized selectedModel', () => {
      expect(() => {
        agentRunRepo.create({
          botId: bot1Id,
          selectedModel: '   '
        })
      }).toThrow(/selectedModel cannot be blank/)

      expect(() => {
        agentRunRepo.create({
          botId: bot1Id,
          selectedModel: 'a'.repeat(101)
        })
      }).toThrow(/selectedModel cannot exceed 100 characters/)
    })

    it('7. rejects invalid initial status (only queued or running permitted)', () => {
      expect(() => {
        agentRunRepo.create({
          botId: bot1Id,
          selectedModel: 'gpt-4o',
          initialStatus: 'completed' as unknown as 'queued' | 'running'
        })
      }).toThrow(/Initial agent run status must be 'queued' or 'running'/)
    })
  })

  // ==========================================================================
  // Retrieval & Listing Isolation
  // ==========================================================================

  describe('Retrieval & Cross-Bot Listing Isolation', () => {
    it('8. getById returns mapped DTO or null when not found', () => {
      const created = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })

      const fetched = agentRunRepo.getById(created.id)
      expect(fetched).toEqual(created)

      const missing = agentRunRepo.getById('00000000-0000-4000-8000-000000000099')
      expect(missing).toBeNull()
    })

    it('9. getByIdScopedToBot enforces bot boundary', () => {
      const run1 = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })

      // Resolves with correct bot
      expect(agentRunRepo.getByIdScopedToBot(run1.id, bot1Id)).not.toBeNull()

      // Returns null when queried with a different bot
      expect(agentRunRepo.getByIdScopedToBot(run1.id, bot2Id)).toBeNull()
    })

    it('10. listByBot isolates runs strictly to the specified Bot', () => {
      agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })
      agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })
      agentRunRepo.create({ botId: bot2Id, selectedModel: 'claude-3-5-sonnet' })

      const bot1Runs = agentRunRepo.listByBot(bot1Id)
      const bot2Runs = agentRunRepo.listByBot(bot2Id)

      expect(bot1Runs).toHaveLength(2)
      expect(bot1Runs.every((r) => r.botId === bot1Id)).toBe(true)

      expect(bot2Runs).toHaveLength(1)
      expect(bot2Runs[0].botId === bot2Id).toBe(true)
    })

    it('11. listByConversation isolates runs strictly to the conversation thread', () => {
      agentRunRepo.create({
        botId: bot1Id,
        conversationId: conv1Id,
        selectedModel: 'gpt-4o'
      })
      agentRunRepo.create({
        botId: bot1Id,
        conversationId: null, // No conversation
        selectedModel: 'gpt-4o'
      })

      const convRuns = agentRunRepo.listByConversation(conv1Id)
      expect(convRuns).toHaveLength(1)
      expect(convRuns[0].conversationId).toBe(conv1Id)
    })
  })

  // ==========================================================================
  // Status Transitions & Terminal State Protection
  // ==========================================================================

  describe('Status Transitions & Terminal State Protection', () => {
    it('12. transitions queued -> running -> waiting_approval -> running -> completed', () => {
      const run = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })
      expect(run.status).toBe('queued')

      const running = agentRunRepo.updateStatus(run.id, 'running')
      expect(running.status).toBe('running')
      expect(running.completedAt).toBeNull()

      const waiting = agentRunRepo.updateStatus(run.id, 'waiting_approval')
      expect(waiting.status).toBe('waiting_approval')

      const resumed = agentRunRepo.updateStatus(run.id, 'running')
      expect(resumed.status).toBe('running')

      const completed = agentRunRepo.markCompleted(run.id)
      expect(completed.status).toBe('completed')
      expect(completed.completedAt).toBeGreaterThanOrEqual(completed.startedAt)

      // Raw DB verification
      const raw = ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as RawRunRow
      expect(raw.status).toBe('completed')
      expect(raw.completed_at).toBe(completed.completedAt)
    })

    it('13. transitions running -> failed with error summary', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      const failed = agentRunRepo.markFailed(run.id, 'Rate limit exceeded by provider.')
      expect(failed.status).toBe('failed')
      expect(failed.errorSummary).toBe('Rate limit exceeded by provider.')
      expect(failed.completedAt).toBeGreaterThanOrEqual(failed.startedAt)

      const raw = ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as RawRunRow
      expect(raw.status).toBe('failed')
      expect(raw.error_summary).toBe('Rate limit exceeded by provider.')
    })

    it('14. transitions running -> cancelled', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      const cancelled = agentRunRepo.markCancelled(run.id)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.completedAt).toBeGreaterThanOrEqual(cancelled.startedAt)

      const raw = ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as RawRunRow
      expect(raw.status).toBe('cancelled')
    })

    it('15. rejects invalid direct transition from queued to completed', () => {
      const run = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })

      expect(() => {
        agentRunRepo.updateStatus(run.id, 'completed')
      }).toThrow(/Invalid agent run state transition from 'queued' to 'completed'/)
    })

    it('16. prevents terminal runs from returning to running or any other state', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })
      agentRunRepo.markCompleted(run.id)

      // Completed run cannot become running
      expect(() => {
        agentRunRepo.updateStatus(run.id, 'running')
      }).toThrow(/Cannot transition agent run '.*' from terminal state 'completed'/)

      // Completed run cannot become cancelled
      expect(() => {
        agentRunRepo.updateStatus(run.id, 'cancelled')
      }).toThrow(/Cannot transition agent run '.*' from terminal state 'completed'/)
    })

    it('17. allows idempotent updates with identical status', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      const same = agentRunRepo.updateStatus(run.id, 'running')
      expect(same.status).toBe('running')
    })
  })

  // ==========================================================================
  // Iteration Count Bounds & Terminal Protection
  // ==========================================================================

  describe('Iteration Count Enforcement', () => {
    it('18. updates iteration count sequentially up to maximum 5', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      for (let i = 1; i <= 5; i++) {
        const updated = agentRunRepo.updateIterationCount(run.id, i)
        expect(updated.iterationCount).toBe(i)
      }

      const raw = ctx.db
        .prepare('SELECT iteration_count FROM agent_runs WHERE id = ?')
        .get(run.id) as { iteration_count: number }
      expect(raw.iteration_count).toBe(5)
    })

    it('19. rejects iteration count exceeding 5', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })

      expect(() => {
        agentRunRepo.updateIterationCount(run.id, 6)
      }).toThrow(/Iteration count must be an integer between 0 and 5/)
    })

    it('20. rejects decreasing iteration count', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })
      agentRunRepo.updateIterationCount(run.id, 3)

      expect(() => {
        agentRunRepo.updateIterationCount(run.id, 2)
      }).toThrow(/Iteration count cannot decrease/)
    })

    it('21. rejects updating iteration count on a completed or failed agent run', () => {
      const run = agentRunRepo.create({
        botId: bot1Id,
        selectedModel: 'gpt-4o',
        initialStatus: 'running'
      })
      agentRunRepo.markCompleted(run.id)

      expect(() => {
        agentRunRepo.updateIterationCount(run.id, 1)
      }).toThrow(/Cannot update iteration count for agent run '.*' in terminal state 'completed'/)
    })
  })

  // ==========================================================================
  // Database CHECK Constraint Enforcement
  // ==========================================================================

  describe('Database CHECK Constraints', () => {
    it('22. verifies SQLite CHECK constraint enforces iteration_count <= 5 directly in SQL', () => {
      const run = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })

      expect(() => {
        ctx.db.prepare('UPDATE agent_runs SET iteration_count = 6 WHERE id = ?').run(run.id)
      }).toThrow(/CHECK constraint failed/)
    })

    it('23. verifies SQLite CHECK constraint rejects illegal raw status strings', () => {
      const run = agentRunRepo.create({ botId: bot1Id, selectedModel: 'gpt-4o' })

      expect(() => {
        ctx.db.prepare("UPDATE agent_runs SET status = 'illegal_status' WHERE id = ?").run(run.id)
      }).toThrow(/CHECK constraint failed/)
    })
  })
})
