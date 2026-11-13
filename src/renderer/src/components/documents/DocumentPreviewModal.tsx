import { ReactElement, useEffect, useState, useRef } from 'react'
import { X, FileText, Loader2, AlertCircle, BookOpen, Target, ExternalLink } from 'lucide-react'
import type { DocumentPreviewDto } from '../../../../shared/knowledge-documents'
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
  const targetedChunkRef = useRef<HTMLDivElement | null>(null)

  // Reset state during render when sourceId changes
  const [prevSourceId, setPrevSourceId] = useState<string | null>(sourceId)
  if (sourceId !== prevSourceId) {
    setPrevSourceId(sourceId)
    setPreview(null)
    setError(null)
    setLoading(Boolean(isOpen && sourceId))
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
  }, [preview, targetChunkId])

  if (!isOpen) {
    return null
  }

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
              <span>Loading preview excerpts...</span>
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
                <span className="doc-meta-item text-muted">
                  Showing first {preview.chunks.length} excerpt
                  {preview.chunks.length === 1 ? '' : 's'}
                </span>
              </div>

              {/* Chunks List */}
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
                              <BookOpen size={12} className="inline-icon" aria-hidden="true" /> Page{' '}
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

                        <pre className="document-preview-chunk-text" data-testid="chunk-content">
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
