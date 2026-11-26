-- Migration 012: Single Conversation per Bot Foundation and Conversation Segments
-- Version: 12
-- Name: single_conversation_per_bot

-- 1. Ensure any existing bots with 0 conversations receive a canonical conversation
-- This guarantees the invariant: Every Bot owns exactly one conversation
INSERT INTO conversations (
    id,
    bot_id,
    knowledge_base_id,
    title,
    created_at,
    updated_at,
    archived_at
)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    b.id,
    b.knowledge_base_id,
    b.name || ' Conversation',
    b.created_at,
    b.updated_at,
    NULL
FROM bots b
LEFT JOIN conversations c ON c.bot_id = b.id
WHERE c.id IS NULL;

-- 2. Create temporary table ranking conversations per bot deterministically
-- Deterministic selection: earliest created_at ASC, with id ASC tie-breaker
CREATE TEMP TABLE _migration_conv_ranked AS
SELECT
    id AS original_id,
    bot_id,
    knowledge_base_id,
    title,
    created_at,
    updated_at,
    archived_at,
    ROW_NUMBER() OVER (
        PARTITION BY bot_id
        ORDER BY created_at ASC, id ASC
    ) AS rank_order,
    FIRST_VALUE(id) OVER (
        PARTITION BY bot_id
        ORDER BY created_at ASC, id ASC
    ) AS canonical_id
FROM conversations;

-- 3. Create temporary table capturing canonical conversations with aggregated updated_at
CREATE TEMP TABLE _migration_canonical_convs AS
SELECT
    r.canonical_id AS id,
    r.bot_id,
    r.knowledge_base_id,
    r.title,
    r.created_at,
    agg.max_updated_at AS updated_at,
    r.archived_at
FROM _migration_conv_ranked r
JOIN (
    SELECT bot_id, MAX(updated_at) AS max_updated_at
    FROM conversations
    GROUP BY bot_id
) agg ON agg.bot_id = r.bot_id
WHERE r.rank_order = 1;

-- 4. Create conversation_segments table to preserve historical conversation threads and boundaries
CREATE TABLE conversation_segments (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    original_conversation_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Conversation Segment' CHECK (length(trim(title)) > 0),
    segment_order INTEGER NOT NULL DEFAULT 0 CHECK (segment_order >= 0),
    first_message_created_at INTEGER CHECK (first_message_created_at IS NULL OR first_message_created_at > 0),
    last_message_created_at INTEGER CHECK (last_message_created_at IS NULL OR last_message_created_at >= first_message_created_at),
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 5. Populate conversation_segments from ranked conversations and message statistics
INSERT INTO conversation_segments (
    id,
    conversation_id,
    original_conversation_id,
    title,
    segment_order,
    first_message_created_at,
    last_message_created_at,
    message_count,
    created_at,
    archived_at
)
SELECT
    r.original_id AS id,
    r.canonical_id AS conversation_id,
    r.original_id AS original_conversation_id,
    CASE
        WHEN length(trim(r.title)) > 0 THEN r.title
        ELSE 'Conversation Segment'
    END AS title,
    (r.rank_order - 1) AS segment_order,
    m_stat.min_created_at AS first_message_created_at,
    m_stat.max_created_at AS last_message_created_at,
    coalesce(m_stat.cnt, 0) AS message_count,
    r.created_at,
    r.archived_at
FROM _migration_conv_ranked r
LEFT JOIN (
    SELECT
        conversation_id,
        MIN(created_at) AS min_created_at,
        MAX(created_at) AS max_created_at,
        COUNT(*) AS cnt
    FROM messages
    GROUP BY conversation_id
) m_stat ON m_stat.conversation_id = r.original_id;

-- 6. Create replacement messages table with segment_id column and foreign key
CREATE TABLE messages_new (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    segment_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    content_format TEXT NOT NULL DEFAULT 'markdown' CHECK (content_format IN ('text', 'markdown', 'json')),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    token_usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(token_usage_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (segment_id) REFERENCES conversation_segments(id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- 7. Migrate all messages: map conversation_id to canonical_id and assign segment_id
INSERT INTO messages_new (
    id,
    conversation_id,
    segment_id,
    role,
    content,
    content_format,
    metadata_json,
    token_usage_json,
    created_at
)
SELECT
    m.id,
    r.canonical_id,
    r.original_id,
    m.role,
    m.content,
    m.content_format,
    m.metadata_json,
    m.token_usage_json,
    m.created_at
FROM messages m
JOIN _migration_conv_ranked r ON r.original_id = m.conversation_id;

-- 8. Relink agent_runs to canonical conversation IDs
UPDATE agent_runs
SET conversation_id = (
    SELECT r.canonical_id
    FROM _migration_conv_ranked r
    WHERE r.original_id = agent_runs.conversation_id
)
WHERE conversation_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM _migration_conv_ranked r
    WHERE r.original_id = agent_runs.conversation_id
  );

-- 9. Create replacement conversations table with UNIQUE(bot_id) constraint
CREATE TABLE conversations_new (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL UNIQUE,
    knowledge_base_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New Conversation' CHECK (length(trim(title)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at),
    UNIQUE (id, bot_id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 10. Populate conversations_new with canonical conversation rows
INSERT INTO conversations_new (
    id,
    bot_id,
    knowledge_base_id,
    title,
    created_at,
    updated_at,
    archived_at
)
SELECT
    id,
    bot_id,
    knowledge_base_id,
    title,
    created_at,
    updated_at,
    archived_at
FROM _migration_canonical_convs;

-- 11. Drop legacy messages and conversations tables, and rename replacement tables
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

-- 12. Rebuild indexes
CREATE UNIQUE INDEX idx_conversations_bot ON conversations(bot_id);
CREATE INDEX idx_conversations_kb ON conversations(knowledge_base_id);
CREATE INDEX idx_conversations_updated ON conversations(bot_id, updated_at DESC);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_messages_segment ON messages(segment_id, created_at ASC);

CREATE INDEX idx_conversation_segments_conv ON conversation_segments(conversation_id, segment_order ASC);
CREATE INDEX idx_conversation_segments_orig ON conversation_segments(original_conversation_id);

-- 13. Clean up temporary migration tables
DROP TABLE _migration_conv_ranked;
DROP TABLE _migration_canonical_convs;
