import type { Migration } from './types'
import initialSchemaSql from './001_initial_schema.sql?raw'
import providerCredentialRefsSql from './002_provider_credential_refs.sql?raw'

export * from './types'
export * from './runner'

/**
 * Production migration registry.
 *
 * Migration 001 establishes the 11 core application relational tables and indexes.
 * Migration 002 evolves provider_connections to store opaque CredentialVault references.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: initialSchemaSql
  },
  {
    version: 2,
    name: 'provider_credential_refs',
    sql: providerCredentialRefsSql
  }
]
