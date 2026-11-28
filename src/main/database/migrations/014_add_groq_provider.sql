-- Migration 014: Add Groq Provider Support
-- Rebuilds provider_connections to permit 'groq' alongside existing providers
-- Version: 14
-- Name: add_groq_provider

-- 1. Create updated provider_connections table adding 'groq' to provider_id CHECK constraint
CREATE TABLE provider_connections_new (
    id TEXT PRIMARY KEY NOT NULL,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('openai', 'anthropic', 'google', 'groq', 'xai', 'openrouter')),
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    credential_ref TEXT NOT NULL UNIQUE CHECK (length(trim(credential_ref)) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- 2. Copy all existing provider connection records safely
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

-- 3. Drop previous table and swap in reconstructed table
DROP TABLE provider_connections;
ALTER TABLE provider_connections_new RENAME TO provider_connections;

-- 4. Recreate indexes on provider_connections
CREATE INDEX idx_provider_connections_provider ON provider_connections(provider_id);
CREATE UNIQUE INDEX idx_provider_connections_ref ON provider_connections(credential_ref);
