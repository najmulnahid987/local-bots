# Phase 12 — Step 12.0: Architecture Audit & Preflight Report

**Project:** Local-First Multi-Model AI Agent Workspace (Local Bots)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.0 — Architecture Audit & Preflight  
**Status:** Audit Complete — No Implementation Performed  
**Date:** November 2026  
**Auditor:** Antigravity (Gemini 3.8 High)  

---

## 1. Executive Summary

Phase 12 ("Unified Bot Experience") aims to transform the interaction model of Local Bots from fragmented, multi-thread chat sessions and disjointed agent execution into a cohesive, sovereign, and verifiable bot workspace. Specifically, Phase 12 is scheduled to deliver:
1. **One Persistent Conversation Per Bot:** Replacing unbounded, ephemeral multi-thread sprawl with an invariant 1:1 Bot-to-Conversation model.
2. **Deterministic History Consolidation:** Safely uniting historical multi-conversation threads into canonical per-bot streams while strictly preserving provenance, metadata, tool events, and chronological integrity.
3. **Configurable Response Policies:** Providing explicit control over grounding modes:
   - *Strict Knowledge Base Only* (mandatory citation grounding; refusal when unevidenced).
   - *Knowledge Base First (Balanced)* (primary KB retrieval with verified citations; transparent fallback to general AI reasoning with explicit evidence demarcation).
   - *General AI Chat* (unconstrained reasoning respecting bot persona and memory without requiring KB citations).
4. **Balanced RAG & Evidence Sufficiency:** Assessing retrieval completeness, detecting partial vs. absent evidence, and avoiding silent refusals when general model assistance is permitted.
5. **Provenance-Aware Grounding & Verification:** Fine-grained claim-level citation validation distinguishing grounded claims from model knowledge.
6. **Strict Chat vs. Agent Task Separation:** Clear boundaries between lightweight conversational turns and bounded multi-step autonomous agent tasks.
7. **Provisional Streaming & Validation Lifecycle:** Preventing ungrounded or invalid responses from flashing as final before post-stream validation completes.
8. **Bot Creation & Management Refinements:** Streamlining bot configuration with response policy selectors, tool permission matrices, and execution safety settings.
9. **Backward-Compatible Backup & Import:** Ensuring historical multi-conversation archive bundles (`v1.0.0`, `v1.1.0`) import cleanly into the 1:1 conversation model.

This preflight audit establishes the ground-truth technical state of the repository before any code or schema alterations are executed for Phase 12. No application code, database migrations, or test doubles were modified or implemented during this audit.

---

## 2. Repository Baseline Audit

### 2.1 Git Repository State
- **Current Branch:** `main` (synchronized with `origin/main`).
- **Current HEAD Commit:** `ff3f1579193109a28a8a1079518b6fea9639a43a` ("i just complete phase 11").
- **Working-Tree Status:** 12 tracked modified files; 0 untracked files.
  - `src/main/documents/extraction/pptx/pptx-fidelity.test.ts`
  - `src/main/documents/extraction/pptx/pptx-ooxml-parser.ts`
  - `src/main/documents/lifecycle/document-lifecycle-service.ts`
  - `src/main/documents/model/schema.ts`
  - `src/main/documents/model/universal-document.test.ts`
  - `src/main/documents/validation/extraction-completeness-evaluator.test.ts`
  - `src/main/documents/validation/extraction-completeness-evaluator.ts`
  - `src/main/documents/validation/source-element-inventory.test.ts`
  - `src/main/documents/validation/source-element-inventory.ts`
  - `src/main/documents/validation/types.ts`
  - `src/main/services/backup-import-manager.test.ts`
  - `src/main/services/backup-import-manager.ts`
- **Origin of Working Tree Modifications:** These 12 files contain the Phase 11.12 corrective implementations (source-grounded element inventory, textual fidelity calculation, safe backup quarantine/rollback, and chunk regeneration with freshness validation). They are uncommitted.

### 2.2 System & Runtime Environment
- **Operating System:** Windows 11 (x64)
- **Node.js:** `v24.21.0`
- **npm:** `11.19.0`
- **Electron:** `44.7.2` (via devDependencies)
- **Frontend Framework:** React `19.3.0`, React DOM `19.3.0`, React Router DOM `7.18.5`
- **TypeScript:** `5.9.3`
- **Vite / Electron-Vite:** Vite `8.3.4`, Electron-Vite `6.0.0`
- **CSS / UI:** Tailwind CSS, Lucide React `1.70.0`
- **AI SDK:** Vercel AI SDK `ai@7.0.164`, `@ai-sdk/openai@4.0.110`, `@ai-sdk/anthropic@4.0.98`, `@ai-sdk/google@4.0.112`
- **Database Engine:** `better-sqlite3@13.0.3` (WAL mode enabled, FTS5 with Porter stemmer)
- **Database Storage Path:** `<userData>/workspace.db` (resolved in Main process via `app.getPath('userData')`). In development: `%APPDATA%/local-first-ai-workspace/workspace.db`.

### 2.3 Verification Scripts & Baseline Execution Results
The repository defines the following authoritative verification scripts in `package.json`:
- **Type Checking:** `npm run typecheck` (`npm run typecheck:node && npm run typecheck:web`)
- **Linting:** `npm run lint` (`eslint --cache .`)
- **Unit & Integration Tests:** `npm run test` (`vitest run`)
- **Production Packaging / Build:** `npm run build` (`npm run typecheck && electron-vite build`)

#### Baseline Check Execution Results:
1. **Typecheck (`npm run typecheck`):**
   - Result: **PASSED (Exit code 0)**.
   - Node and Web TypeScript configurations compiled without any diagnostic errors.
2. **Linting (`npm run lint`):**
   - Result: **PASSED (Exit code 0)** with 1 pre-existing warning:
     `D:\projects_electron\local bots\project\src\renderer\src\components\bots\BotConfigurationForm.tsx:213:6: warning: React Hook useEffect has a missing dependency: 'discoveredModels'`.
   - Zero ESLint errors.
3. **Test Suite (`npm run test`):**
   - Result: **PASSED (Exit code 0)**.
   - Test Files: **208 passed (208 total)**.
   - Tests: **3,184 passed (3,184 total)**.
   - Total Duration: 70.06 seconds.
4. **Production Build (`npm run build`):**
   - Result: **PASSED (Exit code 0)**.
   - Main process bundle, Preload bridge, and Renderer client assets generated cleanly in `out/`.

---

## 3. Actual Bot/Conversation Relationship

### 3.1 Data Model & Cardinality Analysis
- **Schema Reference:** `src/main/database/migrations/001_initial_schema.sql` [L94-106].
  ```sql
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
  ```
- **Current Cardinality:** One-to-Many (`1 : N`). A single Bot can own an arbitrary number of conversation rows because the unique constraint is `UNIQUE (id, bot_id, knowledge_base_id)`, where `id` is a newly generated UUIDv4 for each thread.
- **Absence of Bot Foreign Key to Conversation:** The `bots` table [L72-92] has NO column or reference linking to a default or active conversation.
- **Bot Creation Invariant:** In `BotManagerService.createBot` (`src/main/services/bot-manager.ts` [L148-189]), creating a Bot only inserts into `bots`. It **never creates an initial conversation**.
- **Can a Bot Exist Without Conversations?** **YES.** A newly created Bot has zero conversations until a user explicitly clicks "New Conversation" or sends an initial message.
- **Can Multiple Conversations Be Created Concurrently?** **YES.** Because `ConversationRepository.create` (`src/main/database/repositories/conversation-repository.ts` [L45-97]) generates a fresh `randomUUID()` for `conversations.id` on every invocation, concurrent IPC calls for the same `bot_id` will insert multiple distinct conversation records without collision.

---

## 4. Conversation Architecture Audit: Questions & Findings

### Q1: Can one Bot currently own multiple conversation records?
**Answer:** **YES.** The database schema enforces `FOREIGN KEY (bot_id, knowledge_base_id) REFERENCES bots(id, knowledge_base_id)`, but does not enforce uniqueness on `bot_id`. A Bot can own zero, one, or dozens of conversation records.

### Q2: Which service or API creates a conversation?
**Answer:**
- **Main Process API:** `ConversationManagerService.createConversation(sessionId, request)` in `src/main/services/conversation-manager.ts` [L141-175].
- **Repository Method:** `ConversationRepository.create(input)` in `src/main/database/repositories/conversation-repository.ts` [L45-97].
- **IPC Handler:** `ipcMain.handle(CONVERSATION_IPC_CHANNELS.CREATE, ...)` in `src/main/ipc/conversation-handlers.ts` [L74-86].
- **Preload Bridge:** `window.api.conversation.createConversation(request)` exposed via `src/preload/index.ts`.

### Q3: Can multiple conversations be created concurrently for the same Bot?
**Answer:** **YES.** There is no database lock, mutex, or unique constraint on `(bot_id, knowledge_base_id)` in the `conversations` table. Concurrent IPC requests generate unique UUIDs and both insert successfully.

### Q4: Does every Bot currently have at least one conversation?
**Answer:** **NO.** Newly created Bots start with 0 conversations. Furthermore, if all conversations of a Bot are deleted via `ConversationManagerService.deleteConversation` (`src/main/services/conversation-manager.ts` [L260-310]), the Bot remains with 0 conversations.

### Q5: Can a Bot exist without a conversation?
**Answer:** **YES.** Both the database schema and application lifecycle permit a Bot to exist with zero conversations.

### Q6: How does the Renderer select and open a conversation?
**Answer:**
- In `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx` [L99-116], the page invokes the `useConversations({ botId, enabled })` hook (`src/renderer/src/hooks/useConversations.ts` [L58-144]).
- The hook queries `window.api.conversation.listConversations({ botId })`.
- By default, `selectedConversationId` initializes to `null`.
- In `BotConversationsWorkspacePage.tsx` [L701-725], if `selectedConversation` is null, the right panel renders `ConversationEmptyState` (`variant="no-selection"`) displaying "No Conversation Selected".
- The user must explicitly click a conversation thread item in `ConversationSidebar.tsx` [L31-35] to trigger `selectConversation(id)`, setting `selectedConversationId`.

### Q7: Where is the New Conversation action implemented?
**Answer:**
- **UI Trigger:** `ConversationSidebar.tsx` [L55-64, L150-180] features a "+ New Conversation" button and an inline title input.
- **Empty State Trigger:** `ConversationEmptyState.tsx` [L61-71] provides a "New Conversation" button when no thread is selected.
- **Hook Method:** `useConversations.ts` [L178-210] defines `createConversation(title?)` which calls `window.api.conversation.createConversation({ botId, title })`.

### Q8: Do Normal Chat and Agent Tasks currently share conversation records?
**Answer:** **YES.** Normal Chat turns (`ConversationTurnService.sendMessage` in `src/main/services/conversation-turn-service.ts` [L344-421]) and explicit Agent Tasks (`AgentTaskService.dispatchTask` in `src/main/services/agent-task-service.ts` [L318-655]) operate on the **identical `conversationId`**.
- In an Agent Task, the user task prompt is persisted into `messages` (`role: 'user'`) at line 530.
- When the bounded agent completes, the final synthesis is persisted into `messages` (`role: 'assistant'`) at line 616 with tool events mapped into `metadata_json.toolCalls`.
- The `agent_runs` record references the conversation via `conversation_id`.
- Both normal chat messages and agent task executions appear chronologically mixed in `ConversationMessageList.tsx`.

### Q9: Which database tables reference conversation IDs?
**Answer:**
1. `messages`: `conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE` (`001_initial_schema.sql` [L111, L118]).
2. `agent_runs`: `conversation_id TEXT, FOREIGN KEY (conversation_id, bot_id, knowledge_base_id) REFERENCES conversations(id, bot_id, knowledge_base_id) ON DELETE CASCADE ON UPDATE CASCADE` (`001_initial_schema.sql` [L125, L135]).
3. *(Indirect via `agent_runs`)* `tool_events`: references `agent_run_id REFERENCES agent_runs(id) ON DELETE CASCADE` (`001_initial_schema.sql` [L141, L152]).
No other SQLite tables contain `conversation_id`.

### Q10: Which services depend on conversation IDs?
**Answer:**
- `ConversationRepository` (`src/main/database/repositories/conversation-repository.ts`)
- `MessageRepository` (`src/main/database/repositories/message-repository.ts`)
- `AgentRunRepository` (`src/main/database/repositories/agent-run-repository.ts`)
- `ConversationManagerService` (`src/main/services/conversation-manager.ts`)
- `ConversationTurnService` (`src/main/services/conversation-turn-service.ts`)
- `ConversationService` (`src/main/services/conversation-service.ts`)
- `ConversationExecutionService` (`src/main/services/conversation-execution-service.ts`)
- `ConversationPersistenceService` (`src/main/services/conversation-persistence-service.ts`)
- `ConversationContextManager` (`src/main/services/conversation-context-manager.ts`)
- `AgentTaskService` (`src/main/services/agent-task-service.ts`)
- `BoundedAgentRuntime` (`src/main/services/bounded-agent-runtime.ts`)
- `BackupExportManager` (`src/main/services/backup-export-manager.ts`)
- `BackupImportManager` (`src/main/services/backup-import-manager.ts`)

### Q11: How are messages ordered?
**Answer:**
- In `MessageRepository.listByConversation` (`src/main/database/repositories/message-repository.ts` [L260]):
  `ORDER BY m.created_at ASC, m.id ASC`
- During insertion (`MessageRepository.create` [L124-127]):
  `effectiveCreatedAt = Math.max(now, latestMsg.max_created_at + 1)`
  This guarantees strictly monotonic timestamps for messages within a single conversation thread.
- *Critical Finding:* Monotonicity is only enforced *intra-conversation*. Across different conversation threads of the same Bot, timestamps may overlap or be interleaved.

### Q12: How are citations and attachments linked to messages?
**Answer:**
- **Citations:** There is **no separate `citations` relational table**. Citations are stored as a JSON array of `CitationDto` objects serialized inside `messages.metadata_json` [L97, L115 of `001_initial_schema.sql`]. In `ConversationPersistenceService.persistAssistantMessage` (`src/main/services/conversation-persistence-service.ts` [L190-250]), authentic citations matched from the execution citation map are placed into `metadata.citations`.
- **Attachments:** Attachments do **not exist** in the schema, database, IPC contracts, or UI components. Neither file attachments nor image attachments are supported or stored.

### Q13: How are agent runs and tool events connected to conversations and messages?
**Answer:**
- `agent_runs` holds a composite foreign key `(conversation_id, bot_id, knowledge_base_id)` referencing `conversations`.
- `tool_events` references `agent_runs(id)` via `agent_run_id ON DELETE CASCADE`.
- The assistant message persisted upon agent task completion stores `metadata.agentRunId = runResult.agentRunId` and `metadata.toolCalls = mapToolEventsToMessageToolCalls(runResult.toolEvents)`.
- *Key Detail:* There is no foreign key from `messages` to `agent_runs`. The connection is established via the application-level JSON payload in `metadata_json`.

---

## 5. Safe Consolidation & Migration Proposal

### 5.1 Objective
Transition the workspace database and application runtime from multiple conversations per Bot to **exactly one canonical conversation per Bot** without losing user data, corrupting message chronology, or violating foreign-key constraints.

### 5.2 Deterministic Consolidation Algorithm
For each Bot registered in `bots`:
1. **Query Existing Conversations:**
   `SELECT id, created_at, updated_at FROM conversations WHERE bot_id = :bot_id ORDER BY created_at ASC, id ASC`
2. **Case A: Bot has 0 Conversations:**
   - Create exactly one canonical conversation record:
     ```sql
     INSERT INTO conversations (id, bot_id, knowledge_base_id, title, created_at, updated_at, archived_at)
     VALUES (:new_uuid, :bot_id, :kb_id, :bot_name, :now, :now, NULL);
     ```
3. **Case B: Bot has 1 Conversation:**
   - Designate this conversation as the canonical record.
   - Update its title if needed to reflect the canonical bot workspace name.
4. **Case C: Bot has > 1 Conversations ($C_1, C_2, \dots, C_n$):**
   - Designate $C_1$ (oldest by `created_at ASC, id ASC`) as the canonical conversation $C_{canonical}$.
   - Collect secondary conversation IDs $C_{obsolete} = [C_2, \dots, C_n]$.
   - **Chronological Message Normalization:**
     - To prevent interleaving of unrelated conversations that occurred during overlapping time periods, consolidate by *conversation thread blocks*.
     - Let threads be ordered by their initial message timestamp (or conversation `created_at`).
     - For each subsequent conversation $C_k$, calculate its message sequence. If the minimum timestamp in $C_k$ is $\le$ the maximum timestamp of $C_{k-1}$, assign monotonic offsets so that thread $k$ sequentially succeeds thread $k-1$ while preserving internal relative message intervals.
     - *(Alternative Option)*: Keep original timestamps bare, but inject an explicit system demarcation message between merged threads: `--- Previous Thread: "${conv.title}" (${formattedDate}) ---` with role `'system'`.
   - **Re-link Messages:**
     ```sql
     UPDATE messages
     SET conversation_id = :canonical_conv_id
     WHERE conversation_id IN (:obsolete_conv_ids);
     ```
   - **Re-link Agent Runs:**
     ```sql
     UPDATE agent_runs
     SET conversation_id = :canonical_conv_id
     WHERE conversation_id IN (:obsolete_conv_ids);
     ```
   - **Purge Obsolete Conversation Records:**
     ```sql
     DELETE FROM conversations
     WHERE id IN (:obsolete_conv_ids);
     ```
   - Update $C_{canonical}.updated_at$ to $\max(C_1.updated_at, \dots, C_n.updated_at)$.
5. **Schema Migration Invariant (`012_unified_bot_conversations.sql`):**
   - Create a unique index / constraint ensuring a Bot can never have more than one conversation:
     ```sql
     CREATE UNIQUE INDEX idx_conversations_bot_unique ON conversations(bot_id);
     ```
   - Or replace the table with `bot_id TEXT NOT NULL UNIQUE`.

### 5.3 Migration Risks & Safeguards
- **Risk 1: Foreign Key Cascade Deletion on Naive Delete.**
  *Mitigation:* `PRAGMA foreign_keys = ON;` is enforced. Re-linking `messages` and `agent_runs` to $C_{canonical}$ MUST occur *before* issuing `DELETE FROM conversations`.
- **Risk 2: Interleaved Conversation History.**
  *Mitigation:* Merging solely on `created_at ASC` would interleave alternating user/assistant turns from independent conversations. Grouping by conversation or inserting system thread separators ensures coherence for the LLM context manager.
- **Risk 3: Migration Interruption & Partial Application.**
  *Mitigation:* The entire consolidation migration must execute inside an atomic SQLite transaction (`db.transaction(...)`). If any error occurs, SQLite rolls back to the pre-migration state automatically.

---

## 6. Chat and RAG Audit

### 6.1 Inspecting Core Pipeline Services
- `conversation-turn-service.ts` (`src/main/services/conversation-turn-service.ts`)
- `bot-rag-service.ts` (`src/main/services/bot-rag-service.ts`)
- `rag-prompt-builder.ts` (`src/main/services/rag-prompt-builder.ts`)
- `knowledge-base-only-policy.ts` (`src/main/services/knowledge-base-only-policy.ts`)
- `conversation-persistence-service.ts` (`src/main/services/conversation-persistence-service.ts`)

### 6.2 Code Path Verification & Concrete Answers

#### 1. Bot Resolution and Authoritative KB Ownership
- In `ConversationService.prepareTurn` (`src/main/services/conversation-service.ts` [L175-225]), the service loads the Bot via `this.botRepo.getById(botId, activeKbId)`.
- It verifies that the conversation belongs to both `botId` and `activeKbId`.
- The authoritative `knowledgeBaseId` is derived strictly from the Bot record in SQLite; caller-supplied KB IDs from Renderer IPC are strictly ignored and rejected.

#### 2. Normal Chat Retrieval
- In `BotRagService.retrieve` (`src/main/services/bot-rag-service.ts` [L150-250]), FTS5 full-text search is executed over `knowledge_chunks` joined with `knowledge_sources`:
  `WHERE c.knowledge_base_id = :authoritative_kb_id`
- Queries are sanitized via `sanitizeFts5SearchQuery`.
- Default retrieval parameters: `topK = 5`, `maxContextTokens = 4000`.

#### 3. No-Results Handling & Pre-Flight Refusal
- **Question:** *Does the application refuse to contact the provider when retrieval finds no results?*
- **Verified Code Fact:** **YES.** In `ConversationTurnService.executeSendTurn` (`src/main/services/conversation-turn-service.ts` [L582-638]):
  ```typescript
  if (
    preparedTurn.retrievalStatus === 'NO_RESULTS' ||
    preparedTurn.retrievalStatus === 'RETRIEVAL_DISABLED' ||
    preparedTurn.retrievalStatus === 'EMPTY_QUERY'
  ) {
    const refusalText = KnowledgeBaseOnlyPolicy.getNoResultsResponse() // ...
    yield { type: 'text_delta', textDelta: refusalText }
    // Persists synthetic refusal message; NEVER calls executionService.streamPreparedTurn!
    return
  }
  ```
  The AI model provider is **never contacted** if retrieval yields no matching chunks.

#### 4. Partial Retrieval & Insufficient Evidence
- **Question:** *Can the current architecture distinguish partial evidence from no evidence?*
- **Verified Code Fact:** **NO.** `BotRagService` returns either `status = 'SUCCESS'` (if 1 or more chunks match) or `status = 'NO_RESULTS'` (if 0 match). It has no concept of an evidence sufficiency score or partial confidence rating.
- **Question:** *Can it identify conflicting source documents?*
- **Verified Code Fact:** **NO.** The current RAG service does not perform cross-document contradiction detection or conflict clustering.

#### 5. Enforcement of Policy: Application Code vs. Instructions
- **Question:** *Is the current Knowledge Base Only policy enforced in application code, provider instructions, or both?*
- **Verified Code Fact:** **BOTH.**
  1. *Application Pre-flight:* Hard block on `NO_RESULTS` (skips provider entirely).
  2. *Provider System Prompt:* Appends mandatory instructions: "All factual answers MUST be derived strictly from `<retrieved_context>`. NEVER supply missing factual information from general training knowledge." (`rag-prompt-builder.ts` [L140-144]).
  3. *Application Post-flight:* `KnowledgeBaseOnlyPolicy.validateGroundedResponse` (`knowledge-base-only-policy.ts` [L307-395]) parses markdown blocks and replaces the entire response with `UNGROUNDED_RESPONSE` if any substantive block lacks citations.

#### 6. Supplementing Missing KB Info with General Knowledge
- **Question:** *Can the current architecture supplement missing KB information with general model knowledge?*
- **Verified Code Fact:** **NO.** Any substantive claim without a bracketed citation to an authentic retrieved chunk causes `validateGroundedResponse` to fail with `UNCITED_SUBSTANTIVE_BLOCKS`, replacing the entire answer with a refusal.

#### 7. Citation Validation & Entailment Verification
- **Question:** *Does the citation validator check authentic citation references?*
- **Verified Code Fact:** **YES.** `KnowledgeBaseOnlyPolicy.createBlock` [L424-440] matches regex `\[(\d+)\]` and verifies that every cited number exists in `preparedTurn.citationMap`. Fabricated or out-of-range citations are flagged as invalid.
- **Question:** *Does it verify whether cited evidence actually supports a claim?*
- **Verified Code Fact:** **NO.** As explicitly documented in `KnowledgeBaseOnlyPolicy` [L103]:
  `Structural Entailment Limitation: Structural validation verifies syntactic citation presence and block-level coverage against authentic database records; it does not perform semantic NLI.`

#### 8. Distinguishability of General vs. Grounded Claims
- **Question:** *Are general knowledge and KB-supported claims distinguishable?*
- **Verified Code Fact:** **NO.** In the current system, every claim must either be cited or the response is rejected. There is no fine-grained tagging indicating which sentences are backed by the KB and which are general model knowledge.

#### 9. Streaming vs. Unvalidated Display in UI
- **Question:** *Can the Renderer display an unvalidated answer as though it were final?*
- **Verified Code Fact:** **YES.** During turn execution (`conversation-turn-service.ts` [L646-666]), raw text deltas are streamed directly to the Renderer via IPC and rendered in real-time in `ConversationComposer.tsx`. Grounding validation only runs *after the stream finishes* [L669-675]. If validation fails, the UI abruptly swaps the streamed text with `UNGROUNDED_RESPONSE`.

#### 10. Persistence Failure & Cancellation Lifecycle
- **Question:** *What happens if response validation succeeds but database persistence fails?*
- **Verified Code Fact:** The user message is already written to SQLite (persisted at pre-flight [L576]). If assistant persistence fails [L689-705], `ConversationTurnService` yields an error event (`PERSISTENCE_ERROR`). The user message remains in SQLite as an unanswered message.
- **Question:** *What happens when generation is cancelled or interrupted?*
- **Verified Code Fact:** Aborting the turn via `cancelGeneration()` aborts the provider stream. The assistant message is **not persisted**, while the pre-persisted user message remains. The user can subsequently click "Retry" via `retryLastUserMessage` (`conversation-turn-service.ts` [L428-536]).

### 6.3 Safe Path for Balanced Knowledge Base First Behavior
To introduce **Knowledge Base First (Balanced)** without breaking security or causing regressions:
1. Add `response_policy` to `bots` table: `'kb_only' | 'kb_first' | 'general'`.
2. In `ConversationTurnService.executeSendTurn`:
   - If policy is `'kb_first'`:
     - If retrieval yields `NO_RESULTS`, do **not** abort. Instead, format `<retrieved_context>` as empty and supply a system instruction instructing the model to answer using general AI knowledge while explicitly informing the user that no relevant KB documents were found.
     - If retrieval yields chunks, instruct the model to ground on `<retrieved_context>` with `[n]` citations, but allow general explanations when explicitly marked.
3. In `KnowledgeBaseOnlyPolicy.validateGroundedResponse`:
   - Parameterize validation by policy. For `'kb_first'`, validate that any citation used is authentic from `citationMap`, but do not fail the response for `UNCITED_SUBSTANTIVE_BLOCKS` if the block is general explanation.
   - For `'general'`, bypass citation validation entirely.

---

## 7. Agent Runtime and Tool Permission Audit

### 7.1 Inspecting Agent Architecture
- `src/main/services/bounded-agent-runtime.ts`
- `src/main/services/agent-task-service.ts`
- `src/main/tools/tool-registry.ts`
- `src/main/tools/knowledge-base/` (`search-knowledge-base-tool.ts`, `read-knowledge-source-tool.ts`, `list-knowledge-sources-tool.ts`)
- `src/main/tools/workspace/` (`search-workspace-files-tool.ts`, `read-workspace-file-tool.ts`)
- `src/main/tools/report/save-report-tool.ts`
- `src/main/services/approval-controller.ts`

### 7.2 Verification of Security Baseline & Invariants
1. **Normal Chat Cannot Invoke Agent Tools:** **VERIFIED.** Normal chat prompts (`ConversationService.prepareTurn`) do not map or register any tool schemas with the model. Tools can only be called inside `BoundedAgentRuntime`.
2. **Agent Tasks Require Explicit Activation:** **VERIFIED.** Agent tasks can only be dispatched via `agentsApi.dispatchTask` (`agent:dispatch-task` IPC channel).
3. **Agent Tools Are Authorized by Main-Process Application Code:** **VERIFIED.** `BoundedAgentRuntime` checks `isBotToolEnabled(bot.toolPermissions, canonicalName)` before invoking any tool.
4. **Only Enabled Tools Can Run:** **VERIFIED.** If a model hallucinates or requests an unauthorized tool, `BoundedAgentRuntime` throws `TOOL_PERMISSION_DENIED` and terminates the tool call.
5. **Knowledge Base Tools Scoped to Authoritative Parent KB:** **VERIFIED.** Tools resolve `bot.knowledgeBaseId` strictly from the Bot database record; cross-KB parameters are rejected.
6. **Workspace Tools Restricted to Approved Locations:** **VERIFIED.** `WorkspaceFolderService` enforces that workspace operations only occur within a folder explicitly selected by the user via Electron native dialog. Path traversal (`../`) and sensitive paths (`.git`, `.env`, private keys) are hard-blocked.
7. **Prepare Report Retains Approval and Controlled Writing:** **VERIFIED.** `SaveReportTool` delegates to `ApprovalController`, pausing the agent run (`waiting_approval`) until the user approves or rejects the file write via the UI modal.
8. **Tool Results Preserve Provenance:** **VERIFIED.** `AgentTaskService.buildEvidence` aggregates chunk provenance and file evidence into structured metadata.
9. **Bounded Execution Invariants Enforced:** **VERIFIED.** Max 5 iterations (`MAX_AGENT_RUN_ITERATIONS = 5`), 30s tool timeout, 60s step timeout, 5 min run timeout, `AbortController` cancellation.

---

## 8. Bot Creation UI Audit

### 8.1 Current UI Implementation
- Form component: `src/renderer/src/components/bots/BotConfigurationForm.tsx`
- Modal dialog: `src/renderer/src/components/bots/CreateBotModal.tsx`
- Edit dialog: `src/renderer/src/components/bots/EditBotModal.tsx`

### 8.2 Current Field Inventory
1. **Bot Name:** Text input (`length <= 100`, required).
2. **Description:** Textarea (`length <= 2000`, optional).
3. **System Instructions:** Textarea (`length <= 10000`, optional).
4. **Provider Connection:** Dropdown selecting configured BYOK provider.
5. **Model Selection:** Dropdown dynamically populated with provider models.
6. **Enabled Tools:** Checkbox list rendering approved analytical tools (`search_knowledge_base`, `read_knowledge_base_document`, `list_knowledge_base_documents`, `search_project_files`, `read_project_file`, `prepare_report`).
7. **Parent Knowledge Base:** Implicitly bound to the active workspace session (not selected in form).

### 8.3 Comparison with Proposed Phase 12 Structure
| Proposed Section | Current State | Phase 12 Requirement |
|---|---|---|
| **1. Bot Identity** | Name & Description present | Retain; add visual avatar / persona tags |
| **2. Model and Provider** | Connection & Model dropdowns present | Retain; add temperature and context limit hints |
| **3. Knowledge and Response Behavior** | **MISSING** | Add Response Policy selector: Strict KB Only, KB First (Balanced), General AI |
| **4. Agent Tools and Permissions** | Checkbox list present | Group tools clearly: KB Tools vs. Workspace Tools vs. Reporting |
| **5. Execution Safety** | **MISSING** | Display iteration bounds (max 5) and approval policy toggles |

---

## 9. Backup and Import Audit

### 9.1 Serialized Entities & Relationships
- Specification: `src/shared/export-archive.ts` (`EXPORT_ARCHIVE_SCHEMA_VERSION = '1.1.0'`)
- Export manager: `src/main/services/backup-export-manager.ts`
- Import manager: `src/main/services/backup-import-manager.ts`

### 9.2 Current Export Structure
- `manifest.json`: Metadata, record counts, file checksums.
- `knowledge-base.json`: KB metadata.
- `bots.json`: Bot configurations (`id`, `name`, `systemPrompt`, `modelId`, `toolPermissions`).
- `bot-memories.json`: User notes and instructions.
- `sources.json`: Original document metadata.
- `conversations.json`: Array of `ExportConversationBundleDto`:
  - `conversation`: Metadata (`id`, `botId`, `title`, `createdAt`, `updatedAt`).
  - `messages`: Array of `ExportMessageDto` (`id`, `conversationId`, `role`, `content`, `metadata`).
- *Critical Note:* `agent_runs` and `tool_events` are explicitly in `EXCLUDED_EXPORT_CATEGORIES` [L22-23 of `export-archive.ts`]. They are never bundled into export ZIPs.

### 9.3 Impact of Phase 12 on Backups & Historical Import
- **Exporting Phase 12 Backups:** In Phase 12, each Bot will have exactly one conversation, so `conversations.json` will contain exactly 1 bundle per Bot.
- **Importing Historical Archives (`v1.0.0`, `v1.1.0`):**
  - Historical backups may contain multiple conversations for a single Bot.
  - If `BackupImportManager` attempts to insert multiple conversations for a Bot after `idx_conversations_bot_unique` is enforced, the import will crash with an SQLite constraint violation!
  - *Required Resolution:* `BackupImportManager.executeImport` must consolidate multiple conversation bundles belonging to the same Bot into a single canonical conversation during the import staging transaction.

---

## 10. Phase 11 Dependency Audit

### 10.1 Review of Previously Raised Concerns

| Item | Concern / Dependency | Implementation Evidence in Repository | Classification |
|---|---|---|---|
| **1** | Exact textual fidelity verification | `src/main/documents/validation/source-element-inventory.ts` computes `expectedNormalizedText`; `extraction-completeness-evaluator.ts` and `pptx-fidelity.test.ts` verify metrics. | **RESOLVED** |
| **2** | Independent source-grounded extraction inventory | `source-element-inventory.ts` inspects raw OOXML ZIP packages (PPTX, XLSX, DOCX) directly to detect omitted slides, shapes, and formulas. Tests in `source-element-inventory.test.ts` pass. | **RESOLVED** |
| **3** | Backup/import filesystem and SQLite consistency | `backup-import-manager.ts` defers quarantine cleanup until post-copy verification passes; atomic rollback and unlinking implemented on failure. Tests pass. | **RESOLVED** |
| **4** | Chunk regeneration & report freshness | `document-lifecycle-service.ts` implements `restoreAndRegenerateDocument` taking canonical `UniversalDocument`, running current chunker, updating FTS5, and verifying report version freshness. Tests pass. | **RESOLVED** |
| **5** | Manual GUI acceptance evidence | No persistent manual GUI acceptance test logs or screenshots exist in `docs/` or commit history. | **UNVERIFIABLE** |
| **6** | OCR native/WASM consistency | `real-engine-ocr.test.ts` verified native Tesseract binary on Windows for English and Bengali. Unpdf/pdfjs WASM and nowasm fallbacks packaged. | **RESOLVED** |
| **7** | Git status & documentation audit | Working tree has 12 uncommitted modified files from Phase 11.12 corrective work. Phase 11 final summary reports are missing from `docs/`. | **PARTIALLY RESOLVED** |

### 10.2 Phase 12 Blocking Analysis
Does any unresolved Phase 11 issue block Phase 12?
**NO.** All 3,184 unit and integration tests pass, typecheck passes, and production build succeeds. The uncommitted Phase 11 files are functional and stable, but represent a working-tree hygiene finding that must be addressed prior to commiting Phase 12 changes.

---

## 11. Risk Assessment Register

### P0 — Critical Risks
- **RISK-P0-01: Multi-Thread Message Interleaving During Consolidation**
  - *Finding:* Naive consolidation ordering purely by `created_at ASC` will interleave messages from independent threads if they were active in parallel time windows.
  - *Impact:* Confused conversation context, degraded LLM response quality, broken dialogue history.
  - *Resolution:* Group messages by conversation thread blocks or Monotonically re-sequence timestamps with clear thread break markers during consolidation.
  - *Target Step:* Step 12.1.
- **RISK-P0-02: Historical Backup Import Constraint Failure**
  - *Finding:* Enforcing `UNIQUE (bot_id)` on `conversations` will cause `BackupImportManager.executeImport` to fail when restoring legacy backups (`v1.0.0`/`v1.1.0`) that contain multiple conversation bundles for a single bot.
  - *Impact:* Inability to restore user backups created in earlier application versions.
  - *Resolution:* Update `BackupImportManager` to consolidate multiple incoming conversation bundles for a bot into its single canonical conversation before inserting.
  - *Target Step:* Step 12.1 & Step 12.7.

### P1 — High Risks
- **RISK-P1-01: Unvalidated Response Flash During Streaming**
  - *Finding:* Raw model text deltas are streamed directly to the Renderer before grounding validation completes. If validation fails, the UI abruptly swaps the text with a refusal.
  - *Impact:* Jarring user experience; user sees text that the policy deemed ungrounded.
  - *Resolution:* Introduce provisional streaming state and clear validation badge in Renderer.
  - *Target Step:* Step 12.5.
- **RISK-P1-02: Ambiguous Provenance in Balanced Mode**
  - *Finding:* In "Knowledge Base First" mode, if the model blends KB citations with general knowledge, the user may mistake unverified general knowledge for factual KB claims.
  - *Impact:* Potential user reliance on hallucinated facts.
  - *Resolution:* Implement visual demarcation between cited document passages and general reasoning.
  - *Target Step:* Step 12.3 & Step 12.4.
- **RISK-P1-03: Asymmetric Persistence Failure on Network / DB Errors**
  - *Finding:* User message is persisted before generation starts. If assistant persistence throws, user message remains unanswered without automatic recovery.
  - *Impact:* Leftover dangling user messages.
  - *Resolution:* Mark message state or provide automated one-click turn retry.
  - *Target Step:* Step 12.5.

### P2 — Medium/Low Risks
- **RISK-P2-01: ESLint Warning in BotConfigurationForm**
  - *Finding:* `BotConfigurationForm.tsx:213:6` has a missing `useEffect` dependency (`discoveredModels`).
  - *Impact:* Minor lint noise.
  - *Resolution:* Include dependency or wrap callback in `useCallback`.
  - *Target Step:* Step 12.6.
- **RISK-P2-02: Missing Phase 11 Documentation**
  - *Finding:* Phase 11 audit summaries and completion reports are not tracked in `docs/`.
  - *Impact:* Documentation debt.
  - *Resolution:* Commit Phase 11 documentation or archive preflight.
  - *Target Step:* Project owner review.

---

## 12. Recommended Phase 12 Implementation Sequence

To minimize risk and ensure backward compatibility throughout development, Phase 12 should execute in the following modular sequence:

```
Step 12.0: Architecture Audit & Preflight (COMPLETED)
    │
    ▼
Step 12.1: Conversation Schema Migration & Safe Consolidation
    - Database migration adding bot_id UNIQUE to conversations
    - Deterministic multi-conversation consolidation script
    - Backward-compatible import consolidation in BackupImportManager
    │
    ▼
Step 12.2: Response Policy Data Model & Bot Creation UI
    - Add response_policy to bots table ('kb_only' | 'kb_first' | 'general')
    - Update BotConfigurationForm with policy selectors and safety settings
    │
    ▼
Step 12.3: Balanced RAG Retrieval & Prompt Orchestration
    - Update BotRagService to distinguish partial evidence vs. no results
    - Enhance RagPromptBuilder for Balanced and General modes
    │
    ▼
Step 12.4: Provenance-Aware Grounding & Citation Validation
    - Adapt KnowledgeBaseOnlyPolicy for multi-policy validation
    - Sentence-level citation validation without full-answer discarding in Balanced mode
    │
    ▼
Step 12.5: Streaming Lifecycle & Provisional Response UI
    - Provisional stream state in useConversationTurn
    - Validation badge and grounding indicator in ConversationMessage
    │
    ▼
Step 12.6: Agent Task Execution Separation & Tool Matrix
    - Distinct UI tabs or visual boundaries for Agent Tasks vs Normal Chat
    - Strict execution safety and approval controls
    │
    ▼
Step 12.7: End-to-End Verification & Final Acceptance
    - Comprehensive unit, integration, and E2E regression tests
    - Phase 12 verification report and documentation updates
```

---

## 13. Files Inspected

### Source Code
- `src/main/index.ts`
- `src/main/security.ts`
- `src/main/validation.ts`
- `src/main/database/connection.ts`
- `src/main/database/migrations/001_initial_schema.sql`
- `src/main/database/migrations/index.ts`
- `src/main/database/repositories/bot-repository.ts`
- `src/main/database/repositories/conversation-repository.ts`
- `src/main/database/repositories/message-repository.ts`
- `src/main/database/repositories/agent-run-repository.ts`
- `src/main/database/repositories/tool-event-repository.ts`
- `src/main/services/bot-manager.ts`
- `src/main/services/conversation-manager.ts`
- `src/main/services/conversation-service.ts`
- `src/main/services/conversation-turn-service.ts`
- `src/main/services/conversation-execution-service.ts`
- `src/main/services/conversation-persistence-service.ts`
- `src/main/services/conversation-context-manager.ts`
- `src/main/services/bot-rag-service.ts`
- `src/main/services/rag-prompt-builder.ts`
- `src/main/services/knowledge-base-only-policy.ts`
- `src/main/services/agent-task-service.ts`
- `src/main/services/bounded-agent-runtime.ts`
- `src/main/tools/agent-tool.ts`
- `src/main/tools/tool-registry.ts`
- `src/main/tools/knowledge-base/search-knowledge-base-tool.ts`
- `src/main/tools/knowledge-base/read-knowledge-source-tool.ts`
- `src/main/tools/knowledge-base/list-knowledge-sources-tool.ts`
- `src/main/tools/workspace/search-workspace-files-tool.ts`
- `src/main/tools/workspace/read-workspace-file-tool.ts`
- `src/main/tools/report/save-report-tool.ts`
- `src/main/services/workspace-folder-service.ts`
- `src/main/services/approval-controller.ts`
- `src/main/services/backup-export-manager.ts`
- `src/main/services/backup-import-manager.ts`
- `src/main/documents/validation/source-element-inventory.ts`
- `src/main/documents/validation/extraction-completeness-evaluator.ts`
- `src/main/documents/lifecycle/document-lifecycle-service.ts`
- `src/main/ipc/conversation-handlers.ts`
- `src/main/ipc/agent-handlers.ts`
- `src/preload/index.ts`
- `src/shared/conversations.ts`
- `src/shared/bots.ts`
- `src/shared/agents.ts`
- `src/shared/export-archive.ts`
- `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx`
- `src/renderer/src/components/chat/ConversationSidebar.tsx`
- `src/renderer/src/components/chat/ConversationMessageList.tsx`
- `src/renderer/src/components/chat/ConversationComposer.tsx`
- `src/renderer/src/components/chat/ConversationEmptyState.tsx`
- `src/renderer/src/components/bots/BotConfigurationForm.tsx`
- `src/renderer/src/components/bots/CreateBotModal.tsx`
- `src/renderer/src/components/bots/EditBotModal.tsx`
- `src/renderer/src/hooks/useConversations.ts`
- `src/renderer/src/hooks/useConversationMessages.ts`
- `src/renderer/src/hooks/useConversationTurn.ts`
- `src/renderer/src/hooks/useAgentTask.ts`

### Specifications & Documentation
- `AGENTS.md`
- `PRODUCT_SPEC.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_SCOPE.md`
- `DATA_MODEL.md`
- `PHASE_PLAN.md`

---

## 14. Outstanding Questions & Evidence Gaps

1. **User Experience on Historical Conversation Merges:** When consolidating multiple existing conversations into one canonical thread, should the UI display visual thread separation headers (e.g. `--- Previous Thread: "Refactoring Ideas" (Nov 20, 2026) ---`), or should it present a single seamless timeline?
2. **Commit Policy on Phase 11.12 Uncommitted Files:** Should the 12 modified files from Phase 11.12 be committed as a dedicated milestone commit (`fix(phase-11): complete phase 11.12 corrective implementations`) before Step 12.1 begins?
3. **Model Knowledge Tagging in Balanced Mode:** For the "Knowledge Base First" policy, should ungrounded general-knowledge assertions be flagged visually with an informational tag (e.g., "General AI Reasoning"), or should the assistant explicitly declare its ungrounded status in markdown prose?
