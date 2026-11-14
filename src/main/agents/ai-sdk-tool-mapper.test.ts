import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  isZodSchema,
  mapToolsToAiSdk,
  mapAgentMessagesToChatMessages,
  mapAgentMessagesToModelMessages,
  mapToolCalls
} from './ai-sdk-tool-mapper'
import type { AgentMessage, AgentToolDescriptor } from './agent-model-step-executor'
import type { ToolDefinition } from '../providers/types'
import type { AgentTool } from '../tools/agent-tool'

describe('ai-sdk-tool-mapper (Phase 8 Step 8.7)', () => {
  describe('isZodSchema', () => {
    it('correctly identifies Zod objects and primitives', () => {
      expect(isZodSchema(z.object({ name: z.string() }))).toBe(true)
      expect(isZodSchema(z.string())).toBe(true)
      expect(isZodSchema(z.array(z.number()))).toBe(true)
    })

    it('returns false for plain objects and primitives', () => {
      expect(isZodSchema({})).toBe(false)
      expect(isZodSchema({ type: 'object' })).toBe(false)
      expect(isZodSchema(null)).toBe(false)
      expect(isZodSchema(undefined)).toBe(false)
      expect(isZodSchema('hello')).toBe(false)
      expect(isZodSchema(123)).toBe(false)
    })
  })

  describe('mapToolsToAiSdk', () => {
    it('maps an AgentTool with a Zod schema to an AI SDK tool without execute callback', () => {
      const mockAgentTool: AgentTool = {
        name: 'search_knowledge_base',
        description: 'Searches the Knowledge Base index',
        schema: z.object({ query: z.string(), limit: z.number().optional() }),
        requiredPermission: 'search_knowledge_base',
        execute: async () => ({ result: 'should not run', resultSummary: 'none' })
      }

      const aiTools = mapToolsToAiSdk([mockAgentTool])

      expect(Object.keys(aiTools)).toEqual(['search_knowledge_base'])
      const mapped = aiTools['search_knowledge_base'] as Record<string, unknown>
      expect(mapped.description).toBe('Searches the Knowledge Base index')
      expect(mapped.parameters).toBeDefined()
      // CRITICAL SECURITY INVARIANT: execute must be undefined!
      expect(mapped.execute).toBeUndefined()
    })

    it('maps all six canonical tools correctly without execution callbacks', () => {
      const canonicalTools: AgentToolDescriptor[] = [
        {
          name: 'search_knowledge_base',
          description: 'Search KB',
          parameters: z.object({ query: z.string() })
        },
        {
          name: 'read_knowledge_source',
          description: 'Read source',
          parameters: z.object({ sourceId: z.string() })
        },
        {
          name: 'list_knowledge_sources',
          description: 'List sources',
          parameters: z.object({ limit: z.number().optional() })
        },
        {
          name: 'search_workspace_files',
          description: 'Search files',
          parameters: z.object({ query: z.string() })
        },
        {
          name: 'read_workspace_file',
          description: 'Read file',
          parameters: z.object({ filePath: z.string() })
        },
        {
          name: 'save_report',
          description: 'Save report',
          parameters: z.object({ title: z.string(), content: z.string() })
        }
      ]

      const aiTools = mapToolsToAiSdk(canonicalTools)
      const keys = Object.keys(aiTools)
      expect(keys).toHaveLength(6)
      expect(keys).toContain('search_knowledge_base')
      expect(keys).toContain('read_knowledge_source')
      expect(keys).toContain('list_knowledge_sources')
      expect(keys).toContain('search_workspace_files')
      expect(keys).toContain('read_workspace_file')
      expect(keys).toContain('save_report')

      for (const k of keys) {
        expect((aiTools[k] as Record<string, unknown>).execute).toBeUndefined()
      }
    })

    it('handles JSON schema parameters cleanly', () => {
      const toolDef: ToolDefinition = {
        name: 'custom_tool',
        description: 'Tool with JSON schema',
        parameters: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count']
        }
      }

      const aiTools = mapToolsToAiSdk([toolDef])
      expect(aiTools['custom_tool']).toBeDefined()
      expect((aiTools['custom_tool'] as Record<string, unknown>).description).toBe(
        'Tool with JSON schema'
      )
      expect((aiTools['custom_tool'] as Record<string, unknown>).execute).toBeUndefined()
    })

    it('handles empty or missing parameters by providing an empty schema', () => {
      const toolDef: AgentToolDescriptor = {
        name: 'no_params_tool',
        description: 'No parameters tool'
      }

      const aiTools = mapToolsToAiSdk([toolDef])
      expect(aiTools['no_params_tool']).toBeDefined()
      expect((aiTools['no_params_tool'] as Record<string, unknown>).execute).toBeUndefined()
    })
  })

  describe('mapAgentMessagesToChatMessages', () => {
    it('maps system, user, assistant prose, assistant tool-call, and tool messages', () => {
      const history: AgentMessage[] = [
        { role: 'system', content: 'You are a test bot.' },
        { role: 'user', content: 'Find documents on physics' },
        {
          role: 'assistant',
          content: 'Searching the Knowledge Base...',
          toolCall: {
            toolCallId: 'call_123',
            toolName: 'search_knowledge_base',
            rawArguments: { query: 'physics' }
          }
        },
        {
          role: 'tool',
          toolCallId: 'call_123',
          toolName: 'search_knowledge_base',
          content: 'Found 2 documents.'
        },
        {
          role: 'assistant',
          content: 'Here are the physics documents.'
        }
      ]

      const { systemPrompt, messages } = mapAgentMessagesToChatMessages(history)

      expect(systemPrompt).toBe('You are a test bot.')
      expect(messages).toHaveLength(4)

      expect(messages[0]).toEqual({
        role: 'user',
        content: 'Find documents on physics'
      })

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: 'Searching the Knowledge Base...',
        toolCalls: [
          {
            id: 'call_123',
            name: 'search_knowledge_base',
            arguments: { query: 'physics' }
          }
        ]
      })

      expect(messages[2]).toEqual({
        role: 'tool',
        name: 'search_knowledge_base',
        toolCallId: 'call_123',
        content: 'Found 2 documents.'
      })

      expect(messages[3]).toEqual({
        role: 'assistant',
        content: 'Here are the physics documents.'
      })
    })
  })

  describe('mapAgentMessagesToModelMessages', () => {
    it('produces AI SDK ModelMessages conforming to AI SDK 7 specifications', () => {
      const history: AgentMessage[] = [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'Task instruction' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCall: {
            toolCallId: 'call_999',
            toolName: 'list_knowledge_sources',
            rawArguments: { limit: 10 }
          }
        },
        {
          role: 'tool',
          toolCallId: 'call_999',
          toolName: 'list_knowledge_sources',
          content: '{"sources": []}'
        }
      ]

      const { system, messages } = mapAgentMessagesToModelMessages(history)

      expect(system).toBe('System instruction')
      expect(messages).toHaveLength(3)

      expect(messages[0]).toEqual({
        role: 'user',
        content: 'Task instruction'
      })

      expect(messages[1].role).toBe('assistant')
      const assistantParts = messages[1].content as Array<Record<string, unknown>>
      expect(assistantParts[0]).toEqual({
        type: 'text',
        text: 'Let me check.'
      })
      expect(assistantParts[1]).toEqual({
        type: 'tool-call',
        toolCallId: 'call_999',
        toolName: 'list_knowledge_sources',
        input: { limit: 10 }
      })

      expect(messages[2].role).toBe('tool')
      const toolParts = messages[2].content as Array<Record<string, unknown>>
      expect(toolParts[0]).toEqual({
        type: 'tool-result',
        toolCallId: 'call_999',
        toolName: 'list_knowledge_sources',
        output: {
          type: 'text',
          value: '{"sources": []}'
        }
      })
    })

    it('formats tool error messages with error-text output type', () => {
      const history: AgentMessage[] = [
        {
          role: 'tool',
          toolCallId: 'call_err',
          toolName: 'read_knowledge_source',
          content: 'File not found on disk',
          isError: true
        }
      ]

      const { messages } = mapAgentMessagesToModelMessages(history)
      expect(messages[0].role).toBe('tool')
      const toolParts = messages[0].content as Array<Record<string, unknown>>
      expect(toolParts[0]).toEqual({
        type: 'tool-result',
        toolCallId: 'call_err',
        toolName: 'read_knowledge_source',
        output: {
          type: 'error-text',
          value: 'File not found on disk'
        }
      })
    })
  })

  describe('mapToolCalls', () => {
    it('normalizes tool calls with toolCallId and parsed input', () => {
      const raw = [
        {
          toolCallId: 'call_abc',
          toolName: 'search_knowledge_base',
          input: { query: 'quantum' }
        }
      ]

      const mapped = mapToolCalls(raw)
      expect(mapped).toEqual([
        {
          id: 'call_abc',
          name: 'search_knowledge_base',
          arguments: { query: 'quantum' }
        }
      ])
    })

    it('normalizes JSON string arguments into objects', () => {
      const raw = [
        {
          id: 'call_str',
          name: 'save_report',
          args: JSON.stringify({ title: 'My Report', content: 'Summary' })
        }
      ]

      const mapped = mapToolCalls(raw)
      expect(mapped).toEqual([
        {
          id: 'call_str',
          name: 'save_report',
          arguments: { title: 'My Report', content: 'Summary' }
        }
      ])
    })

    it('generates fallback IDs when tool call ID is omitted by provider', () => {
      const raw = [
        {
          toolName: 'read_workspace_file',
          input: { filePath: 'notes.txt' }
        }
      ]

      const mapped = mapToolCalls(raw)
      expect(mapped).toHaveLength(1)
      expect(mapped[0].id).toMatch(/^call_[0-9a-f-]{36}$/)
      expect(mapped[0].name).toBe('read_workspace_file')
      expect(mapped[0].arguments).toEqual({ filePath: 'notes.txt' })
    })

    it('handles non-array or invalid raw input safely', () => {
      expect(mapToolCalls(null)).toEqual([])
      expect(mapToolCalls(undefined)).toEqual([])
      expect(mapToolCalls('invalid')).toEqual([])
      expect(mapToolCalls([null, undefined, 123])).toEqual([])
    })
  })
})
