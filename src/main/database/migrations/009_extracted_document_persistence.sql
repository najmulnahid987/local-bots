-- Migration 009: Extracted Document Content Persistence
-- Establishes canonical UniversalDocument persistence in knowledge_extracted_documents
-- Version: 9
-- Name: extracted_document_persistence

CREATE TABLE knowledge_extracted_documents (
    source_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
    document_json TEXT NOT NULL CHECK (json_valid(document_json)),
    document_hash TEXT NOT NULL CHECK (length(document_hash) = 64),
    document_size_bytes INTEGER NOT NULL CHECK (document_size_bytes >= 0),
    block_count INTEGER NOT NULL CHECK (block_count >= 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX idx_knowledge_extracted_documents_created ON knowledge_extracted_documents(created_at);
