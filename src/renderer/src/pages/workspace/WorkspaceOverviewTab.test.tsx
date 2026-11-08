// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
  type RenderResult
} from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { WorkspaceOverviewTab } from './WorkspaceOverviewTab'
import { formatBytes, formatCount } from '../../utils/formatters'
import type { KnowledgeBaseDto, KnowledgeBaseOverviewDto } from '../../../../shared/knowledge-bases'

describe('Renderer Page: WorkspaceOverviewTab (Phase 4 Step 4.6C)', () => {
  const activeKb: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'Core research documents and AI notes',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const mockOverviewWithData: KnowledgeBaseOverviewDto = {
    knowledgeBaseId: activeKb.id,
    bots: {
      total: 3,
      active: 2,
      archived: 1
    },
    documents: {
      total: 4,
      ready: 2,
      processing: 1,
      failed: 1,
      totalBytes: 5242880 // 5 MB
    },
    indexing: {
      totalChunks: 350,
      totalTokens: 45000,
      lastIndexedAt: 1700000050000
    },
    recentActivity: [
      {
        id: 'act-1',
        type: 'bot_created',
        title: 'Alpha Bot',
        timestamp: 1700000000000,
        status: 'active'
      },
      {
        id: 'act-2',
        type: 'document_indexed',
        title: 'manual.pdf',
        detail: 'Indexing complete',
        timestamp: 1700000010000,
        status: 'ready'
      }
    ]
  }

  const mockOverviewEmpty: KnowledgeBaseOverviewDto = {
    knowledgeBaseId: activeKb.id,
    bots: {
      total: 0,
      active: 0,
      archived: 0
    },
    documents: {
      total: 0,
      ready: 0,
      processing: 0,
      failed: 0,
      totalBytes: 0
    },
    indexing: {
      totalChunks: 0,
      totalTokens: 0,
      lastIndexedAt: null
    },
    recentActivity: []
  }

  let getOverviewMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getOverviewMock = vi.fn().mockResolvedValue(mockOverviewWithData)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      knowledgeBases: {
        getOverview: getOverviewMock
      }
    }
  })

  afterEach(() => {
    cleanup()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
    vi.restoreAllMocks()
  })

  function renderTab(kb: KnowledgeBaseDto = activeKb): RenderResult {
    return render(
      <MemoryRouter initialEntries={[`/knowledge-bases/${kb.id}/overview`]}>
        <Routes>
          <Route path="/knowledge-bases/:kbId" element={<Outlet context={{ knowledgeBase: kb }} />}>
            <Route path="overview" element={<WorkspaceOverviewTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  }

  it('1. renders loading skeleton while overview is in flight', () => {
    let pendingResolve!: (val: KnowledgeBaseOverviewDto) => void
    getOverviewMock.mockReturnValueOnce(
      new Promise<KnowledgeBaseOverviewDto>((res) => {
        pendingResolve = res
      })
    )

    renderTab()

    expect(screen.getByTestId('overview-loading-state')).toBeDefined()
    expect(screen.getByText('Loading workspace overview...')).toBeDefined()
    expect(screen.queryByTestId('overview-metrics-grid')).toBeNull()

    act(() => {
      pendingResolve(mockOverviewWithData)
    })
  })

  it('2. renders dynamic bot statistics and navigation link', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('card-bots-stats')).toBeDefined()
    })

    expect(screen.getByTestId('bots-total-count').textContent).toBe('3')
    expect(screen.getByTestId('bots-active-count').textContent).toContain('2 active')
    expect(screen.getByTestId('bots-archived-count').textContent).toContain('1 archived')

    const botsLink = screen.getByTestId('link-view-bots')
    expect(botsLink.getAttribute('href')).toBe(`/knowledge-bases/${activeKb.id}/bots`)
  })

  it('3. renders bot empty state when workspace has 0 bots', async () => {
    getOverviewMock.mockResolvedValueOnce(mockOverviewEmpty)
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('bots-empty-state')).toBeDefined()
    })

    expect(screen.getByText('No bots created in this workspace yet.')).toBeDefined()
    expect(screen.queryByTestId('bots-total-count')).toBeNull()
  })

  it('4. renders document statistics with breakdown and formatted bytes', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('card-docs-stats')).toBeDefined()
    })

    expect(screen.getByTestId('docs-total-count').textContent).toBe('4')
    expect(screen.getByTestId('docs-ready-count').textContent).toContain('2 ready')
    expect(screen.getByTestId('docs-processing-count').textContent).toContain('1 processing')
    expect(screen.getByTestId('docs-failed-count').textContent).toContain('1 failed')
    expect(screen.getByTestId('docs-bytes-count').textContent).toBe('5.0 MB')

    const docsLink = screen.getByTestId('link-view-knowledge')
    expect(docsLink.getAttribute('href')).toBe(`/knowledge-bases/${activeKb.id}/knowledge`)
  })

  it('5. renders document empty state when workspace has 0 documents', async () => {
    getOverviewMock.mockResolvedValueOnce(mockOverviewEmpty)
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('docs-empty-state')).toBeDefined()
    })

    expect(screen.getByText('No documents added to this workspace yet.')).toBeDefined()
    expect(screen.queryByTestId('docs-total-count')).toBeNull()
  })

  it('6. renders indexing summary metrics and neutral informational note', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('card-indexing-stats')).toBeDefined()
    })

    expect(screen.getByTestId('indexing-chunks-count').textContent).toBe('350 chunks')
    expect(screen.getByTestId('indexing-tokens-count').textContent).toContain('45,000 tokens')
    expect(screen.getByTestId('indexing-last-indexed').textContent).toContain('Last indexed:')
    expect(screen.getByTestId('indexing-last-indexed').textContent).not.toContain('Not indexed yet')

    expect(
      screen.getByText(
        'Document processing and full-text search will become available in a later implementation phase.'
      )
    ).toBeDefined()
  })

  it('7. renders indexing empty state when total chunks is 0', async () => {
    getOverviewMock.mockResolvedValueOnce(mockOverviewEmpty)
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('indexing-empty-state')).toBeDefined()
    })

    expect(screen.getByText('No chunks generated yet.')).toBeDefined()
    expect(screen.getByTestId('indexing-last-indexed').textContent).toContain('Not indexed yet')
  })

  it('8. renders recent workspace activity feed via KnowledgeBaseRecentActivity', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('workspace-activity-card')).toBeDefined()
    })

    expect(screen.getByText('Alpha Bot')).toBeDefined()
    expect(screen.getByText('manual.pdf')).toBeDefined()
    expect(screen.getByText('Document indexed')).toBeDefined()
  })

  it('9. renders error alert and allows retrying on API error', async () => {
    getOverviewMock.mockRejectedValueOnce(new Error('Internal database read failure'))
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('overview-error-state')).toBeDefined()
    })

    expect(screen.getByText('Internal database read failure')).toBeDefined()

    // Retry button triggers a new call
    getOverviewMock.mockResolvedValueOnce(mockOverviewWithData)
    const retryBtn = screen.getByTestId('btn-overview-retry')
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(screen.getByTestId('card-bots-stats')).toBeDefined()
    })
    expect(screen.queryByTestId('overview-error-state')).toBeNull()
  })

  it('10. allows manual refresh via header refresh button', async () => {
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('card-bots-stats')).toBeDefined()
    })

    const refreshBtn = screen.getByTestId('btn-overview-refresh')
    fireEvent.click(refreshBtn)

    await waitFor(() => {
      expect(getOverviewMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('formatBytes helper', () => {
    it('formats 0 and negative bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B')
      expect(formatBytes(-100)).toBe('0 B')
      expect(formatBytes(NaN)).toBe('0 B')
    })

    it('formats bytes in B, KB, MB, GB ranges correctly', () => {
      expect(formatBytes(512)).toBe('512 B')
      expect(formatBytes(1024)).toBe('1.0 KB')
      expect(formatBytes(1536)).toBe('1.5 KB')
      expect(formatBytes(1048576)).toBe('1.0 MB')
      expect(formatBytes(1073741824)).toBe('1.0 GB')
    })
  })

  describe('formatCount helper', () => {
    it('formats integers with thousand separators', () => {
      expect(formatCount(0)).toBe('0')
      expect(formatCount(999)).toBe('999')
      expect(formatCount(1000)).toBe('1,000')
      expect(formatCount(1234567)).toBe('1,234,567')
      expect(formatCount(-5)).toBe('0')
    })
  })
})
