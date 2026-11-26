// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { EditBotModal } from './EditBotModal'
import type { BotDto, UpdateBotRequest } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'

describe('Renderer: EditBotModal (Phase 6 Step 6.5)', () => {
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
      },
      {
        id: 'gpt-6.1-sol',
        providerId: 'openai',
        displayName: 'GPT-6.1 Sol',
        description: '',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      }
    ]
  }

  const mockConnections: readonly ProviderConnectionSummary[] = [
    {
      id: 'conn-openai-42',
      providerId: 'openai',
      label: 'Main OpenAI',
      status: 'active',
      hasCredential: true,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    }
  ]

  const existingBot: BotDto = {
    id: 'bot-1111-2222',
    knowledgeBaseId: 'kb-test-01',
    name: 'Initial Bot Name',
    description: 'Initial bot description',
    systemPrompt: 'Initial system instructions',
    providerConnectionId: 'conn-openai-42',
    modelId: 'gpt-6-luna',
    responsePolicy: 'balanced_kb_first',
    enabledTools: ['search_knowledge_base', 'prepare_report'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  it('1. returns null when isOpen is false or bot is null', () => {
    const { container: c1 } = render(
      <EditBotModal
        isOpen={false}
        bot={existingBot}
        onClose={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(
      <EditBotModal
        isOpen={true}
        bot={null}
        onClose={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )
    expect(c2.firstChild).toBeNull()
  })

  it('2. prepopulates all existing configuration fields from bot prop', () => {
    render(
      <EditBotModal
        isOpen={true}
        bot={existingBot}
        onClose={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const nameInput = screen.getByTestId('bot-name-input') as HTMLInputElement
    expect(nameInput.value).toBe('Initial Bot Name')

    const descInput = screen.getByTestId('bot-description-input') as HTMLInputElement
    expect(descInput.value).toBe('Initial bot description')

    const promptInput = screen.getByTestId('bot-system-prompt-input') as HTMLTextAreaElement
    expect(promptInput.value).toBe('Initial system instructions')

    const providerSelect = screen.getByTestId('bot-provider-select') as HTMLSelectElement
    expect(providerSelect.value).toBe('conn-openai-42')

    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    expect(modelSelect.value).toBe('gpt-6-luna')

    const searchKb = screen
      .getByTestId('tool-checkbox-search_knowledge_base')
      .querySelector('input')
    const report = screen.getByTestId('tool-checkbox-prepare_report').querySelector('input')
    const readDoc = screen
      .getByTestId('tool-checkbox-read_knowledge_base_document')
      .querySelector('input')

    expect(searchKb?.checked).toBe(true)
    expect(report?.checked).toBe(true)
    expect(readDoc?.checked).toBe(false)
  })

  it('3. updates bot successfully and passes strictly mutable fields in request', async () => {
    const handleSuccess = vi.fn()
    const handleClose = vi.fn()
    let capturedBotId: string | null = null
    let capturedRequest: UpdateBotRequest | null = null

    const mockUpdate = vi.fn(async (id: string, req: UpdateBotRequest) => {
      capturedBotId = id
      capturedRequest = req
      return {
        ...existingBot,
        ...req,
        name: req.name ?? existingBot.name,
        updatedAt: Date.now()
      }
    })

    render(
      <EditBotModal
        isOpen={true}
        bot={existingBot}
        onClose={handleClose}
        onSuccess={handleSuccess}
        updateBotFn={mockUpdate}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const nameInput = screen.getByTestId('bot-name-input')
    fireEvent.change(nameInput, { target: { value: 'Modified Bot Name' } })

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(capturedBotId).toBe('bot-1111-2222')
    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.name).toBe('Modified Bot Name')

    // Immutable fields must never be in UpdateBotRequest
    expect(capturedRequest).not.toHaveProperty('id')
    expect(capturedRequest).not.toHaveProperty('knowledgeBaseId')
    expect(capturedRequest).not.toHaveProperty('createdAt')
    expect(capturedRequest).not.toHaveProperty('status')

    expect(handleSuccess).toHaveBeenCalledTimes(1)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('4. preserves user changes and keeps modal open when update fails', async () => {
    const handleClose = vi.fn()
    const mockUpdate = vi.fn(async () => {
      throw new Error('Connection error updating bot C:\\Users\\secret')
    })

    render(
      <EditBotModal
        isOpen={true}
        bot={existingBot}
        onClose={handleClose}
        updateBotFn={mockUpdate}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const nameInput = screen.getByTestId('bot-name-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Attempted Name' } })

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(handleClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('edit-bot-modal')).not.toBeNull()

    const errorEl = screen.getByTestId('bot-form-error')
    expect(errorEl.textContent).toContain('Connection error updating bot [REDACTED_PATH]')
    expect(nameInput.value).toBe('Attempted Name')
  })

  it('7. loads existing responsePolicy, updates it without mutating tools, and does not retain failed draft on reopen', async () => {
    const strictBot: BotDto = {
      ...existingBot,
      responsePolicy: 'strict_kb_only',
      enabledTools: ['search_knowledge_base', 'prepare_report']
    }

    const failingUpdate = vi.fn(async () => {
      throw new Error('Save failed temporarily')
    })

    const handleClose = vi.fn()
    const { rerender } = render(
      <EditBotModal
        isOpen={true}
        bot={strictBot}
        onClose={handleClose}
        updateBotFn={failingUpdate}
        catalog={mockCatalog}
        connections={mockConnections}
        knowledgeBaseName="Compliance KB"
      />
    )

    expect(screen.getByTestId('parent-kb-indicator').textContent).toContain('Compliance KB')
    const strictRadio = screen
      .getByTestId('policy-option-strict_kb_only')
      .querySelector('input') as HTMLInputElement
    expect(strictRadio.checked).toBe(true)

    const generalRadio = screen
      .getByTestId('policy-option-general_ai_chat')
      .querySelector('input') as HTMLInputElement
    fireEvent.click(generalRadio)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
    })
    expect(screen.getByTestId('bot-form-error').textContent).toContain('Save failed temporarily')

    // Close and reopen -> reverts to persisted strict_kb_only
    rerender(
      <EditBotModal
        isOpen={false}
        bot={strictBot}
        onClose={handleClose}
        updateBotFn={failingUpdate}
        catalog={mockCatalog}
        connections={mockConnections}
        knowledgeBaseName="Compliance KB"
      />
    )
    const succeedUpdate = vi.fn(async (_id: string, req: UpdateBotRequest) => ({
      ...strictBot,
      responsePolicy: req.responsePolicy ?? strictBot.responsePolicy,
      updatedAt: strictBot.updatedAt + 100
    }))
    rerender(
      <EditBotModal
        isOpen={true}
        bot={strictBot}
        onClose={handleClose}
        updateBotFn={succeedUpdate}
        catalog={mockCatalog}
        connections={mockConnections}
        knowledgeBaseName="Compliance KB"
      />
    )

    const reopenedStrict = screen
      .getByTestId('policy-option-strict_kb_only')
      .querySelector('input') as HTMLInputElement
    expect(reopenedStrict.checked).toBe(true)

    const reopenedBalanced = screen
      .getByTestId('policy-option-balanced_kb_first')
      .querySelector('input') as HTMLInputElement
    fireEvent.click(reopenedBalanced)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
    })

    expect(succeedUpdate).toHaveBeenCalledWith(
      strictBot.id,
      expect.objectContaining({
        responsePolicy: 'balanced_kb_first',
        enabledTools: ['search_knowledge_base', 'prepare_report']
      })
    )
    expect(handleClose).toHaveBeenCalledTimes(1)
  })
})
