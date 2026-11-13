// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { DeleteConversationDialog } from './DeleteConversationDialog'
import type { ConversationDto } from '../../../../shared/conversations'

describe('DeleteConversationDialog (Phase 7 Step 7.11)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleConv: ConversationDto = {
    id: 'conv-1111-2222',
    botId: 'bot-01',
    knowledgeBaseId: 'kb-01',
    title: 'Financial Q3 Report',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  it('1. renders dialog with title, permanent deletion explanation, and KB preservation message', () => {
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByTestId('delete-conversation-dialog')).toBeDefined()
    expect(screen.getByTestId('delete-conversation-target-title').textContent).toBe(
      'Financial Q3 Report'
    )
    expect(
      screen.getByText(/All messages and message history in this conversation thread/)
    ).toBeDefined()
    expect(
      screen.getByText(/Knowledge Base documents, search indexes, and Bot instructions/)
    ).toBeDefined()
  })

  it('2. returns null when isOpen is false or conversation is null', () => {
    const { container: c1 } = render(
      <DeleteConversationDialog
        isOpen={false}
        conversation={sampleConv}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(c2.firstChild).toBeNull()
  })

  it('3. clicking Cancel calls onClose', () => {
    const onClose = vi.fn()
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={onClose}
        onConfirm={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('cancel-delete-btn'))
    expect(onClose).toHaveBeenCalled()
  })

  it('4. pressing Escape calls onClose', () => {
    const onClose = vi.fn()
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={onClose}
        onConfirm={vi.fn()}
      />
    )

    const backdrop = screen.getByTestId('delete-conversation-dialog-backdrop')
    fireEvent.keyDown(backdrop, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('5. clicking Confirm calls onConfirm and then closes on success', async () => {
    const onConfirm = vi.fn(async () => {})
    const onClose = vi.fn()
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByTestId('confirm-delete-btn'))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('conv-1111-2222')
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('6. disables Confirm button and displays warning when isGenerating is true', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        isGenerating={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    expect(screen.getByTestId('delete-generating-warning')).toBeDefined()
    const confirmBtn = screen.getByTestId('confirm-delete-btn')
    expect(confirmBtn.getAttribute('disabled')).not.toBeNull()

    fireEvent.click(confirmBtn)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('7. displays sanitized error message when deletion fails', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('Database locked at C:\\Users\\Acer\\secret.db')
    })
    const onClose = vi.fn()
    render(
      <DeleteConversationDialog
        isOpen={true}
        conversation={sampleConv}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByTestId('confirm-delete-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('delete-conversation-error')).toBeDefined()
    })

    const errorEl = screen.getByTestId('delete-conversation-error')
    expect(errorEl.textContent).toContain('[REDACTED_PATH]')
    expect(errorEl.textContent).not.toContain('C:\\Users\\Acer\\secret.db')
    expect(onClose).not.toHaveBeenCalled()
  })
})
