# Phase 12 — Step 12.5 Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.5 — Provenance-Aware Grounding Validator  
**Branch / Base Commit:** `main` @ `ff3f157` (working tree preserves Phase 11.12 and Steps 12.1–12.4 changes; nothing staged or committed)  
**Status:** Completed and verified at the Step 12.5 gate

---

## 1. Objective & Implementation Summary

Step 12.5 introduces typed, claim-level provenance tracking and provenance-aware grounding validation across `strict_kb_only`, `balanced_kb_first`, and `general_ai_chat` while preserving all local-first isolation, citation integrity, backup compatibility, and security guarantees:

- Defined Zod-validated claim provenance DTO contracts (`ClaimProvenanceDto`, `ClaimEvidenceReferenceDto`, `ClaimProvenance`, `ClaimValidationStatus`) persisted inside existing `messages.metadata_json` without introducing a SQLite schema migration.
- Extended `PreparedConversationTurn` in the Electron Main process to carry authoritative `knowledgeBaseId` and retrieved chunk contents (`retrievedChunks`) directly into post-generation validation.
- Implemented [`GroundingValidator`](file:///d:/projects_electron/local%20bots/project/src/main/services/grounding-validator.ts) and integrated it into [`ConversationTurnService`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts) (`sendMessage` and `retryLastUserMessage`) and [`ConversationPersistenceService`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts), alongside an optional bounded `ClaimVerifier` adapter (`createProviderClaimVerifier`) disabled by default.
- Added a collapsible, unobtrusive **Claim Provenance** inspector inside [`ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx) and fixed target-message citation resolution in [`BotConversationsWorkspacePage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx).

---

## 2. Preflight Findings & Actual Data Flow

1. **Identifiers & Metadata Available After Retrieval:** `BotRagService.retrieve` derives authoritative `knowledgeBaseId` from `botRepo.getByIdOnly(botId)` / `kbRepo.getById`, returning `RetrievedChunk[]` (`citationNumber`, `sourceId`, `chunkId`, `fileName`, `fileType`, `pageNumber`, `headingPath`, `chunkIndex`, `score`, `content`, `tokenCount`, `isTruncated`, `citation`). Prior to Step 12.5, `PreparedConversationTurn` dropped both `knowledgeBaseId` and chunk `content` after prompt building.
2. **Existing Validator Gap:** `KnowledgeBaseOnlyPolicy.validateGroundedResponse` checked structural markdown blocks (`>= 30` chars, `>= 5` words) and citation existence in `citationMap` under `strict_kb_only` only, without splitting sentence/clause claims, verifying whether cited chunk contents supported claims, or recording claim-level provenance on Balanced/General responses.
3. **Provider Structured-Output Assessment:** While `ProviderManagerService.generateText` accepts `jsonSchema`, several catalog models mark `capabilities.structuredOutput: false` (verified in [`provider-registry.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-registry.test.ts)), and making a mandatory extra LLM call per message would add latency and paid API costs without user consent. Accordingly, default turns run zero-extra-cost deterministic claim validation while offering an opt-in, bounded `ClaimVerifier` port.
4. **End-to-End Trace:** `BotRagService.retrieve` -> `ConversationService.prepareTurn` (attaches `knowledgeBaseId`, `retrievedChunks`, `citationMap`, `retrievalStatus`, `retrievalAssessment`) -> `ConversationExecutionService` -> `ConversationTurnService.applyPostFlightResponsePolicy` (`GroundingValidator.validateResponse`) -> `ConversationPersistenceService.persistAssistantMessage` (`metadata.claims` + harmonized `groundingMode` + linked `citations`) -> SQLite `messages.metadata_json` -> Preload/IPC `MessageDto` -> `ConversationMessage.tsx`.

---

## 3. Claim-Provenance Data Model

Defined in [`src/shared/conversations.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts):

- `CLAIM_PROVENANCE_VALUES`: `'kb_supported' | 'kb_partially_supported' | 'general_knowledge' | 'unsupported' | 'uncertain'`
- `CLAIM_VALIDATION_STATUSES`: `'validated' | 'partially_validated' | 'not_supported' | 'insufficient_evidence' | 'invalid_reference' | 'not_checked'`
- `ClaimEvidenceReferenceDto`: `knowledgeBaseId?` (optional UUID so Main-process turns record authoritative KB ID without inventing fake IDs in standalone calls), `sourceId`, `chunkId`, `citationNumber`, `fileName`, `fileType`, `pageNumber`, `headingPath`, `chunkIndex`.
- `ClaimProvenanceDto`: `claimId`, `claimText`, `provenance`, `validationStatus`, `evidenceReferences`, `explanation?`.
- `MessageMetadataDto.claims?: readonly ClaimProvenanceDto[]` validated strictly via `messageMetadataSchema` (`max(200)` claims, `.strict()`).

---

## 4. Claim Identification & Support-Assessment Strategy

- **Claim Identification (`identifyResponseClaims`):**
  - Exempts fenced code blocks, ATX headings, markdown link definitions, markdown table header & delimiter rows (`| --- |`), conversational greetings/closings, pure questions without citations, and short uncited transitions.
  - Extracts substantive assertions across paragraphs, list items, blockquotes, and markdown table data rows, splits sentences carefully around decimals/abbreviations, and isolates compound clauses joined by `;`, `, while`, `, whereas`, `, and`, `, but` when clauses carry distinct citations or assertions so uncited clauses never inherit a neighbor's `[1]`.
- **Deterministic Support Assessment (`assessLexicalSupport`):**
  - When referenced chunk text exists: compares normalized domain terms (`approximateStem`, excluding stopwords) and numeric identifiers (`/\b\d+(?:\.\d+)?%?\b/`) against only the claim's referenced chunk(s):
    - Unconfirmed numbers with term overlap or partial term overlap (`1 <= matchedTerms`, `< 0.45` overlap and `< 3` matched terms) -> `kb_partially_supported` (`partially_validated`).
    - Strong overlap (`overlap >= 0.45` or `>= 3` matched terms, zero unconfirmed numbers) -> `kb_supported` (`validated`).
    - Zero meaningful overlap or empty domain terms -> `uncertain` (`insufficient_evidence`).
  - When a legacy caller omits `retrievedChunks` (e.g. direct `KnowledgeBaseOnlyPolicy.validateGroundedResponse`), falls back cleanly to syntactic `citationMap` validation (`'kb_supported'` for valid cited blocks).
  - Uncited Balanced assertions explicitly claiming KB provenance (`EXPLICIT_KB_ATTRIBUTION_REGEX`) are flagged `'uncertain'` (`insufficient_evidence`); other uncited general assertions classify cleanly as `'general_knowledge'` (`not_checked`).
- **Optional Verifier (`createProviderClaimVerifier`):** Bounded (`MAX_VERIFIER_CLAIMS = 20`, excerpt capped at 800 chars, `timeoutMs = 10000`, `AbortSignal`), Zod-validated (`claimVerifierResponseSchema.strict()`), with `<retrieved_context>` XML delimiter escaping and strict `chunkId` allowlist enforcement.

---

## 5. Evidence-Reference Integrity Rules

Enforced in [`resolveClaimReferences`](file:///d:/projects_electron/local%20bots/project/src/main/services/grounding-validator.ts):

1. Every `[n]` marker in prose requires `retrievalStatus === 'SUCCESS'` and membership in the current turn's `citationMap`.
2. When `retrievedChunks` exist, each referenced citation's `chunkId` and `sourceId` must match the retrieved chunk at `[n]`, and any chunk carrying `knowledgeBaseId` must equal `authoritativeKnowledgeBaseId` (rejecting cross-KB leakage).
3. Any unretrieved, invented, or cross-KB reference (including invented `evidenceChunkIds` returned by a model verifier) is rejected as `'invalid_reference'` and excluded from persisted `evidenceReferences` and `citations`.
4. Displayed `fileName`, `pageNumber`, `headingPath`, `sourceId`, and `chunkId` are built solely from authoritative retrieved records—never trusting filenames or page numbers written inside generated prose.

---

## 6. Policy-Specific Validation Behavior

- **`strict_kb_only`:** Preserves pre-flight refusals (`NO_EVIDENCE`, `EMPTY_QUERY`, `RETRIEVAL_UNAVAILABLE`) and structural block guards, and additionally rejects responses whose claims fail support validation (`not_supported`, `invalid_reference`, `insufficient_evidence`, `partially_validated`), replacing output with `KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE` and persisting `citations: []` and omitted `claims`. Never silently falls back to general AI.
- **`balanced_kb_first`:** Never rejects helpful mixed responses. Preserves supported KB claims with validated references, distinguishes `kb_partially_supported` and `general_knowledge` claims cleanly, suppresses invented citations, and refines `MessageMetadataDto.groundingMode` cleanly inside `ConversationPersistenceService.persistAssistantMessage` (`kb_partial_with_general_fallback` when mixed KB + general/uncertain claims exist; `general_fallback_no_kb_evidence` if zero KB claims/citations occurred).
- **`general_ai_chat`:** Unconstrained by Strict rules; labels ordinary responses `general_knowledge` while validating any explicit cited optional KB claims against `citationMap`/`retrievedChunks`.

---

## 7. Persistence & Backup Compatibility

- **No Database Migration Needed:** `messages.metadata_json` already stores serialized JSON validated via `messageMetadataSchema`, preserving canonical `conversation_id`, `segment_id`, and `message.id` values untouched. Historical messages lacking `claims` deserialize and render identically without rewriting history.
- **Export / Import Compatibility:** `BackupExportManager` (`metadata: msg.metadata ? { ...msg.metadata } : null`) and `BackupImportManager` (`secretScanner.scanObject` + `JSON.stringify(msg.metadata ?? {})`) preserve `metadata.claims` on roundtrips while accepting legacy archives with `{}` / omitted `claims`.

---

## 8. UI Changes

- [`ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx): Keeps existing Step 12.4 header grounding badge (`KB Evidence`, `Partial KB + General AI`, `General AI Fallback`, `General AI (No KB Docs)`) and adds a collapsible **Claim Provenance** toggle (`data-testid="toggle-claim-provenance-<id>"`) when persisted `claims.length > 0`, rendering validated status chips (`KB Supported`, `Partial KB Support`, `General AI`, `Unverified Reference`, `Unsupported`, `Uncertain`) and clickable source reference buttons filtered against `message.metadata.citations` while suppressing internal debug fields (`explanation` / UUIDs).
- [`ConversationMessageList.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessageList.tsx) & [`BotConversationsWorkspacePage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx): Extended `onCitationClick(citation, targetMessageId?)` so clicking citations or claim references resolves the exact clicked message ID even when multiple turns reuse citation number `[1]`.

---

## 9. Failure Handling & Security Protections

- Malformed verifier output (`!claimVerifierResponseSchema.safeParse(...).success`), verifier exceptions/timeouts, or verifier-invented `evidenceChunkIds` never upgrade an unverified claim to `kb_supported`/`validated`: Balanced degrades safely to `'uncertain'` / `'insufficient_evidence'` (or `'invalid_reference'`) without stack/secret leakage; Strict rejects cleanly with `UNGROUNDED_RESPONSE`.
- Renderer-supplied metadata cannot override Main-process `authoritativeKbId` or validation decisions; IPC boundaries stay schema-strict; retrieved chunks inside `createProviderClaimVerifier` are escaped via `escapeXmlDelimiters` inside `<retrieved_context>`.

---

## 10. Files Created, Modified, or Deleted

### Created
- [`src/main/services/grounding-validator.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/grounding-validator.ts)
- [`src/main/services/grounding-validator.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/grounding-validator.test.ts)
- [`docs/phase-12/step-12.5-implementation-report.md`](file:///d:/projects_electron/local%20bots/project/docs/phase-12/step-12.5-implementation-report.md)

### Modified
- [`src/shared/conversations.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts)
- [`src/shared/conversations.test.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.test.ts)
- [`src/main/services/conversation-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.ts)
- [`src/main/services/conversation-execution-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-execution-service.ts)
- [`src/main/services/conversation-turn-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts)
- [`src/main/services/conversation-turn-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.test.ts)
- [`src/main/services/conversation-persistence-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts)
- [`src/main/services/conversation-persistence-service.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.test.ts)
- [`src/main/services/backup-export-manager.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/backup-export-manager.test.ts)
- [`src/main/services/backup-import-manager.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/backup-import-manager.test.ts)
- [`src/renderer/src/components/chat/ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx)
- [`src/renderer/src/components/chat/ConversationMessageList.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessageList.tsx)
- [`src/renderer/src/components/chat/ChatPresentation.test.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ChatPresentation.test.tsx)
- [`src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx)

### Deleted
- None in Step 12.5.

---

## 11. Tests Added & Modified

- **`grounding-validator.test.ts` (+18 tests):** Covers all claim-identification, reference-integrity, policy-enforcement, verifier-failure, and prompt-injection scenarios (#1–#20, #27–#29).
- **`conversations.test.ts` (+1 -> 48):** Validates structured `claims` schema & safe malformed fallback.
- **`conversation-persistence-service.test.ts` (+1 -> 52):** Verifies `claims` SQLite persistence, reload, and mixed Balanced `groundingMode` harmonization.
- **`conversation-turn-service.test.ts` (+1 -> 33):** Verifies end-to-end mixed Balanced claims, Strict numeric mismatch rejection, and malformed `claimVerifier` resilience.
- **`ChatPresentation.test.tsx` (+1 -> 18):** Verifies collapsible UI provenance badges, `onCitationClick` target resolution, unvalidated ref filtering, legacy message rendering, and hidden debug strings.
- **`backup-export-manager.test.ts` (+1 -> 8) & `backup-import-manager.test.ts` (+1 -> 20):** Verifies claim metadata export/import roundtrip and legacy archive compatibility without `claims`.

---

## 12. Full Verification Results

Executed cleanly after the final code/test edit:

| Check | Command | Exit Code | Observed Result |
| --- | --- | --- | --- |
| ESLint (Step 12.5 files) | `npx eslint --fix ...` | `0` | 0 errors and 0 warnings across Step 12.5 files |
| Type Checking | `npm run typecheck` | `0` | `tsc --noEmit` passed across `tsconfig.node.json` and `tsconfig.web.json` |
| Linting | `npm run lint` | `0` | 0 errors; only the 3 pre-existing Phase 11.12 warnings remain (`backup-export-manager.ts` L313/316 Prettier; `BotConfigurationForm.tsx` L223 `react-hooks/exhaustive-deps`) |
| Full Test Suite | `npm run test` | `0` | **212 / 212 test files passed**, **3,266 / 3,266 tests passed** (`79.39s`, 0 skipped, 0 failed) |
| Production Build | `npm run build` | `0` | `typecheck` + `electron-vite build` succeeded (`568ms`, `62ms`, `1.99s`) |

---

## 13. Test-Count Comparison with Step 12.4

- **Step 12.4 Baseline:** `211` test files, `3,242` tests
- **Step 12.5 Result:** `212` test files (`+1`), `3,266` tests (`+24` added, `0` removed, `0` skipped, `0` failed)

---

## 14. Known Limitations

1. **Deterministic Lexical & Numeric Overlap Is Not Semantic Entailment Proof:** Default validation checks citation-bound domain-term overlap, numeric fidelity, and chunk ownership rather than deep semantic NLI contradiction or negation detection (for example, inverted polarity sharing the exact same words `"is enabled"` vs `"is not enabled"` within a cited chunk is not caught semantically without a model verifier).
2. **Optional Model-Assisted Verifier Constraints:** `createProviderClaimVerifier` incurs an extra paid model call per verified turn when injected, requires a model supporting structured JSON schema output (`capabilities.structuredOutput: true`), and remains disabled by default unless explicitly configured.
3. **Rule-Based Claim Splitting:** Complex multi-sentence prose with unconventional formatting or implicit pronoun coreference may group clauses conservatively into `'uncertain'` or `'kb_partially_supported'` rather than splitting every atomic proposition.
4. **Backup Import ID Remapping Preserves Snapshot Provenance:** `BackupImportManager` preserves `metadata.claims` JSON snapshots from exported archives verbatim (after secret scanning) rather than remapping historical `sourceId`/`chunkId`/`knowledgeBaseId` UUIDs inside historical message snapshots; re-indexed imported chunks receive new runtime IDs while historical claim text and status remain intact.

---

## 15. Git Branch, HEAD & Working-Tree Status

- **Branch:** `main`
- **HEAD Commit:** `ff3f157`
- **Working Tree:** All Phase 11.12, Steps 12.1–12.4, and Step 12.5 edits remain unstaged and uncommitted (`git status --short` clean of staged or pushed mutations). Stopping cleanly at the Step 12.5 gate before Step 12.6.
