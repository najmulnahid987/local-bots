import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  dispatchAgentTaskRequestSchema,
  cancelAgentTaskRequestSchema,
  getAgentRunRequestSchema,
  listAgentRunsRequestSchema,
  listToolEventsRequestSchema,
  getApprovalDetailsRequestSchema,
  respondToApprovalRequestSchema,
  agentStreamEventSchema,
  validateAgentIpcPayload,
  sanitizeAgentErrorMessage,
  formatAgentIpcError
} from './agent-validation'
import {
  MAX_AGENT_TASK_PROMPT_LENGTH,
  MAX_TOOL_EVENTS_PAGE_SIZE,
  DEFAULT_TOOL_EVENTS_PAGE_SIZE
} from '../../shared/agents'

describe('Agent IPC Validation & Sanitization (Phase 8 Step 8.9)', () => {
  // ==========================================================================
  // Dispatch Agent Task Schema
  // ==========================================================================

  describe('dispatchAgentTaskRequestSchema', () => {
    it('1. accepts a valid dispatch request with defaults', () => {
      const valid = {
        botId: randomUUID(),
        conversationId: randomUUID(),
        taskPrompt: 'Analyze the quarterly financial document and summarize.'
      }
      const parsed = dispatchAgentTaskRequestSchema.parse(valid)
      expect(parsed.botId).toBe(valid.botId)
      expect(parsed.conversationId).toBe(valid.conversationId)
      expect(parsed.taskPrompt).toBe(valid.taskPrompt)
      expect(parsed.workspaceAccessRequested).toBe(false)
    })

    it('2. accepts explicit workspaceAccessRequested flag', () => {
      const valid = {
        botId: randomUUID(),
        conversationId: randomUUID(),
        taskPrompt: 'Check workspace configuration files.',
        workspaceAccessRequested: true
      }
      const parsed = dispatchAgentTaskRequestSchema.parse(valid)
      expect(parsed.workspaceAccessRequested).toBe(true)
    })

    it('3. rejects non-UUID botId and conversationId', () => {
      expect(() =>
        dispatchAgentTaskRequestSchema.parse({
          botId: 'not-a-uuid',
          conversationId: randomUUID(),
          taskPrompt: 'Test'
        })
      ).toThrow(/RFC 4122 UUIDv4/)

      expect(() =>
        dispatchAgentTaskRequestSchema.parse({
          botId: randomUUID(),
          conversationId: 'not-a-uuid',
          taskPrompt: 'Test'
        })
      ).toThrow(/RFC 4122 UUIDv4/)
    })

    it('4. rejects empty or blank taskPrompt', () => {
      expect(() =>
        dispatchAgentTaskRequestSchema.parse({
          botId: randomUUID(),
          conversationId: randomUUID(),
          taskPrompt: '   '
        })
      ).toThrow(/cannot be blank/)
    })

    it('5. rejects taskPrompt exceeding maximum length', () => {
      const tooLong = 'a'.repeat(MAX_AGENT_TASK_PROMPT_LENGTH + 1)
      expect(() =>
        dispatchAgentTaskRequestSchema.parse({
          botId: randomUUID(),
          conversationId: randomUUID(),
          taskPrompt: tooLong
        })
      ).toThrow(/cannot exceed/)
    })

    it('6. strictly rejects untrusted client fields (sessionId, workspacePath, knowledgeBaseId, credentials)', () => {
      const untrustedPayload = {
        botId: randomUUID(),
        conversationId: randomUUID(),
        taskPrompt: 'Test',
        sessionId: 'user-supplied-session',
        knowledgeBaseId: randomUUID(),
        workspacePath: 'C:\\Users\\Attacker\\Secret',
        apiKey: 'secret-key-123',
        modelId: 'gpt-4o'
      }

      expect(() => dispatchAgentTaskRequestSchema.parse(untrustedPayload)).toThrow(
        /Unrecognized key/
      )
    })
  })

  // ==========================================================================
  // Cancel Agent Task Schema
  // ==========================================================================

  describe('cancelAgentTaskRequestSchema', () => {
    it('1. accepts valid agentRunId', () => {
      const id = randomUUID()
      const parsed = cancelAgentTaskRequestSchema.parse({ agentRunId: id })
      expect(parsed.agentRunId).toBe(id)
    })

    it('2. rejects invalid UUID', () => {
      expect(() => cancelAgentTaskRequestSchema.parse({ agentRunId: 'bad-id' })).toThrow(
        /RFC 4122 UUIDv4/
      )
    })

    it('3. rejects unexpected fields', () => {
      expect(() =>
        cancelAgentTaskRequestSchema.parse({
          agentRunId: randomUUID(),
          force: true
        })
      ).toThrow(/Unrecognized key/)
    })
  })

  // ==========================================================================
  // Get Agent Run Schema
  // ==========================================================================

  describe('getAgentRunRequestSchema', () => {
    it('1. accepts valid agentRunId', () => {
      const id = randomUUID()
      const parsed = getAgentRunRequestSchema.parse({ agentRunId: id })
      expect(parsed.agentRunId).toBe(id)
    })

    it('2. rejects non-UUID', () => {
      expect(() => getAgentRunRequestSchema.parse({ agentRunId: '123' })).toThrow(/RFC 4122 UUIDv4/)
    })
  })

  // ==========================================================================
  // List Agent Runs Schema
  // ==========================================================================

  describe('listAgentRunsRequestSchema', () => {
    it('1. accepts valid request with defaults', () => {
      const convId = randomUUID()
      const parsed = listAgentRunsRequestSchema.parse({ conversationId: convId })
      expect(parsed.conversationId).toBe(convId)
      expect(parsed.limit).toBe(50)
      expect(parsed.offset).toBe(0)
    })

    it('2. accepts optional botId and custom limit/offset', () => {
      const convId = randomUUID()
      const bId = randomUUID()
      const parsed = listAgentRunsRequestSchema.parse({
        conversationId: convId,
        botId: bId,
        limit: 10,
        offset: 5
      })
      expect(parsed.conversationId).toBe(convId)
      expect(parsed.botId).toBe(bId)
      expect(parsed.limit).toBe(10)
      expect(parsed.offset).toBe(5)
    })

    it('3. strictly rejects unexpected properties or invalid UUID', () => {
      expect(() =>
        listAgentRunsRequestSchema.parse({
          conversationId: 'not-a-uuid'
        })
      ).toThrow(/RFC 4122 UUIDv4/)

      expect(() =>
        listAgentRunsRequestSchema.parse({
          conversationId: randomUUID(),
          injected: true
        })
      ).toThrow(/unrecognized_keys/)
    })
  })

  // ==========================================================================
  // List Tool Events Schema
  // ==========================================================================

  describe('listToolEventsRequestSchema', () => {
    it('1. accepts valid request with defaults', () => {
      const id = randomUUID()
      const parsed = listToolEventsRequestSchema.parse({ agentRunId: id })
      expect(parsed.agentRunId).toBe(id)
      expect(parsed.limit).toBe(DEFAULT_TOOL_EVENTS_PAGE_SIZE)
      expect(parsed.offset).toBe(0)
    })

    it('2. accepts custom bounded limit and offset', () => {
      const id = randomUUID()
      const parsed = listToolEventsRequestSchema.parse({
        agentRunId: id,
        limit: 25,
        offset: 50
      })
      expect(parsed.limit).toBe(25)
      expect(parsed.offset).toBe(50)
    })

    it('3. rejects limit exceeding MAX_TOOL_EVENTS_PAGE_SIZE (100) or negative offset', () => {
      const id = randomUUID()
      expect(() =>
        listToolEventsRequestSchema.parse({
          agentRunId: id,
          limit: MAX_TOOL_EVENTS_PAGE_SIZE + 1
        })
      ).toThrow(/cannot exceed/)

      expect(() =>
        listToolEventsRequestSchema.parse({
          agentRunId: id,
          offset: -1
        })
      ).toThrow(/cannot be negative/)
    })
  })

  // ==========================================================================
  // Get Approval Details Schema
  // ==========================================================================

  describe('getApprovalDetailsRequestSchema', () => {
    it('1. accepts valid agentRunId and approvalRequestId', () => {
      const agentRunId = randomUUID()
      const approvalRequestId = randomUUID()
      const parsed = getApprovalDetailsRequestSchema.parse({
        agentRunId,
        approvalRequestId
      })
      expect(parsed.agentRunId).toBe(agentRunId)
      expect(parsed.approvalRequestId).toBe(approvalRequestId)
    })

    it('2. rejects invalid UUIDs', () => {
      expect(() =>
        getApprovalDetailsRequestSchema.parse({
          agentRunId: 'bad',
          approvalRequestId: randomUUID()
        })
      ).toThrow(/RFC 4122 UUIDv4/)
    })
  })

  // ==========================================================================
  // Respond To Approval Schema
  // ==========================================================================

  describe('respondToApprovalRequestSchema', () => {
    it('1. accepts approve decision without reason', () => {
      const agentRunId = randomUUID()
      const approvalRequestId = randomUUID()
      const parsed = respondToApprovalRequestSchema.parse({
        agentRunId,
        approvalRequestId,
        decision: 'approve'
      })
      expect(parsed.decision).toBe('approve')
      expect(parsed.reason).toBeUndefined()
    })

    it('2. accepts reject decision with reason', () => {
      const agentRunId = randomUUID()
      const approvalRequestId = randomUUID()
      const parsed = respondToApprovalRequestSchema.parse({
        agentRunId,
        approvalRequestId,
        decision: 'reject',
        reason: 'Report formatting is inaccurate.'
      })
      expect(parsed.decision).toBe('reject')
      expect(parsed.reason).toBe('Report formatting is inaccurate.')
    })

    it('3. rejects invalid decision value', () => {
      expect(() =>
        respondToApprovalRequestSchema.parse({
          agentRunId: randomUUID(),
          approvalRequestId: randomUUID(),
          decision: 'maybe'
        })
      ).toThrow(/must be either 'approve' or 'reject'/)
    })

    it('4. strictly rejects renderer-supplied destinationPath or markdownContent', () => {
      expect(() =>
        respondToApprovalRequestSchema.parse({
          agentRunId: randomUUID(),
          approvalRequestId: randomUUID(),
          decision: 'approve',
          destinationPath: 'C:\\arbitrary\\path\\report.md',
          markdownContent: '# Injected Content'
        })
      ).toThrow(/Unrecognized key/)
    })
  })

  // ==========================================================================
  // Agent Stream Event Schema
  // ==========================================================================

  describe('agentStreamEventSchema', () => {
    const baseAgentMeta = {
      agentRunId: randomUUID(),
      conversationId: randomUUID(),
      botId: randomUUID(),
      executionMode: 'agent' as const,
      timestamp: Date.now()
    }

    it('1. validates agent_run_started event', () => {
      const evt = {
        ...baseAgentMeta,
        type: 'agent_run_started',
        stage: 'preparing' as const,
        sequenceNumber: 1,
        selectedModel: 'gpt-4o'
      }
      expect(agentStreamEventSchema.parse(evt)).toEqual(evt)
    })

    it('2. validates agent_iteration_started, agent_stage_change, and agent_text_delta events', () => {
      const iterEvt = {
        ...baseAgentMeta,
        type: 'agent_iteration_started',
        stage: 'streaming' as const,
        sequenceNumber: 2,
        iteration: 1,
        maxIterations: 5
      }
      expect(agentStreamEventSchema.parse(iterEvt)).toEqual(iterEvt)

      const stageEvt = {
        ...baseAgentMeta,
        type: 'agent_stage_change',
        stage: 'streaming' as const,
        sequenceNumber: 2
      }
      expect(agentStreamEventSchema.parse(stageEvt)).toEqual(stageEvt)

      const deltaEvt = {
        ...baseAgentMeta,
        type: 'agent_text_delta',
        stage: 'streaming' as const,
        sequenceNumber: 3,
        textDelta: 'Drafting...'
      }
      expect(agentStreamEventSchema.parse(deltaEvt)).toEqual(deltaEvt)
    })

    it('3. validates tool_call_started, completed, and failed events', () => {
      const started = {
        ...baseAgentMeta,
        type: 'tool_call_started',
        stage: 'streaming' as const,
        sequenceNumber: 3,
        toolEventId: randomUUID(),
        toolName: 'search_knowledge_base',
        argumentsSummary: '{"query":"revenue"}'
      }
      expect(agentStreamEventSchema.parse(started)).toEqual(started)

      const completed = {
        ...baseAgentMeta,
        type: 'tool_call_completed',
        stage: 'streaming' as const,
        sequenceNumber: 4,
        toolEventId: randomUUID(),
        toolName: 'search_knowledge_base',
        resultSummary: 'Found 3 chunks'
      }
      expect(agentStreamEventSchema.parse(completed)).toEqual(completed)

      const failed = {
        ...baseAgentMeta,
        type: 'tool_call_failed',
        stage: 'streaming' as const,
        sequenceNumber: 5,
        toolEventId: randomUUID(),
        toolName: 'read_workspace_file',
        errorMessage: 'File not found'
      }
      expect(agentStreamEventSchema.parse(failed)).toEqual(failed)
    })

    it('4. validates approval_requested and approval_resolved events', () => {
      const requested = {
        ...baseAgentMeta,
        type: 'approval_requested',
        stage: 'streaming' as const,
        sequenceNumber: 6,
        approvalRequestId: randomUUID(),
        title: 'Quarterly Summary',
        contentPreview: '# Quarterly Summary\nRevenue grew by 15%...',
        contentSizeBytes: 1024,
        expiresAt: Date.now() + 300000
      }
      expect(agentStreamEventSchema.parse(requested)).toEqual(requested)

      const resolved = {
        ...baseAgentMeta,
        type: 'approval_resolved',
        stage: 'streaming' as const,
        sequenceNumber: 7,
        approvalRequestId: randomUUID(),
        status: 'approved'
      }
      expect(agentStreamEventSchema.parse(resolved)).toEqual(resolved)
    })

    it('5. validates agent_run_completed, failed, and cancelled events', () => {
      const completed = {
        ...baseAgentMeta,
        type: 'agent_run_completed',
        stage: 'completed' as const,
        sequenceNumber: 8,
        finalResponse: 'The analysis concluded with positive margins [1].',
        iterations: 2,
        toolEventsCount: 2,
        citationsCount: 1,
        workspaceFilesCount: 0
      }
      expect(agentStreamEventSchema.parse(completed)).toEqual(completed)

      const failed = {
        ...baseAgentMeta,
        type: 'agent_run_failed',
        stage: 'failed' as const,
        sequenceNumber: 9,
        error: {
          code: 'TOOL_TIMEOUT',
          message: 'Tool execution timed out',
          retryable: true
        }
      }
      expect(agentStreamEventSchema.parse(failed)).toEqual(failed)

      const cancelled = {
        ...baseAgentMeta,
        type: 'agent_run_cancelled',
        stage: 'cancelled' as const,
        sequenceNumber: 10,
        reason: 'Cancelled by user.'
      }
      expect(agentStreamEventSchema.parse(cancelled)).toEqual(cancelled)
    })

    it('6. rejects unknown event type and missing authoritative botId', () => {
      expect(() =>
        agentStreamEventSchema.parse({
          type: 'unknown_event_type',
          agentRunId: randomUUID(),
          sequenceNumber: 1,
          timestamp: Date.now()
        })
      ).toThrow()

      expect(() =>
        agentStreamEventSchema.parse({
          type: 'agent_run_cancelled',
          agentRunId: randomUUID(),
          conversationId: randomUUID(),
          executionMode: 'agent',
          stage: 'cancelled',
          sequenceNumber: 1,
          timestamp: Date.now(),
          reason: 'Missing botId'
        })
      ).toThrow()
    })
  })

  // ==========================================================================
  // Error Sanitization & Formatting
  // ==========================================================================

  describe('sanitizeAgentErrorMessage', () => {
    it('1. redacts Windows and POSIX absolute filesystem paths', () => {
      const msg =
        'Failed to read file at C:\\Users\\Administrator\\Documents\\Secret.txt and /var/log/private/app.log'
      const sanitized = sanitizeAgentErrorMessage(msg)
      expect(sanitized).not.toContain('C:\\Users')
      expect(sanitized).not.toContain('/var/log')
      expect(sanitized).toContain('[REDACTED_PATH]')
    })

    it('2. redacts OpenAI, Anthropic, and Google API keys and bearer tokens', () => {
      const msg =
        'Error connecting with sk-proj-1234567890abcdef and sk-ant-api03-abcdef123456789 and AIzaSyD1234567890Bearer xyz.abc.def'
      const sanitized = sanitizeAgentErrorMessage(msg)
      expect(sanitized).not.toContain('sk-proj-')
      expect(sanitized).not.toContain('sk-ant-')
      expect(sanitized).not.toContain('AIzaSy')
      expect(sanitized).toContain('[REDACTED_KEY]')
    })

    it('3. redacts credential references', () => {
      const msg = 'Missing vault key for cred_a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      const sanitized = sanitizeAgentErrorMessage(msg)
      expect(sanitized).not.toContain('cred_a1b2c3d4')
      expect(sanitized).toContain('[REDACTED_REF]')
    })

    it('4. strips JavaScript stack traces', () => {
      const msg = 'Invalid tool argument\n    at ToolRegistry.execute (C:\\repo\\tool.ts:10:5)'
      const sanitized = sanitizeAgentErrorMessage(msg)
      expect(sanitized).not.toContain('at ToolRegistry.execute')
      expect(sanitized).toBe('Invalid tool argument')
    })
  })

  describe('formatAgentIpcError', () => {
    it('1. serializes string error to JSON AgentIpcErrorDto', () => {
      const err = formatAgentIpcError('Simple error message')
      const parsed = JSON.parse(err.message)
      expect(parsed.code).toBe('AGENT_OPERATION_FAILED')
      expect(parsed.message).toBe('Simple error message')
      expect(parsed.retryable).toBe(false)
    })

    it('2. preserves structured error code and retryable flag from Error object', () => {
      const customErr = Object.assign(new Error('Tool failed'), {
        code: 'TOOL_EXECUTION_FAILED',
        retryable: true
      })
      const err = formatAgentIpcError(customErr)
      const parsed = JSON.parse(err.message)
      expect(parsed.code).toBe('TOOL_EXECUTION_FAILED')
      expect(parsed.message).toBe('Tool failed')
      expect(parsed.retryable).toBe(true)
    })

    it('3. parses and re-sanitizes pre-serialized JSON error messages', () => {
      const jsonMsg = JSON.stringify({
        code: 'BOT_NOT_FOUND',
        message: 'Bot at C:\\secret\\bot.json was not found.',
        retryable: false
      })
      const err = formatAgentIpcError(new Error(jsonMsg))
      const parsed = JSON.parse(err.message)
      expect(parsed.code).toBe('BOT_NOT_FOUND')
      expect(parsed.message).toContain('[REDACTED_PATH]')
    })
  })

  describe('validateAgentIpcPayload', () => {
    it('1. returns validated data for conforming inputs', () => {
      const data = { agentRunId: randomUUID() }
      const validated = validateAgentIpcPayload(cancelAgentTaskRequestSchema, data)
      expect(validated.agentRunId).toBe(data.agentRunId)
    })

    it('2. throws formatted JSON Error with VALIDATION_FAILED code on bad input', () => {
      expect(() =>
        validateAgentIpcPayload(cancelAgentTaskRequestSchema, { bad: 123 })
      ).toThrowError(/VALIDATION_FAILED/)
    })
  })
})
