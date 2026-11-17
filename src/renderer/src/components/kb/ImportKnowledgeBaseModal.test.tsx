// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ImportKnowledgeBaseModal } from './ImportKnowledgeBaseModal'
import { KnowledgeBaseProvider } from '../../contexts/KnowledgeBaseContext'
import type { KnowledgeBaseDto, KnowledgeBaseApi } from '../../../../shared/knowledge-bases'
import type {
  ImportPreviewResultDto,
  ExecuteImportResultDto,
  CancelImportResultDto
} from '../../../../shared/export-archive'

describe('ImportKnowledgeBaseModal', () => {
  const activeKb1: KnowledgeBaseDto = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Primary Knowledge Base',
    description: 'Main workspace',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    archivedAt: null
  }

  const activeKb2: KnowledgeBaseDto = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Secondary Knowledge Base',
    description: 'Secondary workspace',
    createdAt: 1700000010000,
    updatedAt: 1700000015000,
    archivedAt: null
  }

  const mockPreviewResult: ImportPreviewResultDto = {
    success: true,
    cancelled: false,
    preview: {
      sessionId: '99999999-9999-4999-8999-999999999999',
      archiveName: 'project-export.voyaro-kb.zip',
      archiveSizeBytes: 102400,
      format: 'voyaro-knowledge-base-export',
      schemaVersion: '1.0.0',
      exportedAt: 1700000020000,
      appVersion: '1.0.0',
      knowledgeBase: {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Exported Alpha Project',
        description: 'Alpha workspace backup'
      },
      counts: {
        bots: 3,
        memories: 5,
        sources: 2,
        conversations: 4,
        messages: 16,
        totalSourceBytes: 50000
      },
      documentFiles: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          originalFileName: 'spec.md',
          fileType: 'md',
          sizeBytes: 25000
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          originalFileName: 'notes.txt',
          fileType: 'txt',
          sizeBytes: 25000
        }
      ],
      securityNotice: 'All bot provider connections will be reset to disconnected state.'
    }
  }

  const mockSelectAndPreview = vi.fn()
  const mockExecute = vi.fn()
  const mockCancel = vi.fn()
  const mockList = vi.fn()

  let mockApi: KnowledgeBaseApi

  beforeEach(() => {
    vi.clearAllMocks()

    mockList.mockResolvedValue([activeKb1, activeKb2])
    mockSelectAndPreview.mockResolvedValue(mockPreviewResult)
    mockExecute.mockResolvedValue({
      success: true,
      cancelled: false,
      strategy: 'new',
      knowledgeBaseId: '44444444-4444-4444-8444-444444444444',
      knowledgeBaseName: 'Exported Alpha Project',
      counts: {
        bots: 3,
        memories: 5,
        sources: 2,
        conversations: 4,
        messages: 16,
        indexedSources: 2,
        failedSources: 0
      }
    } satisfies ExecuteImportResultDto)
    mockCancel.mockResolvedValue({ success: true } satisfies CancelImportResultDto)

    mockApi = {
      list: mockList,
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      delete: vi.fn(),
      getOverview: vi.fn(),
      importSelectAndPreview: mockSelectAndPreview,
      importExecute: mockExecute,
      importCancel: mockCancel
    }

    window.api = {
      ...window.api,
      knowledgeBases: mockApi
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
  })

  function renderWithContext(ui: React.ReactElement): ReturnType<typeof render> {
    return render(<KnowledgeBaseProvider api={mockApi}>{ui}</KnowledgeBaseProvider>)
  }

  it('1. does not render when isOpen is false', () => {
    renderWithContext(<ImportKnowledgeBaseModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('import-kb-modal')).toBeNull()
  })

  it('2. renders step 1 (select step) and triggers native archive picker', async () => {
    renderWithContext(<ImportKnowledgeBaseModal isOpen={true} onClose={vi.fn()} />)

    expect(screen.getByTestId('import-kb-modal')).toBeDefined()
    expect(screen.getByTestId('import-kb-select-step')).toBeDefined()
    expect(screen.getByText('Select Backup Archive')).toBeDefined()

    const selectBtn = screen.getByTestId('btn-select-archive-file')
    fireEvent.click(selectBtn)

    await waitFor(() => {
      expect(mockSelectAndPreview).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('import-kb-preview-step')).toBeDefined()
      expect(screen.getByText('Exported Alpha Project')).toBeDefined()
      expect(screen.getByTestId('import-kb-preview-counts')).toBeDefined()
    })
  })

  it('3. toggles included document files list in preview step', async () => {
    renderWithContext(<ImportKnowledgeBaseModal isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('btn-select-archive-file'))

    await waitFor(() => {
      expect(screen.getByTestId('btn-toggle-file-list')).toBeDefined()
    })

    // Initially file list is collapsed
    expect(screen.queryByTestId('import-kb-file-list')).toBeNull()

    // Expand
    fireEvent.click(screen.getByTestId('btn-toggle-file-list'))
    expect(screen.getByTestId('import-kb-file-list')).toBeDefined()
    expect(screen.getByText('spec.md')).toBeDefined()
    expect(screen.getByText('notes.txt')).toBeDefined()

    // Collapse
    fireEvent.click(screen.getByTestId('btn-toggle-file-list'))
    expect(screen.queryByTestId('import-kb-file-list')).toBeNull()
  })

  it('4. executes import with Strategy 1 (New KB) and shows success summary', async () => {
    const onComplete = vi.fn()
    renderWithContext(
      <ImportKnowledgeBaseModal isOpen={true} onClose={vi.fn()} onImportSuccess={onComplete} />
    )

    fireEvent.click(screen.getByTestId('btn-select-archive-file'))

    await waitFor(() => {
      expect(screen.getByTestId('btn-execute-import')).toBeDefined()
    })

    // Default strategy is 'new'
    expect(screen.getByTestId('radio-strategy-new')).toBeDefined()

    fireEvent.click(screen.getByTestId('btn-execute-import'))

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith({
        sessionId: '99999999-9999-4999-8999-999999999999',
        strategy: 'new'
      })
      expect(screen.getByTestId('import-kb-success-step')).toBeDefined()
      expect(screen.getByText('Knowledge Base Restored Successfully')).toBeDefined()
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('5. executes import with Strategy 2 (Merge)', async () => {
    renderWithContext(<ImportKnowledgeBaseModal isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('btn-select-archive-file'))

    await waitFor(() => {
      expect(screen.getByTestId('radio-strategy-merge')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('radio-strategy-merge'))

    await waitFor(() => {
      expect(screen.getByTestId('select-target-kb-merge')).toBeDefined()
    })

    // Select second KB
    fireEvent.change(screen.getByTestId('select-target-kb-merge'), {
      target: { value: activeKb2.id }
    })

    fireEvent.click(screen.getByTestId('btn-execute-import'))

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith({
        sessionId: '99999999-9999-4999-8999-999999999999',
        strategy: 'merge',
        targetKnowledgeBaseId: activeKb2.id
      })
    })
  })

  it('6. requires exact name confirmation for Strategy 3 (Replace) before enabling execution', async () => {
    renderWithContext(<ImportKnowledgeBaseModal isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('btn-select-archive-file'))

    await waitFor(() => {
      expect(screen.getByTestId('radio-strategy-replace')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('radio-strategy-replace'))

    await waitFor(() => {
      expect(screen.getByTestId('select-target-kb-replace')).toBeDefined()
      expect(screen.getByTestId('input-replace-confirmation-name')).toBeDefined()
    })

    const executeBtn = screen.getByTestId('btn-execute-import') as HTMLButtonElement
    // Button must be disabled until exact match
    expect(executeBtn.disabled).toBe(true)

    // Type partial/wrong name
    fireEvent.change(screen.getByTestId('input-replace-confirmation-name'), {
      target: { value: 'Wrong Name' }
    })
    expect(executeBtn.disabled).toBe(true)

    // Type exact target KB name (activeKb1 is first default)
    fireEvent.change(screen.getByTestId('input-replace-confirmation-name'), {
      target: { value: activeKb1.name }
    })
    expect(executeBtn.disabled).toBe(false)

    fireEvent.click(executeBtn)

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith({
        sessionId: '99999999-9999-4999-8999-999999999999',
        strategy: 'replace',
        targetKnowledgeBaseId: activeKb1.id,
        confirmationName: activeKb1.name
      })
    })
  })

  it('7. calls importCancel when closing modal during preview step', async () => {
    const onClose = vi.fn()
    renderWithContext(<ImportKnowledgeBaseModal isOpen={true} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('btn-select-archive-file'))

    await waitFor(() => {
      expect(screen.getByTestId('btn-cancel-preview')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('btn-cancel-preview'))

    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledWith({
        sessionId: '99999999-9999-4999-8999-999999999999'
      })
      expect(onClose).toHaveBeenCalled()
    })
  })
})
