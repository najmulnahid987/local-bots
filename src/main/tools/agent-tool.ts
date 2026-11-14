import type { z } from 'zod'
import type { CanonicalBotTool } from '../../shared/agents'

// ============================================================================
// Tool Execution Context & Results
// ============================================================================

/**
 * Trusted Main-process context provided to an AgentTool during execution.
 * Authoritative Bot and Knowledge Base identities are derived exclusively
 * from the database by Main-process services and can never be overridden
 * by model-supplied arguments.
 */
export interface ToolExecutionContext {
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly agentRunId?: string
  readonly signal?: AbortSignal
}

/**
 * Structured output that a tool implementation may return.
 */
export interface ToolExecutionOutput<TResult = unknown> {
  readonly result: TResult
  readonly resultSummary: string
}

export type ToolExecuteReturn<TResult = unknown> = ToolExecutionOutput<TResult> | TResult

/**
 * Standard structured result returned from ToolRegistry.execute.
 */
export interface ToolExecutionResult<TResult = unknown> {
  readonly toolName: CanonicalBotTool
  readonly result: TResult
  readonly argumentsSummary: string
  readonly resultSummary: string
}

// ============================================================================
// AgentTool Interface
// ============================================================================

/**
 * Neutral Main-process abstraction for an agent tool.
 * Decoupled from provider-specific SDKs (e.g. Vercel AI SDK).
 */
export interface AgentTool<TInput = unknown, TResult = unknown> {
  readonly name: CanonicalBotTool
  readonly description: string
  readonly schema: z.ZodType<TInput>
  readonly requiredPermission: CanonicalBotTool
  execute(
    args: TInput,
    context: ToolExecutionContext
  ): Promise<ToolExecuteReturn<TResult>> | ToolExecuteReturn<TResult>
}

// ============================================================================
// Error Types
// ============================================================================

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'DUPLICATE_TOOL'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'BOT_NOT_FOUND'
  | 'BOT_ARCHIVED'
  | 'KNOWLEDGE_BASE_NOT_FOUND'
  | 'KNOWLEDGE_BASE_ARCHIVED'
  | 'EXECUTION_FAILED'
  | 'ABORTED'

export class ToolError extends Error {
  public readonly code: ToolErrorCode
  public readonly toolName?: string

  constructor(message: string, code: ToolErrorCode, toolName?: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.toolName = toolName
    Object.setPrototypeOf(this, ToolError.prototype)
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(message: string, toolName?: string) {
    super(message, 'TOOL_NOT_FOUND', toolName)
    this.name = 'ToolNotFoundError'
    Object.setPrototypeOf(this, ToolNotFoundError.prototype)
  }
}

export class ToolDuplicateError extends ToolError {
  constructor(message: string, toolName?: string) {
    super(message, 'DUPLICATE_TOOL', toolName)
    this.name = 'ToolDuplicateError'
    Object.setPrototypeOf(this, ToolDuplicateError.prototype)
  }
}

export class ToolValidationError extends ToolError {
  constructor(message: string, toolName?: string) {
    super(message, 'VALIDATION_FAILED', toolName)
    this.name = 'ToolValidationError'
    Object.setPrototypeOf(this, ToolValidationError.prototype)
  }
}

export class ToolPermissionError extends ToolError {
  constructor(message: string, toolName?: string) {
    super(message, 'PERMISSION_DENIED', toolName)
    this.name = 'ToolPermissionError'
    Object.setPrototypeOf(this, ToolPermissionError.prototype)
  }
}

export class ToolExecutionError extends ToolError {
  constructor(message: string, code: ToolErrorCode = 'EXECUTION_FAILED', toolName?: string) {
    super(message, code, toolName)
    this.name = 'ToolExecutionError'
    Object.setPrototypeOf(this, ToolExecutionError.prototype)
  }
}
