import { ReactElement } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function AppLayout(): ReactElement {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-viewport" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
