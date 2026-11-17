// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { DocumentDeleteConfirmModal } from './DocumentDeleteConfirmModal'

describe('DocumentDeleteConfirmModal (Step 9.8)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('1. returns null when isOpen is false', () => {
    const { container } = render(
      <DocumentDeleteConfirmModal
        isOpen={false}
        documentName="quarterly-report.pdf"
        isDeleting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('2. renders document name, removal warning, and citation safety note', () => {
    render(
      <DocumentDeleteConfirmModal
        isOpen={true}
        documentName="quarterly-report.pdf"
        isDeleting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('document-delete-modal')).toBeDefined()
    expect(screen.getByTestId('delete-document-name').textContent).toContain('quarterly-report.pdf')
    expect(
      screen.getByText(/This operation safely removes the original managed file/)
    ).toBeDefined()
    expect(screen.getByTestId('document-citation-safety-alert')).toBeDefined()
    expect(
      screen.getByText(/Historical conversation messages citing this document will remain/)
    ).toBeDefined()
  })

  it('3. calls onCancel and onConfirm appropriately', () => {
    const handleConfirm = vi.fn()
    const handleCancel = vi.fn()

    render(
      <DocumentDeleteConfirmModal
        isOpen={true}
        documentName="quarterly-report.pdf"
        isDeleting={false}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    )

    fireEvent.click(screen.getByTestId('btn-cancel-delete'))
    expect(handleCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('btn-confirm-delete'))
    expect(handleConfirm).toHaveBeenCalledTimes(1)
  })

  it('4. loads deletion preview and displays extracted chunk count', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      deletion: {
        getPreview: vi.fn(async () => ({
          entityType: 'knowledge_source',
          entityId: 'source-123',
          displayName: 'quarterly-report.pdf',
          parentName: 'Alpha KB',
          parentId: 'kb-123',
          dependentCounts: { chunks: 18 },
          affectedCategories: ['Original file', 'Text chunks'],
          unaffectedCategories: ['Historical messages'],
          backupReversible: true,
          isBlocked: false,
          warnings: []
        }))
      }
    }

    render(
      <DocumentDeleteConfirmModal
        isOpen={true}
        documentName="quarterly-report.pdf"
        sourceId="source-123"
        isDeleting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId('document-chunks-count')).toBeDefined()
    expect(screen.getByText('18')).toBeDefined()
  })

  it('5. blocks deletion when preview indicates document indexing is active', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      deletion: {
        getPreview: vi.fn(async () => ({
          entityType: 'knowledge_source',
          entityId: 'source-123',
          displayName: 'quarterly-report.pdf',
          parentName: 'Alpha KB',
          parentId: 'kb-123',
          dependentCounts: { chunks: 0 },
          affectedCategories: [],
          unaffectedCategories: [],
          backupReversible: true,
          isBlocked: true,
          blockReason:
            'Document is currently being parsed or indexed. Please wait for indexing to finish.',
          warnings: []
        }))
      }
    }

    render(
      <DocumentDeleteConfirmModal
        isOpen={true}
        documentName="quarterly-report.pdf"
        sourceId="source-123"
        isDeleting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId('delete-document-blocked-alert')).toBeDefined()
    expect(screen.getByText(/Document is currently being parsed or indexed/)).toBeDefined()

    const confirmBtn = screen.getByTestId('btn-confirm-delete')
    expect(confirmBtn.getAttribute('disabled')).not.toBeNull()
  })
})
