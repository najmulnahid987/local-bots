import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { createKnowledgeBaseFixture } from '../database/testing/fixtures'
import { ActiveWorkspaceContext } from './active-workspace-context'
import { NoActiveWorkspaceError, BotManagerError, BotValidationError } from './bot-errors'

describe('ActiveWorkspaceContext (Step 6.2)', () => {
  let testCtx: MigratedTestDatabaseContext
  let activeContext: ActiveWorkspaceContext

  beforeEach(() => {
    testCtx = createMigratedTestDatabase()
    activeContext = new ActiveWorkspaceContext({ kbRepo: testCtx.kbRepo })
  })

  afterEach(() => {
    activeContext.clearAll()
    testCtx.cleanup()
  })

  it('1. activating an existing active KB succeeds and returns the KB entity', () => {
    const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Active Project KB' })
    const session1 = 101

    const result = activeContext.activateWorkspace(session1, kb.id)

    expect(result.id).toBe(kb.id)
    expect(result.name).toBe('Active Project KB')
    expect(activeContext.getActiveWorkspaceId(session1)).toBe(kb.id)
    expect(activeContext.hasActiveWorkspace(session1)).toBe(true)
  })

  it('2. activating a nonexistent KB fails with KB_NOT_FOUND', () => {
    const nonexistentId = '99999999-9999-4999-8999-999999999999'

    expect(() => activeContext.activateWorkspace(102, nonexistentId)).toThrow(BotManagerError)

    try {
      activeContext.activateWorkspace(102, nonexistentId)
    } catch (err) {
      expect(err).toBeInstanceOf(BotManagerError)
      expect((err as BotManagerError).code).toBe('KB_NOT_FOUND')
    }
  })

  it('3. activating an archived KB fails with ARCHIVED_WORKSPACE', () => {
    const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Archived KB' })
    testCtx.kbRepo.archive(kb.id)

    expect(() => activeContext.activateWorkspace(103, kb.id)).toThrow(BotManagerError)

    try {
      activeContext.activateWorkspace(103, kb.id)
    } catch (err) {
      expect(err).toBeInstanceOf(BotManagerError)
      expect((err as BotManagerError).code).toBe('ARCHIVED_WORKSPACE')
    }
  })

  it('4. a session without an active KB throws NoActiveWorkspaceError', () => {
    const unknownSession = 'unregistered-session'

    expect(() => activeContext.getActiveWorkspaceId(unknownSession)).toThrow(NoActiveWorkspaceError)
    expect(activeContext.hasActiveWorkspace(unknownSession)).toBe(false)
  })

  it('5. two renderer sessions hold different active KB contexts independently', () => {
    const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Workspace Alpha' })
    const kbB = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Workspace Beta' })

    const sessionA = 1
    const sessionB = 2

    activeContext.activateWorkspace(sessionA, kbA.id)
    activeContext.activateWorkspace(sessionB, kbB.id)

    expect(activeContext.getActiveWorkspaceId(sessionA)).toBe(kbA.id)
    expect(activeContext.getActiveWorkspaceId(sessionB)).toBe(kbB.id)
    expect(activeContext.getActiveWorkspace(sessionA).name).toBe('Workspace Alpha')
    expect(activeContext.getActiveWorkspace(sessionB).name).toBe('Workspace Beta')
  })

  it('6. clearing one session context does not clear another session context', () => {
    const kbA = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Workspace Alpha' })
    const kbB = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Workspace Beta' })

    const sessionA = 'window-1'
    const sessionB = 'window-2'

    activeContext.activateWorkspace(sessionA, kbA.id)
    activeContext.activateWorkspace(sessionB, kbB.id)

    const cleared = activeContext.clearActiveWorkspace(sessionA)
    expect(cleared).toBe(true)

    expect(() => activeContext.getActiveWorkspaceId(sessionA)).toThrow(NoActiveWorkspaceError)
    expect(activeContext.getActiveWorkspaceId(sessionB)).toBe(kbB.id)
  })

  it('7. detects stale context when a KB is archived after activation and purges session', () => {
    const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Soon Archived' })
    const session = 201

    activeContext.activateWorkspace(session, kb.id)
    expect(activeContext.hasActiveWorkspace(session)).toBe(true)

    // Archive the Knowledge Base in the database
    testCtx.kbRepo.archive(kb.id)

    // Attempting to resolve active workspace must detect the archive status, purge session, and throw
    try {
      activeContext.getActiveWorkspaceId(session)
      expect.fail('Should have thrown BotManagerError')
    } catch (err) {
      expect((err as BotManagerError).code).toBe('ARCHIVED_WORKSPACE')
    }

    // Subsequent resolution should now report no active workspace
    expect(activeContext.hasActiveWorkspace(session)).toBe(false)
  })

  it('8. detects stale context when a KB is deleted after activation and purges session', () => {
    const kb = createKnowledgeBaseFixture(testCtx.kbRepo, { name: 'Soon Deleted' })
    const session = 202

    activeContext.activateWorkspace(session, kb.id)

    // Hard-delete KB in SQLite
    testCtx.kbRepo.delete(kb.id)

    try {
      activeContext.getActiveWorkspaceId(session)
      expect.fail('Should have thrown BotManagerError')
    } catch (err) {
      expect((err as BotManagerError).code).toBe('KB_NOT_FOUND')
    }

    expect(activeContext.hasActiveWorkspace(session)).toBe(false)
  })

  it('9. rejects invalid UUID string on workspace activation with BotValidationError', () => {
    expect(() => activeContext.activateWorkspace(301, 'invalid-uuid-string')).toThrow(
      BotValidationError
    )
  })

  it('10. clearAll empties all active sessions', () => {
    const kb = createKnowledgeBaseFixture(testCtx.kbRepo)
    activeContext.activateWorkspace(1, kb.id)
    activeContext.activateWorkspace(2, kb.id)
    expect(activeContext.sessionCount).toBe(2)

    activeContext.clearAll()
    expect(activeContext.sessionCount).toBe(0)
    expect(activeContext.hasActiveWorkspace(1)).toBe(false)
  })
})
