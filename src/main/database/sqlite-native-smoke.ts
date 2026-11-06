import Database from 'better-sqlite3'

export interface SqliteSmokeDiagnostics {
  electronVersion: string | undefined
  nodeVersion: string
  modulesAbi: string
  napiVersion: string | undefined
  betterSqlite3Version: string
  sqliteVersion: string
}

export interface SqliteSmokeResult {
  success: boolean
  sqliteVersion: string
  foreignKeysEnabled: boolean
  crudSuccess: boolean
  transactionCommitSuccess: boolean
  transactionRollbackSuccess: boolean
  diagnostics: SqliteSmokeDiagnostics
}

/**
 * Development-only smoke test to verify native better-sqlite3 functionality
 * inside the actual Electron Main process.
 *
 * Runs exclusively in-memory (':memory:').
 * Does not create or touch persistent database files or userData.
 */
export function runSqliteNativeSmokeTest(): SqliteSmokeResult {
  let db: Database.Database | null = null

  try {
    // 1. Confirm SQLite connection opens in-memory
    db = new Database(':memory:')

    // 2. Execute SELECT sqlite_version()
    const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as {
      version: string
    }
    const sqliteVersion = versionRow?.version
    if (!sqliteVersion || typeof sqliteVersion !== 'string') {
      throw new Error(`Failed to query sqlite_version(); received: ${JSON.stringify(versionRow)}`)
    }

    // 3. Execute PRAGMA foreign_keys = ON
    db.pragma('foreign_keys = ON')

    // 4. Read back PRAGMA foreign_keys and verify it returns 1
    const fkPragma = db.pragma('foreign_keys', { simple: true })
    const foreignKeysEnabled = fkPragma === 1 || fkPragma === '1'
    if (!foreignKeysEnabled) {
      throw new Error(`PRAGMA foreign_keys expected 1, but received: ${fkPragma}`)
    }

    // 5. Create a temporary smoke test table
    db.exec(`
      CREATE TABLE smoke_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      );
    `)

    // 6. Insert a record using a bound parameter
    const insertStmt = db.prepare('INSERT INTO smoke_test (name, value) VALUES (?, ?)')
    const insertResult = insertStmt.run('alpha', 42)
    if (!insertResult.lastInsertRowid) {
      throw new Error('Failed to insert test record; lastInsertRowid is empty')
    }

    // 7. Read it back and compare its value
    const selectStmt = db.prepare('SELECT id, name, value FROM smoke_test WHERE id = ?')
    const row = selectStmt.get(insertResult.lastInsertRowid) as
      { id: number; name: string; value: number } | undefined

    if (!row || row.name !== 'alpha' || row.value !== 42) {
      throw new Error(
        `Inserted row verification failed; expected {name: 'alpha', value: 42}, got: ${JSON.stringify(row)}`
      )
    }
    const crudSuccess = true

    // 8. Execute a transaction and confirm successful commit
    const commitTx = db.transaction((itemA: string, valA: number, itemB: string, valB: number) => {
      insertStmt.run(itemA, valA)
      insertStmt.run(itemB, valB)
    })
    commitTx('commit_test_1', 101, 'commit_test_2', 102)

    const countAfterCommit = db.prepare('SELECT COUNT(*) AS total FROM smoke_test').get() as {
      total: number
    }
    if (countAfterCommit.total !== 3) {
      throw new Error(
        `Transaction commit failed; expected 3 rows, found: ${countAfterCommit.total}`
      )
    }
    const transactionCommitSuccess = true

    // 9. Execute a transaction that deliberately throws and confirm rollback
    const rollbackTx = db.transaction(() => {
      insertStmt.run('rollback_test', 999)
      throw new Error('deliberate_smoke_test_rollback_trigger')
    })

    let caughtRollbackError = false
    try {
      rollbackTx()
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'deliberate_smoke_test_rollback_trigger') {
        caughtRollbackError = true
      } else {
        throw err
      }
    }

    if (!caughtRollbackError) {
      throw new Error('Rollback transaction did not throw expected test error')
    }

    const rollbackCheck = db.prepare('SELECT * FROM smoke_test WHERE name = ?').get('rollback_test')
    if (rollbackCheck !== undefined) {
      throw new Error('Transaction rollback failed; aborted record persisted in database')
    }
    const transactionRollbackSuccess = true

    // Runtime Diagnostics
    const diagnostics: SqliteSmokeDiagnostics = {
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      modulesAbi: process.versions.modules,
      napiVersion: process.versions.napi,
      betterSqlite3Version: '13.0.3',
      sqliteVersion
    }

    return {
      success: true,
      sqliteVersion,
      foreignKeysEnabled: true,
      crudSuccess,
      transactionCommitSuccess,
      transactionRollbackSuccess,
      diagnostics
    }
  } finally {
    // 10. Close the database in a finally block
    if (db && typeof db.close === 'function') {
      try {
        db.close()
      } catch (closeErr) {
        console.error('[Native SQLite Smoke Test] Error closing database:', closeErr)
      }
    }
  }
}
