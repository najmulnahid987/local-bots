// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { CreateBotModal } from './CreateBotModal'
import type { BotDto, CreateBotRequest } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'

describe('Renderer: CreateBotModal (Phase 6 Step 6.5)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const mockCatalog: ProviderCatalogDto = {
    providers: [
      {
        id: 'openai',
        displayName: 'OpenAI',
        description: 'OpenAI',
        docUrl: '',
        isSupported: true,
        defaultModelId: 'gpt-6-luna'
      }
    ],
    models: [
      {
        id: 'gpt-6-luna',
        providerId: 'openai',
        displayName: 'GPT-6 Luna',
        description: '',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      }
    ]
  }

  const mockConnections: readonly ProviderConnectionSummary[] = [
    {
      id: 'conn-1',
      providerId: 'openai',
      label: 'Main OpenAI',
      status: 'active',
      hasCredential: true,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    }
  ]

  const mockCreatedBot: BotDto = {
    id: 'bot-new-1234',
    knowledgeBaseId: 'authoritative-kb-id',
    name: 'Research Bot',
    description: 'Summarizes papers',
    systemPrompt: 'Be concise.',
    providerConnectionId: 'conn-1',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  it('1. returns null when isOpen is false', () => {
    const { container } = render(
      <CreateBotModal
        isOpen={false}
        onClose={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('2. renders header and modal body when isOpen is true', () => {
    render(
      <CreateBotModal
        isOpen={true}
        onClose={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    expect(screen.getByTestId('create-bot-modal')).not.toBeNull()
    expect(screen.getByText('Create AI Bot')).not.toBeNull()
  })

  it('3. calls onClose when clicking the close button or cancel button', () => {
    const handleClose = vi.fn()
    render(
      <CreateBotModal
        isOpen={true}
        onClose={handleClose}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const closeBtn = screen.getByTestId('close-create-bot-modal-btn')
    fireEvent.click(closeBtn)
    expect(handleClose).toHaveBeenCalledTimes(1)

    const cancelBtn = screen.getByTestId('bot-form-cancel-btn')
    fireEvent.click(cancelBtn)
    expect(handleClose).toHaveBeenCalledTimes(2)
  })

  it('4. closes on Escape key', () => {
    const handleClose = vi.fn()
    render(
      <CreateBotModal
        isOpen={true}
        onClose={handleClose}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const backdrop = screen.getByTestId('create-bot-modal-backdrop')
    fireEvent.keyDown(backdrop, { key: 'Escape' })
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('5. creates bot successfully and strictly never passes knowledgeBaseId in request', async () => {
    const handleSuccess = vi.fn()
    const handleClose = vi.fn()
    let capturedRequest: CreateBotRequest | null = null

    const mockCreate = vi.fn(async (req: CreateBotRequest) => {
      capturedRequest = req
      return mockCreatedBot
    })

    render(
      <CreateBotModal
        isOpen={true}
        onClose={handleClose}
        onSuccess={handleSuccess}
        createBotFn={mockCreate}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    // Fill form
    const nameInput = screen.getByTestId('bot-name-input')
    fireEvent.change(nameInput, { target: { value: 'New Test Assistant' } })

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.name).toBe('New Test Assistant')
    // Invariant: knowledgeBaseId must never be in request payload
    expect(capturedRequest).not.toHaveProperty('knowledgeBaseId')

    expect(handleSuccess).toHaveBeenCalledWith(mockCreatedBot)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('6. keeps modal open and preserves user input when creation rejects', async () => {
    const handleClose = vi.fn()
    const mockCreate = vi.fn(async () => {
      throw new Error('Database write failure C:\\private\\vault.db')
    })

    render(
      <CreateBotModal
        isOpen={true}
        onClose={handleClose}
        createBotFn={mockCreate}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const nameInput = screen.getByTestId('bot-name-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Persistent Name' } })

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    // Modal remains open
    expect(handleClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('create-bot-modal')).not.toBeNull()

    // Error is displayed and sanitized
    const errorEl = screen.getByTestId('bot-form-error')
    expect(errorEl.textContent).toContain('Database write failure [REDACTED_PATH]')

    // Input preserved
    expect(nameInput.value).toBe('Persistent Name')
  })
})

