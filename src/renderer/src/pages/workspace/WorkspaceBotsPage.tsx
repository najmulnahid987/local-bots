import { ReactElement, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { Plus, RotateCw, AlertCircle, Loader2 } from 'lucide-react'
import type { WorkspaceOutletContext } from '../../components/kb/KnowledgeBaseWorkspaceLayout'
import type { BotDto, BotStatus } from '../../../../shared/bots'
import { useBots } from '../../hooks/useBots'
import { BotList } from '../../components/bots/BotList'
import { CreateBotModal } from '../../components/bots/CreateBotModal'
import { EditBotModal } from '../../components/bots/EditBotModal'
import { BotArchiveDialog } from '../../components/bots/BotArchiveDialog'
import { BotUnarchiveDialog } from '../../components/bots/BotUnarchiveDialog'
import { BotDeleteDialog } from '../../components/bots/BotDeleteDialog'

export function WorkspaceBotsPage(): ReactElement {
  const navigate = useNavigate()
  const outletCtx = useOutletContext<WorkspaceOutletContext | undefined>()
  const knowledgeBase = outletCtx?.knowledgeBase
  const isWorkspaceActivated = outletCtx?.isWorkspaceActivated ?? true
  const workspaceActivationError = outletCtx?.workspaceActivationError ?? null

  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all')

  const statusOption: BotStatus | undefined = filter === 'all' ? undefined : filter

  // Bot management hook scoped by Main-process active session context
  const {
    bots,
    isLoading,
    isRefreshing,
    error,
    refresh,
    createBot,
    updateBot,
    archiveBot,
    unarchiveBot,
    deleteBot
  } = useBots({
    status: statusOption,
    enabled: isWorkspaceActivated && !workspaceActivationError
  })

  // Modal Dialogs State
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false)
  const [editingBot, setEditingBot] = useState<BotDto | null>(null)
  const [archivingBot, setArchivingBot] = useState<BotDto | null>(null)
  const [unarchivingBot, setUnarchivingBot] = useState<BotDto | null>(null)
  const [deletingBot, setDeletingBot] = useState<BotDto | null>(null)

  const kbName = knowledgeBase?.name ?? 'Current Knowledge Base'

  const handleSelectBot = (bot: BotDto): void => {
    if (knowledgeBase && bot.status !== 'archived') {
      navigate(`/knowledge-bases/${knowledgeBase.id}/bots/${bot.id}/conversations`)
    }
  }

  return (
    <div className="workspace-tab-panel" data-testid="workspace-bots-tab">
      {/* Tab Panel Header */}
      <div className="workspace-panel-header">
        <div>
          <h2 className="workspace-panel-title" data-testid="workspace-bots-heading">
            AI Bots
          </h2>
          <p className="workspace-panel-subtitle">
            Specialized AI teammates configured to analyze, query, and synthesize documents within{' '}
            <strong>{kbName}</strong>.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refresh()}
            disabled={isLoading || isRefreshing || !isWorkspaceActivated}
            data-testid="refresh-bots-btn"
            title="Refresh bot list"
            aria-label="Refresh bot list"
          >
            <RotateCw
              size={13}
              className={`inline-icon ${isRefreshing ? 'spinner' : ''}`}
              aria-hidden="true"
            />
            Refresh
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setIsCreateOpen(true)}
            disabled={!isWorkspaceActivated || Boolean(workspaceActivationError)}
            data-testid="create-bot-btn"
          >
            <Plus size={15} className="inline-icon" aria-hidden="true" />
            Create Bot
          </button>
        </div>
      </div>

      {/* Main Process Workspace Activation Error */}
      {workspaceActivationError && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="workspace-activation-error"
          style={{ marginBottom: '16px' }}
        >
          <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Workspace Activation Error</strong>
            <span>
              Failed to activate the local Knowledge Base context in the main process:{' '}
              {workspaceActivationError}
            </span>
          </div>
        </div>
      )}

      {/* Activating Workspace State */}
      {!isWorkspaceActivated && !workspaceActivationError && (
        <div
          className="section-loading-state"
          role="status"
          data-testid="workspace-activating-state"
          style={{ marginBottom: '16px' }}
        >
          <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
          <span>Synchronizing workspace context...</span>
        </div>
      )}

      {/* Filter Toolbar */}
      <div
        className="bot-filter-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
          gap: '12px'
        }}
      >
        <div className="filter-button-group" role="tablist" aria-label="Bot status filter">
          <button
            type="button"
            className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('all')}
            role="tab"
            aria-selected={filter === 'all'}
            data-testid="filter-all"
          >
            All Bots
          </button>
          <button
            type="button"
            className={`btn btn-sm ${filter === 'active' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('active')}
            role="tab"
            aria-selected={filter === 'active'}
            data-testid="filter-active"
          >
            Active
          </button>
          <button
            type="button"
            className={`btn btn-sm ${filter === 'archived' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter('archived')}
            role="tab"
            aria-selected={filter === 'archived'}
            data-testid="filter-archived"
          >
            Archived
          </button>
        </div>

        <span
          className="text-muted"
          style={{ fontSize: '12px' }}
          data-testid="bots-count-indicator"
        >
          {isLoading
            ? 'Loading...'
            : `${bots.length} ${filter === 'all' ? '' : `${filter} `}bot${bots.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Bot List / Grid Display */}
      <BotList
        bots={bots}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refresh()}
        onSelectBot={handleSelectBot}
        onEditBot={(bot) => setEditingBot(bot)}
        onArchiveBot={(bot) => setArchivingBot(bot)}
        onUnarchiveBot={(bot) => setUnarchivingBot(bot)}
        onDeleteBot={(bot) => setDeletingBot(bot)}
        emptyTitle={
          filter === 'archived'
            ? 'No archived Bots in this Knowledge Base'
            : filter === 'active'
              ? 'No active Bots in this Knowledge Base'
              : 'No Bots created yet'
        }
        emptyMessage={
          filter === 'archived'
            ? 'You have not archived any Bots in this workspace.'
            : 'Create specialized AI Bots with custom system instructions, model configurations, and analytical tools.'
        }
      />

      {/* Modal Dialogs */}
      <CreateBotModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        createBotFn={createBot}
      />

      <EditBotModal
        isOpen={Boolean(editingBot)}
        bot={editingBot}
        onClose={() => setEditingBot(null)}
        updateBotFn={updateBot}
      />

      <BotArchiveDialog
        isOpen={Boolean(archivingBot)}
        bot={archivingBot}
        onClose={() => setArchivingBot(null)}
        onArchive={archiveBot}
      />

      <BotUnarchiveDialog
        isOpen={Boolean(unarchivingBot)}
        bot={unarchivingBot}
        onClose={() => setUnarchivingBot(null)}
        onUnarchive={unarchiveBot}
      />

      <BotDeleteDialog
        isOpen={Boolean(deletingBot)}
        bot={deletingBot}
        onClose={() => setDeletingBot(null)}
        onDelete={deleteBot}
      />
    </div>
  )
}
