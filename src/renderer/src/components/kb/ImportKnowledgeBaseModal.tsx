import { ReactElement, useState, KeyboardEvent, useMemo } from 'react'
import {
  X,
  Loader2,
  Upload,
  ShieldCheck,
  AlertCircle,
  FolderArchive,
  CheckCircle2,
  Layers,
  ChevronDown,
  ChevronUp,
  FileText,
  AlertTriangle
} from 'lucide-react'
import { useKnowledgeBases } from '../../contexts/KnowledgeBaseContext'
import type {
  ImportPreviewDto,
  ExecuteImportResultDto,
  ImportStrategy
} from '../../../../shared/export-archive'

export interface ImportKnowledgeBaseModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onImportSuccess?: (result: ExecuteImportResultDto) => void
  readonly defaultTargetKnowledgeBaseId?: string
}

type ImportModalStep = 'select' | 'preview' | 'importing' | 'success'

export function ImportKnowledgeBaseModal({
  isOpen,
  onClose,
  onImportSuccess,
  defaultTargetKnowledgeBaseId
}: ImportKnowledgeBaseModalProps): ReactElement | null {
  const { knowledgeBases, refresh: refreshKBs } = useKnowledgeBases()

  const [step, setStep] = useState<ImportModalStep>('select')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null)
  const [strategy, setStrategy] = useState<ImportStrategy>('new')
  const [targetKbId, setTargetKbId] = useState<string>(defaultTargetKnowledgeBaseId || '')
  const [confirmationName, setConfirmationName] = useState<string>('')
  const [showFileList, setShowFileList] = useState<boolean>(false)
  const [importResult, setImportResult] = useState<ExecuteImportResultDto | null>(null)

  const activeKnowledgeBases = useMemo(
    () => knowledgeBases.filter((kb) => kb.archivedAt === null),
    [knowledgeBases]
  )

  const effectiveTargetKbId =
    targetKbId ||
    defaultTargetKnowledgeBaseId ||
    (activeKnowledgeBases.length > 0 ? activeKnowledgeBases[0].id : '')

  const selectedTargetKb =
    activeKnowledgeBases.find((kb) => kb.id === effectiveTargetKbId) ||
    (activeKnowledgeBases.length > 0 ? activeKnowledgeBases[0] : null)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && step !== 'importing') {
      void handleClose()
    }
  }

  const handleClose = async (): Promise<void> => {
    if (step === 'importing') return

    // If closing while previewing, cancel session to clean up staging directory
    if (preview && step === 'preview') {
      try {
        if (window.api?.knowledgeBases?.importCancel) {
          await window.api.knowledgeBases.importCancel({ sessionId: preview.sessionId })
        }
      } catch {
        // Non-critical session cleanup error
      }
    }

    setStep('select')
    setIsLoading(false)
    setPreview(null)
    setErrorMessage(null)
    setImportResult(null)
    setStrategy('new')
    setTargetKbId('')
    setConfirmationName('')
    setShowFileList(false)
    onClose()
  }

  const handleSelectArchive = async (): Promise<void> => {
    setIsLoading(true)
    setErrorMessage(null)

    try {
      if (!window.api?.knowledgeBases?.importSelectAndPreview) {
        throw new Error('Knowledge Base import capability is not available in this environment.')
      }

      const result = await window.api.knowledgeBases.importSelectAndPreview()

      if (result.cancelled) {
        // Native file picker cancelled, remain in select step
        setIsLoading(false)
        return
      }

      if (result.success && result.preview) {
        setPreview(result.preview)
        setStep('preview')
        setStrategy('new')
        if (activeKnowledgeBases.length > 0 && !targetKbId) {
          setTargetKbId(activeKnowledgeBases[0].id)
        }
      } else {
        setErrorMessage(result.error || 'Failed to inspect Knowledge Base archive.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred during archive selection.'
      setErrorMessage(msg)
    } finally {
      setIsLoading(false)
    }
  }

  const handleExecuteImport = async (): Promise<void> => {
    if (!preview || step === 'importing') return

    if ((strategy === 'merge' || strategy === 'replace') && !effectiveTargetKbId) {
      setErrorMessage('Please select a target Knowledge Base.')
      return
    }

    if (strategy === 'replace') {
      if (!selectedTargetKb) {
        setErrorMessage('Selected target Knowledge Base could not be found.')
        return
      }
      if (confirmationName.trim() !== selectedTargetKb.name.trim()) {
        setErrorMessage(`Please type '${selectedTargetKb.name}' exactly to confirm replacement.`)
        return
      }
    }

    setIsLoading(true)
    setErrorMessage(null)
    setStep('importing')

    try {
      if (!window.api?.knowledgeBases?.importExecute) {
        throw new Error('Knowledge Base import capability is not available in this environment.')
      }

      const result = await window.api.knowledgeBases.importExecute({
        sessionId: preview.sessionId,
        strategy,
        targetKnowledgeBaseId: strategy !== 'new' ? effectiveTargetKbId : undefined,
        confirmationName: strategy === 'replace' ? confirmationName.trim() : undefined
      })

      if (result.success) {
        setImportResult(result)
        setStep('success')
        await refreshKBs()
        if (onImportSuccess) {
          onImportSuccess(result)
        }
      } else {
        setErrorMessage(result.error || 'Failed to complete Knowledge Base import.')
        setStep('preview')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred while executing import.'
      setErrorMessage(msg)
      setStep('preview')
    } finally {
      setIsLoading(false)
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  const isReplaceConfirmed =
    strategy !== 'replace' ||
    (selectedTargetKb && confirmationName.trim() === selectedTargetKb.name.trim())

  if (!isOpen) return null

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="import-kb-modal-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-medium"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-kb-title"
        data-testid="import-kb-modal"
        style={{ maxWidth: '640px', width: '92%' }}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <FolderArchive size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="import-kb-title" className="modal-title">
              {step === 'select' && 'Import Knowledge Base'}
              {step === 'preview' && 'Review Knowledge Base Backup'}
              {step === 'importing' && 'Restoring Knowledge Base...'}
              {step === 'success' && 'Import Complete'}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={handleClose}
            disabled={step === 'importing'}
            aria-label="Close dialog"
            data-testid="btn-close-import-kb"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            maxHeight: '72vh',
            overflowY: 'auto'
          }}
        >
          {errorMessage && (
            <div
              className="form-alert form-alert-error"
              role="alert"
              data-testid="import-kb-error"
              style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}
            >
              <AlertCircle
                size={18}
                className="text-danger flex-shrink-0"
                style={{ marginTop: '2px' }}
                aria-hidden="true"
              />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* STEP 1: SELECT ARCHIVE */}
          {step === 'select' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                padding: '32px 16px',
                border: '2px dashed #cbd5e1',
                borderRadius: '8px',
                gap: '12px'
              }}
              data-testid="import-kb-select-step"
            >
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Upload size={24} className="text-accent" aria-hidden="true" />
              </div>
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600 }}>
                  Select Backup Archive
                </h3>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b', maxWidth: '420px' }}>
                  Choose a versioned <code className="font-mono text-xs">.voyaro-kb.zip</code>{' '}
                  export archive to inspect and restore into your workspace.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSelectArchive}
                disabled={isLoading}
                data-testid="btn-select-archive-file"
                style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    <span>Inspecting Archive...</span>
                  </>
                ) : (
                  <>
                    <Upload size={16} aria-hidden="true" />
                    <span>Select Archive File...</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* STEP 2: PREVIEW & STRATEGY SELECTION */}
          {step === 'preview' && preview && (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
              data-testid="import-kb-preview-step"
            >
              {/* Archive Summary Card */}
              <div
                style={{
                  padding: '14px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start'
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#1e293b' }}>
                      {preview.knowledgeBase.name}
                    </h3>
                    {preview.knowledgeBase.description && (
                      <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#64748b' }}>
                        {preview.knowledgeBase.description}
                      </p>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: '11px',
                      color: '#64748b',
                      backgroundColor: '#e2e8f0',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontWeight: 500
                    }}
                  >
                    {formatBytes(preview.archiveSizeBytes)}
                  </span>
                </div>

                {/* Counts Grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: '8px',
                    marginTop: '12px',
                    padding: '10px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    textAlign: 'center',
                    fontSize: '12px'
                  }}
                  data-testid="import-kb-preview-counts"
                >
                  <div>
                    <div style={{ color: '#64748b', fontSize: '11px' }}>Bots</div>
                    <strong style={{ fontSize: '14px' }}>{preview.counts.bots}</strong>
                  </div>
                  <div>
                    <div style={{ color: '#64748b', fontSize: '11px' }}>Memories</div>
                    <strong style={{ fontSize: '14px' }}>{preview.counts.memories}</strong>
                  </div>
                  <div>
                    <div style={{ color: '#64748b', fontSize: '11px' }}>Documents</div>
                    <strong style={{ fontSize: '14px' }}>{preview.counts.sources}</strong>
                  </div>
                  <div>
                    <div style={{ color: '#64748b', fontSize: '11px' }}>Convs</div>
                    <strong style={{ fontSize: '14px' }}>{preview.counts.conversations}</strong>
                  </div>
                  <div>
                    <div style={{ color: '#64748b', fontSize: '11px' }}>Messages</div>
                    <strong style={{ fontSize: '14px' }}>{preview.counts.messages}</strong>
                  </div>
                </div>

                {/* Document Files Toggle */}
                {preview.documentFiles.length > 0 && (
                  <div style={{ marginTop: '10px' }}>
                    <button
                      type="button"
                      onClick={() => setShowFileList(!showFileList)}
                      className="btn btn-secondary btn-sm"
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12px',
                        padding: '6px 10px'
                      }}
                      data-testid="btn-toggle-file-list"
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FileText size={14} aria-hidden="true" />
                        <span>Included Documents ({preview.documentFiles.length})</span>
                      </span>
                      {showFileList ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>

                    {showFileList && (
                      <div
                        style={{
                          marginTop: '6px',
                          maxHeight: '120px',
                          overflowY: 'auto',
                          border: '1px solid #e2e8f0',
                          borderRadius: '6px',
                          backgroundColor: '#ffffff'
                        }}
                        data-testid="import-kb-file-list"
                      >
                        {preview.documentFiles.map((f) => (
                          <div
                            key={f.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              padding: '5px 10px',
                              fontSize: '12px',
                              borderBottom: '1px solid #f1f5f9'
                            }}
                          >
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {f.originalFileName}
                            </span>
                            <span
                              style={{
                                color: '#94a3b8',
                                fontSize: '11px',
                                flexShrink: 0,
                                marginLeft: '8px'
                              }}
                            >
                              {formatBytes(f.sizeBytes)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Security Safeguard Banner */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '10px 12px',
                  backgroundColor: 'rgba(59, 130, 246, 0.06)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: '#1e3a8a'
                }}
              >
                <ShieldCheck
                  size={18}
                  className="text-accent flex-shrink-0"
                  style={{ marginTop: '1px' }}
                  aria-hidden="true"
                />
                <span>{preview.securityNotice}</span>
              </div>

              {/* Import Strategy Selection */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}>
                  Import Strategy
                </label>

                {/* Option 1: New KB (Default) */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '10px',
                    borderRadius: '6px',
                    border:
                      strategy === 'new' ? '2px solid var(--color-accent)' : '1px solid #e2e8f0',
                    backgroundColor: strategy === 'new' ? 'rgba(59, 130, 246, 0.04)' : '#ffffff',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="radio"
                    name="importStrategy"
                    value="new"
                    checked={strategy === 'new'}
                    onChange={() => setStrategy('new')}
                    style={{ marginTop: '3px' }}
                    data-testid="radio-strategy-new"
                  />
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>
                      Create New Knowledge Base (Recommended)
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>
                      Restores into a new, standalone Knowledge Base named &ldquo;
                      {preview.knowledgeBase.name}&rdquo;. Generates fresh UUIDs for all entities.
                    </div>
                  </div>
                </label>

                {/* Option 2: Merge into existing */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '10px',
                    borderRadius: '6px',
                    border:
                      strategy === 'merge' ? '2px solid var(--color-accent)' : '1px solid #e2e8f0',
                    backgroundColor: strategy === 'merge' ? 'rgba(59, 130, 246, 0.04)' : '#ffffff',
                    cursor: activeKnowledgeBases.length > 0 ? 'pointer' : 'not-allowed',
                    opacity: activeKnowledgeBases.length > 0 ? 1 : 0.6
                  }}
                >
                  <input
                    type="radio"
                    name="importStrategy"
                    value="merge"
                    checked={strategy === 'merge'}
                    onChange={() => setStrategy('merge')}
                    disabled={activeKnowledgeBases.length === 0}
                    style={{ marginTop: '3px' }}
                    data-testid="radio-strategy-merge"
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>
                      Merge into Existing Knowledge Base
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>
                      Adds the imported bots, memories, and documents into an existing Knowledge
                      Base without overwriting existing data.
                    </div>
                    {strategy === 'merge' && (
                      <div style={{ marginTop: '8px' }}>
                        <select
                          className="form-control"
                          value={targetKbId}
                          onChange={(e) => setTargetKbId(e.target.value)}
                          data-testid="select-target-kb-merge"
                          style={{ fontSize: '13px', padding: '6px 8px' }}
                        >
                          {activeKnowledgeBases.map((kb) => (
                            <option key={kb.id} value={kb.id}>
                              {kb.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </label>

                {/* Option 3: Replace existing */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '10px',
                    borderRadius: '6px',
                    border: strategy === 'replace' ? '2px solid #ef4444' : '1px solid #e2e8f0',
                    backgroundColor: strategy === 'replace' ? 'rgba(239, 68, 68, 0.04)' : '#ffffff',
                    cursor: activeKnowledgeBases.length > 0 ? 'pointer' : 'not-allowed',
                    opacity: activeKnowledgeBases.length > 0 ? 1 : 0.6
                  }}
                >
                  <input
                    type="radio"
                    name="importStrategy"
                    value="replace"
                    checked={strategy === 'replace'}
                    onChange={() => setStrategy('replace')}
                    disabled={activeKnowledgeBases.length === 0}
                    style={{ marginTop: '3px' }}
                    data-testid="radio-strategy-replace"
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: strategy === 'replace' ? '#b91c1c' : 'inherit'
                      }}
                    >
                      Replace Existing Knowledge Base (Destructive)
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>
                      Permanently wipes all existing bots, documents, and conversations in the
                      target Knowledge Base and replaces them with this backup.
                    </div>

                    {strategy === 'replace' && selectedTargetKb && (
                      <div
                        style={{
                          marginTop: '10px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px'
                        }}
                      >
                        <select
                          className="form-control"
                          value={targetKbId}
                          onChange={(e) => {
                            setTargetKbId(e.target.value)
                            setConfirmationName('')
                          }}
                          data-testid="select-target-kb-replace"
                          style={{ fontSize: '13px', padding: '6px 8px' }}
                        >
                          {activeKnowledgeBases.map((kb) => (
                            <option key={kb.id} value={kb.id}>
                              {kb.name}
                            </option>
                          ))}
                        </select>

                        <div
                          style={{
                            padding: '10px',
                            backgroundColor: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            borderRadius: '6px',
                            fontSize: '12px',
                            color: '#991b1b'
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontWeight: 600
                            }}
                          >
                            <AlertTriangle size={15} aria-hidden="true" />
                            <span>Warning: This action cannot be undone</span>
                          </div>
                          <p style={{ margin: '4px 0 8px 0' }}>
                            To confirm replacing <strong>{selectedTargetKb.name}</strong>, type its
                            exact name below:
                          </p>
                          <input
                            type="text"
                            className="form-control"
                            placeholder={selectedTargetKb.name}
                            value={confirmationName}
                            onChange={(e) => setConfirmationName(e.target.value)}
                            data-testid="input-replace-confirmation-name"
                            style={{
                              fontSize: '13px',
                              borderColor:
                                confirmationName.trim() === selectedTargetKb.name.trim()
                                  ? '#10b981'
                                  : undefined
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* STEP 3: IMPORTING PROGRESS */}
          {step === 'importing' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                padding: '40px 16px',
                gap: '16px'
              }}
              data-testid="import-kb-importing-step"
            >
              <Loader2 size={36} className="animate-spin text-accent" aria-hidden="true" />
              <div>
                <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 600 }}>
                  Restoring Knowledge Base...
                </h3>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
                  Unpacking archive, reconstructing entities, and re-indexing original documents
                  into full-text search.
                </p>
              </div>
            </div>
          )}

          {/* STEP 4: SUCCESS SUMMARY */}
          {step === 'success' && importResult && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                padding: '16px',
                backgroundColor: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px'
              }}
              data-testid="import-kb-success-step"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <CheckCircle2 size={24} className="text-success flex-shrink-0" aria-hidden="true" />
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#065f46' }}>
                    Knowledge Base Restored Successfully
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: '#047857' }}>
                    Restored into: <strong>{importResult.knowledgeBaseName}</strong> (
                    {importResult.strategy} strategy)
                  </p>
                </div>
              </div>

              {importResult.counts && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: '8px',
                    padding: '12px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    textAlign: 'center',
                    fontSize: '12px'
                  }}
                  data-testid="import-kb-success-counts"
                >
                  <div>
                    <span style={{ color: '#64748b' }}>Bots:</span>{' '}
                    <strong>{importResult.counts.bots}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Memories:</span>{' '}
                    <strong>{importResult.counts.memories}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Sources:</span>{' '}
                    <strong>{importResult.counts.sources}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Convs:</span>{' '}
                    <strong>{importResult.counts.conversations}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Messages:</span>{' '}
                    <strong>{importResult.counts.messages}</strong>
                  </div>
                </div>
              )}

              {importResult.counts && (
                <div
                  style={{
                    fontSize: '12px',
                    color: '#065f46',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Layers size={14} aria-hidden="true" />
                  <span>
                    FTS5 Re-indexing: <strong>{importResult.counts.indexedSources}</strong> of{' '}
                    <strong>{importResult.counts.sources}</strong> documents re-indexed
                    successfully.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* MODAL FOOTER */}
        <div
          className="modal-footer"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}
        >
          {step === 'select' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              data-testid="btn-cancel-select"
            >
              Cancel
            </button>
          )}

          {step === 'preview' && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleClose}
                disabled={isLoading}
                data-testid="btn-cancel-preview"
              >
                Cancel
              </button>
              <button
                type="button"
                className={strategy === 'replace' ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={handleExecuteImport}
                disabled={isLoading || !isReplaceConfirmed}
                data-testid="btn-execute-import"
              >
                {strategy === 'replace' ? 'Confirm & Replace' : 'Import Knowledge Base'}
              </button>
            </>
          )}

          {step === 'success' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleClose}
              data-testid="btn-done-import"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
