-- Migration 004: Import Recovery Journal Schema
-- Durable crash-recovery tracking for Knowledge Base imports and replacements
-- Version: 4
-- Name: import_recovery_journal

CREATE TABLE import_recovery_journal (
    id TEXT PRIMARY KEY NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('new', 'merge', 'replace')),
    target_knowledge_base_id TEXT,
    target_knowledge_base_name TEXT NOT NULL CHECK (length(trim(target_knowledge_base_name)) > 0),
    archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
    archive_name TEXT NOT NULL CHECK (length(trim(archive_name)) > 0),
    state TEXT NOT NULL CHECK (
        state IN (
            'preparing',
            'staging',
            'validated',
            'quarantining',
            'files_promoting',
            'database_committing',
            'database_committed',
            'indexing',
            'verifying',
            'completed',
            'rolling_back',
            'recovery_required',
            'cancelled',
            'failed'
        )
    ),
    staging_dir_name TEXT NOT NULL CHECK (length(trim(staging_dir_name)) > 0),
    quarantine_dir_name TEXT,
    promoted_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(promoted_files_json)),
    remapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(remapping_json)),
    counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts_json)),
    error_message TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX idx_import_recovery_journal_state ON import_recovery_journal(state);
CREATE INDEX idx_import_recovery_journal_target_kb ON import_recovery_journal(target_knowledge_base_id);
CREATE INDEX idx_import_recovery_journal_created_at ON import_recovery_journal(created_at);
