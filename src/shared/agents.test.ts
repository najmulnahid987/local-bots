import { describe, it, expect } from 'vitest'
import {
  CANONICAL_BOT_TOOLS,
  LEGACY_BOT_TOOLS,
  LEGACY_TO_CANONICAL_TOOL_MAP,
  CANONICAL_TO_LEGACY_TOOL_MAP,
  AGENT_RUN_STATUSES,
  DB_AGENT_RUN_STATUSES,
  TOOL_EVENT_STATUSES,
  TOOL_APPROVAL_STATUSES,
  normalizeToolName,
  isBotToolEnabled,
  toDbAgentRunStatus,
  toAppAgentRunStatus,
  agentRunStatusSchema,
  toolEventStatusSchema,
  toolApprovalStatusSchema,
  canonicalBotToolSchema,
  agentRunDtoSchema,
  toolEventDtoSchema,
  type AgentRunDto,
  type ToolEventDto
} from './agents'

describe('Shared Agent Contracts & Schemas (Phase 8 Step 8.1)', () => {
  // ==========================================================================
  // Canonical Tools & Legacy Compatibility
  // ==========================================================================

  describe('Tool Identifiers and Legacy Compatibility', () => {
    it('1. exposes all 6 canonical Phase 8 tools', () => {
      expect(CANONICAL_BOT_TOOLS).toEqual([
        'search_knowledge_base',
        'read_knowledge_source',
        'list_knowledge_sources',
        'search_workspace_files',
        'read_workspace_file',
        'save_report'
      ])
      expect(CANONICAL_BOT_TOOLS).toHaveLength(6)
    })

    it('2. maps each legacy tool alias to its exact canonical counterpart', () => {
      expect(LEGACY_TO_CANONICAL_TOOL_MAP['read_knowledge_base_document']).toBe(
        'read_knowledge_source'
      )
      expect(LEGACY_TO_CANONICAL_TOOL_MAP['list_knowledge_base_documents']).toBe(
        'list_knowledge_sources'
      )
      expect(LEGACY_TO_CANONICAL_TOOL_MAP['search_project_files']).toBe('search_workspace_files')
      expect(LEGACY_TO_CANONICAL_TOOL_MAP['read_project_file']).toBe('read_workspace_file')
      expect(LEGACY_TO_CANONICAL_TOOL_MAP['prepare_report']).toBe('save_report')
    })

    it('3. maps canonical tools to their legacy counterparts where applicable', () => {
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['read_knowledge_source']).toBe(
        'read_knowledge_base_document'
      )
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['list_knowledge_sources']).toBe(
        'list_knowledge_base_documents'
      )
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['search_workspace_files']).toBe('search_project_files')
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['read_workspace_file']).toBe('read_project_file')
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['save_report']).toBe('prepare_report')
      expect(CANONICAL_TO_LEGACY_TOOL_MAP['search_knowledge_base']).toBeUndefined()
    })

    it('4. normalizeToolName resolves canonical tools directly', () => {
      for (const tool of CANONICAL_BOT_TOOLS) {
        expect(normalizeToolName(tool)).toBe(tool)
      }
    })

    it('5. normalizeToolName converts legacy aliases to canonical names', () => {
      expect(normalizeToolName('read_knowledge_base_document')).toBe('read_knowledge_source')
      expect(normalizeToolName('list_knowledge_base_documents')).toBe('list_knowledge_sources')
      expect(normalizeToolName('search_project_files')).toBe('search_workspace_files')
      expect(normalizeToolName('read_project_file')).toBe('read_workspace_file')
      expect(normalizeToolName('prepare_report')).toBe('save_report')
    })

    it('6. normalizeToolName returns null for unknown, empty, or malicious tool names', () => {
      expect(normalizeToolName('unauthorized_shell')).toBeNull()
      expect(normalizeToolName('execute_terminal_command')).toBeNull()
      expect(normalizeToolName('')).toBeNull()
      expect(normalizeToolName('   ')).toBeNull()
      expect(normalizeToolName('../../../etc/passwd')).toBeNull()
    })

    it('7. isBotToolEnabled recognizes both canonical and legacy tool permissions', () => {
      // Direct canonical permission
      expect(isBotToolEnabled(['read_knowledge_source'], 'read_knowledge_source')).toBe(true)

      // Legacy stored permission
      expect(isBotToolEnabled(['read_knowledge_base_document'], 'read_knowledge_source')).toBe(true)
      expect(isBotToolEnabled(['list_knowledge_base_documents'], 'list_knowledge_sources')).toBe(
        true
      )
      expect(isBotToolEnabled(['search_project_files'], 'search_workspace_files')).toBe(true)
      expect(isBotToolEnabled(['read_project_file'], 'read_workspace_file')).toBe(true)
      expect(isBotToolEnabled(['prepare_report'], 'save_report')).toBe(true)

      // Common tool between both
      expect(isBotToolEnabled(['search_knowledge_base'], 'search_knowledge_base')).toBe(true)
    })

    it('8. isBotToolEnabled rejects disabled tools, empty arrays, null, and unknown names', () => {
      expect(isBotToolEnabled(['search_knowledge_base'], 'save_report')).toBe(false)
      expect(isBotToolEnabled([], 'read_knowledge_source')).toBe(false)
      expect(isBotToolEnabled(null, 'read_knowledge_source')).toBe(false)
      expect(isBotToolEnabled(undefined, 'read_knowledge_source')).toBe(false)
      expect(
        isBotToolEnabled(['unauthorized_tool' as unknown as string], 'read_knowledge_source')
      ).toBe(false)
    })

    it('9. canonicalBotToolSchema strictly validates canonical tools and rejects legacy/unknown names', () => {
      for (const tool of CANONICAL_BOT_TOOLS) {
        expect(canonicalBotToolSchema.safeParse(tool).success).toBe(true)
      }
      for (const legacy of LEGACY_BOT_TOOLS) {
        expect(canonicalBotToolSchema.safeParse(legacy).success).toBe(false)
      }
      expect(canonicalBotToolSchema.safeParse('unknown_tool').success).toBe(false)
    })
  })

  // ==========================================================================
  // Agent Run Status & Database Mappings
  // ==========================================================================

  describe('Agent Run Statuses and Database Mapping', () => {
    it('10. exposes all 6 application agent run statuses', () => {
      expect(AGENT_RUN_STATUSES).toEqual([
        'queued',
        'running',
        'waiting_approval',
        'completed',
        'failed',
        'cancelled'
      ])
    })

    it('11. exposes all 6 SQLite database agent run check constraint statuses', () => {
      expect(DB_AGENT_RUN_STATUSES).toEqual([
        'pending',
        'running',
        'awaiting_approval',
        'completed',
        'failed',
        'cancelled'
      ])
    })

    it('12. toDbAgentRunStatus correctly maps application statuses to database check values', () => {
      expect(toDbAgentRunStatus('queued')).toBe('pending')
      expect(toDbAgentRunStatus('waiting_approval')).toBe('awaiting_approval')
      expect(toDbAgentRunStatus('running')).toBe('running')
      expect(toDbAgentRunStatus('completed')).toBe('completed')
      expect(toDbAgentRunStatus('failed')).toBe('failed')
      expect(toDbAgentRunStatus('cancelled')).toBe('cancelled')
    })

    it('13. toAppAgentRunStatus correctly maps database check values to application statuses', () => {
      expect(toAppAgentRunStatus('pending')).toBe('queued')
      expect(toAppAgentRunStatus('awaiting_approval')).toBe('waiting_approval')
      expect(toAppAgentRunStatus('running')).toBe('running')
      expect(toAppAgentRunStatus('completed')).toBe('completed')
      expect(toAppAgentRunStatus('failed')).toBe('failed')
      expect(toAppAgentRunStatus('cancelled')).toBe('cancelled')
    })

    it('14. toAppAgentRunStatus throws descriptive error for unknown database status', () => {
      expect(() => toAppAgentRunStatus('unknown_status' as unknown as string)).toThrow(
        /Unknown DbAgentRunStatus: 'unknown_status'/
      )
    })

    it('15. agentRunStatusSchema strictly accepts valid statuses and rejects unknown', () => {
      for (const s of AGENT_RUN_STATUSES) {
        expect(agentRunStatusSchema.safeParse(s).success).toBe(true)
      }
      expect(agentRunStatusSchema.safeParse('pending').success).toBe(false)
      expect(agentRunStatusSchema.safeParse('awaiting_approval').success).toBe(false)
      expect(agentRunStatusSchema.safeParse('idle').success).toBe(false)
    })
  })

  // ==========================================================================
  // Tool Event Statuses & Approval Statuses
  // ==========================================================================

  describe('Tool Event Lifecycle & Approval Statuses', () => {
    it('16. exposes all 5 tool event statuses', () => {
      expect(TOOL_EVENT_STATUSES).toEqual([
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled'
      ])
      for (const s of TOOL_EVENT_STATUSES) {
        expect(toolEventStatusSchema.safeParse(s).success).toBe(true)
      }
      expect(toolEventStatusSchema.safeParse('unknown').success).toBe(false)
    })

    it('17. exposes all 5 tool approval statuses', () => {
      expect(TOOL_APPROVAL_STATUSES).toEqual([
        'not_required',
        'auto_approved',
        'pending_approval',
        'user_approved',
        'user_rejected'
      ])
      for (const s of TOOL_APPROVAL_STATUSES) {
        expect(toolApprovalStatusSchema.safeParse(s).success).toBe(true)
      }
      expect(toolApprovalStatusSchema.safeParse('denied').success).toBe(false)
    })
  })

  // ==========================================================================
  // AgentRunDto Zod Validation
  // ==========================================================================

  describe('AgentRunDto Schema Validation', () => {
    const validRun: AgentRunDto = {
      id: 'a0000000-0000-4000-8000-000000000001',
      botId: 'b0000000-0000-4000-8000-000000000001',
      conversationId: 'c0000000-0000-4000-8000-000000000001',
      status: 'running',
      selectedModel: 'gpt-4o',
      iterationCount: 2,
      errorSummary: null,
      startedAt: 1700000000000,
      completedAt: null
    }

    it('18. validates a valid AgentRunDto', () => {
      const res = agentRunDtoSchema.safeParse(validRun)
      expect(res.success).toBe(true)
    })

    it('19. validates an AgentRunDto with null conversationId and completed state', () => {
      const completedRun: AgentRunDto = {
        ...validRun,
        conversationId: null,
        status: 'completed',
        iterationCount: 5,
        completedAt: 1700000005000
      }
      expect(agentRunDtoSchema.safeParse(completedRun).success).toBe(true)
    })

    it('20. rejects iterationCount exceeding maximum 5', () => {
      const invalid = { ...validRun, iterationCount: 6 }
      const res = agentRunDtoSchema.safeParse(invalid)
      expect(res.success).toBe(false)
      expect(res.error?.issues[0].message).toMatch(/cannot exceed 5/)
    })

    it('21. rejects negative iterationCount', () => {
      const invalid = { ...validRun, iterationCount: -1 }
      expect(agentRunDtoSchema.safeParse(invalid).success).toBe(false)
    })

    it('22. rejects completedAt earlier than startedAt', () => {
      const invalid = {
        ...validRun,
        startedAt: 1700000005000,
        completedAt: 1700000001000
      }
      const res = agentRunDtoSchema.safeParse(invalid)
      expect(res.success).toBe(false)
      expect(res.error?.issues[0].message).toMatch(/cannot be earlier than startedAt/)
    })

    it('23. strictly rejects unexpected extra properties', () => {
      const invalid = { ...validRun, unexpectedField: 'malicious' }
      expect(agentRunDtoSchema.safeParse(invalid).success).toBe(false)
    })

    it('24. rejects errorSummary exceeding 2000 characters', () => {
      const invalid = { ...validRun, errorSummary: 'a'.repeat(2001) }
      expect(agentRunDtoSchema.safeParse(invalid).success).toBe(false)
    })
  })

  // ==========================================================================
  // ToolEventDto Zod Validation
  // ==========================================================================

  describe('ToolEventDto Schema Validation', () => {
    const validEvent: ToolEventDto = {
      id: 'e0000000-0000-4000-8000-000000000001',
      agentRunId: 'a0000000-0000-4000-8000-000000000001',
      sequenceNumber: 1,
      toolName: 'search_knowledge_base',
      status: 'completed',
      approvalStatus: 'auto_approved',
      argumentsSummary: '{"query":"local storage"}',
      resultSummary: 'Found 3 matching chunks.',
      errorMessage: null,
      startedAt: 1700000000000,
      completedAt: 1700000000250
    }

    it('25. validates a valid ToolEventDto', () => {
      const res = toolEventDtoSchema.safeParse(validEvent)
      expect(res.success).toBe(true)
    })

    it('26. rejects sequenceNumber < 1', () => {
      const invalid = { ...validEvent, sequenceNumber: 0 }
      const res = toolEventDtoSchema.safeParse(invalid)
      expect(res.success).toBe(false)
      expect(res.error?.issues[0].message).toMatch(/must be at least 1/)
    })

    it('27. rejects non-canonical toolName', () => {
      const invalid = { ...validEvent, toolName: 'read_knowledge_base_document' }
      expect(toolEventDtoSchema.safeParse(invalid).success).toBe(false)
    })

    it('28. rejects argumentsSummary exceeding 2000 characters', () => {
      const invalid = { ...validEvent, argumentsSummary: 'a'.repeat(2001) }
      expect(toolEventDtoSchema.safeParse(invalid).success).toBe(false)
    })

    it('29. rejects resultSummary exceeding 4000 characters', () => {
      const invalid = { ...validEvent, resultSummary: 'a'.repeat(4001) }
      expect(toolEventDtoSchema.safeParse(invalid).success).toBe(false)
    })

    it('30. strictly rejects unexpected extra properties on ToolEventDto', () => {
      const invalid = { ...validEvent, rawFileContents: 'secret password' }
      expect(toolEventDtoSchema.safeParse(invalid).success).toBe(false)
    })
  })
})
