-- Migration 011: Knowledge Document Preservation Validation Persistence
-- Establishes runtime extraction completeness and chunk coverage validation persistence
-- Version: 11
-- Name: create_document_validation

CREATE TABLE knowledge_document_validation (
    source_id TEXT PRIMARY KEY NOT NULL,
    schema_version TEXT NOT NULL DEFAULT '1.0.0',
    status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'unknown', 'failed')),
    extraction_status TEXT NOT NULL CHECK (extraction_status IN ('complete', 'partial', 'unknown', 'failed')),
    chunk_coverage_status TEXT NOT NULL CHECK (chunk_coverage_status IN ('complete', 'partial', 'unknown', 'failed')),
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    report_hash TEXT NOT NULL CHECK (length(report_hash) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX idx_knowledge_document_validation_status ON knowledge_document_validation(status);
CREATE INDEX idx_knowledge_document_validation_created ON knowledge_document_validation(created_at);
