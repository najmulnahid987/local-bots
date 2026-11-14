import { z } from 'zod'

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
