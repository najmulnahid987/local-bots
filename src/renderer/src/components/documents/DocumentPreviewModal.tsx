import { ReactElement, useEffect, useState, useRef } from 'react'
import {
  X,
  FileText,
  Loader2,
  AlertCircle,
  BookOpen,
  Target,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  FileSpreadsheet,
  Presentation,
  Layers,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Info
} from 'lucide-react'
import type {
  DocumentPreviewDto,
  PreviewBlockDto,
  PreviewPreservationSummaryDto
} from '../../../../shared/knowledge-documents'
import { formatBytes, formatCount } from '../../utils/formatters'

export interface DocumentPreviewModalProps {
  readonly isOpen: boolean
  readonly sourceId: string | null
  readonly knowledgeBaseId: string
  readonly onClose: () => void
  readonly targetChunkId?: string | null
  readonly targetPageNumber?: number | null
  readonly targetHeadingPath?: readonly string[] | null
  readonly citationNumber?: number | null
}

const BLOCKS_PER_PAGE = 50

export function DocumentPreviewModal({
  isOpen,
  sourceId,
  knowledgeBaseId,
  onClose,
  targetChunkId,
  targetPageNumber,
  targetHeadingPath,
  citationNumber
}: DocumentPreviewModalProps): ReactElement | null {
  const [preview, setPreview] = useState<DocumentPreviewDto | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(isOpen && sourceId))
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'full' | 'preservation' | 'chunks'>('chunks')
  const [blockPageIndex, setBlockPageIndex] = useState<number>(0)
  const targetedChunkRef = useRef<HTMLDivElement | null>(null)

  // Reset state during render when sourceId changes
  const [prevSourceId, setPrevSourceId] = useState<string | null>(sourceId)
  if (sourceId !== prevSourceId) {
    setPrevSourceId(sourceId)
    setPreview(null)
    setError(null)
    setBlockPageIndex(0)
    setLoading(Boolean(isOpen && sourceId))
    setActiveTab(targetChunkId ? 'chunks' : 'full')
  }

  // Esc key closes modal
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Load preview data when modal opens
  useEffect(() => {
    if (!isOpen || !sourceId || !knowledgeBaseId) {
      return
    }

    let isCurrent = true

    const fetchPreview = async (): Promise<void> => {
      try {
        if (!window.api?.knowledgeDocuments?.preview) {
          throw new Error('Document preview API is not available.')
        }

        const data = await window.api.knowledgeDocuments.preview({
          knowledgeBaseId,
          sourceId,
          maxChunks: targetChunkId ? 10 : 3
        })

        if (!isCurrent) return

        if (!data) {
          throw new Error('Document preview is unavailable or document is not fully indexed.')
        }

        setPreview(data)
        // If blocks are available and user didn't specifically target a citation chunk, show full document
        if (!targetChunkId && data.blocks && data.blocks.length > 0) {
          setActiveTab('full')
        } else {
          setActiveTab('chunks')
        }
        setError(null)
      } catch (err) {
        if (!isCurrent) return
        const rawMsg = err instanceof Error ? err.message : String(err)
        setError(rawMsg.replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]'))
      } finally {
        if (isCurrent) {
          setLoading(false)
        }
      }
    }

    void fetchPreview()

    return () => {
      isCurrent = false
    }
  }, [isOpen, sourceId, knowledgeBaseId, targetChunkId])

  // Scroll targeted chunk into view when preview data renders
  useEffect(() => {
    if (preview && targetedChunkRef.current) {
      if (typeof targetedChunkRef.current.scrollIntoView === 'function') {
        targetedChunkRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [preview, targetChunkId, activeTab])

  if (!isOpen) {
    return null
  }

  const renderPreservationBadge = (report?: PreviewPreservationSummaryDto | null): ReactElement => {
    if (!report) {
      return (
        <span
          className="doc-preservation-badge status-unknown"
          title="Preservation has not been evaluated for this document."
          data-testid="preservation-badge-unknown"
        >
          <HelpCircle size={13} className="inline-icon text-muted" aria-hidden="true" />
          <span>Preservation: Not evaluated</span>
        </span>
      )
    }

    switch (report.status) {
      case 'complete':
        return (
          <span
            className="doc-preservation-badge status-complete"
            title="Complete information preservation verified without data loss."
            data-testid="preservation-badge-complete"
          >
            <CheckCircle2 size={13} className="inline-icon text-success" aria-hidden="true" />
            <span>Preservation: Complete</span>
          </span>
        )
      case 'partial':
        return (
          <span
            className="doc-preservation-badge status-partial"
            title="Partial preservation: some complex or unsupported elements were simplified."
            data-testid="preservation-badge-partial"
          >
            <AlertTriangle size={13} className="inline-icon text-warning" aria-hidden="true" />
            <span>Preservation: Partial</span>
          </span>
        )
      case 'failed':
        return (
          <span
            className="doc-preservation-badge status-failed"
            title="Preservation validation failed for one or more elements."
            data-testid="preservation-badge-failed"
          >
            <XCircle size={13} className="inline-icon text-danger" aria-hidden="true" />
            <span>Preservation: Failed</span>
          </span>
        )
      default:
        return (
          <span
            className="doc-preservation-badge status-unknown"
            title="Preservation status unknown."
            data-testid="preservation-badge-unknown"
          >
            <HelpCircle size={13} className="inline-icon text-muted" aria-hidden="true" />
            <span>Preservation: Unknown</span>
          </span>
        )
    }
  }

  // Render individual canonical block safely (zero dangerous HTML)
  const renderBlock = (block: PreviewBlockDto): ReactElement => {
    switch (block.type) {
      case 'heading': {
        const HeadingTag = `h${Math.min(6, Math.max(1, block.level ?? 1))}` as
          'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return (
          <div
            key={block.id}
            className="preview-block preview-heading-block"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <HeadingTag className={`preview-heading heading-level-${block.level ?? 1}`}>
              {block.text}
            </HeadingTag>
          </div>
        )
      }

      case 'code':
        return (
          <div
            key={block.id}
            className="preview-block preview-code-block"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            {block.language && <div className="preview-code-language">{block.language}</div>}
            <pre className="preview-code-content">
              <code>{block.text}</code>
            </pre>
          </div>
        )

      case 'table':
        return (
          <div
            key={block.id}
            className="preview-block preview-table-block"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <div className="preview-table-container">
              <table className="preview-data-table">
                {block.headers && block.headers.length > 0 && (
                  <thead>
                    <tr>
                      {block.headers.map((h, i) => (
                        <th key={i}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                )}
                {block.rows && block.rows.length > 0 && (
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <td key={cIdx}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                )}
              </table>
            </div>
          </div>
        )

      case 'sheet_boundary':
        return (
          <div
            key={block.id}
            className="preview-block preview-sheet-boundary"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <FileSpreadsheet size={16} className="inline-icon text-accent" aria-hidden="true" />
            <span className="boundary-title">
              Worksheet: {block.sheetName || `Sheet ${block.sheetIndex ?? 1}`}
            </span>
          </div>
        )

      case 'slide_boundary':
        return (
          <div
            key={block.id}
            className="preview-block preview-slide-boundary"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <Presentation size={16} className="inline-icon text-accent" aria-hidden="true" />
            <span className="boundary-title">
              Slide {block.slideNumber ?? 1}: {block.slideTitle || 'Untitled Slide'}
            </span>
          </div>
        )

      case 'page_boundary':
        return (
          <div
            key={block.id}
            className="preview-block preview-page-boundary"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <BookOpen size={14} className="inline-icon text-muted" aria-hidden="true" />
            <span className="boundary-title">Page {block.location?.pageNumber ?? 1}</span>
          </div>
        )

      default:
        return (
          <div
            key={block.id}
            className="preview-block preview-paragraph-block"
            data-testid={`preview-block-${block.orderIndex}`}
          >
            <p className="preview-paragraph-text">{block.text}</p>
          </div>
        )
    }
  }

  const allBlocks = preview?.blocks ?? []
  const totalPages = Math.ceil(allBlocks.length / BLOCKS_PER_PAGE) || 1
  const displayedBlocks = allBlocks.slice(
    blockPageIndex * BLOCKS_PER_PAGE,
    (blockPageIndex + 1) * BLOCKS_PER_PAGE
  )

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
      data-testid="document-preview-modal"
    >
      <div className="modal-container document-preview-modal-container">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <FileText size={20} className="inline-icon text-accent" aria-hidden="true" />
            <h3 id="preview-modal-title" className="modal-title" data-testid="preview-title">
              {preview?.originalFileName || 'Document Preview'}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onClose}
            aria-label="Close document preview"
            data-testid="btn-close-preview"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body document-preview-modal-body">
          {loading && (
            <div className="section-loading-state" role="status" data-testid="preview-loading">
              <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
              <span>Loading document preview...</span>
            </div>
          )}

          {error && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="preview-error"
            >
              <AlertCircle size={18} className="inline-icon text-danger" aria-hidden="true" />
              <div className="alert-body">
                <strong>Preview Error</strong>
                <span>{error}</span>
              </div>
            </div>
          )}

          {!loading && !error && preview && (
            <div className="document-preview-content">
              {/* Document Meta Row */}
              <div className="document-preview-meta-row" data-testid="preview-meta">
                <span className={`doc-format-badge format-${preview.fileType}`}>
                  {preview.fileType.toUpperCase()}
                </span>
                <span className="doc-meta-item">
                  <strong>Size:</strong> {formatBytes(preview.fileSize)}
                </span>
                <span className="doc-meta-item">
                  <strong>Total Chunks:</strong> {formatCount(preview.totalChunks)}
                </span>
                {preview.totalBlocks !== undefined && preview.totalBlocks > 0 && (
                  <span className="doc-meta-item">
                    <strong>Total Blocks:</strong> {formatCount(preview.totalBlocks)}
                  </span>
                )}
                {renderPreservationBadge(preview.preservationReport)}
              </div>

              {/* View Mode Tabs */}
              <div className="document-preview-tabs" role="tablist">
                {preview.blocks && preview.blocks.length > 0 && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'full'}
                    className={`preview-tab-btn ${activeTab === 'full' ? 'active' : ''}`}
                    onClick={() => setActiveTab('full')}
                    data-testid="tab-full-document"
                  >
                    <Layers size={14} className="inline-icon" aria-hidden="true" />
                    <span>Full Document ({preview.totalBlocks ?? preview.blocks.length})</span>
                  </button>
                )}

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'preservation'}
                  className={`preview-tab-btn ${activeTab === 'preservation' ? 'active' : ''}`}
                  onClick={() => setActiveTab('preservation')}
                  data-testid="tab-preservation-details"
                >
                  <ShieldCheck size={14} className="inline-icon" aria-hidden="true" />
                  <span>
                    Preservation Report
                    {preview.preservationReport?.status
                      ? ` (${preview.preservationReport.status.toUpperCase()})`
                      : ''}
                  </span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'chunks'}
                  className={`preview-tab-btn ${activeTab === 'chunks' ? 'active' : ''}`}
                  onClick={() => setActiveTab('chunks')}
                  data-testid="tab-indexed-chunks"
                >
                  <Target size={14} className="inline-icon" aria-hidden="true" />
                  <span>Indexed Chunks ({preview.chunks.length})</span>
                </button>
              </div>

              {/* TAB 1: FULL CANONICAL DOCUMENT */}
              {activeTab === 'full' && (
                <div className="preview-full-document-panel" data-testid="full-document-panel">
                  {allBlocks.length === 0 ? (
                    <p className="empty-state-text">
                      No structured blocks found for this document.
                    </p>
                  ) : (
                    <>
                      {/* Pagination header for large documents */}
                      {totalPages > 1 && (
                        <div className="preview-pagination-controls">
                          <span>
                            Showing blocks {blockPageIndex * BLOCKS_PER_PAGE + 1}–
                            {Math.min((blockPageIndex + 1) * BLOCKS_PER_PAGE, allBlocks.length)} of{' '}
                            {allBlocks.length}
                          </span>
                          <div className="pagination-buttons">
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              disabled={blockPageIndex === 0}
                              onClick={() => setBlockPageIndex((p) => Math.max(0, p - 1))}
                            >
                              <ChevronLeft size={14} /> Previous
                            </button>
                            <span className="page-indicator">
                              Page {blockPageIndex + 1} of {totalPages}
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              disabled={blockPageIndex >= totalPages - 1}
                              onClick={() =>
                                setBlockPageIndex((p) => Math.min(totalPages - 1, p + 1))
                              }
                            >
                              Next <ChevronRight size={14} />
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="canonical-blocks-container">
                        {displayedBlocks.map((block) => renderBlock(block))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* TAB 2: PRESERVATION DETAILS */}
              {activeTab === 'preservation' && (
                <div className="preview-preservation-panel" data-testid="preservation-report-panel">
                  {preview.preservationReport ? (
                    <div className="preservation-report-content">
                      {/* Top Summary Banner */}
                      <div
                        className={`preservation-summary-banner status-${preview.preservationReport.status}`}
                      >
                        <div className="summary-banner-header">
                          <h4 className="summary-title">
                            Overall Status: {preview.preservationReport.status.toUpperCase()}
                          </h4>
                        </div>
                        <p className="summary-description">
                          {preview.preservationReport.status === 'complete' &&
                            'All textual content, document elements, and structural boundaries were verified intact.'}
                          {preview.preservationReport.status === 'partial' &&
                            'Some visual objects, drawings, or unsupported constructs were simplified or preserved as references.'}
                          {preview.preservationReport.status === 'failed' &&
                            'One or more source elements failed extraction or parsing.'}
                          {preview.preservationReport.status === 'unknown' &&
                            'Preservation status could not be verified deterministically.'}
                        </p>
                      </div>

                      {/* Fidelity Grid */}
                      <div className="preservation-metrics-grid">
                        <div className="metric-card">
                          <span className="metric-label">Textual Fidelity</span>
                          <span
                            className={`metric-value status-${preview.preservationReport.textualFidelity ?? 'unknown'}`}
                          >
                            {(
                              preview.preservationReport.textualFidelity ?? 'unknown'
                            ).toUpperCase()}
                          </span>
                        </div>
                        <div className="metric-card">
                          <span className="metric-label">Structural Fidelity</span>
                          <span
                            className={`metric-value status-${preview.preservationReport.structuralFidelity ?? 'unknown'}`}
                          >
                            {(
                              preview.preservationReport.structuralFidelity ?? 'unknown'
                            ).toUpperCase()}
                          </span>
                        </div>
                        <div className="metric-card">
                          <span className="metric-label">Chunk Coverage</span>
                          <span
                            className={`metric-value status-${preview.preservationReport.chunkCoverageStatus}`}
                          >
                            {preview.preservationReport.chunkCoverageStatus.toUpperCase()} (
                            {(preview.preservationReport.coverageRatio * 100).toFixed(1)}%)
                          </span>
                        </div>
                        <div className="metric-card">
                          <span className="metric-label">Blocks Covered</span>
                          <span className="metric-value">
                            {preview.preservationReport.coveredBlocks} /{' '}
                            {preview.preservationReport.totalBlocks}
                          </span>
                        </div>
                      </div>

                      {/* Dispositions breakdown */}
                      <div className="preservation-dispositions-card">
                        <h5 className="card-section-title">Source Element Dispositions</h5>
                        <div className="dispositions-list">
                          {Object.entries(preview.preservationReport.dispositionCounts).map(
                            ([disp, count]) => (
                              <div key={disp} className="disposition-item">
                                <span className="disposition-name">{disp}</span>
                                <span className="disposition-count">{count}</span>
                              </div>
                            )
                          )}
                        </div>
                      </div>

                      {/* Warnings and Limitations */}
                      {(preview.preservationReport.warnings.length > 0 ||
                        preview.preservationReport.measurementLimitations.length > 0) && (
                        <div className="preservation-warnings-card">
                          <h5 className="card-section-title">Disclosed Warnings & Limitations</h5>
                          <ul className="warnings-list">
                            {preview.preservationReport.warnings.map((w, idx) => (
                              <li key={`w-${idx}`} className="warning-item">
                                <Info size={13} className="inline-icon text-warning" />
                                <span>{w}</span>
                              </li>
                            ))}
                            {preview.preservationReport.measurementLimitations.map((l, idx) => (
                              <li key={`l-${idx}`} className="limitation-item">
                                <AlertCircle size={13} className="inline-icon text-muted" />
                                <span>{l}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Versions */}
                      <div className="preservation-versions-row">
                        <span className="version-tag">
                          Extractor: {preview.preservationReport.versions.extractorVersion || 'N/A'}
                        </span>
                        <span className="version-tag">
                          Chunker: {preview.preservationReport.versions.chunkerVersion}
                        </span>
                        <span className="version-tag">
                          Validator: {preview.preservationReport.versions.validatorVersion}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-report-state">
                      <HelpCircle size={36} className="text-muted" />
                      <p>
                        Preservation validation report has not been generated for this document.
                        Click &ldquo;Reindex&rdquo; in the document table to run the latest
                        information-preserving validator.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: INDEXED CHUNKS */}
              {activeTab === 'chunks' && (
                <div className="preview-chunks-panel" data-testid="indexed-chunks-panel">
                  {preview.chunks.length === 0 ? (
                    <p className="empty-state-text">No indexed chunks found for this document.</p>
                  ) : (
                    <div className="document-preview-chunks-list">
                      {preview.chunks.map((chunk) => {
                        const isTargetChunk = targetChunkId
                          ? chunk.chunkId === targetChunkId
                          : targetPageNumber !== null && targetPageNumber !== undefined
                            ? chunk.pageNumber === targetPageNumber
                            : targetHeadingPath && targetHeadingPath.length > 0 && chunk.headingPath
                              ? chunk.headingPath.join(' > ') === targetHeadingPath.join(' > ')
                              : false

                        return (
                          <div
                            key={chunk.chunkId}
                            ref={isTargetChunk ? targetedChunkRef : null}
                            className={`document-preview-chunk-card ${isTargetChunk ? 'is-cited-chunk' : ''}`}
                            data-testid={`preview-chunk-${chunk.chunkIndex}`}
                            style={
                              isTargetChunk
                                ? {
                                    border: '2px solid #3b82f6',
                                    backgroundColor: '#eff6ff'
                                  }
                                : undefined
                            }
                          >
                            <div className="document-preview-chunk-header">
                              <span className="chunk-badge">Chunk #{chunk.chunkIndex + 1}</span>

                              {isTargetChunk && (
                                <span
                                  className="chunk-cited-badge"
                                  data-testid="chunk-cited-badge"
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    backgroundColor: '#2563eb',
                                    color: '#ffffff',
                                    padding: '2px 8px',
                                    borderRadius: '4px',
                                    fontSize: '11px',
                                    fontWeight: 600
                                  }}
                                >
                                  <Target size={12} aria-hidden="true" />
                                  Cited {citationNumber ? `[${citationNumber}]` : 'Location'}
                                </span>
                              )}

                              {chunk.pageNumber !== null && (
                                <span className="chunk-page-badge" data-testid="chunk-page-number">
                                  <BookOpen size={12} className="inline-icon" aria-hidden="true" />{' '}
                                  {preview.fileType === 'pptx' ? 'Slide' : 'Page'}{' '}
                                  {chunk.pageNumber}
                                </span>
                              )}

                              {chunk.heading && (
                                <span className="chunk-heading-badge" data-testid="chunk-heading">
                                  {chunk.headingPath && chunk.headingPath.length > 1
                                    ? chunk.headingPath.join(' > ')
                                    : chunk.heading}
                                </span>
                              )}

                              <span className="chunk-token-count text-muted">
                                ~{chunk.tokenCount} tokens
                              </span>
                            </div>

                            <pre
                              className="document-preview-chunk-text"
                              data-testid="chunk-content"
                            >
                              {chunk.content}
                            </pre>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <a
            href={`#/knowledge-bases/${knowledgeBaseId}/knowledge`}
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="view-in-kb-link"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              textDecoration: 'none'
            }}
          >
            <ExternalLink size={14} className="inline-icon" aria-hidden="true" />
            <span>View in Knowledge Base</span>
          </a>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="btn-dismiss-preview"
          >
            Close Preview
          </button>
        </div>
      </div>
    </div>
  )
}
