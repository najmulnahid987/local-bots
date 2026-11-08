// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { KnowledgeBaseRecentActivity } from './KnowledgeBaseRecentActivity'
import type { KnowledgeBaseActivityItemDto } from '../../../../shared/knowledge-bases'

describe('Renderer Component: KnowledgeBaseRecentActivity (Phase 4 Step 4.6C)', () => {
  afterEach(() => {
    cleanup()
  })

  it('1. renders empty activity placeholder when array is empty', () => {
    render(<KnowledgeBaseRecentActivity activity={[]} />)

    expect(screen.getByTestId('activity-empty-state')).toBeDefined()
    expect(screen.getByText('No recent workspace activity.')).toBeDefined()
    expect(screen.queryByTestId('activity-list')).toBeNull()
  })

  it('2. renders all 6 supported event types with human-readable type labels', () => {
    const activityItems: KnowledgeBaseActivityItemDto[] = [
      {
        id: 'act-1',
        type: 'bot_created',
        title: 'Customer Support Bot',
        timestamp: 1700000000000,
        status: 'active'
      },
      {
        id: 'act-2',
        type: 'bot_updated',
        title: 'Sales Assistant',
        timestamp: 1700000010000,
        status: 'active'
      },
      {
        id: 'act-3',
        type: 'document_registered',
        title: 'whitepaper.pdf',
        detail: 'PDF source registered',
        timestamp: 1700000020000,
        status: 'queued'
      },
      {
        id: 'act-4',
        type: 'document_indexed',
        title: 'handbook.md',
        detail: 'Indexing complete',
        timestamp: 1700000030000,
        status: 'ready'
      },
      {
        id: 'act-5',
        type: 'document_failed',
        title: 'corrupt.pdf',
        detail: 'Failed to extract text',
        timestamp: 1700000040000,
        status: 'failed'
      },
      {
        id: 'act-6',
        type: 'agent_run',
        title: 'Run with Customer Support Bot',
        detail: 'Completed task successfully',
        timestamp: 1700000050000,
        status: 'completed'
      }
    ]

    render(<KnowledgeBaseRecentActivity activity={activityItems} />)

    expect(screen.getByTestId('activity-list')).toBeDefined()
    expect(screen.getByText('Bot created')).toBeDefined()
    expect(screen.getByText('Bot updated')).toBeDefined()
    expect(screen.getByText('Document registered')).toBeDefined()
    expect(screen.getByText('Document indexed')).toBeDefined()
    expect(screen.getByText('Document processing failed')).toBeDefined()
    expect(screen.getByText('AI agent execution')).toBeDefined()

    expect(screen.getByText('Customer Support Bot')).toBeDefined()
    expect(screen.getByText('whitepaper.pdf')).toBeDefined()
    expect(screen.getByText('handbook.md')).toBeDefined()
  })

  it('3. safely redacts filesystem paths from activity detail', () => {
    const sensitiveActivity: KnowledgeBaseActivityItemDto[] = [
      {
        id: 'act-leak',
        type: 'document_failed',
        title: 'secret.pdf',
        detail: 'Parser error reading /Users/admin/documents/secret.pdf: invalid trailer',
        timestamp: 1700000000000,
        status: 'failed'
      }
    ]

    render(<KnowledgeBaseRecentActivity activity={sensitiveActivity} />)

    const detailEl = screen.getByText(/Parser error reading/i)
    expect(detailEl.textContent).toContain('[REDACTED_PATH]')
    expect(detailEl.textContent).not.toContain('/Users/admin')
  })

  it('4. displays status badges when status is provided', () => {
    const activityWithStatus: KnowledgeBaseActivityItemDto[] = [
      {
        id: 'act-status',
        type: 'document_indexed',
        title: 'guide.md',
        timestamp: 1700000000000,
        status: 'ready'
      }
    ]

    render(<KnowledgeBaseRecentActivity activity={activityWithStatus} />)

    const badge = screen.getByTestId('activity-status-ready')
    expect(badge.textContent).toBe('ready')
    expect(badge.className).toContain('status-ready')
  })
})
