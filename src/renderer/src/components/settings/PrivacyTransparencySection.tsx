import { ReactElement, useState, useEffect, useCallback } from 'react'
import {
  Shield,
  HardDrive,
  Cpu,
  KeyRound,
  CreditCard,
  FolderArchive,
  FileText,
  Trash2,
  Globe,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Lock,
  Loader2
} from 'lucide-react'
import type { LocalStorageInfoDto, StorageTarget } from '../../../../shared/privacy'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`
}

export function PrivacyTransparencySection(): ReactElement {
  const [storageInfo, setStorageInfo] = useState<LocalStorageInfoDto | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [isOpeningFolder, setIsOpeningFolder] = useState<string | null>(null)

  // Expandable sections state
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    transmission: false,
    credentials: true,
    storage: true,
    deletion: false,
    backups: false,
    network: false
  })

  const toggleSection = (key: string): void => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  useEffect(() => {
    let isCancelled = false

    const loadStorageInfo = async (): Promise<void> => {
      setIsLoading(true)
      try {
        if (window.api?.privacy?.getStorageInfo) {
          const info = await window.api.privacy.getStorageInfo()
          if (!isCancelled) setStorageInfo(info)
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to retrieve storage info.'
          setActionError(msg)
        }
      } finally {
        if (!isCancelled) setIsLoading(false)
      }
    }

    void loadStorageInfo()
    return () => {
      isCancelled = true
    }
  }, [])

  const handleOpenFolder = useCallback(async (target: StorageTarget): Promise<void> => {
    setIsOpeningFolder(target)
    setActionError(null)
    setActionSuccess(null)
    try {
      if (!window.api?.privacy?.openStorageFolder) {
        throw new Error('Privacy API bridge is unavailable.')
      }
      const res = await window.api.privacy.openStorageFolder(target)
      if (res.success) {
        setActionSuccess(
          `Opened application folder (${target}) in your operating system file manager.`
        )
      } else {
        setActionError(res.error ?? `Failed to open folder (${target}).`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Failed to open ${target} folder.`
      setActionError(msg)
    } finally {
      setIsOpeningFolder(null)
    }
  }, [])

  return (
    <section
      className="settings-section"
      data-testid="privacy-transparency-section"
      aria-labelledby="privacy-settings-title"
    >
      <div className="settings-section-header">
        <div className="section-title-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Shield size={20} className="text-primary inline-icon" aria-hidden="true" />
            <h2 id="privacy-settings-title" className="section-title">
              Privacy & Transparency
            </h2>
          </div>
          <p className="section-description">
            Transparent disclosure of how your data is stored locally, when it is transmitted to AI
            providers, how credentials are encrypted, and what happens upon deletion.
          </p>
        </div>
      </div>

      {actionSuccess && (
        <div
          className="section-notification section-notification-success"
          role="status"
          data-testid="privacy-action-success"
        >
          <CheckCircle2 size={16} className="inline-icon" aria-hidden="true" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {actionError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="privacy-action-error"
        >
          <AlertCircle size={18} className="alert-icon" aria-hidden="true" />
          <div className="alert-body">
            <strong>Privacy Action Notice</strong>
            <p>{actionError}</p>
          </div>
        </div>
      )}

      {/* 1. Privacy Overview */}
      <div className="workspace-settings-card" data-testid="privacy-overview-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <Shield size={18} className="text-secondary" aria-hidden="true" />
          <strong style={{ fontSize: '15px' }}>Architecture & Sovereignty Overview</strong>
        </div>
        <p style={{ margin: '0 0 12px 0', fontSize: '13px', lineHeight: 1.6 }}>
          This application operates on a <strong>local-first</strong>, sovereign desktop foundation
          with a <strong>Bring Your Own Key (BYOK)</strong> model. Your workspace data—including
          Knowledge Bases, Bots, document files, semantic search chunks, and conversation
          histories—is stored directly on your personal computer.
        </p>
        <p style={{ margin: '0 0 12px 0', fontSize: '13px', lineHeight: 1.6 }}>
          <strong>Important Boundary:</strong> When you generate a response with an AI Bot or run an
          Autonomous Agent Task, the required context (your prompt, relevant conversation turns, Bot
          instructions, retrieved document excerpts, and saved memories) is sent{' '}
          <strong>directly</strong> to your selected AI provider (such as OpenAI, Anthropic, or
          Google) over direct TLS 1.3 connections. The application does <em>not</em> make a blanket
          promise that all data stays completely on this device.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '12px',
            marginTop: '12px'
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-bg-subtle, #f8fafc)',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--color-border)'
            }}
          >
            <div
              style={{ fontWeight: 600, fontSize: '12px', color: 'var(--color-text-secondary)' }}
            >
              LOCAL STORAGE
            </div>
            <div style={{ fontSize: '13px', marginTop: '4px' }}>
              Structured SQLite DB, FTS5 indexes, and original documents live on your machine.
            </div>
          </div>
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-bg-subtle, #f8fafc)',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--color-border)'
            }}
          >
            <div
              style={{ fontWeight: 600, fontSize: '12px', color: 'var(--color-text-secondary)' }}
            >
              AI TRANSMISSION
            </div>
            <div style={{ fontSize: '13px', marginTop: '4px' }}>
              Only active turn context and requested file excerpts are sent to your chosen provider.
            </div>
          </div>
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-bg-subtle, #f8fafc)',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--color-border)'
            }}
          >
            <div
              style={{ fontWeight: 600, fontSize: '12px', color: 'var(--color-text-secondary)' }}
            >
              NO INTERMEDIARY CLOUD
            </div>
            <div style={{ fontSize: '13px', marginTop: '4px' }}>
              Zero application-owned accounts, zero intermediate proxies, and zero telemetry
              tracking.
            </div>
          </div>
        </div>
      </div>

      {/* 2. Local Data Storage Inventory */}
      <div className="workspace-settings-card" data-testid="local-storage-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('storage')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('storage')}
          aria-expanded={expandedSections.storage}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <HardDrive size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>Local Data Storage Locations</strong>
          </div>
          {expandedSections.storage ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.storage && (
          <div style={{ marginTop: '16px' }}>
            <p
              style={{
                margin: '0 0 14px 0',
                fontSize: '13px',
                color: 'var(--color-text-secondary)'
              }}
            >
              The application stores structured data in embedded SQLite, original documents in
              managed directories, and encrypted credentials in OS-backed storage.
            </p>

            {isLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0' }}>
                <Loader2 size={16} className="spinner" />
                <span style={{ fontSize: '13px' }}>Loading authoritative storage paths...</span>
              </div>
            ) : storageInfo ? (
              <dl className="settings-metadata-list" data-testid="storage-paths-list">
                <div className="settings-metadata-row">
                  <dt className="settings-metadata-key">Application Data Folder</dt>
                  <dd className="settings-metadata-val" data-testid="app-data-path-val">
                    <code>{storageInfo.userDataPath}</code>
                  </dd>
                </div>
                <div className="settings-metadata-row">
                  <dt className="settings-metadata-key">SQLite Database</dt>
                  <dd className="settings-metadata-val" data-testid="database-path-val">
                    <code>{storageInfo.databasePath}</code>
                    <span
                      style={{
                        marginLeft: '8px',
                        fontSize: '12px',
                        color: 'var(--color-text-secondary)'
                      }}
                    >
                      ({formatBytes(storageInfo.databaseSizeBytes)} database,{' '}
                      {formatBytes(storageInfo.walSizeBytes)} WAL)
                    </span>
                  </dd>
                </div>
                <div className="settings-metadata-row">
                  <dt className="settings-metadata-key">Managed Documents</dt>
                  <dd className="settings-metadata-val" data-testid="documents-path-val">
                    <code>{storageInfo.documentsPath}</code>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '12px',
                        color: 'var(--color-text-secondary)',
                        marginTop: '2px'
                      }}
                    >
                      Files stored as
                      &lt;userData&gt;/documents/&lt;kbId&gt;/originals/&lt;sourceId&gt;.&lt;ext&gt;
                      with immutable UUID naming.
                    </span>
                  </dd>
                </div>
                <div className="settings-metadata-row">
                  <dt className="settings-metadata-key">Credential Vault</dt>
                  <dd className="settings-metadata-val" data-testid="credentials-path-val">
                    <code>{storageInfo.credentialsPath}</code>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '12px',
                        color: 'var(--color-text-secondary)',
                        marginTop: '2px'
                      }}
                    >
                      Encrypted binary blobs (cred_&lt;uuid&gt;.enc) protected by your operating
                      system.
                    </span>
                  </dd>
                </div>
              </dl>
            ) : null}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '16px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleOpenFolder('userData')}
                disabled={isOpeningFolder !== null}
                data-testid="btn-open-userdata-folder"
              >
                <FolderOpen size={14} className="inline-icon" aria-hidden="true" />
                <span>
                  {isOpeningFolder === 'userData' ? 'Opening...' : 'Show App Data Folder'}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleOpenFolder('documents')}
                disabled={isOpeningFolder !== null}
                data-testid="btn-open-documents-folder"
              >
                <FolderOpen size={14} className="inline-icon" aria-hidden="true" />
                <span>
                  {isOpeningFolder === 'documents' ? 'Opening...' : 'Show Documents Folder'}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleOpenFolder('database')}
                disabled={isOpeningFolder !== null}
                data-testid="btn-open-database-folder"
              >
                <FolderOpen size={14} className="inline-icon" aria-hidden="true" />
                <span>
                  {isOpeningFolder === 'database' ? 'Opening...' : 'Show Database Folder'}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 3. AI Provider Data Transmission */}
      <div className="workspace-settings-card" data-testid="provider-transmission-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('transmission')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('transmission')}
          aria-expanded={expandedSections.transmission}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cpu size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>AI Provider Data Transmission</strong>
          </div>
          {expandedSections.transmission ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.transmission && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ margin: '0 0 12px 0', fontSize: '13px', lineHeight: 1.6 }}>
              Information leaves your computer only when you explicitly generate an AI turn or start
              an Autonomous Agent Task. Outbound calls connect directly to official provider APIs:
            </p>

            <ul style={{ margin: '0 0 16px 20px', fontSize: '13px', lineHeight: 1.6 }}>
              <li>
                <strong>Normal Chat Turns:</strong> Sent data includes your current message,
                relevant conversation history (trimmed to model limits), Bot system instructions,
                relevant retrieved Knowledge Base excerpts, and relevant saved Bot memories.
              </li>
              <li>
                <strong>Knowledge Base Grounding:</strong> Knowledge Base documents are stored
                locally, but relevant retrieved text excerpts may be sent to your selected AI
                provider when you ask a question.
              </li>
              <li>
                <strong>Saved Bot Memories:</strong> Saved memories remain in local storage, but
                relevant memories (up to the 1,500-token budget) are appended to provider prompts.
              </li>
              <li>
                <strong>Autonomous Agent Tasks:</strong> The AI provider receives iterative task
                prompts. When an agent tool reads a workspace file or searches Knowledge Base
                documents, the tool&apos;s output is submitted to the provider for subsequent
                reasoning iterations.
              </li>
              <li>
                <strong>Provider Retention:</strong> Providers process requests under their own API
                terms and privacy policies. The application cannot control provider-side retention
                or server logging.
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* 4. API Credentials and Security */}
      <div className="workspace-settings-card" data-testid="credentials-security-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('credentials')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('credentials')}
          aria-expanded={expandedSections.credentials}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyRound size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>API Credentials & OS Protection</strong>
          </div>
          {expandedSections.credentials ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.credentials && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ margin: '0 0 12px 0', fontSize: '13px', lineHeight: 1.6 }}>
              You provide your own AI provider API keys. The application protects credentials using
              your operating system&apos;s hardware-backed secure storage:
            </p>

            <dl className="settings-metadata-list">
              <div className="settings-metadata-row">
                <dt className="settings-metadata-key">OS Secure Storage</dt>
                <dd className="settings-metadata-val" data-testid="encryption-status-val">
                  {storageInfo?.encryptionAvailable ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        color: '#166534',
                        fontWeight: 600
                      }}
                    >
                      <Lock size={14} /> Active ({storageInfo.encryptionBackend ?? 'Hardware/OS'})
                    </span>
                  ) : (
                    <span style={{ color: '#991b1b', fontWeight: 600 }}>
                      Unavailable or Weak Backend Blocked
                    </span>
                  )}
                </dd>
              </div>
              <div className="settings-metadata-row">
                <dt className="settings-metadata-key">Platform Mechanism</dt>
                <dd className="settings-metadata-val">
                  Windows DPAPI (CryptProtectData) • macOS Keychain • Linux Secret Service
                  (basic_text strictly blocked)
                </dd>
              </div>
              <div className="settings-metadata-row">
                <dt className="settings-metadata-key">In-Memory Decryption</dt>
                <dd className="settings-metadata-val">
                  Decrypted only in Main process memory during active HTTPS calls; never stored in
                  SQLite and never exposed across IPC to the React renderer.
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>

      {/* 5. API Billing */}
      <div className="workspace-settings-card" data-testid="billing-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <CreditCard size={18} className="text-secondary" aria-hidden="true" />
          <strong style={{ fontSize: '15px' }}>API Billing & Payment Responsibility</strong>
        </div>
        <p style={{ margin: '0 0 10px 0', fontSize: '13px', lineHeight: 1.6 }}>
          The application does <strong>not</strong> charge you for AI model usage. API usage is
          billed directly by your selected provider (OpenAI, Anthropic, or Google) according to your
          personal provider account, chosen model, token usage, and applicable pricing.
        </p>
        <p
          style={{
            margin: '0',
            fontSize: '13px',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.5
          }}
        >
          Different models and Autonomous Agent Tasks (which may perform up to 5 iterations) consume
          input and output tokens. Your provider controls all billing, usage limits, and account
          balances.
        </p>
      </div>

      {/* 6. Knowledge Base Backups */}
      <div className="workspace-settings-card" data-testid="backups-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('backups')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('backups')}
          aria-expanded={expandedSections.backups}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FolderArchive size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>Knowledge Base Export & Backup Privacy</strong>
          </div>
          {expandedSections.backups ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.backups && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ margin: '0 0 10px 0', fontSize: '13px', lineHeight: 1.6 }}>
              Knowledge Base backups (.voyaro-kb.zip) are portable archives designed for backup and
              migration:
            </p>
            <ul style={{ margin: '0 0 12px 20px', fontSize: '13px', lineHeight: 1.6 }}>
              <li>
                <strong>Included:</strong> Knowledge Base metadata, Bot configurations, saved Bot
                memories, Knowledge Source metadata, original source documents, and conversations
                with message histories.
              </li>
              <li>
                <strong>Strictly Excluded:</strong> API keys, encrypted credential files, credential
                references, SQLite database files, and search chunk indexes (rebuilt on import).
              </li>
            </ul>
            <div
              style={{
                padding: '10px 14px',
                backgroundColor: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 'var(--radius-sm, 6px)',
                color: '#92400e',
                fontSize: '13px',
                lineHeight: 1.5
              }}
            >
              <strong>Archive Privacy Advisory:</strong> Exported ZIP files contain your actual
              document files and conversation histories in unencrypted format. Store backups in a
              secure, trusted location. Deleting a Knowledge Base within the app does not
              automatically delete previously exported ZIP files.
            </div>
          </div>
        )}
      </div>

      {/* 7. Diagnostics Export */}
      <div className="workspace-settings-card" data-testid="diagnostics-privacy-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <FileText size={18} className="text-secondary" aria-hidden="true" />
          <strong style={{ fontSize: '15px' }}>Diagnostics Export Privacy</strong>
        </div>
        <p style={{ margin: '0 0 10px 0', fontSize: '13px', lineHeight: 1.6 }}>
          When exporting technical diagnostics (diagnostics.json) for troubleshooting:
        </p>
        <ul style={{ margin: '0 0 10px 20px', fontSize: '13px', lineHeight: 1.6 }}>
          <li>
            <strong>Included:</strong> Application version, OS architecture, database integrity
            status, table counts, storage sizes, and sanitized technical error codes.
          </li>
          <li>
            <strong>Strictly Excluded:</strong> Prompts, messages, assistant answers, document
            contents, document filenames ([REDACTED_FILE]), filesystem paths ([REDACTED_PATH]), API
            keys ([REDACTED_API_KEY]), and credential references.
          </li>
        </ul>
      </div>

      {/* 8. Data Deletion and Limitations */}
      <div className="workspace-settings-card" data-testid="deletion-retention-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('deletion')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('deletion')}
          aria-expanded={expandedSections.deletion}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Trash2 size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>Data Deletion & Retention Boundaries</strong>
          </div>
          {expandedSections.deletion ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.deletion && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ margin: '0 0 10px 0', fontSize: '13px', lineHeight: 1.6 }}>
              The application provides hardened deletion controls with safety confirmations:
            </p>
            <ul style={{ margin: '0 0 12px 20px', fontSize: '13px', lineHeight: 1.6 }}>
              <li>
                <strong>Delete Conversation:</strong> Removes messages and task runs; preserves Bot
                settings and documents.
              </li>
              <li>
                <strong>Delete Bot:</strong> Removes Bot profile, memories, and threads; preserves
                parent Knowledge Base and documents.
              </li>
              <li>
                <strong>Delete Knowledge Source:</strong> Permanently removes original document
                files and FTS5 search entries.
              </li>
              <li>
                <strong>Delete Knowledge Base:</strong> Removes all child Bots, documents, and
                conversations; quarantines and deletes physical files.
              </li>
              <li>
                <strong>Delete Provider Connection:</strong> Removes local encrypted credential
                files. Note: Deleting a saved connection does <em>not</em> revoke the API key at the
                provider (revoke keys via your provider dashboard).
              </li>
            </ul>

            <div
              style={{
                padding: '10px 14px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 'var(--radius-sm, 6px)',
                color: '#991b1b',
                fontSize: '13px',
                lineHeight: 1.5
              }}
            >
              <strong>Deletion Limitations:</strong> Deleting data locally removes it permanently
              from your device, but <em>cannot</em> delete previously exported ZIP backups or recall
              prompts previously received and processed by external AI providers.
            </div>
          </div>
        )}
      </div>

      {/* 9. Network Activity & External Services */}
      <div className="workspace-settings-card" data-testid="network-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => toggleSection('network')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection('network')}
          aria-expanded={expandedSections.network}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe size={18} className="text-secondary" aria-hidden="true" />
            <strong style={{ fontSize: '15px' }}>External Network Activity</strong>
          </div>
          {expandedSections.network ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>

        {expandedSections.network && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ margin: '0 0 10px 0', fontSize: '13px', lineHeight: 1.6 }}>
              Code-audited external network endpoints used by this application:
            </p>
            <ul style={{ margin: '0 0 12px 20px', fontSize: '13px', lineHeight: 1.6 }}>
              <li>
                <strong>OpenAI:</strong> <code>https://api.openai.com/v1</code> (via official SDK
                adapter)
              </li>
              <li>
                <strong>Anthropic:</strong> <code>https://api.anthropic.com/v1</code> (via official
                SDK adapter)
              </li>
              <li>
                <strong>Google Gemini:</strong>{' '}
                <code>https://generativelanguage.googleapis.com/v1beta</code> (via official SDK
                adapter)
              </li>
            </ul>
            <p
              style={{
                margin: '0',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
                lineHeight: 1.5
              }}
            >
              The application contains zero telemetry endpoints, zero third-party analytics
              trackers, zero crash reporting servers, and zero cloud user authentication services.
              Outbound traffic is restricted strictly to the AI provider APIs configured in your
              settings.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
