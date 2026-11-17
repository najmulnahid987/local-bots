import { ReactElement, useState, useCallback } from 'react'
import { Plus, RefreshCw, Brain, AlertTriangle, CheckCircle2, X } from 'lucide-react'
import type { BotDto } from '../../../../../shared/bots'
import type { BotMemoryDto, BotMemoryType } from '../../../../../shared/bot-memories'
import { useBotMemories } from '../../../hooks/useBotMemories'
import { BotMemoryUsageIndicator } from './BotMemoryUsageIndicator'
import { BotMemoryList } from './BotMemoryList'
import { BotMemoryEditor } from './BotMemoryEditor'
import { BotMemoryDeleteDialog } from './BotMemoryDeleteDialog'

export interface BotMemorySectionProps {
  readonly bot: BotDto
  readonly isArchived?: boolean
}

interface NotificationState {
  readonly type: 'success' | 'error'
  readonly message: string
}

export function BotMemorySection({ bot, isArchived = false }: BotMemorySectionProps): ReactElement {
  const botIsArchived = isArchived || bot.status === 'archived'

  const {
    memories,
    isLoading,
    error,
    isMutating,
    totalEstimatedTokens,
    pinnedCount,
    noteCount,
    refresh,
    createMemory,
    updateMemory,
    deleteMemory
  } = useBotMemories({ botId: bot.id })

  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false)
  const [editingMemory, setEditingMemory] = useState<BotMemoryDto | null>(null)

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState<boolean>(false)
  const [deletingMemory, setDeletingMemory] = useState<BotMemoryDto | null>(null)

  const [notification, setNotification] = useState<NotificationState | null>(null)

  const showNotification = useCallback((type: 'success' | 'error', message: string) => {
    setNotification({ type, message })
    setTimeout(() => {
      setNotification((curr) => (curr?.message === message ? null : curr))
    }, 4000)
  }, [])

  // Create or Update
  const handleSaveMemory = async (values: {
    memoryType: BotMemoryType
    content: string
  }): Promise<void> => {
    try {
      if (editingMemory) {
        await updateMemory(editingMemory.id, values)
        showNotification('success', 'Memory updated successfully.')
      } else {
        await createMemory({
          memoryType: values.memoryType,
          content: values.content
        })
        showNotification('success', 'Memory created successfully.')
      }
      setIsEditorOpen(false)
      setEditingMemory(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save memory.'
      showNotification('error', msg)
      throw err
    }
  }

  // Delete
  const handleConfirmDelete = async (memoryId: string): Promise<void> => {
    try {
      await deleteMemory(memoryId)
      showNotification('success', 'Memory deleted.')
      setIsDeleteDialogOpen(false)
      setDeletingMemory(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete memory.'
      showNotification('error', msg)
      throw err
    }
  }

  // Pin toggle
  const handleTogglePin = async (memory: BotMemoryDto): Promise<void> => {
    try {
      const newType: BotMemoryType =
        memory.memoryType === 'pinned_instruction' ? 'user_note' : 'pinned_instruction'
      const updated = await updateMemory(memory.id, { memoryType: newType })
      const isNowPinned = updated.memoryType === 'pinned_instruction'
      showNotification(
        'success',
        isNowPinned
          ? 'Memory pinned as high-priority instruction.'
          : 'Memory unpinned to user note.'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to toggle pin state.'
      showNotification('error', msg)
    }
  }

  const handleCreateNew = (): void => {
    setEditingMemory(null)
    setIsEditorOpen(true)
  }

  const handleEdit = (memory: BotMemoryDto): void => {
    setEditingMemory(memory)
    setIsEditorOpen(true)
  }

  const handleDeletePrompt = (memory: BotMemoryDto): void => {
    setDeletingMemory(memory)
    setIsDeleteDialogOpen(true)
  }

  return (
    <div
      className="bot-memory-section"
      data-testid="bot-memory-section"
      style={{
        padding: '20px 24px',
        maxWidth: '900px',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box'
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
          gap: '16px',
          flexWrap: 'wrap'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '8px',
              backgroundColor: '#eef2ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#4f46e5'
            }}
          >
            <Brain size={20} aria-hidden="true" />
          </div>
          <div>
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 700,
                color: '#0f172a',
                margin: 0
              }}
              data-testid="bot-memory-title"
            >
              {bot.name} &mdash; Memories
            </h2>
            <p style={{ fontSize: '12.5px', color: '#64748b', margin: '2px 0 0 0' }}>
              Persistent context and instructions recalled automatically during AI conversations.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={refresh}
            disabled={isLoading || isMutating}
            data-testid="btn-refresh-memories"
            title="Refresh memories"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          {!botIsArchived && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleCreateNew}
              disabled={isMutating}
              data-testid="btn-add-memory"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}
            >
              <Plus size={15} />
              <span>Add Memory</span>
            </button>
          )}
        </div>
      </div>

      {/* Archived Warning Banner */}
      {botIsArchived && (
        <div
          className="section-alert section-alert-warning"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            backgroundColor: '#fffbeb',
            border: '1px solid #fef3c7',
            borderRadius: '8px',
            color: '#b45309',
            fontSize: '13px',
            marginBottom: '16px'
          }}
          data-testid="bot-archived-memory-warning"
        >
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>
            This Bot is archived. Existing memories can be reviewed, but new memories cannot be
            added or modified while archived.
          </span>
        </div>
      )}

      {/* Transient Notification Banner */}
      {notification && (
        <div
          role="status"
          data-testid="memory-action-notification"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '10px 14px',
            backgroundColor: notification.type === 'success' ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${notification.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: '8px',
            color: notification.type === 'success' ? '#166534' : '#991b1b',
            fontSize: '13px',
            marginBottom: '16px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {notification.type === 'success' ? (
              <CheckCircle2 size={16} style={{ color: '#16a34a', flexShrink: 0 }} />
            ) : (
              <AlertTriangle size={16} style={{ color: '#dc2626', flexShrink: 0 }} />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotification(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              padding: 0,
              display: 'flex'
            }}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Usage Indicator */}
      <BotMemoryUsageIndicator
        totalEstimatedTokens={totalEstimatedTokens}
        pinnedCount={pinnedCount}
        noteCount={noteCount}
      />

      {/* Memory List */}
      <BotMemoryList
        memories={memories}
        isLoading={isLoading}
        error={error}
        onRefresh={refresh}
        onEdit={handleEdit}
        onDelete={handleDeletePrompt}
        onTogglePin={handleTogglePin}
        onCreateNew={handleCreateNew}
        isMutating={isMutating}
        isArchived={botIsArchived}
      />

      {/* Editor Modal */}
      <BotMemoryEditor
        isOpen={isEditorOpen}
        botId={bot.id}
        memory={editingMemory}
        onClose={() => {
          setIsEditorOpen(false)
          setEditingMemory(null)
        }}
        onSave={handleSaveMemory}
        isSubmitting={isMutating}
      />

      {/* Delete Confirmation Dialog */}
      <BotMemoryDeleteDialog
        isOpen={isDeleteDialogOpen}
        memory={deletingMemory}
        onClose={() => {
          setIsDeleteDialogOpen(false)
          setDeletingMemory(null)
        }}
        onConfirm={handleConfirmDelete}
        isDeleting={isMutating}
      />
    </div>
  )
}
