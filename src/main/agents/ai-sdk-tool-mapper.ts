import { tool, jsonSchema, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { ToolDefinition, ChatMessage, ToolCall } from '../providers/types'
import type { AgentTool } from '../tools/agent-tool'
import type { AgentToolDescriptor, AgentMessage } from './agent-model-step-executor'

// ============================================================================
// Type Guards & Utility Helpers
// ============================================================================

/**
 * Checks whether an unknown value is a Zod schema object.
 */
export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value instanceof z.ZodType || '_def' in value) &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  )
}

// ============================================================================
// Tool Schema Mapping (Zero Local Execution)
// ============================================================================

/**
 * Converts a collection of AgentTool instances, AgentToolDescriptors, or ToolDefinitions
 * into a dictionary of AI SDK tools suitable for model tool-calling.
 *
 * CRITICAL SECURITY INVARIANT:
 * Zero `execute` callbacks are attached. The returned AI SDK tools are pure schema
 * declarations and cannot execute local code under any circumstances.
 */
export function mapToolsToAiSdk(
  tools: ReadonlyArray<ToolDefinition | AgentTool | AgentToolDescriptor>
): ToolSet {
  const result: ToolSet = {}

  for (const t of tools) {
    if (!t || typeof t !== 'object' || !t.name) {
      continue
    }

    let parametersSchema: unknown

    if ('schema' in t && t.schema) {
      parametersSchema = t.schema
    } else if ('parameters' in t && t.parameters) {
      if (isZodSchema(t.parameters)) {
        parametersSchema = t.parameters
      } else if (typeof t.parameters === 'object') {
        parametersSchema = jsonSchema(t.parameters as Record<string, unknown>)
      } else {
        parametersSchema = z.object({})
      }
    } else {
      parametersSchema = z.object({})
    }

    // Pure schema definition — execute callback is intentionally omitted
    const mappedTool = tool({
      description: t.description || '',
      parameters: parametersSchema as z.ZodTypeAny
    } as unknown as Parameters<typeof tool>[0])

    result[t.name] = mappedTool as unknown as ToolSet[string]
  }

  return result
}

// ============================================================================
// Message Mapping
// ============================================================================

/**
 * Maps internal AgentMessage execution history into application ChatMessage instances
 * and an optional separate system prompt.
 */
export function mapAgentMessagesToChatMessages(history: readonly AgentMessage[]): {
  systemPrompt?: string
  messages: ChatMessage[]
} {
  const systemParts: string[] = []
  const messages: ChatMessage[] = []

  for (const msg of history) {
    if (msg.role === 'system') {
      if (msg.content && msg.content.trim().length > 0) {
        systemParts.push(msg.content.trim())
      }
    } else if (msg.role === 'user') {
      messages.push({
        role: 'user',
        content: msg.content
      })
    } else if (msg.role === 'assistant') {
      if (msg.toolCall) {
        const toolCalls: ToolCall[] = [
          {
            id: msg.toolCall.toolCallId,
            name: msg.toolCall.toolName,
            arguments:
              typeof msg.toolCall.rawArguments === 'object' && msg.toolCall.rawArguments !== null
                ? (msg.toolCall.rawArguments as Record<string, unknown>)
                : {}
          }
        ]
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          toolCalls
        })
      } else {
        messages.push({
          role: 'assistant',
          content: msg.content ?? ''
        })
      }
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'tool',
        name: msg.toolName,
        toolCallId: msg.toolCallId,
        content: msg.content
      })
    }
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages
  }
}

/**
 * Maps internal AgentMessage history directly to AI SDK ModelMessage structures.
 */
export function mapAgentMessagesToModelMessages(history: readonly AgentMessage[]): {
  system?: string
  messages: ModelMessage[]
} {
  const systemParts: string[] = []
  const messages: ModelMessage[] = []

  for (const msg of history) {
    if (msg.role === 'system') {
      if (msg.content && msg.content.trim().length > 0) {
        systemParts.push(msg.content.trim())
      }
    } else if (msg.role === 'user') {
      messages.push({
        role: 'user',
        content: msg.content
      })
    } else if (msg.role === 'assistant') {
      if (msg.toolCall) {
        const contentParts: Array<
          | { type: 'text'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = []
        if (msg.content && msg.content.trim().length > 0) {
          contentParts.push({
            type: 'text',
            text: msg.content
          })
        }
        contentParts.push({
          type: 'tool-call',
          toolCallId: msg.toolCall.toolCallId,
          toolName: msg.toolCall.toolName,
          input: msg.toolCall.rawArguments ?? {}
        })
        messages.push({
          role: 'assistant',
          content: contentParts
        } as ModelMessage)
      } else {
        messages.push({
          role: 'assistant',
          content: msg.content ?? ''
        })
      }
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            output: msg.isError
              ? { type: 'error-text', value: msg.content }
              : { type: 'text', value: msg.content }
          }
        ]
      })
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages
  }
}

// ============================================================================
// Tool Call Parsing & Normalization
// ============================================================================

/**
 * Maps raw tool calls returned by AI SDK generateText or streamText into normalized ToolCall structures.
 * Ensures a reliable ID is present even if the vendor omitted one.
 */
export function mapToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) {
    return []
  }

  const results: ToolCall[] = []

  for (const raw of rawToolCalls) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const item = raw as {
      toolCallId?: string
      id?: string
      toolName?: string
      name?: string
      input?: unknown
      args?: unknown
    }

    const id = item.toolCallId || item.id || `call_${randomUUID()}`
    const name = item.toolName || item.name || 'unknown_tool'
    const rawArgs = item.input !== undefined ? item.input : item.args

    let parsedArgs: Record<string, unknown> = {}
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs)
      } catch {
        parsedArgs = {}
      }
    } else if (typeof rawArgs === 'object' && rawArgs !== null) {
      parsedArgs = rawArgs as Record<string, unknown>
    }

    results.push({
      id,
      name,
      arguments: parsedArgs
    })
  }

  return results
}
