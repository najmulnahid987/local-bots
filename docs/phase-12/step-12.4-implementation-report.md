# Phase 12 — Step 12.4 Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.4 — Balanced KB-First Retrieval & General Knowledge Fallback  
**Branch / Base Commit:** `main` @ `ff3f157` (working tree preserves Phase 11.12 and Steps 12.1–12.3 changes; nothing staged or committed)  
**Status:** Completed and verified at the Step 12.4 gate

---

## 1. Objective Summary

Step 12.4 implements the end-to-end runtime retrieval, evidence assessment, fallback, prompt guidance, error propagation, and subtle message transparency behavior for the `balanced_kb_first` Bot response policy while preserving `strict_kb_only` and `general_ai_chat` semantics:

1. **Relevant KB Evidence (`relevant_evidence`):** Prioritizes retrieved `<retrieved_context>` chunks first, retains authentic `[n]` citations, isolates Knowledge Bases strictly via Main-process Bot-to-KB lookup, and permits non-contradictory clarifying general context without claiming general training knowledge came from documents.
2. **Partial KB Evidence (`partial_evidence`):** Uses deterministic natural-language keyword extraction (`content_terms`) and Balanced relaxed content-term matching (`relaxed_terms` when `enablePartialFallback` is enabled) to surface partial KB matches, instruct the model to ground covered parts with `[n]` and transparently distinguish general AI supplementation, and prevent fabricated citations.
3. **No Relevant KB Evidence (`no_relevant_evidence`):** When an active, populated KB has zero relevant matches (or `EMPTY_QUERY` with indexed sources), Balanced skips Strict KB Only pre-flight refusals, instructs the model to answer using general AI knowledge while transparently noting the assigned KB lacked relevant info, and suppresses invented citations.
4. **No Usable KB Content (`no_usable_kb`):** Distinguishes active parent KBs with zero indexed/ready sources or chunks (`indexing_status IN ('completed', 'ready')`) from populated KBs and from missing/archived KBs, falling back cleanly under Balanced/General AI without falsely claiming populated documents were matched.
5. **Technical Retrieval Failures (`RETRIEVAL_ERROR`):** SQLite/FTS5 errors, readiness check failures, malformed retrieval payloads, or missing/archived parent Bot/KB errors raise typed `RETRIEVAL_ERROR` failures across both `sendMessage` and `retryLastUserMessage` and never silently degrade into general AI fallback.

In-scope boundaries maintained:
- **Zero SQLite schema changes / migrations** added (`groundingMode` persists inside existing validated `messages.metadata_json` and roundtrips cleanly with export/import schemas).
- **Deferred intentionally:** Claim-level provenance/grounding validation & provisional response gating UI (Step 12.5), strict Normal Chat vs. Agent Task execution separation (Step 12.6), and neural embeddings/vector search.

---

## 2. Preflight Scoring Audit & Retrieval Limitations

- **Retrieval Engine:** SQLite FTS5 (`knowledge_fts` with Porter stemming) ordered by `bm25(knowledge_fts) AS rank_score` (`ASC`, more negative = stronger match), strictly scoped by `f.knowledge_base_id = ? AND s.indexing_status IN ('completed', 'ready')`.
- **Natural-Language Query Bottleneck Identified:** `sanitizeFts5SearchQuery` preserves implicit FTS5 `AND` over all non-operator tokens. Conversational questions containing stopwords (e.g., `"What is our vacation carryover limit?"`) or multi-topic partial queries (e.g., `"What is the vacation carryover limit and lunar shuttle boarding schedule?"`) previously returned zero rows if stopwords or unindexed second-topic terms were absent from chunks.
- **Deterministic Evidence Assessment Implemented:**
  - Exact FTS5 query runs first (`matchStrategy: 'exact'`), preserving full backwards compatibility with `strict_kb_only` and existing `searchChunks` call expectations.
  - Readiness stats (`readySourceCount`, `chunkCount`) are inspected for the authoritative `knowledgeBaseId` via `KnowledgeSourceRepository.getSearchableStats`. If exact search returns zero rows and `kbChunkCount === 0`, retrieval returns `NO_RESULTS` with `assessment.outcome: 'no_usable_kb'` without further queries.
  - When `kbChunkCount > 0`, retrieval retries stopword-stripped `AND` terms (`matchStrategy: 'content_terms'`) and—only when `options.enablePartialFallback` is `true` (`balanced_kb_first`)—relaxed `OR` content-term search (`matchStrategy: 'relaxed_terms'`) ranked by `(matchedContentTermCount DESC, rank_score ASC)`.
  - Evidence outcome classifies `'partial_evidence'` when `matchStrategy === 'relaxed_terms'` and `termCoverageRatio < 0.75`, and `'relevant_evidence'` otherwise when chunks pass token budgeting.
- **Known Limitation:** Evidence assessment uses deterministic lexical token/stem coverage over FTS5 BM25 results rather than semantic/NLI entailment verification; claim-level verification belongs to Step 12.5.

---

## 3. Repository & Retrieval Layer Changes

- [`src/main/database/repositories/knowledge-source-repository.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/repositories/knowledge-source-repository.ts):
  - Added `getSearchableStats(knowledgeBaseId)` counting ready/completed sources (`indexing_status IN ('completed', 'ready')`) and their indexed chunks inside a single SQL query scoped to `knowledge_base_id`, throwing `RepositoryError` on database failure.
- [`src/main/services/bot-rag-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/bot-rag-service.ts):
  - Exported `BotRagEvidenceOutcome`, `BotRagMatchStrategy`, and `BotRagEvidenceAssessment`; added `enablePartialFallback?: boolean` on `BotRagRetrievalOptions` and `assessment?: BotRagEvidenceAssessment` on `BotRagRetrievalResult`.
  - Preserved `BotRagRetrievalStatus` (`'SUCCESS' | 'NO_RESULTS' | 'EMPTY_QUERY' | 'RETRIEVAL_DISABLED'`) and `BOT_NOT_FOUND`, `BOT_ARCHIVED`, `KNOWLEDGE_BASE_NOT_FOUND`, `KNOWLEDGE_BASE_ARCHIVED`, and `DATABASE_ERROR` failure behavior unchanged.

---

## 4. Prompt Building, Turn Orchestration, Error Semantics & Metadata

- [`src/shared/conversations.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts):
  - Defined `MESSAGE_GROUNDING_MODES`, `MessageGroundingMode`, and `messageGroundingModeSchema`:
    - `'kb_grounded'`
    - `'kb_partial_with_general_fallback'`
    - `'general_fallback_no_kb_evidence'`
    - `'general_fallback_no_usable_kb'`
    - `'general_chat'`
  - Added optional `groundingMode?: MessageGroundingMode` onto `MessageMetadataDto` and `messageMetadataSchema`. Existing `serializeMessageMetadata`, `deserializeMessageMetadata`, `MessageRepository`, and `exportMessageDtoSchema` preserve and validate the field automatically without SQLite DDL changes.
- [`src/main/services/rag-prompt-builder.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/rag-prompt-builder.ts):
  - Extended `buildSystemInstruction` and `buildBalancedOrGeneralPolicyInstruction` to accept optional `retrievalAssessment?: BotRagEvidenceAssessment` and produce tailored `balanced_kb_first` policy & Section 4 status guidance across relevant, partial, populated no-results, and `no_usable_kb` outcomes while preserving `strict_kb_only`, `general_ai_chat`, `<retrieved_context>` anti-injection guards, and no-citation-fabrication rules.
  - Exposed optional `retrievalAssessment` on `RagPromptResult`.
- [`src/main/services/conversation-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.ts):
  - Passed `enablePartialFallback: responsePolicy === 'balanced_kb_first'` in `executeBotRagRetrieval`, added defensive payload shape validation throwing `'RETRIEVAL_ERROR'`, preserved `'RETRIEVAL_ERROR'` mapping inside `budgetConversationContext`, and populated optional `retrievalAssessment` and `groundingMode` (`resolvePreparedGroundingMode`) onto `PreparedConversationTurn`.
- [`src/main/services/conversation-turn-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts):
  - Added `'RETRIEVAL_ERROR'` explicitly to `ConversationTurnErrorCode` so both `executeSendTurn` and `executeRetryTurn` fail loudly with typed `RETRIEVAL_ERROR` stream events and rejected promises whenever retrieval fails technically.
- [`src/main/services/conversation-persistence-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts):
  - Persists `preparedTurn.groundingMode` into assistant message metadata alongside `providerId`, `modelId`, authentic linked `citations`, and `generation` while keeping strict pre-flight refusals and unflagged mocks clean.

---

## 5. Subtle Chat Message Transparency UI

- [`src/renderer/src/components/chat/ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx):
  - Added `getGroundingBadgeMeta` and rendered a compact header pill (`className="chat-grounding-pill"`, `data-testid="message-grounding-badge-<id>"`) when assistant metadata carries:
    - `'kb_grounded'` -> `KB Evidence`
    - `'kb_partial_with_general_fallback'` -> `Partial KB + General AI`
    - `'general_fallback_no_kb_evidence'` -> `General AI Fallback`
    - `'general_fallback_no_usable_kb'` -> `General AI (No KB Docs)`
  - Leaves `'general_chat'` and unset metadata unadorned to avoid noisy chrome across messages.

---

## 6. Test Additions & Coverage Accounting

Added **+14 tests** across 8 existing test suites (bringing total from Step 12.3's `3,228` to **`3,242`**, across **`211`** test files):

| Suite | Previous | Current | Net | Coverage Focus |
| --- | --- | --- | --- | --- |
| [`bot-rag-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/bot-rag-service.test.ts) | 44 | 49 | +5 | Natural-language queries, partial evidence, `no_usable_kb` vs `no_relevant_evidence`, failed-source filtering, cross-KB isolation, DB readiness error |
| [`rag-prompt-builder.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/rag-prompt-builder.test.ts) | 43 | 44 | +1 | Tailored `balanced_kb_first` instructions across relevant, partial, empty-KB-hit, and `no_usable_kb` states |
| [`conversation-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.test.ts) | 47 | 49 | +2 | Balanced Cases 1–5 turn preparation, `RETRIEVAL_ERROR` propagation, forged `knowledgeBaseId`/`responsePolicy` stripping |
| [`conversation-turn-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.test.ts) | 30 | 32 | +2 | End-to-end Balanced turns across Cases 1–4 (`groundingMode` + authentic citations), `RETRIEVAL_ERROR` on `sendMessage` & `retryLastUserMessage`, `general_chat` persistence |
| [`conversation-persistence-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.test.ts) | 50 | 51 | +1 | `groundingMode` persistence and SQLite reload verification |
| [`conversations.test.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.test.ts) | 46 | 47 | +1 | `messageMetadataSchema` `groundingMode` acceptance & invalid enum rejection |
| [`ChatPresentation.test.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ChatPresentation.test.tsx) | 16 | 17 | +1 | Compact Balanced source indicator badges rendered & `general_chat` kept clean |
| [`phase-7-e2e-rag-security.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/phase-7-e2e-rag-security.test.ts) | 20 | 21 | +1 | E2E Balanced empty-KB isolation, partial evidence citation linking, and simulated `SQLITE_BUSY` surfacing `RETRIEVAL_ERROR` loudly |

---

## 7. Verification Results

All checks ran cleanly after the final code/test edit:

| Check | Command | Exit Code | Observed Output Summary |
| --- | --- | --- | --- |
| ESLint (modified Step 12.4 files) | `npx eslint --fix ...` | `0` | 0 errors and 0 warnings across all Step 12.4 touched files |
| Type Checking | `npm run typecheck` | `0` | `tsc --noEmit` passed with 0 errors across `tsconfig.node.json` and `tsconfig.web.json` |
| Linting | `npm run lint` | `0` | 0 errors; only the 3 pre-existing Phase 11.12 warnings remain (`backup-export-manager.ts` L313/316 Prettier; `BotConfigurationForm.tsx` L223 `react-hooks/exhaustive-deps`) |
| Test Suite | `npm run test` | `0` | **211 / 211 test files passed**, **3,242 / 3,242 tests passed** (`72.43s`) |
| Production Build | `npm run build` | `0` | `typecheck` + `electron-vite build` succeeded for `main` (`538ms`), `preload` (`56ms`), and `renderer` (`558ms`) bundles |

---

## 8. Scope Boundary & Gate Notice

Implementation stops cleanly at the Step 12.4 gate:
- Git working tree remains on `main` @ `ff3f157`, unstaged and uncommitted, with all prior Phase 11.12 and Steps 12.1–12.3 changes intact.
- Step 12.5 (provenance-aware grounding validation & provisional response lifecycle) and Step 12.6 (Normal Chat vs. Agent Task execution separation) were **not** implemented here and await authorization to proceed.
