// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { PrivacyTransparencySection } from './PrivacyTransparencySection'
import type { LocalStorageInfoDto } from '../../../../shared/privacy'

describe('PrivacyTransparencySection (Step 9.9)', () => {
  const dummyStorageInfo: LocalStorageInfoDto = {
    userDataPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro',
    databasePath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\database\\app.sqlite',
    documentsPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\documents',
    credentialsPath: 'C:\\Users\\User\\AppData\\Roaming\\voyaro\\credentials',
    platform: 'win32',
    encryptionAvailable: true,
    encryptionBackend: 'dpapi',
    databaseSizeBytes: 2097152,
    walSizeBytes: 131072
  }

  let mockGetStorageInfo: ReturnType<typeof vi.fn>
  let mockOpenStorageFolder: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGetStorageInfo = vi.fn().mockResolvedValue(dummyStorageInfo)
    mockOpenStorageFolder = vi.fn().mockResolvedValue({ success: true, target: 'userData' })

    window.api = {
      ...window.api,
      privacy: {
        getStorageInfo: mockGetStorageInfo,
        openStorageFolder: mockOpenStorageFolder
      }
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('1. renders all required privacy and transparency sections', async () => {
    render(<PrivacyTransparencySection />)

    expect(screen.getByTestId('privacy-transparency-section')).toBeTruthy()
    expect(screen.getByTestId('privacy-overview-card')).toBeTruthy()
    expect(screen.getByTestId('local-storage-card')).toBeTruthy()
    expect(screen.getByTestId('provider-transmission-card')).toBeTruthy()
    expect(screen.getByTestId('credentials-security-card')).toBeTruthy()
    expect(screen.getByTestId('billing-card')).toBeTruthy()
    expect(screen.getByTestId('backups-card')).toBeTruthy()
    expect(screen.getByTestId('diagnostics-privacy-card')).toBeTruthy()
    expect(screen.getByTestId('deletion-retention-card')).toBeTruthy()
    expect(screen.getByTestId('network-card')).toBeTruthy()
  })

  it('2. loads and renders authoritative storage paths and encryption status', async () => {
    render(<PrivacyTransparencySection />)

    await waitFor(() => {
      expect(mockGetStorageInfo).toHaveBeenCalled()
      expect(screen.getByTestId('app-data-path-val').textContent).toContain(
        dummyStorageInfo.userDataPath
      )
      expect(screen.getByTestId('database-path-val').textContent).toContain(
        dummyStorageInfo.databasePath
      )
      expect(screen.getByTestId('documents-path-val').textContent).toContain(
        dummyStorageInfo.documentsPath
      )
      expect(screen.getByTestId('credentials-path-val').textContent).toContain(
        dummyStorageInfo.credentialsPath
      )
      expect(screen.getByTestId('encryption-status-val').textContent).toContain('dpapi')
    })
  })

  it('3. triggers safe folder open actions for allowlisted targets', async () => {
    render(<PrivacyTransparencySection />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-open-userdata-folder')).toBeTruthy()
    })

    const appDataBtn = screen.getByTestId('btn-open-userdata-folder')
    fireEvent.click(appDataBtn)

    await waitFor(() => {
      expect(mockOpenStorageFolder).toHaveBeenCalledWith('userData')
      expect(screen.getByTestId('privacy-action-success')).toBeTruthy()
    })

    const docsBtn = screen.getByTestId('btn-open-documents-folder')
    fireEvent.click(docsBtn)

    await waitFor(() => {
      expect(mockOpenStorageFolder).toHaveBeenCalledWith('documents')
    })

    const dbBtn = screen.getByTestId('btn-open-database-folder')
    fireEvent.click(dbBtn)

    await waitFor(() => {
      expect(mockOpenStorageFolder).toHaveBeenCalledWith('database')
    })
  })

  it('4. displays error notification when folder open action fails', async () => {
    mockOpenStorageFolder.mockRejectedValueOnce(new Error('OS folder access failed'))

    render(<PrivacyTransparencySection />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-open-userdata-folder')).toBeTruthy()
    })

    const appDataBtn = screen.getByTestId('btn-open-userdata-folder')
    fireEvent.click(appDataBtn)

    await waitFor(() => {
      expect(screen.getByTestId('privacy-action-error').textContent).toContain(
        'OS folder access failed'
      )
    })
  })

  it('5. discloses accurate provider transmission boundaries including Agent Task tool outputs', () => {
    render(<PrivacyTransparencySection />)

    // Expand transmission section
    const transmissionHeader = screen.getByText('AI Provider Data Transmission')
    fireEvent.click(transmissionHeader)

    expect(
      screen.getByText(
        /Knowledge Base documents are stored locally, but relevant retrieved text excerpts/i
      )
    ).toBeTruthy()
    expect(screen.getByText(/When an agent tool reads a workspace file/i)).toBeTruthy()
  })

  it('6. discloses backup contents, unencrypted warning, and deletion limitations', () => {
    render(<PrivacyTransparencySection />)

    // Expand backups section
    const backupsHeader = screen.getByText('Knowledge Base Export & Backup Privacy')
    fireEvent.click(backupsHeader)

    expect(screen.getByText(/Archive Privacy Advisory:/i)).toBeTruthy()
    expect(
      screen.getByText(
        /Deleting a Knowledge Base within the app does not automatically delete previously exported ZIP files/i
      )
    ).toBeTruthy()

    // Expand deletion section
    const deletionHeader = screen.getByText('Data Deletion & Retention Boundaries')
    fireEvent.click(deletionHeader)

    expect(screen.getByText(/Deletion Limitations:/i)).toBeTruthy()
    expect(screen.getByText(/revoke the API key at the provider/i)).toBeTruthy()
  })

  it('7. discloses verified external endpoints and absence of telemetry', () => {
    render(<PrivacyTransparencySection />)

    const networkHeader = screen.getByText('External Network Activity')
    fireEvent.click(networkHeader)

    expect(screen.getByText('https://api.openai.com/v1')).toBeTruthy()
    expect(screen.getByText('https://api.anthropic.com/v1')).toBeTruthy()
    expect(screen.getByText('https://generativelanguage.googleapis.com/v1beta')).toBeTruthy()
    expect(
      screen.getByText(/zero telemetry endpoints, zero third-party analytics trackers/i)
    ).toBeTruthy()
  })
})
