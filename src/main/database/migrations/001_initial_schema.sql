-- Migration 001: Initial Core Schema
-- Creates the 11 core application relational tables and performance indexes
-- Version: 1
-- Name: initial_schema

-- 1. Table: knowledge_bases
CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    storage_path TEXT NOT NULL UNIQUE CHECK (length(trim(storage_path)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at)
);

-- 2. Table: provider_connections
CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY NOT NULL,
    provider_name TEXT NOT NULL CHECK (provider_name IN ('openai', 'anthropic', 'google', 'xai', 'openrouter')),
    connection_name TEXT NOT NULL CHECK (length(trim(connection_name)) > 0),
    encrypted_credentials BLOB NOT NULL,
    key_preview TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- 3. Table: app_settings
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY NOT NULL CHECK (length(trim(key)) > 0),
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

-- 4. Table: knowledge_sources
CREATE TABLE knowledge_sources (
    id TEXT PRIMARY KEY NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
    original_file_name TEXT NOT NULL CHECK (length(trim(original_file_name)) > 0),
    relative_file_path TEXT NOT NULL CHECK (length(trim(relative_file_path)) > 0),
    file_type TEXT NOT NULL CHECK (file_type IN ('txt', 'md', 'pdf')),
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    file_size INTEGER NOT NULL CHECK (file_size >= 0),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    indexing_status TEXT NOT NULL DEFAULT 'queued' CHECK (indexing_status IN ('queued', 'parsing', 'indexing', 'ready', 'failed')),
    error_message TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    indexed_at INTEGER CHECK (indexed_at IS NULL OR indexed_at >= created_at),
    UNIQUE (id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 5. Table: knowledge_chunks
CREATE TABLE knowledge_chunks (
    id TEXT PRIMARY KEY NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE (source_id, chunk_index),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (source_id, knowledge_base_id) REFERENCES knowledge_sources(id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 6. Table: bots
CREATE TABLE bots (
    id TEXT PRIMARY KEY NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    provider_connection_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    tool_permissions_json TEXT NOT NULL DEFAULT '[]' CHECK (
        CASE
            WHEN json_valid(tool_permissions_json) THEN json_type(tool_permissions_json) = 'array'
            ELSE 0
        END
    ),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (provider_connection_id) REFERENCES provider_connections(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 7. Table: conversations
CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New Conversation' CHECK (length(trim(title)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at),
    UNIQUE (id, bot_id, knowledge_base_id),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 8. Table: messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    content_format TEXT NOT NULL DEFAULT 'markdown' CHECK (content_format IN ('text', 'markdown', 'json')),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    token_usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(token_usage_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 9. Table: agent_runs
CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    conversation_id TEXT,
    knowledge_base_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
    selected_model TEXT NOT NULL CHECK (length(trim(selected_model)) > 0),
    iteration_count INTEGER NOT NULL DEFAULT 0 CHECK (iteration_count >= 0 AND iteration_count <= 5),
    error_summary TEXT,
    started_at INTEGER NOT NULL CHECK (started_at > 0),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= started_at),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (conversation_id, bot_id, knowledge_base_id) REFERENCES conversations(id, bot_id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 10. Table: tool_events
CREATE TABLE tool_events (
    id TEXT PRIMARY KEY NOT NULL,
    agent_run_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    approval_status TEXT NOT NULL DEFAULT 'auto_approved' CHECK (approval_status IN ('not_required', 'auto_approved', 'pending_approval', 'user_approved', 'user_rejected')),
    arguments_summary TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(arguments_summary)),
    result_summary TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    started_at INTEGER NOT NULL CHECK (started_at > 0),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= started_at),
    UNIQUE (agent_run_id, sequence_number),
    FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 11. Table: bot_memories
CREATE TABLE bot_memories (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'user_note' CHECK (memory_type IN ('user_note', 'pinned_instruction')),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes

-- Knowledge Bases
CREATE INDEX idx_knowledge_bases_created_at ON knowledge_bases(created_at DESC);

-- Knowledge Sources
CREATE INDEX idx_knowledge_sources_kb ON knowledge_sources(knowledge_base_id);
CREATE INDEX idx_knowledge_sources_status ON knowledge_sources(knowledge_base_id, indexing_status);
CREATE INDEX idx_knowledge_sources_hash ON knowledge_sources(knowledge_base_id, content_hash);

-- Knowledge Chunks
CREATE INDEX idx_knowledge_chunks_kb ON knowledge_chunks(knowledge_base_id);
CREATE INDEX idx_knowledge_chunks_source ON knowledge_chunks(source_id);

-- Provider Connections
CREATE INDEX idx_provider_connections_provider ON provider_connections(provider_name);

-- Bots
CREATE INDEX idx_bots_kb ON bots(knowledge_base_id);
CREATE INDEX idx_bots_provider ON bots(provider_connection_id);

-- Conversations
CREATE INDEX idx_conversations_bot ON conversations(bot_id);
CREATE INDEX idx_conversations_kb ON conversations(knowledge_base_id);
CREATE INDEX idx_conversations_updated ON conversations(bot_id, updated_at DESC);

-- Messages
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at ASC);

-- Agent Runs
CREATE INDEX idx_agent_runs_bot ON agent_runs(bot_id, started_at DESC);
CREATE INDEX idx_agent_runs_conversation ON agent_runs(conversation_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);

-- Tool Events
CREATE INDEX idx_tool_events_run ON tool_events(agent_run_id, sequence_number ASC);

-- Bot Memories
CREATE INDEX idx_bot_memories_bot ON bot_memories(bot_id);
CREATE INDEX idx_bot_memories_kb ON bot_memories(knowledge_base_id);
