-- Migration 013: Configurable Bot Response Policies (Phase 12 Step 12.3)
-- Adds persistent per-Bot `response_policy` column with strict CHECK constraint
-- and safe default `'balanced_kb_first'` for all legacy and newly created Bots.
-- Preserves all existing Bot rows, foreign keys, and relationships.

ALTER TABLE bots
  ADD COLUMN response_policy TEXT NOT NULL DEFAULT 'balanced_kb_first'
  CHECK (response_policy IN ('strict_kb_only', 'balanced_kb_first', 'general_ai_chat'));
