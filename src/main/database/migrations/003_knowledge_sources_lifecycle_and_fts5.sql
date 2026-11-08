-- Migration 003: Knowledge Sources Lifecycle and SQLite FTS5 Index Foundation
-- Version: 3
-- Name: knowledge_sources_lifecycle_and_fts5

-- 1. Rebuild knowledge_sources with canonical indexing_status CHECK constraint
-- Canonical statuses: queued, processing, completed, failed, needs_reindex
CREATE TABLE knowledge_sources_new (
    id TEXT PRIMARY KEY NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
    original_file_name TEXT NOT NULL CHECK (length(trim(original_file_name)) > 0),
    relative_file_path TEXT NOT NULL CHECK (length(trim(relative_file_path)) > 0),
    file_type TEXT NOT NULL CHECK (file_type IN ('txt', 'md', 'pdf')),
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

-- 2. Migrate existing knowledge_sources rows with legacy status mapping
INSERT INTO knowledge_sources_new (
    id, knowledge_base_id, file_name, original_file_name, relative_file_path,
    file_type, mime_type, file_size, content_hash, indexing_status,
    error_message, created_at, updated_at, indexed_at
)
SELECT
    id, knowledge_base_id, file_name, original_file_name, relative_file_path,
    file_type, mime_type, file_size, content_hash,
    CASE indexing_status
        WHEN 'ready' THEN 'completed'
        WHEN 'parsing' THEN 'processing'
        WHEN 'indexing' THEN 'processing'
        WHEN 'queued' THEN 'queued'
        WHEN 'failed' THEN 'failed'
        WHEN 'processing' THEN 'processing'
        WHEN 'completed' THEN 'completed'
        WHEN 'needs_reindex' THEN 'needs_reindex'
        ELSE 'failed'
    END,
    error_message, created_at, updated_at, indexed_at
FROM knowledge_sources;

-- 3. Drop legacy table and rename replacement table
DROP TABLE knowledge_sources;
ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources;

-- 4. Rebuild indexes on knowledge_sources
CREATE INDEX idx_knowledge_sources_kb ON knowledge_sources(knowledge_base_id);
CREATE INDEX idx_knowledge_sources_status ON knowledge_sources(knowledge_base_id, indexing_status);
CREATE INDEX idx_knowledge_sources_hash ON knowledge_sources(knowledge_base_id, content_hash);

-- 5. Create knowledge_fts FTS5 virtual table
CREATE VIRTUAL TABLE knowledge_fts USING fts5 (
    content,
    chunk_id UNINDEXED,
    knowledge_base_id UNINDEXED,
    source_id UNINDEXED,
    tokenize = 'porter unicode61'
);

-- 6. Create automatic FTS synchronization triggers on knowledge_chunks
CREATE TRIGGER trg_knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
    INSERT INTO knowledge_fts (rowid, content, chunk_id, knowledge_base_id, source_id)
    VALUES (new.rowid, new.content, new.id, new.knowledge_base_id, new.source_id);
END;

CREATE TRIGGER trg_knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
    DELETE FROM knowledge_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER trg_knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
    DELETE FROM knowledge_fts WHERE rowid = old.rowid;
    INSERT INTO knowledge_fts (rowid, content, chunk_id, knowledge_base_id, source_id)
    VALUES (new.rowid, new.content, new.id, new.knowledge_base_id, new.source_id);
END;

-- 7. Backfill existing knowledge_chunks into knowledge_fts
INSERT INTO knowledge_fts (rowid, content, chunk_id, knowledge_base_id, source_id)
SELECT rowid, content, id, knowledge_base_id, source_id
FROM knowledge_chunks;

