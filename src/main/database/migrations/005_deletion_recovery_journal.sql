-- Migration 005: Deletion Recovery Journal Schema
-- Durable crash-recovery tracking for Knowledge Base and Knowledge Source deletions
-- Version: 5
-- Name: deletion_recovery_journal

CREATE TABLE deletion_recovery_journal (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('knowledge_base', 'knowledge_source')),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
    knowledge_base_id TEXT NOT NULL CHECK (length(trim(knowledge_base_id)) > 0),
    entity_name TEXT NOT NULL CHECK (length(trim(entity_name)) > 0),
    quarantine_path_name TEXT NOT NULL CHECK (length(trim(quarantine_path_name)) > 0),
    original_rel_path TEXT,
    state TEXT NOT NULL CHECK (
        state IN (
            'preparing',
            'quarantining',
            'database_deleting',
            'database_deleted',
            'filesystem_finalizing',
            'completed',
            'rolling_back',
            'recovery_required',
            'failed'
        )
    ),
    error_message TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX idx_deletion_recovery_journal_state ON deletion_recovery_journal(state);
CREATE INDEX idx_deletion_recovery_journal_entity ON deletion_recovery_journal(entity_type, entity_id);
CREATE INDEX idx_deletion_recovery_journal_created_at ON deletion_recovery_journal(created_at);
