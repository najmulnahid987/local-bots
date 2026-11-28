-- Migration 015: Add Perplexity AI Provider Support
-- Evolves provider_connections.provider_id CHECK constraint to permit 'perplexity'
-- alongside ('openai', 'anthropic', 'google', 'groq', 'xai', 'openrouter').
--
-- Note: Rebuilds provider_connections using the standard SQLite table rebuild pattern
-- (migration runner handles PRAGMA foreign_keys = OFF via disableForeignKeysForTableRebuild).
-- Preserves all existing provider connections and bots.provider_connection_id FK references.

CREATE TABLE provider_connections_new (
    id TEXT PRIMARY KEY NOT NULL,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('openai', 'anthropic', 'google', 'groq', 'xai', 'openrouter', 'perplexity')),
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    credential_ref TEXT NOT NULL UNIQUE CHECK (length(trim(credential_ref)) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

INSERT INTO provider_connections_new (
    id,
    provider_id,
    label,
    credential_ref,
    status,
    created_at,
    updated_at
)
SELECT
    id,
    provider_id,
    label,
    credential_ref,
    status,
    created_at,
    updated_at
FROM provider_connections;

DROP TABLE provider_connections;

ALTER TABLE provider_connections_new RENAME TO provider_connections;

-- Recreate authoritative indexes from Migration 001 / 014
CREATE INDEX IF NOT EXISTS idx_provider_connections_provider ON provider_connections(provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_ref ON provider_connections(credential_ref);
