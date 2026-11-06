import type { Migration } from './types'

export * from './types'
export * from './runner'

/**
 * Production migration registry.
 *
 * For Step 2.3, this registry is intentionally empty.
 * Core application domain migrations will be added starting in Step 2.4.
 */
export const migrations: readonly Migration[] = []
