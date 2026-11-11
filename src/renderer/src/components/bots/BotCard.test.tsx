// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BotCard } from './BotCard'
import type { BotDto } from '../../../../shared/bots'

describe('Renderer: BotCard Component (Phase 6 Step 6.4)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const sampleActiveBot: BotDto = {
    id: 'bot-1111-2222',
    knowledgeBaseId: 'kb-test-01',
    name: 'Doc Analysis Bot',
    description: 'Summarizes and categorizes legal agreements and technical briefs.',
    systemPrompt: 'You are an analytical assistant.',
    providerConnectionId: 'conn-openai-42',
    modelId: 'gpt-6-luna',
    enabledTools: ['search_knowledge_base', 'read_knowledge_base_document'],
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }

  const sampleUnassignedBot: BotDto = {
    id: 'bot-3333-4444',
    knowledgeBaseId: 'kb-test-01',
    name: 'Unassigned Assistant',
    description: '',
    systemPrompt: 'You are an unassigned assistant.',
    providerConnectionId: null,
    modelId: 'claude-sonnet-5-5',
    enabledTools: [],
    status: 'active',
    createdAt: 1700000050000,
    updatedAt: 1700000050000
  }

  const sampleArchivedBot: BotDto = {
    id: 'bot-5555-6666',
    knowledgeBaseId: 'kb-test-01',
    name: 'Archived Legacy Bot',
    description: 'This bot has been archived.',
    systemPrompt: 'You are archived.',
    providerConnectionId: 'conn-google-99',
    modelId: 'gemini-2.5-pro',
    enabledTools: ['prepare_report'],
    status: 'archived',
    createdAt: 1690000000000,
    updatedAt: 1695000000000
  }

  describe('Content and Metadata Rendering', () => {
    it('renders bot name prominently', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const nameEl = screen.getByTestId('bot-name')
      expect(nameEl.textContent).toContain('Doc Analysis Bot')
      expect(nameEl.tagName.toLowerCase()).toBe('h3')
    })

    it('renders description when present', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const descEl = screen.getByTestId('bot-description')
      expect(descEl.textContent).toContain(
        'Summarizes and categorizes legal agreements and technical briefs.'
      )
    })

    it('renders fallback when description is empty', () => {
      render(<BotCard bot={sampleUnassignedBot} />)

      const emptyDescEl = screen.getByTestId('bot-description-empty')
      expect(emptyDescEl.textContent).toContain('No description provided.')
    })

    it('renders model ID in code element', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const modelEl = screen.getByTestId('bot-model')
      expect(modelEl.textContent).toContain('gpt-6-luna')
      const codeEl = modelEl.querySelector('code')
      expect(codeEl).not.toBeNull()
      expect(codeEl?.textContent).toContain('gpt-6-luna')
    })

    it('renders "Connected" provider status and does not leak raw providerConnectionId', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const providerEl = screen.getByTestId('bot-provider-status')
      expect(providerEl.textContent).toContain('Connected')
      // Invariant: Never leak raw provider connection ID into rendered text
      expect(screen.queryByText('conn-openai-42')).toBeNull()
    })

    it('renders "Unassigned" status when providerConnectionId is null', () => {
      render(<BotCard bot={sampleUnassignedBot} />)

      const providerEl = screen.getByTestId('bot-provider-status')
      expect(providerEl.textContent).toContain('Unassigned')
    })

    it('renders active status badge for active bot', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const badge = screen.getByTestId('bot-status-badge')
      expect(badge.textContent).toContain('Active')
      expect(badge.classList.contains('status-badge-active')).toBe(true)
    })

    it('renders archived status badge and class for archived bot', () => {
      render(<BotCard bot={sampleArchivedBot} />)

      const card = screen.getByTestId('bot-card-bot-5555-6666')
      expect(card.classList.contains('bot-card-archived')).toBe(true)

      const badge = screen.getByTestId('bot-status-badge')
      expect(badge.textContent).toContain('Archived')
      expect(badge.classList.contains('status-badge-revoked')).toBe(true)
    })
  })

  describe('Tool Badges', () => {
    it('renders human-readable badges for enabled tools', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const kbBadge = screen.getByTestId('tool-badge-search_knowledge_base')
      expect(kbBadge.textContent).toContain('Search KB')
      const docBadge = screen.getByTestId('tool-badge-read_knowledge_base_document')
      expect(docBadge.textContent).toContain('Read Doc')
    })

    it('renders fallback when no tools are enabled', () => {
      render(<BotCard bot={sampleUnassignedBot} />)

      const noToolsEl = screen.getByTestId('bot-no-tools')
      expect(noToolsEl.textContent).toContain('No tools enabled')
    })
  })

  describe('Interactivity and Accessibility', () => {
    it('is not interactive by default (no onSelect or onClick)', () => {
      render(<BotCard bot={sampleActiveBot} />)

      const card = screen.getByTestId('bot-card-bot-1111-2222')
      expect(card.classList.contains('bot-card-interactive')).toBe(false)
      expect(card.getAttribute('role')).toBeNull()
      expect(card.getAttribute('tabindex')).toBeNull()
    })

    it('becomes interactive and handles click when onSelect is provided', () => {
      const handleSelect = vi.fn()
      render(<BotCard bot={sampleActiveBot} onSelect={handleSelect} />)

      const card = screen.getByTestId('bot-card-bot-1111-2222')
      expect(card.classList.contains('bot-card-interactive')).toBe(true)
      expect(card.getAttribute('role')).toBe('button')
      expect(card.getAttribute('tabindex')).toBe('0')

      fireEvent.click(card)
      expect(handleSelect).toHaveBeenCalledTimes(1)
      expect(handleSelect).toHaveBeenCalledWith(sampleActiveBot)
    })

    it('handles keyboard navigation with Enter and Space keys', () => {
      const handleClick = vi.fn()
      render(<BotCard bot={sampleActiveBot} onClick={handleClick} />)

      const card = screen.getByTestId('bot-card-bot-1111-2222')

      fireEvent.keyDown(card, { key: 'Enter' })
      expect(handleClick).toHaveBeenCalledTimes(1)
      expect(handleClick).toHaveBeenCalledWith(sampleActiveBot)

      fireEvent.keyDown(card, { key: ' ' })
      expect(handleClick).toHaveBeenCalledTimes(2)

      // Other keys should not trigger
      fireEvent.keyDown(card, { key: 'ArrowDown' })
      expect(handleClick).toHaveBeenCalledTimes(2)
    })

    it('applies custom className correctly', () => {
      render(<BotCard bot={sampleActiveBot} className="custom-test-class" />)

      const card = screen.getByTestId('bot-card-bot-1111-2222')
      expect(card.classList.contains('custom-test-class')).toBe(true)
    })
  })
})
