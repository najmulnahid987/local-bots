import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  WorkspaceFolderService,
  type WorkspaceDialogOperations,
  type BrowserWindowLike
} from './workspace-folder-service'
import { WorkspaceSecurityError } from '../security/workspace-path-guard'
import type { OpenDialogReturnValue } from 'electron'

describe('WorkspaceFolderService (Phase 8 Step 8.3)', () => {
  let tempDir: string
  let canonicalTempDir: string
  let mockWindow: BrowserWindowLike
  let mockDialogOps: WorkspaceDialogOperations
  let service: WorkspaceFolderService

  const agentRunId1 = 'run-1111-aaaa'
  const agentRunId2 = 'run-2222-bbbb'
  const botId1 = 'bot-1111-aaaa'
  const botId2 = 'bot-2222-bbbb'

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-folder-test-'))
    canonicalTempDir = fs.realpathSync.native(tempDir)

    mockWindow = {
      isDestroyed: vi.fn(() => false)
    }

    mockDialogOps = {
      showOpenDialog: vi.fn(
        async () =>
          ({
            canceled: false,
            filePaths: [tempDir]
          }) as OpenDialogReturnValue
      )
    }

    service = new WorkspaceFolderService({ dialogOps: mockDialogOps })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on busy locks
    }
  })

  it('1. successfully authorizes workspace folder via native dialog', async () => {
    const result = await service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)

    expect(result.status).toBe('authorized')
    if (result.status === 'authorized') {
      expect(result.agentRunId).toBe(agentRunId1)
      expect(result.botId).toBe(botId1)
    }

    expect(service.hasGrant(agentRunId1, botId1)).toBe(true)
    const approvedRoot = service.getApprovedRoot(agentRunId1, botId1)
    expect(approvedRoot).toBe(canonicalTempDir)
  })

  it('2. returns cancelled status when user cancels native dialog', async () => {
    mockDialogOps.showOpenDialog = vi.fn(
      async () =>
        ({
          canceled: true,
          filePaths: []
        }) as OpenDialogReturnValue
    )

    const result = await service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)

    expect(result.status).toBe('cancelled')
    expect(service.hasGrant(agentRunId1, botId1)).toBe(false)
  })

  it('3. rejects authorization when selected path does not exist on disk', async () => {
    mockDialogOps.showOpenDialog = vi.fn(
      async () =>
        ({
          canceled: false,
          filePaths: [path.join(tempDir, 'non-existent-subfolder')]
        }) as OpenDialogReturnValue
    )

    await expect(
      service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)
    ).rejects.toThrow(WorkspaceSecurityError)
  })

  it('4. rejects authorization when window is missing or destroyed', async () => {
    await expect(service.requestWorkspaceAuthorization(null, agentRunId1, botId1)).rejects.toThrow(
      'Active BrowserWindow is required'
    )

    mockWindow.isDestroyed = vi.fn(() => true)
    await expect(
      service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)
    ).rejects.toThrow('window has been destroyed')
  })

  it('5. enforces run-specific and bot-specific isolation (grant cannot be reused across runs or bots)', async () => {
    await service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)

    // Same run, correct bot -> OK
    expect(service.getApprovedRoot(agentRunId1, botId1)).toBe(canonicalTempDir)

    // Same run, wrong bot -> Throws
    expect(() => service.getApprovedRoot(agentRunId1, botId2)).toThrow(
      'Workspace authorization mismatch: Bot does not match the authorized grant.'
    )

    // Different run -> Throws
    expect(() => service.getApprovedRoot(agentRunId2, botId1)).toThrow(
      'No active workspace authorization found for this agent run.'
    )
  })

  it('6. revokes and clears grants deterministically', async () => {
    await service.requestWorkspaceAuthorization(mockWindow, agentRunId1, botId1)
    expect(service.hasGrant(agentRunId1, botId1)).toBe(true)

    // Revoke run 1
    const revoked = service.revoke(agentRunId1)
    expect(revoked).toBe(true)
    expect(service.hasGrant(agentRunId1, botId1)).toBe(false)

    // Authorize run 2 and clear all
    await service.requestWorkspaceAuthorization(mockWindow, agentRunId2, botId2)
    expect(service.hasGrant(agentRunId2, botId2)).toBe(true)

    service.clear()
    expect(service.hasGrant(agentRunId2, botId2)).toBe(false)
  })
})
