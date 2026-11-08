import { ReactElement } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { KnowledgeBaseProvider } from './contexts/KnowledgeBaseContext'
import { AppLayout } from './components/layout/AppLayout'
import { HomePage } from './pages/HomePage'
import { KnowledgeBasesPage } from './pages/KnowledgeBasesPage'
import { ActivityPage } from './pages/ActivityPage'
import { SettingsPage } from './pages/SettingsPage'
import { KnowledgeBaseWorkspaceLayout } from './components/kb/KnowledgeBaseWorkspaceLayout'
import { WorkspaceOverviewTab } from './pages/workspace/WorkspaceOverviewTab'
import { WorkspaceKnowledgeTab } from './pages/workspace/WorkspaceKnowledgeTab'
import { WorkspaceBotsTab } from './pages/workspace/WorkspaceBotsTab'
import { WorkspaceActivityTab } from './pages/workspace/WorkspaceActivityTab'
import { WorkspaceSettingsTab } from './pages/workspace/WorkspaceSettingsTab'

export default function App(): ReactElement {
  return (
    <HashRouter>
      <KnowledgeBaseProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/knowledge-bases" element={<KnowledgeBasesPage />} />
            <Route path="/knowledge-bases/:kbId" element={<KnowledgeBaseWorkspaceLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<WorkspaceOverviewTab />} />
              <Route path="knowledge" element={<WorkspaceKnowledgeTab />} />
              <Route path="bots" element={<WorkspaceBotsTab />} />
              <Route path="activity" element={<WorkspaceActivityTab />} />
              <Route path="settings" element={<WorkspaceSettingsTab />} />
            </Route>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Route>
        </Routes>
      </KnowledgeBaseProvider>
    </HashRouter>
  )
}
