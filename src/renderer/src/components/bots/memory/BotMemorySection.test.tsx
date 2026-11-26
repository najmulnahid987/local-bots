// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { BotMemorySection } from './BotMemorySection'
import type { BotDto } from '../../../../../shared/bots'
import type { BotMemoryDto } from '../../../../../shared/bot-memories'

describe('Renderer: BotMemorySection (Phase 9 Step 9.3)', () => {
  const sampleBot: BotDto = {
    id: 'bot-1111-2222',
    knowledgeBaseId: 'kb-3333-4444',
    name: 'Research Assistant',
    description: 'Literature analysis',
    systemPrompt: 'Be concise.',
    providerConnectionId: 'conn-1',
    modelId: 'gpt-4o',
    responsePolicy: 'balanced_kb_first',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleMemories: readonly BotMemoryDto[] = [
    {
      id: 'mem-1',
      botId: 'bot-1111-2222',
      knowledgeBaseId: 'kb-3333-4444',
      memoryType: 'pinned_instruction',
      content: 'Always output citations in Harvard referencing format.',
      createdAt: 1700000001000,
      updatedAt: 1700000001000
    },
    {
      id: 'mem-2',
      botId: 'bot-1111-2222',
      knowledgeBaseId: 'kb-3333-4444',
      memoryType: 'user_note',
      content: 'User prefers concise executive bullet points.',
      createdAt: 1700000002000,
      updatedAt: 1700000002000
    }
  ]

  let mockListFn: ReturnType<typeof vi.fn>
  let mockCreateFn: ReturnType<typeof vi.fn>
  let mockUpdateFn: ReturnType<typeof vi.fn>
  let mockDeleteFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockListFn = vi.fn(async () => [...sampleMemories])
    mockCreateFn = vi.fn(async (input) => ({
      id: 'mem-new-99',
      botId: input.botId,
      knowledgeBaseId: 'kb-3333-4444',
      memoryType: input.memoryType ?? 'user_note',
      content: input.content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))
    mockUpdateFn = vi.fn(async (id, input) => {
      const existing = sampleMemories.find((m) => m.id === id) ?? sampleMemories[0]
      return {
        ...existing,
        ...input,
        updatedAt: Date.now()
      }
    })
    mockDeleteFn = vi.fn(async (id) => ({
      success: true,
      deletedId: id
    }))

    window.api = {
      botMemories: {
        list: mockListFn,
        create: mockCreateFn,
        update: mockUpdateFn,
        delete: mockDeleteFn,
        get: vi.fn(),
        count: vi.fn(async () => sampleMemories.length)
      }
    } as never
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('1. renders loading state while initial memories are being fetched', async () => {
    // Delay resolution to capture loading indicator
    let resolveList: (val: BotMemoryDto[]) => void = () => {}
    mockListFn.mockImplementation(
      () =>
        new Promise<BotMemoryDto[]>((resolve) => {
          resolveList = resolve
        })
    )

    render(<BotMemorySection bot={sampleBot} />)

    expect(screen.getByTestId('bot-memory-loading-state')).toBeDefined()
    expect(screen.getByText('Loading Bot memories...')).toBeDefined()

    await act(async () => {
      resolveList([...sampleMemories])
    })

    await waitFor(() => {
      expect(screen.queryByTestId('bot-memory-loading-state')).toBeNull()
    })
  })

  it('2. renders empty state when Bot has no saved memories', async () => {
    mockListFn.mockResolvedValueOnce([])

    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('bot-memory-empty-state')).toBeDefined()
    })

    expect(screen.getByText('No Memories Saved Yet')).toBeDefined()
    expect(screen.getByTestId('btn-create-first-memory')).toBeDefined()
  })

  it('3. renders error state with retry button when list API fails', async () => {
    mockListFn.mockRejectedValueOnce(new Error('Database disk I/O failure'))

    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('bot-memory-error-state')).toBeDefined()
    })

    expect(screen.getByText(/Database disk I\/O failure/)).toBeDefined()
    const retryBtn = screen.getByTestId('btn-retry-load-memories')
    expect(retryBtn).toBeDefined()

    // Clicking retry calls list again
    mockListFn.mockResolvedValueOnce([...sampleMemories])
    await act(async () => {
      fireEvent.click(retryBtn)
    })

    await waitFor(() => {
      expect(screen.getByTestId('bot-memory-list-container')).toBeDefined()
    })
  })

  it('4. renders memories cards, badges, and usage indicator', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
      expect(screen.getByTestId('bot-memory-card-mem-2')).toBeDefined()
    })

    // Badges
    expect(screen.getByTestId('memory-type-badge-mem-1').textContent).toContain(
      'Pinned Instruction'
    )
    expect(screen.getByTestId('memory-type-badge-mem-2').textContent).toContain('User Note')

    // Usage indicator
    expect(screen.getByTestId('bot-memory-usage-indicator')).toBeDefined()
    expect(screen.getByTestId('memory-breakdown-counts').textContent).toContain('1 pinned, 1 note')
    expect(screen.getByTestId('bot-memory-privacy-disclosure')).toBeDefined()
  })

  it('5. allows filtering memories by tab (All, Pinned, Notes) and search query', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
    })

    // Filter by Pinned
    fireEvent.click(screen.getByTestId('tab-memories-pinned'))
    expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
    expect(screen.queryByTestId('bot-memory-card-mem-2')).toBeNull()

    // Filter by Notes
    fireEvent.click(screen.getByTestId('tab-memories-notes'))
    expect(screen.queryByTestId('bot-memory-card-mem-1')).toBeNull()
    expect(screen.getByTestId('bot-memory-card-mem-2')).toBeDefined()

    // Back to All
    fireEvent.click(screen.getByTestId('tab-memories-all'))
    expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
    expect(screen.getByTestId('bot-memory-card-mem-2')).toBeDefined()

    // Search query
    const searchInput = screen.getByTestId('input-search-memories')
    fireEvent.change(searchInput, { target: { value: 'Harvard' } })
    expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
    expect(screen.queryByTestId('bot-memory-card-mem-2')).toBeNull()

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(screen.getByTestId('bot-memory-card-mem-1')).toBeDefined()
    expect(screen.getByTestId('bot-memory-card-mem-2')).toBeDefined()
  })

  it('6. creates a new memory via BotMemoryEditor modal', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-add-memory')).toBeDefined()
    })

    // Open Add Memory modal
    fireEvent.click(screen.getByTestId('btn-add-memory'))
    expect(screen.getByTestId('bot-memory-editor-modal')).toBeDefined()
    expect(screen.getByText('Add Bot Memory')).toBeDefined()

    // Type content
    const textarea = screen.getByTestId('textarea-memory-content')
    fireEvent.change(textarea, { target: { value: 'New domain guideline for testing' } })

    // Switch to Pinned Instruction
    fireEvent.click(screen.getByTestId('input-memory-type-pinned'))

    // Save
    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-save-memory'))
    })

    expect(mockCreateFn).toHaveBeenCalledWith({
      botId: 'bot-1111-2222',
      memoryType: 'pinned_instruction',
      content: 'New domain guideline for testing'
    })

    // Modal closed
    await waitFor(() => {
      expect(screen.queryByTestId('bot-memory-editor-modal')).toBeNull()
    })
  })

  it('7. validates empty memory content and disables save button', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-add-memory')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('btn-add-memory'))

    const saveBtn = screen.getByTestId('btn-save-memory') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    // Whitespace only
    const textarea = screen.getByTestId('textarea-memory-content')
    fireEvent.change(textarea, { target: { value: '    ' } })
    expect(saveBtn.disabled).toBe(true)

    // Valid text enables button
    fireEvent.change(textarea, { target: { value: 'Valid memory' } })
    expect(saveBtn.disabled).toBe(false)
  })

  it('8. edits an existing memory', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('memory-edit-btn-mem-1')).toBeDefined()
    })

    // Open edit for mem-1
    fireEvent.click(screen.getByTestId('memory-edit-btn-mem-1'))
    expect(screen.getByTestId('bot-memory-editor-modal')).toBeDefined()
    expect(screen.getByText('Edit Bot Memory')).toBeDefined()

    const textarea = screen.getByTestId('textarea-memory-content') as HTMLTextAreaElement
    expect(textarea.value).toBe(sampleMemories[0].content)

    // Edit content
    fireEvent.change(textarea, { target: { value: 'Updated citation format to APA.' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-save-memory'))
    })

    expect(mockUpdateFn).toHaveBeenCalledWith('mem-1', 'bot-1111-2222', {
      memoryType: 'pinned_instruction',
      content: 'Updated citation format to APA.'
    })

    await waitFor(() => {
      expect(screen.queryByTestId('bot-memory-editor-modal')).toBeNull()
    })
  })

  it('9. toggles pin status between pinned_instruction and user_note', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('memory-toggle-pin-btn-mem-1')).toBeDefined()
    })

    // Toggle pin on pinned instruction (mem-1) -> unpins to user_note
    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-toggle-pin-btn-mem-1'))
    })

    expect(mockUpdateFn).toHaveBeenCalledWith('mem-1', 'bot-1111-2222', {
      memoryType: 'user_note'
    })
  })

  it('10. deletes a memory with confirmation dialog', async () => {
    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('memory-delete-btn-mem-2')).toBeDefined()
    })

    // Click delete button -> opens dialog
    fireEvent.click(screen.getByTestId('memory-delete-btn-mem-2'))
    expect(screen.getByTestId('bot-memory-delete-modal')).toBeDefined()
    expect(screen.getByTestId('delete-memory-preview').textContent).toContain(
      sampleMemories[1].content
    )

    // Click cancel -> modal closes without calling API
    fireEvent.click(screen.getByTestId('btn-cancel-delete-memory'))
    expect(screen.queryByTestId('bot-memory-delete-modal')).toBeNull()
    expect(mockDeleteFn).not.toHaveBeenCalled()

    // Re-open and confirm
    fireEvent.click(screen.getByTestId('memory-delete-btn-mem-2'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-confirm-delete-memory'))
    })

    expect(mockDeleteFn).toHaveBeenCalledWith('mem-2', 'bot-1111-2222')
    await waitFor(() => {
      expect(screen.queryByTestId('bot-memory-delete-modal')).toBeNull()
    })
  })

  it('11. displays warning banner and disables creation when Bot is archived', async () => {
    const archivedBot: BotDto = { ...sampleBot, status: 'archived' }

    render(<BotMemorySection bot={archivedBot} isArchived={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('bot-archived-memory-warning')).toBeDefined()
    })

    expect(screen.queryByTestId('btn-add-memory')).toBeNull()

    // Cards have mutation buttons disabled
    const editBtn = screen.getByTestId('memory-edit-btn-mem-1') as HTMLButtonElement
    const deleteBtn = screen.getByTestId('memory-delete-btn-mem-1') as HTMLButtonElement
    const pinBtn = screen.getByTestId('memory-toggle-pin-btn-mem-1') as HTMLButtonElement

    expect(editBtn.disabled).toBe(true)
    expect(deleteBtn.disabled).toBe(true)
    expect(pinBtn.disabled).toBe(true)
  })

  it('12. displays budget overflow warning when stored tokens exceed 1,500 budget', async () => {
    // 1600 tokens = 6,400 chars
    const massiveContent = 'A'.repeat(6400)
    mockListFn.mockResolvedValueOnce([
      {
        id: 'mem-big',
        botId: 'bot-1111-2222',
        knowledgeBaseId: 'kb-3333-4444',
        memoryType: 'user_note',
        content: massiveContent,
        createdAt: 1700000000000,
        updatedAt: 1700000000000
      }
    ])

    render(<BotMemorySection bot={sampleBot} />)

    await waitFor(() => {
      expect(screen.getByTestId('memory-overflow-warning')).toBeDefined()
    })

    expect(screen.getByTestId('memory-overflow-warning').textContent).toContain(
      'exceed the per-turn budget'
    )
    expect(screen.getByTestId('memory-token-usage-text').textContent).toContain(
      '1,600 / 1,500 tokens'
    )
  })
})
