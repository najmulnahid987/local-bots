import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: {
    on: vi.fn(),
    removeListener: vi.fn(),
    invoke: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: vi.fn()
  }
}))
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../database/migrations/runner'
import { migrations } from '../database/migrations'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { DiagnosticSanitizer } from './diagnostic-sanitizer'
import { sanitizeConversationErrorMessage } from '../ipc/conversation-validation'
import { sanitizeAgentErrorMessage } from '../ipc/agent-validation'
import { sanitizeErrorMessage } from '../providers/provider-manager/errors'
import { ApprovalController } from './approval-controller'
import { sanitizeFts5SearchQuery } from '../documents/search/query-sanitizer'
import { WorkspacePathGuard, WorkspaceSecurityError } from '../security/workspace-path-guard'
import { createConversationApi, createAgentsApi } from '../../preload/index'
import { CONVERSATION_IPC_CHANNELS } from '../../shared/conversations'
import { AGENT_IPC_CHANNELS } from '../../shared/agents'

describe('Phase 12 — Step 12.8: Reliability and Security Hardening', () => {
  describe('1. Secret Query Parameters & Header Redaction', () => {
    const samples = [
      'Request failed: https://generativelanguage.googleapis.com/v1/models?key=AIzaSySecretQueryParam1234567890&alt=sse',
      'Upstream error with &api_key=my_secret_api_key_value_999&token=tok_secret_abc123',
      'Header x-api-key: sk-ant-api03-supersecretkeyvalue1234567890 failed',
      'Header x-goog-api-key: secret-goog-header-value-99999 rejected',
      'Header authorization: Bearer secret_jwt_token_value_1234567890'
    ]

    it('DiagnosticSanitizer redacts secret query params and headers', () => {
      for (const sample of samples) {
        const sanitized = DiagnosticSanitizer.sanitize(sample)
        expect(sanitized).not.toContain('AIzaSySecretQueryParam1234567890')
        expect(sanitized).not.toContain('my_secret_api_key_value_999')
        expect(sanitized).not.toContain('tok_secret_abc123')
        expect(sanitized).not.toContain('supersecretkeyvalue1234567890')
        expect(sanitized).not.toContain('secret-goog-header-value-99999')
        expect(sanitized).not.toContain('secret_jwt_token_value_1234567890')
      }
    })

    it('IPC and Provider error sanitizers redact secret query params and headers', () => {
      for (const sample of samples) {
        for (const fn of [
          sanitizeConversationErrorMessage,
          sanitizeAgentErrorMessage,
          sanitizeErrorMessage
        ]) {
          const sanitized = fn(sample)
          expect(sanitized).not.toContain('AIzaSySecretQueryParam1234567890')
          expect(sanitized).not.toContain('my_secret_api_key_value_999')
          expect(sanitized).not.toContain('tok_secret_abc123')
          expect(sanitized).not.toContain('supersecretkeyvalue1234567890')
          expect(sanitized).not.toContain('secret-goog-header-value-99999')
          expect(sanitized).not.toContain('secret_jwt_token_value_1234567890')
        }
      }
    })
  })

  describe('2. Preload Malformed Stream Event Resilience', () => {
    it('ignores malformed non-object or missing-type payloads on Conversation stream port', async () => {
      const listeners = new Map<string, ((ev: unknown, data: unknown) => void)[]>()
      const fakePort: {
        onmessage: ((ev: { data: unknown }) => void) | null
        start: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      } = {
        onmessage: null,
        start: vi.fn(),
        close: vi.fn()
      }

      const fakeIpc = {
        on: vi.fn((ch: string, cb: (ev: unknown, data: unknown) => void) => {
          const list = listeners.get(ch) ?? []
          list.push(cb)
          listeners.set(ch, list)
        }),
        removeListener: vi.fn(),
        invoke: vi.fn(async (_ch: string, payload: { requestId?: string }) => {
          setTimeout(() => {
            for (const cb of listeners.get(CONVERSATION_IPC_CHANNELS.STREAM_PORT) ?? []) {
              cb({ ports: [fakePort] }, { requestId: payload.requestId })
            }
            setTimeout(() => {
              // Malformed payloads must not crash or reject
              fakePort.onmessage?.({ data: null })
              fakePort.onmessage?.({ data: 'corrupted string' })
              fakePort.onmessage?.({ data: { noType: true } })
              // Valid finish event still resolves cleanly
              fakePort.onmessage?.({
                data: {
                  type: 'finish',
                  finishReason: 'stop',
                  totalTextLength: 2,
                  durationMs: 10,
                  requestId: payload.requestId,
                  botId: 'bot-1',
                  conversationId: 'conv-1',
                  executionMode: 'chat',
                  sequenceNumber: 1,
                  timestamp: Date.now(),
                  stage: 'completed',
                  message: {
                    id: 'msg-1',
                    conversationId: 'conv-1',
                    role: 'assistant',
                    content: 'ok',
                    contentFormat: 'markdown',
                    metadata: {},
                    tokenUsage: null,
                    createdAt: Date.now()
                  }
                }
              })
            }, 5)
          }, 5)
          return { started: true }
        })
      }

      const api = createConversationApi(fakeIpc as unknown as Electron.IpcRenderer)
      const received: unknown[] = []
      const res = await api.sendMessage(
        { conversationId: 'conv-1', content: 'hi', requestId: 'req-malformed-test' },
        (ev) => received.push(ev)
      )

      expect(res.assistantMessage.content).toBe('ok')
      expect(received).toHaveLength(1)
    })

    it('ignores malformed payloads on Agent stream port without crashing subscribers', () => {
      const listeners = new Map<string, ((ev: unknown, data: unknown) => void)[]>()
      const fakePort: {
        onmessage: ((ev: { data: unknown }) => void) | null
        start: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      } = {
        onmessage: null,
        start: vi.fn(),
        close: vi.fn()
      }

      const fakeIpc = {
        on: vi.fn((ch: string, cb: (ev: unknown, data: unknown) => void) => {
          const list = listeners.get(ch) ?? []
          list.push(cb)
          listeners.set(ch, list)
        }),
        removeListener: vi.fn(),
        invoke: vi.fn()
      }

      const api = createAgentsApi(fakeIpc as unknown as Electron.IpcRenderer)
      const received: unknown[] = []
      api.subscribeToTaskEvents('run-1', (ev) => received.push(ev))

      for (const cb of listeners.get(AGENT_IPC_CHANNELS.STREAM_PORT) ?? []) {
        cb({ ports: [fakePort] }, { agentRunId: 'run-1' })
      }

      expect(() => fakePort.onmessage?.({ data: null })).not.toThrow()
      expect(() => fakePort.onmessage?.({ data: 12345 })).not.toThrow()
      expect(() => fakePort.onmessage?.({ data: { missingType: 1 } })).not.toThrow()
      expect(received).toHaveLength(0)
    })
  })

  describe('3. ApprovalController Cross-Run / Cross-Bot Binding', () => {
    it('prevents retrieving approved content using a different botId or agentRunId', async () => {
      const controller = new ApprovalController()
      let capturedReqId = ''
      controller.onEvent((ev) => {
        if (ev.type === 'requested') {
          capturedReqId = ev.request.requestId
        }
      })

      const approvalPromise = controller.requestApproval({
        agentRunId: 'run-A',
        botId: 'bot-A',
        title: 'Report',
        markdownContent: '# Secret Report'
      })

      expect(capturedReqId).not.toBe('')
      // Cross-bot or cross-run approve must be rejected (returns false)
      expect(controller.approve(capturedReqId, { agentRunId: 'run-A', botId: 'bot-B' })).toBe(false)
      expect(controller.approve(capturedReqId, { agentRunId: 'run-B', botId: 'bot-A' })).toBe(false)

      // Authoritative approve succeeds
      expect(controller.approve(capturedReqId, { agentRunId: 'run-A', botId: 'bot-A' })).toBe(true)
      const decision = await approvalPromise
      expect(decision.status).toBe('approved')

      // Wrong botId or agentRunId must be rejected / return null
      expect(
        controller.getApprovedContent(capturedReqId, { agentRunId: 'run-A', botId: 'bot-B' })
      ).toBeNull()
      expect(
        controller.getApprovedContent(capturedReqId, { agentRunId: 'run-B', botId: 'bot-A' })
      ).toBeNull()

      // Authoritative match succeeds
      const approved = controller.getApprovedContent(capturedReqId, {
        agentRunId: 'run-A',
        botId: 'bot-A'
      })
      expect(approved?.content).toBe('# Secret Report')
    })
  })

  describe('4. SQLite Transaction Rollback, Foreign Keys, & FTS5 Injection Safety', () => {
    let db: Database.Database

    beforeEach(() => {
      db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      runMigrations(db, migrations)
    })

    afterEach(() => {
      db.close()
    })

    it('rolls back entire multi-row transaction on failure and rejects FK violations', () => {
      const kbRepo = new KnowledgeBaseRepository(db)
      const botRepo = new BotRepository(db)
      const convRepo = new ConversationRepository(db)
      const msgRepo = new MessageRepository(db)

      const kb = kbRepo.create({ name: 'Tx KB' })
      const bot = botRepo.create({ knowledgeBaseId: kb.id, name: 'TxBot', modelId: 'gpt-4o' })
      const conv = convRepo.create({ botId: bot.id, knowledgeBaseId: kb.id, title: 'Canonical' })

      expect(() => {
        db.transaction(() => {
          msgRepo.create({
            conversationId: conv.id,
            botId: bot.id,
            knowledgeBaseId: kb.id,
            role: 'user',
            content: 'Should roll back'
          })
          // Trigger FK violation
          msgRepo.create({
            conversationId: randomUUID(),
            botId: bot.id,
            knowledgeBaseId: kb.id,
            role: 'user',
            content: 'Invalid FK'
          })
        })()
      }).toThrow()

      expect(msgRepo.listByConversation(conv.id, bot.id, kb.id)).toHaveLength(0)
    })

    it('neutralizes SQL/FTS5 injection payloads in query sanitizer and parameterized FTS5 MATCH', () => {
      const payload = `'; DROP TABLE messages; -- OR NEAR(a, b)`
      const sanitized = sanitizeFts5SearchQuery(payload)
      expect(sanitized.startsWith('"')).toBe(true)

      const rows = db
        .prepare('SELECT chunk_id FROM knowledge_fts WHERE knowledge_fts MATCH ?')
        .all(sanitized)
      expect(rows).toEqual([])
      // Verify messages table still exists and was not dropped
      const msgTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() as { name: string } | undefined
      expect(msgTable?.name).toBe('messages')
    })
  })

  describe('5. WorkspacePathGuard Sensitive File & Traversal Rejection', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-sec-128-'))
      fs.writeFileSync(path.join(tmpDir, '.env'), 'API_KEY=secret')
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'API_KEY=secret2')
      fs.mkdirSync(path.join(tmpDir, '.git'))
      fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '[core]')
      fs.writeFileSync(path.join(tmpDir, 'id_rsa'), 'PRIVATE')
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('blocks .env, .env.local, .git/config, id_rsa, traversal, UNC, and NUL bytes', () => {
      const canonicalRoot = WorkspacePathGuard.validateRootDirectory(tmpDir)
      const blockedInputs = [
        '.env',
        '.env.local',
        '.git/config',
        'id_rsa',
        '../outside.txt',
        '\\\\server\\share\\file.txt',
        'file\0.txt'
      ]

      for (const input of blockedInputs) {
        expect(() => WorkspacePathGuard.validatePath(canonicalRoot, input)).toThrow(
          WorkspaceSecurityError
        )
      }
    })
  })
})
