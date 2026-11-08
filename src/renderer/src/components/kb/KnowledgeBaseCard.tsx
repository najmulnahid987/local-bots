import { ReactElement } from 'react'
import { Edit3, Archive, ArchiveRestore, Trash2, Check, Clock, FolderOpen } from 'lucide-react'
import type { KnowledgeBaseDto } from '../../../../shared/knowledge-bases'

export interface KnowledgeBaseCardProps {
  readonly knowledgeBase: KnowledgeBaseDto
  readonly isActiveWorkspace: boolean
  readonly onOpenWorkspace: (id: string) => void
  readonly onSelectWorkspace?: (id: string) => void
  readonly onEdit: (kb: KnowledgeBaseDto) => void
  readonly onArchive: (kb: KnowledgeBaseDto) => void
  readonly onUnarchive: (kb: KnowledgeBaseDto) => void
  readonly onDelete: (kb: KnowledgeBaseDto) => void
}

export function KnowledgeBaseCard({
  knowledgeBase,
  isActiveWorkspace,
  onOpenWorkspace,
  onSelectWorkspace,
  onEdit,
  onArchive,
  onUnarchive,
  onDelete
}: KnowledgeBaseCardProps): ReactElement {
  const isArchived = knowledgeBase.archivedAt !== null

  const formattedCreated = new Date(knowledgeBase.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })

  const formattedUpdated = new Date(knowledgeBase.updatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })

  return (
    <article
      className={`kb-card ${isActiveWorkspace ? 'kb-card-active-workspace' : ''} ${
        isArchived ? 'kb-card-archived' : ''
      }`}
      aria-label={`Knowledge Base: ${knowledgeBase.name}`}
      data-testid={`kb-card-${knowledgeBase.id}`}
    >
      <header className="kb-card-header">
        <div className="kb-card-title-group">
          <h3 className="kb-card-title" title={knowledgeBase.name}>
            {knowledgeBase.name}
          </h3>
          <div className="kb-card-badges">
            {isArchived ? (
              <span
                className="status-badge status-badge-revoked"
                data-testid={`badge-archived-${knowledgeBase.id}`}
              >
                Archived
              </span>
            ) : (
              <span
                className="status-badge status-badge-active"
                data-testid={`badge-active-${knowledgeBase.id}`}
              >
                Active
              </span>
            )}
            {isActiveWorkspace && (
              <span
                className="status-badge status-badge-active"
                data-testid={`badge-current-workspace-${knowledgeBase.id}`}
              >
                <Check size={12} className="inline-icon" aria-hidden="true" /> Current Workspace
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="kb-card-body">
        {knowledgeBase.description ? (
          <p className="kb-card-description">{knowledgeBase.description}</p>
        ) : (
          <p className="kb-card-description empty">No description provided.</p>
        )}
      </div>

      <footer className="kb-card-footer">
        <div className="kb-card-meta">
          <span title={`Created on ${formattedCreated}`}>Created {formattedCreated}</span>
          <span title={`Last updated on ${formattedUpdated}`}>
            <Clock size={11} className="inline-icon" aria-hidden="true" /> Updated{' '}
            {formattedUpdated}
          </span>
        </div>

        <div className="kb-card-actions">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {!isArchived && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  onOpenWorkspace(knowledgeBase.id)
                  onSelectWorkspace?.(knowledgeBase.id)
                }}
                aria-label={`Open ${knowledgeBase.name} workspace`}
                data-testid={`btn-open-workspace-${knowledgeBase.id}`}
              >
                <FolderOpen size={14} className="inline-icon" aria-hidden="true" /> Open Workspace
              </button>
            )}
            {isActiveWorkspace && (
              <span
                className="text-secondary text-sm"
                data-testid={`active-label-${knowledgeBase.id}`}
              >
                Active Workspace
              </span>
            )}
          </div>

          <div className="kb-card-actions-right">
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-icon"
              onClick={() => onEdit(knowledgeBase)}
              aria-label={`Edit ${knowledgeBase.name}`}
              data-testid={`btn-edit-kb-${knowledgeBase.id}`}
              title="Edit Knowledge Base"
            >
              <Edit3 size={14} aria-hidden="true" />
            </button>

            {isArchived ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-icon"
                onClick={() => onUnarchive(knowledgeBase)}
                aria-label={`Restore ${knowledgeBase.name}`}
                data-testid={`btn-unarchive-kb-${knowledgeBase.id}`}
                title="Restore Knowledge Base"
              >
                <ArchiveRestore size={14} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-icon"
                onClick={() => onArchive(knowledgeBase)}
                aria-label={`Archive ${knowledgeBase.name}`}
                data-testid={`btn-archive-kb-${knowledgeBase.id}`}
                title="Archive Knowledge Base"
              >
                <Archive size={14} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className="btn btn-danger-outline btn-sm btn-icon"
              onClick={() => onDelete(knowledgeBase)}
              aria-label={`Delete ${knowledgeBase.name}`}
              data-testid={`btn-delete-kb-${knowledgeBase.id}`}
              title="Delete Knowledge Base"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </footer>
    </article>
  )
}
