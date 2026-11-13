// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ConversationMessage } from './ConversationMessage'
import { ConversationComposer } from './ConversationComposer'
import { ConversationMessageList } from './ConversationMessageList'
import { ConversationSidebar } from './ConversationSidebar'
import { ConversationEmptyState } from './ConversationEmptyState'
import type { MessageDto, ConversationDto } from '../../../../shared/conversations'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: Chat Presentation Components (Phase 7 Step 7.9)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleBot: BotDto = {
    id: 'bot-1111-2222',
    knowledgeBaseId: 'kb-01',
    name: 'Research Bot',
    description: 'Research assistant',
    systemPrompt: 'You are helpful',
    providerConnectionId: 'conn-01',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const userMessage: MessageDto = {
    id: 'msg-user-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'What is the refund policy?',
    contentFormat: 'markdown',
    metadata: {},
    tokenUsage: null,
    createdAt: 1700000000000
  }

  const assistantMessage: MessageDto = {
    id: 'msg-asst-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Full refunds are provided within 30 days of purchase.',
    contentFormat: 'markdown',
    metadata: {
      citations: [
        {
          citationNumber: 1,
          sourceId: 'src-1',
          chunkId: 'chk-1',
          fileName: 'terms_of_service.pdf',
          fileType: 'pdf',
          pageNumber: 3,
          headingPath: ['Refunds'],
          chunkIndex: 0
        }
      ]
    },
    tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    createdAt: 1700000005000
  }

  const sampleConv1: ConversationDto = {
    id: 'conv-1',
    botId: sampleBot.id,
    knowledgeBaseId: 'kb-01',
    title: 'Customer Policy Query',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    archivedAt: null
  }

  const sampleConv2: ConversationDto = {
    id: 'conv-2',
    botId: sampleBot.id,
    knowledgeBaseId: 'kb-01',
    title: 'Tax Regulations',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  // -------------------------------------------------------------------------
  // 1. ConversationMessage
  // -------------------------------------------------------------------------
  describe('ConversationMessage', () => {
    it('renders user and assistant messages with distinct alignment and styling', () => {
      render(<ConversationMessage message={userMessage} />)
      const userRow = screen.getByTestId('message-item-msg-user-1')
      expect(userRow.className).toContain('chat-message-user')
      expect(userRow.textContent).toContain('You')
      expect(userRow.textContent).toContain('What is the refund policy?')

      render(<ConversationMessage message={assistantMessage} botName="Research Bot" />)
      const asstRow = screen.getByTestId('message-item-msg-asst-1')
      expect(asstRow.className).toContain('chat-message-assistant')
      expect(asstRow.textContent).toContain('Research Bot')
      expect(asstRow.textContent).toContain('Full refunds are provided within 30 days of purchase.')
      // Preserves citations in rendered metadata summary
      expect(screen.getByTestId('citations-list-msg-asst-1')).toBeDefined()
      expect(screen.getByTestId('citations-list-msg-asst-1').textContent).toContain(
        'terms_of_service.pdf'
      )
    })

    it('preserves exact plain-text message formatting and whitespace', () => {
      const formattedMessage: MessageDto = {
        ...userMessage,
        id: 'msg-formatted',
        contentFormat: 'text',
        content: 'Line 1\n\nLine 2 with   spaces\n  - Item A\n  - Item B'
      }

      render(<ConversationMessage message={formattedMessage} />)

      const bubble = screen.getByTestId('message-item-msg-formatted')
      expect(bubble.textContent).toContain('Line 1\n\nLine 2 with   spaces\n  - Item A\n  - Item B')
    })
  })

  // -------------------------------------------------------------------------
  // 2. ConversationComposer
  // -------------------------------------------------------------------------
  describe('ConversationComposer', () => {
    it('rejects blank or whitespace-only input and disables send button', () => {
      const onSend = vi.fn()
      render(<ConversationComposer onSend={onSend} isGenerating={false} />)

      const sendBtn = screen.getByTestId('send-message-btn')
      const input = screen.getByTestId('message-input') as HTMLTextAreaElement

      expect(sendBtn.getAttribute('disabled')).not.toBeNull()

      fireEvent.change(input, { target: { value: '    ' } })
      expect(sendBtn.getAttribute('disabled')).not.toBeNull()

      fireEvent.click(sendBtn)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('sends on Enter and inserts newline on Shift+Enter', async () => {
      const onSend = vi.fn(async () => {})
      render(<ConversationComposer onSend={onSend} isGenerating={false} />)

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement

      // Type text
      fireEvent.change(input, { target: { value: 'First line' } })

      // Shift+Enter should NOT submit
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      expect(onSend).not.toHaveBeenCalled()

      // Plain Enter should submit
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
      expect(onSend).toHaveBeenCalledWith('First line')

      // Clears input only after submission completes
      await waitFor(() => {
        expect(input.value).toBe('')
      })
    })

    it('disables input and send button when isGenerating is true', () => {
      const onSend = vi.fn()
      render(<ConversationComposer onSend={onSend} isGenerating={true} />)

      const input = screen.getByTestId('message-input')
      const sendBtn = screen.getByTestId('send-message-btn')

      expect(input.getAttribute('disabled')).not.toBeNull()
      expect(sendBtn.getAttribute('disabled')).not.toBeNull()
    })

    it('disables input when disabled prop is passed (e.g. archived bot)', () => {
      const onSend = vi.fn()
      render(<ConversationComposer onSend={onSend} isGenerating={false} disabled={true} />)

      const input = screen.getByTestId('message-input')
      expect(input.getAttribute('disabled')).not.toBeNull()
    })

    it('preserves typed text if onSend throws an error', async () => {
      const onSend = vi.fn(async () => {
        throw new Error('Network timeout')
      })
      render(<ConversationComposer onSend={onSend} isGenerating={false} />)

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'Preserve my text' } })

      const sendBtn = screen.getByTestId('send-message-btn')
      fireEvent.click(sendBtn)

      await waitFor(() => {
        expect(onSend).toHaveBeenCalled()
      })

      // Must NOT clear text on failure
      expect(input.value).toBe('Preserve my text')
    })

    it('renders Stop button when isGenerating is true and onStop is provided', () => {
      const onStop = vi.fn()
      render(
        <ConversationComposer
          onSend={vi.fn()}
          onStop={onStop}
          isGenerating={true}
          isCancelling={false}
        />
      )

      expect(screen.queryByTestId('send-message-btn')).toBeNull()
      const stopBtn = screen.getByTestId('stop-generation-btn')
      expect(stopBtn).toBeDefined()
      expect(stopBtn.textContent).toContain('Stop')
      expect(stopBtn.getAttribute('disabled')).toBeNull()

      fireEvent.click(stopBtn)
      expect(onStop).toHaveBeenCalled()
    })

    it('Stop button displays Stopping... and is disabled when isCancelling is true', () => {
      render(
        <ConversationComposer
          onSend={vi.fn()}
          onStop={vi.fn()}
          isGenerating={true}
          isCancelling={true}
        />
      )

      const stopBtn = screen.getByTestId('stop-generation-btn')
      expect(stopBtn.textContent).toContain('Stopping...')
      expect(stopBtn.getAttribute('disabled')).not.toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // 3. ConversationMessageList & Streaming Display
  // -------------------------------------------------------------------------
  describe('ConversationMessageList', () => {
    it('renders empty conversation state when no messages exist and not generating', () => {
      render(
        <ConversationMessageList
          messages={[]}
          isLoading={false}
          isGenerating={false}
          streamingText=""
          botName="Research Bot"
        />
      )

      expect(screen.getByTestId('messages-empty')).toBeDefined()
      expect(screen.getByText('Chat with Research Bot')).toBeDefined()
    })

    it('renders loading state when isLoading is true and no messages loaded yet', () => {
      render(
        <ConversationMessageList
          messages={[]}
          isLoading={true}
          isGenerating={false}
          streamingText=""
        />
      )

      expect(screen.getByTestId('messages-loading')).toBeDefined()
    })

    it('renders streaming assistant bubble when streamingText is non-empty', () => {
      render(
        <ConversationMessageList
          messages={[userMessage]}
          isLoading={false}
          isGenerating={true}
          streamingText="I am analyzing your refund policy request..."
          botName="Research Bot"
        />
      )

      expect(screen.getByTestId('streaming-text-preview')).toBeDefined()
      expect(screen.getByText(/I am analyzing your refund policy request\.\.\./)).toBeDefined()
    })

    it('renders generating thinking indicator when isGenerating is true but streamingText has not arrived yet', () => {
      render(
        <ConversationMessageList
          messages={[userMessage]}
          isLoading={false}
          isGenerating={true}
          streamingText=""
          botName="Research Bot"
        />
      )

      expect(screen.getByTestId('streaming-indicator')).toBeDefined()
      expect(screen.getByText('Research Bot is thinking...')).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // 4. ConversationSidebar
  // -------------------------------------------------------------------------
  describe('ConversationSidebar', () => {
    it('renders list of active Bot conversations with titles and timestamps', () => {
      const onSelect = vi.fn()
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1, sampleConv2]}
          selectedConversationId="conv-1"
          onSelectConversation={onSelect}
          onCreateConversation={vi.fn()}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      expect(screen.getByTestId('conversation-title-conv-1').textContent).toBe(
        'Customer Policy Query'
      )
      expect(screen.getByTestId('conversation-title-conv-2').textContent).toBe('Tax Regulations')

      const item1 = screen.getByTestId('conversation-item-conv-1')
      expect(item1.getAttribute('aria-selected')).toBe('true')

      fireEvent.click(screen.getByTestId('conversation-item-conv-2'))
      expect(onSelect).toHaveBeenCalledWith('conv-2')
    })

    it('renders sidebar empty state when bot has no conversations', () => {
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[]}
          selectedConversationId={null}
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      expect(screen.getByTestId('conversations-empty-state')).toBeDefined()
      expect(screen.getByText('No conversations')).toBeDefined()
    })

    it('clicking Rename button opens inline rename form prefilled with title without selecting conversation', () => {
      const onSelect = vi.fn()
      const onRename = vi.fn()
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1, sampleConv2]}
          selectedConversationId="conv-1"
          onSelectConversation={onSelect}
          onCreateConversation={vi.fn()}
          onRenameConversation={onRename}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      const renameBtn = screen.getByTestId('rename-conversation-btn-conv-2')
      fireEvent.click(renameBtn)

      expect(onSelect).not.toHaveBeenCalled()
      expect(screen.getByTestId('rename-form-conv-2')).toBeDefined()
      const input = screen.getByTestId('rename-input-conv-2') as HTMLInputElement
      expect(input.value).toBe('Tax Regulations')
    })

    it('inline rename form rejects blank or whitespace-only titles', async () => {
      const onRename = vi.fn()
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1]}
          selectedConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          onRenameConversation={onRename}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      fireEvent.click(screen.getByTestId('rename-conversation-btn-conv-1'))
      const input = screen.getByTestId('rename-input-conv-1')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.click(screen.getByTestId('save-rename-btn-conv-1'))

      expect(onRename).not.toHaveBeenCalled()
      expect(screen.getByTestId('rename-error-conv-1').textContent).toContain('cannot be blank')
    })

    it('inline rename form cancels when Escape is pressed', () => {
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1]}
          selectedConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      fireEvent.click(screen.getByTestId('rename-conversation-btn-conv-1'))
      expect(screen.getByTestId('rename-form-conv-1')).toBeDefined()

      const input = screen.getByTestId('rename-input-conv-1')
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(screen.queryByTestId('rename-form-conv-1')).toBeNull()
      expect(screen.getByTestId('conversation-title-conv-1')).toBeDefined()
    })

    it('inline rename form saves when Enter is pressed', async () => {
      const onRename = vi.fn(async () => ({ ...sampleConv1, title: 'Updated Title' }))
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1]}
          selectedConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          onRenameConversation={onRename}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      fireEvent.click(screen.getByTestId('rename-conversation-btn-conv-1'))
      const input = screen.getByTestId('rename-input-conv-1')
      fireEvent.change(input, { target: { value: 'Updated Title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onRename).toHaveBeenCalledWith('conv-1', 'Updated Title')
      })
    })

    it('clicking Delete button opens DeleteConversationDialog without selecting conversation', () => {
      const onSelect = vi.fn()
      const onDelete = vi.fn()
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1, sampleConv2]}
          selectedConversationId="conv-1"
          onSelectConversation={onSelect}
          onCreateConversation={vi.fn()}
          onDeleteConversation={onDelete}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      const deleteBtn = screen.getByTestId('delete-conversation-btn-conv-2')
      fireEvent.click(deleteBtn)

      expect(onSelect).not.toHaveBeenCalled()
      expect(screen.getByTestId('delete-conversation-dialog')).toBeDefined()
      expect(screen.getByTestId('delete-conversation-target-title').textContent).toBe(
        'Tax Regulations'
      )
    })

    it('disables Delete button when isGenerating is true for the selected conversation', () => {
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1, sampleConv2]}
          selectedConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          isGenerating={true}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      const deleteBtn1 = screen.getByTestId('delete-conversation-btn-conv-1')
      expect(deleteBtn1.getAttribute('disabled')).not.toBeNull()

      const deleteBtn2 = screen.getByTestId('delete-conversation-btn-conv-2')
      expect(deleteBtn2.getAttribute('disabled')).toBeNull()
    })

    it('canceling Delete dialog leaves conversation untouched', () => {
      render(
        <ConversationSidebar
          bot={sampleBot}
          conversations={[sampleConv1]}
          selectedConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCreateConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          isLoading={false}
          isRefreshing={false}
          isMutating={false}
          error={null}
          onRefresh={vi.fn()}
        />
      )

      fireEvent.click(screen.getByTestId('delete-conversation-btn-conv-1'))
      expect(screen.getByTestId('delete-conversation-dialog')).toBeDefined()

      fireEvent.click(screen.getByTestId('cancel-delete-btn'))
      expect(screen.queryByTestId('delete-conversation-dialog')).toBeNull()
      expect(screen.getByTestId('conversation-title-conv-1')).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // 5. ConversationEmptyState
  // -------------------------------------------------------------------------
  describe('ConversationEmptyState', () => {
    it('renders no-selection variant with create button when not archived', () => {
      const onNew = vi.fn()
      render(
        <ConversationEmptyState
          variant="no-selection"
          botName="Research Bot"
          onNewConversation={onNew}
          isArchived={false}
        />
      )

      expect(screen.getByTestId('no-conversation-selected')).toBeDefined()
      const btn = screen.getByTestId('empty-state-new-conv-btn')
      fireEvent.click(btn)
      expect(onNew).toHaveBeenCalled()
    })

    it('hides create button on no-selection variant when bot is archived', () => {
      render(
        <ConversationEmptyState
          variant="no-selection"
          botName="Research Bot"
          onNewConversation={vi.fn()}
          isArchived={true}
        />
      )

      expect(screen.queryByTestId('empty-state-new-conv-btn')).toBeNull()
    })
  })
})
