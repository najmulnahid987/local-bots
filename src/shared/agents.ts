import { z } from 'zod'
import type { StreamLifecycleStage } from './conversations'

// ============================================================================
// Canonical & Legacy Tool Identifiers
// ============================================================================

/**
 * Authoritative canonical list of Phase 8 read-only and analytical tools.
 */
export const CANONICAL_BOT_TOOLS = [
  'search_knowledge_base',
  'read_knowledge_source',
  'list_knowledge_sources',
  'search_workspace_files',
  'read_workspace_file',
  'save_report'
] as const

export type CanonicalBotTool = (typeof CANONICAL_BOT_TOOLS)[number]

/**
 * Historical legacy tool identifiers used in earlier specifications and initial records.
 */
export const LEGACY_BOT_TOOLS = [
  'read_knowledge_base_document',
  'list_knowledge_base_documents',
  'search_project_files',
  'read_project_file',
  'prepare_report'
] as const

export type LegacyBotTool = (typeof LEGACY_BOT_TOOLS)[number]

/**
 * Non-destructive mapping from legacy tool identifiers to canonical Phase 8 names.
 */
export const LEGACY_TO_CANONICAL_TOOL_MAP: Readonly<Record<LegacyBotTool, CanonicalBotTool>> =
  Object.freeze({
    read_knowledge_base_document: 'read_knowledge_source',
    list_knowledge_base_documents: 'list_knowledge_sources',
    search_project_files: 'search_workspace_files',
    read_project_file: 'read_workspace_file',
    prepare_report: 'save_report'
  })

/**
 * Reverse mapping from canonical tool identifiers to their historical legacy aliases.
 */
export const CANONICAL_TO_LEGACY_TOOL_MAP: Readonly<
  Partial<Record<CanonicalBotTool, LegacyBotTool>>
> = Object.freeze({
  read_knowledge_source: 'read_knowledge_base_document',
  list_knowledge_sources: 'list_knowledge_base_documents',
  search_workspace_files: 'search_project_files',
  read_workspace_file: 'read_project_file',
  save_report: 'prepare_report'
})

/**
 * Complete set of all recognized tool identifiers (canonical + legacy).
 */
export const ALL_RECOGNIZED_BOT_TOOLS = [...CANONICAL_BOT_TOOLS, ...LEGACY_BOT_TOOLS] as const

export type AnyBotTool = (typeof ALL_RECOGNIZED_BOT_TOOLS)[number]

/**
 * Normalizes any recognized tool name (canonical or legacy alias) into its canonical Phase 8 name.
 * Returns null if the tool name is unknown or unrecognized.
 */
export function normalizeToolName(toolName: string): CanonicalBotTool | null {
  if ((CANONICAL_BOT_TOOLS as readonly string[]).includes(toolName)) {
    return toolName as CanonicalBotTool
  }
  if (toolName in LEGACY_TO_CANONICAL_TOOL_MAP) {
    return LEGACY_TO_CANONICAL_TOOL_MAP[toolName as LegacyBotTool]
  }
  return null
}

/**
 * Checks whether a specific canonical tool is authorized for a Bot based on its enabled tools list.
 * Respects both canonical tool names and historical legacy aliases in the stored permissions.
 * Does NOT enable disabled tools or unknown tool names.
 */
export function isBotToolEnabled(
  enabledTools: readonly string[] | undefined | null,
  requiredTool: CanonicalBotTool
): boolean {
  if (!enabledTools || !Array.isArray(enabledTools) || enabledTools.length === 0) {
    return false
  }

  // 1. Direct match with canonical name
  if (enabledTools.includes(requiredTool)) {
    return true
  }

  // 2. Direct match with legacy alias
  const legacyAlias = CANONICAL_TO_LEGACY_TOOL_MAP[requiredTool]
  if (legacyAlias && enabledTools.includes(legacyAlias)) {
    return true
  }

  // 3. Fallback: normalize every enabled tool and compare
  return enabledTools.some((tool) => normalizeToolName(tool) === requiredTool)
}

// ============================================================================
// Agent Run Status & Database Mapping
// ============================================================================

/**
 * Application-level execution statuses for Agent Runs.
 */
export const AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled'
] as const

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

/**
 * SQLite database CHECK constraint values for agent_runs.status:
 * CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'))
 */
export const DB_AGENT_RUN_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled'
] as const

export type DbAgentRunStatus = (typeof DB_AGENT_RUN_STATUSES)[number]

/**
 * Maps application-level AgentRunStatus to the SQLite database check constraint string.
 */
export function toDbAgentRunStatus(status: AgentRunStatus): DbAgentRunStatus {
  switch (status) {
    case 'queued':
      return 'pending'
    case 'waiting_approval':
      return 'awaiting_approval'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default: {
      const _exhaustive: never = status
      throw new Error(`Unknown AgentRunStatus: ${_exhaustive}`)
    }
  }
}

/**
 * Maps SQLite database status string to application-level AgentRunStatus.
 */
export function toAppAgentRunStatus(dbStatus: DbAgentRunStatus | string): AgentRunStatus {
  switch (dbStatus) {
    case 'pending':
      return 'queued'
    case 'awaiting_approval':
      return 'waiting_approval'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      throw new Error(`Unknown DbAgentRunStatus: '${dbStatus}'`)
  }
}

// ============================================================================
// Tool Event Status & Approval Status
// ============================================================================

/**
 * Lifecycle statuses for individual tool execution events.
 * Matches SQLite CHECK constraint:
 * CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
 */
export const TOOL_EVENT_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
] as const

export type ToolEventStatus = (typeof TOOL_EVENT_STATUSES)[number]

/**
 * Human-in-the-loop approval statuses for tool events.
 * Matches SQLite CHECK constraint:
 * CHECK (approval_status IN ('not_required', 'auto_approved', 'pending_approval', 'user_approved', 'user_rejected'))
 */
export const TOOL_APPROVAL_STATUSES = [
  'not_required',
  'auto_approved',
  'pending_approval',
  'user_approved',
  'user_rejected'
] as const

export type ToolApprovalStatus = (typeof TOOL_APPROVAL_STATUSES)[number]

// ============================================================================
// Summary Limits & Security Constraints
// ============================================================================

export const MAX_ARGUMENTS_SUMMARY_LENGTH = 2000
export const MAX_RESULT_SUMMARY_LENGTH = 4000
export const MAX_ERROR_SUMMARY_LENGTH = 2000
export const MAX_AGENT_RUN_ITERATIONS = 5

// ============================================================================
// Public Data Transfer Objects (DTOs)
// ============================================================================

export interface AgentRunDto {
  readonly id: string
  readonly botId: string
  readonly conversationId: string | null
  readonly status: AgentRunStatus
  readonly selectedModel: string
  readonly iterationCount: number
  readonly errorSummary: string | null
  readonly startedAt: number
  readonly completedAt: number | null
}

export interface ToolEventDto {
  readonly id: string
  readonly agentRunId: string
  readonly sequenceNumber: number
  readonly toolName: CanonicalBotTool
  readonly status: ToolEventStatus
  readonly approvalStatus: ToolApprovalStatus
  readonly argumentsSummary: string
  readonly resultSummary: string
  readonly errorMessage: string | null
  readonly startedAt: number
  readonly completedAt: number | null
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

export const canonicalBotToolSchema = z.enum(CANONICAL_BOT_TOOLS, {
  message: 'Invalid canonical bot tool identifier.'
})

export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES, {
  message: 'Invalid agent run status.'
})

export const toolEventStatusSchema = z.enum(TOOL_EVENT_STATUSES, {
  message: 'Invalid tool event status.'
})

export const toolApprovalStatusSchema = z.enum(TOOL_APPROVAL_STATUSES, {
  message: 'Invalid tool approval status.'
})

export const agentRunDtoSchema = z
  .object({
    id: z.string().uuid({ message: 'Run ID must be a valid RFC 4122 UUIDv4.' }),
    botId: z.string().uuid({ message: 'Bot ID must be a valid RFC 4122 UUIDv4.' }),
    conversationId: z
      .string()
      .uuid({ message: 'Conversation ID must be a valid RFC 4122 UUIDv4.' })
      .nullable(),
    status: agentRunStatusSchema,
    selectedModel: z
      .string()
      .trim()
      .min(1, { message: 'selectedModel cannot be blank.' })
      .max(100, { message: 'selectedModel cannot exceed 100 characters.' }),
    iterationCount: z
      .number()
      .int({ message: 'iterationCount must be an integer.' })
      .min(0, { message: 'iterationCount cannot be negative.' })
      .max(MAX_AGENT_RUN_ITERATIONS, {
        message: `iterationCount cannot exceed ${MAX_AGENT_RUN_ITERATIONS}.`
      }),
    errorSummary: z
      .string()
      .max(MAX_ERROR_SUMMARY_LENGTH, {
        message: `errorSummary cannot exceed ${MAX_ERROR_SUMMARY_LENGTH} characters.`
      })
      .nullable(),
    startedAt: z
      .number()
      .int()
      .positive({ message: 'startedAt must be a positive integer timestamp.' }),
    completedAt: z
      .number()
      .int()
      .positive({ message: 'completedAt must be a positive integer timestamp.' })
      .nullable()
  })
  .strict()
  .refine((data) => data.completedAt === null || data.completedAt >= data.startedAt, {
    message: 'completedAt cannot be earlier than startedAt.'
  })

export const toolEventDtoSchema = z
  .object({
    id: z.string().uuid({ message: 'Tool Event ID must be a valid RFC 4122 UUIDv4.' }),
    agentRunId: z.string().uuid({ message: 'Agent Run ID must be a valid RFC 4122 UUIDv4.' }),
    sequenceNumber: z
      .number()
      .int({ message: 'sequenceNumber must be an integer.' })
      .min(1, { message: 'sequenceNumber must be at least 1.' }),
    toolName: canonicalBotToolSchema,
    status: toolEventStatusSchema,
    approvalStatus: toolApprovalStatusSchema,
    argumentsSummary: z.string().max(MAX_ARGUMENTS_SUMMARY_LENGTH, {
      message: `argumentsSummary cannot exceed ${MAX_ARGUMENTS_SUMMARY_LENGTH} characters.`
    }),
    resultSummary: z.string().max(MAX_RESULT_SUMMARY_LENGTH, {
      message: `resultSummary cannot exceed ${MAX_RESULT_SUMMARY_LENGTH} characters.`
    }),
    errorMessage: z
      .string()
      .max(MAX_ERROR_SUMMARY_LENGTH, {
        message: `errorMessage cannot exceed ${MAX_ERROR_SUMMARY_LENGTH} characters.`
      })
      .nullable(),
    startedAt: z
      .number()
      .int()
      .positive({ message: 'startedAt must be a positive integer timestamp.' }),
    completedAt: z
      .number()
      .int()
      .positive({ message: 'completedAt must be a positive integer timestamp.' })
      .nullable()
  })
  .strict()
  .refine((data) => data.completedAt === null || data.completedAt >= data.startedAt, {
    message: 'completedAt cannot be earlier than startedAt.'
  })

// ============================================================================
// Phase 8 Step 8.9 — Agent IPC Channels & Error Hierarchy
// ============================================================================

export const AGENT_IPC_CHANNELS = {
  DISPATCH_TASK: 'agent:dispatch-task',
  CANCEL_TASK: 'agent:cancel-task',
  GET_RUN: 'agent:get-run',
  LIST_RUNS: 'agent:list-runs',
  LIST_TOOL_EVENTS: 'agent:list-tool-events',
  GET_APPROVAL_DETAILS: 'agent:get-approval-details',
  RESPOND_TO_APPROVAL: 'agent:respond-to-approval',
  STREAM_PORT: 'agent:stream-port'
} as const

export type AgentIpcChannel = (typeof AGENT_IPC_CHANNELS)[keyof typeof AGENT_IPC_CHANNELS]

export class AgentBridgeError extends Error {
  public readonly code: string
  public readonly retryable: boolean

  constructor(message: string, code = 'AGENT_BRIDGE_ERROR', retryable = false) {
    super(message)
    this.name = 'AgentBridgeError'
    this.code = code
    this.retryable = retryable
    Object.setPrototypeOf(this, AgentBridgeError.prototype)
  }
}

// ============================================================================
// Phase 8 Step 8.9 — Request & Response DTOs
// ============================================================================

export const MAX_AGENT_TASK_PROMPT_LENGTH = 10_000
export const MAX_TOOL_EVENTS_PAGE_SIZE = 100
export const DEFAULT_TOOL_EVENTS_PAGE_SIZE = 50

export interface DispatchAgentTaskRequest {
  readonly botId: string
  readonly conversationId: string
  readonly taskPrompt: string
  readonly workspaceAccessRequested?: boolean
  readonly executionMode?: 'agent'
}

export interface DispatchAgentTaskResponse {
  readonly accepted: boolean
  readonly agentRunId: string
  readonly conversationId: string
  readonly status: 'queued' | 'running' | 'cancelled'
  readonly reason?: string
}

export interface CancelAgentTaskRequest {
  readonly agentRunId: string
}

export interface CancelAgentTaskResponse {
  readonly success: boolean
  readonly agentRunId: string
}

export interface GetAgentRunRequest {
  readonly agentRunId: string
}

export interface GetAgentRunResponse {
  readonly run: AgentRunDto
}

export interface ListAgentRunsRequest {
  readonly conversationId: string
  readonly botId?: string
  readonly limit?: number
  readonly offset?: number
}

export interface ListAgentRunsResponse {
  readonly runs: readonly AgentRunDto[]
  readonly total: number
  readonly hasMore: boolean
  readonly limit: number
  readonly offset: number
}

export interface ListToolEventsRequest {
  readonly agentRunId: string
  readonly limit?: number
  readonly offset?: number
}

export interface ListToolEventsResponse {
  readonly events: readonly ToolEventDto[]
  readonly total: number
  readonly hasMore: boolean
  readonly limit: number
  readonly offset: number
}

export interface GetApprovalDetailsRequest {
  readonly agentRunId: string
  readonly approvalRequestId: string
}

export interface ApprovalDetailsDto {
  readonly requestId: string
  readonly agentRunId: string
  readonly botId: string
  readonly title: string
  readonly markdownContent: string
  readonly contentSizeBytes: number
  readonly createdAt: number
  readonly expiresAt?: number
  readonly status: 'pending'
}

export interface RespondToApprovalRequest {
  readonly agentRunId: string
  readonly approvalRequestId: string
  readonly decision: 'approve' | 'reject'
  readonly reason?: string
}

export interface RespondToApprovalResponse {
  readonly success: boolean
  readonly requestId: string
  readonly status: 'approved' | 'rejected'
}

// ============================================================================
// Phase 8 Step 8.9 — Safe Agent Event Stream Contract
// ============================================================================

export type AgentStreamEventType =
  | 'agent_stage_change'
  | 'agent_text_delta'
  | 'agent_run_started'
  | 'agent_iteration_started'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'agent_run_completed'
  | 'agent_run_failed'
  | 'agent_run_cancelled'

export interface AgentStreamEventBase {
  readonly agentRunId: string
  readonly conversationId: string
  readonly botId: string
  readonly executionMode: 'agent'
  readonly stage: StreamLifecycleStage
  readonly sequenceNumber: number
  readonly timestamp: number
}

export interface AgentStageChangeStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_stage_change'
  readonly stage: StreamLifecycleStage
}

export interface AgentTextDeltaStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_text_delta'
  readonly textDelta: string
}

export interface AgentRunStartedStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_run_started'
  readonly botId: string
  readonly selectedModel: string
}

export interface AgentIterationStartedStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_iteration_started'
  readonly iteration: number
  readonly maxIterations: number
}

export interface ToolCallStartedStreamEvent extends AgentStreamEventBase {
  readonly type: 'tool_call_started'
  readonly toolEventId: string
  readonly toolName: CanonicalBotTool
  readonly argumentsSummary: string
}

export interface ToolCallCompletedStreamEvent extends AgentStreamEventBase {
  readonly type: 'tool_call_completed'
  readonly toolEventId: string
  readonly toolName: CanonicalBotTool
  readonly resultSummary: string
}

export interface ToolCallFailedStreamEvent extends AgentStreamEventBase {
  readonly type: 'tool_call_failed'
  readonly toolEventId: string
  readonly toolName: CanonicalBotTool
  readonly errorMessage: string
}

export interface ApprovalRequestedStreamEvent extends AgentStreamEventBase {
  readonly type: 'approval_requested'
  readonly approvalRequestId: string
  readonly title: string
  readonly contentPreview: string
  readonly contentSizeBytes: number
  readonly expiresAt?: number
}

export interface ApprovalResolvedStreamEvent extends AgentStreamEventBase {
  readonly type: 'approval_resolved'
  readonly approvalRequestId: string
  readonly status: 'approved' | 'rejected' | 'cancelled' | 'expired'
  readonly reason?: string
}

export interface AgentRunCompletedStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_run_completed'
  readonly finalResponse: string
  readonly iterations: number
  readonly toolEventsCount: number
  readonly citationsCount: number
  readonly workspaceFilesCount: number
}

export interface AgentRunFailedStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_run_failed'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable?: boolean
  }
}

export interface AgentRunCancelledStreamEvent extends AgentStreamEventBase {
  readonly type: 'agent_run_cancelled'
  readonly reason: string
}

export type AgentStreamEvent =
  | AgentStageChangeStreamEvent
  | AgentTextDeltaStreamEvent
  | AgentRunStartedStreamEvent
  | AgentIterationStartedStreamEvent
  | ToolCallStartedStreamEvent
  | ToolCallCompletedStreamEvent
  | ToolCallFailedStreamEvent
  | ApprovalRequestedStreamEvent
  | ApprovalResolvedStreamEvent
  | AgentRunCompletedStreamEvent
  | AgentRunFailedStreamEvent
  | AgentRunCancelledStreamEvent

// ============================================================================
// Phase 8 Step 8.9 — Strict Zod Schemas for IPC
// ============================================================================

export const dispatchAgentTaskRequestSchema = z
  .object({
    botId: z.string().uuid({ message: 'botId must be a valid RFC 4122 UUIDv4.' }),
    conversationId: z.string().uuid({ message: 'conversationId must be a valid RFC 4122 UUIDv4.' }),
    taskPrompt: z
      .string()
      .trim()
      .min(1, { message: 'taskPrompt cannot be blank.' })
      .max(MAX_AGENT_TASK_PROMPT_LENGTH, {
        message: `taskPrompt cannot exceed ${MAX_AGENT_TASK_PROMPT_LENGTH} characters.`
      }),
    workspaceAccessRequested: z.boolean().optional().default(false),
    executionMode: z.literal('agent').optional().default('agent')
  })
  .strict()

export const cancelAgentTaskRequestSchema = z
  .object({
    agentRunId: z.string().uuid({ message: 'agentRunId must be a valid RFC 4122 UUIDv4.' })
  })
  .strict()

export const getAgentRunRequestSchema = z
  .object({
    agentRunId: z.string().uuid({ message: 'agentRunId must be a valid RFC 4122 UUIDv4.' })
  })
  .strict()

export const listAgentRunsRequestSchema = z
  .object({
    conversationId: z.string().uuid({ message: 'conversationId must be a valid RFC 4122 UUIDv4.' }),
    botId: z.string().uuid({ message: 'botId must be a valid RFC 4122 UUIDv4.' }).optional(),
    limit: z
      .number()
      .int({ message: 'limit must be an integer.' })
      .min(1, { message: 'limit must be at least 1.' })
      .max(100, { message: 'limit cannot exceed 100.' })
      .optional()
      .default(50),
    offset: z
      .number()
      .int({ message: 'offset must be an integer.' })
      .min(0, { message: 'offset cannot be negative.' })
      .optional()
      .default(0)
  })
  .strict()

export const listToolEventsRequestSchema = z
  .object({
    agentRunId: z.string().uuid({ message: 'agentRunId must be a valid RFC 4122 UUIDv4.' }),
    limit: z
      .number()
      .int({ message: 'limit must be an integer.' })
      .min(1, { message: 'limit must be at least 1.' })
      .max(MAX_TOOL_EVENTS_PAGE_SIZE, {
        message: `limit cannot exceed ${MAX_TOOL_EVENTS_PAGE_SIZE}.`
      })
      .optional()
      .default(DEFAULT_TOOL_EVENTS_PAGE_SIZE),
    offset: z
      .number()
      .int({ message: 'offset must be an integer.' })
      .min(0, { message: 'offset cannot be negative.' })
      .optional()
      .default(0)
  })
  .strict()

export const getApprovalDetailsRequestSchema = z
  .object({
    agentRunId: z.string().uuid({ message: 'agentRunId must be a valid RFC 4122 UUIDv4.' }),
    approvalRequestId: z
      .string()
      .uuid({ message: 'approvalRequestId must be a valid RFC 4122 UUIDv4.' })
  })
  .strict()

export const respondToApprovalRequestSchema = z
  .object({
    agentRunId: z.string().uuid({ message: 'agentRunId must be a valid RFC 4122 UUIDv4.' }),
    approvalRequestId: z
      .string()
      .uuid({ message: 'approvalRequestId must be a valid RFC 4122 UUIDv4.' }),
    decision: z.enum(['approve', 'reject'], {
      message: "decision must be either 'approve' or 'reject'."
    }),
    reason: z
      .string()
      .trim()
      .max(500, { message: 'reason cannot exceed 500 characters.' })
      .optional()
  })
  .strict()

const agentStreamEventBaseShape = {
  agentRunId: z.string().uuid(),
  conversationId: z.string().uuid(),
  botId: z.string().uuid(),
  executionMode: z.literal('agent'),
  stage: z.enum([
    'idle',
    'preparing',
    'streaming',
    'finalizing',
    'completed',
    'cancelled',
    'failed'
  ]),
  sequenceNumber: z.number().int().positive(),
  timestamp: z.number().int().positive()
}

export const agentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent_stage_change'),
    ...agentStreamEventBaseShape
  }),
  z.object({
    type: z.literal('agent_text_delta'),
    ...agentStreamEventBaseShape,
    textDelta: z.string()
  }),
  z.object({
    type: z.literal('agent_run_started'),
    ...agentStreamEventBaseShape,
    selectedModel: z.string().min(1)
  }),
  z.object({
    type: z.literal('agent_iteration_started'),
    ...agentStreamEventBaseShape,
    iteration: z.number().int().min(1).max(MAX_AGENT_RUN_ITERATIONS),
    maxIterations: z.number().int().min(1).max(MAX_AGENT_RUN_ITERATIONS)
  }),
  z.object({
    type: z.literal('tool_call_started'),
    ...agentStreamEventBaseShape,
    toolEventId: z.string().uuid(),
    toolName: canonicalBotToolSchema,
    argumentsSummary: z.string()
  }),
  z.object({
    type: z.literal('tool_call_completed'),
    ...agentStreamEventBaseShape,
    toolEventId: z.string().uuid(),
    toolName: canonicalBotToolSchema,
    resultSummary: z.string()
  }),
  z.object({
    type: z.literal('tool_call_failed'),
    ...agentStreamEventBaseShape,
    toolEventId: z.string().uuid(),
    toolName: canonicalBotToolSchema,
    errorMessage: z.string()
  }),
  z.object({
    type: z.literal('approval_requested'),
    ...agentStreamEventBaseShape,
    approvalRequestId: z.string().uuid(),
    title: z.string(),
    contentPreview: z.string(),
    contentSizeBytes: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive().optional()
  }),
  z.object({
    type: z.literal('approval_resolved'),
    ...agentStreamEventBaseShape,
    approvalRequestId: z.string().uuid(),
    status: z.enum(['approved', 'rejected', 'cancelled', 'expired']),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal('agent_run_completed'),
    ...agentStreamEventBaseShape,
    finalResponse: z.string(),
    iterations: z.number().int().min(0),
    toolEventsCount: z.number().int().min(0),
    citationsCount: z.number().int().min(0),
    workspaceFilesCount: z.number().int().min(0)
  }),
  z.object({
    type: z.literal('agent_run_failed'),
    ...agentStreamEventBaseShape,
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional()
    })
  }),
  z.object({
    type: z.literal('agent_run_cancelled'),
    ...agentStreamEventBaseShape,
    reason: z.string()
  })
])
