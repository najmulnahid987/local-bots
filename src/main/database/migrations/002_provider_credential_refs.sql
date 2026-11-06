-- Migration 002: Provider Credential References Schema
-- Replaces BLOB credentials with opaque credential references in provider_connections
-- Version: 2
-- Name: provider_credential_refs

-- 1. Safety Guard: Abort migration if legacy provider_connections contains any rows.
-- This prevents accidental data loss if legacy encrypted credentials exist.
CREATE TABLE __migration_002_guard (
    legacy_rows_count INTEGER CHECK (legacy_rows_count = 0)
);

INSERT INTO __migration_002_guard (legacy_rows_count)
SELECT count(*) FROM provider_connections;

DROP TABLE __migration_002_guard;

-- 2. Create updated provider_connections table without encrypted_credentials or key_preview
CREATE TABLE provider_connections_new (
    id TEXT PRIMARY KEY NOT NULL,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('openai', 'anthropic', 'google', 'xai', 'openrouter')),
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    credential_ref TEXT NOT NULL UNIQUE CHECK (length(trim(credential_ref)) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- 3. Drop legacy table and rename new table to provider_connections
DROP TABLE provider_connections;
ALTER TABLE provider_connections_new RENAME TO provider_connections;

-- 4. Rebuild indexes
CREATE INDEX idx_provider_connections_provider ON provider_connections(provider_id);
CREATE UNIQUE INDEX idx_provider_connections_ref ON provider_connections(credential_ref);

