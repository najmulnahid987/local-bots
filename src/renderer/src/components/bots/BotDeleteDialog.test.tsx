// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { BotDeleteDialog } from './BotDeleteDialog'
import type { BotDto, DeleteBotResultDto } from '../../../../shared/bots'

describe('Renderer: BotDeleteDialog (Phase 6 Step 6.5)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleBot: BotDto = {
    id: 'bot-to-delete-9999',
    knowledgeBaseId: 'kb-test-01',
    name: 'Analytical Bot Alpha',
    description: 'Will be deleted',
    systemPrompt: '',
    providerConnectionId: 'conn-1',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  it('1. returns null when isOpen is false or bot is null', () => {
    const { container: c1 } = render(
      <BotDeleteDialog isOpen={false} bot={sampleBot} onClose={vi.fn()} />
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(<BotDeleteDialog isOpen={true} bot={null} onClose={vi.fn()} />)
    expect(c2.firstChild).toBeNull()
  })

  it('2. displays bot name, cascade warnings, and preservation guarantees', () => {
    render(<BotDeleteDialog isOpen={true} bot={sampleBot} onClose={vi.fn()} />)

    expect(screen.getByTestId('delete-bot-dialog')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Delete Bot Permanently' })).not.toBeNull()
    expect(screen.getByTestId('delete-bot-confirm-btn')).not.toBeNull()
    expect(screen.getAllByText(/Analytical Bot Alpha/)).toHaveLength(2)

    // Cascade deletions explanation
    expect(screen.getByText(/All conversation threads associated with this Bot/)).not.toBeNull()
    expect(
      screen.getByText(/All autonomous agent execution runs and recorded tool invocation events/)
    ).not.toBeNull()
    expect(screen.getByText(/All persistent Bot memories and task state/)).not.toBeNull()

    // Preservation guarantees explanation
    expect(screen.getByText(/The parent Knowledge Base itself remains untouched/)).not.toBeNull()
    expect(
      screen.getByText(
        /All ingested document sources, extracted chunks, and FTS5 search indexes remain intact/
      )
    ).not.toBeNull()
    expect(
      screen.getByText(/All sibling Bots and configured provider API connections are unaffected/)
    ).not.toBeNull()
  })

  it('3. disables delete button until user types the exact Bot name', () => {
    render(<BotDeleteDialog isOpen={true} bot={sampleBot} onClose={vi.fn()} />)

    const confirmBtn = screen.getByTestId('delete-bot-confirm-btn') as HTMLButtonElement
    const input = screen.getByTestId('confirm-delete-bot-input') as HTMLInputElement

    // Initially disabled
    expect(confirmBtn.disabled).toBe(true)

    // Type partial or wrong name
    fireEvent.change(input, { target: { value: 'Analytical Bot' } })
    expect(confirmBtn.disabled).toBe(true)

    // Type exact matching name
    fireEvent.change(input, { target: { value: 'Analytical Bot Alpha' } })
    expect(confirmBtn.disabled).toBe(false)

    // Clear name
    fireEvent.change(input, { target: { value: '' } })
    expect(confirmBtn.disabled).toBe(true)
  })

  it('4. calls onClose when clicking cancel button or close button', () => {
    const handleClose = vi.fn()
    render(<BotDeleteDialog isOpen={true} bot={sampleBot} onClose={handleClose} />)

    const cancelBtn = screen.getByTestId('delete-bot-cancel-btn')
    fireEvent.click(cancelBtn)
    expect(handleClose).toHaveBeenCalledTimes(1)

    const closeBtn = screen.getByTestId('close-delete-bot-dialog-btn')
    fireEvent.click(closeBtn)
    expect(handleClose).toHaveBeenCalledTimes(2)
  })

  it('5. executes permanent deletion when confirmed and calls onSuccess and onClose', async () => {
    const handleSuccess = vi.fn()
    const handleClose = vi.fn()
    const deleteResult: DeleteBotResultDto = {
      success: true,
      botId: 'bot-to-delete-9999'
    }
    const mockDelete = vi.fn(async () => deleteResult)

    render(
      <BotDeleteDialog
        isOpen={true}
        bot={sampleBot}
        onClose={handleClose}
        onSuccess={handleSuccess}
        onDelete={mockDelete}
      />
    )

    const input = screen.getByTestId('confirm-delete-bot-input')
    fireEvent.change(input, { target: { value: 'Analytical Bot Alpha' } })

    const confirmBtn = screen.getByTestId('delete-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockDelete).toHaveBeenCalledWith('bot-to-delete-9999')
    expect(handleSuccess).toHaveBeenCalledWith(deleteResult)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('6. keeps dialog open and displays error when deletion rejects', async () => {
    const handleClose = vi.fn()
    const mockDelete = vi.fn(async () => {
      throw new Error('SQLite cascade error C:\\Users\\db.sqlite')
    })

    render(
      <BotDeleteDialog isOpen={true} bot={sampleBot} onClose={handleClose} onDelete={mockDelete} />
    )

    const input = screen.getByTestId('confirm-delete-bot-input')
    fireEvent.change(input, { target: { value: 'Analytical Bot Alpha' } })

    const confirmBtn = screen.getByTestId('delete-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(handleClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('delete-bot-dialog')).not.toBeNull()
    const errorEl = screen.getByTestId('delete-bot-error')
    expect(errorEl.textContent).toContain('SQLite cascade error [REDACTED_PATH]')
  })
})
