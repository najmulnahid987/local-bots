// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { SettingsPage } from './SettingsPage'

describe('SettingsPage Component', () => {
  beforeEach(() => {
    window.api = {
      ping: vi.fn(),
      providers: {
        getCatalog: vi.fn().mockResolvedValue({ providers: [], models: [] }),
        listConnections: vi.fn().mockResolvedValue([])
      } as unknown as (typeof window.api)['providers'],
      knowledgeBases: {} as unknown as (typeof window.api)['knowledgeBases'],
      diagnostics: {
        getDatabaseHealth: vi.fn().mockResolvedValue({
          status: 'healthy',
          integrityStatus: 'ok',
          foreignKeyStatus: 'ok',
          databaseAvailable: true,
          databaseSizeBytes: 65536,
          walSizeBytes: 0,
          lastVerifiedAt: Date.now(),
          violationsCount: 0,
          violations: [],
          summary: 'Database is healthy.',
          diagnosticCodes: [],
          recoveryGuidance: []
        }),
        runIntegrityCheck: vi.fn(),
        exportDiagnostics: vi.fn()
      } as unknown as (typeof window.api)['diagnostics'],
      privacy: {
        getStorageInfo: vi.fn().mockResolvedValue({
          userDataPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro',
          databasePath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\database\\app.sqlite',
          documentsPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\documents',
          credentialsPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\credentials',
          platform: 'win32',
          encryptionAvailable: true,
          encryptionBackend: 'dpapi',
          databaseSizeBytes: 65536,
          walSizeBytes: 0
        }),
        openStorageFolder: vi.fn().mockResolvedValue({ success: true, target: 'userData' })
      } as unknown as (typeof window.api)['privacy']
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders provider connections, database health, and privacy sections', async () => {
    render(<SettingsPage />)

    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('AI Provider Connections')).toBeTruthy()
    expect(screen.getByText('Database Health & Diagnostics')).toBeTruthy()
    expect(screen.getByText('Privacy & Transparency')).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByTestId('database-health-section')).toBeTruthy()
      expect(screen.getByTestId('privacy-transparency-section')).toBeTruthy()
    })
  })
})
