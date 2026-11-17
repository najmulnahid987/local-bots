import { ReactElement } from 'react'
import { Bot, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'
import { BotCard } from './BotCard'

export interface BotListProps {
  readonly bots: readonly BotDto[]
  readonly isLoading?: boolean
  readonly error?: string | null
  readonly onRetry?: () => void
  readonly onSelectBot?: (bot: BotDto) => void
  readonly onEditBot?: (bot: BotDto) => void
  readonly onArchiveBot?: (bot: BotDto) => void
  readonly onUnarchiveBot?: (bot: BotDto) => void
  readonly onDeleteBot?: (bot: BotDto) => void
  readonly onManageMemoriesBot?: (bot: BotDto) => void
  readonly emptyTitle?: string
  readonly emptyMessage?: string
  readonly className?: string
}

export function BotList({
  bots,
  isLoading = false,
  error = null,
  onRetry,
  onSelectBot,
  onEditBot,
  onArchiveBot,
  onUnarchiveBot,
  onDeleteBot,
  onManageMemoriesBot,
  emptyTitle,
  emptyMessage,
  className = ''
}: BotListProps): ReactElement {
  if (isLoading) {
    return (
      <div className="section-loading-state" role="status" data-testid="bot-list-loading">
        <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
        <span>Loading bots...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="section-alert section-alert-error" role="alert" data-testid="bot-list-error">
        <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
        <div className="alert-body">
          <strong>Failed to load bots</strong>
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '8px', alignSelf: 'flex-start' }}
              onClick={onRetry}
              data-testid="bot-list-retry"
            >
              <RefreshCw size={13} className="inline-icon" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      </div>
    )
  }

  if (bots.length === 0) {
    return (
      <section
        className="empty-state-section"
        aria-label="No Bots Found"
        data-testid="bot-list-empty"
      >
        <div className="empty-state-card">
          <Bot
            size={44}
            style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
            aria-hidden="true"
          />
          <h3 className="empty-state-heading">{emptyTitle ?? 'No Bots in this Knowledge Base'}</h3>
          <p className="empty-state-text">
            {emptyMessage ??
              'Create a persistent AI Bot to analyze, query, and synthesize documents inside this Knowledge Base.'}
          </p>
        </div>
      </section>
    )
  }

  return (
    <div
      className={`bot-grid ${className}`.trim()}
      role="list"
      aria-label="AI Bots List"
      data-testid="bot-list-grid"
    >
      {bots.map((bot) => (
        <div key={bot.id} role="listitem" className="bot-grid-item">
          <BotCard
            bot={bot}
            onSelect={onSelectBot}
            onEdit={onEditBot}
            onArchive={onArchiveBot}
            onUnarchive={onUnarchiveBot}
            onDelete={onDeleteBot}
            onManageMemories={onManageMemoriesBot}
          />
        </div>
      ))}
    </div>
  )
}
