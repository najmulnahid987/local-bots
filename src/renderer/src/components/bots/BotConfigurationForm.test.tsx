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
      responsePolicy: 'balanced_kb_first',
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

  it('11. renders Knowledge and Response Behavior section with parent KB scope, Balanced default, and recommended badge', () => {
    render(
      <BotConfigurationForm
        knowledgeBaseName="Legal Archive KB"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    expect(screen.getByTestId('bot-response-policy-section')).toBeDefined()
    expect(screen.getByTestId('parent-kb-indicator').textContent).toContain('Legal Archive KB')
    expect(screen.getByTestId('policy-recommended-badge').textContent).toContain('Recommended')

    const strictRadio = screen
      .getByTestId('policy-option-strict_kb_only')
      .querySelector('input') as HTMLInputElement
    const balancedRadio = screen
      .getByTestId('policy-option-balanced_kb_first')
      .querySelector('input') as HTMLInputElement
    const generalRadio = screen
      .getByTestId('policy-option-general_ai_chat')
      .querySelector('input') as HTMLInputElement

    expect(balancedRadio.checked).toBe(true)
    expect(strictRadio.checked).toBe(false)
    expect(generalRadio.checked).toBe(false)
  })

  it('12. submits selected responsePolicy independently of enabledTools', async () => {
    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        initialValues={{
          name: 'Policy Switch Bot',
          providerConnectionId: 'conn-openai-1',
          modelId: 'gpt-6-luna',
          enabledTools: ['prepare_report']
        }}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={mockCatalog}
        connections={mockConnections}
      />
    )

    const generalRadio = screen
      .getByTestId('policy-option-general_ai_chat')
      .querySelector('input') as HTMLInputElement
    fireEvent.click(generalRadio)
    expect(generalRadio.checked).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
    })

    expect(handleSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Policy Switch Bot',
        responsePolicy: 'general_ai_chat',
        enabledTools: ['prepare_report']
      })
    )
  })

  it('13. supports Groq connections and displays dynamically discovered Groq models from connection summary', async () => {
    const groqCatalog: ProviderCatalogDto = {
      providers: [
        ...mockCatalog.providers,
        {
          id: 'groq',
          displayName: 'Groq',
          description: 'Groq LPU models',
          docUrl: 'https://console.groq.com/docs/models',
          isSupported: true,
          defaultModelId: 'llama-3.3-70b-versatile'
        }
      ],
      models: [
        ...mockCatalog.models,
        {
          id: 'llama-3.3-70b-versatile',
          providerId: 'groq',
          displayName: 'Llama 3.3 70B Versatile',
          description: 'Groq model',
          availability: 'stable',
          capabilities: {
            streaming: true,
            tools: true,
            imageInput: false,
            structuredOutput: false
          },
          docUrl: ''
        }
      ]
    }

    const groqConnection: ProviderConnectionSummary = {
      id: 'conn-groq-dynamic',
      providerId: 'groq',
      label: 'Groq Workspace Key',
      status: 'active',
      hasCredential: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      availableModels: ['llama-3.3-70b-versatile', 'groq/custom-discovered-90b']
    }

    const handleSubmit = vi.fn()
    render(
      <BotConfigurationForm
        initialValues={{
          name: 'Groq Dynamic UI Bot',
          providerConnectionId: 'conn-groq-dynamic',
          modelId: 'groq/custom-discovered-90b'
        }}
        onSubmit={handleSubmit}
        onCancel={vi.fn()}
        catalog={groqCatalog}
        connections={[groqConnection]}
      />
    )

    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    const optionValues = Array.from(modelSelect.options).map((o) => o.value)
    expect(optionValues).toContain('llama-3.3-70b-versatile')
    expect(optionValues).toContain('groq/custom-discovered-90b')
    expect(modelSelect.value).toBe('groq/custom-discovered-90b')

    await act(async () => {
      fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
    })

    expect(handleSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Groq Dynamic UI Bot',
        providerConnectionId: 'conn-groq-dynamic',
        modelId: 'groq/custom-discovered-90b'
      })
    )
  })

  it('14. renders searchable model filter and OpenRouter pricing/context/tools metadata for large discovered catalogs', async () => {
    const openrouterConn: ProviderConnectionSummary = {
      id: 'conn-openrouter-ui',
      providerId: 'openrouter',
      label: 'OpenRouter Key',
      status: 'active',
      hasCredential: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const discoveredCatalog = Array.from({ length: 8 }, (_, idx) => ({
      id: idx === 7 ? 'anthropic/claude-3.7-sonnet:thinking' : `vendor-${idx}/model-${idx}:free`,
      providerId: 'openrouter' as const,
      displayName: idx === 7 ? 'Claude 3.7 Sonnet Thinking' : `Vendor Model ${idx}`,
      description: 'OpenRouter model',
      availability: 'stable',
      contextWindow: { inputTokens: idx === 7 ? 200000 : 32000, outputTokens: 8192 },
      inputModalities: idx === 7 ? ['text', 'image'] : ['text'],
      pricing:
        idx === 7
          ? { promptPerTokenUsd: '0.000003', completionPerTokenUsd: '0.000015', isFree: false }
          : { promptPerTokenUsd: '0', completionPerTokenUsd: '0', isFree: true },
      providerCapabilities: {
        streaming: true,
        tools: idx === 7,
        imageInput: idx === 7,
        structuredOutput: idx === 7
      },
      capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
      docUrl: ''
    }))

    const orCatalog: ProviderCatalogDto = {
      providers: [
        ...mockCatalog.providers,
        {
          id: 'openrouter',
          displayName: 'OpenRouter',
          description: 'OpenRouter routing',
          docUrl: 'https://openrouter.ai/models',
          isSupported: true,
          defaultModelId: 'openrouter/auto'
        }
      ],
      models: [
        ...mockCatalog.models,
        {
          id: 'openrouter/auto',
          providerId: 'openrouter',
          displayName: 'OpenRouter Auto Router',
          description: 'Router',
          availability: 'stable',
          capabilities: {
            streaming: true,
            tools: false,
            imageInput: false,
            structuredOutput: false
          },
          docUrl: ''
        }
      ]
    }

    ;(window as unknown as { api: unknown }).api = {
      providers: {
        getAvailableModels: vi.fn().mockResolvedValue(discoveredCatalog)
      }
    }

    const handleSubmit = vi.fn()
    await act(async () => {
      render(
        <BotConfigurationForm
          initialValues={{
            name: 'OpenRouter Search Bot',
            providerConnectionId: 'conn-openrouter-ui',
            modelId: 'anthropic/claude-3.7-sonnet:thinking'
          }}
          onSubmit={handleSubmit}
          onCancel={vi.fn()}
          catalog={orCatalog}
          connections={[openrouterConn]}
        />
      )
    })

    const searchInput = screen.getByTestId('bot-model-search-input') as HTMLInputElement
    expect(searchInput).toBeTruthy()
    expect(screen.getByTestId('selected-model-metadata').textContent).toContain('200K ctx')
    expect(screen.getByTestId('selected-model-metadata').textContent).toContain('Tools supported')
    expect(screen.getByTestId('selected-model-metadata').textContent).toContain('$3.00/1M in')

    fireEvent.change(searchInput, { target: { value: 'vendor-2' } })
    const modelSelect = screen.getByTestId('bot-model-select') as HTMLSelectElement
    const visibleValues = Array.from(modelSelect.options).map((o) => o.value)
    expect(visibleValues).toContain('vendor-2/model-2:free')
    // Selected model remains safely preserved while filtering
    expect(visibleValues).toContain('anthropic/claude-3.7-sonnet:thinking')

    await act(async () => {
      fireEvent.click(screen.getByTestId('bot-form-submit-btn'))
    })
    expect(handleSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: 'conn-openrouter-ui',
        modelId: 'anthropic/claude-3.7-sonnet:thinking'
      })
    )
  })
})
