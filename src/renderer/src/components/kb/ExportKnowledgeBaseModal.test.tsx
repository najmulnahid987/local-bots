// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ExportKnowledgeBaseModal } from './ExportKnowledgeBaseModal'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

describe('ExportKnowledgeBaseModal', () => {
  const mockKb: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Research Workspace',
    description: 'A test research KB',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    archivedAt: null
  }

  const mockExport = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    window.api = {
      ...window.api,
      knowledgeBases: {
        ...window.api?.knowledgeBases,
        export: mockExport
      }
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
  })

  it('does not render when isOpen is false', () => {
    render(<ExportKnowledgeBaseModal isOpen={false} knowledgeBase={mockKb} onClose={vi.fn()} />)
    expect(screen.queryByTestId('export-kb-modal')).toBeNull()
  })

  it('renders disclosure information when isOpen is true', () => {
    render(<ExportKnowledgeBaseModal isOpen={true} knowledgeBase={mockKb} onClose={vi.fn()} />)

    expect(screen.getByTestId('export-kb-modal')).toBeDefined()
    expect(screen.getByText('Export Knowledge Base')).toBeDefined()
    expect(screen.getByText('Research Workspace')).toBeDefined()
    expect(screen.getByText('Included in archive:')).toBeDefined()
    expect(screen.getByText('Privacy & Security Guarantees:')).toBeDefined()
    expect(screen.getByTestId('btn-confirm-export-kb')).toBeDefined()
  })

  it('triggers export via window.api and displays success state with counts', async () => {
    mockExport.mockResolvedValueOnce({
      success: true,
      knowledgeBaseId: mockKb.id,
      archivePath: 'C:\\exports\\research-export.voyaro-kb.zip',
      archiveSizeBytes: 204800, // 200 KB
      counts: {
        bots: 2,
        memories: 4,
        sources: 3,
        conversations: 5,
        messages: 25,
        totalSourceBytes: 150000
      }
    })

    const onComplete = vi.fn()
    render(
      <ExportKnowledgeBaseModal
        isOpen={true}
        knowledgeBase={mockKb}
        onClose={vi.fn()}
        onExportComplete={onComplete}
      />
    )

    const exportBtn = screen.getByTestId('btn-confirm-export-kb')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      expect(mockExport).toHaveBeenCalledWith(mockKb.id)
      expect(screen.getByTestId('export-kb-success')).toBeDefined()
      expect(screen.getByText('Export Completed Successfully')).toBeDefined()
      expect(screen.getByTestId('export-kb-counts')).toBeDefined()
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('displays error message when export fails', async () => {
    mockExport.mockResolvedValueOnce({
      success: false,
      knowledgeBaseId: mockKb.id,
      error: 'Integrity check failed: missing source file.'
    })

    render(<ExportKnowledgeBaseModal isOpen={true} knowledgeBase={mockKb} onClose={vi.fn()} />)

    const exportBtn = screen.getByTestId('btn-confirm-export-kb')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      expect(screen.getByTestId('export-kb-error')).toBeDefined()
      expect(screen.getByText('Integrity check failed: missing source file.')).toBeDefined()
    })
  })

  it('resets gracefully when user cancels save dialog', async () => {
    mockExport.mockResolvedValueOnce({
      success: false,
      cancelled: true,
      knowledgeBaseId: mockKb.id
    })

    render(<ExportKnowledgeBaseModal isOpen={true} knowledgeBase={mockKb} onClose={vi.fn()} />)

    const exportBtn = screen.getByTestId('btn-confirm-export-kb')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      expect(mockExport).toHaveBeenCalledWith(mockKb.id)
      // Should not show error or success
      expect(screen.queryByTestId('export-kb-error')).toBeNull()
      expect(screen.queryByTestId('export-kb-success')).toBeNull()
      // Button should still be enabled
      expect((screen.getByTestId('btn-confirm-export-kb') as HTMLButtonElement).disabled).toBe(
        false
      )
    })
  })
})
