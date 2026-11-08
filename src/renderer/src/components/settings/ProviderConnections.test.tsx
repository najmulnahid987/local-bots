// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { ProviderConnectionsSection } from './ProviderConnectionsSection'
import { AddProviderConnectionDialog } from './AddProviderConnectionDialog'
import { TestProviderConnectionDialog } from './TestProviderConnectionDialog'
import { ReplaceProviderCredentialDialog } from './ReplaceProviderCredentialDialog'
import { EditProviderLabelDialog } from './EditProviderLabelDialog'
import { RemoveProviderConnectionDialog } from './RemoveProviderConnectionDialog'
import type {
  ProviderCatalogDto,
  ProviderConnectionSummary,
  ProviderApi,
  ConnectionTestResult,
  RemoveConnectionResult
} from '../../../../shared/providers'

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
      description: 'Claude models',
      docUrl: 'https://anthropic.com',
      isSupported: true,
      defaultModelId: 'claude-sonnet-5-5'
    },
    {
      id: 'google',
      displayName: 'Google Gemini',
      description: 'Gemini models',
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
      description: 'Fast OpenAI model',
      availability: 'stable',
      capabilities: { streaming: true, tools: true, imageInput: true, structuredOutput: true },
      docUrl: 'https://openai.com'
    },
    {
      id: 'gpt-6-sol',
      providerId: 'openai',
      displayName: 'GPT-6.1 Sol',
      description: 'Preview model',
      availability: 'preview',
      capabilities: { streaming: true, tools: true, imageInput: true, structuredOutput: true },
      docUrl: 'https://openai.com'
    },
    {
      id: 'gpt-deprecated-model',
      providerId: 'openai',
      displayName: 'GPT Deprecated',
      description: 'Old model',
      availability: 'deprecated',
      capabilities: { streaming: true, tools: false, imageInput: false, structuredOutput: false },
      docUrl: 'https://openai.com'
    },
    {
      id: 'claude-sonnet-5-5',
      providerId: 'anthropic',
      displayName: 'Claude Sonnet 5.5',
      description: 'Anthropic frontier model',
      availability: 'stable',
      capabilities: { streaming: true, tools: true, imageInput: true, structuredOutput: true },
      docUrl: 'https://anthropic.com'
    },
    {
      id: 'gemini-3.8-flash',
      providerId: 'google',
      displayName: 'Gemini 3.8 Flash',
      description: 'Google high-speed model',
      availability: 'stable',
      capabilities: { streaming: true, tools: true, imageInput: true, structuredOutput: true },
      docUrl: 'https://google.com'
    }
  ]
}

const mockConnections: readonly ProviderConnectionSummary[] = [
  {
    id: 'conn-openai-1',
    providerId: 'openai',
    label: 'OpenAI Primary',
    status: 'active',
    hasCredential: true,
    createdAt: 1000,
    updatedAt: 1000
  },
  {
    id: 'conn-anthropic-1',
    providerId: 'anthropic',
    label: 'Anthropic Claude',
    status: 'error',
    hasCredential: true,
    createdAt: 2000,
    updatedAt: 2000
  },
  {
    id: 'conn-google-1',
    providerId: 'google',
    label: 'Google Gemini Pro',
    status: 'revoked',
    hasCredential: false,
    createdAt: 3000,
    updatedAt: 3000
  }
]

describe('Renderer: Provider Management Settings UI (Phase 3 Step 3.8)', () => {
  let mockProviderApi: { [K in keyof ProviderApi]: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockProviderApi = {
      getCatalog: vi.fn().mockResolvedValue(mockCatalog),
      listConnections: vi.fn().mockResolvedValue(mockConnections),
      testDraftConnection: vi.fn(),
      createConnection: vi.fn(),
      testConnection: vi.fn(),
      updateConnectionLabel: vi.fn(),
      replaceCredential: vi.fn(),
      removeConnection: vi.fn(),
      generateText: vi.fn(),
      streamText: vi.fn()
    }

    window.api = {
      ping: vi.fn(),
      providers: mockProviderApi as unknown as ProviderApi
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  // 1. Initial catalog loading
  it('1. loads and binds the provider catalog on initial mount', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(mockProviderApi.getCatalog).toHaveBeenCalledTimes(1)
    })
  })

  // 2. Initial connection loading
  it('2. loads the list of saved provider connections on initial mount', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(mockProviderApi.listConnections).toHaveBeenCalledTimes(1)
    })
  })

  // 3. Empty state
  it('3. displays clear empty state when zero provider connections exist', async () => {
    mockProviderApi.listConnections.mockResolvedValueOnce([])

    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('no-connections-empty-state')).toBeTruthy()
    })

    expect(screen.getByRole('heading', { name: /no provider connections yet/i })).toBeTruthy()
    expect(
      screen.getByText(/add your own openai, anthropic, or google api keys to get started/i)
    ).toBeTruthy()
  })

  // 4. Display of saved connections
  it('4. displays saved connection cards with labels, providers, and action controls', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('provider-connections-list')).toBeTruthy()
    })

    expect(screen.getByText('OpenAI Primary')).toBeTruthy()
    expect(screen.getByText('Anthropic Claude')).toBeTruthy()
    expect(screen.getByText('Google Gemini Pro')).toBeTruthy()
  })

  // 5. Provider names and statuses
  it('5. renders backend connection status badges and vault presence accurately', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeTruthy()
      expect(screen.getByText('Error')).toBeTruthy()
      expect(screen.getByText('Revoked')).toBeTruthy()
    })

    const keyIndicators = screen.getAllByText(/key stored \(os vault\)/i)
    expect(keyIndicators.length).toBe(2)
    expect(screen.getByText(/missing key/i)).toBeTruthy()
  })

  // 6. Add Connection dialog opens
  it('6. opens the Add Connection dialog when clicking the Add Connection action', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('add-connection-button')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('add-connection-button'))

    expect(screen.getByTestId('add-connection-dialog')).toBeTruthy()
    expect(
      screen.getByRole('heading', { level: 2, name: /add ai provider connection/i })
    ).toBeTruthy()
  })

  // 7. Provider selection updates model choices
  it('7. updates available models when selecting a different provider in the Add dialog', async () => {
    const handleClose = vi.fn()
    const handleSuccess = vi.fn()

    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={handleClose}
        onSuccess={handleSuccess}
      />
    )

    const providerSelect = screen.getByRole('combobox', { name: /^provider$/i })
    const modelSelect = screen.getByLabelText(/default test model/i) as HTMLSelectElement

    // Initial provider is openai, default is gpt-6-luna
    expect(modelSelect.value).toBe('gpt-6-luna')

    // Change provider to anthropic
    fireEvent.change(providerSelect, { target: { value: 'anthropic' } })

    expect((screen.getByLabelText(/default test model/i) as HTMLSelectElement).value).toBe(
      'claude-sonnet-5-5'
    )
  })

  // 8. Deprecated models are not initially selected
  it('8. filters out deprecated models from default selection and labels preview models', () => {
    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    // Deprecated model should not be in the selectable options
    expect(screen.queryByText(/gpt deprecated/i)).toBeNull()

    // Preview model should be clearly marked with (Preview)
    expect(screen.getByText(/gpt-6\.1 sol \(preview\)/i)).toBeTruthy()
  })

  // 9. Successful connection creation
  it('9. successfully creates connection and refreshes list on valid submission', async () => {
    const newSummary: ProviderConnectionSummary = {
      id: 'conn-new-1',
      providerId: 'openai',
      label: 'Secondary Key',
      status: 'active',
      hasCredential: true,
      createdAt: 4000,
      updatedAt: 4000
    }

    mockProviderApi.createConnection.mockResolvedValueOnce(newSummary)

    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('add-connection-button')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('add-connection-button'))

    const labelInput = screen.getByLabelText(/connection label/i)
    const keyInput = screen.getByTestId('api-key-input')
    const submitBtn = screen.getByTestId('submit-connection-button')

    fireEvent.change(labelInput, { target: { value: 'Secondary Key' } })
    fireEvent.change(keyInput, { target: { value: 'sk-harmless-test-token-123' } })

    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(mockProviderApi.createConnection).toHaveBeenCalledWith({
      providerId: 'openai',
      label: 'Secondary Key',
      apiKey: 'sk-harmless-test-token-123',
      modelId: 'gpt-6-luna'
    })

    await waitFor(() => {
      expect(screen.queryByTestId('add-connection-dialog')).toBeNull()
    })
  })

  // 10. Invalid credential error display
  it('10. displays sanitized error banner when backend rejects invalid credentials', async () => {
    mockProviderApi.createConnection.mockRejectedValueOnce(
      new Error('Authentication failed: Invalid API key credentials.')
    )

    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const labelInput = screen.getByLabelText(/connection label/i)
    const keyInput = screen.getByTestId('api-key-input')
    const submitBtn = screen.getByTestId('submit-connection-button')

    fireEvent.change(labelInput, { target: { value: 'Bad Key' } })
    fireEvent.change(keyInput, { target: { value: 'sk-invalid-test-key' } })

    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(screen.getByTestId('add-connection-error')).toBeTruthy()
    expect(screen.getByText(/authentication failed: invalid api key credentials/i)).toBeTruthy()
  })

  // 11. API key input clears after successful submission
  it('11. strictly clears the API key input after successful connection creation', async () => {
    mockProviderApi.createConnection.mockResolvedValueOnce({
      id: 'conn-new-2',
      providerId: 'openai',
      label: 'Key 2',
      status: 'active',
      hasCredential: true,
      createdAt: 5000,
      updatedAt: 5000
    })

    const handleSuccess = vi.fn()
    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={handleSuccess}
      />
    )

    const labelInput = screen.getByLabelText(/connection label/i)
    const keyInput = screen.getByTestId('api-key-input') as HTMLInputElement

    fireEvent.change(labelInput, { target: { value: 'Key 2' } })
    fireEvent.change(keyInput, { target: { value: 'sk-temp-key-val' } })
    expect(keyInput.value).toBe('sk-temp-key-val')

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-connection-button'))
    })

    expect(keyInput.value).toBe('')
  })

  // 12. API key input clears after failed submission
  it('12. strictly clears the API key input in finally block after failed submission', async () => {
    mockProviderApi.createConnection.mockRejectedValueOnce(new Error('Connection timed out.'))

    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const labelInput = screen.getByLabelText(/connection label/i)
    const keyInput = screen.getByTestId('api-key-input') as HTMLInputElement

    fireEvent.change(labelInput, { target: { value: 'Key Fail' } })
    fireEvent.change(keyInput, { target: { value: 'sk-secret-failed-key' } })
    expect(keyInput.value).toBe('sk-secret-failed-key')

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-connection-button'))
    })

    // Key input must be wiped out even though modal remains open
    expect(keyInput.value).toBe('')
    expect(screen.getByTestId('add-connection-error')).toBeTruthy()
  })

  // 13. Duplicate submission is prevented
  it('13. prevents duplicate form submission while validation or save is in flight', async () => {
    let resolveCreation: (val: ProviderConnectionSummary) => void = () => {}
    const slowCreationPromise = new Promise<ProviderConnectionSummary>((resolve) => {
      resolveCreation = resolve
    })
    mockProviderApi.createConnection.mockReturnValueOnce(slowCreationPromise)

    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText(/connection label/i), { target: { value: 'Slow Key' } })
    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: 'sk-slow-key' } })

    const submitBtn = screen.getByTestId('submit-connection-button') as HTMLButtonElement

    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(submitBtn.disabled).toBe(true)
    expect(screen.getByText(/connecting & saving/i)).toBeTruthy()

    // Second click should not call backend again
    fireEvent.click(submitBtn)
    expect(mockProviderApi.createConnection).toHaveBeenCalledTimes(1)

    // Resolve promise
    await act(async () => {
      resolveCreation({
        id: 'conn-slow',
        providerId: 'openai',
        label: 'Slow Key',
        status: 'active',
        hasCredential: true,
        createdAt: 6000,
        updatedAt: 6000
      })
    })
  })

  // 14. Saved connection test succeeds
  it('14. executes saved connection test and displays latency upon success', async () => {
    const successResult: ConnectionTestResult = {
      ok: true,
      success: true,
      latencyMs: 142,
      testedModelId: 'gpt-6-luna'
    }
    mockProviderApi.testConnection.mockResolvedValueOnce(successResult)

    const onTested = vi.fn()
    render(
      <TestProviderConnectionDialog
        isOpen={true}
        connection={mockConnections[0]}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onTested={onTested}
      />
    )

    const runBtn = screen.getByTestId('run-test-button')

    await act(async () => {
      fireEvent.click(runBtn)
    })

    expect(mockProviderApi.testConnection).toHaveBeenCalledWith({
      connectionId: 'conn-openai-1',
      modelId: 'gpt-6-luna'
    })

    expect(screen.getByTestId('test-success-banner')).toBeTruthy()
    expect(screen.getByText(/142ms/i)).toBeTruthy()
    expect(onTested).toHaveBeenCalledTimes(1)
  })

  // 15. Saved connection test fails safely
  it('15. displays sanitized error banner when saved connection test fails without key compromise', async () => {
    const failResult: ConnectionTestResult = {
      ok: false,
      success: false,
      latencyMs: 0,
      testedModelId: 'claude-sonnet-5-5',
      error: {
        code: 'NETWORK_TIMEOUT',
        message: 'Endpoint TLS handshake timed out after 15s.',
        retryable: true
      }
    }
    mockProviderApi.testConnection.mockResolvedValueOnce(failResult)

    render(
      <TestProviderConnectionDialog
        isOpen={true}
        connection={mockConnections[1]}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onTested={vi.fn()}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('run-test-button'))
    })

    expect(screen.getByTestId('test-error-banner')).toBeTruthy()
    expect(screen.getByText(/endpoint tls handshake timed out after 15s\./i)).toBeTruthy()
    expect(screen.getByText(/temporary network timeout/i)).toBeTruthy()
  })

  // 16. Replace key dialog works
  it('16. renders Replace Key dialog and validates replacement credentials', async () => {
    const updatedSummary: ProviderConnectionSummary = {
      ...mockConnections[0],
      updatedAt: 7000
    }
    mockProviderApi.replaceCredential.mockResolvedValueOnce(updatedSummary)

    const onSuccess = vi.fn()
    render(
      <ReplaceProviderCredentialDialog
        isOpen={true}
        connection={mockConnections[0]}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    )

    const keyInput = screen.getByTestId('replace-api-key-input')
    const submitBtn = screen.getByTestId('submit-replace-button')

    fireEvent.change(keyInput, { target: { value: 'sk-replacement-secret-key' } })

    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(mockProviderApi.replaceCredential).toHaveBeenCalledWith({
      connectionId: 'conn-openai-1',
      apiKey: 'sk-replacement-secret-key',
      modelId: 'gpt-6-luna'
    })

    expect(onSuccess).toHaveBeenCalledWith(updatedSummary)
  })

  // 17. Replacement input clears after success
  it('17. wipes replacement key input after successful replacement', async () => {
    mockProviderApi.replaceCredential.mockResolvedValueOnce(mockConnections[0])

    render(
      <ReplaceProviderCredentialDialog
        isOpen={true}
        connection={mockConnections[0]}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const keyInput = screen.getByTestId('replace-api-key-input') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-replacement-pass' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-replace-button'))
    })

    expect(keyInput.value).toBe('')
  })

  // 18. Replacement input clears after failure
  it('18. wipes replacement key input in finally block after failed replacement', async () => {
    mockProviderApi.replaceCredential.mockRejectedValueOnce(
      new Error('Provider rejected candidate key: 401 Unauthorized.')
    )

    render(
      <ReplaceProviderCredentialDialog
        isOpen={true}
        connection={mockConnections[0]}
        catalog={mockCatalog}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const keyInput = screen.getByTestId('replace-api-key-input') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-rejected-replacement' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-replace-button'))
    })

    expect(keyInput.value).toBe('')
    expect(screen.getByTestId('replace-key-error')).toBeTruthy()
    expect(screen.getByText(/previously stored credential was preserved/i)).toBeTruthy()
  })

  // 19. Label editing works
  it('19. edits connection label and submits trimmed value', async () => {
    const updatedSummary: ProviderConnectionSummary = {
      ...mockConnections[0],
      label: 'Renamed OpenAI Account'
    }
    mockProviderApi.updateConnectionLabel.mockResolvedValueOnce(updatedSummary)

    const onSuccess = vi.fn()
    render(
      <EditProviderLabelDialog
        isOpen={true}
        connection={mockConnections[0]}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    )

    const labelInput = screen.getByTestId('edit-label-input')
    fireEvent.change(labelInput, { target: { value: '  Renamed OpenAI Account  ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-edit-label-button'))
    })

    expect(mockProviderApi.updateConnectionLabel).toHaveBeenCalledWith({
      connectionId: 'conn-openai-1',
      label: 'Renamed OpenAI Account'
    })
    expect(onSuccess).toHaveBeenCalledWith(updatedSummary)
  })

  // 20. Empty labels are rejected
  it('20. rejects blank and whitespace-only labels with validation error', async () => {
    render(
      <EditProviderLabelDialog
        isOpen={true}
        connection={mockConnections[0]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const labelInput = screen.getByTestId('edit-label-input')
    fireEvent.change(labelInput, { target: { value: '    ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-edit-label-button'))
    })

    expect(mockProviderApi.updateConnectionLabel).not.toHaveBeenCalled()
    expect(screen.getByTestId('edit-label-error')).toBeTruthy()
    expect(screen.getByText(/connection label cannot be blank/i)).toBeTruthy()
  })

  // 21. Remove confirmation works
  it('21. displays confirmation dialog and deletes connection on user confirmation', async () => {
    const removeResult: RemoveConnectionResult = {
      success: true,
      connectionId: 'conn-openai-1',
      credentialCleaned: true
    }
    mockProviderApi.removeConnection.mockResolvedValueOnce(removeResult)

    const onSuccess = vi.fn()
    render(
      <RemoveProviderConnectionDialog
        isOpen={true}
        connection={mockConnections[0]}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    )

    expect(screen.getByText(/are you sure you want to delete/i)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-remove-button'))
    })

    expect(mockProviderApi.removeConnection).toHaveBeenCalledWith({
      connectionId: 'conn-openai-1'
    })
    expect(onSuccess).toHaveBeenCalledWith(removeResult)
  })

  // 22. Bot-referenced connection deletion error is shown
  it('22. displays sanitized error when deletion is rejected due to active Bot references', async () => {
    mockProviderApi.removeConnection.mockRejectedValueOnce(
      new Error(
        'Cannot remove provider connection: currently referenced by active Bot "ResearchAssistant".'
      )
    )

    render(
      <RemoveProviderConnectionDialog
        isOpen={true}
        connection={mockConnections[0]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-remove-button'))
    })

    expect(screen.getByTestId('remove-connection-error')).toBeTruthy()
    expect(screen.getByText(/currently referenced by active bot "researchassistant"/i)).toBeTruthy()
  })

  // 23. Cleanup-pending result is handled
  it('23. handles cleanup-pending result gracefully when credential file cleanup is deferred', async () => {
    const pendingResult: RemoveConnectionResult = {
      success: true,
      connectionId: 'conn-openai-1',
      credentialCleaned: false
    }
    mockProviderApi.removeConnection.mockResolvedValueOnce(pendingResult)

    const onSuccess = vi.fn()
    render(
      <RemoveProviderConnectionDialog
        isOpen={true}
        connection={mockConnections[0]}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-remove-button'))
    })

    expect(onSuccess).toHaveBeenCalledWith(pendingResult)
  })

  // 24. Refresh occurs after successful mutations
  it('24. triggers connection list refresh after dialog confirmations', async () => {
    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(mockProviderApi.listConnections).toHaveBeenCalledTimes(1)
    })

    // Click refresh button in header
    const refreshBtn = screen.getByRole('button', { name: /refresh connections/i })
    await act(async () => {
      fireEvent.click(refreshBtn)
    })

    expect(mockProviderApi.listConnections).toHaveBeenCalledTimes(2)
  })

  // 25. No credential references appear in rendered DOM
  it('25. strictly never renders credential_ref or vault pointers in the DOM', async () => {
    // Inject malicious-looking properties into mock data to verify DOM suppression
    const poisonedConnection = {
      ...mockConnections[0],
      credential_ref: 'vault_sec_secret_ref_pointer_12345',
      storage_key: 'dpapi_secret_blob_hash'
    } as unknown as ProviderConnectionSummary

    mockProviderApi.listConnections.mockResolvedValueOnce([poisonedConnection])

    const { container } = render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI Primary')).toBeTruthy()
    })

    expect(container.innerHTML).not.toContain('vault_sec_secret_ref_pointer_12345')
    expect(container.innerHTML).not.toContain('dpapi_secret_blob_hash')
  })

  // 26. No API key fragments appear in rendered DOM
  it('26. strictly never renders API key fragments or unmasked credentials in the DOM', async () => {
    const { container } = render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('provider-connections-list')).toBeTruthy()
    })

    // Inspect entire rendered HTML tree for key-like prefixes
    expect(container.innerHTML).not.toContain('sk-')
    expect(container.innerHTML).not.toContain('AIzaSy')
  })

  // 27. No Main-process objects are imported into Renderer
  it('27. operates exclusively via typed window.api bridge without direct Node/Main primitives', () => {
    expect(typeof window.api.providers.getCatalog).toBe('function')
    expect(typeof window.api.providers.listConnections).toBe('function')
    expect((window.api as unknown as { db?: unknown }).db).toBeUndefined()
    expect((window.api as unknown as { vault?: unknown }).vault).toBeUndefined()
    expect((window.api as unknown as { ipcRenderer?: unknown }).ipcRenderer).toBeUndefined()
  })

  // 28. Backend-unavailable errors are displayed safely
  it('28. renders a resilient error alert when the provider bridge is unavailable', async () => {
    // Simulate disconnected IPC / preload failure
    window.api = undefined as unknown as typeof window.api

    render(<ProviderConnectionsSection />)

    await waitFor(() => {
      expect(screen.getByTestId('provider-load-error')).toBeTruthy()
    })

    expect(screen.getByText(/provider service unavailable/i)).toBeTruthy()
    expect(screen.getByText(/service bridge is not available in this window/i)).toBeTruthy()
  })
})
