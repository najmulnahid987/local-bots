import { ReactElement, KeyboardEvent } from 'react'
import { Cpu, CheckCircle2, AlertCircle, Wrench } from 'lucide-react'
import type { BotDto } from '../../../../shared/bots'

export interface BotCardProps {
  readonly bot: BotDto
  readonly onSelect?: (bot: BotDto) => void
  readonly onClick?: (bot: BotDto) => void
  readonly className?: string
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  search_knowledge_base: 'Search KB',
  read_knowledge_base_document: 'Read Doc',
  list_knowledge_base_documents: 'List Docs',
  search_project_files: 'Search Files',
  read_project_file: 'Read File',
  prepare_report: 'Prepare Report'
}

function formatToolName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool] ?? tool
}

export function BotCard({ bot, onSelect, onClick, className = '' }: BotCardProps): ReactElement {
  const isArchived = bot.status === 'archived'
  const isInteractive = Boolean(onSelect || onClick)

  const handleInteraction = (): void => {
    if (onSelect) onSelect(bot)
    if (onClick) onClick(bot)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      handleInteraction()
    }
  }

  return (
    <article
      className={`bot-card ${isArchived ? 'bot-card-archived' : ''} ${
        isInteractive ? 'bot-card-interactive' : ''
      } ${className}`.trim()}
      aria-label={`Bot: ${bot.name}`}
      data-testid={`bot-card-${bot.id}`}
      tabIndex={isInteractive ? 0 : undefined}
      role={isInteractive ? 'button' : undefined}
      onClick={isInteractive ? handleInteraction : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
    >
      <header className="bot-card-header">
        <div className="bot-card-title-group">
          <h3 className="bot-card-name" data-testid="bot-name" title={bot.name}>
            {bot.name}
          </h3>
          <div className="bot-card-badges">
            {isArchived ? (
              <span
                className="status-badge status-badge-revoked"
                data-testid="bot-status-badge"
                title="Bot is archived"
              >
                Archived
              </span>
            ) : (
              <span
                className="status-badge status-badge-active"
                data-testid="bot-status-badge"
                title="Bot is active"
              >
                Active
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="bot-card-body">
        {bot.description ? (
          <p className="bot-card-description" data-testid="bot-description">
            {bot.description}
          </p>
        ) : (
          <p className="bot-card-description empty" data-testid="bot-description-empty">
            No description provided.
          </p>
        )}
      </div>

      <footer className="bot-card-footer">
        <div className="bot-card-meta">
          <span
            className="bot-meta-item"
            data-testid="bot-model"
            title={`Model ID: ${bot.modelId}`}
          >
            <Cpu size={12} className="inline-icon" aria-hidden="true" />
            <code className="bot-model-code">{bot.modelId}</code>
          </span>

          {bot.providerConnectionId ? (
            <span
              className="bot-meta-item bot-meta-connected"
              data-testid="bot-provider-status"
              title="Assigned to a configured provider connection"
            >
              <CheckCircle2 size={12} className="inline-icon text-success" aria-hidden="true" />
              Connected
            </span>
          ) : (
            <span
              className="bot-meta-item bot-meta-unassigned"
              data-testid="bot-provider-status"
              title="No provider connection assigned"
            >
              <AlertCircle size={12} className="inline-icon text-muted" aria-hidden="true" />
              Unassigned
            </span>
          )}
        </div>

        <div className="bot-card-tools-section">
          {bot.enabledTools.length > 0 ? (
            <div className="bot-card-tools" data-testid="bot-tools-list" aria-label="Enabled tools">
              {bot.enabledTools.map((tool) => (
                <span
                  key={tool}
                  className="bot-tool-badge"
                  data-testid={`tool-badge-${tool}`}
                  title={tool}
                >
                  <Wrench size={10} className="inline-icon" aria-hidden="true" />
                  {formatToolName(tool)}
                </span>
              ))}
            </div>
          ) : (
            <span className="bot-no-tools" data-testid="bot-no-tools">
              No tools enabled
            </span>
          )}
        </div>
      </footer>
    </article>
  )
}
