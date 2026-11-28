// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ConversationMessage } from './ConversationMessage'
import { ProviderPrivacyInformation } from '../settings/ProviderPrivacyInformation'
import { ProviderConnectionCard } from '../settings/ProviderConnectionCard'
import { AddProviderConnectionDialog } from '../settings/AddProviderConnectionDialog'
import { TestProviderConnectionDialog } from '../settings/TestProviderConnectionDialog'
import type { MessageDto } from '../../../../shared/conversations'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'

describe('Perplexity UI Isolation, Privacy Disclosures & Web Sources Rendering', () => {
  afterEach(() => {
    cleanup()
  })

  it('1. renders Perplexity webSources separately from KB citations and strips unsafe URLs', () => {
    const msg: MessageDto = {
      id: 'msg-pplx-ui-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Based on KB policy [1] and recent news.',
      contentFormat: 'markdown',
      createdAt: Date.now(),
      metadata: {
        providerId: 'perplexity',
        modelId: 'perplexity/sonar',
        groundingMode: 'kb_partial_with_general_fallback',
        citations: [
          {
            citationNumber: 1,
            sourceId: 'src-1',
            chunkId: 'chunk-1',
            fileName: 'InternalPolicy.md',
            fileType: 'md',
            pageNumber: 1,
            headingPath: ['Overview'],
            chunkIndex: 0
          }
        ],
        webSources: [
          {
            id: 'ws-1',
            title: 'Perplexity Agent Docs',
            url: 'https://docs.perplexity.ai/docs/agent-api/quickstart',
            snippet: 'Official Agent API',
            sourceType: 'search',
            originLabel: 'Perplexity Web Search'
          }
        ]
      }
    }

    render(<ConversationMessage message={msg} botName="Research Bot" />)

    // KB citation still renders as authoritative local KB evidence
    expect(screen.getByTestId('citations-list-msg-pplx-ui-1')).toBeDefined()
    expect(screen.getByTestId('citation-chip-msg-pplx-ui-1-1').textContent).toContain(
      'InternalPolicy.md'
    )

    // External Web Sources render in their own clearly labeled section
    const webSection = screen.getByTestId('web-sources-msg-pplx-ui-1')
    expect(webSection.textContent).toContain(
      'Web Sources (External Research — Not Local KB Evidence)'
    )
    const link = screen.getByTestId('web-source-link-msg-pplx-ui-1-0') as HTMLAnchorElement
    expect(link.href).toBe('https://docs.perplexity.ai/docs/agent-api/quickstart')
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
  })

  it('2. preserves backward compatibility when legacy messages lack webSources', () => {
    const legacyMsg: MessageDto = {
      id: 'msg-legacy-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Legacy response text.',
      contentFormat: 'markdown',
      createdAt: Date.now(),
      metadata: {
        providerId: 'openai',
        modelId: 'gpt-4o',
        citations: []
      }
    }

    render(<ConversationMessage message={legacyMsg} botName="Legacy Bot" />)
    expect(screen.queryByTestId('web-sources-msg-legacy-1')).toBeNull()
  })

  it('3. displays accurate Perplexity privacy & test charge disclosures in settings UI', () => {
    render(<ProviderPrivacyInformation />)
    const privacyText = document.body.textContent ?? ''
    expect(privacyText).toContain('Perplexity')
    expect(privacyText).toContain('api.perplexity.ai')
    expect(privacyText).toContain('store: false')
    expect(privacyText).toContain('not guarantee zero data retention')

    const catalog: ProviderCatalogDto = {
      providers: [
        {
          id: 'perplexity',
          displayName: 'Perplexity',
          description: 'Perplexity Agent API',
          docUrl: 'https://docs.perplexity.ai',
          isSupported: true,
          defaultModelId: 'perplexity/sonar'
        }
      ],
      models: [
        {
          id: 'perplexity/sonar',
          providerId: 'perplexity',
          displayName: 'Perplexity Sonar (Direct Model)',
          description: 'Direct Sonar model',
          availability: 'stable',
          capabilities: {
            streaming: true,
            tools: false,
            imageInput: false,
            structuredOutput: false
          },
          docUrl: 'https://docs.perplexity.ai'
        }
      ]
    }

    const conn: ProviderConnectionSummary = {
      id: 'conn-pplx-1',
      providerId: 'perplexity',
      label: 'Perplexity Work',
      status: 'active',
      hasCredential: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    render(
      <ProviderConnectionCard
        connection={conn}
        catalog={catalog}
        onTest={() => {}}
        onReplaceKey={() => {}}
        onEditLabel={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('Perplexity Work')).toBeDefined()

    render(
      <AddProviderConnectionDialog
        isOpen={true}
        catalog={catalog}
        onClose={() => {}}
        onSuccess={() => {}}
      />
    )
    expect(screen.getByPlaceholderText('Enter Perplexity API key (pplx-...)')).toBeDefined()
    expect(document.body.textContent).toContain('may incur a small usage charge')

    cleanup()
    render(
      <TestProviderConnectionDialog
        isOpen={true}
        connection={conn}
        catalog={catalog}
        onClose={() => {}}
        onTested={() => {}}
      />
    )
    expect(document.body.textContent).toContain('may incur a small provider usage charge')
  })
})
