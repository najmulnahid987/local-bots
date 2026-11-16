import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CONVERSATION_IPC_CHANNELS,
  type ConversationDto,
  type MessageDto,
  type DeleteConversationResultDto,
  type PublicConversationTurnEvent,
  ConversationBridgeError
} from '../../shared/conversations'
import {
  registerConversationIpcHandlers,
  registerFailingConversationIpcHandlers
} from './conversation-handlers'
import { ConversationStreamManager } from './conversation-stream-manager'
import {
  type MessagePortMainLike,
  type MessageChannelLike,
  type WebFrameWithPostMessage
} from './provider-stream-manager'
import {
  sanitizeConversationErrorMessage,
  formatConversationIpcError
} from './conversation-validation'
import { createConversationApi, normalizeConversationBridgeError } from '../../preload'
import { ConversationManagerService } from '../services/conversation-manager'
import {
  ConversationTurnService,
  ConversationTurnError,
  type ConversationTurnStream,
  type ConversationTurnEvent
} from '../services/conversation-turn-service'
import { ConversationRepository } from '../database/repositories/conversation-repository'
import { MessageRepository } from '../database/repositories/message-repository'
import { BotRepository } from '../database/repositories/bot-repository'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { ActiveWorkspaceContext } from '../services/active-workspace-context'
import { resetMonitoredSenders } from './bot-handlers'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'

// ipcRenderer listeners map
type IpcListener = (event: unknown, ...args: unknown[]) => void

// IPC registry and listeners for Electron mocks hoisted before module imports
const { mockIpcHandlers, mockRendererListeners } = vi.hoisted(() => {
  return {
    mockIpcHandlers: new Map<
      string,
      (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
    >(),
    mockRendererListeners: new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  }
})

vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
        ) => {
          mockIpcHandlers.set(channel, handler)
        }
      ),
      removeHandler: vi.fn((channel: string) => {
        mockIpcHandlers.delete(channel)
      })
    },
    contextBridge: {
      exposeInMainWorld: vi.fn()
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        const handler = mockIpcHandlers.get(channel)
        if (!handler) {
          throw new Error(`No handler registered for channel '${channel}'`)
        }
        // Synthetic default event from authorized window 1
        const defaultEvent: IpcSenderEventLike = {
          sender: defaultMockWebContents,
          senderFrame: defaultMockWebContents.mainFrame
        }
        return handler(defaultEvent, ...args)
      }),
      on: vi.fn((channel: string, listener: IpcListener) => {
        const list = mockRendererListeners.get(channel) ?? []
        list.push(listener)
        mockRendererListeners.set(channel, list)
      }),
      removeListener: vi.fn((channel: string, listener: IpcListener) => {
        const list = mockRendererListeners.get(channel) ?? []
        const idx = list.indexOf(listener)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
      })
    },
    BrowserWindow: vi.fn()
  }
})

let defaultMockWebContents: MockWebContentsWithEvents

class MockMessagePortMain implements MessagePortMainLike {
  public listeners = {
    message: [] as Array<(event: { data: unknown }) => void>,
    close: [] as Array<() => void>
  }
  public queue: unknown[] = []
  public remotePort: MockMessagePortMain | null = null
  public isClosed = false
  public isStarted = false

  public start(): void {
    this.isStarted = true
    this.flush()
  }

  public close(): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const listener of [...this.listeners.close]) {
      listener()
    }
  }

  public postMessage(message: unknown): void {
    if (this.remotePort && !this.remotePort.isClosed) {
      this.remotePort.queue.push(message)
      this.remotePort.flush()
    }
  }

  public flush(): void {
    if (!this.isStarted || this.listeners.message.length === 0) return
    while (this.queue.length > 0) {
      const msg = this.queue.shift()
      for (const listener of [...this.listeners.message]) {
        listener({ data: msg })
      }
    }
  }

  public on(
    event: 'message' | 'close',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (event === 'message') {
      this.listeners.message.push(listener as (event: { data: unknown }) => void)
      this.flush()
    } else if (event === 'close') {
      this.listeners.close.push(listener as () => void)
    }
  }

  public set onmessage(listener: ((event: { data: unknown }) => void) | null) {
    this.listeners.message = listener ? [listener] : []
    this.isStarted = true
    this.flush()
  }

  public get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.listeners.message[0] ?? null
  }
}

function createMockMessageChannel(): MessageChannelLike {
  const port1 = new MockMessagePortMain()
  const port2 = new MockMessagePortMain()
  port1.remotePort = port2
  port2.remotePort = port1
  return { port1, port2 }
}

interface MockWebContentsWithEvents extends WebContentsLike {
  id: number
  mainFrame: WebFrameWithPostMessage
  eventListeners: Map<string, Array<() => void>>
  isDestroyed: () => boolean
  once: (event: string, listener: () => void) => void
  on: (event: string, listener: () => void) => void
  emit: (event: string) => void
}

function createMockWebContents(id = 1): MockWebContentsWithEvents {
  let destroyed = false
  const eventListeners = new Map<string, Array<() => void>>()

  const mainFrame: WebFrameWithPostMessage = {
    url: 'http://localhost:5173/index.html',
    postMessage: vi.fn((channel: string, payload: unknown, transfer?: unknown[]) => {
      const listeners = mockRendererListeners.get(channel) ?? []
      for (const listener of listeners) {
        listener({ ports: transfer }, payload)
      }
    })
  }

  const contents: MockWebContentsWithEvents = {
    id,
    mainFrame,
    eventListeners,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      const list = eventListeners.get(event) ?? []
      list.push(listener)
      eventListeners.set(event, list)
    },
    on: (event: string, listener: () => void) => {
      const list = eventListeners.get(event) ?? []
      list.push(listener)
      eventListeners.set(event, list)
    },
    emit: (event: string) => {
      if (event === 'destroyed') {
        destroyed = true
      }
      const list = eventListeners.get(event) ?? []
      eventListeners.delete(event)
      for (const listener of list) {
        listener()
      }
    }
  }

  return contents
}

describe('Conversation IPC Bridge & Preload Integration', () => {
  let dbContext: MigratedTestDatabaseContext
  let kbRepo: KnowledgeBaseRepository
  let botRepo: BotRepository
  let convRepo: ConversationRepository
  let msgRepo: MessageRepository
  let activeContext: ActiveWorkspaceContext
  let convManager: ConversationManagerService
  let turnService: ConversationTurnService
  let streamManager: ConversationStreamManager

  const devOrigin = 'http://localhost:5173'
  let mockWebContents1: MockWebContentsWithEvents
  let mockWebContents2: MockWebContentsWithEvents
  let mockWindow1: BrowserWindowLike
  let mockWindow2: BrowserWindowLike
  let isWindow1Destroyed = false
  let isWindow2Destroyed = false

  let kb1Id: string
  let kb2Id: string
  let bot1Id: string
  let bot2Id: string

  beforeEach(() => {
    resetMonitoredSenders()
    mockRendererListeners.clear()
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()

    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    botRepo = new BotRepository(dbContext.db)
    convRepo = new ConversationRepository(dbContext.db)
    msgRepo = new MessageRepository(dbContext.db)
    activeContext = new ActiveWorkspaceContext({ kbRepo })

    convManager = new ConversationManagerService({
      conversationRepo: convRepo,
      messageRepo: msgRepo,
      botRepo,
      activeContext,
      db: dbContext.db
    })

    // Fixture Provider Connection
    const now = Date.now()
    const connId = '00000000-0000-4000-8000-000000000001'
    dbContext.db
      .prepare(
        'INSERT INTO provider_connections (id, provider_id, label, credential_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(connId, 'openai', 'OpenAI Work', 'cred_test_12345678', 'active', now, now)

    // Two KBs
    const kb1 = kbRepo.create({ name: 'Alpha KB', description: 'Primary' })
    const kb2 = kbRepo.create({ name: 'Beta KB', description: 'Secondary' })
    kb1Id = kb1.id
    kb2Id = kb2.id

    // Two Bots
    const bot1 = botRepo.create({
      knowledgeBaseId: kb1Id,
      name: 'Alpha Bot',
      description: 'Bot in KB1',
      systemPrompt: 'System prompt 1',
      providerConnectionId: connId,
      modelId: 'gpt-4o'
    })
    bot1Id = bot1.id

    const bot2 = botRepo.create({
      knowledgeBaseId: kb2Id,
      name: 'Beta Bot',
      description: 'Bot in KB2',
      systemPrompt: 'System prompt 2',
      providerConnectionId: connId,
      modelId: 'gpt-4o'
    })
    bot2Id = bot2.id

    // Setup Mock Windows & WebContents
    mockWebContents1 = createMockWebContents(1)
    mockWebContents2 = createMockWebContents(2)
    defaultMockWebContents = mockWebContents1
    isWindow1Destroyed = false
    isWindow2Destroyed = false

    mockWindow1 = {
      isDestroyed: () => isWindow1Destroyed,
      webContents: mockWebContents1
    }

    mockWindow2 = {
      isDestroyed: () => isWindow2Destroyed,
      webContents: mockWebContents2
    }

    // Activate KB1 for session 1
    activeContext.activateWorkspace(1, kb1Id)
    // Activate KB2 for session 2
    activeContext.activateWorkspace(2, kb2Id)

    // Setup custom stream manager with mock channel factory
    streamManager = new ConversationStreamManager({
      channelFactory: createMockMessageChannel
    })

    // Setup Mock ConversationTurnService
    turnService = {
      sendMessage: vi.fn(),
      retryLastUserMessage: vi.fn(),
      isGenerating: vi.fn().mockReturnValue(false),
      isDeleting: vi.fn().mockReturnValue(false),
      acquireDeletionLock: vi.fn((id: string) => {
        if (turnService.isGenerating(id)) {
          throw new ConversationTurnError(
            'Cannot delete conversation while generation is in progress. Please stop generation first.',
            'CONCURRENT_TURN_ACTIVE'
          )
        }
      }),
      releaseDeletionLock: vi.fn(),
      getActiveTurnCount: vi.fn().mockReturnValue(0)
    } as unknown as ConversationTurnService

    // Register Handlers for Window 1
    registerConversationIpcHandlers({
      getMainWindow: () => mockWindow1,
      conversationManager: convManager,
      turnService,
      streamManager,
      activeContext
    })
  })

  describe('1. Sender & Frame Validation', () => {
    it('rejects an unauthorized sender webContents', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      expect(handler).toBeDefined()

      const unauthorizedSender = createMockWebContents(999)
      const event: IpcSenderEventLike = {
        sender: unauthorizedSender,
        senderFrame: unauthorizedSender.mainFrame
      }

      await expect(handler!(event, { botId: bot1Id, title: 'Test' })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects an unauthorized frame (e.g. child frame / iframe)', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const fakeChildFrame = { url: 'http://localhost:5173/child.html' } as WebFrameMainLike
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: fakeChildFrame
      }

      await expect(handler!(event, { botId: bot1Id, title: 'Test' })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects when main window is destroyed', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      isWindow1Destroyed = true
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(handler!(event, { botId: bot1Id, title: 'Test' })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects when sender URL is untrusted', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const evilContents = createMockWebContents(1)
      ;(evilContents.mainFrame as { url: string }).url = 'https://malicious.evil.com/phish'
      const event: IpcSenderEventLike = {
        sender: evilContents,
        senderFrame: evilContents.mainFrame
      }

      await expect(handler!(event, { botId: bot1Id, title: 'Test' })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })
  })

  describe('2. Session & Knowledge Base Isolation', () => {
    it('rejects payload attempting to inject knowledgeBaseId', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: bot1Id,
          title: 'Malicious KB injection',
          knowledgeBaseId: kb2Id
        })
      ).rejects.toThrow(/INVALID_INPUT/)
    })

    it('rejects payload attempting to inject sessionId', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: bot1Id,
          title: 'Malicious session injection',
          sessionId: 2
        })
      ).rejects.toThrow(/INVALID_INPUT/)
    })

    it('rejects creating a conversation for a Bot belonging to another KB', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // Session 1 is active on KB1, but bot2 belongs to KB2
      await expect(
        handler!(event, {
          botId: bot2Id,
          title: 'Cross-KB Attempt'
        })
      ).rejects.toThrow(/BOT_MISMATCH/)
    })

    it('rejects when session has no active workspace', async () => {
      activeContext.clearActiveWorkspace(1)
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          botId: bot1Id,
          title: 'No Workspace'
        })
      ).rejects.toThrow(/NO_ACTIVE_WORKSPACE/)
    })
  })

  describe('3. Conversation Management Operations', () => {
    it('creates a conversation successfully for an active Bot', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const conv = (await handler!(event, {
        botId: bot1Id,
        title: 'Project Alpha Talk'
      })) as ConversationDto

      expect(conv.id).toBeDefined()
      expect(conv.botId).toBe(bot1Id)
      expect(conv.knowledgeBaseId).toBe(kb1Id)
      expect(conv.title).toBe('Project Alpha Talk')
    })

    it('lists conversations for a Bot', async () => {
      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.LIST)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      // Create conversation
      convManager.createConversation(1, { botId: bot1Id, title: 'Conv A' })

      const list = (await handler!(event, {
        botId: bot1Id
      })) as ConversationDto[]

      expect(list.length).toBeGreaterThanOrEqual(1)
      expect(list.some((c) => c.title === 'Conv A')).toBe(true)
    })

    it('loads messages for a conversation', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Chat Thread' })

      msgRepo.create({
        conversationId: conv.id,
        botId: bot1Id,
        knowledgeBaseId: kb1Id,
        role: 'user',
        content: 'Hello Bot!',
        contentFormat: 'text'
      })

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.GET_MESSAGES)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const messages = (await handler!(event, {
        conversationId: conv.id
      })) as MessageDto[]

      expect(messages.length).toBe(1)
      expect(messages[0].content).toBe('Hello Bot!')
      expect(messages[0].role).toBe('user')
    })

    it('renames a conversation', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Old Name' })

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.RENAME)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const updated = (await handler!(event, {
        conversationId: conv.id,
        title: 'Updated Name'
      })) as ConversationDto

      expect(updated.title).toBe('Updated Name')
    })

    it('rejects renaming an archived conversation', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Archived Conv' })
      dbContext.db
        .prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
        .run(Date.now(), conv.id)

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.RENAME)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          conversationId: conv.id,
          title: 'Should Fail'
        })
      ).rejects.toThrow(/CONVERSATION_ARCHIVED/)
    })

    it('deletes a conversation', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'To Delete' })

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.DELETE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const result = (await handler!(event, {
        conversationId: conv.id
      })) as DeleteConversationResultDto

      expect(result.success).toBe(true)
      expect(result.conversationId).toBe(conv.id)
    })

    it('rejects deletion when generation is active for the conversation (race protection)', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Active Generating' })

      vi.mocked(turnService.isGenerating).mockImplementation((id: string) => id === conv.id)

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.DELETE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(
        handler!(event, {
          conversationId: conv.id
        })
      ).rejects.toThrow(/CONCURRENT_TURN_ACTIVE/)

      const fetched = convManager.listConversations(1, { botId: bot1Id })
      expect(fetched.some((c) => c.id === conv.id)).toBe(true)

      vi.mocked(turnService.isGenerating).mockReturnValue(false)
    })
  })

  describe('4. Streaming IPC Transport (sendMessage & retry)', () => {
    it('successfully streams sendMessage events across transferred MessagePort', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Stream Thread' })
      const requestId = '11111111-1111-4111-8111-111111111111'

      // Mock user and assistant messages
      const userMessage: MessageDto = {
        id: '22222222-2222-4222-8222-222222222222',
        conversationId: conv.id,
        role: 'user',
        content: 'Stream prompt',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: Date.now()
      }

      const assistantMessage: MessageDto = {
        id: '33333333-3333-4333-8333-333333333333',
        conversationId: conv.id,
        role: 'assistant',
        content: 'Assistant answer',
        contentFormat: 'markdown',
        metadata: {
          modelId: 'gpt-4o',
          citations: [
            {
              citationNumber: 1,
              sourceId: '44444444-4444-4444-8444-444444444444',
              chunkId: '55555555-5555-4555-8555-555555555555',
              fileName: 'doc.md',
              fileType: 'md',
              pageNumber: null,
              headingPath: ['Heading 1'],
              chunkIndex: 0
            }
          ]
        },
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        createdAt: Date.now()
      }

      // Setup turnService.sendMessage mock generator
      async function* mockSendTurnStream(): AsyncGenerator<ConversationTurnEvent> {
        yield { type: 'text_delta' as const, textDelta: 'Assistant ' }
        yield { type: 'text_delta' as const, textDelta: 'answer' }
        yield {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          totalTextLength: 16,
          durationMs: 120,
          message: assistantMessage
        }
      }

      const mockTurnStream: ConversationTurnStream = {
        [Symbol.asyncIterator]: mockSendTurnStream,
        getResult: vi.fn().mockResolvedValue({
          userMessage,
          assistantMessage,
          finishReason: 'stop',
          durationMs: 120,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        })
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        mockTurnStream
      )

      // Mock turn stream
      let transferredPort: MockMessagePortMain | null = null
      mockWebContents1.mainFrame.postMessage = vi.fn(
        (channel: string, payload: unknown, transfer?: unknown[]) => {
          if (channel === CONVERSATION_IPC_CHANNELS.STREAM_PORT && transfer && transfer[0]) {
            transferredPort = transfer[0] as MockMessagePortMain
            const listeners = mockRendererListeners.get(CONVERSATION_IPC_CHANNELS.STREAM_PORT) ?? []
            for (const listener of listeners) {
              listener({ ports: [transferredPort] }, payload)
            }
          }
        }
      )

      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
      const startResult = await handler!(event, {
        requestId,
        conversationId: conv.id,
        content: 'Stream prompt',
        contentFormat: 'markdown'
      })

      expect(startResult).toEqual({ started: true })
      expect(mockWebContents1.mainFrame.postMessage).toHaveBeenCalledWith(
        CONVERSATION_IPC_CHANNELS.STREAM_PORT,
        { requestId },
        expect.any(Array)
      )

      // Capture messages received on transferredPort (the renderer end)
      const receivedEvents: PublicConversationTurnEvent[] = []
      transferredPort!.on('message', (ev: { data: unknown }) => {
        receivedEvents.push(ev.data as PublicConversationTurnEvent)
      })
      transferredPort!.start()
      transferredPort!.start()

      // Wait for stream to finish
      await new Promise((r) => setTimeout(r, 50))

      expect(receivedEvents.length).toBe(3)
      expect(receivedEvents[0]).toEqual({ type: 'text_delta', textDelta: 'Assistant ' })
      expect(receivedEvents[1]).toEqual({ type: 'text_delta', textDelta: 'answer' })
      expect(receivedEvents[2].type).toBe('finish')
      if (receivedEvents[2].type === 'finish') {
        expect(receivedEvents[2].finishReason).toBe('stop')
        expect(receivedEvents[2].message.id).toBe(assistantMessage.id)
        expect(receivedEvents[2].userMessage?.id).toBe(userMessage.id)
        expect(receivedEvents[2].message.metadata.citations?.length).toBe(1)
      }
    })

    it('delivers sanitized error across stream port when execution fails', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Error Thread' })
      const requestId = '22222222-2222-4222-8222-222222222222'

      async function* mockErrorStream(): AsyncGenerator<ConversationTurnEvent> {
        yield { type: 'text_delta' as const, textDelta: 'Starting...' }
        yield {
          type: 'error' as const,
          error: {
            code: 'RATE_LIMIT_EXCEEDED' as const,
            message: 'Rate limit hit for key sk-proj-1234567890abcdef at C:\\vault\\key.txt',
            retryable: true
          }
        }
      }

      const mockTurnStream: ConversationTurnStream = {
        [Symbol.asyncIterator]: mockErrorStream,
        getResult: vi.fn().mockRejectedValue(new Error('Turn failed'))
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        mockTurnStream
      )

      let transferredPort: MockMessagePortMain | null = null
      mockWebContents1.mainFrame.postMessage = vi.fn(
        (_channel: string, _payload: unknown, transfer?: unknown[]) => {
          if (transfer && transfer[0]) {
            transferredPort = transfer[0] as MockMessagePortMain
          }
        }
      )

      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
      await handler!(event, {
        requestId,
        conversationId: conv.id,
        content: 'Trigger rate limit'
      })

      const receivedEvents: PublicConversationTurnEvent[] = []
      transferredPort!.on('message', (ev: { data: unknown }) => {
        receivedEvents.push(ev.data as PublicConversationTurnEvent)
      })
      transferredPort!.start()

      await new Promise((r) => setTimeout(r, 50))

      const errorEvent = receivedEvents.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      if (errorEvent && errorEvent.type === 'error') {
        expect(errorEvent.error.code).toBe('RATE_LIMIT_EXCEEDED')
        expect(errorEvent.error.retryable).toBe(true)
        expect(errorEvent.error.message).toContain('[REDACTED_KEY]')
        expect(errorEvent.error.message).not.toContain('sk-proj-')
        expect(errorEvent.error.message).not.toContain('C:\\vault')
      }
    })
  })

  describe('5. Cancellation & Resource Cleanup', () => {
    it('cancels an active generation turn', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Cancel Thread' })
      const requestId = '33333333-3333-4333-8333-333333333333'

      let wasCancelled = false
      async function* mockLongStream(): AsyncGenerator<ConversationTurnEvent> {
        try {
          while (true) {
            yield { type: 'text_delta' as const, textDelta: 'tick ' }
            await new Promise((r) => setTimeout(r, 20))
          }
        } finally {
          wasCancelled = true
        }
      }

      const mockTurnStream: ConversationTurnStream = {
        [Symbol.asyncIterator]: mockLongStream,
        getResult: vi.fn().mockImplementation(() => new Promise(() => {}))
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        mockTurnStream
      )

      const sendHandler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
      await sendHandler!(
        { sender: mockWebContents1, senderFrame: mockWebContents1.mainFrame },
        {
          requestId,
          conversationId: conv.id,
          content: 'Long running prompt'
        }
      )

      expect(streamManager.hasStream(requestId)).toBe(true)

      const cancelHandler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CANCEL_GENERATION)
      const cancelResult = (await cancelHandler!(
        { sender: mockWebContents1, senderFrame: mockWebContents1.mainFrame },
        { requestId }
      )) as { success: boolean }

      expect(cancelResult.success).toBe(true)
      expect(streamManager.hasStream(requestId)).toBe(false)
      await new Promise((r) => setTimeout(r, 40))
      expect(wasCancelled).toBe(true)
    })

    it('rejects attempt by another window to cancel a stream', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Ownership Thread' })
      const requestId = '44444444-4444-4444-8444-444444444444'

      async function* mockStream(): AsyncGenerator<ConversationTurnEvent> {
        while (true) {
          yield { type: 'text_delta' as const, textDelta: 'word ' }
          await new Promise((r) => setTimeout(r, 20))
        }
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        [Symbol.asyncIterator]: mockStream,
        getResult: vi.fn().mockImplementation(() => new Promise(() => {}))
      })

      const sendHandler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
      await sendHandler!(
        { sender: mockWebContents1, senderFrame: mockWebContents1.mainFrame },
        {
          requestId,
          conversationId: conv.id,
          content: 'Owned by window 1'
        }
      )

      // Attempt cancellation from Window 2
      expect(() => {
        streamManager.cancelStream(requestId, mockWindow2)
      }).toThrow(/Unauthorized/)
    })

    it('aborts active streams on window destruction and navigation', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Destruction Thread' })
      const requestId = '55555555-5555-4555-8555-555555555555'

      async function* mockStream(): AsyncGenerator<ConversationTurnEvent> {
        while (true) {
          yield { type: 'text_delta' as const, textDelta: 'alive ' }
          await new Promise((r) => setTimeout(r, 20))
        }
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        [Symbol.asyncIterator]: mockStream,
        getResult: vi.fn().mockImplementation(() => new Promise(() => {}))
      })

      const sendHandler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.SEND_MESSAGE)
      await sendHandler!(
        { sender: mockWebContents1, senderFrame: mockWebContents1.mainFrame },
        {
          requestId,
          conversationId: conv.id,
          content: 'Window death test'
        }
      )

      expect(streamManager.hasStream(requestId)).toBe(true)

      // Emit did-start-navigation
      mockWebContents1.emit('did-start-navigation')
      expect(streamManager.hasStream(requestId)).toBe(false)
    })
  })

  describe('6. Preload Bridge API Contract', () => {
    it('exposes only approved methods on window.api.conversation', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = createConversationApi({} as any)

      expect(typeof api.createConversation).toBe('function')
      expect(typeof api.listConversations).toBe('function')
      expect(typeof api.listMessages).toBe('function')
      expect(typeof api.renameConversation).toBe('function')
      expect(typeof api.deleteConversation).toBe('function')
      expect(typeof api.sendMessage).toBe('function')
      expect(typeof api.retryLastUserMessage).toBe('function')
      expect(typeof api.cancelGeneration).toBe('function')

      // Ensure no raw Electron primitives or repositories are exposed
      // @ts-expect-error verifying no raw internals
      expect(api.ipcRenderer).toBeUndefined()
      // @ts-expect-error verifying no raw internals
      expect(api.db).toBeUndefined()
    })

    it('normalizes IPC error rejections into ConversationBridgeError with code and retryable', () => {
      const rawError = new Error(
        JSON.stringify({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          retryable: true
        })
      )

      const normalized = normalizeConversationBridgeError(rawError)
      expect(normalized).toBeInstanceOf(ConversationBridgeError)
      expect(normalized.code).toBe('RATE_LIMIT_EXCEEDED')
      expect(normalized.retryable).toBe(true)
      expect(normalized.message).toBe('Too many requests')
    })

    it('executes api.sendMessage end-to-end via Preload bridge', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Preload Thread' })
      const requestId = '77777777-7777-4777-8777-777777777777'

      const userMsg: MessageDto = {
        id: '88888888-8888-4888-8888-888888888888',
        conversationId: conv.id,
        role: 'user',
        content: 'Bridge prompt',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: Date.now()
      }

      const assistantMsg: MessageDto = {
        id: '99999999-9999-4999-8999-999999999999',
        conversationId: conv.id,
        role: 'assistant',
        content: 'Bridge response',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        createdAt: Date.now()
      }

      async function* mockSendTurnStream(): AsyncGenerator<ConversationTurnEvent> {
        yield { type: 'text_delta' as const, textDelta: 'Bridge ' }
        yield { type: 'text_delta' as const, textDelta: 'response' }
        yield {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
          totalTextLength: 15,
          durationMs: 80,
          message: assistantMsg
        }
      }

      const mockTurnStream: ConversationTurnStream = {
        [Symbol.asyncIterator]: mockSendTurnStream,
        getResult: vi.fn().mockResolvedValue({
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          finishReason: 'stop',
          durationMs: 80,
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 }
        })
      }

      ;(turnService.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        mockTurnStream
      )

      // Setup mock ipcRenderer object
      const mockIpc = {
        invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
          const handler = mockIpcHandlers.get(channel)
          if (!handler) {
            throw new Error(`No handler registered for channel '${channel}'`)
          }
          const defaultEvent: IpcSenderEventLike = {
            sender: mockWebContents1,
            senderFrame: mockWebContents1.mainFrame
          }
          return handler(defaultEvent, ...args)
        }),
        on: vi.fn((channel: string, listener: IpcListener) => {
          const list = mockRendererListeners.get(channel) ?? []
          list.push(listener)
          mockRendererListeners.set(channel, list)
        }),
        removeListener: vi.fn((channel: string, listener: IpcListener) => {
          const list = mockRendererListeners.get(channel) ?? []
          const idx = list.indexOf(listener)
          if (idx !== -1) {
            list.splice(idx, 1)
          }
        })
      }

      // @ts-expect-error mock ipcRenderer
      const api = createConversationApi(mockIpc)

      const emittedChunks: PublicConversationTurnEvent[] = []
      const result = await api.sendMessage(
        {
          conversationId: conv.id,
          content: 'Bridge prompt',
          requestId
        },
        (event) => {
          emittedChunks.push(event)
        }
      )

      expect(result.assistantMessage.id).toBe(assistantMsg.id)
      expect(result.finishReason).toBe('stop')
      expect(result.userMessage?.id).toBe(userMsg.id)
      expect(emittedChunks.length).toBe(3)
      expect(emittedChunks[0]).toEqual({ type: 'text_delta', textDelta: 'Bridge ' })
      expect(emittedChunks[1]).toEqual({ type: 'text_delta', textDelta: 'response' })
      expect(emittedChunks[2].type).toBe('finish')
    })

    it('executes api.retryLastUserMessage end-to-end via Preload bridge', async () => {
      const conv = convManager.createConversation(1, {
        botId: bot1Id,
        title: 'Preload Retry Thread'
      })
      const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

      const assistantMsg: MessageDto = {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        conversationId: conv.id,
        role: 'assistant',
        content: 'Retried answer',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: Date.now()
      }

      async function* mockRetryTurnStream(): AsyncGenerator<ConversationTurnEvent> {
        yield { type: 'text_delta' as const, textDelta: 'Retried ' }
        yield { type: 'text_delta' as const, textDelta: 'answer' }
        yield {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          totalTextLength: 14,
          durationMs: 95,
          message: assistantMsg
        }
      }

      const mockTurnStream: ConversationTurnStream = {
        [Symbol.asyncIterator]: mockRetryTurnStream,
        getResult: vi.fn().mockResolvedValue({
          assistantMessage: assistantMsg,
          finishReason: 'stop',
          durationMs: 95
        })
      }

      ;(turnService.retryLastUserMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        mockTurnStream
      )

      const mockIpc = {
        invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
          const handler = mockIpcHandlers.get(channel)
          if (!handler) {
            throw new Error(`No handler registered for channel '${channel}'`)
          }
          const defaultEvent: IpcSenderEventLike = {
            sender: mockWebContents1,
            senderFrame: mockWebContents1.mainFrame
          }
          return handler(defaultEvent, ...args)
        }),
        on: vi.fn((channel: string, listener: IpcListener) => {
          const list = mockRendererListeners.get(channel) ?? []
          list.push(listener)
          mockRendererListeners.set(channel, list)
        }),
        removeListener: vi.fn((channel: string, listener: IpcListener) => {
          const list = mockRendererListeners.get(channel) ?? []
          const idx = list.indexOf(listener)
          if (idx !== -1) {
            list.splice(idx, 1)
          }
        })
      }

      // @ts-expect-error mock ipcRenderer
      const api = createConversationApi(mockIpc)

      const emittedChunks: PublicConversationTurnEvent[] = []
      const result = await api.retryLastUserMessage(
        {
          conversationId: conv.id,
          requestId
        },
        (event) => {
          emittedChunks.push(event)
        }
      )

      expect(result.assistantMessage.id).toBe(assistantMsg.id)
      expect(result.finishReason).toBe('stop')
      expect(emittedChunks.length).toBe(3)
    })
  })

  describe('7. Failing Handlers Fallback', () => {
    it('throws CONVERSATION_SUBSYSTEM_FAILED when failing handlers are registered', async () => {
      registerFailingConversationIpcHandlers(
        () => mockWindow1,
        'Subsystem crash at C:\\logs\\err.txt'
      )

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.CREATE)
      const event: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: mockWebContents1.mainFrame
      }

      await expect(handler!(event, { botId: bot1Id, title: 'Crash' })).rejects.toThrow(
        /CONVERSATION_SUBSYSTEM_FAILED/
      )

      try {
        await handler!(event, { botId: bot1Id, title: 'Crash' })
      } catch (err) {
        expect(String(err)).toContain('[REDACTED_PATH]')
        expect(String(err)).not.toContain('C:\\logs')
      }
    })
  })

  describe('8. Error Sanitization Helpers', () => {
    it('redacts API keys, tokens, paths, and credential refs', () => {
      const dirty =
        'Error at C:\\Users\\Administrator\\secret.key with Bearer eyJhbGciOi.secret and sk-proj-1234567890abcdef and cred_00000000-0000-4000-8000-000000000001'
      const clean = sanitizeConversationErrorMessage(dirty)

      expect(clean).toContain('[REDACTED_PATH]')
      expect(clean).toContain('Bearer [REDACTED_TOKEN]')
      expect(clean).toContain('[REDACTED_KEY]')
      expect(clean).toContain('[REDACTED_REF]')
      expect(clean).not.toContain('secret.key')
      expect(clean).not.toContain('sk-proj-')
      expect(clean).not.toContain('cred_00000000')
    })

    it('formats error into valid JSON string with safe code and retryable', () => {
      const err = new Error('Sensitive fail at /var/data/dump.log')
      ;(err as unknown as { code: string; retryable: boolean }).code = 'SERVICE_UNAVAILABLE'
      ;(err as unknown as { code: string; retryable: boolean }).retryable = true

      const formatted = formatConversationIpcError(err)
      const parsed = JSON.parse(formatted.message)

      expect(parsed.code).toBe('SERVICE_UNAVAILABLE')
      expect(parsed.retryable).toBe(true)
      expect(parsed.message).toContain('[REDACTED_PATH]')
    })
  })

  describe('9. Active-Turn Protection & Regression Tests', () => {
    it('synchronously acquires active-turn lock upon sendMessage before lazy iteration', () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Lock Test' })

      const mockExecutionService = {
        executeTurn: vi.fn()
      }
      const mockPersistenceService = {
        persistUserMessage: vi.fn(),
        persistAssistantTurn: vi.fn()
      }
      const mockConversationService = {
        prepareTurn: vi.fn()
      }

      const turnServiceWithLock = new ConversationTurnService({
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        activeWorkspaceContext: activeContext,
        // @ts-expect-error mock services
        executionService: mockExecutionService,
        // @ts-expect-error mock services
        persistenceService: mockPersistenceService,
        // @ts-expect-error mock services
        conversationService: mockConversationService
      })

      expect(turnServiceWithLock.isGenerating(conv.id)).toBe(false)

      // Start turn 1 - returns stream without yet consuming it
      const stream1 = turnServiceWithLock.sendMessage(1, {
        conversationId: conv.id,
        content: 'Turn 1 prompt'
      })

      // Lock MUST be active immediately
      expect(turnServiceWithLock.isGenerating(conv.id)).toBe(true)
      expect(stream1).toBeDefined()

      // Attempting a second simultaneous turn on the same conversation MUST throw CONCURRENT_TURN_ACTIVE immediately
      expect(() => {
        turnServiceWithLock.sendMessage(1, {
          conversationId: conv.id,
          content: 'Turn 2 simultaneous prompt'
        })
      }).toThrow(/already in progress/)

      try {
        turnServiceWithLock.sendMessage(1, {
          conversationId: conv.id,
          content: 'Turn 2 simultaneous prompt'
        })
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe('CONCURRENT_TURN_ACTIVE')
      }
    })
  })

  describe('resolveCitation IPC (Phase 7 Step 7.10)', () => {
    it('successfully invokes resolveCitation over IPC and returns target DTO', async () => {
      const conv = convManager.createConversation(1, { botId: bot1Id, title: 'Citation Test' })

      const mockTarget = {
        citationNumber: 1,
        sourceId: '00000000-0000-4000-8000-000000000010',
        chunkId: '00000000-0000-4000-8000-000000000020',
        knowledgeBaseId: kb1Id,
        fileName: 'architecture.pdf',
        fileType: 'pdf' as const,
        pageNumber: 3,
        headingPath: ['Intro'],
        chunkIndex: 0
      }

      vi.spyOn(convManager, 'resolveCitation').mockReturnValueOnce(mockTarget)

      const mockIpc = {
        invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
          const handler = mockIpcHandlers.get(channel)
          if (!handler) {
            throw new Error(`No handler registered for channel '${channel}'`)
          }
          const defaultEvent: IpcSenderEventLike = {
            sender: mockWebContents1,
            senderFrame: mockWebContents1.mainFrame
          }
          return handler(defaultEvent, ...args)
        }),
        on: vi.fn(),
        removeListener: vi.fn()
      }

      // @ts-expect-error mock ipc
      const preloadApi = createConversationApi(mockIpc)

      const res = await preloadApi.resolveCitation({
        conversationId: conv.id,
        messageId: '00000000-0000-4000-8000-000000000099',
        citationNumber: 1
      })

      expect(res).toEqual(mockTarget)
      expect(convManager.resolveCitation).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          conversationId: conv.id,
          messageId: '00000000-0000-4000-8000-000000000099',
          citationNumber: 1
        })
      )
    })

    it('rejects resolveCitation from untrusted sender frame', async () => {
      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents1,
        senderFrame: {
          url: 'http://malicious-origin.com'
        }
      }

      const handler = mockIpcHandlers.get(CONVERSATION_IPC_CHANNELS.RESOLVE_CITATION)
      expect(handler).toBeDefined()

      await expect(
        handler!(untrustedEvent, {
          conversationId: '00000000-0000-4000-8000-000000000001',
          messageId: '00000000-0000-4000-8000-000000000099',
          citationNumber: 1
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects resolveCitation when schema validation fails (non-positive citationNumber)', async () => {
      const mockIpc = {
        invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
          const handler = mockIpcHandlers.get(channel)
          if (!handler) {
            throw new Error(`No handler registered for channel '${channel}'`)
          }
          const defaultEvent: IpcSenderEventLike = {
            sender: mockWebContents1,
            senderFrame: mockWebContents1.mainFrame
          }
          return handler(defaultEvent, ...args)
        }),
        on: vi.fn(),
        removeListener: vi.fn()
      }

      // @ts-expect-error mock ipc
      const preloadApi = createConversationApi(mockIpc)

      await expect(
        preloadApi.resolveCitation({
          conversationId: '00000000-0000-4000-8000-000000000001',
          messageId: '00000000-0000-4000-8000-000000000099',
          citationNumber: 0
        })
      ).rejects.toThrow()
    })

    it('rejects resolveCitation when subsystem has failed', async () => {
      registerFailingConversationIpcHandlers(() => mockWindow1, 'Database destroyed')

      const mockIpc = {
        invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
          const handler = mockIpcHandlers.get(channel)
          if (!handler) {
            throw new Error(`No handler registered for channel '${channel}'`)
          }
          const defaultEvent: IpcSenderEventLike = {
            sender: mockWebContents1,
            senderFrame: mockWebContents1.mainFrame
          }
          return handler(defaultEvent, ...args)
        }),
        on: vi.fn(),
        removeListener: vi.fn()
      }

      // @ts-expect-error mock ipc
      const preloadApi = createConversationApi(mockIpc)

      await expect(
        preloadApi.resolveCitation({
          conversationId: '00000000-0000-4000-8000-000000000001',
          messageId: '00000000-0000-4000-8000-000000000099',
          citationNumber: 1
        })
      ).rejects.toThrowError(ConversationBridgeError)
    })
  })
})
