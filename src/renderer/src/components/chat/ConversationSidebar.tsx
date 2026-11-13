import { ReactElement, useState, KeyboardEvent } from 'react'
import { Plus, RotateCw, MessageSquare, Loader2, Pencil, Trash2 } from 'lucide-react'
import type { ConversationDto, DeleteConversationResultDto } from '../../../../shared/conversations'
import type { BotDto } from '../../../../shared/bots'
import { formatTimestamp } from '../../utils/formatters'
import { DeleteConversationDialog } from './DeleteConversationDialog'

export interface ConversationSidebarProps {
  readonly bot: BotDto
  readonly conversations: readonly ConversationDto[]
  readonly selectedConversationId: string | null
  readonly onSelectConversation: (id: string) => void
  readonly onCreateConversation: (title?: string) => Promise<ConversationDto>
  readonly onRenameConversation?: (
    conversationId: string,
    title: string
  ) => Promise<ConversationDto>
  readonly onDeleteConversation?: (conversationId: string) => Promise<DeleteConversationResultDto>
  readonly isGenerating?: boolean
  readonly isLoading: boolean
  readonly isRefreshing: boolean
  readonly isMutating: boolean
  readonly error: string | null
  readonly onRefresh: () => void
}

export function ConversationSidebar({
  bot,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
  isGenerating = false,
  isLoading,
  isRefreshing,
  isMutating,
  error,
  onRefresh
}: ConversationSidebarProps): ReactElement {
  const isArchived = bot.status === 'archived'
  const [isCreatingInline, setIsCreatingInline] = useState<boolean>(false)
  const [newTitle, setNewTitle] = useState<string>('')

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState<string>('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState<boolean>(false)

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<ConversationDto | null>(null)

  const handleCreate = async (): Promise<void> => {
    try {
      const titleToUse = newTitle.trim() || undefined
      await onCreateConversation(titleToUse)
      setNewTitle('')
      setIsCreatingInline(false)
    } catch {
      // Handled by parent error state
    }
  }

  const handleCreateKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      void handleCreate()
    } else if (e.key === 'Escape') {
      setIsCreatingInline(false)
      setNewTitle('')
    }
  }

  const handleSaveRename = async (conversationId: string): Promise<void> => {
    if (!onRenameConversation || isRenaming) return
    const trimmed = editTitle.trim()
    if (!trimmed) {
      setRenameError('Conversation title cannot be blank.')
      return
    }
    if (trimmed.length > 200) {
      setRenameError('Conversation title cannot exceed 200 characters.')
      return
    }

    setIsRenaming(true)
    setRenameError(null)

    try {
      await onRenameConversation(conversationId, trimmed)
      setEditingId(null)
      setEditTitle('')
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err)
      setRenameError(
        rawMsg
          .replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
          .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
          .replace(
            /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            '[REDACTED_REF]'
          )
      )
    } finally {
      setIsRenaming(false)
    }
  }

  return (
    <aside
      className="chat-sidebar"
      data-testid="conversations-sidebar"
      aria-label="Conversation Threads"
      style={{
        width: '280px',
        minWidth: '240px',
        maxWidth: '320px',
        borderRight: '1px solid var(--color-border, #e2e8f0)',
        backgroundColor: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        userSelect: 'none'
      }}
    >
      {/* Sidebar Header / Actions */}
      <div
        className="chat-sidebar-header"
        style={{
          padding: '16px',
          borderBottom: '1px solid var(--color-border, #f1f5f9)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <MessageSquare size={16} className="text-accent inline-icon" aria-hidden="true" />
            <h3
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--color-text-primary, #0f172a)',
                margin: 0
              }}
            >
              Conversations
            </h3>
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onRefresh}
              disabled={isRefreshing || isArchived}
              data-testid="refresh-conversations-btn"
              title="Refresh conversations"
              aria-label="Refresh conversations"
              style={{ padding: '5px 8px' }}
            >
              <RotateCw
                size={13}
                className={`inline-icon ${isRefreshing ? 'spinner' : ''}`}
                aria-hidden="true"
              />
            </button>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setIsCreatingInline(true)}
              disabled={isMutating || isArchived}
              data-testid="create-conversation-btn"
              title="New Conversation"
              aria-label="New Conversation"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '5px 10px',
                fontSize: '12px'
              }}
            >
              <Plus size={14} className="inline-icon" aria-hidden="true" />
              <span>New</span>
            </button>
          </div>
        </div>

        {/* Inline Create Form */}
        {isCreatingInline && (
          <div
            className="chat-sidebar-inline-create"
            data-testid="inline-create-form"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '10px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #cbd5e1'
            }}
          >
            <input
              type="text"
              className="form-input"
              data-testid="new-conversation-title-input"
              aria-label="New conversation title"
              placeholder="Conversation title (optional)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={handleCreateKeyDown}
              autoFocus
              style={{ fontSize: '12.5px', padding: '6px 8px' }}
            />
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setIsCreatingInline(false)
                  setNewTitle('')
                }}
                data-testid="cancel-create-btn"
                style={{ fontSize: '11.5px', padding: '3px 8px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleCreate()}
                disabled={isMutating}
                data-testid="confirm-create-btn"
                style={{ fontSize: '11.5px', padding: '3px 10px' }}
              >
                {isMutating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {/* Sidebar Error State */}
        {error && (
          <div
            className="section-alert section-alert-error"
            role="alert"
            data-testid="conversations-error-alert"
            style={{ fontSize: '11.5px', padding: '8px', margin: 0 }}
          >
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Conversations List / Scrollable Container */}
      <div
        className="chat-sidebar-list-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px'
        }}
      >
        {isLoading && conversations.length === 0 ? (
          <div
            className="section-loading-state"
            role="status"
            data-testid="conversations-loading"
            style={{ padding: '24px 0', fontSize: '12px' }}
          >
            <Loader2 size={16} className="spinner inline-icon text-accent" aria-hidden="true" />
            <span>Loading threads...</span>
          </div>
        ) : conversations.length === 0 ? (
          <div
            className="chat-sidebar-empty"
            data-testid="conversations-empty-state"
            style={{
              padding: '24px 12px',
              textAlign: 'center',
              color: 'var(--color-text-secondary, #94a3b8)'
            }}
          >
            <MessageSquare
              size={24}
              style={{ margin: '0 auto 8px auto', opacity: 0.6 }}
              aria-hidden="true"
            />
            <h4
              style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 4px 0', color: '#475569' }}
            >
              No conversations
            </h4>
            <p style={{ fontSize: '11.5px', margin: 0, lineHeight: 1.4 }}>
              Start a new conversation thread with {bot.name}.
            </p>
          </div>
        ) : (
          <ul
            className="chat-threads-list"
            data-testid="conversations-list"
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '4px'
            }}
          >
            {conversations.map((c) => {
              const isSelected = c.id === selectedConversationId
              const isEditing = editingId === c.id
              const timestampStr =
                c.updatedAt || c.createdAt ? formatTimestamp(c.updatedAt || c.createdAt) : ''

              if (isEditing) {
                return (
                  <li key={c.id}>
                    <div
                      className="chat-thread-item-rename"
                      data-testid={`rename-form-${c.id}`}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        backgroundColor: '#f8fafc',
                        border: '1px solid #3b82f6',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        className="form-input form-input-sm"
                        data-testid={`rename-input-${c.id}`}
                        aria-label="Edit conversation title"
                        value={editTitle}
                        onChange={(e) => {
                          setEditTitle(e.target.value)
                          setRenameError(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void handleSaveRename(c.id)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditingId(null)
                            setRenameError(null)
                          }
                        }}
                        autoFocus
                        maxLength={200}
                        disabled={isRenaming}
                        style={{ fontSize: '12px', padding: '4px 6px' }}
                      />
                      {renameError && (
                        <span
                          className="text-danger"
                          style={{ fontSize: '11px', lineHeight: '1.3' }}
                          data-testid={`rename-error-${c.id}`}
                          role="alert"
                        >
                          {renameError}
                        </span>
                      )}
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          data-testid={`cancel-rename-btn-${c.id}`}
                          onClick={() => {
                            setEditingId(null)
                            setRenameError(null)
                          }}
                          disabled={isRenaming}
                          style={{ fontSize: '11px', padding: '2px 8px' }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          data-testid={`save-rename-btn-${c.id}`}
                          onClick={() => void handleSaveRename(c.id)}
                          disabled={isRenaming}
                          style={{ fontSize: '11px', padding: '2px 10px' }}
                        >
                          {isRenaming ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </li>
                )
              }

              return (
                <li key={c.id}>
                  <div
                    className={`chat-thread-item-wrapper ${isSelected ? 'selected' : ''}`}
                    style={{ position: 'relative' }}
                  >
                    <button
                      type="button"
                      className={`chat-thread-item ${isSelected ? 'selected' : ''}`}
                      data-testid={`conversation-item-${c.id}`}
                      aria-selected={isSelected}
                      onClick={() => onSelectConversation(c.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        paddingRight: '64px',
                        borderRadius: '8px',
                        backgroundColor: isSelected
                          ? 'var(--color-sidebar-active, #eff6ff)'
                          : 'transparent',
                        border: isSelected ? '1px solid #3b82f6' : '1px solid transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                        transition: 'background-color 120ms ease, border-color 120ms ease'
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '6px'
                        }}
                      >
                        <span
                          className="chat-thread-title"
                          data-testid={`conversation-title-${c.id}`}
                          style={{
                            fontSize: '13px',
                            fontWeight: isSelected ? 600 : 500,
                            color: isSelected ? '#1e40af' : 'var(--color-text-primary, #0f172a)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                          title={c.title}
                        >
                          {c.title}
                        </span>
                      </div>

                      {timestampStr && (
                        <span
                          className="chat-thread-time"
                          style={{
                            fontSize: '11px',
                            color: isSelected ? '#3b82f6' : 'var(--color-text-secondary, #94a3b8)'
                          }}
                        >
                          {timestampStr}
                        </span>
                      )}
                    </button>

                    {/* Rename & Delete Action Buttons */}
                    <div
                      className="chat-thread-actions"
                      style={{
                        position: 'absolute',
                        right: '8px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '2px'
                      }}
                    >
                      {onRenameConversation && (
                        <button
                          type="button"
                          className="btn-icon chat-thread-action-btn"
                          data-testid={`rename-conversation-btn-${c.id}`}
                          aria-label={`Rename ${c.title}`}
                          title="Rename conversation"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(c.id)
                            setEditTitle(c.title)
                            setRenameError(null)
                          }}
                          disabled={isArchived}
                          style={{
                            padding: '4px',
                            borderRadius: '4px',
                            border: 'none',
                            background: 'transparent',
                            color: isArchived ? '#cbd5e1' : '#64748b',
                            cursor: isArchived ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                      )}

                      {onDeleteConversation && (
                        <button
                          type="button"
                          className="btn-icon chat-thread-action-btn chat-thread-delete-btn"
                          data-testid={`delete-conversation-btn-${c.id}`}
                          aria-label={`Delete ${c.title}`}
                          title={
                            isGenerating && isSelected
                              ? 'Cannot delete conversation while generating'
                              : 'Delete conversation'
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget(c)
                          }}
                          disabled={isGenerating && isSelected}
                          style={{
                            padding: '4px',
                            borderRadius: '4px',
                            border: 'none',
                            background: 'transparent',
                            color: isGenerating && isSelected ? '#cbd5e1' : '#ef4444',
                            cursor: isGenerating && isSelected ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <DeleteConversationDialog
          isOpen={Boolean(deleteTarget)}
          conversation={deleteTarget}
          isGenerating={isGenerating && selectedConversationId === deleteTarget.id}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (id) => {
            if (onDeleteConversation) {
              await onDeleteConversation(id)
            }
            setDeleteTarget(null)
          }}
        />
      )}
    </aside>
  )
}
