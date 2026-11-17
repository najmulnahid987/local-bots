// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { TaskSummaryMemoryProposalModal } from './TaskSummaryMemoryProposalModal'
import type { BotMemoryDto } from '../../../../shared/bot-memories'

describe('Renderer: TaskSummaryMemoryProposalModal (Phase 9 Step 9.3 Task Summary Workflow)', () => {
  const sampleBotId = 'bot-aaaa-bbbb'
  const sampleBotName = 'Financial Analyst Bot'
  const sampleContent = 'Quarterly revenue grew by 14% to $2.3M with 18% net margins.'
  const sampleTaskTitle = 'Analyze Q3 Financials'

  let mockCreateFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockCreateFn = vi.fn(async (input) => ({
      id: 'mem-task-123',
      botId: input.botId,
      knowledgeBaseId: 'kb-test',
      memoryType: input.memoryType ?? 'user_note',
      content: input.content,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    }))

    window.api = {
      botMemories: {
        create: mockCreateFn,
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn()
      }
    } as never
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('1. does not render when isOpen is false', () => {
    const { container } = render(
      <TaskSummaryMemoryProposalModal
        isOpen={false}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={vi.fn()}
      />
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('task-summary-memory-modal')).toBeNull()
  })

  it('2. opens with pre-populated task findings, bot name, and source title', () => {
    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        taskTitle={sampleTaskTitle}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-summary-memory-modal')).toBeDefined()
    expect(screen.getByText('Save Task Findings as Bot Memory')).toBeDefined()
    expect(screen.getByText(sampleBotName)).toBeDefined()
    expect(screen.getByText(`Source: ${sampleTaskTitle}`)).toBeDefined()

    const textarea = screen.getByTestId('textarea-task-summary-content') as HTMLTextAreaElement
    expect(textarea.value).toBe(sampleContent)
  })

  it('3. allows user to edit the proposed content before saving', () => {
    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={vi.fn()}
      />
    )

    const textarea = screen.getByTestId('textarea-task-summary-content') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: { value: 'Refined key takeaway: 14% revenue growth in Q3.' }
    })

    expect(textarea.value).toBe('Refined key takeaway: 14% revenue growth in Q3.')
    expect(screen.getByTestId('task-summary-char-counter').textContent).toContain(
      '47 / 10,000 chars'
    )
  })

  it('4. disables save button when content is empty or whitespace', () => {
    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent=""
        onClose={vi.fn()}
      />
    )

    const saveBtn = screen.getByTestId('btn-save-task-summary') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    const textarea = screen.getByTestId('textarea-task-summary-content')
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(saveBtn.disabled).toBe(true)

    fireEvent.change(textarea, { target: { value: 'Valid finding' } })
    expect(saveBtn.disabled).toBe(false)
  })

  it('5. allows selecting Pinned Instruction or User Note', () => {
    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={vi.fn()}
      />
    )

    const userNoteRadio = screen.getByTestId('input-summary-type-note') as HTMLInputElement
    const pinnedRadio = screen.getByTestId('input-summary-type-pinned') as HTMLInputElement

    // Defaults to user_note
    expect(userNoteRadio.checked).toBe(true)
    expect(pinnedRadio.checked).toBe(false)

    // Select pinned instruction
    fireEvent.click(pinnedRadio)
    expect(userNoteRadio.checked).toBe(false)
    expect(pinnedRadio.checked).toBe(true)
  })

  it('6. cancels without creating a memory when Cancel is clicked', () => {
    const handleClose = vi.fn()

    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={handleClose}
      />
    )

    fireEvent.click(screen.getByTestId('btn-cancel-task-summary'))

    expect(handleClose).toHaveBeenCalled()
    expect(mockCreateFn).not.toHaveBeenCalled()
  })

  it('7. cancels when Escape key is pressed', () => {
    const handleClose = vi.fn()

    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={handleClose}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(handleClose).toHaveBeenCalled()
    expect(mockCreateFn).not.toHaveBeenCalled()
  })

  it('8. saves memory with authoritative botId, selected type, and edited content', async () => {
    const handleClose = vi.fn()
    const handleSaveSuccess = vi.fn()

    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={handleClose}
        onSaveSuccess={handleSaveSuccess}
      />
    )

    // Switch to pinned instruction
    fireEvent.click(screen.getByTestId('input-summary-type-pinned'))

    // Edit content
    const textarea = screen.getByTestId('textarea-task-summary-content')
    fireEvent.change(textarea, {
      target: { value: 'Refined task finding: always verify balance sheet.' }
    })

    // Click explicit Save
    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-save-task-summary'))
    })

    expect(mockCreateFn).toHaveBeenCalledWith({
      botId: sampleBotId,
      memoryType: 'pinned_instruction',
      content: 'Refined task finding: always verify balance sheet.'
    })

    await waitFor(() => {
      expect(handleSaveSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: sampleBotId,
          memoryType: 'pinned_instruction',
          content: 'Refined task finding: always verify balance sheet.'
        })
      )
      expect(handleClose).toHaveBeenCalled()
    })
  })

  it('9. prevents duplicate submissions while saving is in progress', async () => {
    let resolveCreate: (val: BotMemoryDto) => void = () => {}
    mockCreateFn.mockImplementation(
      () =>
        new Promise<BotMemoryDto>((resolve) => {
          resolveCreate = resolve
        })
    )

    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={vi.fn()}
      />
    )

    const saveBtn = screen.getByTestId('btn-save-task-summary') as HTMLButtonElement

    await act(async () => {
      fireEvent.click(saveBtn)
    })

    // Now submitting
    expect(saveBtn.disabled).toBe(true)
    expect(mockCreateFn).toHaveBeenCalledTimes(1)

    // Clicking again should do nothing
    fireEvent.click(saveBtn)
    expect(mockCreateFn).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({
        id: 'mem-1',
        botId: sampleBotId,
        knowledgeBaseId: 'kb-test',
        memoryType: 'user_note',
        content: sampleContent,
        createdAt: 1700000000000,
        updatedAt: 1700000000000
      })
    })
  })

  it('10. displays sanitized error banner when memory creation fails', async () => {
    mockCreateFn.mockRejectedValueOnce(
      new Error(
        'Failed to insert memory at C:\\Users\\secret\\workspace.db with key sk-proj-123456789012345'
      )
    )

    render(
      <TaskSummaryMemoryProposalModal
        isOpen={true}
        botId={sampleBotId}
        botName={sampleBotName}
        defaultContent={sampleContent}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-save-task-summary'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('task-summary-error')).toBeDefined()
    })

    const errorText = screen.getByTestId('task-summary-error').textContent ?? ''
    expect(errorText).toContain('[REDACTED_PATH]')
    expect(errorText).toContain('[REDACTED_KEY]')
    expect(errorText).not.toContain('C:\\Users\\secret')
    expect(errorText).not.toContain('sk-proj-123456789012345')
  })
})
