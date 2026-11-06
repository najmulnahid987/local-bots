import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resetDevDatabase,
  DatabaseResetError,
  RESET_CONFIRMATION_PHRASE,
  RESET_CLI_SWITCH
} from './reset'
import { DatabaseManager } from '../connection'

describe('Database Safe Development Reset Utility (dev/reset)', () => {
  let tempUserData: string
  let dbDir: string
  let manager: DatabaseManager

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'test-reset-userdata-'))
    dbDir = join(tempUserData, 'database')
    mkdirSync(dbDir, { recursive: true })
    manager = new DatabaseManager()
  })

  afterEach(() => {
    if (manager.isOpen()) {
      manager.close()
    }
    rmSync(tempUserData, { recursive: true, force: true })
  })

  const validOptions = (): {
    confirmationPhrase: string
    appInstance: { isPackaged: boolean; getPath: (name: 'userData') => string }
    env: NodeJS.ProcessEnv
    argv: string[]
    manager: DatabaseManager
  } => ({
    confirmationPhrase: RESET_CONFIRMATION_PHRASE,
    appInstance: {
      isPackaged: false,
      getPath: () => tempUserData
    },
    env: { LOCAL_AI_ENABLE_DB_RESET: '1' },
    argv: ['node', 'electron', RESET_CLI_SWITCH],
    manager
  })

  // Test 1: Reset blocked when app.isPackaged is true
  it('1. blocks reset when app.isPackaged is true', () => {
    const opts = validOptions()
    opts.appInstance.isPackaged = true

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(() => resetDevDatabase(opts)).toThrow(/strictly prohibited in a packaged application/i)
  })

  // Test 2: Reset blocked when environment flag is missing
  it('2. blocks reset when the environment flag is missing', () => {
    const opts = validOptions()
    opts.env = {}

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(() => resetDevDatabase(opts)).toThrow(
      /environment variable LOCAL_AI_ENABLE_DB_RESET must be set to '1'/i
    )
  })

  // Test 3: Reset blocked when environment flag has an incorrect value
  it('3. blocks reset when the environment flag has an incorrect value', () => {
    const opts = validOptions()
    opts.env = { LOCAL_AI_ENABLE_DB_RESET: 'true' }

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)

    opts.env = { LOCAL_AI_ENABLE_DB_RESET: '0' }
    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
  })

  // Test 4: Reset blocked when command-line switch is missing
  it('4. blocks reset when the command-line switch is missing', () => {
    const opts = validOptions()
    opts.argv = ['node', 'electron']

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(() => resetDevDatabase(opts)).toThrow(
      /command-line switch '--reset-dev-database' is missing/i
    )
  })

  // Test 5: Reset blocked when confirmation phrase is incorrect
  it('5. blocks reset when the confirmation phrase is incorrect', () => {
    const opts = validOptions()
    opts.confirmationPhrase = 'reset please'

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(() => resetDevDatabase(opts)).toThrow(/confirmation phrase does not match/i)
  })

  // Test 6: Failed authorization leaves every file untouched
  it('6. leaves every database file untouched when authorization fails', () => {
    const dbFile = join(dbDir, 'app.sqlite')
    writeFileSync(dbFile, 'critical database content')

    const opts = validOptions()
    opts.confirmationPhrase = 'wrong phrase'

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(existsSync(dbFile)).toBe(true)
  })

  // Test 7: Successful reset closes the database connection first
  it('7. closes the database connection before file removal', () => {
    manager.initialize(tempUserData)
    expect(manager.isOpen()).toBe(true)

    const opts = validOptions()
    const result = resetDevDatabase(opts)

    expect(result.success).toBe(true)
    expect(manager.isOpen()).toBe(false)
  })

  // Test 8: Successful reset removes app.sqlite
  it('8. removes app.sqlite on successful authorized reset', () => {
    const dbFile = join(dbDir, 'app.sqlite')
    writeFileSync(dbFile, 'sqlite data')

    const opts = validOptions()
    const result = resetDevDatabase(opts)

    expect(result.success).toBe(true)
    expect(result.deletedFiles).toContain('app.sqlite')
    expect(existsSync(dbFile)).toBe(false)
  })

  // Test 9: Successful reset removes approved sidecar files
  it('9. removes approved sidecar files (app.sqlite-wal, app.sqlite-shm, app.sqlite-journal)', () => {
    const sidecars = ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm', 'app.sqlite-journal']

    for (const file of sidecars) {
      writeFileSync(join(dbDir, file), `content of ${file}`)
    }

    const opts = validOptions()
    const result = resetDevDatabase(opts)

    expect(result.success).toBe(true)
    for (const file of sidecars) {
      expect(result.deletedFiles).toContain(file)
      expect(existsSync(join(dbDir, file))).toBe(false)
    }
  })

  // Test 10: Successful reset leaves the database directory intact
  it('10. leaves the database directory intact after reset', () => {
    writeFileSync(join(dbDir, 'app.sqlite'), 'sqlite data')

    const opts = validOptions()
    resetDevDatabase(opts)

    expect(existsSync(dbDir)).toBe(true)
  })

  // Test 11: Unrelated userData files remain intact
  it('11. preserves unrelated files in database directory and parent userData', () => {
    const unrelatedInDb = join(dbDir, 'custom-backup.json')
    const unrelatedInUserData = join(tempUserData, 'user-preferences.json')

    writeFileSync(unrelatedInDb, '{"preserve": true}')
    writeFileSync(unrelatedInUserData, '{"theme": "dark"}')
    writeFileSync(join(dbDir, 'app.sqlite'), 'sqlite data')

    const opts = validOptions()
    const result = resetDevDatabase(opts)

    expect(result.success).toBe(true)
    expect(existsSync(unrelatedInDb)).toBe(true)
    expect(existsSync(unrelatedInUserData)).toBe(true)
  })

  // Test 12: Arbitrary external directories cannot be targeted
  it('12. derives path internally from app.getPath and rejects empty/invalid paths', () => {
    const opts = validOptions()
    opts.appInstance.getPath = () => ''

    expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
    expect(() => resetDevDatabase(opts)).toThrow(/Invalid or empty userData path/i)
  })

  // Test 13: Symlinked database directories are rejected
  it('13. rejects a symlinked database directory', () => {
    const realDbDir = join(tempUserData, 'real-database')
    mkdirSync(realDbDir)
    rmSync(dbDir, { recursive: true, force: true })

    try {
      symlinkSync(realDbDir, dbDir, 'junction')
    } catch {
      // Junction creation fallback
    }

    if (existsSync(dbDir)) {
      const opts = validOptions()
      expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
      expect(() => resetDevDatabase(opts)).toThrow(/symbolic link/i)
    }
  })

  // Test 14: Symlinked database files are rejected
  it('14. rejects symlinked database files', () => {
    const realFile = join(tempUserData, 'external.sqlite')
    writeFileSync(realFile, 'external sqlite file')
    const symlinkTarget = join(dbDir, 'app.sqlite')

    let symlinkCreated = false
    try {
      symlinkSync(realFile, symlinkTarget, 'file')
      symlinkCreated = true
    } catch {
      // Windows unprivileged environment may deny file symlink creation
    }

    if (symlinkCreated) {
      const opts = validOptions()
      expect(() => resetDevDatabase(opts)).toThrow(DatabaseResetError)
      expect(() => resetDevDatabase(opts)).toThrow(/symbolic link/i)
    }
  })

  // Test 15: Repeated reset attempts are safe
  it('15. safely handles repeated reset attempts without error', () => {
    writeFileSync(join(dbDir, 'app.sqlite'), 'data')

    const opts = validOptions()
    const firstResult = resetDevDatabase(opts)
    expect(firstResult.success).toBe(true)
    expect(firstResult.deletedFiles).toContain('app.sqlite')

    // Second run when files are already gone
    const secondResult = resetDevDatabase(opts)
    expect(secondResult.success).toBe(true)
    expect(secondResult.deletedFiles).toEqual([])
  })

  // Test 16: Database can be initialized again after a successful reset
  it('16. allows database initialization after a successful reset', () => {
    manager.initialize(tempUserData)
    expect(manager.isOpen()).toBe(true)

    const opts = validOptions()
    resetDevDatabase(opts)
    expect(manager.isOpen()).toBe(false)
    expect(existsSync(join(dbDir, 'app.sqlite'))).toBe(false)

    // Re-initialize manager on the same directory
    const initResult = manager.initialize(tempUserData)
    expect(initResult.foreignKeys).toBe(true)
    expect(manager.isOpen()).toBe(true)
    expect(existsSync(join(dbDir, 'app.sqlite'))).toBe(true)
  })
})
