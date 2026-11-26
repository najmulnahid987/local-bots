// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ClearConversationDialog } from './ClearConversationDialog'
import type { ConversationDto, ClearConversationPreviewDto } from '../../../../shared/conversations'

describe('ClearConversationDialog (Phase 12 Step 12.2)', () => {
  const sampleConv: ConversationDto = {
    id: 'conv-1111-1111-1111-111111111111',
    botId: 'bot-1111-1111-1111-111111111111',
    knowledgeBaseId: 'kb-1111-1111-1111-111111111111',
    title: 'Research Bot Thread',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: {
        conversation: {
          getClearPreview: vi.fn()
        }
      },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing when closed or conversation is null', () => {
    const { rerender } = render(
      <ClearConversationDialog
        isOpen={false}
        conversation={sampleConv}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByTestId('clear-conversation-dialog')).toBeNull()

    rerender(
      <ClearConversationDialog
        isOpen={true}
        conversation={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByTestId('clear-conversation-dialog')).toBeNull()
  })

  it('loads preview statistics and clearly explains preserved KB, Bot, and Agent audit data', async () => {
    const preview: ClearConversationPreviewDto = {
      conversationId: sampleConv.id,
      conversationTitle: sampleConv.title,
      botId: sampleConv.botId,
      botName: 'Research Bot',
      messageCount: 14,
      segmentCount: 3,
      agentRunCount: 2,
      toolEventCount: 5,
      isBlocked: false
    }
    vi.mocked(window.api.conversation!.getClearPreview!).mockResolvedValueOnce(preview)

    render(
      <ClearConversationDialog
        isOpen={true}
        conversation={sampleConv}
        botName="Research Bot"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByTestId('clear-conversation-target-title').textContent).toBe('Research Bot')
    expect(screen.getByText(/Preserved Workspace & Audit Data/i)).toBeDefined()

    const summary = await screen.findByTestId('clear-preview-summary')
    expect(summary.textContent).toContain('14')
    expect(summary.textContent).toContain('3')
    expect(summary.textContent).toContain('2')
    expect(summary.textContent).toContain('5')
  })

  it('invokes onConfirm and closes on Clear click, and leaves unchanged on Cancel or Escape', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn(async () => {})
    const preview: ClearConversationPreviewDto = {
      conversationId: sampleConv.id,
      conversationTitle: sampleConv.title,
      botId: sampleConv.botId,
      botName: 'Research Bot',
      messageCount: 2,
      segmentCount: 1,
      agentRunCount: 0,
      toolEventCount: 0,
      isBlocked: false
    }
    vi.mocked(window.api.conversation!.getClearPreview!).mockResolvedValue(preview)

    render(
      <ClearConversationDialog
        isOpen={true}
        conversation={sampleConv}
        botName="Research Bot"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByTestId('cancel-clear-btn'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByTestId('clear-conversation-dialog-backdrop'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-clear-btn'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(sampleConv.id)
      expect(onClose).toHaveBeenCalledTimes(3)
    })
  })

  it('disables confirm action while generating or running an Agent Task', () => {
    const onConfirm = vi.fn()
    render(
      <ClearConversationDialog
        isOpen={true}
        conversation={sampleConv}
        isGenerating={true}
        isTaskActive={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const warning = screen.getByTestId('clear-generating-warning')
    expect(warning.textContent).toContain('Agent Task is currently running')
    const confirmBtn = screen.getByTestId('confirm-clear-btn') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    fireEvent.click(confirmBtn)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('displays sanitized error without closing when onConfirm fails', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn(async () => {
      throw new Error('Clear failed at C:\\Users\\Admin\\workspace.db with sk-proj-secret123456')
    })

    render(
      <ClearConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByTestId('confirm-clear-btn'))

    const alert = await screen.findByTestId('clear-conversation-error')
    expect(alert.textContent).toContain('[REDACTED_PATH]')
    expect(alert.textContent).toContain('[REDACTED_KEY]')
    expect(alert.textContent).not.toContain('workspace.db')
    expect(onClose).not.toHaveBeenCalled()
  })
})
