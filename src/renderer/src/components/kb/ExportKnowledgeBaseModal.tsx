import { ReactElement, useState, KeyboardEvent } from 'react'
import {
  X,
  Loader2,
  Download,
  ShieldCheck,
  FileCheck,
  AlertCircle,
  FolderArchive,
  CheckCircle2
} from 'lucide-react'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'
import type { ExportKnowledgeBaseResultDto } from '../../../../shared/export-archive'

export interface ExportKnowledgeBaseModalProps {
  readonly isOpen: boolean
  readonly knowledgeBase: KnowledgeBaseDto | null
  readonly onClose: () => void
  readonly onExportComplete?: (result: ExportKnowledgeBaseResultDto) => void
}

export function ExportKnowledgeBaseModal({
  isOpen,
  knowledgeBase,
  onClose,
  onExportComplete
}: ExportKnowledgeBaseModalProps): ReactElement | null {
  const [isExporting, setIsExporting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<ExportKnowledgeBaseResultDto | null>(null)

  if (!isOpen || !knowledgeBase) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isExporting) {
      handleClose()
    }
  }

  const handleClose = (): void => {
    if (isExporting) return
    setErrorMessage(null)
    setExportResult(null)
    onClose()
  }

  const handleStartExport = async (): Promise<void> => {
    if (isExporting || !knowledgeBase) return

    setIsExporting(true)
    setErrorMessage(null)
    setExportResult(null)

    try {
      if (!window.api?.knowledgeBases?.export) {
        throw new Error('Knowledge Base export capability is not available in this environment.')
      }

      const result = await window.api.knowledgeBases.export(knowledgeBase.id)

      if (result.cancelled) {
        // User cancelled native Save As dialog, reset state gracefully
        setIsExporting(false)
        return
      }

      if (result.success) {
        setExportResult(result)
        if (onExportComplete) {
          onExportComplete(result)
        }
      } else {
        setErrorMessage(result.error || 'Failed to export Knowledge Base.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred during export.'
      setErrorMessage(msg)
    } finally {
      setIsExporting(false)
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="export-kb-modal-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-medium"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-kb-title"
        data-testid="export-kb-modal"
        style={{ maxWidth: '600px' }}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <FolderArchive size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="export-kb-title" className="modal-title">
              Export Knowledge Base
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={handleClose}
            disabled={isExporting}
            aria-label="Close dialog"
            data-testid="btn-close-export-kb"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
        >
          {errorMessage && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              data-testid="export-kb-error"
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <AlertCircle size={18} className="text-danger flex-shrink-0" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          {exportResult && exportResult.success ? (
            <div
              className="export-success-container"
              data-testid="export-kb-success"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                padding: '16px',
                backgroundColor: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <CheckCircle2 size={22} className="text-success" aria-hidden="true" />
                <div>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                    Export Completed Successfully
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: '#64748b' }}>
                    Archive saved to:{' '}
                    <strong className="font-mono text-xs">{exportResult.archivePath}</strong>
                  </p>
                </div>
              </div>

              {exportResult.counts && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '8px',
                    marginTop: '8px',
                    padding: '12px',
                    backgroundColor: 'rgba(255, 255, 255, 0.6)',
                    borderRadius: '6px',
                    fontSize: '12px'
                  }}
                  data-testid="export-kb-counts"
                >
                  <div>
                    <span style={{ color: '#64748b' }}>Bots:</span>{' '}
                    <strong>{exportResult.counts.bots}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Memories:</span>{' '}
                    <strong>{exportResult.counts.memories}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Sources:</span>{' '}
                    <strong>{exportResult.counts.sources}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Conversations:</span>{' '}
                    <strong>{exportResult.counts.conversations}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Messages:</span>{' '}
                    <strong>{exportResult.counts.messages}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Archive Size:</span>{' '}
                    <strong>{formatBytes(exportResult.archiveSizeBytes ?? 0)}</strong>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: '13.5px', lineHeight: 1.5, color: '#334155' }}>
                Export <strong>{knowledgeBase.name}</strong> into a portable, versioned archive{' '}
                <span
                  className="font-mono text-xs"
                  style={{ backgroundColor: '#f1f5f9', padding: '2px 4px', borderRadius: '4px' }}
                >
                  .voyaro-kb.zip
                </span>{' '}
                that can be backed up or imported into another workspace profile.
              </p>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  padding: '14px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  fontSize: '12.5px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                  <FileCheck
                    size={18}
                    className="text-accent flex-shrink-0"
                    style={{ marginTop: '2px' }}
                    aria-hidden="true"
                  />
                  <div>
                    <strong style={{ color: '#0f172a' }}>Included in archive:</strong>
                    <ul
                      style={{
                        margin: '4px 0 0 16px',
                        padding: 0,
                        color: '#475569',
                        listStyleType: 'disc'
                      }}
                    >
                      <li>Knowledge Base metadata & configurations</li>
                      <li>Assigned Bots, tool definitions & system prompts</li>
                      <li>Saved Bot memories (notes and instructions)</li>
                      <li>Original source documents & verified checksums</li>
                      <li>Conversation threads and messages</li>
                    </ul>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    marginTop: '6px'
                  }}
                >
                  <ShieldCheck
                    size={18}
                    className="text-success flex-shrink-0"
                    style={{ marginTop: '2px' }}
                    aria-hidden="true"
                  />
                  <div>
                    <strong style={{ color: '#0f172a' }}>Privacy & Security Guarantees:</strong>
                    <ul
                      style={{
                        margin: '4px 0 0 16px',
                        padding: 0,
                        color: '#475569',
                        listStyleType: 'disc'
                      }}
                    >
                      <li>
                        <strong>Zero credentials:</strong> API keys, tokens, and provider secrets
                        are never exported
                      </li>
                      <li>
                        <strong>No machine paths:</strong> Absolute local filesystem paths are
                        omitted
                      </li>
                      <li>
                        <strong>No live database locks:</strong> SQLite files and WAL journals are
                        excluded
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div
          className="modal-footer"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClose}
            disabled={isExporting}
            data-testid="btn-cancel-export-kb"
          >
            {exportResult?.success ? 'Close' : 'Cancel'}
          </button>

          {!exportResult?.success && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStartExport}
              disabled={isExporting}
              data-testid="btn-confirm-export-kb"
            >
              {isExporting ? (
                <>
                  <Loader2 size={16} className="spinner inline-icon" aria-hidden="true" />
                  <span>Exporting...</span>
                </>
              ) : (
                <>
                  <Download size={16} className="inline-icon" aria-hidden="true" />
                  <span>Choose Location & Export</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
