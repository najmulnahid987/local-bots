// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BotList } from './BotList'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: BotList Component (Phase 6 Step 6.4)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleBots: BotDto[] = [
    {
      id: 'bot-1',
      knowledgeBaseId: 'kb-01',
      name: 'Alpha Bot',
      description: 'Alpha bot description',
      systemPrompt: '',
      providerConnectionId: 'conn-1',
      modelId: 'gpt-6-luna',
      enabledTools: ['search_knowledge_base'],
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    },
    {
      id: 'bot-2',
      knowledgeBaseId: 'kb-01',
      name: 'Beta Bot',
      description: 'Beta bot description',
      systemPrompt: '',
      providerConnectionId: null,
      modelId: 'claude-sonnet-5-5',
      enabledTools: [],
      status: 'active',
      createdAt: 1700000010000,
      updatedAt: 1700000010000
    }
  ]

  describe('Loading State', () => {
    it('renders loading spinner and status message when isLoading is true', () => {
      render(<BotList bots={[]} isLoading={true} />)

      const loadingEl = screen.getByTestId('bot-list-loading')
      expect(loadingEl.getAttribute('role')).toBe('status')
      expect(loadingEl.textContent).toContain('Loading bots...')
      expect(screen.queryByTestId('bot-list-empty')).toBeNull()
      expect(screen.queryByTestId('bot-list-grid')).toBeNull()
    })
  })

  describe('Error State', () => {
    it('renders alert when error message is provided', () => {
      render(<BotList bots={[]} error="Failed to retrieve bots from database" />)

      const errorEl = screen.getByTestId('bot-list-error')
      expect(errorEl.getAttribute('role')).toBe('alert')
      expect(errorEl.textContent).toContain('Failed to load bots')
      expect(errorEl.textContent).toContain('Failed to retrieve bots from database')
      expect(screen.queryByTestId('bot-list-retry')).toBeNull()
    })

    it('renders retry button and triggers callback when onRetry is provided', () => {
      const handleRetry = vi.fn()
      render(<BotList bots={[]} error="Network timeout" onRetry={handleRetry} />)

      const retryBtn = screen.getByTestId('bot-list-retry')
      expect(retryBtn).not.toBeNull()
      expect(retryBtn.textContent).toContain('Retry')

      fireEvent.click(retryBtn)
      expect(handleRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe('Empty State', () => {
    it('renders default empty state when bots array is empty', () => {
      render(<BotList bots={[]} />)

      const emptyEl = screen.getByTestId('bot-list-empty')
      expect(emptyEl).not.toBeNull()
      expect(emptyEl.textContent).toContain('No Bots in this Knowledge Base')
      expect(emptyEl.textContent).toContain(
        'Create a persistent AI Bot to analyze, query, and synthesize documents inside this Knowledge Base.'
      )
    })

    it('renders custom empty title and message when provided', () => {
      render(
        <BotList
          bots={[]}
          emptyTitle="No Archived Bots"
          emptyMessage="You have not archived any bots in this workspace."
        />
      )

      const emptyEl = screen.getByTestId('bot-list-empty')
      expect(emptyEl.textContent).toContain('No Archived Bots')
      expect(emptyEl.textContent).toContain('You have not archived any bots in this workspace.')
    })
  })

  describe('Bot Grid Rendering', () => {
    it('renders list of bots with semantic markup', () => {
      render(<BotList bots={sampleBots} />)

      const gridEl = screen.getByTestId('bot-list-grid')
      expect(gridEl.getAttribute('role')).toBe('list')

      const items = screen.getAllByRole('listitem')
      expect(items).toHaveLength(2)

      expect(screen.getByText('Alpha Bot')).not.toBeNull()
      expect(screen.getByText('Beta Bot')).not.toBeNull()
    })

    it('passes onSelectBot to individual BotCards', () => {
      const handleSelect = vi.fn()
      render(<BotList bots={sampleBots} onSelectBot={handleSelect} />)

      const firstCard = screen.getByTestId('bot-card-bot-1')
      fireEvent.click(firstCard)

      expect(handleSelect).toHaveBeenCalledTimes(1)
      expect(handleSelect).toHaveBeenCalledWith(sampleBots[0])
    })

    it('applies custom className to the bot-grid container', () => {
      render(<BotList bots={sampleBots} className="custom-grid-class" />)

      const gridEl = screen.getByTestId('bot-list-grid')
      expect(gridEl.classList.contains('custom-grid-class')).toBe(true)
    })
  })
})
