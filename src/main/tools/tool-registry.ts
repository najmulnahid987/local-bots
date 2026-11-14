import {
  type CanonicalBotTool,
  normalizeToolName,
  isBotToolEnabled,
  MAX_ARGUMENTS_SUMMARY_LENGTH,
  MAX_RESULT_SUMMARY_LENGTH
} from '../../shared/agents'
import type { BotRepository } from '../database/repositories/bot-repository'
import type { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import {
  type AgentTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolExecutionOutput,
  ToolError,
  ToolNotFoundError,
  ToolDuplicateError,
  ToolValidationError,
  ToolPermissionError,
  ToolExecutionError
} from './agent-tool'

// ============================================================================
// Registry Dependencies & Options
// ============================================================================

export interface ToolRegistryDependencies {
  readonly botRepository: BotRepository
  readonly knowledgeBaseRepository: KnowledgeBaseRepository
}

export interface ExecuteToolOptions {
  readonly toolName: string
  readonly botId: string
  readonly rawArguments: unknown
  readonly agentRunId?: string
  readonly signal?: AbortSignal
}

// ============================================================================
// Helper Utilities
// ============================================================================

function safeTruncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, Math.max(0, maxLength - 3)) + '...'
}

function isToolExecutionOutput<T>(value: unknown): value is ToolExecutionOutput<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    'resultSummary' in value &&
    typeof (value as { resultSummary: unknown }).resultSummary === 'string'
  )
}

// ============================================================================
// ToolRegistry Implementation
// ============================================================================

/**
 * Main-process registry managing agent tools, permission verification,
 * and authoritative Knowledge Base scoping.
 */
export class ToolRegistry {
  private readonly tools = new Map<CanonicalBotTool, AgentTool>()
  private readonly botRepo: BotRepository
  private readonly kbRepo: KnowledgeBaseRepository

  constructor(deps: ToolRegistryDependencies) {
    if (!deps.botRepository || !deps.knowledgeBaseRepository) {
      throw new Error('BotRepository and KnowledgeBaseRepository are required for ToolRegistry.')
    }
    this.botRepo = deps.botRepository
    this.kbRepo = deps.knowledgeBaseRepository
  }

  /**
   * Registers a tool using its canonical identifier.
   * Rejects duplicate registrations.
   */
  public register(tool: AgentTool): void {
    if (!tool || typeof tool !== 'object' || !tool.name) {
      throw new ToolValidationError(
        'Cannot register invalid tool: missing tool definition or name.'
      )
    }

    if (this.tools.has(tool.name)) {
      throw new ToolDuplicateError(
        `Tool '${tool.name}' is already registered in ToolRegistry.`,
        tool.name
      )
    }

    this.tools.set(tool.name, tool)
  }

  /**
   * Resolves a tool by its canonical name or recognized legacy alias.
   */
  public get(toolName: string): AgentTool | undefined {
    const canonicalName = normalizeToolName(toolName)
    if (!canonicalName) {
      return undefined
    }
    return this.tools.get(canonicalName)
  }

  /**
   * Checks whether a tool is registered under its canonical name or legacy alias.
   */
  public has(toolName: string): boolean {
    return this.get(toolName) !== undefined
  }

  /**
   * Lists all currently registered tools.
   */
  public list(): readonly AgentTool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Executes a tool with strict application-layer authorization, authoritative
   * Knowledge Base resolution, Zod schema validation, and abort signal monitoring.
   */
  public async execute(options: ExecuteToolOptions): Promise<ToolExecutionResult<unknown>> {
    if (!options || typeof options !== 'object') {
      throw new ToolValidationError('ExecuteToolOptions must be an object.')
    }

    // 1. Resolve registered tool
    const tool = this.get(options.toolName)
    if (!tool) {
      throw new ToolNotFoundError(
        `Tool '${options.toolName}' is not registered.`,
        normalizeToolName(options.toolName) ?? undefined
      )
    }

    // 2. Authoritative Bot lookup
    let bot
    try {
      bot = this.botRepo.getByIdOnly(options.botId)
    } catch (err) {
      throw new ToolExecutionError(
        `Failed to resolve Bot: ${err instanceof Error ? err.message : String(err)}`,
        'EXECUTION_FAILED',
        tool.name
      )
    }

    if (!bot) {
      throw new ToolExecutionError(`Bot '${options.botId}' not found.`, 'BOT_NOT_FOUND', tool.name)
    }

    if (bot.status !== 'active') {
      throw new ToolExecutionError(
        `Bot '${options.botId}' is archived and cannot execute tools.`,
        'BOT_ARCHIVED',
        tool.name
      )
    }

    const authoritativeKbId = bot.knowledgeBaseId

    // 3. Verify parent Knowledge Base exists and is not archived
    let kb
    try {
      kb = this.kbRepo.getById(authoritativeKbId)
    } catch (err) {
      throw new ToolExecutionError(
        `Failed to verify parent Knowledge Base: ${err instanceof Error ? err.message : String(err)}`,
        'EXECUTION_FAILED',
        tool.name
      )
    }

    if (!kb) {
      throw new ToolExecutionError(
        `Parent Knowledge Base '${authoritativeKbId}' for Bot '${options.botId}' was not found.`,
        'KNOWLEDGE_BASE_NOT_FOUND',
        tool.name
      )
    }

    if (kb.archived_at !== null) {
      throw new ToolExecutionError(
        `Parent Knowledge Base '${authoritativeKbId}' for Bot '${options.botId}' is archived.`,
        'KNOWLEDGE_BASE_ARCHIVED',
        tool.name
      )
    }

    // 4. Application-layer permission enforcement (before execution)
    const isAuthorized = isBotToolEnabled(bot.toolPermissions, tool.requiredPermission)
    if (!isAuthorized) {
      throw new ToolPermissionError(
        `Permission denied: Tool '${tool.name}' is not enabled for Bot '${options.botId}'.`,
        tool.name
      )
    }

    // 5. Validate arguments using registered tool schema
    const parseResult = tool.schema.safeParse(options.rawArguments ?? {})
    if (!parseResult.success) {
      const issueDetails = parseResult.error.issues
        .map((issue) =>
          issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
        )
        .join('; ')
      throw new ToolValidationError(
        `Invalid arguments for tool '${tool.name}': ${issueDetails}`,
        tool.name
      )
    }

    // 6. Check cancellation before running
    if (options.signal?.aborted) {
      throw new ToolExecutionError('Tool execution was cancelled.', 'ABORTED', tool.name)
    }

    // 7. Construct trusted execution context
    const context: ToolExecutionContext = {
      botId: bot.id,
      knowledgeBaseId: authoritativeKbId,
      agentRunId: options.agentRunId,
      signal: options.signal
    }

    // 8. Execute tool safely
    let rawOutput: unknown
    try {
      rawOutput = await tool.execute(parseResult.data, context)
    } catch (err) {
      if (err instanceof ToolError) {
        throw err
      }
      if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new ToolExecutionError('Tool execution was cancelled.', 'ABORTED', tool.name)
      }
      throw new ToolExecutionError(
        `Failed to execute tool '${tool.name}': ${err instanceof Error ? err.message : String(err)}`,
        'EXECUTION_FAILED',
        tool.name
      )
    }

    // 9. Format bounded safe summaries
    let finalResult: unknown
    let resultSummary: string

    if (isToolExecutionOutput(rawOutput)) {
      finalResult = rawOutput.result
      resultSummary = safeTruncate(rawOutput.resultSummary, MAX_RESULT_SUMMARY_LENGTH)
    } else {
      finalResult = rawOutput
      try {
        resultSummary = safeTruncate(JSON.stringify(rawOutput), MAX_RESULT_SUMMARY_LENGTH)
      } catch {
        resultSummary = safeTruncate(String(rawOutput), MAX_RESULT_SUMMARY_LENGTH)
      }
    }

    let argumentsSummary: string
    try {
      argumentsSummary = safeTruncate(
        JSON.stringify(parseResult.data ?? {}),
        MAX_ARGUMENTS_SUMMARY_LENGTH
      )
    } catch {
      argumentsSummary = '{}'
    }

    return {
      toolName: tool.name,
      result: finalResult,
      argumentsSummary,
      resultSummary
    }
  }
}
