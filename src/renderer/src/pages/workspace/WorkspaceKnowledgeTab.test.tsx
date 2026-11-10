// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  type RenderResult
} from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { WorkspaceKnowledgeTab } from './WorkspaceKnowledgeTab'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'
import type {
  KnowledgeSourceDto,
  DocumentSearchResultDto,
  DocumentPreviewDto
} from '../../../../shared/knowledge-documents'

describe('WorkspaceKnowledgeTab (Phase 5 Step 5.11)', () => {
  const activeKb: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'Core research documents and AI notes',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null
  }

  const otherKb: KnowledgeBaseDto = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Secondary Base',
    description: 'Second workspace',
    createdAt: 1700000010000,
    updatedAt: 1700000010000,
    archivedAt: null
  }

  const sampleCompletedDoc: KnowledgeSourceDto = {
    id: 'src-1111-1111-1111-111111111111',
    knowledgeBaseId: activeKb.id,
    originalFileName: 'neural_nets.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: 204800,
    fileSize: 204800,
    status: 'completed',
    indexingStatus: 'completed',
    createdAt: 1700000000000,
    updatedAt: 1700000010000,
    indexedAt: 1700000010000,
    chunkCount: 15,
    errorMessage: null
  }

  const sampleFailedDoc: KnowledgeSourceDto = {
    id: 'src-2222-2222-2222-222222222222',
    knowledgeBaseId: activeKb.id,
    originalFileName: 'corrupted_file.txt',
    fileType: 'txt',
    mimeType: 'text/plain',
    fileSizeBytes: 512,
    fileSize: 512,
    status: 'failed',
    indexingStatus: 'failed',
    createdAt: 1700000020000,
    updatedAt: 1700000025000,
    indexedAt: null,
    chunkCount: 0,
    errorMessage: 'File contains invalid UTF-8 byte sequences.'
  }

  const sampleProcessingDoc: KnowledgeSourceDto = {
    id: 'src-3333-3333-3333-333333333333',
    knowledgeBaseId: activeKb.id,
    originalFileName: 'large_manual.md',
    fileType: 'md',
    mimeType: 'text/markdown',
    fileSizeBytes: 10240,
    fileSize: 10240,
    status: 'processing',
    indexingStatus: 'processing',
    createdAt: 1700000030000,
    updatedAt: 1700000030000,
    indexedAt: null,
    chunkCount: 0,
    errorMessage: null
  }

  const sampleQueuedDoc: KnowledgeSourceDto = {
    id: 'src-4444-4444-4444-444444444444',
    knowledgeBaseId: activeKb.id,
    originalFileName: 'notes.txt',
    fileType: 'txt',
    mimeType: 'text/plain',
    fileSizeBytes: 1024,
    fileSize: 1024,
    status: 'queued',
    indexingStatus: 'queued',
    createdAt: 1700000040000,
    updatedAt: 1700000040000,
    indexedAt: null,
    chunkCount: 0,
    errorMessage: null
  }

  const sampleNeedsReindexDoc: KnowledgeSourceDto = {
    id: 'src-5555-5555-5555-555555555555',
    knowledgeBaseId: activeKb.id,
    originalFileName: 'legacy.md',
    fileType: 'md',
    mimeType: 'text/markdown',
    fileSizeBytes: 2048,
    fileSize: 2048,
    status: 'needs_reindex',
    indexingStatus: 'needs_reindex',
    createdAt: 1700000050000,
    updatedAt: 1700000050000,
    indexedAt: null,
    chunkCount: 2,
    errorMessage: null
  }

  const sampleSearchResult: DocumentSearchResultDto = {
    sourceId: sampleCompletedDoc.id,
    knowledgeBaseId: activeKb.id,
    filename: sampleCompletedDoc.originalFileName,
    chunkId: 'chunk-1',
    chunkIndex: 0,
    content: 'Full chunk content discussing gradient descent optimization.',
    snippet: 'Discussion of [[HL]]gradient descent[[/HL]] optimization in deep networks.',
    score: -3.5,
    pageNumber: 3,
    heading: 'Optimization',
    headingLevel: 2,
    headingPath: ['Deep Learning', 'Optimization'],
    lineRange: null,
    chunkerVersion: '1.0.0'
  }

  const samplePreview: DocumentPreviewDto = {
    sourceId: sampleCompletedDoc.id,
    knowledgeBaseId: activeKb.id,
    originalFileName: sampleCompletedDoc.originalFileName,
    fileType: 'pdf',
    fileSize: sampleCompletedDoc.fileSize,
    status: 'completed',
    totalChunks: 15,
    chunks: [
      {
        chunkId: 'chunk-1',
        chunkIndex: 0,
        content: 'Excerpt 1: Gradient descent fundamentals and backpropagation.',
        tokenCount: 12,
        pageNumber: 1,
        heading: 'Introduction',
        headingLevel: 1,
        headingPath: ['Introduction']
      },
      {
        chunkId: 'chunk-2',
        chunkIndex: 1,
        content: 'Excerpt 2: Stochastic gradient descent dynamics and learning rates.',
        tokenCount: 14,
        pageNumber: 2,
        heading: 'Stochastic Methods',
        headingLevel: 2,
        headingPath: ['Introduction', 'Stochastic Methods']
      }
    ]
  }

  let listMock: ReturnType<typeof vi.fn>
  let selectAndImportMock: ReturnType<typeof vi.fn>
  let searchMock: ReturnType<typeof vi.fn>
  let previewMock: ReturnType<typeof vi.fn>
  let reindexMock: ReturnType<typeof vi.fn>
  let deleteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listMock = vi.fn().mockResolvedValue([sampleCompletedDoc])
    selectAndImportMock = vi.fn().mockResolvedValue({
      status: 'completed',
      duplicate: false,
      cancelled: false,
      source: sampleCompletedDoc,
      totalChunks: 15,
      totalTokens: 1500
    })
    searchMock = vi.fn().mockResolvedValue([sampleSearchResult])
    previewMock = vi.fn().mockResolvedValue(samplePreview)
    reindexMock = vi.fn().mockResolvedValue({
      status: 'completed',
      source: sampleCompletedDoc,
      totalChunks: 15,
      totalTokens: 1500,
      chunkerVersion: '1.0.0'
    })
    deleteMock = vi.fn().mockResolvedValue({
      success: true,
      sourceId: sampleCompletedDoc.id,
      knowledgeBaseId: activeKb.id,
      fileCleaned: true,
      cleanupPending: false
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      knowledgeDocuments: {
        list: listMock,
        selectAndImport: selectAndImportMock,
        search: searchMock,
        preview: previewMock,
        reindex: reindexMock,
        delete: deleteMock
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
      <MemoryRouter initialEntries={[`/knowledge-bases/${kb.id}/knowledge`]}>
        <Routes>
          <Route path="/knowledge-bases/:kbId" element={<Outlet context={{ knowledgeBase: kb }} />}>
            <Route path="knowledge" element={<WorkspaceKnowledgeTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  }

  // ---------------------------------------------------------------------------
  // 1. Navigation, Loading & Empty State
  // ---------------------------------------------------------------------------
  describe('1. Navigation, Loading & Empty State', () => {
    it('renders panel title and loads documents for the active Knowledge Base', async () => {
      renderTab()

      expect(screen.getByText('Knowledge Documents')).toBeDefined()
      expect(screen.getByText(/Research Workspace/)).toBeDefined()

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledWith(activeKb.id)
      })

      expect(await screen.findByText('neural_nets.pdf')).toBeDefined()
    })

    it('renders loading state while documents list is in flight', () => {
      listMock.mockReturnValueOnce(new Promise(() => {}))
      renderTab()

      expect(screen.getByTestId('documents-loading')).toBeDefined()
      expect(screen.getByText('Loading Knowledge Base documents...')).toBeDefined()
    })

    it('renders empty state when Knowledge Base has no documents', async () => {
      listMock.mockResolvedValueOnce([])
      renderTab()

      expect(await screen.findByTestId('workspace-knowledge-empty')).toBeDefined()
      expect(screen.getByText('No documents uploaded yet')).toBeDefined()
      expect(screen.getByTestId('btn-empty-import')).toBeDefined()
    })

    it('renders error state with retry button when list fails', async () => {
      listMock.mockRejectedValueOnce(new Error('Failed to load documents from database.'))
      renderTab()

      expect(await screen.findByTestId('alert-docs-error')).toBeDefined()
      expect(screen.getByText(/Failed to load documents from database/)).toBeDefined()

      // Click retry
      listMock.mockResolvedValueOnce([sampleCompletedDoc])
      fireEvent.click(screen.getByTestId('btn-retry-docs'))

      expect(await screen.findByText('neural_nets.pdf')).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Document List & Lifecycle Status Badges
  // ---------------------------------------------------------------------------
  describe('2. Document List & Lifecycle Status Badges', () => {
    it('displays all approved lifecycle status badges correctly', async () => {
      listMock.mockResolvedValueOnce([
        sampleCompletedDoc,
        sampleFailedDoc,
        sampleProcessingDoc,
        sampleQueuedDoc,
        sampleNeedsReindexDoc
      ])

      renderTab()

      expect(await screen.findByTestId('status-badge-completed')).toBeDefined()
      expect(screen.getByTestId('status-badge-failed')).toBeDefined()
      expect(screen.getByTestId('status-badge-processing')).toBeDefined()
      expect(screen.getByTestId('status-badge-queued')).toBeDefined()
      expect(screen.getByTestId('status-badge-needs-reindex')).toBeDefined()

      // Error message note displayed for failed doc
      expect(screen.getByTestId('doc-error-message')).toBeDefined()
      expect(screen.getByText('File contains invalid UTF-8 byte sequences.')).toBeDefined()
    })

    it('displays document metadata (file size, chunk count, format badge)', async () => {
      renderTab()

      expect(await screen.findByText('neural_nets.pdf')).toBeDefined()
      expect(screen.getByText('PDF')).toBeDefined()
      expect(screen.getByTestId('doc-size').textContent).toBe('200 KB')
      expect(screen.getByTestId('doc-chunk-count').textContent).toBe('15')
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Document Import
  // ---------------------------------------------------------------------------
  describe('3. Document Import', () => {
    it('successfully imports a document and refreshes list', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const importBtn = screen.getByTestId('btn-import-document')
      fireEvent.click(importBtn)

      expect(selectAndImportMock).toHaveBeenCalledWith({
        knowledgeBaseId: activeKb.id,
        allowDuplicate: false
      })

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledTimes(2) // Initial + refresh
      })
    })

    it('handles cancelled import without showing an error', async () => {
      selectAndImportMock.mockResolvedValueOnce({
        status: 'cancelled',
        duplicate: false,
        cancelled: true
      })

      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId('btn-import-document'))

      await waitFor(() => {
        expect(selectAndImportMock).toHaveBeenCalled()
      })

      expect(screen.queryByTestId('alert-import-error')).toBeNull()
    })

    it('handles duplicate detection with confirmation modal and duplicate import option', async () => {
      selectAndImportMock.mockResolvedValueOnce({
        status: 'duplicate',
        duplicate: true,
        cancelled: false,
        existingSource: {
          id: 'existing-id',
          originalFileName: 'neural_nets.pdf',
          fileSize: 204800,
          indexingStatus: 'completed',
          createdAt: 1700000000000
        }
      })

      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId('btn-import-document'))

      // Duplicate modal opens
      expect(await screen.findByTestId('document-duplicate-modal')).toBeDefined()
      expect(screen.getByTestId('duplicate-existing-filename').textContent).toBe('neural_nets.pdf')

      // Confirm duplicate import
      selectAndImportMock.mockResolvedValueOnce({
        status: 'completed',
        duplicate: false,
        cancelled: false,
        source: sampleCompletedDoc,
        totalChunks: 15,
        totalTokens: 1500
      })

      fireEvent.click(screen.getByTestId('btn-confirm-duplicate'))

      await waitFor(() => {
        expect(selectAndImportMock).toHaveBeenCalledWith({
          knowledgeBaseId: activeKb.id,
          allowDuplicate: true
        })
      })
    })

    it('displays error banner when import fails', async () => {
      selectAndImportMock.mockRejectedValueOnce(new Error('File exceeds maximum allowed size.'))
      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId('btn-import-document'))

      expect(await screen.findByTestId('alert-import-error')).toBeDefined()
      expect(screen.getByText(/File exceeds maximum allowed size/)).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Document Search
  // ---------------------------------------------------------------------------
  describe('4. Document Search', () => {
    it('searches document content and renders results with provenance and highlighted snippets', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const searchInput = screen.getByTestId('input-document-search')
      fireEvent.change(searchInput, { target: { value: 'gradient descent' } })

      const submitBtn = screen.getByTestId('btn-submit-search')
      fireEvent.click(submitBtn)

      await waitFor(() => {
        expect(searchMock).toHaveBeenCalledWith({
          knowledgeBaseId: activeKb.id,
          query: 'gradient descent'
        })
      })

      // Search results rendered
      expect(await screen.findByTestId('search-results-section')).toBeDefined()
      expect(screen.getByTestId('result-filename-0').textContent).toBe('neural_nets.pdf')
      expect(screen.getByTestId('result-page-0').textContent).toContain('Page 3')
      expect(screen.getByTestId('result-heading-0').textContent).toBe(
        'Deep Learning > Optimization'
      )

      // Safe highlighted snippet mark
      const highlight = screen.getByTestId('search-highlight')
      expect(highlight.tagName.toLowerCase()).toBe('mark')
      expect(highlight.textContent).toBe('gradient descent')
    })

    it('submits search on Enter keypress', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const searchInput = screen.getByTestId('input-document-search')
      fireEvent.change(searchInput, { target: { value: 'neural networks' } })
      fireEvent.submit(screen.getByTestId('document-search-form'))

      await waitFor(() => {
        expect(searchMock).toHaveBeenCalledWith({
          knowledgeBaseId: activeKb.id,
          query: 'neural networks'
        })
      })
    })

    it('validates empty search query without calling search API', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const searchInput = screen.getByTestId('input-document-search')
      fireEvent.change(searchInput, { target: { value: '   ' } })
      fireEvent.submit(screen.getByTestId('document-search-form'))

      expect(searchMock).not.toHaveBeenCalled()
      expect(await screen.findByTestId('alert-search-error')).toBeDefined()
      expect(screen.getByText('Please enter a search term.')).toBeDefined()
    })

    it('displays no-results state when search returns empty results', async () => {
      searchMock.mockResolvedValueOnce([])
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const searchInput = screen.getByTestId('input-document-search')
      fireEvent.change(searchInput, { target: { value: 'nonexistent keyword' } })
      fireEvent.submit(screen.getByTestId('document-search-form'))

      expect(await screen.findByTestId('search-no-results')).toBeDefined()
      expect(screen.getByText('No matching documents found')).toBeDefined()

      // Clicking "Back to All Documents" clears search view
      fireEvent.click(screen.getByTestId('btn-back-to-documents'))
      expect(screen.queryByTestId('search-no-results')).toBeNull()
      expect(screen.getByTestId('documents-table-wrapper')).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Document Preview
  // ---------------------------------------------------------------------------
  describe('5. Document Preview', () => {
    it('opens preview modal, displays bounded excerpts and closes on close button', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const previewBtn = screen.getByTestId(`btn-preview-${sampleCompletedDoc.id}`)
      fireEvent.click(previewBtn)

      expect(await screen.findByTestId('document-preview-modal')).toBeDefined()
      expect(previewMock).toHaveBeenCalledWith({
        knowledgeBaseId: activeKb.id,
        sourceId: sampleCompletedDoc.id,
        maxChunks: 3
      })

      // Title & metadata
      expect(await screen.findByTestId('preview-title')).toBeDefined()
      expect(screen.getByTestId('preview-meta')).toBeDefined()

      // Chunk excerpts
      expect(screen.getByTestId('preview-chunk-0')).toBeDefined()
      expect(screen.getByTestId('preview-chunk-1')).toBeDefined()
      expect(screen.getByText(/Gradient descent fundamentals/)).toBeDefined()

      // Close preview
      fireEvent.click(screen.getByTestId('btn-close-preview'))
      expect(screen.queryByTestId('document-preview-modal')).toBeNull()
    })

    it('closes preview modal on Escape key', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId(`btn-preview-${sampleCompletedDoc.id}`))
      expect(await screen.findByTestId('document-preview-modal')).toBeDefined()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByTestId('document-preview-modal')).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Reindex Workflow
  // ---------------------------------------------------------------------------
  describe('6. Reindex Workflow', () => {
    it('successfully reindexes a document and refreshes list', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      const reindexBtn = screen.getByTestId(`btn-reindex-${sampleCompletedDoc.id}`)
      fireEvent.click(reindexBtn)

      expect(reindexMock).toHaveBeenCalledWith({
        knowledgeBaseId: activeKb.id,
        sourceId: sampleCompletedDoc.id
      })

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledTimes(2)
      })
    })

    it('displays error banner when reindexing fails', async () => {
      reindexMock.mockRejectedValueOnce(
        new Error('Checksum mismatch: file modified externally on disk.')
      )

      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId(`btn-reindex-${sampleCompletedDoc.id}`))

      expect(await screen.findByTestId('alert-reindex-error')).toBeDefined()
      expect(screen.getByText(/Checksum mismatch/)).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Deletion Workflow
  // ---------------------------------------------------------------------------
  describe('7. Deletion Workflow', () => {
    it('prompts confirmation, cancels deletion without calling delete API', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId(`btn-delete-${sampleCompletedDoc.id}`))

      expect(await screen.findByTestId('document-delete-modal')).toBeDefined()
      expect(screen.getByTestId('delete-document-name').textContent).toBe('“neural_nets.pdf”')

      // Click cancel
      fireEvent.click(screen.getByTestId('btn-cancel-delete'))
      expect(screen.queryByTestId('document-delete-modal')).toBeNull()
      expect(deleteMock).not.toHaveBeenCalled()
    })

    it('confirms deletion, executes delete API and removes document from list', async () => {
      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId(`btn-delete-${sampleCompletedDoc.id}`))
      expect(await screen.findByTestId('document-delete-modal')).toBeDefined()

      // List mock for post-delete refresh returns empty list
      listMock.mockResolvedValueOnce([])

      fireEvent.click(screen.getByTestId('btn-confirm-delete'))

      await waitFor(() => {
        expect(deleteMock).toHaveBeenCalledWith({
          knowledgeBaseId: activeKb.id,
          sourceId: sampleCompletedDoc.id
        })
      })

      expect(screen.queryByTestId('document-delete-modal')).toBeNull()
      expect(await screen.findByTestId('workspace-knowledge-empty')).toBeDefined()
    })

    it('displays error banner when deletion fails', async () => {
      deleteMock.mockRejectedValueOnce(new Error('Permission denied deleting storage file.'))

      renderTab()
      await screen.findByText('neural_nets.pdf')

      fireEvent.click(screen.getByTestId(`btn-delete-${sampleCompletedDoc.id}`))
      fireEvent.click(screen.getByTestId('btn-confirm-delete'))

      expect(await screen.findByTestId('alert-delete-error')).toBeDefined()
      expect(screen.getByText(/Permission denied deleting storage file/)).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Knowledge Base Switching & Isolation
  // ---------------------------------------------------------------------------
  describe('8. Knowledge Base Switching & Isolation', () => {
    it('resets document list and search results when switching Knowledge Bases', async () => {
      const { rerender } = renderTab(activeKb)
      await screen.findByText('neural_nets.pdf')

      // Switch to other Knowledge Base
      listMock.mockResolvedValueOnce([])
      rerender(
        <MemoryRouter initialEntries={[`/knowledge-bases/${otherKb.id}/knowledge`]}>
          <Routes>
            <Route
              path="/knowledge-bases/:kbId"
              element={<Outlet context={{ knowledgeBase: otherKb }} />}
            >
              <Route path="knowledge" element={<WorkspaceKnowledgeTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(listMock).toHaveBeenCalledWith(otherKb.id)
      })

      // Old document from activeKb must not be shown
      expect(screen.queryByText('neural_nets.pdf')).toBeNull()
      expect(await screen.findByTestId('workspace-knowledge-empty')).toBeDefined()
    })
  })
})
