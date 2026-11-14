// ============================================================================
// Agent Model Step Executor Contract (Provider-Independent)
// Phase 8 Step 8.6
// ============================================================================

/**
 * Message roles supported within the internal agent execution history.
 */
export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * System prompt containing grounding instructions and persona.
 */
export interface AgentSystemMessage {
  readonly role: 'system'
  readonly content: string
}

/**
 * User task instruction or prompt.
 */
export interface AgentUserMessage {
  readonly role: 'user'
  readonly content: string
}

/**
 * Model decision message: either prose or a tool call request.
 */
export interface AgentAssistantMessage {
  readonly role: 'assistant'
  readonly content?: string
  readonly toolCall?: {
    readonly toolCallId: string
    readonly toolName: string
    readonly rawArguments: unknown
  }
}

/**
 * Result returned from a tool execution, fed back into the agent conversation loop.
 */
export interface AgentToolMessage {
  readonly role: 'tool'
  readonly toolCallId: string
  readonly toolName: string
  readonly content: string
  readonly isError?: boolean
}

/**
 * Union of all internal agent message types.
 */
export type AgentMessage =
  AgentSystemMessage | AgentUserMessage | AgentAssistantMessage | AgentToolMessage

/**
 * Bounded descriptor of a tool available to the agent for this run.
 */
export interface AgentToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
}

/**
 * Token and context window budget tracking for the active agent run.
 */
export interface AgentContextBudget {
  readonly modelContextLimit: number
  readonly reservedOutputTokens: number
  readonly availableInputTokens: number
  readonly estimatedCurrentTokens: number
}

/**
 * Request sent to the model step executor to produce one decision.
 */
export interface AgentModelStepRequest {
  readonly agentRunId: string
  readonly botId: string
  readonly knowledgeBaseId: string
  readonly conversationId?: string | null
  readonly selectedModel: string
  readonly history: readonly AgentMessage[]
  readonly tools: readonly AgentToolDescriptor[]
  readonly signal?: AbortSignal
  readonly contextBudget?: AgentContextBudget
}

// ============================================================================
// Model Step Decisions (Discriminated Union)
// ============================================================================

/**
 * Decision to invoke a specific tool with untrusted arguments.
 */
export interface AgentToolCallDecision {
  readonly type: 'tool_call'
  readonly toolCallId: string
  readonly toolName: string
  readonly rawArguments: unknown
}

/**
 * Decision to conclude the task with a final response.
 */
export interface AgentFinalResponseDecision {
  readonly type: 'final'
  readonly content: string
  readonly modelMetadata?: {
    readonly finishReason?: string
    readonly promptTokens?: number
    readonly completionTokens?: number
  }
}

/**
 * Result returned by an AgentModelStepExecutor for a single decision round.
 * Strictly limited to at most one tool call per iteration for MVP determinism.
 */
export type AgentModelStepResult = AgentToolCallDecision | AgentFinalResponseDecision

// ============================================================================
// Executor Interface
// ============================================================================

/**
 * Neutral, provider-independent abstraction for executing a single model decision round.
 * Supports deterministic mock/fake executors in tests and provider adapters in production.
 */
export interface AgentModelStepExecutor {
  executeStep(request: AgentModelStepRequest): Promise<AgentModelStepResult>
}
