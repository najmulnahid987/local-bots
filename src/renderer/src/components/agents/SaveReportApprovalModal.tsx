import { ReactElement, useEffect, useState, useCallback } from 'react'
import { X, FileCheck, AlertCircle, Loader2, ShieldCheck, CheckCircle2, Ban } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ApprovalDetailsDto } from '../../../../shared/agents'
import { safeUrlTransform } from '../chat/markdown-utils'
import { formatBytes, formatTimestamp } from '../../utils/formatters'

export interface SaveReportApprovalModalProps {
  readonly isOpen: boolean
  readonly agentRunId: string | null
  readonly approvalRequestId: string | null
  readonly onClose: () => void
  readonly onDecisionSubmitted?: (decision: 'approve' | 'reject') => void
}

/**
 * Human-in-the-loop report approval modal.
 * Presents exact proposed markdown report content, title, and size
 * for user inspection before save_report can write to the filesystem.
 *
 * Security Requirements:
 * - Uses ReactMarkdown with safeUrlTransform without raw HTML.
 * - Model cannot silently write or overwrite files.
 * - User decision dispatched via secure IPC bridge (respondToApproval).
 */
export function SaveReportApprovalModal({
  isOpen,
  agentRunId,
  approvalRequestId,
  onClose,
  onDecisionSubmitted
}: SaveReportApprovalModalProps): ReactElement | null {
  const [details, setDetails] = useState<ApprovalDetailsDto | null>(null)
  const [loading, setLoading] = useState<boolean>(
    Boolean(isOpen && agentRunId && approvalRequestId)
  )
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rejectionReason, setRejectionReason] = useState<string>('')

  // Reset when target request changes
  const [prevTarget, setPrevTarget] = useState<string | null>(
    agentRunId && approvalRequestId ? `${agentRunId}:${approvalRequestId}` : null
  )
  const currentTarget =
    agentRunId && approvalRequestId ? `${agentRunId}:${approvalRequestId}` : null
  if (currentTarget !== prevTarget) {
    setPrevTarget(currentTarget)
    setDetails(null)
    setError(null)
    setActionError(null)
    setRejectionReason('')
    setLoading(Boolean(isOpen && agentRunId && approvalRequestId))
  }

  // Escape key closes modal without saving
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isSubmitting, onClose])

  // Load pending approval details
  useEffect(() => {
    if (!isOpen || !agentRunId || !approvalRequestId) {
      return
    }

    let isCurrent = true

    const fetchApprovalDetails = async (): Promise<void> => {
      try {
        if (!window.api?.agents?.getApprovalDetails) {
          throw new Error('Agent approval API is not available.')
        }

        const data = await window.api.agents.getApprovalDetails({
          agentRunId,
          approvalRequestId
        })

        if (!isCurrent) return

        if (!data) {
          throw new Error('Approval request is not pending, has expired, or was already resolved.')
        }

        setDetails(data)
      } catch (err) {
        if (!isCurrent) return
        setError(err instanceof Error ? err.message : 'Failed to load report approval details.')
      } finally {
        if (isCurrent) {
          setLoading(false)
        }
      }
    }

    void fetchApprovalDetails()

    return () => {
      isCurrent = false
    }
  }, [isOpen, agentRunId, approvalRequestId])

  const handleDecision = useCallback(
    async (decision: 'approve' | 'reject'): Promise<void> => {
      if (!agentRunId || !approvalRequestId || isSubmitting) return

      setIsSubmitting(true)
      setActionError(null)

      try {
        if (!window.api?.agents?.respondToApproval) {
          throw new Error('Agent response API is not available.')
        }

        const res = await window.api.agents.respondToApproval({
          agentRunId,
          approvalRequestId,
          decision,
          reason:
            decision === 'reject' && rejectionReason.trim() ? rejectionReason.trim() : undefined
        })

        if (!res.success) {
          throw new Error(`Failed to resolve approval: response status was ${res.status}.`)
        }

        onDecisionSubmitted?.(decision)
        onClose()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Failed to ${decision} report.`)
      } finally {
        setIsSubmitting(false)
      }
    },
    [agentRunId, approvalRequestId, isSubmitting, rejectionReason, onDecisionSubmitted, onClose]
  )

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      data-testid="save-report-approval-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px'
      }}
    >
      <div
        className="modal-container save-report-modal-container"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-report-modal-title"
        data-testid="save-report-approval-modal"
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90vh',
          backgroundColor: '#ffffff',
          borderRadius: '10px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid #cbd5e1'
        }}
      >
        {/* Modal Header */}
        <div
          className="modal-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid #e2e8f0',
            backgroundColor: '#f8fafc'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <FileCheck
              size={20}
              className="inline-icon text-accent"
              style={{ color: '#2563eb' }}
              aria-hidden="true"
            />
            <div>
              <h3
                id="save-report-modal-title"
                className="modal-title"
                data-testid="save-report-title"
                style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#0f172a' }}
              >
                {details?.title ? `Approve Report: ${details.title}` : 'Review Report to Save'}
              </h3>
              <span style={{ fontSize: '12px', color: '#64748b' }}>
                Human approval required before file creation
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close report review"
            data-testid="btn-close-report-modal"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              padding: '4px',
              borderRadius: '4px',
              color: '#64748b'
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Modal Body */}
        <div
          className="modal-body"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}
        >
          {loading && (
            <div
              className="section-loading-state"
              role="status"
              data-testid="report-details-loading"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '40px 0',
                color: '#64748b'
              }}
            >
              <Loader2 size={20} className="spinner inline-icon" aria-hidden="true" />
              <span>Loading report preview...</span>
            </div>
          )}

          {error && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="report-details-error"
              style={{
                padding: '12px 14px',
                borderRadius: '6px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#b91c1c',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <AlertCircle
                size={18}
                className="inline-icon"
                style={{ flexShrink: 0, marginTop: '2px' }}
                aria-hidden="true"
              />
              <div>
                <strong>Unable to load report</strong>
                <p style={{ margin: '4px 0 0 0' }}>{error}</p>
              </div>
            </div>
          )}

          {actionError && (
            <div
              className="section-alert section-alert-error"
              role="alert"
              data-testid="report-action-error"
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#b91c1c',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <AlertCircle size={15} className="inline-icon" aria-hidden="true" />
              <span>{actionError}</span>
            </div>
          )}

          {!loading && !error && details && (
            <>
              {/* Security & Metadata Info Callout */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  backgroundColor: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: '#166534'
                }}
                data-testid="report-meta-callout"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>
                    <strong>File save approval:</strong> Approving will open a native OS save dialog
                    to select the destination folder.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '12px', flexShrink: 0, fontWeight: 500 }}>
                  <span data-testid="report-content-size">
                    Size: {formatBytes(details.contentSizeBytes)}
                  </span>
                  {details.expiresAt && (
                    <span data-testid="report-expires-at">
                      Expires: {formatTimestamp(details.expiresAt)}
                    </span>
                  )}
                </div>
              </div>

              {/* Report Preview Panel */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#475569',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em'
                  }}
                >
                  Report Content Preview
                </div>
                <div
                  className="report-markdown-preview chat-markdown-content"
                  data-testid="report-markdown-preview"
                  style={{
                    maxHeight: '340px',
                    overflowY: 'auto',
                    padding: '14px 16px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '13px',
                    lineHeight: '1.6',
                    color: '#0f172a'
                  }}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrlTransform}>
                    {details.markdownContent}
                  </ReactMarkdown>
                </div>
              </div>

              {/* Optional Rejection Reason */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label
                  htmlFor="rejection-reason-input"
                  style={{ fontSize: '12px', fontWeight: 500, color: '#475569' }}
                >
                  Rejection Reason (optional, returned to model):
                </label>
                <input
                  id="rejection-reason-input"
                  type="text"
                  data-testid="rejection-reason-input"
                  className="form-input"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g. Needs more detailed analysis or wrong format"
                  disabled={isSubmitting}
                  maxLength={500}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '12.5px'
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div
          className="modal-footer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderTop: '1px solid #e2e8f0',
            backgroundColor: '#f8fafc'
          }}
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="cancel-approval-btn"
            style={{
              padding: '6px 12px',
              fontSize: '12.5px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              backgroundColor: '#ffffff',
              color: '#334155',
              cursor: isSubmitting ? 'not-allowed' : 'pointer'
            }}
          >
            Cancel / Review Later
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void handleDecision('reject')}
              disabled={isSubmitting || loading || Boolean(error)}
              data-testid="reject-report-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 14px',
                fontSize: '12.5px',
                borderRadius: '6px',
                border: '1px solid #fecaca',
                backgroundColor: '#fef2f2',
                color: '#b91c1c',
                cursor: isSubmitting || loading || Boolean(error) ? 'not-allowed' : 'pointer',
                fontWeight: 500
              }}
            >
              <Ban size={14} aria-hidden="true" />
              <span>Reject</span>
            </button>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleDecision('approve')}
              disabled={isSubmitting || loading || Boolean(error)}
              data-testid="approve-report-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 16px',
                fontSize: '12.5px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: '#16a34a',
                color: '#ffffff',
                cursor: isSubmitting || loading || Boolean(error) ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                boxShadow: '0 1px 2px rgba(22, 163, 74, 0.2)'
              }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="spinner inline-icon" aria-hidden="true" />
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>Approve & Save</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
