// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DatabaseHealthSection } from './DatabaseHealthSection'
import type { DatabaseHealthDto, DiagnosticsExportResultDto } from '../../../../shared/diagnostics'

describe('DatabaseHealthSection Component', () => {
  const healthyDto: DatabaseHealthDto = {
    status: 'healthy',
    integrityStatus: 'ok',
    foreignKeyStatus: 'ok',
    databaseAvailable: true,
    databaseSizeBytes: 1048576, // 1 MB
    walSizeBytes: 32768, // 32 KB
    lastVerifiedAt: 1731800000000,
    violationsCount: 0,
    violations: [],
    summary: 'Database is healthy and fully consistent. All integrity constraints verified.',
    diagnosticCodes: [],
    recoveryGuidance: []
  }

  const warningDto: DatabaseHealthDto = {
    status: 'warning',
    integrityStatus: 'ok',
    foreignKeyStatus: 'violations_detected',
    databaseAvailable: true,
    databaseSizeBytes: 2097152,
    walSizeBytes: 65536,
    lastVerifiedAt: 1731800000000,
    violationsCount: 2,
    violations: [
      { table: 'bots', rowid: 1, parent: 'knowledge_bases', fkid: 0 },
      { table: 'messages', rowid: 4, parent: 'conversations', fkid: 0 }
    ],
    summary: 'Foreign key constraint violations detected (2).',
    diagnosticCodes: ['FOREIGN_KEY_VIOLATIONS'],
    recoveryGuidance: [
      'Do not delete active SQLite or WAL files manually.',
      'Export sanitized diagnostics for technical troubleshooting.',
      'Restore Knowledge Base from a verified archive if orphaned records persist.'
    ]
  }

  const criticalDto: DatabaseHealthDto = {
    status: 'critical',
    integrityStatus: 'failed',
    foreignKeyStatus: 'error',
    databaseAvailable: true,
    databaseSizeBytes: 1048576,
    walSizeBytes: 0,
    lastVerifiedAt: 1731800000000,
    violationsCount: 0,
    violations: [],
    summary: 'SQLite integrity check failed (page 42 corruption detected).',
    diagnosticCodes: ['INTEGRITY_CHECK_FAILED'],
    recoveryGuidance: [
      'Do not delete the active database or WAL log manually.',
      'Restore from a verified Knowledge Base backup archive (.voyaro-kb.zip).'
    ]
  }

  const exportResultDto: DiagnosticsExportResultDto = {
    success: true,
    filename: 'local-first-ai-diagnostics-2026-11-17.json',
    sizeBytes: 4096,
    exportedAt: 1731800000000,
    schemaVersion: '1.0.0',
    verified: true
  }

  beforeEach(() => {
    window.api = {
      ping: vi.fn(),
      providers: {} as unknown as (typeof window.api)['providers'],
      knowledgeBases: {} as unknown as (typeof window.api)['knowledgeBases'],
      diagnostics: {
        getDatabaseHealth: vi.fn().mockResolvedValue(healthyDto),
        runIntegrityCheck: vi.fn().mockResolvedValue(healthyDto),
        exportDiagnostics: vi.fn().mockResolvedValue(exportResultDto)
      } as unknown as (typeof window.api)['diagnostics']
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders healthy state properly on initial mount', async () => {
    render(<DatabaseHealthSection />)

    expect(screen.getByText('Database Health & Diagnostics')).toBeTruthy()
    expect(window.api.diagnostics!.getDatabaseHealth).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge').textContent).toContain('Healthy')
    })

    expect(screen.getByTestId('integrity-status-val').textContent).toBe('Passed (OK)')
    expect(screen.getByTestId('foreign-key-status-val').textContent).toBe(
      'Consistent (No violations)'
    )
    expect(screen.getByTestId('database-size-val').textContent).toBe('1.0 MB')
    expect(screen.getByTestId('wal-size-val').textContent).toBe('32.0 KB')
    expect(screen.queryByTestId('recovery-guidance-box')).toBeNull()
  })

  it('renders warning status with warning badge, violation count, and recovery guidance', async () => {
    vi.mocked(window.api.diagnostics!.getDatabaseHealth).mockResolvedValueOnce(warningDto)

    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge').textContent).toContain('Warning')
    })

    expect(screen.getByTestId('foreign-key-status-val').textContent).toContain(
      '2 constraint violation(s) detected'
    )
    const guidanceBox = screen.getByTestId('recovery-guidance-box')
    expect(guidanceBox).toBeTruthy()
    expect(guidanceBox.textContent).toContain('Do not delete active SQLite or WAL files manually.')
    expect(guidanceBox.textContent).toContain(
      'Export sanitized diagnostics for technical troubleshooting.'
    )
  })

  it('renders critical status with critical badge and guidance', async () => {
    vi.mocked(window.api.diagnostics!.getDatabaseHealth).mockResolvedValueOnce(criticalDto)

    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge').textContent).toContain('Critical')
    })

    expect(screen.getByTestId('integrity-status-val').textContent).toBe('Failed')
    const guidanceBox = screen.getByTestId('recovery-guidance-box')
    expect(guidanceBox).toBeTruthy()
    expect(guidanceBox.textContent).toContain(
      'Restore from a verified Knowledge Base backup archive'
    )
  })

  it('clicking "Run Integrity Check" triggers integrity check and updates UI', async () => {
    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge').textContent).toContain('Healthy')
    })

    // Mock runIntegrityCheck to return warningDto
    vi.mocked(window.api.diagnostics!.runIntegrityCheck).mockResolvedValueOnce(warningDto)

    const checkBtn = screen.getByTestId('run-integrity-check-button')
    fireEvent.click(checkBtn)

    await waitFor(() => {
      expect(window.api.diagnostics!.runIntegrityCheck).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('database-health-status-badge').textContent).toContain('Warning')
    })
  })

  it('clicking "Export Diagnostics" triggers export and shows success notification', async () => {
    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge')).toBeTruthy()
    })

    const exportBtn = screen.getByTestId('export-diagnostics-button')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      expect(window.api.diagnostics!.exportDiagnostics).toHaveBeenCalledTimes(1)
      const successNotice = screen.getByTestId('diagnostics-export-success')
      expect(successNotice).toBeTruthy()
      expect(successNotice.textContent).toContain('local-first-ai-diagnostics-2026-11-17.json')
      expect(successNotice.textContent).toContain('4.0 KB')
    })
  })

  it('ignores cancelled diagnostics export without error', async () => {
    vi.mocked(window.api.diagnostics!.exportDiagnostics).mockResolvedValueOnce({
      success: false,
      cancelled: true
    })

    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge')).toBeTruthy()
    })

    const exportBtn = screen.getByTestId('export-diagnostics-button')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      expect(window.api.diagnostics!.exportDiagnostics).toHaveBeenCalledTimes(1)
    })

    expect(screen.queryByTestId('diagnostics-export-success')).toBeNull()
    expect(screen.queryByTestId('diagnostics-error')).toBeNull()
  })

  it('displays error notice when exportDiagnostics fails', async () => {
    vi.mocked(window.api.diagnostics!.exportDiagnostics).mockResolvedValueOnce({
      success: false,
      cancelled: false,
      error: 'Permission denied writing to destination'
    })

    render(<DatabaseHealthSection />)

    await waitFor(() => {
      expect(screen.getByTestId('database-health-status-badge')).toBeTruthy()
    })

    const exportBtn = screen.getByTestId('export-diagnostics-button')
    fireEvent.click(exportBtn)

    await waitFor(() => {
      const errorNotice = screen.getByTestId('diagnostics-error')
      expect(errorNotice).toBeTruthy()
      expect(errorNotice.textContent).toContain('Permission denied writing to destination')
    })
  })

  it('displays error notice when getDatabaseHealth fails', async () => {
    vi.mocked(window.api.diagnostics!.getDatabaseHealth).mockRejectedValueOnce(
      new Error('Failed reading database')
    )

    render(<DatabaseHealthSection />)

    await waitFor(() => {
      const errorNotice = screen.getByTestId('diagnostics-error')
      expect(errorNotice).toBeTruthy()
      expect(errorNotice.textContent).toContain('Failed reading database')
    })
  })

  it('renders privacy notice explaining non-destructive design and secret omission', () => {
    render(<DatabaseHealthSection />)

    expect(screen.getByText(/Diagnostic Privacy & Non-Destructive Design/)).toBeTruthy()
    expect(screen.getByText(/numeric counts, schema versions, hardware descriptors/)).toBeTruthy()
  })
})
