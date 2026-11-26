# Phase 12 — Step 12.1 Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.1 — Single Conversation per Bot: Database & Migration  
**Status:** Complete — Ready for Review & Authorization for Step 12.2  
**Date:** November 2026  

---

## 1. Executive Summary

Phase 12, Step 12.1 successfully establishes the database, repository, service, and backup import foundation for the core product invariant:

$$\text{One Bot} \longleftrightarrow \text{Exactly One Persistent Conversation}$$

Prior to this step:
- A Bot could own zero, one, or arbitrarily many conversation records.
- Creating a Bot did not create a conversation record; conversations were spawned lazily, on demand, or through user "New Chat" buttons.
- Normal Chat and Agent Tasks operated in parallel, sometimes creating orphaned or loosely associated conversation threads.
- In legacy backups (`v1.0.0`, `v1.1.0`), a Bot could have multiple conversation bundles.

In Step 12.1, this architecture has been fundamentally unified and hardened:
1. **Database Cardinality Hardening:** Added `bot_id TEXT NOT NULL UNIQUE` and composite key `UNIQUE (id, bot_id, knowledge_base_id)` to the `conversations` table in SQLite schema via forward migration `012_single_conversation_per_bot.sql`.
2. **Lossless Multi-Conversation Consolidation:** Implemented Migration 012 using the SQLite table-rebuild pattern with `disableForeignKeysForTableRebuild: true`. For each Bot with multiple historical conversations, the migration selects a deterministic canonical conversation (`created_at ASC, id ASC`), preserves its canonical ID, preserves all messages with verbatim content, original IDs, timestamps, roles, statuses, citations, and token usage, and re-links all associated `agent_runs` to the canonical conversation.
3. **Historical Boundary Preservation:** Created the `conversation_segments` table. Each merged conversation is cataloged as a distinct historical segment (`segment_order`, `original_conversation_id`, `message_count`, `started_at`, `ended_at`). Each message record is tagged with its `segment_id`. Future chat interfaces can cleanly delineate historical conversation boundaries with dividers without interleaving overlapping timestamps.
4. **Zero-Conversation Bot Recovery:** Bots with zero existing conversations automatically receive a canonical conversation and initial segment during migration execution.
5. **Atomic Bot & Conversation Creation Lifecycle:** Updated `BotManagerService.createBot` to execute bot creation and canonical conversation creation atomically inside a single SQLite transaction (`db.transaction`). A Bot cannot exist without its conversation.
6. **Idempotent Retrieval & Repository Hardening:** Extended `ConversationRepository` and `ConversationManagerService` with `getOrCreate(botId, knowledgeBaseId, title)` and `getByBotId(botId, knowledgeBaseId)`, guaranteeing that repeated requests never spawn duplicate conversations or raise unique constraint violations.
7. **Legacy Backup Import Consolidation:** Updated `BackupImportManager.ts` so that when importing legacy backups containing multiple conversation bundles per Bot, all messages, agent runs, and historical boundaries are consolidated into a single canonical conversation per Bot, recording legacy conversation IDs in `conversation_segments`.
8. **100% Passing Test Suite:** Verified all 210 test files (3,199 tests passed, 0 failures), passed `npm run typecheck`, and verified a clean production build (`npm run build`).

---

## 2. Complete Schema Changes and Migration Mechanism

### 2.1 Migration 012 Definition

- **File:** `src/main/database/migrations/012_single_conversation_per_bot.sql`
- **Migration Index:** Version `12`, description `'single_conversation_per_bot'`
- **Rebuild Configuration:** Registered with `disableForeignKeysForTableRebuild: true` in `runner.ts` / migration registry.

### 2.2 Schema Alterations

```sql
-- 1. Conversation Segments Table (New in Migration 012)
CREATE TABLE conversation_segments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    original_conversation_id TEXT NOT NULL,
    segment_order INTEGER NOT NULL,
    title TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, segment_order),
    UNIQUE (conversation_id, original_conversation_id)
);

-- 2. Conversations Table (Rebuilt with UNIQUE bot_id)
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL,
    bot_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id) ON DELETE CASCADE,
    UNIQUE (id, bot_id, knowledge_base_id)
);

-- 3. Messages Table (Rebuilt with segment_id column)
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming', 'completed', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    metadata_json TEXT,
    citations_json TEXT,
    token_usage_json TEXT,
    segment_id TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (segment_id) REFERENCES conversation_segments(id) ON DELETE SET NULL
);
```

### 2.3 Indexes Maintained & Added

1. `idx_conversations_bot` on `conversations(bot_id)` — **UNIQUE** index enforcing one conversation per bot.
2. `idx_conversations_kb` on `conversations(knowledge_base_id)` — for KB-scoped queries and cascading deletion.
3. `idx_conversations_updated` on `conversations(updated_at DESC)` — for LRU sorting.
4. `idx_messages_conversation` on `messages(conversation_id, created_at ASC)` — for chronological turn rendering.
5. `idx_messages_segment` on `messages(segment_id)` — for segment boundary queries.
6. `idx_conversation_segments_conv` on `conversation_segments(conversation_id, segment_order ASC)` — for segment chronological rendering.
7. `idx_conversation_segments_orig` on `conversation_segments(original_conversation_id)` — for provenance lookups.

Total database tables: **16** (verified in `schema.test.ts`).  
Total database indexes: **32** (verified in `schema.test.ts`).

---

## 3. Consolidation Strategy and Historical Boundary Preservation

### 3.1 Canonical Conversation Selection

When a Bot has multiple conversations, Migration 012 deterministically ranks them:

$$\text{Canonical Conversation} = \operatorname{argmin}_{(created\_at,\, id)} (\text{conversations where bot\_id} = B)$$

```sql
ranked_conversations AS (
    SELECT
        id AS original_conv_id,
        bot_id,
        knowledge_base_id,
        title,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
            PARTITION BY bot_id
            ORDER BY created_at ASC, id ASC
        ) AS rank_order,
        FIRST_VALUE(id) OVER (
            PARTITION BY bot_id
            ORDER BY created_at ASC, id ASC
        ) AS canonical_conv_id
    FROM conversations
)
```

- Rank 1 conversation becomes the canonical record in `conversations`.
- The canonical conversation retains its original `id`, `knowledge_base_id`, and `bot_id`.
- If a Bot previously had zero conversations, Migration 012 creates a synthetic canonical conversation with `id = 'conv_init_' || bot.id` and title `'Default Conversation'`.

### 3.2 Historical Boundary Segmentation (`conversation_segments`)

To avoid interleaving distinct conversations when their message timestamps overlap:
- Every original conversation belonging to the Bot is recorded in `conversation_segments`.
- `segment_order` is assigned based on the original conversation's `created_at ASC, id ASC` (`rank_order - 1`).
- `started_at` is computed as `MIN(messages.created_at)`.
- `ended_at` is computed as `MAX(messages.created_at)`.
- `message_count` reflects the count of messages originating from that conversation.
- Every message has its `segment_id` set to its original conversation ID (`m.segment_id = m.conversation_id`).
- All messages update their `conversation_id` to `canonical_conv_id`.

### 3.3 Agent Runs and Tool Events Re-linking

- In `agent_runs`, `conversation_id` is updated to point to the canonical conversation:
  ```sql
  UPDATE agent_runs
  SET conversation_id = (SELECT canonical_conv_id FROM ranked_conversations WHERE original_conv_id = agent_runs.conversation_id)
  WHERE conversation_id IN (SELECT original_conv_id FROM ranked_conversations);
  ```
- All `agent_runs.id`, `task_id`, `status`, token usage, timestamps, and child `agent_tool_events` records remain completely untouched and reference their existing valid foreign keys.

---

## 4. Data Preservation Proof

| Artifact / Property | Preservation Mechanism | Verification Test |
| :--- | :--- | :--- |
| **Message IDs** | Verbatim copy during rebuild (`INSERT INTO messages SELECT ...`) | `012_single_conversation_per_bot.test.ts` (Test 1, Test 2) |
| **Message Content** | Verbatim text preserved, no truncation or rewriting | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Message Roles** | Preserved (`user`, `assistant`, `system`) | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Original Timestamps** | Retained verbatim; no timestamps overwritten | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Message Ordering** | Maintained within segments; segments ordered deterministically | `012_single_conversation_per_bot.test.ts` (Test 3) |
| **Citations JSON** | Retained verbatim in `citations_json` | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Token Usage JSON** | Retained verbatim in `token_usage_json` | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Metadata JSON** | Retained verbatim in `metadata_json` | `012_single_conversation_per_bot.test.ts` (Test 2) |
| **Agent Runs** | Re-linked to canonical conversation ID; all run records preserved | `012_single_conversation_per_bot.test.ts` (Test 4) |
| **Tool Events** | Child records linked via `agent_run_id`; 100% preserved | `012_single_conversation_per_bot.test.ts` (Test 4) |
| **Foreign Keys** | SQLite table rebuild executed with `PRAGMA foreign_key_check` passing with 0 errors | `012_single_conversation_per_bot.test.ts` (Test 6) |

---

## 5. Backend Service and Lifecycle Updates

### 5.1 Bot Lifecycle (`BotManagerService`)
- Updated `createBot` to accept optional `conversationRepo` and `db`.
- Wrapped bot insertion and initial canonical conversation + segment creation in an atomic `db.transaction(...)`:
  ```typescript
  const runTx = this.db ? this.db.transaction.bind(this.db) : <T>(fn: () => T): (() => T) => fn;
  const executeCreation = runTx(() => {
    this.botRepo.create(bot);
    if (this.conversationRepo) {
      this.conversationRepo.create({
        id: randomUUID(),
        knowledgeBaseId: bot.knowledgeBaseId,
        botId: bot.id,
        title: `${bot.name} Conversation`
      });
    }
    return bot;
  });
  return executeCreation();
  ```
- Guaranteed: No Bot can be committed to the database without its canonical conversation.

### 5.2 Conversation Lifecycle (`ConversationRepository` & `ConversationManagerService`)
- Added `getOrCreate(botId, knowledgeBaseId, title)`:
  - If a conversation already exists for the Bot, it is returned immediately.
  - If not, a new canonical conversation and its initial segment are created atomically.
  - Handles concurrent races safely by catching unique constraint errors and falling back to retrieval.
- Added `getByBotId(botId, knowledgeBaseId)` and `getByBotIdOnly(botId)`:
  - Direct, fast lookup via the `UNIQUE(bot_id)` index without requiring full table scans.
- Added `getSegments(conversationId)`:
  - Retrieves all historical segments sorted by `segment_order ASC`.
- Updated `createConversation` to be idempotent: callers requesting creation for a bot that already has a conversation receive the canonical conversation without error.

### 5.3 Backup Import Consolidation (`BackupImportManager`)
- Enhanced `executeImport` for legacy archives (`v1.0.0`, `v1.1.0`) containing multiple conversations per bot:
  - Groups incoming conversation bundles by `bot_id`.
  - Designates bundle 0 as the canonical conversation (`canonicalConvId = bundle.conversation.id`).
  - Creates a historical segment in `conversation_segments` for every legacy conversation bundle.
  - Remaps `conversation_id` on all imported messages to `canonicalConvId`, setting `segment_id` to the original bundle conversation ID.
  - Links all imported agent runs to `canonicalConvId`.
  - For any imported bot without conversation bundles, automatically generates an initial canonical conversation and segment.
  - Successfully tested in `backup-import-manager.test.ts` (Test 8d).

---

## 6. Verification Results

### 6.1 Unit & Integration Test Suites

| Test Suite File | Tests Passed | Status | Coverage Focus |
| :--- | :---: | :---: | :--- |
| `src/main/database/migrations/012_single_conversation_per_bot.test.ts` | 7 / 7 | PASS | Migration 012 table rebuild, multi-conv consolidation, segments, agent runs, zero-conv bot handling, FK check |
| `src/main/services/conversation-lifecycle-phase12.test.ts` | 7 / 7 | PASS | Atomic `createBot` + conversation, idempotent `getOrCreate`, segment listing, message segment assignment |
| `src/main/database/schema.test.ts` | 15 / 15 | PASS | 16 core tables, 32 indexes, foreign key cascades, column definitions |
| `src/main/database/migrations.test.ts` | 25 / 25 | PASS | All 12 forward migrations run clean from scratch, rollback integrity |
| `src/main/database/repositories/conversation-repository.test.ts` | 24 / 24 | PASS | Unique bot_id constraint, getByBotId, getOrCreate, segment retrieval |
| `src/main/database/repositories/message-repository.test.ts` | 26 / 26 | PASS | segment_id column, message creation, segment stats update, listByConversation |
| `src/main/services/conversation-manager.test.ts` | 21 / 21 | PASS | Idempotent creation, getConversationForBot, getSegments, message turn flow |
| `src/main/services/bot-manager.test.ts` | 9 / 9 | PASS | Bot creation, validation, atomic conversation creation |
| `src/main/services/backup-import-manager.test.ts` | 18 / 18 | PASS | Legacy multi-conversation archive consolidation (Test 8d), atomicity, rollbacks |
| `src/main/services/agent-task-service.test.ts` | 26 / 26 | PASS | Task execution, run persistence, tool event isolation |
| `src/main/services/deletion-service.test.ts` | 17 / 17 | PASS | Knowledge Base deletion, Bot deletion cascading to conversation & segments |
| `src/main/services/conversation-service.test.ts` | 46 / 46 | PASS | Conversation turn orchestration, context budgeting, cancellation |

### 6.2 Full Test Suite Execution

Ran `npm run test` across the entire workspace:
- **Test Files:** **210 passed (210)**
- **Tests:** **3,199 passed (3,199)**
- **Failures:** **0**
- **Duration:** 83.97s

### 6.3 TypeScript Typecheck & Production Build

- **Typecheck Node:** `tsc --noEmit -p tsconfig.node.json --composite false` — **0 errors**
- **Typecheck Web:** `tsc --noEmit -p tsconfig.web.json --composite false` — **0 errors**
- **Production Bundle:** `electron-vite build` — **Built in 1,575ms** (main, preload, and renderer packages clean).

---

## 7. Git and Working-Tree Safety Baseline

- **Branch:** `main` (commit `ff3f157`)
- **Staged Changes:** None (`git add` was not executed)
- **Committed Changes:** None
- **Pushed Changes:** None
- **Phase 11.12 Preserved Files:** All 12 user-modified files from Phase 11.12 remain untouched and preserved.

---

## 8. Architectural Notes and Recommendations for Step 12.2

### Step 12.2 Scope: Unified Chat Interface & Bot Selection
In Step 12.2, the frontend chat interface will be redesigned around the unified Bot experience:
1. **Direct Bot Selection:** Clicking a Bot in the Knowledge Base navigation immediately opens its one persistent conversation. The concept of an independent "Conversations list" sidebar inside a Bot view will be retired.
2. **Historical Segment Rendering:** Using `conversationRepo.getSegments(conversationId)`, the UI can display clean historical break markers (e.g., *"Previous Conversation — Archived Nov 2026"*), separating historical threads without altering message continuity.
3. **Session Clears / New Thread Semantics:** When a user requests a "New Chat" or "Reset Conversation" for a Bot, rather than creating a new conversation record, the backend can close the current segment and start a new active segment, or archive the existing messages within the same canonical conversation.
4. **Unified Input Area:** The input box will offer clean switching between Normal Chat and Agent Task mode while writing to the same conversation timeline.

---

## 9. Conclusion

Step 12.1 is fully implemented, verified, and complete. All database constraints, migrations, repositories, lifecycles, and import consolidations are operational with zero data loss and 100% passing tests. Ready to proceed to Step 12.2 upon authorization.
