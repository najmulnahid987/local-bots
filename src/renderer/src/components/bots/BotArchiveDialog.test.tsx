// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { BotArchiveDialog } from './BotArchiveDialog'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: BotArchiveDialog (Phase 6 Step 6.5)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleBot: BotDto = {
    id: 'bot-1234',
    knowledgeBaseId: 'kb-test',
    name: 'Customer Support Bot',
    description: 'Handles support inquiries',
    systemPrompt: 'Be polite.',
    providerConnectionId: 'conn-1',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  it('1. returns null when isOpen is false or bot is null', () => {
    const { container: c1 } = render(
      <BotArchiveDialog isOpen={false} bot={sampleBot} onClose={vi.fn()} />
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(
      <BotArchiveDialog isOpen={true} bot={null} onClose={vi.fn()} />
    )
    expect(c2.firstChild).toBeNull()
  })

  it('2. displays bot name and explains archive behavior', () => {
    render(<BotArchiveDialog isOpen={true} bot={sampleBot} onClose={vi.fn()} />)

    expect(screen.getByTestId('archive-bot-dialog')).not.toBeNull()
    expect(screen.getByText(/Archive Bot: Customer Support Bot/)).not.toBeNull()
    expect(
      screen.getByText(/Existing conversation history and messages remain stored and preserved/)
    ).not.toBeNull()
    expect(screen.getByText(/You can restore this Bot to active status at any time/)).not.toBeNull()
  })

  it('3. cancels on cancel button or close button', () => {
    const handleClose = vi.fn()
    render(<BotArchiveDialog isOpen={true} bot={sampleBot} onClose={handleClose} />)

    const cancelBtn = screen.getByTestId('archive-bot-cancel-btn')
    fireEvent.click(cancelBtn)
    expect(handleClose).toHaveBeenCalledTimes(1)

    const closeBtn = screen.getByTestId('close-archive-bot-dialog-btn')
    fireEvent.click(closeBtn)
    expect(handleClose).toHaveBeenCalledTimes(2)
  })

  it('4. closes on Escape key', () => {
    const handleClose = vi.fn()
    render(<BotArchiveDialog isOpen={true} bot={sampleBot} onClose={handleClose} />)

    const backdrop = screen.getByTestId('archive-bot-dialog-backdrop')
    fireEvent.keyDown(backdrop, { key: 'Escape' })
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('5. executes archive successfully and calls onSuccess and onClose', async () => {
    const handleSuccess = vi.fn()
    const handleClose = vi.fn()
    const mockArchive = vi.fn(async (id: string) => ({
      ...sampleBot,
      id,
      status: 'archived' as const,
      updatedAt: Date.now()
    }))

    render(
      <BotArchiveDialog
        isOpen={true}
        bot={sampleBot}
        onClose={handleClose}
        onSuccess={handleSuccess}
        onArchive={mockArchive}
      />
    )

    const confirmBtn = screen.getByTestId('archive-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockArchive).toHaveBeenCalledWith('bot-1234')
    expect(handleSuccess).toHaveBeenCalledTimes(1)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('6. keeps dialog open and displays error when archive rejects', async () => {
    const handleClose = vi.fn()
    const mockArchive = vi.fn(async () => {
      throw new Error('Database locked C:\\workspace\\app.db')
    })

    render(
      <BotArchiveDialog
        isOpen={true}
        bot={sampleBot}
        onClose={handleClose}
        onArchive={mockArchive}
      />
    )

    const confirmBtn = screen.getByTestId('archive-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(handleClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('archive-bot-dialog')).not.toBeNull()
    expect(screen.getByText(/Database locked \[REDACTED_PATH\]/)).not.toBeNull()
  })
})

