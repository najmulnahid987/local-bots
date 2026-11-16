// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  type RenderResult
} from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { BotConversationsWorkspacePage } from './BotConversationsWorkspacePage'
import { WorkspaceBotsPage } from './WorkspaceBotsPage'
import type { WorkspaceOutletContext } from '../../components/kb/KnowledgeBaseWorkspaceLayout'
import type { BotDto } from '../../../../shared/bots'
import {
  type ConversationDto,
  type MessageDto,
  type ConversationTurnResultDto,
  type PublicConversationTurnEvent,
  ConversationBridgeError
} from '../../../../shared/conversations'

describe('Renderer: BotConversationsWorkspacePage & Navigation (Phase 7 Step 7.8)', () => {
  const activeKbId = '11111111-1111-4111-8111-111111111111'
  const activeBotId = '22222222-2222-4222-8222-222222222222'
  const otherBotId = '33333333-3333-4333-8333-333333333333'

  const sampleActiveBot: BotDto = {
    id: activeBotId,
    knowledgeBaseId: activeKbId,
    name: 'Research Assistant',
    description: 'Specialized in researching local documents',
    systemPrompt: 'You are an intelligent research assistant.',
    providerConnectionId: 'conn-openai-01',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base', 'read_knowledge_base_document'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleArchivedBot: BotDto = {
    id: otherBotId,
    knowledgeBaseId: activeKbId,
    name: 'Archived Legacy Bot',
    description: 'Archived bot',
    systemPrompt: 'You are archived.',
    providerConnectionId: null,
    modelId: 'claude-sonnet-5-5',
    enabledTools: [],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  const sampleConv1: ConversationDto = {
    id: 'conv-1111-1111-1111-111111111111',
    botId: activeBotId,
    knowledgeBaseId: activeKbId,
    title: 'Q4 Budget Analysis',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const sampleConv2: ConversationDto = {
    id: 'conv-2222-2222-2222-222222222222',
    botId: activeBotId,
    knowledgeBaseId: activeKbId,
    title: 'Legal Risk Review',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const sampleMessage: MessageDto = {
    id: 'msg-01',
    conversationId: sampleConv1.id,
    role: 'user',
    content: 'Summarize the Q4 expenses.',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000001000
  }

  let mockBotsList: BotDto[] = []
  let mockConversationsList: ConversationDto[] = []
  let mockMessagesList: MessageDto[] = []

  beforeEach(() => {
    mockBotsList = [sampleActiveBot, sampleArchivedBot]
    mockConversationsList = [sampleConv1, sampleConv2]
    mockMessagesList = [sampleMessage]

    // Setup window.api mock
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
        listConversations: vi.fn(async (req: { botId?: string }) =>
          mockConversationsList.filter((c) => (req.botId ? c.botId === req.botId : true))
        ),
        createConversation: vi.fn(async (req: { botId: string; title?: string }) => {
          const created: ConversationDto = {
            id: 'conv-new-test',
            botId: req.botId,
            knowledgeBaseId: activeKbId,
            title: req.title ?? 'New Conversation',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null
          }
          mockConversationsList = [created, ...mockConversationsList]
          return created
        }),
        renameConversation: vi.fn(async (req: { conversationId: string; title: string }) => {
          const target = mockConversationsList.find((c) => c.id === req.conversationId)
          if (!target) throw new Error('Not found')
          const updated = { ...target, title: req.title }
          mockConversationsList = mockConversationsList.map((c) =>
            c.id === updated.id ? updated : c
          )
          return updated
        }),
        deleteConversation: vi.fn(async (req: { conversationId: string }) => {
          mockConversationsList = mockConversationsList.filter((c) => c.id !== req.conversationId)
          return { success: true, conversationId: req.conversationId }
        }),
        listMessages: vi.fn(async (req: { conversationId?: string } | string) => {
          const convId = typeof req === 'string' ? req : req?.conversationId
          return mockMessagesList.filter((m) => m.conversationId === convId)
        }),
        sendMessage: vi.fn(async () => ({
          assistantMessage: {
            id: 'msg-assist-01',
            conversationId: sampleConv1.id,
            role: 'assistant',
            content: 'Here is the summary of expenses.',
            contentFormat: 'markdown',
            metadata: {},
            tokenUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            createdAt: Date.now()
          },
          finishReason: 'stop',
          durationMs: 250
        })),
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
      } as never
    }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function renderPageWithRouter(initialEntry: string): RenderResult {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
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

  it('1. renders Bot conversation workspace with bot details and conversations list', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-conversations-title').textContent).toContain(
        'Research Assistant'
      )
    })

    expect(screen.getByTestId('bot-status-badge').textContent).toContain('Active')
    expect(screen.getByTestId('bot-model').textContent).toContain('gpt-6-luna')
    expect(screen.getByTestId('back-to-bots-link')).toBeDefined()

    // Verify conversation list items loaded
    await waitFor(() => {
      expect(screen.getByTestId(`conversation-title-${sampleConv1.id}`).textContent).toContain(
        'Q4 Budget Analysis'
      )
      expect(screen.getByTestId(`conversation-title-${sampleConv2.id}`).textContent).toContain(
        'Legal Risk Review'
      )
    })
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

  it('5. displays archived notice when Bot is archived', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${otherBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-archived-notice')).toBeDefined()
    })
    expect(screen.getByTestId('bot-status-badge').textContent).toContain('Archived')
  })

  it('6. selects conversation and loads message history', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })

    // Initially no conversation selected
    expect(screen.getByTestId('no-conversation-selected')).toBeDefined()

    // Click on conversation 1
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        'Q4 Budget Analysis'
      )
    })

    // Message list should load
    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
      expect(screen.getByText('Summarize the Q4 expenses.')).toBeDefined()
    })
  })

  it('7. creates a new conversation from inline form and auto-selects it', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('create-conversation-btn')).toBeDefined()
    })

    // Click "New" button
    fireEvent.click(screen.getByTestId('create-conversation-btn'))

    expect(screen.getByTestId('inline-create-form')).toBeDefined()
    const input = screen.getByTestId('new-conversation-title-input')
    fireEvent.change(input, { target: { value: 'Strategy Session 2027' } })

    // Click "Create"
    fireEvent.click(screen.getByTestId('confirm-create-btn'))

    await waitFor(() => {
      expect(window.api.conversation?.createConversation).toHaveBeenCalledWith({
        botId: activeBotId,
        title: 'Strategy Session 2027'
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('selected-conversation-title').textContent).toContain(
        'Strategy Session 2027'
      )
    })
  })

  it('8. navigates from WorkspaceBotsPage to Bot conversation page when clicking active bot', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots`)

    await waitFor(() => {
      expect(screen.getByTestId(`bot-card-${activeBotId}`)).toBeDefined()
    })

    // Click active bot card to navigate
    fireEvent.click(screen.getByTestId(`bot-card-${activeBotId}`))

    await waitFor(() => {
      expect(screen.getByTestId('bot-conversations-title').textContent).toContain(
        'Research Assistant'
      )
    })
  })

  it('9. sends a user message via composer and clears input upon success', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })

    // Select conversation
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'What are the main risks?' } })
    expect(input.value).toBe('What are the main risks?')

    const sendBtn = screen.getByTestId('send-message-btn')
    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(window.api.conversation?.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: sampleConv1.id,
          content: 'What are the main risks?',
          contentFormat: 'markdown'
        }),
        expect.any(Function)
      )
    })

    // Input should be cleared after successful send
    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('10. displays streaming bubble and incremental text during active generation', async () => {
    let resolveSend!: (res: ConversationTurnResultDto) => void
    let eventCallback: ((event: unknown) => void) | null = null

    // Mock sendMessage to stay pending until we trigger it, capturing event callback
    vi.mocked(window.api.conversation!.sendMessage).mockImplementationOnce(
      (_req, onEvent) =>
        new Promise((resolve) => {
          resolveSend = resolve
          eventCallback = onEvent as (event: unknown) => void
        })
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input')
    fireEvent.change(input, { target: { value: 'Explain the budget shortfall' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    // Verify generation state has started (thinking indicator)
    await waitFor(() => {
      expect(screen.getByTestId('streaming-indicator')).toBeDefined()
    })

    // Simulate streaming delta event
    eventCallback!({
      type: 'text_delta',
      textDelta: 'Analyzing document archives...'
    })

    await waitFor(() => {
      expect(screen.getByTestId('streaming-text-preview').textContent).toContain(
        'Analyzing document archives...'
      )
    })

    // Complete generation
    resolveSend({
      assistantMessage: {
        id: 'msg-assist-streamed',
        conversationId: sampleConv1.id,
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

    // Streaming indicators should be removed after generation finishes
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
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input')
    fireEvent.change(input, { target: { value: 'Trigger error' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })

    const alertText = screen.getByTestId('turn-error-alert').textContent
    expect(alertText).toContain('Generation Error')
    expect(alertText).toContain('[REDACTED_PATH]')
    expect(alertText).not.toContain('C:\\Users\\Secrets')
  })

  it('12. isolates message history when switching between conversations', async () => {
    const conv2Message: MessageDto = {
      id: 'msg-conv2-01',
      conversationId: sampleConv2.id,
      role: 'user',
      content: 'Review compliance checklist.',
      contentFormat: 'markdown',
      metadata: {},
      tokenUsage: null,
      createdAt: 1700000020000
    }
    mockMessagesList = [sampleMessage, conv2Message]

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    // Select conv 1
    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByText('Summarize the Q4 expenses.')).toBeDefined()
    })
    expect(screen.queryByText('Review compliance checklist.')).toBeNull()

    // Switch to conv 2
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv2.id}`))

    await waitFor(() => {
      expect(screen.getByText('Review compliance checklist.')).toBeDefined()
    })
    expect(screen.queryByText('Summarize the Q4 expenses.')).toBeNull()
  })

  it('13. disables composer and creation for archived bot', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${otherBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId('bot-archived-notice')).toBeDefined()
    })

    // "New" conversation button in sidebar should be disabled
    const newBtn = screen.getByTestId('create-conversation-btn')
    expect(newBtn.hasAttribute('disabled')).toBe(true)

    // Empty state displays archived message
    expect(screen.getAllByText(/Bot is archived/i).length).toBeGreaterThanOrEqual(1)
  })

  it('14. clicking citation marker resolves via Main process and opens DocumentPreviewModal', async () => {
    const assistantWithCitation: MessageDto = {
      id: 'msg-assist-cited',
      conversationId: sampleConv1.id,
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
    mockMessagesList = [sampleMessage, assistantWithCitation]

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    // Wait for citation button to render
    await waitFor(() => {
      expect(screen.getByTestId('citation-marker-1')).toBeDefined()
    })

    // Click the citation marker [1]
    fireEvent.click(screen.getByTestId('citation-marker-1'))

    await waitFor(() => {
      expect(window.api.conversation?.resolveCitation).toHaveBeenCalledWith({
        conversationId: sampleConv1.id,
        messageId: assistantWithCitation.id,
        citationNumber: 1
      })
    })

    // Document preview modal should open
    await waitFor(() => {
      expect(screen.getByTestId('document-preview-modal')).toBeDefined()
      expect(screen.getByTestId('preview-title').textContent).toContain('q4_expenses.pdf')
      expect(screen.getByTestId('chunk-cited-badge')).toBeDefined()
    })

    // Dismiss preview modal
    fireEvent.click(screen.getByTestId('btn-close-preview'))
    await waitFor(() => {
      expect(screen.queryByTestId('document-preview-modal')).toBeNull()
    })
  })

  it('15. displays sanitized alert when citation resolution fails', async () => {
    const assistantWithCitation: MessageDto = {
      id: 'msg-assist-cited-fail',
      conversationId: sampleConv1.id,
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
    mockMessagesList = [sampleMessage, assistantWithCitation]

    vi.mocked(window.api.conversation!.resolveCitation).mockRejectedValueOnce(
      new Error('Cited source at C:\\Secret\\Path does not exist.')
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

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

  it('16. renames conversation in workspace and preserves message history', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    const renameBtn = screen.getByTestId(`rename-conversation-btn-${sampleConv1.id}`)
    fireEvent.click(renameBtn)

    const input = screen.getByTestId(`rename-input-${sampleConv1.id}`)
    fireEvent.change(input, { target: { value: 'Renamed Q4 Analysis' } })
    fireEvent.click(screen.getByTestId(`save-rename-btn-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-title-${sampleConv1.id}`).textContent).toBe(
        'Renamed Q4 Analysis'
      )
    })

    expect(screen.getByTestId('selected-conversation-title').textContent).toBe(
      'Renamed Q4 Analysis'
    )
    expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
  })

  it('17. displays sanitized error when renaming fails', async () => {
    vi.mocked(window.api.conversation!.renameConversation).mockRejectedValueOnce(
      new Error('Failed at C:\\Confidential\\path.db')
    )

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`rename-conversation-btn-${sampleConv1.id}`))
    const input = screen.getByTestId(`rename-input-${sampleConv1.id}`)
    fireEvent.change(input, { target: { value: 'New Bad Title' } })
    fireEvent.click(screen.getByTestId(`save-rename-btn-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`rename-error-${sampleConv1.id}`)).toBeDefined()
    })

    const err = screen.getByTestId(`rename-error-${sampleConv1.id}`)
    expect(err.textContent).toContain('[REDACTED_PATH]')
    expect(err.textContent).not.toContain('C:\\Confidential\\path.db')
  })

  it('18. deletes selected conversation, clears messages, and shows empty state', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`delete-conversation-btn-${sampleConv1.id}`))

    expect(screen.getByTestId('delete-conversation-dialog')).toBeDefined()
    expect(screen.getByTestId('delete-conversation-target-title').textContent).toBe(
      sampleConv1.title
    )

    fireEvent.click(screen.getByTestId('confirm-delete-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId(`conversation-item-${sampleConv1.id}`)).toBeNull()
    })

    expect(screen.getByTestId('no-conversation-selected')).toBeDefined()
    expect(screen.queryByTestId(`message-item-${sampleMessage.id}`)).toBeNull()
  })

  it('19. deleting another conversation preserves currently selected conversation', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`delete-conversation-btn-${sampleConv2.id}`))
    expect(screen.getByTestId('delete-conversation-dialog')).toBeDefined()
    fireEvent.click(screen.getByTestId('confirm-delete-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId(`conversation-item-${sampleConv2.id}`)).toBeNull()
    })

    expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    expect(screen.getByTestId('selected-conversation-title').textContent).toBe(sampleConv1.title)
    expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
  })

  it('20. stops active generation, clears streaming preview, and shows cancellation notice', async () => {
    let streamCallback: ((evt: PublicConversationTurnEvent) => void) | null = null

    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      streamCallback = onEvent ?? null
      return new Promise(() => {})
    })

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input')
    fireEvent.change(input, { target: { value: 'Generate a long report' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('stop-generation-btn')).toBeDefined()
    })

    streamCallback!({
      type: 'text_delta',
      textDelta: 'Partial output that should disappear'
    })

    await waitFor(() => {
      expect(screen.getByTestId('streaming-text-preview')).toBeDefined()
    })
    expect(screen.getByText('Partial output that should disappear')).toBeDefined()

    fireEvent.click(screen.getByTestId('stop-generation-btn'))

    await waitFor(() => {
      expect(window.api.conversation!.cancelGeneration).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(screen.queryByTestId('streaming-text-preview')).toBeNull()
    })

    expect(screen.getByTestId('cancellation-notice')).toBeDefined()
    expect(screen.getByTestId('cancellation-notice').textContent).toContain('Generation stopped')
    expect(screen.getByTestId(`message-item-${sampleMessage.id}`)).toBeDefined()
  })

  it('21. displays Retry button for retryable error, reuses user message without duplicates', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      onEvent?.({
        type: 'error',
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
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })

    const input = screen.getByTestId('message-input')
    fireEvent.change(input, { target: { value: 'Why did this fail?' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })
    expect(screen.getByTestId('retry-turn-btn')).toBeDefined()

    vi.mocked(window.api.conversation!.retryLastUserMessage).mockImplementation(
      async (_req, onEvent) => {
        onEvent?.({
          type: 'text_delta',
          textDelta: 'Successfully answered on retry.'
        })
        return {
          assistantMessage: {
            id: 'msg-asst-retry',
            conversationId: sampleConv1.id,
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
          conversationId: sampleConv1.id
        }),
        expect.any(Function)
      )
    })

    expect(window.api.conversation!.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('22. does not show Retry button when error is non-retryable', async () => {
    vi.mocked(window.api.conversation!.sendMessage).mockImplementation(async (_req, onEvent) => {
      onEvent?.({
        type: 'error',
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
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

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

  it('23. switching conversations clears stale error alerts and cancellation notices', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    vi.mocked(window.api.conversation!.sendMessage).mockImplementationOnce(
      async (_req, onEvent) => {
        onEvent?.({
          type: 'error',
          error: { code: 'FAIL', message: 'Stale error', retryable: true }
        })
        throw new Error('Stale error')
      }
    )

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeDefined()
    })
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Trigger error' } })
    fireEvent.click(screen.getByTestId('send-message-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('turn-error-alert')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv2.id}`))

    await waitFor(() => {
      expect(screen.queryByTestId('turn-error-alert')).toBeNull()
      expect(screen.queryByTestId('cancellation-notice')).toBeNull()
    })
  })

  it('24. dispatches agent task explicitly without triggering normal chat sendMessage', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('composer-mode-agent-btn')).toBeDefined()
    })

    // Switch to agent task mode
    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))

    const input = screen.getByTestId('message-input')
    fireEvent.change(input, { target: { value: 'Audit fiscal contracts' } })

    const dispatchBtn = screen.getByTestId('dispatch-task-btn')
    fireEvent.click(dispatchBtn)

    await waitFor(() => {
      expect(window.api.agents!.dispatchTask).toHaveBeenCalledWith({
        botId: activeBotId,
        conversationId: sampleConv1.id,
        taskPrompt: 'Audit fiscal contracts',
        workspaceAccessRequested: false
      })
      expect(window.api.conversation!.sendMessage).not.toHaveBeenCalled()
    })
  })

  it('25. renders active task activity timeline when an agent task is running', async () => {
    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId('composer-mode-agent-btn')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'Run task' } })
    fireEvent.click(screen.getByTestId('dispatch-task-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('active-task-timeline-container')).toBeDefined()
      expect(screen.getByTestId('task-timeline-run-test-01')).toBeDefined()
    })
  })

  it('26. renders distinct workspace file evidence and collapsible task activity on assistant message', async () => {
    const taskMessage: MessageDto = {
      id: 'msg-task-result',
      conversationId: sampleConv1.id,
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

    mockMessagesList = [sampleMessage, taskMessage]

    renderPageWithRouter(`/knowledge-bases/${activeKbId}/bots/${activeBotId}/conversations`)

    await waitFor(() => {
      expect(screen.getByTestId(`conversation-item-${sampleConv1.id}`)).toBeDefined()
    })
    fireEvent.click(screen.getByTestId(`conversation-item-${sampleConv1.id}`))

    await waitFor(() => {
      expect(screen.getByTestId(`message-item-${taskMessage.id}`)).toBeDefined()
    })

    // Knowledge base citations rendered
    expect(screen.getByTestId(`citations-list-${taskMessage.id}`)).toBeDefined()

    // Workspace evidence rendered distinctly
    expect(screen.getByTestId(`workspace-evidence-${taskMessage.id}`)).toBeDefined()
    expect(screen.getByText('contracts/sla.md')).toBeDefined()

    // Collapsible task activity rendered
    const toggleBtn = screen.getByTestId(`toggle-task-activity-${taskMessage.id}`)
    expect(toggleBtn).toBeDefined()

    // Click to expand tool execution cards
    fireEvent.click(toggleBtn)

    expect(screen.getByTestId(`task-activity-list-${taskMessage.id}`)).toBeDefined()
    expect(screen.getByText('Read Workspace File')).toBeDefined()
  })
})
