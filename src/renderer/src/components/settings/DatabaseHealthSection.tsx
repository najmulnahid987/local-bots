import { ReactElement, useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  AlertCircle,
  RefreshCw,
  Download,
  Database,
  ShieldCheck,
  Info
} from 'lucide-react'
import type { DatabaseHealthDto, DiagnosticsExportResultDto } from '../../../../shared/diagnostics'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`
}

export function DatabaseHealthSection(): ReactElement {
  const [health, setHealth] = useState<DatabaseHealthDto | null>(null)
  const [isLoadingHealth, setIsLoadingHealth] = useState<boolean>(true)
  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [exportNotification, setExportNotification] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const handleRunIntegrityCheck = useCallback(async (): Promise<void> => {
    setIsLoadingHealth(true)
    setHealthError(null)
    try {
      if (!window.api?.diagnostics?.runIntegrityCheck) {
        throw new Error('Diagnostics service bridge is not available in this window.')
      }
      const freshHealth = await window.api.diagnostics.runIntegrityCheck()
      setHealth(freshHealth)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Database integrity check execution failed.'
      setHealthError(msg)
    } finally {
      setIsLoadingHealth(false)
    }
  }, [])

  const handleExportDiagnostics = useCallback(async (): Promise<void> => {
    setIsExporting(true)
    setExportError(null)
    setExportNotification(null)
    try {
      if (!window.api?.diagnostics?.exportDiagnostics) {
        throw new Error('Diagnostics service bridge is not available in this window.')
      }
      const result: DiagnosticsExportResultDto = await window.api.diagnostics.exportDiagnostics()

      if (result.success && !result.cancelled) {
        const sizeStr = result.sizeBytes ? ` (${formatBytes(result.sizeBytes)})` : ''
        setExportNotification(
          `Diagnostics successfully exported as ${result.filename ?? 'file'}${sizeStr}. All sensitive data was safely excluded.`
        )
      } else if (!result.success && !result.cancelled) {
        setExportError(result.error ?? 'Failed to export diagnostics.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Diagnostics export failed.'
      setExportError(msg)
    } finally {
      setIsExporting(false)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const initializeData = async (): Promise<void> => {
      try {
        if (!window.api?.diagnostics?.getDatabaseHealth) {
          throw new Error('Diagnostics service bridge is not available in this window.')
        }
        const data = await window.api.diagnostics.getDatabaseHealth()
        if (isMounted) {
          setHealth(data)
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : 'Failed to retrieve database health.'
          setHealthError(msg)
        }
      } finally {
        if (isMounted) {
          setIsLoadingHealth(false)
        }
      }
    }

    void initializeData()

    return () => {
      isMounted = false
    }
  }, [])

  const renderStatusBadge = (status: DatabaseHealthDto['status']): ReactElement => {
    switch (status) {
      case 'healthy':
        return (
          <span
            className="badge badge-success"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#f0fdf4',
              color: '#166534',
              border: '1px solid #bbf7d0',
              padding: '4px 10px',
              borderRadius: '9999px',
              fontWeight: 600,
              fontSize: '12px'
            }}
            data-testid="database-health-status-badge"
          >
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>Healthy</span>
          </span>
        )
      case 'warning':
        return (
          <span
            className="badge badge-warning"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#fffbeb',
              color: '#92400e',
              border: '1px solid #fde68a',
              padding: '4px 10px',
              borderRadius: '9999px',
              fontWeight: 600,
              fontSize: '12px'
            }}
            data-testid="database-health-status-badge"
          >
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Warning</span>
          </span>
        )
      case 'critical':
      default:
        return (
          <span
            className="badge badge-danger"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#fef2f2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              padding: '4px 10px',
              borderRadius: '9999px',
              fontWeight: 600,
              fontSize: '12px'
            }}
            data-testid="database-health-status-badge"
          >
            <AlertOctagon size={14} aria-hidden="true" />
            <span>Critical</span>
          </span>
        )
    }
  }

  return (
    <section
      className="settings-section"
      aria-labelledby="database-health-heading"
      data-testid="database-health-section"
      style={{ marginTop: '32px' }}
    >
      <div className="settings-section-header">
        <div className="section-title-group">
          <h2 id="database-health-heading" className="section-title">
            Database Health & Diagnostics
          </h2>
          <p className="section-description">
            Inspect local SQLite database integrity, WAL consistency, and export sanitized technical
            diagnostics for troubleshooting.
          </p>
        </div>

        <div className="section-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleRunIntegrityCheck}
            disabled={isLoadingHealth || isExporting}
            data-testid="run-integrity-check-button"
            title="Execute SQLite integrity and foreign key checks"
          >
            <RefreshCw
              size={14}
              className={`inline-icon ${isLoadingHealth ? 'spinner' : ''}`}
              aria-hidden="true"
            />
            <span>{isLoadingHealth ? 'Checking...' : 'Run Integrity Check'}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleExportDiagnostics}
            disabled={isLoadingHealth || isExporting}
            data-testid="export-diagnostics-button"
            title="Export sanitized technical diagnostics JSON"
          >
            <Download
              size={14}
              className={`inline-icon ${isExporting ? 'spinner' : ''}`}
              aria-hidden="true"
            />
            <span>{isExporting ? 'Exporting...' : 'Export Diagnostics'}</span>
          </button>
        </div>
      </div>

      {exportNotification && (
        <div
          className="section-notification section-notification-success"
          role="status"
          data-testid="diagnostics-export-success"
        >
          <CheckCircle2 size={16} className="inline-icon" aria-hidden="true" />
          <span>{exportNotification}</span>
        </div>
      )}

      {(healthError || exportError) && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="diagnostics-error"
        >
          <AlertCircle size={18} className="alert-icon" aria-hidden="true" />
          <div className="alert-body">
            <strong>Database Diagnostics Notice</strong>
            <p>{healthError || exportError}</p>
          </div>
        </div>
      )}

      {health && (
        <div className="workspace-settings-card" data-testid="database-health-card">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingBottom: '12px',
              borderBottom: '1px solid var(--color-border)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Database size={18} className="text-secondary" aria-hidden="true" />
              <strong style={{ fontSize: '15px' }}>Database Status</strong>
            </div>
            {renderStatusBadge(health.status)}
          </div>

          <p style={{ margin: '4px 0 12px 0', fontSize: '13px', lineHeight: 1.5 }}>
            {health.summary}
          </p>

          <dl className="settings-metadata-list">
            <div className="settings-metadata-row">
              <dt className="settings-metadata-key">Integrity Check</dt>
              <dd className="settings-metadata-val" data-testid="integrity-status-val">
                {health.integrityStatus === 'ok'
                  ? 'Passed (OK)'
                  : health.integrityStatus === 'failed'
                    ? 'Failed'
                    : 'Execution Error'}
              </dd>
            </div>

            <div className="settings-metadata-row">
              <dt className="settings-metadata-key">Foreign Keys</dt>
              <dd className="settings-metadata-val" data-testid="foreign-key-status-val">
                {health.foreignKeyStatus === 'ok'
                  ? 'Consistent (No violations)'
                  : `${health.violationsCount} constraint violation(s) detected`}
              </dd>
            </div>

            <div className="settings-metadata-row">
              <dt className="settings-metadata-key">Database File Size</dt>
              <dd className="settings-metadata-val" data-testid="database-size-val">
                {formatBytes(health.databaseSizeBytes)}
              </dd>
            </div>

            <div className="settings-metadata-row">
              <dt className="settings-metadata-key">WAL Log Size</dt>
              <dd className="settings-metadata-val" data-testid="wal-size-val">
                {formatBytes(health.walSizeBytes)}
              </dd>
            </div>

            <div className="settings-metadata-row">
              <dt className="settings-metadata-key">Last Verified</dt>
              <dd className="settings-metadata-val" data-testid="last-verified-val">
                {health.lastVerifiedAt > 0
                  ? new Date(health.lastVerifiedAt).toLocaleString()
                  : 'Pending'}
              </dd>
            </div>
          </dl>

          {health.recoveryGuidance.length > 0 && (
            <div
              className="recovery-guidance-container"
              style={{
                marginTop: '16px',
                padding: '14px 16px',
                backgroundColor: health.status === 'healthy' ? '#f8fafc' : '#fffbeb',
                border: `1px solid ${health.status === 'healthy' ? '#e2e8f0' : '#fde68a'}`,
                borderRadius: 'var(--radius-md)'
              }}
              data-testid="recovery-guidance-box"
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontWeight: 600,
                  fontSize: '13px',
                  color: health.status === 'healthy' ? '#334155' : '#92400e',
                  marginBottom: '8px'
                }}
              >
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Recommended Actions & Recovery Guidance</span>
              </div>
              <ul
                style={{
                  margin: '0',
                  paddingLeft: '20px',
                  fontSize: '13px',
                  lineHeight: 1.6,
                  color: health.status === 'healthy' ? '#475569' : '#78350f'
                }}
              >
                {health.recoveryGuidance.map((guidance, idx) => (
                  <li key={idx}>{guidance}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div
        className="privacy-callout-card"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          padding: '12px 16px',
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 'var(--radius-md)',
          fontSize: '12px',
          color: '#64748b',
          lineHeight: 1.5
        }}
      >
        <Info
          size={16}
          style={{ flexShrink: 0, marginTop: '2px', color: '#3b82f6' }}
          aria-hidden="true"
        />
        <div>
          <strong style={{ color: '#334155' }}>Diagnostic Privacy & Non-Destructive Design:</strong>{' '}
          Diagnostics export packages contain only numeric counts, schema versions, hardware
          descriptors, and sanitized error summaries. User conversations, documents, memories, and
          API keys are strictly excluded. The application will never attempt destructive automatic
          repairs on active database files.
        </div>
      </div>
    </section>
  )
}
