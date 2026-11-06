import { resolve, join } from 'node:path'
import { readdirSync, lstatSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { app } from 'electron'
import { databaseManager, type DatabaseManager } from '../connection'

export const RESET_CONFIRMATION_PHRASE = 'RESET LOCAL DEVELOPMENT DATABASE'
export const RESET_ENV_VARIABLE = 'LOCAL_AI_ENABLE_DB_RESET'
export const RESET_CLI_SWITCH = '--reset-dev-database'

export const PERMITTED_RESET_FILES = new Set([
  'app.sqlite',
  'app.sqlite-wal',
  'app.sqlite-shm',
  'app.sqlite-journal'
])

export class DatabaseResetError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'RESET_DENIED'
  ) {
    super(message)
    this.name = 'DatabaseResetError'
  }
}

export interface ResetDevDatabaseOptions {
  confirmationPhrase: string
  appInstance?: { isPackaged: boolean; getPath: (name: 'userData') => string }
  env?: NodeJS.ProcessEnv
  argv?: string[]
  manager?: DatabaseManager
}

export interface DatabaseResetResult {
  success: boolean
  deletedFiles: string[]
  databaseDir: string
  message?: string
}

/**
 * Strictly guarded development-only utility to reset the local SQLite database.
 * Never available in production or exposed to Renderer/IPC.
 */
export function resetDevDatabase(options: ResetDevDatabaseOptions): DatabaseResetResult {
  const currentApp = options.appInstance ?? app
  const currentEnv = options.env ?? process.env
  const currentArgv = options.argv ?? process.argv
  const currentManager = options.manager ?? databaseManager

  // 1. Mandatory authorization: Packaged application guard
  if (currentApp.isPackaged) {
    throw new DatabaseResetError(
      'Database reset is strictly prohibited in a packaged application.',
      'RESET_BLOCKED_PACKAGED'
    )
  }

  // 2. Mandatory authorization: Explicit environment variable
  if (currentEnv[RESET_ENV_VARIABLE] !== '1') {
    throw new DatabaseResetError(
      `Database reset blocked: environment variable ${RESET_ENV_VARIABLE} must be set to '1'.`,
      'RESET_BLOCKED_ENV'
    )
  }

  // 3. Mandatory authorization: Command-line switch
  if (!currentArgv.includes(RESET_CLI_SWITCH)) {
    throw new DatabaseResetError(
      `Database reset blocked: command-line switch '${RESET_CLI_SWITCH}' is missing.`,
      'RESET_BLOCKED_CLI'
    )
  }

  // 4. Mandatory authorization: Exact confirmation phrase
  if (options.confirmationPhrase !== RESET_CONFIRMATION_PHRASE) {
    throw new DatabaseResetError(
      `Database reset blocked: confirmation phrase does not match '${RESET_CONFIRMATION_PHRASE}'.`,
      'RESET_BLOCKED_PHRASE'
    )
  }

  // Target path restrictions
  const rawUserData = currentApp.getPath('userData')
  if (!rawUserData || typeof rawUserData !== 'string' || rawUserData.trim().length === 0) {
    throw new DatabaseResetError('Invalid or empty userData path provided.', 'RESET_INVALID_PATH')
  }

  if (!existsSync(rawUserData)) {
    throw new DatabaseResetError(
      `userData path does not exist: '${rawUserData}'.`,
      'RESET_PATH_NOT_FOUND'
    )
  }

  const canonicalUserData = realpathSync(rawUserData)
  const databaseDir = resolve(canonicalUserData, 'database')

  if (!existsSync(databaseDir)) {
    return {
      success: true,
      deletedFiles: [],
      databaseDir,
      message: 'Database directory does not exist; nothing to reset.'
    }
  }

  // Inspect database directory without following symlinks
  const dirStat = lstatSync(databaseDir)
  if (dirStat.isSymbolicLink()) {
    throw new DatabaseResetError(
      'Database directory is a symbolic link, which is strictly prohibited.',
      'RESET_SYMLINK_REJECTED'
    )
  }
  if (!dirStat.isDirectory()) {
    throw new DatabaseResetError('Database target is not a directory.', 'RESET_NOT_A_DIRECTORY')
  }

  // Close database manager connection first
  try {
    currentManager.close()
  } catch (err) {
    throw new DatabaseResetError(
      `Failed to close database before reset: ${err instanceof Error ? err.message : String(err)}`,
      'RESET_CLOSE_FAILED'
    )
  }

  if (currentManager.isOpen()) {
    throw new DatabaseResetError(
      'Database connection remains open after close request.',
      'RESET_CONNECTION_STILL_OPEN'
    )
  }

  // Inspect files inside database directory
  const entries = readdirSync(databaseDir)
  const deletedFiles: string[] = []

  for (const entry of entries) {
    if (PERMITTED_RESET_FILES.has(entry)) {
      const entryPath = join(databaseDir, entry)
      const entryStat = lstatSync(entryPath)

      if (entryStat.isSymbolicLink()) {
        throw new DatabaseResetError(
          `Database file '${entry}' is a symbolic link, which is strictly prohibited.`,
          'RESET_SYMLINK_FILE'
        )
      }

      if (!entryStat.isFile()) {
        throw new DatabaseResetError(
          `Database target '${entry}' is not a regular file.`,
          'RESET_NON_REGULAR_FILE'
        )
      }

      try {
        rmSync(entryPath, { force: true })
        deletedFiles.push(entry)
      } catch (err) {
        throw new DatabaseResetError(
          `Failed to delete database file '${entry}': ${err instanceof Error ? err.message : String(err)}`,
          'RESET_DELETE_FAILED'
        )
      }
    }
  }

  return {
    success: true,
    deletedFiles,
    databaseDir
  }
}
