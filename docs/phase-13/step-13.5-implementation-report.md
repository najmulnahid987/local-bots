# Phase 13 — Step 13.5: Cross-Provider Optimization & Final Audit Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (Local Bots)  
**Phase:** 13 — Multi-Provider Expansion & Response Performance  
**Step:** 13.5 — Cross-Provider Optimization & Final Audit  
**Date:** November 28, 2026  
**Baseline Branch / HEAD:** `main` @ `10a8c62bc5f2f0605f0374088609ab293c4964a2` (`nice work`)  

---

## 1. Initial Git State & Preserved Pre-Existing Work

Preflight inspection verified:
- **Branch:** `main`
- **HEAD:** `10a8c62bc5f2f0605f0374088609ab293c4964a2`
- **Staged changes:** `0`
- **Pre-existing baseline tests (end of Step 13.4):** `225` test files, `3,421` tests passing.
- **Preserved pre-existing changes:**
  - Pre-existing modifications in `openai/*` and `anthropic/*` files plus `package.json` / `package-lock.json`.
  - Complete Step 13.2 (`groq`), Step 13.3 (`openrouter`), and Step 13.4 (`perplexity`, Migration 015, `webSources`) implementations, migrations (`014_*`, `015_*`), UI changes, and tests.
- **Git safety compliance:** Zero destructive Git operations (`reset`, `clean`, `restore`, `stash`) and zero staging/committing/pushing were performed. Earlier database migrations were left untouched.

---

## 2. Bottleneck Root Causes & Eliminations

### 2.1 Context Selection $O(T^2)$ Bottleneck (`ConversationContextManager`)
- **Root Cause:** On long conversations (~80 turns / 160 messages), trimming conversation history inside `ConversationContextManager` repeatedly rebuilt the full prompt via `RagPromptBuilder.build()` inside each iteration of the trim loop, causing quadratic $O(T^2)$ string formatting and token-estimation work (~`997.214 ms` p50 in Step 13.1).
- **Fix ([conversation-context-manager.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-context-manager.ts)):**
  - Computes the static zero-history base prompt cost **once** via `RagPromptBuilder.build()`.
  - Computes per-turn token and message-framing costs in a single $O(N)$ pass, preserving trailing duplicate-user-question suppression and role transformation rules bit-for-bit.
  - Selects `startTurnIndex` using a linear prefix subtraction scan.
  - Calls `RagPromptBuilder.build()` **once** for the winning slice (or one additional fallback call when dropping `memoryContext` at 0 history turns).

### 2.2 Streaming IPC Over-Dispatch (`ConversationStreamManager`)
- **Root Cause:** Every raw token chunk from provider streams triggered an immediate `port.postMessage(...)` IPC serialization frame, creating high IPC and renderer dispatch overhead during rapid token bursts.
- **Fix ([conversation-stream-manager.ts](file:///d:/projects_electron/local%20bots/project/src/main/ipc/conversation-stream-manager.ts)):**
  - Added configurable `deltaBatchIntervalMs` defaulting to `DEFAULT_DELTA_BATCH_INTERVAL_MS = 16` ms and `MAX_DELTA_BATCH_BUFFER_CHARS = 512`.
  - **Zero-delay first token:** The first non-empty `text_delta` after entering the `streaming` phase flushes immediately (`0 ms` batching delay) to minimize perceived Time-To-First-Token (TTFT).
  - Subsequent rapid `text_delta` events coalesce within `16 ms` or `512` characters while preserving strict monotonic `sequenceNumber` ordering, request/conversation scoping, pre-terminal flushing before `finish`/`error`, and immediate timer/buffer cancellation on abort or cleanup with zero post-abort chunk leaks.

### 2.3 Renderer Streaming Jank, Per-Token Prism Highlighting & Reload Flash
- **Root Causes:**
  1. Per-token React state updates triggered synchronous Markdown and Prism tokenization across the entire message list.
  2. Smooth scroll (`scrollIntoView({ behavior: 'smooth' })`) ran on every delta and pulled the viewport back even when the user scrolled up to read earlier messages.
  3. Conversation completion triggered a full historical IPC reload of all messages.
- **Fixes:**
  - **Streaming hook & error redaction ([useConversationTurn.ts](file:///d:/projects_electron/local%20bots/project/src/renderer/src/hooks/useConversationTurn.ts), [useBotConversation.ts](file:///d:/projects_electron/local%20bots/project/src/renderer/src/hooks/useBotConversation.ts)):** Extracted `createStreamEventHandler`; first non-empty delta updates state immediately and measures monotonic UI latency `firstVisibleTextMs`. Subsequent rapid deltas buffer via `requestAnimationFrame` (`16 ms` timer fallback) and clean up on finish/cancel/error/unmount. Added `appendMessages` / ID-deduplicating `appendMessage` and extended `sanitizeConversationError` pattern matching to cover `gsk_|pplx-|sk-or-v1-|sk-or-`.
  - **Zero-reload completion ([BotConversationsWorkspacePage.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx)):** Appends finalized `[userMessage, assistantMessage]` on `onFinish` and `partialMessage` on `onError` via `appendMessages`/`appendMessage` without re-fetching historical messages over IPC; stabilized `handleSaveResponseAsMemory` with `useCallback`.
  - **Memoization & deferred syntax highlighting ([CodeBlock.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/CodeBlock.tsx), [MarkdownMessageContent.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/MarkdownMessageContent.tsx), [ConversationMessage.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx)):** Wrapped components in `React.memo`, memoized `remarkPlugins`, and deferred expensive `Prism.tokenize()` execution while `isGenerating === true`, applying full Prism highlighting immediately upon stream completion.
  - **Smart auto-scrolling & isolated live bubble ([ConversationMessageList.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessageList.tsx)):** Isolated active streaming rendering in memoized `StreamingAssistantBubble`, replaced per-delta `scrollIntoView` with `requestAnimationFrame`-throttled auto-follow active only within `120 px` of the bottom (`isNearBottomRef`), halted auto-follow when the user scrolls upward, and added an accessible `Jump to latest` control (`data-testid="scroll-to-bottom-btn"`).

---

## 3. Monotonic Telemetry & Local Pipeline Instrumentation

End-to-end local stage timings now use monotonic `performance.now()` (removing wall-clock drift issues from `Date.now()`):
- **Shared Contract ([conversations.ts](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts)):** Extended `GenerationMetadataDto` and `generationMetadataSchema` with `prepareMs`, `retrievalMs`, `contextSelectionMs`, `finalizationMs`, and `tokensPerSecond` alongside `firstTokenMs` and `durationMs`.
- **Pipeline Stage Capture:**
  - [conversation-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.ts): Captures `prepareMs`, `retrievalMs`, and `contextSelectionMs` in `PreparedConversationTurn.timings`.
  - [conversation-execution-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-execution-service.ts): Measures `firstTokenMs` strictly from `providerManagerService.streamText(...)` dispatch to first non-empty provider `text-delta`, emitting metrics on `FinishEvent` and `ConversationExecutionResult`.
  - [conversation-turn-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts): Measures `finalizationMs` inside `applyPostFlightResponsePolicy` around `GroundingValidator.validateResponse`.
  - [conversation-persistence-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts): Persists all telemetry fields and derives `tokensPerSecond` only when `firstTokenMs !== undefined` (streaming turns with measured TTFT) and `usage.completionTokens > 0` so non-streaming synthetic fixtures remain deterministic and backward-compatible.

---

## 4. Provider Defects Found & Fixed

1. **Cross-Adapter Connection Isolation in Chat & Agent Execution:**
   - Added internal Main-process-only `connectionId?: string` on `GenerateTextOptions` ([types.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/types.ts)), populated internally by [provider-manager-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-manager/provider-manager-service.ts) and [ai-sdk-agent-model-step-executor.ts](file:///d:/projects_electron/local%20bots/project/src/main/agents/ai-sdk-agent-model-step-executor.ts) (never accepted from client IPC payloads).
   - Wired `providerRegistry.getModel(<provider>, options.modelId, options.connectionId)` in [openai-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/openai/openai-adapter.ts), [anthropic-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/anthropic/anthropic-adapter.ts), and [google-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/google/google-adapter.ts).
2. **`OpenAIAdapter` Fixes ([openai-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/openai/openai-adapter.ts)):**
   - Fixed `testConnection` `timeoutId` timer leak and cleaned up `abortHandler` listeners before pre-aborted early return and in `finally`.
   - Unwrapped internal timeout `controller.signal.reason` in both `generateText` and `streamText` catch blocks so request timeouts classify consistently as `TIMEOUT` rather than `ABORTED` or generic `PROVIDER_ERROR`.
   - Added empty stream conversion for `finishReason` of `content-filter` (explicit filtered error) and `error` (empty error chunk failure) in `streamText`.
   - Added `'o4-'` to `chatPrefixes` in `discoverAvailableModels`.
3. **`AnthropicAdapter` Fixes ([anthropic-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/anthropic/anthropic-adapter.ts)):**
   - Unwrapped internal timeout `controller.signal.reason` in both `generateText` and `streamText` catch blocks.
   - Converted empty `content-filter` and `error` `finishReason` streams into normalized errors in `streamText`.
4. **`GoogleAdapter` Fix ([google-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/google/google-adapter.ts)):**
   - Added `connectionId`-scoped model lookup and unwrapped internal timeout `controller.signal.reason` in `generateText` catch block.

---

## 5. Six-Provider Consistency Audit Matrix

| Capability / Guardrail | OpenAI | Anthropic | Google | Groq | OpenRouter | Perplexity |
|---|---|---|---|---|---|---|
| Direct HTTPS BYOK endpoint (`safeStorage` vault) | Verified | Verified | Verified | Verified | Verified | Verified |
| Main-only `connectionId` resolution & catalog isolation | Verified | Verified | Verified | Verified | Verified | Verified |
| Dynamic `/models` discovery persistence across restart | Verified | Verified | Verified | Verified | Verified | Verified |
| Chat streaming + Agent `generateText` execution | Verified | Verified | Verified | Verified | Verified | Verified |
| Normalized `TIMEOUT` vs user `ABORTED` distinction | Verified | Verified | Verified | Verified | Verified | Verified |
| Empty `content-filter` / `error` stream rejection | Verified | Verified | Verified | Verified | Verified | Verified |
| Response policies (`strict_kb_only`, `balanced_kb_first`, `general_ai_chat`) | Verified | Verified | Verified | Verified | Verified | Verified |
| Secret redaction in provider/conversation errors (`sk-`, `sk-ant-`, `AIza`, `gsk_`, `sk-or-`, `pplx-`) | Verified | Verified | Verified | Verified | Verified | Verified |
| Export/import backup compatibility & credential reset | Verified | Verified | Verified | Verified | Verified | Verified |

---

## 6. Before / After Benchmarks & Methodology Caveats

### 6.1 80-Turn Context Selection Benchmark (`n = 20`, 80 turns / 160 messages, 8k window)
- **Step 13.1 Baseline:** `997.214 ms` p50, `1031.411 ms` p95
- **Step 13.5 Measured (standalone single-file run):** `7.30 ms` p50, `15.39 ms` p95 (~136x faster p50)
- **Step 13.5 Measured (`STEP_13_5_CONTEXT_BENCH`, full 227-worker concurrent Vitest run):**
  - `{"n":20,"p50":19.4037000000003,"p95":31.841300000000047}` (~51x faster p50 even under full 227-worker CPU load)

### 6.2 Local Pipeline Stage Benchmark (`STEP_13_5_PIPELINE_BENCH`, `n = 20`, mocked provider HTTP stream)

| Stage / Metric | Step 13.1 Baseline (`:memory:` SQLite, p50) | Step 13.5 Standalone Disk-WAL SQLite (p50 / p95) | Step 13.5 Full-Suite 227-Worker Disk-WAL SQLite (p50 / p95) |
|---|---|---|---|
| FTS5 Retrieval | `2.879 ms` | `2.07 ms` / `2.93 ms` | `3.20 ms` / `4.04 ms` |
| Turn Context Prep (10 turns) | *Included in E2E* | `13.51 ms` / `21.87 ms` | `23.58 ms` / `34.51 ms` |
| Local TTFT (dispatch -> 1st chunk) | `6.297 ms` | `22.00 ms` / `30.19 ms` | `38.51 ms` / `47.51 ms` |
| Finalization (grounding validation) | `4.219 ms` | `5.68 ms` / `11.01 ms` | `12.06 ms` / `29.44 ms` |
| Local E2E (turn persistence + pipeline) | `10.800 ms` | `28.13 ms` / `35.71 ms` | `53.75 ms` / `59.46 ms` |

**Methodology Caveats:**
1. All provider network calls in automated tests are **mocked in-process**; no live external provider API latency was measured or claimed.
2. Step 13.1 measured pipeline stages on in-memory SQLite (`:memory:`), whereas Step 13.5 Test 6 benchmarks full persistence using disk-backed WAL SQLite via `createMigratedTestDatabase()`, which includes real filesystem I/O for user and assistant message writes.
3. Standalone vs full-suite numbers differ because Vitest runs `227` worker processes in parallel during the full regression run.

---

## 7. Verification Summary

| Check | Result | Details |
|---|---|---|
| `npm run lint` | Passed (`0` errors, `0` warnings) | ESLint clean across repository |
| `npm run typecheck` | Passed (`0` errors) | Both `tsconfig.node.json` and `tsconfig.web.json` passed |
| `npm test` | **227 / 227 files passed; 3,430 / 3,430 tests passed** | Duration `91.26s`; `+2` files and `+9` tests over Step 13.4 (`225` files, `3,421` tests) |
| `npm run build` | Passed | `out/main/index.js` (`1,509.71 kB`), `out/preload/index.js` (`270.62 kB`), `out/renderer/assets/index-BLtkB6oQ.js` (`2,321.19 kB`) |

- **New Step 13.5 Test Files:**
  - [step-13.5-cross-provider-audit.test.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/step-13.5-cross-provider-audit.test.ts) (`6` tests): 80-turn context selection benchmark + semantic equivalence, monotonic pipeline telemetry + `tokensPerSecond`, `ConversationStreamManager` delta batching + immediate first delta + abort cleanup, OpenAI/Anthropic timeout/error stream hardening, 6-provider dynamic model discovery persistence + connection isolation + execution, and reproducible `STEP_13_5_PIPELINE_BENCH`.
  - [Step135StreamingUi.test.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/Step135StreamingUi.test.tsx) (`3` tests): Deferred Prism tokenization during streaming, `useConversationTurn` RAF batching + `firstVisibleTextMs`, and smart auto-scroll + Jump-to-Latest control.
- **Security & Architecture Regression Results:** Existing suites for Electron IPC sender/frame validation (`conversation-bridge.test.ts`, `provider-bridge.test.ts`, `knowledge-base-bridge.test.ts`), CredentialVault/safeStorage (`credential-vault.test.ts`), multi-KB Bot isolation (`bot-persistence-and-isolation.test.ts`), response policies & grounding (`knowledge-base-only-policy.test.ts`, `grounding-validator.test.ts`), diagnostic/secret sanitization (`secret-scanner.test.ts`, `diagnostic-sanitizer.test.ts`), and provider E2E suites (`groq-e2e-integration.test.ts`, `openrouter-e2e-integration.test.ts`, `perplexity-e2e-integration.test.ts`) all passed.

---

## 8. Known Limitations & Deferred Scope

- **Non-streaming Agent steps:** `AiSdkAgentModelStepExecutor` uses `adapter.generateText` for bounded Agent tool iterations per the Phase 8 runtime contract rather than streaming intermediate tokens.
- **Test-injected custom `ProviderRegistry` instances:** `OpenAIAdapter` and `AnthropicAdapter` look up dynamic connection-scoped models on the shared `providerRegistry` singleton; custom `ProviderRegistry` test doubles remain isolated unless registered into `providerRegistry` (future DI constructor injection can remove singleton coupling cleanly without breaking production behavior).
- **Pre-existing Vite build notice:** `electron-vite build` emits the upstream `[EMPTY_IMPORT_META]` notice from `unpdf/dist/index.mjs` when bundling CommonJS `main`.
- **Phase 14 boundary:** No Phase 14 work (SQLCipher, local LLM weights / Ollama / llama.cpp, privacy-mode redesign, or cloud analytics) was started.

---

## 9. Files Added or Modified in Step 13.5

### Modified Files
- [conversation-context-manager.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-context-manager.ts)
- [conversation-stream-manager.ts](file:///d:/projects_electron/local%20bots/project/src/main/ipc/conversation-stream-manager.ts)
- [conversations.ts](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts)
- [conversation-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-service.ts)
- [conversation-execution-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-execution-service.ts)
- [conversation-turn-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts)
- [conversation-persistence-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts)
- [types.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/types.ts)
- [provider-manager-service.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-manager/provider-manager-service.ts)
- [ai-sdk-agent-model-step-executor.ts](file:///d:/projects_electron/local%20bots/project/src/main/agents/ai-sdk-agent-model-step-executor.ts)
- [openai-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/openai/openai-adapter.ts)
- [anthropic-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/anthropic/anthropic-adapter.ts)
- [google-adapter.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/google/google-adapter.ts)
- [useConversationTurn.ts](file:///d:/projects_electron/local%20bots/project/src/renderer/src/hooks/useConversationTurn.ts)
- [useBotConversation.ts](file:///d:/projects_electron/local%20bots/project/src/renderer/src/hooks/useBotConversation.ts)
- [BotConversationsWorkspacePage.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx)
- [CodeBlock.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/CodeBlock.tsx)
- [MarkdownMessageContent.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/MarkdownMessageContent.tsx)
- [ConversationMessage.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx)
- [ConversationMessageList.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessageList.tsx)

### Added Files
- [step-13.5-cross-provider-audit.test.ts](file:///d:/projects_electron/local%20bots/project/src/main/providers/step-13.5-cross-provider-audit.test.ts)
- [Step135StreamingUi.test.tsx](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/Step135StreamingUi.test.tsx)
- [step-13.5-implementation-report.md](file:///d:/projects_electron/local%20bots/project/docs/phase-13/step-13.5-implementation-report.md)

---

## 10. Git Gate Confirmation

- **Nothing was staged, committed, or pushed.**
- All pre-existing working-tree modifications from prior steps were preserved cleanly.
- Phase 13 — Step 13.5 is complete and halted cleanly at the Step 13.5 / Phase 13 completion gate awaiting human review.
