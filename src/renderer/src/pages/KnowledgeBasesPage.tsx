import { ReactElement, useState, useMemo } from 'react'
import {
  FolderPlus,
  Search,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  FolderOpen
} from 'lucide-react'
import { useKnowledgeBases } from '../contexts/KnowledgeBaseContext'
import { KnowledgeBaseCard } from '../components/kb/KnowledgeBaseCard'
import { CreateKnowledgeBaseModal } from '../components/kb/CreateKnowledgeBaseModal'
import { EditKnowledgeBaseModal } from '../components/kb/EditKnowledgeBaseModal'
import { ArchiveKnowledgeBaseDialog } from '../components/kb/ArchiveKnowledgeBaseDialog'
import { DeleteKnowledgeBaseModal } from '../components/kb/DeleteKnowledgeBaseModal'
import type { KnowledgeBaseDto, DeleteKnowledgeBaseResult } from '../../../shared/knowledge-bases'

type FilterStatus = 'all' | 'active' | 'archived'

export function KnowledgeBasesPage(): ReactElement {
  const {
    knowledgeBases,
    activeKnowledgeBaseId,
    loading,
    initialized,
    error,
    selectKnowledgeBase,
    unarchiveKnowledgeBase,
    clearError
  } = useKnowledgeBases()

  // Local UI State
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all')
  const [notification, setNotification] = useState<{
    type: 'success' | 'warning' | 'info'
    message: string
  } | null>(null)

  // Dialog State
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false)
  const [editingKb, setEditingKb] = useState<KnowledgeBaseDto | null>(null)
  const [archivingKb, setArchivingKb] = useState<KnowledgeBaseDto | null>(null)
  const [deletingKb, setDeletingKb] = useState<KnowledgeBaseDto | null>(null)

  // Filtered and searched Knowledge Bases
  const filteredKnowledgeBases = useMemo(() => {
    let list = knowledgeBases

    if (statusFilter === 'active') {
      list = list.filter((kb) => kb.archivedAt === null)
    } else if (statusFilter === 'archived') {
      list = list.filter((kb) => kb.archivedAt !== null)
    }

    const query = searchQuery.trim().toLowerCase()
    if (query) {
      list = list.filter((kb) => {
        const nameMatch = kb.name.toLowerCase().includes(query)
        const descMatch = kb.description ? kb.description.toLowerCase().includes(query) : false
        return nameMatch || descMatch
      })
    }

    return list
  }, [knowledgeBases, statusFilter, searchQuery])

  // Direct unarchive action from card
  const handleUnarchive = async (kb: KnowledgeBaseDto): Promise<void> => {
    try {
      await unarchiveKnowledgeBase(kb.id)
      setNotification({
        type: 'success',
        message: `Knowledge Base "${kb.name}" has been restored to active status.`
      })
    } catch {
      // Error will be reflected in context error
    }
  }

  // Deletion completion handler
  const handleDeleteSuccess = (result: DeleteKnowledgeBaseResult, kbName: string): void => {
    if (result.cleanupPending) {
      setNotification({
        type: 'warning',
        message: `Knowledge Base "${kbName}" was deleted from the database. Operating system storage cleanup is pending.`
      })
    } else {
      setNotification({
        type: 'success',
        message: `Knowledge Base "${kbName}" and all associated files were permanently deleted.`
      })
    }
  }

  return (
    <div className="page-container" data-testid="knowledge-bases-page">
      <header className="page-header">
        <div className="settings-section-header" style={{ paddingBottom: 0, borderBottom: 'none' }}>
          <div className="section-title-group">
            <h1 className="page-title">Knowledge Bases</h1>
            <p className="page-description">
              Organize your documents and shared knowledge in independent workspaces.
            </p>
          </div>
          <div className="section-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setIsCreateOpen(true)}
              data-testid="btn-open-create-kb"
            >
              <FolderPlus size={16} className="inline-icon" aria-hidden="true" /> Create Knowledge
              Base
            </button>
          </div>
        </div>
      </header>

      {/* Notifications */}
      {notification && (
        <div
          className={`section-notification ${
            notification.type === 'success'
              ? 'section-notification-success'
              : notification.type === 'warning'
                ? 'form-alert-warning'
                : 'section-notification-info'
          }`}
          role="status"
          data-testid="kb-dashboard-notification"
        >
          {notification.type === 'success' && (
            <CheckCircle2 size={16} className="inline-icon text-accent" aria-hidden="true" />
          )}
          {notification.type === 'warning' && (
            <AlertTriangle
              size={16}
              className="inline-icon"
              aria-hidden="true"
              style={{ color: '#b45309' }}
            />
          )}
          <span style={{ flex: 1 }}>{notification.message}</span>
          <button
            type="button"
            className="modal-close-button"
            onClick={() => setNotification(null)}
            aria-label="Dismiss notification"
            data-testid="btn-dismiss-notification"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Context Error Banner */}
      {error && (
        <div
          className="section-alert section-alert-error"
          role="alert"
          data-testid="kb-dashboard-error"
        >
          <AlertCircle size={20} className="inline-icon text-danger" aria-hidden="true" />
          <div className="alert-body">
            <strong>Error</strong>
            <span>{error}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm retry-btn"
              onClick={clearError}
              data-testid="btn-clear-error"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Toolbar: Search & Filter Tabs */}
      <section className="kb-toolbar" aria-label="Knowledge Base controls">
        <div className="kb-toolbar-left">
          <div className="kb-search-box">
            <Search size={15} className="kb-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="kb-search-input"
              placeholder="Search knowledge bases..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search knowledge bases by name or description"
              data-testid="input-kb-search"
            />
            {searchQuery && (
              <button
                type="button"
                className="kb-search-clear-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search query"
                data-testid="btn-clear-search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="kb-filter-group" role="tablist" aria-label="Filter by status">
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'all'}
              className={`kb-filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
              data-testid="filter-tab-all"
            >
              All
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'active'}
              className={`kb-filter-btn ${statusFilter === 'active' ? 'active' : ''}`}
              onClick={() => setStatusFilter('active')}
              data-testid="filter-tab-active"
            >
              Active
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'archived'}
              className={`kb-filter-btn ${statusFilter === 'archived' ? 'active' : ''}`}
              onClick={() => setStatusFilter('archived')}
              data-testid="filter-tab-archived"
            >
              Archived
            </button>
          </div>
        </div>
      </section>

      {/* Main Content Area */}
      {loading && !initialized ? (
        <div className="section-loading-state" role="status" data-testid="kb-loading-state">
          <Loader2 size={24} className="spinner inline-icon text-accent" aria-hidden="true" />
          <span>Loading Knowledge Bases...</span>
        </div>
      ) : knowledgeBases.length === 0 ? (
        /* Empty State: Zero Knowledge Bases in Workspace */
        <section className="empty-state-section" aria-label="Knowledge Bases Status">
          <div className="empty-state-card" data-testid="empty-state-no-kbs">
            <FolderOpen
              size={48}
              style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
              aria-hidden="true"
            />
            <h2 className="empty-state-heading">No Knowledge Bases yet</h2>
            <p className="empty-state-text">
              Knowledge Bases organize your project documents, specialized AI Bots, and
              conversations in isolated workspaces. Create your first Knowledge Base for a project,
              research topic, business, or personal notes.
            </p>
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setIsCreateOpen(true)}
                data-testid="btn-empty-create-kb"
              >
                <FolderPlus size={16} className="inline-icon" aria-hidden="true" /> Create Knowledge
                Base
              </button>
            </div>
          </div>
        </section>
      ) : filteredKnowledgeBases.length === 0 ? (
        /* Empty State: Filter or Search yielded 0 results */
        <section className="empty-state-section" aria-label="Filtered Knowledge Bases Status">
          <div className="empty-state-card" data-testid="empty-state-no-results">
            {searchQuery ? (
              <>
                <Search
                  size={40}
                  style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
                  aria-hidden="true"
                />
                <h2 className="empty-state-heading">No matching Knowledge Bases</h2>
                <p className="empty-state-text">
                  No Knowledge Bases match your search query &ldquo;
                  <strong>{searchQuery.trim()}</strong>&rdquo;.
                </p>
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSearchQuery('')}
                    data-testid="btn-reset-search"
                  >
                    Clear Search
                  </button>
                </div>
              </>
            ) : statusFilter === 'archived' ? (
              <>
                <FolderOpen
                  size={40}
                  style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
                  aria-hidden="true"
                />
                <h2 className="empty-state-heading">No archived Knowledge Bases</h2>
                <p className="empty-state-text">
                  You have not archived any Knowledge Bases. Archived workspaces will appear here.
                </p>
              </>
            ) : (
              <>
                <FolderOpen
                  size={40}
                  style={{ color: '#94a3b8', margin: '0 auto 12px auto' }}
                  aria-hidden="true"
                />
                <h2 className="empty-state-heading">No active Knowledge Bases</h2>
                <p className="empty-state-text">All your Knowledge Bases are currently archived.</p>
              </>
            )}
          </div>
        </section>
      ) : (
        /* Knowledge Base Grid */
        <section className="kb-grid" aria-label="Knowledge Bases collection" data-testid="kb-grid">
          {filteredKnowledgeBases.map((kb) => (
            <KnowledgeBaseCard
              key={kb.id}
              knowledgeBase={kb}
              isActiveWorkspace={activeKnowledgeBaseId === kb.id}
              onSelectWorkspace={selectKnowledgeBase}
              onEdit={(targetKb) => setEditingKb(targetKb)}
              onArchive={(targetKb) => setArchivingKb(targetKb)}
              onUnarchive={handleUnarchive}
              onDelete={(targetKb) => setDeletingKb(targetKb)}
            />
          ))}
        </section>
      )}

      {/* Modals */}
      <CreateKnowledgeBaseModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(created) => {
          setNotification({
            type: 'success',
            message: `Knowledge Base "${created.name}" created successfully.`
          })
        }}
      />

      {editingKb && (
        <EditKnowledgeBaseModal
          key={editingKb.id}
          isOpen={true}
          knowledgeBase={editingKb}
          onClose={() => setEditingKb(null)}
          onSuccess={(updated) => {
            setNotification({
              type: 'success',
              message: `Knowledge Base "${updated.name}" updated successfully.`
            })
          }}
        />
      )}

      {archivingKb && (
        <ArchiveKnowledgeBaseDialog
          key={archivingKb.id}
          isOpen={true}
          knowledgeBase={archivingKb}
          isActiveWorkspace={activeKnowledgeBaseId === archivingKb.id}
          onClose={() => setArchivingKb(null)}
          onSuccess={(archived) => {
            setNotification({
              type: 'info',
              message: `Knowledge Base "${archived.name}" has been archived.`
            })
          }}
        />
      )}

      {deletingKb && (
        <DeleteKnowledgeBaseModal
          key={deletingKb.id}
          isOpen={true}
          knowledgeBase={deletingKb}
          onClose={() => setDeletingKb(null)}
          onSuccess={handleDeleteSuccess}
        />
      )}
    </div>
  )
}
