// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
  type RenderResult
} from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet, useNavigate } from 'react-router-dom'
import { BotConversationsWorkspacePage } from './BotConversationsWorkspacePage'
import { WorkspaceBotsPage } from './WorkspaceBotsPage'
import type { WorkspaceOutletContext } from '../../components/kb/KnowledgeBaseWorkspaceLayout'
import type { BotDto } from '../../../../shared/bots'
import {
  type BotConversationWorkspaceDto,
  type ClearConversationPreviewDto,
  type ClearConversationResultDto,
  type ConversationDto,
  type ConversationSegmentDto,
  type MessageDto,
  type ConversationTurnResultDto,
  type PublicConversationTurnEvent,
  ConversationBridgeError
} from '../../../../shared/conversations'

function TestBotRouteSwitcher({
  kbId,
  targetBotId,
  label
}: {
  kbId: string
  targetBotId: string
  label: string
}): ReactElement {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      data-testid={`switch-to-${targetBotId}`}
      onClick={() => navigate(`/knowledge-bases/${kbId}/bots/${targetBotId}/conversations`)}
    >
      {label}
    </button>
  )
}

describe('Renderer: BotConversationsWorkspacePage Unified Single Conversation (Phase 12 Step 12.2)', () => {
  const activeKbId = '11111111-1111-4111-8111-111111111111'
  const activeBotId = '22222222-2222-4222-8222-222222222222'
  const secondBotId = '33333333-3333-4333-8333-333333333333'
  const archivedBotId = '44444444-4444-4444-8444-444444444444'

  const sampleActiveBot: BotDto = {
    id: activeBotId,
    knowledgeBaseId: activeKbId,
    name: 'Research Assistant',
    description: 'Specialized in researching local documents',
    systemPrompt: 'You are an intelligent research assistant.',
    providerConnectionId: 'conn-openai-01',
    modelId: 'gpt-6-luna',
    responsePolicy: 'balanced_kb_first',
    enabledTools: ['search_knowledge_base', 'read_knowledge_base_document'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleSecondBot: BotDto = {
    id: secondBotId,
    knowledgeBaseId: activeKbId,
    name: 'Compliance Auditor',
    description: 'Audits regulatory policies',
    systemPrompt: 'You audit compliance.',
    providerConnectionId: 'conn-openai-01',
    modelId: 'gpt-6-luna',
    responsePolicy: 'balanced_kb_first',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000001000,
    updatedAt: 1700000001000
  }

  const sampleArchivedBot: BotDto = {
    id: archivedBotId,
    knowledgeBaseId: activeKbId,
    name: 'Archived Legacy Bot',
    description: 'Archived bot',
    systemPrompt: 'You are archived.',
    providerConnectionId: null,
    modelId: 'claude-sonnet-5-5',
    responsePolicy: 'balanced_kb_first',
    enabledTools: [],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  const canonicalConv1: ConversationDto = {
    id: 'conv-1111-1111-1111-111111111111',
    botId: activeBotId,
    knowledgeBaseId: activeKbId,
    title: 'Research Assistant Workspace',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const canonicalConv2: ConversationDto = {
    id: 'conv-2222-2222-2222-222222222222',
    botId: secondBotId,
    knowledgeBaseId: activeKbId,
    title: 'Compliance Auditor Workspace',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const canonicalArchivedConv: ConversationDto = {
    id: 'conv-3333-3333-3333-333333333333',
    botId: archivedBotId,
    knowledgeBaseId: activeKbId,
    title: 'Archived Legacy Workspace',
    createdAt: 1690000000000,
    updatedAt: 1690000005000,
    archivedAt: null
  }

  const sampleMessage: MessageDto = {
    id: 'msg-01',
    conversationId: canonicalConv1.id,
    role: 'user',
    content: 'Summarize the Q4 expenses.',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000001000
  }

  const secondBotMessage: MessageDto = {
    id: 'msg-bot2-01',
    conversationId: canonicalConv2.id,
    role: 'user',
    content: 'Review compliance checklist.',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000020000
  }

  const archivedBotMessage: MessageDto = {
    id: 'msg-arch-01',
    conversationId: canonicalArchivedConv.id,
    role: 'assistant',
    content: 'Historical archived audit note.',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1690000002000
  }

  let mockBotsList: BotDto[] = []
  let mockConversationsByBot: Map<string, ConversationDto>
  let mockSegmentsByConv: Map<string, ConversationSegmentDto[]>
  let mockMessagesByConv: Map<string, MessageDto[]>
  let mockAgentRunsByConv: Map<string, number>

  beforeEach(() => {
    mockBotsList = [sampleActiveBot, sampleSecondBot, sampleArchivedBot]
    mockConversationsByBot = new Map([
      [activeBotId, canonicalConv1],
      [secondBotId, canonicalConv2],
      [archivedBotId, canonicalArchivedConv]
    ])
    mockSegmentsByConv = new Map([
      [
        canonicalConv1.id,
        [
          {
            id: 'seg-1-0',
            conversationId: canonicalConv1.id,
            originalConversationId: canonicalConv1.id,
            title: canonicalConv1.title,
            segmentOrder: 0,
            firstMessageCreatedAt: null,
            lastMessageCreatedAt: null,
            createdAt: 1700000000000,
            archivedAt: null,
            messageCount: 1
          }
        ]
      ],
      [
        canonicalConv2.id,
        [
          {
            id: 'seg-2-0',
            conversationId: canonicalConv2.id,
            originalConversationId: canonicalConv2.id,
            title: canonicalConv2.title,
            segmentOrder: 0,
            firstMessageCreatedAt: null,
            lastMessageCreatedAt: null,
            createdAt: 1700000010000,
            archivedAt: null,
            messageCount: 1
          }
        ]
      ],
      [
        canonicalArchivedConv.id,
        [
          {
            id: 'seg-3-0',
            conversationId: canonicalArchivedConv.id,
            originalConversationId: canonicalArchivedConv.id,
            title: canonicalArchivedConv.title,
            segmentOrder: 0,
            firstMessageCreatedAt: null,
            lastMessageCreatedAt: null,
            createdAt: 1690000000000,
            archivedAt: null,
            messageCount: 1
          }
        ]
      ]
    ])
    mockMessagesByConv = new Map([
      [canonicalConv1.id, [sampleMessage]],
      [canonicalConv2.id, [secondBotMessage]],
      [canonicalArchivedConv.id, [archivedBotMessage]]
    ])
    mockAgentRunsByConv = new Map([[canonicalConv1.id, 1]])

    window.api = {
      ping: vi.fn(),
      providers: {} as never,
      knowledgeBases: {
        activateWorkspace: vi.fn(async () => ({ success: true })),
        deactivateWorkspace: vi.fn(async () => ({ success: true }))
      } as never,
      knowledgeDocuments: {
        preview: vi.fn(async () => ({
          sourceId: 'src-01',
          knowledgeBaseId: activeKbId,
          originalFileName: 'q4_expenses.pdf',
          fileType: 'pdf',
          fileSize: 1024,
          status: 'completed',
          totalChunks: 1,
          chunks: [
            {
              chunkId: 'chunk-01',
              chunkIndex: 0,
              content: 'Q4 total expenses were 1.2M.',
              tokenCount: 20,
              pageNumber: 2,
              heading: 'Executive Summary',
              headingLevel: 2,
              headingPath: ['Financials', 'Executive Summary']
            }
          ]
        }))
      } as never,
      bots: {
        list: vi.fn(async () => mockBotsList),
        get: vi.fn(async (id: string) => mockBotsList.find((b) => b.id === id) ?? null),
        create: vi.fn(),
        update: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        delete: vi.fn(),
        activateWorkspace: vi.fn(async () => ({ success: true })),
        deactivateWorkspace: vi.fn(async () => ({ success: true }))
      } as never,
      conversation: {
        getConversationForBot: vi.fn(
          async (req: { botId: string } | string): Promise<BotConversationWorkspaceDto> => {
            const bId = typeof req === 'string' ? req : req.botId
            const conv = mockConversationsByBot.get(bId)
            if (!conv) {
              throw new ConversationBridgeError(
                `Canonical conversation for Bot '${bId}' could not be loaded.`,
                'CONVERSATION_NOT_FOUND'
              )
            }
            return {
              conversation: conv,
              segments: mockSegmentsByConv.get(conv.id) ?? [],
              messages: mockMessagesByConv.get(conv.id) ?? []
            }
          }
        ),
        getSegments: vi.fn(async (req: { conversationId: string } | string) => {
          const convId = typeof req === 'string' ? req : req.conversationId
          return mockSegmentsByConv.get(convId) ?? []
        }),
        getClearPreview: vi.fn(
          async (
            req: { conversationId: string } | string
          ): Promise<ClearConversationPreviewDto> => {
            const convId = typeof req === 'string' ? req : req.conversationId
            const conv = Array.from(mockConversationsByBot.values()).find((c) => c.id === convId)
            const bot = mockBotsList.find((b) => b.id === conv?.botId)
            const msgs = mockMessagesByConv.get(convId) ?? []
            const segs = mockSegmentsByConv.get(convId) ?? []
            const runs = mockAgentRunsByConv.get(convId) ?? 0
            return {
              conversationId: convId,
              conversationTitle: conv?.title ?? 'Workspace',
              botId: bot?.id ?? activeBotId,
              botName: bot?.name ?? 'Research Assistant',
              messageCount: msgs.length,
              segmentCount: segs.length,
              agentRunCount: runs,
              toolEventCount: runs > 0 ? 2 : 0,
              isBlocked: false
            }
          }
        ),
        clearConversation: vi.fn(
          async (req: { conversationId: string } | string): Promise<ClearConversationResultDto> => {
            const convId = typeof req === 'string' ? req : req.conversationId
            const conv = Array.from(mockConversationsByBot.values()).find((c) => c.id === convId)!
            const deletedCount = (mockMessagesByConv.get(convId) ?? []).length
            const runs = mockAgentRunsByConv.get(convId) ?? 0
            const updatedConv: ConversationDto = {
              ...conv,
              updatedAt: Date.now()
            }
            const freshSeg: ConversationSegmentDto = {
              id: `seg-fresh-${convId}`,
              conversationId: convId,
              originalConversationId: convId,
              title: conv.title,
              segmentOrder: 0,
              firstMessageCreatedAt: null,
              lastMessageCreatedAt: null,
              createdAt: Date.now(),
              archivedAt: null,
              messageCount: 0
            }
            mockConversationsByBot.set(conv.botId, updatedConv)
            mockMessagesByConv.set(convId, [])
            mockSegmentsByConv.set(convId, [freshSeg])
            return {
              success: true,
              conversation: updatedConv,
              activeSegment: freshSeg,
              deletedMessagesCount: deletedCount,
              preservedAgentRunsCount: runs
            }
          }
        ),
        listConversations: vi.fn(),
        renameConversation: vi.fn(),
        deleteConversation: vi.fn(),
        listMessages: vi.fn(async (req: { conversationId?: string } | string) => {
          const convId = typeof req === 'string' ? req : (req?.conversationId ?? '')
          return mockMessagesByConv.get(convId) ?? []
        }),
        sendMessage: vi.fn(async (req: { conversationId: string; content: string }) => {
          const userMsg: MessageDto = {
            id: `msg-user-${Date.now()}`,
            conversationId: req.conversationId,
            role: 'user',
            content: req.content,
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          }
          const assistMsg: MessageDto = {
            id: `msg-assist-${Date.now()}`,
            conversationId: req.conversationId,
            role: 'assistant',
            content: 'Here is the summary of expenses.',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            createdAt: Date.now() + 1
          }
          const existing = mockMessagesByConv.get(req.conversationId) ?? []
          mockMessagesByConv.set(req.conversationId, [...existing, userMsg, assistMsg])
          return {
            userMessage: userMsg,
            assistantMessage: assistMsg,
            finishReason: 'stop' as const,
            durationMs: 250
          }
        }),
        retryLastUserMessage: vi.fn(),
        cancelGeneration: vi.fn(),
        resolveCitation: vi.fn(async () => ({
          citationNumber: 1,
          sourceId: 'src-01',
          chunkId: 'chunk-01',
          knowledgeBaseId: activeKbId,
          fileName: 'q4_expenses.pdf',
          fileType: 'pdf',
          pageNumber: 2,
          headingPath: ['Financials', 'Executive Summary'],
          chunkIndex: 0
        }))
      } as never,
      agents: {
        dispatchTask: vi.fn(async (req) => ({
          accepted: true,
          agentRunId: 'run-test-01',
          status: 'queued' as const,
          conversationId: req.conversationId,
          botId: req.botId
        })),
        cancelTask: vi.fn(async () => ({ success: true, agentRunId: 'run-test-01' })),
        getRun: vi.fn(),
        listRuns: vi.fn(async () => ({ runs: [], total: 0 })),
        listToolEvents: vi.fn(async () => ({ events: [], total: 0 })),
        getApprovalDetails: vi.fn(),
        respondToApproval: vi.fn(),
        subscribeToTaskEvents: vi.fn(() => () => {})
      } as never,
      botMemories: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        create: vi.fn(async (input) => ({
          id: 'mem-101',
          botId: input.botId,
          knowledgeBaseId: activeKbId,
          memoryType: input.memoryType ?? 'user_note',
          content: input.content,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(async () => 0)
      } as never
    }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function renderPageWithRouter(initialEntry: string, includeSwitchers = false): RenderResult {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        {includeSwitchers && (
          <div>
            <TestBotRouteSwitcher kbId={activeKbId} targetBotId={activeBotId} label="Go Bot 1" />
            <TestBotRouteSwitcher kbId={activeKbId} targetBotId={secondBotId} label="Go Bot 2" />
          </div>
        )}
        <Routes>
          <Route
            path="/knowledge-bases/:kbId"
            element={
              <Outlet
                context={
                  {
                    knowledgeBase: {
                      id: activeKbId,
                      name: 'Finance Vault',
                      description: 'Financial documents',
                      createdAt: 1700000000000,
                      updatedAt: 1700000000000,
                      archivedAt: null
                    },
                    isWorkspaceActivated: true
                  } satisfies WorkspaceOutletContext
                }
              />
            }
          >
            <Route path="bots" element={<WorkspaceBotsPage />} />
            <Route path="bots/:botId/conversations" element={<BotConversationsWorkspacePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  }

  it('1. opens Bot directly into its single canonical persistent conversation with no sidebar or creation controls', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-conversations-title').textContent).toContain(
        'Research Assistant'
      )
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv1.title
      )
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    expect(window.api.conversation?.getConversationForBot).toHaveBeenCalledWith({
      botId: activeBotId
    })
    expect(screen.getByTestId('bot-status-badge').textContent).toContain('Active')
    expect(screen.getByTestId('bot-model').textContent).toContain('gpt-6-luna')
    expect(screen.getByTestId('clear-conversation-btn')).toBeDefined()

    // Multi-conversation UI and creation controls must not exist anywhere in the workspace
    expect(screen.queryByTestId('sidebar-conversations-panel')).toBeNull()
    expect(screen.queryByTestId('create-conversation-btn')).toBeNull()
    expect(screen.queryByTestId('empty-state-new-conv-btn')).toBeNull()
    expect(screen.queryByTestId('no-conversation-selected')).toBeNull()
    expect(screen.queryByText(/New Conversation/i)).toBeNull()
    expect(
      (window.api.conversation as unknown as Record<string, unknown>).createConversation
    ).toBeUndefined()
  })

  it('2. provides return link back to parent Knowledge Base Bots workspace', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('back-to-bots-link')).toBeDefined()
    })

    const backLink = screen.getByTestId('back-to-bots-link')
    expect(backLink.getAttribute('href')).toBe(`/knowledge-bases/${activeKbId}/bots`)
  })

  it('3. rejects invalid UUIDs in route and displays friendly error', async () => {
    renderPageWithRouter(`/knowledge-bases/invalid-kb-uuid/bots/${activeBotId}/conversations`)

    expect(screen.getByTestId('bot-conversations-invalid-route')).toBeDefined()
    expect(screen.getByText(/is not a valid UUID format/i)).toBeDefined()
  })

  it('4. displays error state when Bot does not exist', async () => {
    const missingBotId = '99999999-9999-4999-8999-999999999999'
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${missingBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-not-found-state')).toBeDefined()
    })
    expect(screen.getByText(/does not exist or has been deleted/i)).toBeDefined()
  })

  it('5. opens archived Bot canonical conversation read-only and disables composer & clear action', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${archivedBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-archived-notice')).toBeDefined()
      expect(screen.getByTestId(`message-item-${archivedBotMessage.id}`)).toBeDefined()
    })
    expect(screen.getByTestId('bot-status-badge').textContent).toContain('Archived')
    expect(screen.getByText('Historical archived audit note.')).toBeDefined()

    const input = screen.getByTestId('message-input') as HTMLTextAreaElement
    expect(input.disabled).toBe(true)

    const clearBtn = screen.getByTestId('clear-conversation-btn') as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
  })

  it('6. reopening a Bot loads the exact same canonical persistent conversation ID', async () => {
    const firstRender = renderPageWithRouter(
      `/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`
    )

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv1.title
      )
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    firstRender.unmount()

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)
    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv1.title
      )
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    expect(window.api.conversation?.getConversationForBot).toHaveBeenCalledTimes(2)
  })

  it('7. isolates conversations and prevents stale async responses during rapid Bot switching (A -> B -> A)', async () => {
    let resolveBot1Slow!: (val: BotConversationWorkspaceDto) => void
    const slowBot1Promise = new Promise<BotConversationWorkspaceDto>((res) => {
      resolveBot1Slow = res
    })

    const origImpl = vi
      .mocked(window.api.conversation!.getConversationForBot)
      .getMockImplementation()!
    let firstBot1Call = true
    vi.mocked(window.api.conversation!.getConversationForBot).mockImplementation(async (req) => {
      const bId = typeof req === 'string' ? req : req.botId
      if (bId === activeBotId && firstBot1Call) {
        firstBot1Call = false
        return slowBot1Promise
      }
      return origImpl(req)
    })

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`, true)

    await waitFor(() => {
      expect(window.api.conversation!.getConversationForBot).toHaveBeenCalledWith({
        botId: activeBotId
      })
    })

    // Rapidly switch to Bot 2 before Bot 1 finishes resolving
    fireEvent.click(screen.getByTestId(`switch-to-${secondBotId}`))

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv2.title
      )
      expect(screen.getByText('Review compliance checklist.')).toBeDefined()
    })

    // Now resolve the stale slow Bot 1 response; it MUST NOT overwrite Bot 2's messages/title
    await act(async () => {
      resolveBot1Slow({
        conversation: canonicalConv1,
        segments: mockSegmentsByConv.get(canonicalConv1.id) ?? [],
        messages: [sampleMessage]
      })
      await slowBot1Promise
    })

    expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
      canonicalConv2.title
    )
    expect(screen.getByText('Review compliance checklist.')).toBeDefined()
    expect(screen.queryByText('Summarize the Q4 expenses.')).toBeNull()
  })

  it('8. navigates from WorkspaceBotsPage directly into Bot canonical conversation workspace', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots`)

    await waitFor(() => {
      expect(screen.getByTestId(`bot-card-${activeBotId}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`bot-card-${activeBotId}`))

    await waitFor(() => {
      expect(screen.getByTestId('bot-conversations-title').textContent).toContain(
        'Research Assistant'
      )
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv1.title
      )
    })
  })

  it('9. sends a user message via composer into canonical conversation and clears input', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'What are the main risks?' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(window.api.conversation?.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: canonicalConv1.id,
          content: 'What are the main risks?',
          contentFormat: 'markdown'
        }),
        expect.any(Function)
      )
    })

    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('10. displays streaming bubble and incremental text during active generation', async () => {
    let resolveSend!: (res: ConversationTurnResultDto) => void
    let eventCallback: ((event: unknown) => void) | null = null

    vi.mocked(window.api.conversation!.sendMessage).mockImplementationOnce(
      (_req, onEvent) =>
        new Promise((resolve) => {
          resolveSend = resolve
          eventCallback = onEvent as (event: unknown) => void
        })
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'Explain the budget shortfall' }
    })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('streaming-indicator')).toBeDefined()
    })

    eventCallback!({
      type: 'text_delta',
      textDelta: 'Analyzing document archives...'
    })

    await waitFor(() => {
      expect(screen.getByTestId('streaming-text-preview').textContent).toContain(
        'Analyzing document archives...'
      )
    })

    // Clear Conversation must be disabled during active generation
    expect((screen.getByTestId('clear-conversation-btn') as HTMLButtonElement).disabled).toBe(true)

    resolveSend({
      assistantMessage: {
        id: 'msg-assist-streamed',
        conversationId: canonicalConv1.id,
        role: 'assistant',
        content: 'Analyzing document archives... complete.',
        contentFormat: 'markdown',
        metadata: {},
        tokenUsage: null,
        createdAt: Date.now()
      },
      finishReason: 'stop',
      durationMs: 300
    })

    await waitFor(() => {
      expect(screen.queryByTestId('streaming-indicator')).toBeNull()
      expect(screen.queryByTestId('streaming-text-preview')).toBeNull()
    })
  })

  it('11. displays sanitized turn error alert when generation fails', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockRejectedValueOnce(
      new Error('Provider API failed at C:\\Users\\Secrets\\token.txt')
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Trigger error' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })

    const alertText = screen.getByTestId('turn-error-alert').textContent
    expect(alertText).toContain('Generation Error')
    expect(alertText).toContain('[REDACTED_PATH]')
    expect(alertText).not.toContain('C:\\Users\\Secrets')
  })

  it('12. clears stale turn error alerts and cancellation notices when switching between Bots', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockImplementationOnce(
      async (_req, onEvent) => {
        onEvent?.({
          type: 'error',
          requestId: 'req-1',
          conversationId: canonicalConv1.id,
          executionMode: 'chat',
          sequenceNumber: 1,
          timestamp: 1000,
          stage: 'failed',
          error: { code: 'FAIL', message: 'Stale bot 1 error', retryable: true }
        })
        throw new Error('Stale bot 1 error')
      }
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`, true)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Trigger error' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })

    // Switch to Bot 2 -> stale alert must vanish immediately
    fireEvent.click(screen.getByTestId(`switch-to-${secondBotId}`))

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv2.title
      )
      expect(screen.queryByTestId('turn-error-alert')).toBeNull()
      expect(screen.queryByTestId('cancellation-notice')).toBeNull()
    })
  })

  it('13. clicking citation marker resolves via Main process and opens DocumentPreviewModal', async () => {
    const assistantWithCitation: MessageDto = {
      id: 'msg-assist-cited',
      conversationId: canonicalConv1.id,
      role: 'assistant',
      content: 'As shown in the financial report [1], revenue grew 20%.',
      contentFormat: 'markdown',
      metadata: {
        citations: [
          {
            citationNumber: 1,
            sourceId: 'src-01',
            chunkId: 'chunk-01',
            fileName: 'q4_expenses.pdf',
            fileType: 'pdf',
            pageNumber: 2,
            headingPath: ['Financials', 'Executive Summary'],
            chunkIndex: 0
          }
        ]
      },
      tokenUsage: null,
      createdAt: 1700000002000
    }
    mockMessagesByConv.set(canonicalConv1.id, [sampleMessage, assistantWithCitation])

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('citation-marker-1')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('citation-marker-1'))

    await waitFor(() => {
      expect(window.api.conversation?.resolveCitation).toHaveBeenCalledWith({
        conversationId: canonicalConv1.id,
        messageId: assistantWithCitation.id,
        citationNumber: 1
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('document-preview-modal')).toBeDefined()
      expect(screen.getByTestId('preview-title').textContent).toContain('q4_expenses.pdf')
      expect(screen.getByTestId('chunk-cited-badge')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('btn-close-preview'))
    await waitFor(() => {
      expect(screen.queryByTestId('document-preview-modal')).toBeNull()
    })
  })

  it('14. displays sanitized alert when citation resolution fails', async () => {
    const assistantWithCitation: MessageDto = {
      id: 'msg-assist-cited-fail',
      conversationId: canonicalConv1.id,
      role: 'assistant',
      content: 'Refer to missing report [1].',
      contentFormat: 'markdown',
      metadata: {
        citations: [
          {
            citationNumber: 1,
            sourceId: 'src-01',
            chunkId: 'chunk-01',
            fileName: 'deleted_doc.pdf',
            fileType: 'pdf',
            pageNumber: 1,
            headingPath: null,
            chunkIndex: 0
          }
        ]
      },
      tokenUsage: null,
      createdAt: 1700000003000
    }
    mockMessagesByConv.set(canonicalConv1.id, [sampleMessage, assistantWithCitation])

    vi.mocked(window.api.conversation!.resolveCitation).mockRejectedValueOnce(
      new Error('Cited source at C:\\Secret\\Path does not exist.')
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('citation-marker-1')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('citation-marker-1'))

    await waitFor(() => {
      expect(screen.getByTestId('citation-error-alert')).toBeDefined()
    })

    const alert = screen.getByTestId('citation-error-alert')
    expect(alert.textContent).toContain('[REDACTED_PATH]')
    expect(alert.textContent).not.toContain('C:\\Secret\\Path')
  })

  it('15. stops active generation, clears streaming preview, and shows cancellation notice', async () => {
    let streamCallback: ((evt: PublicConversationTurnEvent) => void) | null = null

    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      streamCallback = onEvent ?? null
      return new Promise(() => {})
    })

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'Generate a long report' }
    })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('stop-generation-btn')).toBeDefined()
    })

    streamCallback!({
      type: 'text_delta',
      requestId: 'req-2',
      conversationId: canonicalConv1.id,
      executionMode: 'chat',
      sequenceNumber: 1,
      timestamp: 1000,
      stage: 'streaming',
      textDelta: 'Partial output that should disappear'
    })

    await waitFor(() => {
      expect(screen.getByTestId('streaming-text-preview')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('stop-generation-btn'))

    await waitFor(() => {
      expect(window.api.conversation!.cancelGeneration).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(screen.queryByTestId('streaming-text-preview')).toBeNull()
    })

    expect(screen.getByTestId('cancellation-notice').textContent).toContain('Generation stopped')
    expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
  })

  it('16. displays Retry button for retryable error and reuses user message without duplicates', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      onEvent?.({
        type: 'error',
        requestId: 'req-3',
        conversationId: canonicalConv1.id,
        executionMode: 'chat',
        sequenceNumber: 1,
        timestamp: 1000,
        stage: 'failed',
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Provider rate limit exceeded. Please retry in a few moments.',
          retryable: true
        }
      })
      throw new ConversationBridgeError(
        'Provider rate limit exceeded. Please retry in a few moments.',
        'RATE_LIMIT_EXCEEDED',
        true
      )
    })

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'Why did this fail?' }
    })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })
    expect(screen.getByTestId('retry-turn-btn')).toBeDefined()

    vi.mocked(window.api.conversation!.retryLastUserMessage).mockImplementation(
      async (_req, onEvent) => {
        onEvent?.({
          type: 'text_delta',
          requestId: 'req-4',
          conversationId: canonicalConv1.id,
          executionMode: 'chat',
          sequenceNumber: 1,
          timestamp: 1000,
          stage: 'streaming',
          textDelta: 'Successfully answered on retry.'
        })
        return {
          assistantMessage: {
            id: 'msg-asst-retry',
            conversationId: canonicalConv1.id,
            role: 'assistant',
            content: 'Successfully answered on retry.',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: null,
            createdAt: Date.now()
          },
          finishReason: 'stop',
          durationMs: 300
        }
      }
    )

    fireEvent.click(screen.getByTestId('retry-turn-btn'))

    await waitFor(() => {
      expect(window.api.conversation!.retryLastUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: canonicalConv1.id
        }),
        expect.any(Function)
      )
    })

    expect(window.api.conversation!.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('17. does not show Retry button when error is non-retryable', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      onEvent?.({
        type: 'error',
        requestId: 'req-5',
        conversationId: canonicalConv1.id,
        executionMode: 'chat',
        sequenceNumber: 1,
        timestamp: 1000,
        stage: 'failed',
        error: {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: 'Context window exceeded.',
          retryable: false
        }
      })
      throw new Error('Context window exceeded')
    })

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Too long prompt' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })

    expect(screen.queryByTestId('retry-turn-btn')).toBeNull()
  })

  it('18. renders consolidated conversation_segments in segmentOrder including empty segments and overlapping timestamps', async () => {
    const segA: ConversationSegmentDto = {
      id: 'seg-a',
      conversationId: canonicalConv1.id,
      originalConversationId: canonicalConv1.id,
      title: 'Initial Consolidated Thread',
      segmentOrder: 0,
      firstMessageCreatedAt: null,
      lastMessageCreatedAt: null,
      createdAt: 1700000000000,
      archivedAt: null,
      messageCount: 1
    }
    const segEmpty: ConversationSegmentDto = {
      id: 'seg-empty',
      conversationId: canonicalConv1.id,
      originalConversationId: canonicalConv1.id,
      title: 'Empty Consolidated Thread',
      segmentOrder: 1,
      firstMessageCreatedAt: null,
      lastMessageCreatedAt: null,
      createdAt: 1700000001000,
      archivedAt: null,
      messageCount: 0
    }
    const segB: ConversationSegmentDto = {
      id: 'seg-b',
      conversationId: canonicalConv1.id,
      originalConversationId: canonicalConv1.id,
      title: 'Second Consolidated Thread',
      segmentOrder: 2,
      firstMessageCreatedAt: null,
      lastMessageCreatedAt: null,
      createdAt: 1700000002000,
      archivedAt: null,
      messageCount: 1
    }

    const msgA: MessageDto = {
      ...sampleMessage,
      id: 'msg-seg-a',
      segmentId: segA.id,
      content: 'Message in segment A (late ts)',
      createdAt: 1700000999000
    }
    const msgB: MessageDto = {
      ...sampleMessage,
      id: 'msg-seg-b',
      segmentId: segB.id,
      content: 'Message in segment B (early ts)',
      createdAt: 1700000005000
    }

    mockSegmentsByConv.set(canonicalConv1.id, [segB, segEmpty, segA])
    mockMessagesByConv.set(canonicalConv1.id, [msgB, msgA])

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('conversation-segment-header-seg-a')).toBeDefined()
      expect(screen.getByTestId('conversation-segment-empty-seg-empty')).toBeDefined()
      expect(screen.getByTestId('conversation-segment-header-seg-b')).toBeDefined()
    })

    expect(screen.getByTestId('messages-count').textContent).toContain(
      '2 message(s) across 3 threads'
    )
    const listHtml = screen.getByTestId('messages-container').innerHTML
    expect(listHtml.indexOf('msg-seg-a')).toBeLessThan(
      listHtml.indexOf('conversation-segment-empty-seg-empty')
    )
    expect(listHtml.indexOf('conversation-segment-empty-seg-empty')).toBeLessThan(
      listHtml.indexOf('msg-seg-b')
    )
  })

  it('19. Clear Conversation cancels cleanly, and on confirm clears messages while retaining canonical ID and usability', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    // Open dialog & cancel -> history untouched
    fireEvent.click(screen.getByTestId('clear-conversation-btn'))
    expect(screen.getByTestId('clear-conversation-dialog')).toBeDefined()
    expect(screen.getByText(/Preserved Workspace & Audit Data/i)).toBeDefined()

    fireEvent.click(screen.getByTestId('cancel-clear-btn'))
    expect(screen.queryByTestId('clear-conversation-dialog')).toBeNull()
    expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()

    // Reopen dialog & confirm
    fireEvent.click(screen.getByTestId('clear-conversation-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('clear-preview-summary')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('confirm-clear-btn'))

    await waitFor(() => {
      expect(window.api.conversation?.clearConversation).toHaveBeenCalledWith({
        conversationId: canonicalConv1.id
      })
      expect(screen.queryByTestId(`message-item-${sampleMessage.id}`)).toBeNull()
      expect(screen.getByTestId('messages-empty')).toBeDefined()
    })

    // User can immediately chat again using the SAME canonical conversation ID
    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'Fresh question after clear' }
    })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(window.api.conversation?.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: canonicalConv1.id,
          content: 'Fresh question after clear'
        }),
        expect.any(Function)
      )
    })
  })

  it('20. displays recoverable error alert without creating conversation when canonical conversation load fails', async () => {
    vi.mocked(window.api.conversation!.getConversationForBot).mockRejectedValueOnce(
      new ConversationBridgeError(
        'Canonical conversation could not be loaded for this Bot.',
        'CONVERSATION_NOT_FOUND'
      )
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('conversation-error-alert')).toBeDefined()
    })
    expect(screen.getByTestId('retry-load-conversation-btn')).toBeDefined()
    expect(
      (window.api.conversation as unknown as Record<string, unknown>).createConversation
    ).toBeUndefined()

    // Clicking Retry invokes getConversationForBot again and recovers
    fireEvent.click(screen.getByTestId('retry-load-conversation-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        canonicalConv1.title
      )
    })
  })

  it('21. dispatches agent task explicitly into canonical conversation without triggering normal chat sendMessage', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('composer-mode-agent-btn')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))
    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'Audit fiscal contracts' }
    })
    fireEvent.click(screen.getByTestId('dispatch-task-btn'))

    await waitFor(() => {
      expect(window.api.agents!.dispatchTask).toHaveBeenCalledWith({
        botId: activeBotId,
        conversationId: canonicalConv1.id,
        taskPrompt: 'Audit fiscal contracts',
        workspaceAccessRequested: false
      })
      expect(window.api.conversation!.sendMessage).not.toHaveBeenCalled()
    })
  })

  it('22. renders active task activity timeline and disables Clear Conversation while Agent Task is running', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('composer-mode-agent-btn')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Run task' } })
    fireEvent.click(screen.getByTestId('dispatch-task-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('active-task-timeline-container')).toBeDefined()
      expect(screen.getByTestId('task-timeline-run-test-01')).toBeDefined()
      expect((screen.getByTestId('clear-conversation-btn') as HTMLButtonElement).disabled).toBe(
        true
      )
    })
  })

  it('23. renders distinct workspace file evidence and collapsible task activity on assistant message', async () => {
    const taskMessage: MessageDto = {
      id: 'msg-task-result',
      conversationId: canonicalConv1.id,
      role: 'assistant',
      content: 'I examined the workspace files and summarized the contracts.',
      contentFormat: 'markdown',
      metadata: {
        agentRunId: 'run-test-01',
        citations: [
          {
            citationNumber: 1,
            sourceId: 'src-01',
            chunkId: 'chunk-01',
            fileName: 'q4_expenses.pdf',
            fileType: 'pdf',
            pageNumber: 2,
            headingPath: ['Legal'],
            chunkIndex: 0
          }
        ],
        toolCalls: [
          {
            id: 'tc-01',
            toolName: 'read_workspace_file',
            status: 'completed',
            argumentsSummary: '{"targetPath":"contracts/sla.md"}',
            resultSummary: 'Read 25 lines.'
          }
        ]
      },
      tokenUsage: null,
      createdAt: 1700000020000
    }

    mockMessagesByConv.set(canonicalConv1.id, [sampleMessage, taskMessage])

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${taskMessage.id}`)).toBeDefined()
    })

    expect(screen.getByTestId(`citations-list-${taskMessage.id}`)).toBeDefined()
    expect(screen.getByTestId(`workspace-evidence-${taskMessage.id}`)).toBeDefined()
    expect(screen.getByText('contracts/sla.md')).toBeDefined()

    const toggleBtn = screen.getByTestId(`toggle-task-activity-${taskMessage.id}`)
    fireEvent.click(toggleBtn)

    expect(screen.getByTestId(`task-activity-list-${taskMessage.id}`)).toBeDefined()
    expect(screen.getByText('Read Workspace File')).toBeDefined()
  })

  it('24. toggles between Chat and Memories views in the workspace', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('tab-view-chat')).toBeDefined()
      expect(screen.getByTestId('tab-view-memories')).toBeDefined()
    })

    expect(screen.getByTestId('tab-view-chat').getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('bot-memories-view-container')).toBeNull()

    fireEvent.click(screen.getByTestId('tab-view-memories'))

    await waitFor(() => {
      expect(screen.getByTestId('bot-memories-view-container')).toBeDefined()
      expect(screen.getByTestId('bot-memory-section')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('tab-view-chat'))

    await waitFor(() => {
      expect(screen.queryByTestId('bot-memories-view-container')).toBeNull()
      expect(screen.getByTestId('bot-conversations-layout')).toBeDefined()
    })
  })

  it('25. opens TaskSummaryMemoryProposalModal from assistant message save action and saves memory', async () => {
    const assistantMessage: MessageDto = {
      id: 'msg-assist-finding',
      conversationId: canonicalConv1.id,
      role: 'assistant',
      content: 'Key finding: Q4 gross margins improved to 68%.',
      contentFormat: 'markdown',
      metadata: {},
      tokenUsage: null,
      createdAt: 1700000010000
    }

    mockMessagesByConv.set(canonicalConv1.id, [sampleMessage, assistantMessage])

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${assistantMessage.id}`)).toBeDefined()
      expect(screen.getByTestId(`save-memory-btn-${assistantMessage.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`save-memory-btn-${assistantMessage.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('task-summary-memory-modal')).toBeDefined()
    })

    const textarea = screen.getByTestId('textarea-task-summary-content') as HTMLTextAreaElement
    expect(textarea.value).toBe('Key finding: Q4 gross margins improved to 68%.')

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-save-task-summary'))
    })

    expect(window.api.botMemories!.create).toHaveBeenCalledWith({
      botId: activeBotId,
      memoryType: 'user_note',
      content: 'Key finding: Q4 gross margins improved to 68%.'
    })

    await waitFor(() => {
      expect(screen.getByTestId('memory-save-success-notification')).toBeDefined()
    })
  })

  it('26. displays persisted Bot responsePolicy label in conversation header and updates when Bot policy changes', async () => {
    // 1. Default Balanced policy loaded from Bot API
    const { unmount } = renderPageWithRouter(
      `/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`
    )
    await waitFor(() => {
      expect(screen.getByTestId('bot-response-policy').textContent).toBe(
        'Knowledge Base First (Balanced)'
      )
    })
    unmount()

    // 2. Updated to Strict Knowledge Base Only
    vi.mocked(window.api.bots!.get).mockResolvedValueOnce({
      ...sampleActiveBot,
      responsePolicy: 'strict_kb_only'
    })
    const strictRender = renderPageWithRouter(
      `/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`
    )
    await waitFor(() => {
      expect(screen.getByTestId('bot-response-policy').textContent).toBe(
        'Strict Knowledge Base Only'
      )
    })
    strictRender.unmount()

    // 3. Updated to General AI Chat
    vi.mocked(window.api.bots!.get).mockResolvedValueOnce({
      ...sampleActiveBot,
      responsePolicy: 'general_ai_chat'
    })
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)
    await waitFor(() => {
      expect(screen.getByTestId('bot-response-policy').textContent).toBe('General AI Chat')
    })
  })
})
