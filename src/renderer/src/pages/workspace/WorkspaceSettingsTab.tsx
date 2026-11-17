import { ReactElement, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Settings, Clock, HardDrive, KeyRound, FolderArchive, Download, Upload } from 'lucide-react'
import type { WorkspaceOutletContext } from './WorkspaceOverviewTab'
import { ExportKnowledgeBaseModal } from '../../components/kb/ExportKnowledgeBaseModal'
import { ImportKnowledgeBaseModal } from '../../components/kb/ImportKnowledgeBaseModal'

export function WorkspaceSettingsTab(): ReactElement {
  const { knowledgeBase } = useOutletContext<WorkspaceOutletContext>()
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false)

  const formattedCreated = new Date(knowledgeBase.createdAt).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  const formattedUpdated = new Date(knowledgeBase.updatedAt).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <div className="workspace-tab-panel" data-testid="workspace-settings-tab">
      <div className="workspace-panel-header">
        <h2 className="workspace-panel-title">Workspace Settings</h2>
        <p className="workspace-panel-subtitle">
          Basic information and storage configuration for this Knowledge Base.
        </p>
      </div>

      <div className="workspace-settings-card">
        <div className="settings-section-header">
          <Settings size={18} className="text-secondary" aria-hidden="true" />
          <h3 className="settings-section-title">Knowledge Base Metadata</h3>
        </div>

        <dl className="settings-metadata-list">
          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Workspace Name</dt>
            <dd className="settings-metadata-val" data-testid="settings-val-name">
              {knowledgeBase.name}
            </dd>
          </div>

          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Description</dt>
            <dd className="settings-metadata-val" data-testid="settings-val-description">
              {knowledgeBase.description || 'No description provided'}
            </dd>
          </div>

          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Workspace Identifier</dt>
            <dd className="settings-metadata-val font-mono text-sm" data-testid="settings-val-id">
              <KeyRound size={12} className="inline-icon text-secondary" aria-hidden="true" />{' '}
              {knowledgeBase.id}
            </dd>
          </div>

          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Storage Directory</dt>
            <dd
              className="settings-metadata-val font-mono text-sm"
              data-testid="settings-val-storage"
            >
              <HardDrive size={12} className="inline-icon text-secondary" aria-hidden="true" />{' '}
              documents/{knowledgeBase.id}
            </dd>
          </div>

          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Created At</dt>
            <dd className="settings-metadata-val text-sm" data-testid="settings-val-created">
              <Clock size={12} className="inline-icon text-secondary" aria-hidden="true" />{' '}
              {formattedCreated}
            </dd>
          </div>

          <div className="settings-metadata-row">
            <dt className="settings-metadata-key">Last Updated</dt>
            <dd className="settings-metadata-val text-sm" data-testid="settings-val-updated">
              <Clock size={12} className="inline-icon text-secondary" aria-hidden="true" />{' '}
              {formattedUpdated}
            </dd>
          </div>
        </dl>
      </div>

      <div
        className="workspace-settings-card"
        style={{ marginTop: '16px' }}
        data-testid="settings-card-export"
      >
        <div className="settings-section-header">
          <FolderArchive size={18} className="text-secondary" aria-hidden="true" />
          <h3 className="settings-section-title">Export & Portability</h3>
        </div>

        <p className="text-sm text-secondary" style={{ marginTop: '8px', lineHeight: 1.5 }}>
          Export this Knowledge Base, its Bots, saved memories, documents, and conversations into a
          portable ZIP archive (<code>.voyaro-kb.zip</code>). All API keys and machine paths are
          strictly excluded.
        </p>

        <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setIsExportModalOpen(true)}
            data-testid="btn-open-export-kb"
          >
            <Download size={14} className="inline-icon" aria-hidden="true" />
            <span>Export Knowledge Base</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setIsImportModalOpen(true)}
            data-testid="btn-open-import-kb-workspace"
          >
            <Upload size={14} className="inline-icon" aria-hidden="true" />
            <span>Import / Restore Archive</span>
          </button>
        </div>
      </div>

      <ExportKnowledgeBaseModal
        isOpen={isExportModalOpen}
        knowledgeBase={knowledgeBase}
        onClose={() => setIsExportModalOpen(false)}
      />

      <ImportKnowledgeBaseModal
        isOpen={isImportModalOpen}
        defaultTargetKnowledgeBaseId={knowledgeBase.id}
        onClose={() => setIsImportModalOpen(false)}
      />
    </div>
  )
}
