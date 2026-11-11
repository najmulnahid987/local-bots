// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { BotUnarchiveDialog } from './BotUnarchiveDialog'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: BotUnarchiveDialog (Phase 6 Step 6.5)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleArchivedBot: BotDto = {
    id: 'bot-archived-5678',
    knowledgeBaseId: 'kb-test',
    name: 'Archived Helper',
    description: 'Archived description',
    systemPrompt: 'Archived prompt',
    providerConnectionId: 'conn-1',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base'],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  it('1. returns null when isOpen is false or bot is null', () => {
    const { container: c1 } = render(
      <BotUnarchiveDialog isOpen={false} bot={sampleArchivedBot} onClose={vi.fn()} />
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(
      <BotUnarchiveDialog isOpen={true} bot={null} onClose={vi.fn()} />
    )
    expect(c2.firstChild).toBeNull()
  })

  it('2. displays bot name and explains restoration to active status', () => {
    render(<BotUnarchiveDialog isOpen={true} bot={sampleArchivedBot} onClose={vi.fn()} />)

    expect(screen.getByTestId('unarchive-bot-dialog')).not.toBeNull()
    expect(screen.getByText(/Restore Bot: Archived Helper/)).not.toBeNull()
    expect(
      screen.getByText(/This Bot will return to active status and be immediately available/)
    ).not.toBeNull()
    expect(
      screen.getByText(/All previous conversation threads and stored memories remain intact/)
    ).not.toBeNull()
  })

  it('3. cancels on cancel button or close button', () => {
    const handleClose = vi.fn()
    render(<BotUnarchiveDialog isOpen={true} bot={sampleArchivedBot} onClose={handleClose} />)

    const cancelBtn = screen.getByTestId('unarchive-bot-cancel-btn')
    fireEvent.click(cancelBtn)
    expect(handleClose).toHaveBeenCalledTimes(1)

    const closeBtn = screen.getByTestId('close-unarchive-bot-dialog-btn')
    fireEvent.click(closeBtn)
    expect(handleClose).toHaveBeenCalledTimes(2)
  })

  it('4. closes on Escape key', () => {
    const handleClose = vi.fn()
    render(<BotUnarchiveDialog isOpen={true} bot={sampleArchivedBot} onClose={handleClose} />)

    const backdrop = screen.getByTestId('unarchive-bot-dialog-backdrop')
    fireEvent.keyDown(backdrop, { key: 'Escape' })
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('5. executes unarchive successfully and calls onSuccess and onClose', async () => {
    const handleSuccess = vi.fn()
    const handleClose = vi.fn()
    const mockUnarchive = vi.fn(async (id: string) => ({
      ...sampleArchivedBot,
      id,
      status: 'active' as const,
      updatedAt: Date.now()
    }))

    render(
      <BotUnarchiveDialog
        isOpen={true}
        bot={sampleArchivedBot}
        onClose={handleClose}
        onSuccess={handleSuccess}
        onUnarchive={mockUnarchive}
      />
    )

    const confirmBtn = screen.getByTestId('unarchive-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(mockUnarchive).toHaveBeenCalledWith('bot-archived-5678')
    expect(handleSuccess).toHaveBeenCalledTimes(1)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('6. keeps dialog open and displays error when unarchive rejects', async () => {
    const handleClose = vi.fn()
    const mockUnarchive = vi.fn(async () => {
      throw new Error('Unarchive failed sk-ant-1234567890')
    })

    render(
      <BotUnarchiveDialog
        isOpen={true}
        bot={sampleArchivedBot}
        onClose={handleClose}
        onUnarchive={mockUnarchive}
      />
    )

    const confirmBtn = screen.getByTestId('unarchive-bot-confirm-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    expect(handleClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('unarchive-bot-dialog')).not.toBeNull()
    expect(screen.getByText(/Unarchive failed \[REDACTED_KEY\]/)).not.toBeNull()
  })
})

