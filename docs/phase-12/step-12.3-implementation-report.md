# Phase 12 — Step 12.3 Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.3 — Configurable Bot Response Policies  
**Branch / Base Commit:** `main` @ `ff3f157` (working tree includes preserved Phase 11.12, Step 12.1, and Step 12.2 changes; nothing staged or committed)  
**Status:** Completed and verified at the Step 12.3 gate

---

## 1. Objective Summary

Step 12.3 adds persistent, strongly typed, per-Bot response policies while keeping Agent tool permissions completely independent:

1. `strict_kb_only` — Strict Knowledge Base Only
2. `balanced_kb_first` — Knowledge Base First (Balanced) *(default for newly created and legacy Bots)*
3. `general_ai_chat` — General AI Chat

In scope for Step 12.3:
- Shared policy domain model, metadata, validation schemas, and DTO conversion.
- SQLite Migration `013` (`bot_response_policies`) adding `response_policy` to `bots` cleanly with `NOT NULL DEFAULT 'balanced_kb_first'` and `CHECK` constraints.
- Repository, Manager, IPC, Preload, and Backup Export/Import support.
- Bot Creation, Bot Editing, Bot Card, and Conversation Workspace header UI updates.
- Policy-selection boundary separating `strict_kb_only` from `balanced_kb_first` and `general_ai_chat` without prematurely implementing Step 12.4 Balanced RAG scoring or Step 12.5 provenance-aware grounding validation.

---

## 2. Investigation of Step 12.1 (`3,199`) vs. Step 12.2 (`3,198`) Test-Count Discrepancy

An exact diff against `HEAD` and Step 12.2 test logs accounted for the `-1` net test count change (`3,199 -> 3,198`, `210` files unchanged), confirming no test was accidentally lost:

- **Deleted obsolete multi-conversation test files (`-19` tests across `-2` files):**
  - `src/renderer/src/components/chat/DeleteConversationDialog.test.tsx`: `-9`
  - `src/renderer/src/hooks/useConversations.test.tsx`: `-10`
- **Created replacement canonical-conversation test files (`+11` tests across `+2` files):**
  - `src/renderer/src/hooks/useBotConversation.test.tsx`: `+6`
  - `src/renderer/src/components/chat/ClearConversationDialog.test.tsx`: `+5`
- **Updated existing suites (`+7` net tests):**
  - `src/main/database/repositories/conversation-repository.test.ts`: `24 -> 28` (`+4`)
  - `src/main/database/repositories/message-repository.test.ts`: `26 -> 28` (`+2`)
  - `src/main/services/conversation-manager.test.ts`: `21 -> 27` (`+6`)
  - `src/main/ipc/conversation-bridge.test.ts`: `32 -> 36` (`+4`)
  - `src/shared/conversations.test.ts`: `45 -> 46` (`+1`)
  - `src/renderer/src/hooks/useConversationMessages.test.tsx`: `8 -> 9` (`+1`)
  - `src/renderer/src/components/chat/ChatPresentation.test.tsx`: `24 -> 16` (`-8`; removed 9 retired `ConversationSidebar` tests, updated 2 `ConversationEmptyState` tests in-place, added 1 segment header test)
  - `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.test.tsx`: `28 -> 25` (`-3`; retired multi-conversation create/switch/rename/delete UI tests and added canonical workspace open, reopen, rapid switching, segment boundary ordering, clear conversation, and recoverable error tests)
- **Net Check:** `-9 - 10 + 6 + 5 + 4 + 2 + 6 + 4 + 1 + 1 - 8 - 3 = -1` (`3,199 -> 3,198`).

---

## 3. Database Schema & Migration 013

- Added [`013_bot_response_policies.sql`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/013_bot_response_policies.sql) and registered version `13` (`bot_response_policies`) in [`index.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/index.ts).
- DDL:
  ```sql
  ALTER TABLE bots
    ADD COLUMN response_policy TEXT NOT NULL DEFAULT 'balanced_kb_first'
    CHECK (response_policy IN ('strict_kb_only', 'balanced_kb_first', 'general_ai_chat'));
  ```
- Verified in [`013_bot_response_policies.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/013_bot_response_policies.test.ts):
  - Migrates pre-v13 databases and assigns existing Bots `'balanced_kb_first'` without breaking `knowledge_base_id`, `provider_connection_id`, `conversations`, `bot_memories`, or `agent_runs` foreign keys (`PRAGMA foreign_keys = ON`, `PRAGMA foreign_key_check === []`).
  - Fresh v13 bootstrap defaults omitted SQL inserts to `'balanced_kb_first'` and enforces `NOT NULL` + `CHECK`.
  - Preserves explicit valid values across repeated `runMigrations` invocations (idempotent).
  - Transactional rollback preserves v12 schema and existing Bot records if migration 13 fails.

---

## 4. Domain Model, Validation, Persistence & IPC Contracts

- **Shared Contracts ([`src/shared/bots.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/bots.ts)):**
  - Defined `BOT_RESPONSE_POLICIES`, `BotResponsePolicy`, `DEFAULT_BOT_RESPONSE_POLICY` (`'balanced_kb_first'`), `BOT_RESPONSE_POLICY_METADATA`, `botResponsePolicySchema`, `isBotResponsePolicy`, `resolveBotResponsePolicy`, and `getBotResponsePolicyMeta`.
  - Added required `responsePolicy: BotResponsePolicy` on `BotDto`, optional `responsePolicy` on `CreateBotRequest` (defaulting to `'balanced_kb_first'` in `createBotRequestSchema`) and `UpdateBotRequest` (validating single-field policy updates in `updateBotRequestSchema`), and normalized camelCase/snake_case inputs with safe fallback in `toBotDto`.
- **Database & Repository ([`types.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/repositories/types.ts), [`bot-repository.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/repositories/bot-repository.ts)):**
  - Updated `Bot`, `CreateBotInput`, `UpdateBotInput`, `createBotSchema`, `updateBotSchema`, `BotRow`, `create`, `getById`, `getByIdOnly`, `listByKnowledgeBase`, `update`, and `mapRowToBot`.
  - `mapRowToBot` validates stored `response_policy` via Zod and throws `RepositoryError` on corruption.
- **Manager & IPC ([`bot-manager.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/bot-manager.ts), [`bot-handlers.ts`](file:///d:/projects_electron/local%20bots/project/src/main/ipc/bot-handlers.ts), [`preload/index.ts`](file:///d:/projects_electron/local%20bots/project/src/preload/index.ts)):**
  - Persists default and explicit policies on creation and supports updating `responsePolicy` without mutating `enabledTools` (and vice versa).
  - Preserves Main-process `knowledgeBaseId` resolution (`ActiveWorkspaceContext`) and strict schema rejection of unauthorized fields.

---

## 5. Backup Export & Import Compatibility

- Updated `ExportBotDto` and `exportBotDtoSchema` in [`src/shared/export-archive.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/export-archive.ts) with optional `responsePolicy?: BotResponsePolicy`.
- Updated [`backup-export-manager.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/backup-export-manager.ts) to serialize `responsePolicy: bot.responsePolicy` into `bots.json` without exposing credentials.
- Updated [`backup-import-manager.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/backup-import-manager.ts) to persist `resolveBotResponsePolicy(bot.responsePolicy)` on import:
  - Preserves explicit valid policies on re-import.
  - Defaults legacy pre-12.3 archives lacking `responsePolicy` to `'balanced_kb_first'`.
  - Rejects archives containing invalid `responsePolicy` enum values at schema validation.

---

## 6. Policy Selection Boundary in Chat Execution Pipeline

- [`rag-prompt-builder.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/rag-prompt-builder.ts): Extended `BotPromptConfig` and `buildSystemInstruction` with `responsePolicy` (`DEFAULT_BOT_RESPONSE_POLICY` default).
  - `'strict_kb_only'` uses `KnowledgeBaseOnlyPolicy.buildGroundingSystemInstruction`.
  - `'balanced_kb_first'` and `'general_ai_chat'` use policy-appropriate instructions that remove Strict KB Only's general-knowledge prohibition while retaining untrusted `<retrieved_context>` injection protections and strict no-citation-fabrication rules.
- [`conversation-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.ts): Added `responsePolicy: BotResponsePolicy` onto `PreparedConversationTurn` and passed `bot.responsePolicy` into `ConversationContextManager.selectContext`.
- [`conversation-turn-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts): Extracted `getPreFlightRefusalText` and `applyPostFlightResponsePolicy` across `executeSendTurn` and `executeRetryTurn`:
  - `strict_kb_only` continues enforcing pre-flight `NO_RESULTS` / `RETRIEVAL_DISABLED` / `EMPTY_QUERY` deterministic refusals and post-flight `KnowledgeBaseOnlyPolicy.validateGroundedResponse`.
  - `balanced_kb_first` and `general_ai_chat` execute without silently falling back to Strict KB Only refusals or `UNGROUNDED_RESPONSE` rejection, while citation linking in `ConversationPersistenceService` continues resolving strictly against authentic `citationMap` entries.
- Explicit Strict KB Only integration fixtures in [`knowledge-base-only-integration.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/knowledge-base-only-integration.test.ts) and tight token-budget math in [`conversation-context-manager.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-context-manager.test.ts) (Test 42) were updated to specify `responsePolicy: 'strict_kb_only'` explicitly.
- **Deferred intentionally:** Balanced evidence scoring/partial-evidence guidance (Step 12.4) and provenance-aware grounding validation (Step 12.5).

---

## 7. Bot Creation, Bot Editing & Conversation Workspace UI

- [`BotConfigurationForm.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/bots/BotConfigurationForm.tsx) & [`main.css`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/assets/main.css):
  - Added a dedicated **Knowledge and Response Behavior** section (`data-testid="bot-response-policy-section"`) displaying parent Knowledge Base context (`data-testid="parent-kb-indicator"`) and accessible radio cards for all three policies with plain-language descriptions, `balanced_kb_first` preselected, and a `Recommended` badge (`data-testid="policy-recommended-badge"`), strictly separate from **Enabled Tools**.
- [`CreateBotModal.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/bots/CreateBotModal.tsx), [`EditBotModal.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/bots/EditBotModal.tsx), and [`WorkspaceBotsPage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/WorkspaceBotsPage.tsx):
  - Passed `knowledgeBaseName` to both modals, submitted selected `responsePolicy`, and keyed `EditBotModal`'s form on `${bot.id}-${bot.updatedAt}` so failed saves never leave optimistic values across reopen/reload.
- [`BotCard.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/bots/BotCard.tsx) & [`BotConversationsWorkspacePage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx):
  - Rendered the persisted Bot `responsePolicy` badge (`data-testid="bot-response-policy"`) with short labels on Bot cards and full human-readable labels (`Strict Knowledge Base Only`, `Knowledge Base First (Balanced)`, `General AI Chat`) in the conversation workspace header.

---

## 8. Verification Results

All checks ran cleanly after the final code/test edit:

| Check | Command | Exit Code | Observed Output Summary |
| --- | --- | --- | --- |
| Type Checking | `npm run typecheck` | `0` | `tsc --noEmit` passed with 0 errors across `tsconfig.node.json` and `tsconfig.web.json` |
| Linting | `npm run lint` | `0` | 0 errors; 3 pre-existing warnings (`backup-export-manager.ts` L313/316 Prettier; `BotConfigurationForm.tsx` L223 `react-hooks/exhaustive-deps`) |
| Test Suite | `npm run test` | `0` | **211 / 211 test files passed**, **3,228 / 3,228 tests passed** (+1 test file, +30 net tests over Step 12.2's 3,198 baseline) |
| Production Build | `npm run build` | `0` | `typecheck` + `electron-vite build` succeeded for `main`, `preload`, and `renderer` bundles |

---

## 9. Scope Boundary & Gate Notice

Implementation stops cleanly at the Step 12.3 gate:
- Git working tree remains unstaged and uncommitted with all Phase 11.12, Step 12.1, and Step 12.2 changes intact.
- Step 12.4 (Balanced RAG retrieval & evidence assessment), Step 12.5 (provenance-aware grounding & citation validation), and Step 12.6 (Normal Chat vs. Agent Task execution separation) were **not** implemented here and await authorization for Step 12.4.
