// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ConversationMessage } from './ConversationMessage'
import { ConversationComposer } from './ConversationComposer'
import { ConversationMessageList } from './ConversationMessageList'
import { ConversationEmptyState } from './ConversationEmptyState'
import type { MessageDto, ConversationSegmentDto } from '../../../../shared/conversations'

describe('Renderer: Chat Presentation Components (Phase 7 Step 7.9)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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

    it('renders compact source indicator badges for Balanced grounding modes and hides noisy chrome for general_chat', () => {
      const kbMsg: MessageDto = {
        ...assistantMessage,
        id: 'msg-kb-badge',
        metadata: { ...assistantMessage.metadata, groundingMode: 'kb_grounded' }
      }
      const partialMsg: MessageDto = {
        ...assistantMessage,
        id: 'msg-partial-badge',
        metadata: { groundingMode: 'kb_partial_with_general_fallback' }
      }
      const fallbackMsg: MessageDto = {
        ...assistantMessage,
        id: 'msg-fallback-badge',
        metadata: { groundingMode: 'general_fallback_no_kb_evidence' }
      }
      const noUsableMsg: MessageDto = {
        ...assistantMessage,
        id: 'msg-nousable-badge',
        metadata: { groundingMode: 'general_fallback_no_usable_kb' }
      }
      const generalMsg: MessageDto = {
        ...assistantMessage,
        id: 'msg-general-badge',
        metadata: { groundingMode: 'general_chat' }
      }

      render(
        <>
          <ConversationMessage message={kbMsg} botName="Balanced Bot" />
          <ConversationMessage message={partialMsg} botName="Balanced Bot" />
          <ConversationMessage message={fallbackMsg} botName="Balanced Bot" />
          <ConversationMessage message={noUsableMsg} botName="Balanced Bot" />
          <ConversationMessage message={generalMsg} botName="General Bot" />
        </>
      )

      expect(screen.getByTestId('message-grounding-badge-msg-kb-badge').textContent).toBe(
        'KB Evidence'
      )
      expect(screen.getByTestId('message-grounding-badge-msg-partial-badge').textContent).toBe(
        'Partial KB + General AI'
      )
      expect(screen.getByTestId('message-grounding-badge-msg-fallback-badge').textContent).toBe(
        'General AI Fallback'
      )
      expect(screen.getByTestId('message-grounding-badge-msg-nousable-badge').textContent).toBe(
        'General AI (No KB Docs)'
      )
      expect(screen.queryByTestId('message-grounding-badge-msg-general-badge')).toBeNull()
    })

    it('34. Renders older messages without executionMode cleanly and displays Agent Task badge for agent runs', () => {
      // Historical message without executionMode in metadata
      const legacyMessage: MessageDto = {
        ...assistantMessage,
        id: 'msg-legacy-1',
        content: 'Historical message created before Phase 12 Step 12.6',
        metadata: {
          generation: { finishReason: 'stop' }
        }
      }

      // Modern Agent task message
      const agentMessage: MessageDto = {
        ...assistantMessage,
        id: 'msg-agent-task-1',
        content: 'Report saved to workspace.',
        metadata: {
          executionMode: 'agent',
          agentRunId: 'run-uuid-1234'
        }
      }

      // Modern Chat message
      const chatMessage: MessageDto = {
        ...assistantMessage,
        id: 'msg-chat-1',
        content: 'Conversational response.',
        metadata: {
          executionMode: 'chat'
        }
      }

      render(
        <>
          <ConversationMessage message={legacyMessage} botName="Legacy Bot" />
          <ConversationMessage message={agentMessage} botName="Agent Bot" />
          <ConversationMessage message={chatMessage} botName="Chat Bot" />
        </>
      )

      // Legacy message renders cleanly with no execution mode badge
      expect(screen.queryByTestId('message-execution-mode-msg-legacy-1')).toBeNull()
      expect(screen.getByTestId('message-item-msg-legacy-1').textContent).toContain(
        'Historical message created before Phase 12 Step 12.6'
      )

      // Agent message displays Agent Task badge
      const agentBadge = screen.getByTestId('message-execution-mode-msg-agent-task-1')
      expect(agentBadge).toBeDefined()
      expect(agentBadge.textContent).toContain('Agent Task')

      // Chat message does not display Agent Task badge
      expect(screen.queryByTestId('message-execution-mode-msg-chat-1')).toBeNull()
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

    it('renders historical segments strictly in segmentOrder without interleaving overlapping timestamps and handles empty segments', () => {
      const seg0: ConversationSegmentDto = {
        id: 'seg-0',
        conversationId: 'conv-1',
        originalConversationId: 'conv-1',
        title: 'Contract Review',
        segmentOrder: 0,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000000000,
        archivedAt: null,
        messageCount: 1
      }
      const seg1Empty: ConversationSegmentDto = {
        id: 'seg-1',
        conversationId: 'conv-1',
        originalConversationId: 'conv-1',
        title: 'Empty Consolidated Thread',
        segmentOrder: 1,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000001000,
        archivedAt: null,
        messageCount: 0
      }
      const seg2: ConversationSegmentDto = {
        id: 'seg-2',
        conversationId: 'conv-1',
        originalConversationId: 'conv-1',
        title: 'Follow-Up Research',
        segmentOrder: 2,
        firstMessageCreatedAt: null,
        lastMessageCreatedAt: null,
        createdAt: 1700000002000,
        archivedAt: null,
        messageCount: 1
      }

      const msgSeg0LaterTs: MessageDto = {
        ...userMessage,
        id: 'msg-seg-0',
        segmentId: seg0.id,
        content: 'Older segment message with later timestamp',
        createdAt: 1700000099000
      }
      const msgSeg2EarlierTs: MessageDto = {
        ...assistantMessage,
        id: 'msg-seg-2',
        segmentId: seg2.id,
        content: 'Later segment message with earlier timestamp',
        createdAt: 1700000011000
      }

      render(
        <ConversationMessageList
          messages={[msgSeg2EarlierTs, msgSeg0LaterTs]}
          segments={[seg2, seg0, seg1Empty]}
          isLoading={false}
          isGenerating={false}
          streamingText=""
          botName="Research Bot"
        />
      )

      const header0 = screen.getByTestId('conversation-segment-header-seg-0')
      const header1 = screen.getByTestId('conversation-segment-header-seg-1')
      const header2 = screen.getByTestId('conversation-segment-header-seg-2')
      expect(header0.textContent).toContain('Contract Review')
      expect(header1.textContent).toContain('Empty Consolidated Thread')
      expect(header2.textContent).toContain('Follow-Up Research')

      // Segment headers must not be interactive buttons/tabs for switching conversations
      expect(header0.closest('button')).toBeNull()
      expect(screen.getByTestId('conversation-segment-empty-seg-1').textContent).toContain(
        'No messages recorded in this historical thread.'
      )

      // DOM order must be msg-seg-0 before empty seg-1 before msg-seg-2
      const listEl = screen.getByTestId('messages-container')
      const html = listEl.innerHTML
      expect(html.indexOf('msg-seg-0')).toBeLessThan(
        html.indexOf('conversation-segment-empty-seg-1')
      )
      expect(html.indexOf('conversation-segment-empty-seg-1')).toBeLessThan(
        html.indexOf('msg-seg-2')
      )
    })
  })

  // -------------------------------------------------------------------------
  // 4. ConversationEmptyState (Unified Single-Conversation Workspace)
  // -------------------------------------------------------------------------
  describe('ConversationEmptyState', () => {
    it('renders empty conversation state for an active Bot with no New Conversation controls', () => {
      render(<ConversationEmptyState botName="Research Bot" isArchived={false} />)

      expect(screen.getByTestId('messages-empty')).toBeDefined()
      expect(screen.getByText('Chat with Research Bot')).toBeDefined()
      expect(screen.queryByTestId('empty-state-new-conv-btn')).toBeNull()
      expect(screen.queryByTestId('no-conversation-selected')).toBeNull()
    })

    it('renders read-only archived message when bot is archived', () => {
      render(<ConversationEmptyState botName="Research Bot" isArchived={true} />)

      expect(screen.getByTestId('messages-empty')).toBeDefined()
      expect(screen.getByText(/archived and has no recorded messages/i)).toBeDefined()
      expect(screen.queryByTestId('empty-state-new-conv-btn')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // 5. Claim Provenance Inspector (Step 12.5)
  // -------------------------------------------------------------------------
  describe('Step 12.5: Claim Provenance Presentation & Integrity', () => {
    it('expands claim-level provenance, triggers click with messageId, filters unvalidated references, and leaves legacy messages intact', () => {
      const onCitationClick = vi.fn()
      const msgWithClaims: MessageDto = {
        ...assistantMessage,
        id: 'msg-claims-1',
        metadata: {
          ...assistantMessage.metadata,
          groundingMode: 'kb_partial_with_general_fallback',
          claims: [
            {
              claimId: 'claim-1',
              claimText: 'Full refunds are provided within 30 days.',
              provenance: 'kb_supported',
              validationStatus: 'validated',
              evidenceReferences: [
                {
                  knowledgeBaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  sourceId: 'src-1',
                  chunkId: 'chk-1',
                  citationNumber: 1,
                  fileName: 'terms_of_service.pdf',
                  fileType: 'pdf',
                  pageNumber: 3,
                  headingPath: ['Refunds'],
                  chunkIndex: 0
                }
              ],
              explanation: 'INTERNAL_SHOULD_NOT_RENDER'
            },
            {
              claimId: 'claim-2',
              claimText: 'Support response times are typically under one business day.',
              provenance: 'general_knowledge',
              validationStatus: 'not_checked',
              evidenceReferences: []
            },
            {
              claimId: 'claim-3',
              claimText: 'Fake unverified claim [99].',
              provenance: 'unsupported',
              validationStatus: 'invalid_reference',
              evidenceReferences: [
                {
                  sourceId: 'fake-src',
                  chunkId: 'fake-chk',
                  citationNumber: 99,
                  fileName: 'ghost.pdf',
                  fileType: 'pdf',
                  pageNumber: null,
                  headingPath: null,
                  chunkIndex: 0
                }
              ]
            }
          ]
        }
      }

      render(
        <>
          <ConversationMessage
            message={msgWithClaims}
            botName="Balanced Bot"
            onCitationClick={onCitationClick}
          />
          <ConversationMessage message={assistantMessage} botName="Legacy Bot" />
        </>
      )

      // Legacy message without claims continues rendering normally with no provenance toggle
      expect(screen.queryByTestId('claim-provenance-section-msg-asst-1')).toBeNull()

      const toggle = screen.getByTestId('toggle-claim-provenance-msg-claims-1')
      expect(toggle.textContent).toContain('Claim Provenance (3 claims)')
      expect(screen.queryByTestId('claim-provenance-list-msg-claims-1')).toBeNull()

      fireEvent.click(toggle)
      const list = screen.getByTestId('claim-provenance-list-msg-claims-1')
      expect(list.textContent).not.toContain('INTERNAL_SHOULD_NOT_RENDER')
      expect(screen.getByTestId('claim-status-badge-msg-claims-1-claim-1').textContent).toBe(
        'KB Supported'
      )
      expect(screen.getByTestId('claim-status-badge-msg-claims-1-claim-2').textContent).toBe(
        'General AI'
      )
      expect(screen.getByTestId('claim-status-badge-msg-claims-1-claim-3').textContent).toBe(
        'Unverified Reference'
      )

      // Unvalidated claim-3 reference is filtered out in the UI
      expect(screen.queryByTestId('claim-ref-btn-msg-claims-1-claim-3-99')).toBeNull()

      // Clicking valid claim ref opens source citation for exact message ID
      const refBtn = screen.getByTestId('claim-ref-btn-msg-claims-1-claim-1-1')
      fireEvent.click(refBtn)
      expect(onCitationClick).toHaveBeenCalledWith(
        expect.objectContaining({
          citationNumber: 1,
          sourceId: 'src-1',
          chunkId: 'chk-1',
          fileName: 'terms_of_service.pdf'
        }),
        'msg-claims-1'
      )
    })
  })
})
