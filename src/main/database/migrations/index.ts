import type { Migration } from './types'
import initialSchemaSql from './001_initial_schema.sql?raw'

export * from './types'
export * from './runner'

/**
 * Production migration registry.
 *
 * Migration 001 establishes the 11 core application relational tables and indexes.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: initialSchemaSql
  }
]
