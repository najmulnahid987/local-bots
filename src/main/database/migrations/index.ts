import type { Migration } from './types'
import initialSchemaSql from './001_initial_schema.sql?raw'
import providerCredentialRefsSql from './002_provider_credential_refs.sql?raw'
import knowledgeSourcesLifecycleAndFts5Sql from './003_knowledge_sources_lifecycle_and_fts5.sql?raw'
import importRecoveryJournalSql from './004_import_recovery_journal.sql?raw'
import deletionRecoveryJournalSql from './005_deletion_recovery_journal.sql?raw'
import docxPersistenceSupportSql from './006_docx_persistence_support.sql?raw'
import xlsxPersistenceSupportSql from './007_xlsx_persistence_support.sql?raw'
import pptxPersistenceSupportSql from './008_pptx_persistence_support.sql?raw'
import extractedDocumentPersistenceSql from './009_extracted_document_persistence.sql?raw'
import csvPersistenceSupportSql from './010_csv_persistence_support.sql?raw'

export * from './types'
export * from './runner'

/**
 * Production migration registry.
 *
 * Migration 001 establishes the 11 core application relational tables and indexes.
 * Migration 002 evolves provider_connections to store opaque CredentialVault references.
 * Migration 003 evolves knowledge_sources lifecycle statuses and establishes the knowledge_fts FTS5 foundation.
 * Migration 004 establishes the import_recovery_journal table for durable crash resilience.
 * Migration 005 establishes the deletion_recovery_journal table for safe crash recovery during deletions.
 * Migration 006 evolves knowledge_sources.file_type to permit 'docx' persistence.
 * Migration 007 evolves knowledge_sources.file_type to permit 'xlsx' persistence.
 * Migration 008 evolves knowledge_sources.file_type to permit 'pptx' persistence.
 * Migration 009 establishes knowledge_extracted_documents for canonical UniversalDocument persistence.
 * Migration 010 evolves knowledge_sources.file_type to permit 'csv' persistence.
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
  },
  {
    version: 3,
    name: 'knowledge_sources_lifecycle_and_fts5',
    sql: knowledgeSourcesLifecycleAndFts5Sql,
    disableForeignKeysForTableRebuild: true
  },
  {
    version: 4,
    name: 'import_recovery_journal',
    sql: importRecoveryJournalSql
  },
  {
    version: 5,
    name: 'deletion_recovery_journal',
    sql: deletionRecoveryJournalSql
  },
  {
    version: 6,
    name: 'docx_persistence_support',
    sql: docxPersistenceSupportSql,
    disableForeignKeysForTableRebuild: true
  },
  {
    version: 7,
    name: 'xlsx_persistence_support',
    sql: xlsxPersistenceSupportSql,
    disableForeignKeysForTableRebuild: true
  },
  {
    version: 8,
    name: 'pptx_persistence_support',
    sql: pptxPersistenceSupportSql,
    disableForeignKeysForTableRebuild: true
  },
  {
    version: 9,
    name: 'extracted_document_persistence',
    sql: extractedDocumentPersistenceSql
  },
  {
    version: 10,
    name: 'csv_persistence_support',
    sql: csvPersistenceSupportSql,
    disableForeignKeysForTableRebuild: true
  }
]
