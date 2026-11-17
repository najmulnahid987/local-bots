import { ReactElement } from 'react'
import { Pin, StickyNote, Edit3, Trash2 } from 'lucide-react'
import type { BotMemoryDto } from '../../../../../shared/bot-memories'
import { estimateTokenCount } from '../../../../../shared/bot-memories'
import { formatTimestamp } from '../../../utils/formatters'

export interface BotMemoryCardProps {
  readonly memory: BotMemoryDto
  readonly onEdit: (memory: BotMemoryDto) => void
  readonly onDelete: (memory: BotMemoryDto) => void
  readonly onTogglePin: (memory: BotMemoryDto) => void
  readonly isMutating?: boolean
  readonly isArchived?: boolean
}

export function BotMemoryCard({
  memory,
  onEdit,
  onDelete,
  onTogglePin,
  isMutating = false,
  isArchived = false
}: BotMemoryCardProps): ReactElement {
  const isPinned = memory.memoryType === 'pinned_instruction'
  const estimatedTokens = estimateTokenCount(memory.content)

  const updatedTimeText = memory.updatedAt ? formatTimestamp(memory.updatedAt) : ''
  const createdTimeText = memory.createdAt ? formatTimestamp(memory.createdAt) : ''

  return (
    <article
      className={`bot-memory-card ${isPinned ? 'bot-memory-card-pinned' : ''}`}
      data-testid={`bot-memory-card-${memory.id}`}
      style={{
        backgroundColor: '#ffffff',
        border: isPinned ? '1px solid #c7d2fe' : '1px solid var(--color-border, #e2e8f0)',
        borderLeft: isPinned ? '4px solid #6366f1' : '4px solid #94a3b8',
        borderRadius: '8px',
        padding: '14px 16px',
        marginBottom: '12px',
        boxShadow: isPinned
          ? '0 1px 3px rgba(99, 102, 241, 0.08)'
          : '0 1px 2px rgba(15, 23, 42, 0.04)',
        position: 'relative'
      }}
    >
      {/* Top Header: Badge, Tokens & Actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px',
          gap: '8px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {isPinned ? (
            <span
              className="status-badge"
              data-testid={`memory-type-badge-${memory.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                backgroundColor: '#eef2ff',
                color: '#4338ca',
                border: '1px solid #c7d2fe',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '11px',
                fontWeight: 600
              }}
              title="Pinned instruction: prioritized inside the memory context budget. Cannot override system safety rules."
            >
              <Pin size={11} className="inline-icon" aria-hidden="true" />
              <span>Pinned Instruction</span>
            </span>
          ) : (
            <span
              className="status-badge"
              data-testid={`memory-type-badge-${memory.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                backgroundColor: '#f1f5f9',
                color: '#475569',
                border: '1px solid #cbd5e1',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '11px',
                fontWeight: 600
              }}
              title="User note: contextual preference or finding included as prompt context."
            >
              <StickyNote size={11} className="inline-icon" aria-hidden="true" />
              <span>User Note</span>
            </span>
          )}

          <span
            data-testid={`memory-token-badge-${memory.id}`}
            style={{
              fontSize: '11px',
              color: '#64748b',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              padding: '1px 6px',
              borderRadius: '4px'
            }}
          >
            ~{estimatedTokens} tokens
          </span>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => onTogglePin(memory)}
            disabled={isMutating || isArchived}
            data-testid={`memory-toggle-pin-btn-${memory.id}`}
            title={isPinned ? 'Demote to regular user note' : 'Pin to prioritize in context budget'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              color: isPinned ? '#4338ca' : '#475569'
            }}
          >
            <Pin size={12} aria-hidden="true" fill={isPinned ? 'currentColor' : 'none'} />
            <span>{isPinned ? 'Unpin' : 'Pin'}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => onEdit(memory)}
            disabled={isMutating || isArchived}
            data-testid={`memory-edit-btn-${memory.id}`}
            title="Edit memory content or type"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px'
            }}
          >
            <Edit3 size={12} aria-hidden="true" />
            <span>Edit</span>
          </button>

          <button
            type="button"
            className="btn btn-danger btn-xs"
            onClick={() => onDelete(memory)}
            disabled={isMutating || isArchived}
            data-testid={`memory-delete-btn-${memory.id}`}
            title="Delete this memory"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              padding: '3px 8px'
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* Memory Content Text */}
      <div
        className="bot-memory-content"
        data-testid={`memory-content-${memory.id}`}
        style={{
          fontSize: '13px',
          lineHeight: '1.55',
          color: 'var(--color-text-primary, #0f172a)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: '8px 0',
          fontFamily: 'inherit'
        }}
      >
        {memory.content}
      </div>

      {/* Footer Timestamps */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          color: '#94a3b8',
          borderTop: '1px solid #f1f5f9',
          paddingTop: '6px',
          marginTop: '8px'
        }}
      >
        <span data-testid={`memory-updated-time-${memory.id}`}>Updated {updatedTimeText}</span>
        {createdTimeText && createdTimeText !== updatedTimeText && (
          <span data-testid={`memory-created-time-${memory.id}`}>Created {createdTimeText}</span>
        )}
      </footer>
    </article>
  )
}
