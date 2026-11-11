// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { BotConfigurationForm } from './BotConfigurationForm'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'

describe('Renderer: BotConfigurationForm (Phase 6 Step 6.5)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const mockCatalog: ProviderCatalogDto = {
    providers: [
      {
        id: 'openai',
        displayName: 'OpenAI',
        description: 'OpenAI models',
        docUrl: 'https://openai.com',
        isSupported: true,
        defaultModelId: 'gpt-6-luna'
      },
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        description: 'Anthropic models',
        docUrl: 'https://anthropic.com',
        isSupported: true,
        defaultModelId: 'claude-sonnet-5-5'
      },
      {
        id: 'google',
        displayName: 'Google Gemini',
        description: 'Google models',
        docUrl: 'https://google.com',
        isSupported: true,
        defaultModelId: 'gemini-3.8-flash'
      }
    ],
    models: [
      {
        id: 'gpt-6-luna',
        providerId: 'openai',
        displayName: 'GPT-6 Luna',
        description: 'Fast responsive model',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      },
      {
        id: 'gpt-6.1-sol',
        providerId: 'openai',
        displayName: 'GPT-6.1 Sol',
        description: 'Frontier reasoning model',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      },
      {
        id: 'claude-sonnet-5-5',
        providerId: 'anthropic',
        displayName: 'Claude Sonnet 5.5',
        description: 'Balanced intelligence model',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      },
      {
        id: 'gemini-3.8-flash',
        providerId: 'google',
        displayName: 'Gemini 3.8 Flash',
        description: 'High throughput model',
        availability: 'stable',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      },
      {
        id: 'gpt-deprecated',
        providerId: 'openai',
        displayName: 'Legacy Deprecated Model',
        description: 'Deprecated model',
        availability: 'deprecated',
        capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
        docUrl: ''
      }
    ]
  }

  const mockConnections: readonly ProviderConnectionSummary[] = [
    {
      id: 'conn-openai-1',
      providerId: 'openai',
      label: 'Work OpenAI Connection',
      status: 'active',
      hasCredential: true,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    },
    {
      id: 'conn-anthropic-1',
      providerId: 'anthropic',
      label: 'Claude Workspace Key',
      status: 'active',
      hasCredential: true,
      createdAt: 1700000010000,
      updatedAt: 1700000010000
    },
    {
      id: 'conn-google-1',
      providerId: 'google',
      label: 'Google Cloud Key',
      status: 'error',
      hasCredential: true,
      createdAt: 1700000020000,
      updatedAt: 1700000020000
    }
  ]

  it('1. renders with default values and filters out deprecated models', () => {
    render(
      <BotConfigurationForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const nameInput = screen.getByTestId('bot-name-input') as HTMLInputElement
    expect(nameInput.value).toBe('')

    const descInput = screen.getByTestId('bot-description-input') as HTMLInputElement
    expect(descInput.value).toBe('')

    const systemPromptInput = screen.getByTestId('bot-system-prompt-input') as HTMLTextAreaElement
    expect(systemPromptInput.value).toBe('')

    // Default connection is unassigned
    const providerSelect = screen.getByTestId('bot-provider-select') as HTMLSelectElement
    expect(providerSelect.value).toBe('')

    // Model select should contain non-deprecated models from all providers in unassigned mode
    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    expect(modelSelect.value).toBe('gpt-6-luna')
    expect(screen.queryByText(/Legacy Deprecated Model/)).toBeNull()

    // Default tools should be checked
    const searchKb = screen
      .getByTestId('tool-checkbox-search_knowledge_base')
      .querySelector('input')
    const readDoc = screen
      .getByTestId('tool-checkbox-read_knowledge_base_document')
      .querySelector('input')
    expect(searchKb?.checked).toBe(true)
    expect(readDoc?.checked).toBe(true)
  })

  it('2. validates required Bot name on submit', async () => {
    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    fireEvent.click(submitBtn)

    expect(handleSubmit).not.toHaveBeenCalled()
    const errorEl = screen.getByTestId('bot-name-error')
    expect(errorEl.textContent).toContain('Bot name cannot be blank.')
  })

  it('3. validates maximum name length (100 characters)', async () => {
    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        initialValues={{ name: 'a'.repeat(101) }}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    fireEvent.click(submitBtn)

    expect(handleSubmit).not.toHaveBeenCalled()
    const errorEl = screen.getByTestId('bot-name-error')
    expect(errorEl.textContent).toContain('Bot name cannot exceed 100 characters.')
  })

  it('4. displays connection list with labels and provider names without exposing credentials', () => {
    render(
      <BotConfigurationForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    expect(screen.getByText(/Work OpenAI Connection \(OpenAI\)/)).not.toBeNull()
    expect(screen.getByText(/Claude Workspace Key \(Anthropic\)/)).not.toBeNull()
    expect(screen.getByText(/Google Cloud Key \(Google Gemini\) \[error\]/)).not.toBeNull()
  })

  it('5. filters available models when selecting a provider connection', async () => {
    render(
      <BotConfigurationForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const providerSelect = screen.getByTestId('bot-provider-select')
    // Select Anthropic connection
    fireEvent.change(providerSelect, { target: { value: 'conn-anthropic-1' } })

    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    // Only Claude Sonnet 5.5 should be available
    expect(modelSelect.value).toBe('claude-sonnet-5-5')
    expect(screen.queryByText(/GPT-6 Luna/)).toBeNull()
    expect(screen.getByText(/Claude Sonnet 5.5/)).not.toBeNull()
  })

  it('6. automatically switches model when current model is incompatible with newly selected provider', () => {
    render(
      <BotConfigurationForm
        initialValues={{
          providerConnectionId: 'conn-openai-1',
          modelId: 'gpt-6-luna'
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const providerSelect = screen.getByTestId('bot-provider-select')
    // Switch from OpenAI to Anthropic
    fireEvent.change(providerSelect, { target: { value: 'conn-anthropic-1' } })

    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-sonnet-5-5')
  })

  it('7. allows toggling all six approved tool permissions independently', () => {
    render(
      <BotConfigurationForm
        initialValues={{ enabledTools: ['search_knowledge_base'] }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const searchKbCard = screen.getByTestId('tool-checkbox-search_knowledge_base')
    const reportCard = screen.getByTestId('tool-checkbox-prepare_report')

    const searchInput = searchKbCard.querySelector('input') as HTMLInputElement
    const reportInput = reportCard.querySelector('input') as HTMLInputElement

    expect(searchInput.checked).toBe(true)
    expect(reportInput.checked).toBe(false)

    // Toggle prepare_report ON
    fireEvent.click(reportInput)
    expect(reportInput.checked).toBe(true)

    // Toggle search_knowledge_base OFF
    fireEvent.click(searchInput)
    expect(searchInput.checked).toBe(false)
  })

  it('8. submits valid configuration with trimmed inputs', async () => {
    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        initialValues={{
          name: '  Lead Researcher  ',
          description: '  Summarizes deep tech briefs  ',
          systemPrompt: '  Be precise.  ',
          providerConnectionId: 'conn-openai-1',
          modelId: 'gpt-6.1-sol',
          enabledTools: ['search_knowledge_base', 'prepare_report']
        }}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const submitBtn = screen.getByTestId('bot-form-submit-btn')
    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(handleSubmit).toHaveBeenCalledTimes(1)
    expect(handleSubmit).toHaveBeenCalledWith({
      name: 'Lead Researcher',
      description: 'Summarizes deep tech briefs',
      systemPrompt: 'Be precise.',
      providerConnectionId: 'conn-openai-1',
      modelId: 'gpt-6.1-sol',
      enabledTools: ['search_knowledge_base', 'prepare_report']
    })
  })

  it('9. prevents submission and disables buttons while isSubmitting is true', () => {
    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        isSubmitting={true}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const submitBtn = screen.getByTestId('bot-form-submit-btn') as HTMLButtonElement
    const cancelBtn = screen.getByTestId('bot-form-cancel-btn') as HTMLButtonElement

    expect(submitBtn.disabled).toBe(true)
    expect(cancelBtn.disabled).toBe(true)
    expect(submitBtn.textContent).toContain('Saving...')

    fireEvent.click(submitBtn)
    expect(handleSubmit).not.toHaveBeenCalled()
  })

  it('10. renders error alert when error prop is supplied', () => {
    render(
      <BotConfigurationForm
        error="Model validation failed on the backend."
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const errorAlert = screen.getByTestId('bot-form-error')
    expect(errorAlert.textContent).toContain('Model validation failed on the backend.')
  })
})
