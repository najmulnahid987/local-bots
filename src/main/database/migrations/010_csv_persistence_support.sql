-- Migration 010: CSV Persistence Enablement
-- Expands permitted knowledge_sources.file_type values to include 'csv'
-- Version: 10
-- Name: csv_persistence_support

-- 1. Create replacement table with expanded file_type CHECK constraint
CREATE TABLE knowledge_sources_new (
    id TEXT PRIMARY KEY NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
    original_file_name TEXT NOT NULL CHECK (length(trim(original_file_name)) > 0),
    relative_file_path TEXT NOT NULL CHECK (length(trim(relative_file_path)) > 0),
    file_type TEXT NOT NULL CHECK (file_type IN ('txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx', 'csv')),
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    file_size INTEGER NOT NULL CHECK (file_size >= 0),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    indexing_status TEXT NOT NULL DEFAULT 'queued' CHECK (
        indexing_status IN ('queued', 'processing', 'completed', 'failed', 'needs_reindex')
    ),
    error_message TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    indexed_at INTEGER CHECK (indexed_at IS NULL OR indexed_at >= created_at),
    UNIQUE (id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 2. Migrate existing knowledge_sources rows verbatim
INSERT INTO knowledge_sources_new (
    id, knowledge_base_id, file_name, original_file_name, relative_file_path,
    file_type, mime_type, file_size, content_hash, indexing_status,
    error_message, created_at, updated_at, indexed_at
)
SELECT
    id, knowledge_base_id, file_name, original_file_name, relative_file_path,
    file_type, mime_type, file_size, content_hash, indexing_status,
    error_message, created_at, updated_at, indexed_at
FROM knowledge_sources;

-- 3. Drop legacy table and rename replacement table
DROP TABLE knowledge_sources;
ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources;

-- 4. Rebuild indexes on knowledge_sources
CREATE INDEX idx_knowledge_sources_kb ON knowledge_sources(knowledge_base_id);
CREATE INDEX idx_knowledge_sources_status ON knowledge_sources(knowledge_base_id, indexing_status);
CREATE INDEX idx_knowledge_sources_hash ON knowledge_sources(knowledge_base_id, content_hash);
