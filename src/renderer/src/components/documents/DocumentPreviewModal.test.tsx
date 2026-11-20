// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DocumentPreviewModal } from './DocumentPreviewModal'
import type { DocumentPreviewDto } from '../../../../shared/knowledge-documents'

describe('DocumentPreviewModal (Phase 5 Step 5.11)', () => {
  const kbId = '11111111-1111-4111-8111-111111111111'
  const sourceId = 'src-1111-1111-1111-111111111111'

  const samplePreview: DocumentPreviewDto = {
    sourceId,
    knowledgeBaseId: kbId,
    originalFileName: 'research_notes.md',
    fileType: 'md',
    fileSize: 4096,
    status: 'completed',
    totalChunks: 8,
    chunks: [
      {
        chunkId: 'chunk-1',
        chunkIndex: 0,
        content: 'Section 1 content with <script>alert("xss")</script> code example.',
        tokenCount: 15,
        pageNumber: null,
        heading: 'Introduction',
        headingLevel: 1,
        headingPath: ['Introduction']
      },
      {
        chunkId: 'chunk-2',
        chunkIndex: 1,
        content: 'Section 2 text with page reference.',
        tokenCount: 10,
        pageNumber: 2,
        heading: 'Architecture',
        headingLevel: 2,
        headingPath: ['Introduction', 'Architecture']
      }
    ]
  }

  let previewMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    previewMock = vi.fn().mockResolvedValue(samplePreview)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      knowledgeDocuments: {
        preview: previewMock
      }
    }
  })

  afterEach(() => {
    cleanup()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
    vi.restoreAllMocks()
  })

  it('1. returns null when isOpen is false', () => {
    const { container } = render(
      <DocumentPreviewModal
        isOpen={false}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('2. shows loading state while preview data is in flight', () => {
    previewMock.mockReturnValueOnce(new Promise(() => {}))

    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('preview-loading')).toBeDefined()
  })

  it('3. renders error banner when preview API rejects', async () => {
    previewMock.mockRejectedValueOnce(new Error('Document is corrupt or unreadable.'))

    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByTestId('preview-error')).toBeDefined()
    expect(screen.getByText(/Document is corrupt or unreadable/)).toBeDefined()
  })

  it('4. renders document metadata, bounded chunks, headings and page numbers', async () => {
    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByTestId('preview-title')).toBeDefined()
    expect(screen.getByText('research_notes.md')).toBeDefined()
    expect(screen.getByText('MD')).toBeDefined()
    expect(screen.getByText(/4\.0 KB/)).toBeDefined()
    expect(screen.getByText(/Total Chunks:/)).toBeDefined()

    // Bounded chunk excerpts
    expect(screen.getByTestId('preview-chunk-0')).toBeDefined()
    expect(screen.getByTestId('preview-chunk-1')).toBeDefined()
    expect(screen.getByText('Introduction > Architecture')).toBeDefined()
    expect(screen.getByText(/Page 2/)).toBeDefined()

    // Untrusted content rendered as text, not HTML
    expect(screen.getByText(/<script>alert\("xss"\)<\/script>/)).toBeDefined()
  })

  it('5. calls onClose when close button or dismiss button is clicked', async () => {
    const closeSpy = vi.fn()
    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={closeSpy}
      />
    )

    await screen.findByTestId('preview-title')

    fireEvent.click(screen.getByTestId('btn-close-preview'))
    expect(closeSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('btn-dismiss-preview'))
    expect(closeSpy).toHaveBeenCalledTimes(2)
  })

  it('6. calls onClose on Escape keypress', async () => {
    const closeSpy = vi.fn()
    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={closeSpy}
      />
    )

    await screen.findByTestId('preview-title')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('7. renders Slide badge instead of Page for PPTX documents', async () => {
    const pptxPreview: DocumentPreviewDto = {
      sourceId,
      knowledgeBaseId: kbId,
      originalFileName: 'briefing.pptx',
      fileType: 'pptx',
      fileSize: 12345,
      status: 'completed',
      totalChunks: 1,
      chunks: [
        {
          chunkId: 'chunk-pptx-1',
          chunkIndex: 0,
          pageNumber: 4,
          heading: 'Executive Summary',
          headingLevel: 2,
          headingPath: ['Executive Summary'],
          content: 'Slide content regarding mission architecture.',
          tokenCount: 15
        }
      ]
    }
    previewMock.mockResolvedValueOnce(pptxPreview)

    render(
      <DocumentPreviewModal
        isOpen={true}
        sourceId={sourceId}
        knowledgeBaseId={kbId}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByTestId('preview-title')).toBeDefined()
    expect(screen.getByText('briefing.pptx')).toBeDefined()
    expect(screen.getByText('PPTX')).toBeDefined()
    expect(screen.getByText(/Slide 4/)).toBeDefined()
  })
})
