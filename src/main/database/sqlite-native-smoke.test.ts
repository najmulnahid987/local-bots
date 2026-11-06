import { describe, it, expect } from 'vitest'
import { runSqliteNativeSmokeTest } from './sqlite-native-smoke'

describe('sqlite-native-smoke', () => {
  it('executes in-memory better-sqlite3 operations cleanly', () => {
    const result = runSqliteNativeSmokeTest()

    expect(result.success).toBe(true)
    expect(result.foreignKeysEnabled).toBe(true)
    expect(result.crudSuccess).toBe(true)
    expect(result.transactionCommitSuccess).toBe(true)
    expect(result.transactionRollbackSuccess).toBe(true)
    expect(typeof result.sqliteVersion).toBe('string')
    expect(result.sqliteVersion.length).toBeGreaterThan(0)
    expect(result.diagnostics.betterSqlite3Version).toBe('13.0.3')
    expect(result.diagnostics.nodeVersion).toBe(process.versions.node)
  })
})
