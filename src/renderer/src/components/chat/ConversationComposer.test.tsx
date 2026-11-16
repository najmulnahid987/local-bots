// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ConversationComposer } from './ConversationComposer'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: ConversationComposer (Agent Task Mode & Permissions)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleBotWithoutWorkspaceTools: BotDto = {
    id: 'bot-01',
    knowledgeBaseId: 'kb-01',
    name: 'KB Bot',
    description: 'Knowledge base only bot',
    systemPrompt: 'You are helpful.',
    providerConnectionId: 'conn-01',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base', 'read_knowledge_source'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleBotWithWorkspaceTools: BotDto = {
    id: 'bot-02',
    knowledgeBaseId: 'kb-01',
    name: 'Full Agent Bot',
    description: 'Bot with filesystem access',
    systemPrompt: 'You are helpful.',
    providerConnectionId: 'conn-01',
    modelId: 'gpt-6-luna',
    enabledTools: [
      'search_knowledge_base',
      'read_knowledge_source',
      'search_workspace_files',
      'read_workspace_file'
    ],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  it('renders in Chat mode by default', () => {
    const handleSend = vi.fn().mockResolvedValue(undefined)
    render(
      <ConversationComposer
        bot={sampleBotWithoutWorkspaceTools}
        onSend={handleSend}
        isGenerating={false}
      />
    )

    const chatBtn = screen.getByTestId('composer-mode-chat-btn')
    const agentBtn = screen.getByTestId('composer-mode-agent-btn')

    expect(chatBtn.getAttribute('aria-pressed')).toBe('true')
    expect(agentBtn.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('send-message-btn')).toBeDefined()
    expect(screen.queryByTestId('workspace-access-checkbox')).toBeNull()
  })

  it('sends ordinary chat message via onSend in Chat mode', async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined)
    const handleDispatch = vi.fn().mockResolvedValue(undefined)

    render(
      <ConversationComposer
        bot={sampleBotWithoutWorkspaceTools}
        onSend={handleSend}
        onDispatchTask={handleDispatch}
        isGenerating={false}
      />
    )

    const textarea = screen.getByTestId('message-input')
    fireEvent.change(textarea, { target: { value: 'Hello assistant' } })

    const sendBtn = screen.getByTestId('send-message-btn')
    expect(sendBtn.getAttribute('disabled')).toBeNull()
    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith('Hello assistant')
      expect(handleDispatch).not.toHaveBeenCalled()
    })
  })

  it('disables workspace folder checkbox if bot does not possess workspace tools', () => {
    render(
      <ConversationComposer
        bot={sampleBotWithoutWorkspaceTools}
        onSend={vi.fn()}
        isGenerating={false}
      />
    )

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))

    const checkbox = screen.getByTestId('workspace-access-checkbox') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.checked).toBe(false)
  })

  it('enables workspace folder checkbox if bot has workspace tools', () => {
    render(
      <ConversationComposer
        bot={sampleBotWithWorkspaceTools}
        onSend={vi.fn()}
        isGenerating={false}
      />
    )

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))

    const checkbox = screen.getByTestId('workspace-access-checkbox') as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
  })

  it('dispatches task via onDispatchTask with workspaceAccessRequested flag', async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined)
    const handleDispatch = vi.fn().mockResolvedValue(undefined)

    render(
      <ConversationComposer
        bot={sampleBotWithWorkspaceTools}
        onSend={handleSend}
        onDispatchTask={handleDispatch}
        isGenerating={false}
      />
    )

    fireEvent.click(screen.getByTestId('composer-mode-agent-btn'))

    const checkbox = screen.getByTestId('workspace-access-checkbox')
    fireEvent.click(checkbox)

    const textarea = screen.getByTestId('message-input')
    fireEvent.change(textarea, { target: { value: 'Audit the package.json dependencies' } })

    const dispatchBtn = screen.getByTestId('dispatch-task-btn')
    fireEvent.click(dispatchBtn)

    await waitFor(() => {
      expect(handleDispatch).toHaveBeenCalledWith('Audit the package.json dependencies', true)
      expect(handleSend).not.toHaveBeenCalled()
    })
  })

  it('shows Stop button when task is running and invokes onStop', async () => {
    const handleStop = vi.fn().mockResolvedValue(undefined)

    render(
      <ConversationComposer
        bot={sampleBotWithWorkspaceTools}
        onSend={vi.fn()}
        onStop={handleStop}
        isGenerating={false}
        isTaskRunning={true}
      />
    )

    const stopBtn = screen.getByTestId('stop-generation-btn')
    expect(stopBtn).toBeDefined()

    fireEvent.click(stopBtn)
    await waitFor(() => {
      expect(handleStop).toHaveBeenCalled()
    })
  })
})
