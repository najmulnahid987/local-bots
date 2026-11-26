# Phase 12 — Step 12.7: Streaming Lifecycle Implementation Report (Audited & Corrected)

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.7 — Streaming Lifecycle  
**Status:** Implementation Complete, Audited & Verified  
**Date:** November 2026  

---

## 1. Git-State Investigation & Reconciliation

### Verified Repository State
- **Branch:** `main` (`origin/main`)
- **HEAD at Audit Start:** `ff3f1579193109a28a8a1079518b6fea9639a43a` (`ff3f157 i just complete phase 11`) with all Steps 12.1–12.7 unstaged in the working tree.
- **Current HEAD:** `a2bf8908b6a93621f4cbc831059ed723b4f126ce` (`a2bf890 (HEAD -> main, origin/main) almost complete the phase 12`, authored/committed externally on `Thu Nov 26 21:01:28 2026 +0600`), which committed 121 files (`19,060+` insertions, `3,098-` deletions) encompassing Phase 12 (Steps 12.1–12.7) and the `src/main/documents/` updates.
- **Current Working Tree:** Contains only the post-`a2bf890` mandatory `botId` contract corrections and this updated report, with 0 staged changes (`git diff --cached --stat` empty).

### Resolution of Conflicting Previous Reports
- **Why Step 12.5, Step 12.6, and Step 12.7 differed:** All of Phase 12 (Steps 12.1 through 12.7) was implemented sequentially in the local working tree without intermediate `git commit` or `git add` operations, so `HEAD` has remained at Phase 11 commit `ff3f157` throughout Phase 12.
- Step 12.6's description of a "clean working tree" was inaccurate; in reality, Steps 12.1–12.6 were all unstaged in the working tree alongside pre-existing post-Phase-11 document extraction/validation edits in `src/main/documents/`. What was accurate is that **zero changes were staged or committed**.

---

## 2. Architecture & Enforced Streaming Event Contracts

### 2.1 7-Stage Lifecycle Model
Defined in `src/shared/conversations.ts`:
`STREAM_LIFECYCLE_STAGES = ['idle', 'preparing', 'streaming', 'finalizing', 'completed', 'cancelled', 'failed'] as const`

### 2.2 Strict Chat Event Contract (`src/shared/conversations.ts`)
Every `PublicConversationTurnEvent` (`PublicStageChangeEvent`, `PublicTextDeltaEvent`, `PublicFinishEvent`, `PublicErrorEvent`) now **requires** at the type level (with zero optional exceptions):
- `requestId: string`
- `botId: string`
- `conversationId: string`
- `executionMode: ExecutionMode` (`'chat'`)
- `sequenceNumber: number` (starts at `1`, increments by `1` per event)
- `timestamp: number`
- `stage: StreamLifecycleStage`

`ConversationStreamManager` requires `conversationRepo: ConversationRepository` and resolves `botId` authoritatively via `resolveAuthoritativeBotId(conversationId)` before opening or transferring any stream, rejecting unknown conversations and ignoring any client-supplied `botId`.

### 2.3 Strict Agent Event Contract (`src/shared/agents.ts`)
`AgentStreamEventBase` now **requires** at the type level (with zero optional exceptions):
- `agentRunId: string`
- `botId: string`
- `conversationId: string`
- `executionMode: 'agent'`
- `stage: StreamLifecycleStage` (resolved deterministically in `AgentStreamManager.resolveStage`)
- `sequenceNumber: number` (starts at `1`, increments by `1` per event)
- `timestamp: number`

`AgentStreamManager.startStream(...)` requires a non-empty `botId: string` (supplied authoritatively by `agent-handlers.ts` from SQLite `botRepository.getByIdOnly(payload.botId)` and verified against `conversation.botId === bot.id`).

### 2.4 Terminal & Post-Terminal Guards
- Both `ConversationStreamManager` and `AgentStreamManager` track `hasEmittedTerminal: boolean` per session.
- Once a terminal event (`finish` / `error` for Chat; `agent_run_completed` / `agent_run_failed` / `agent_run_cancelled` for Agent) is emitted, `hasEmittedTerminal` is set to `true`, rejecting any duplicate terminal events or late deltas.
- Fallback uncaught error handlers in `ConversationStreamManager.emitFallbackErrorAndCleanup` stamp full correlation metadata (`requestId`, `conversationId`, `botId`, `executionMode`, `sequenceNumber`, `timestamp`, `stage: 'failed'`).

---

## 3. Complete Scenario-by-Scenario Test Mapping (All 46 Required Scenarios + 6 Audit Additions)

| Scenario | Requirement | Test file and test name | Actual result |
|---:|---|---|---|
| 1 | Provider yields incremental text chunks | `src/main/services/streaming-lifecycle.test.ts` — `1. Provider yields incremental text chunks correctly` | **PASS** |
| 2 | Empty text deltas handled cleanly without crashing | `src/main/services/streaming-lifecycle.test.ts` — `2. Empty text deltas are ignored or handled cleanly without crashing` | **PASS** |
| 3 | Stream completion emits final token usage and finish reason | `src/main/services/streaming-lifecycle.test.ts` — `3. Stream completion emits final token usage and finish reason` | **PASS** |
| 4 | Provider errors during streaming surface with structured codes | `src/main/services/streaming-lifecycle.test.ts` — `4. Provider errors during streaming surface with structured codes` | **PASS** |
| 5 | AbortSignal aborts provider stream immediately | `src/main/services/streaming-lifecycle.test.ts` — `5. AbortSignal aborts provider stream immediately` | **PASS** |
| 6 | Multi-chunk responses accumulate exact complete text | `src/main/services/streaming-lifecycle.test.ts` — `6. Multi-chunk responses accumulate to the exact complete text without missing or duplicated characters` | **PASS** |
| 7 | Token usage reporting matches provider / handles missing usage | `src/main/services/streaming-lifecycle.test.ts` — `7. Token usage reporting matches provider data when available, handles missing usage gracefully` | **PASS** |
| 8 | Chat lifecycle enters `preparing` stage on start | `src/main/services/streaming-lifecycle.test.ts` — `8-12. preparing -> streaming -> finalizing -> completed with citations and metadata` | **PASS** |
| 9 | Chat lifecycle transitions to `streaming` on first delta | `src/main/services/streaming-lifecycle.test.ts` — `8-12. preparing -> streaming -> finalizing -> completed with citations and metadata` | **PASS** |
| 10 | Chat lifecycle transitions to `finalizing` before persistence | `src/main/services/streaming-lifecycle.test.ts` — `8-12. preparing -> streaming -> finalizing -> completed with citations and metadata` | **PASS** |
| 11 | Chat lifecycle emits `completed` finish event | `src/main/services/streaming-lifecycle.test.ts` — `8-12. preparing -> streaming -> finalizing -> completed with citations and metadata` | **PASS** |
| 12 | Citations and metadata attached only on `completed` finish | `src/main/services/streaming-lifecycle.test.ts` — `8-12. preparing -> streaming -> finalizing -> completed with citations and metadata` | **PASS** |
| 13 | Error during preparation surfaces before streaming begins | `src/main/services/streaming-lifecycle.test.ts` — `13. Error during preparation surfaces before streaming begins` | **PASS** |
| 14 | Error during streaming terminates turn cleanly with error event | `src/main/services/streaming-lifecycle.test.ts` — `14. Error during streaming terminates turn cleanly with error event` | **PASS** |
| 15 | Error during finalizing (persistence failure) surfaces safely | `src/main/services/streaming-lifecycle.test.ts` — `15. Error during finalizing (persistence failure) surfaces safely` | **PASS** |
| 16 | Idle state restores after completion or error | `src/main/services/streaming-lifecycle.test.ts` — `16. Idle state restores after completion or error` | **PASS** |
| 17 | Agent task dispatch emits `agent_run_started` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 18 | Agent iteration emits `agent_iteration_started` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 19 | Agent tool start emits `tool_call_started` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 20 | Agent tool completion emits `tool_call_completed` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 21 | Agent approval gate emits `approval_requested` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 22 | Agent approval decision emits `approval_resolved` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 23 | Agent task completion emits `agent_run_completed` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 24 | Agent task failure emits `agent_run_failed` | `src/main/services/streaming-lifecycle.test.ts` — `17-24. Agent task dispatch, iterations, tool calls, approval, completion, and failure` | **PASS** |
| 25 | Client cancellation during streaming halts provider immediately | `src/main/services/streaming-lifecycle.test.ts` — `25. Client cancellation during streaming halts provider generation immediately` | **PASS** |
| 26 | Client cancellation during agent run marks run cancelled | `src/main/services/streaming-lifecycle.test.ts` — `26. Client cancellation during agent run marks run cancelled` | **PASS** |
| 27 | Cancellation is idempotent (duplicate cancels are safe no-ops) | `src/main/services/streaming-lifecycle.test.ts` — `27. Cancellation is idempotent (duplicate cancel requests are safe no-ops)` | **PASS** |
| 28 | Late chunks arriving after cancellation are discarded | `src/main/services/streaming-lifecycle.test.ts` — `28. Late chunks arriving after cancellation are discarded and not persisted` | **PASS** |
| 29 | Concurrent turn rejection on same conversation | `src/main/services/streaming-lifecycle.test.ts` — `29. Concurrent turn rejection (second request while first is active fails cleanly)` | **PASS** |
| 30 | Rapid cancel-then-send sequence cleans up previous turn | `src/main/services/streaming-lifecycle.test.ts` — `30. Rapid cancel-then-send sequence cleans up previous turn before starting new turn` | **PASS** |
| 31 | Completed chat turn persists user & assistant messages with citations | `src/main/services/streaming-lifecycle.test.ts` — `31. Fully completed chat turn persists user message and assistant message with citations` | **PASS** |
| 32 | Cancelled chat turn with partial text persists `isPartial: true` | `src/main/services/streaming-lifecycle.test.ts` — `32. Cancelled chat turn with partial text persists user message and partial assistant message (isPartial: true)` | **PASS** |
| 33 | Cancelled chat turn with no text persists user message only | `src/main/services/streaming-lifecycle.test.ts` — `33. Cancelled chat turn with no text persists user message only (no empty assistant message)` | **PASS** |
| 34 | Failed chat turn with partial text persists partial with `status: 'failed'` | `src/main/services/streaming-lifecycle.test.ts` — `34. Failed chat turn with partial text persists partial message with status "failed"` | **PASS** |
| 35 | Retrying after cancelled turn deletes partial and generates fresh response | `src/main/services/streaming-lifecycle.test.ts` — `35. Retrying after cancelled turn deletes/replaces partial message and generates fresh response without duplicates` | **PASS** |
| 36 | Partial assistant message has no validated claims or false citations | `src/main/services/streaming-lifecycle.test.ts` — `36. Partial assistant message has no validated claims or false citations` | **PASS** |
| 37 | Application restart / refresh loads partial message from SQLite | `src/main/services/streaming-lifecycle.test.ts` — `37. Application restart or page refresh loads partial message correctly from SQLite` | **PASS** |
| 38 | `MessagePortMain` transfer succeeds for send message stream | `src/main/services/streaming-lifecycle.test.ts` — `38. MessagePortMain transfer succeeds for send message stream` | **PASS** |
| 39 | `MessagePortMain` transfer succeeds for retry stream | `src/main/services/streaming-lifecycle.test.ts` — `39. MessagePortMain transfer succeeds for retry stream` | **PASS** |
| 40 | `MessagePortMain` transfer succeeds for agent task stream | `src/main/services/streaming-lifecycle.test.ts` — `40. MessagePortMain transfer succeeds for agent task stream` | **PASS** |
| 41 | Window close aborts active streams and cleans up ports | `src/main/services/streaming-lifecycle.test.ts` — `41. Window close or navigation aborts active streams and cleans up ports` | **PASS** |
| 42 | Renderer unmount cancels active turn and ignores late events | `src/renderer/src/hooks/useConversationTurn.test.tsx` — `8. ignores late events...` & `9. cleans up active generation on component unmount` | **PASS** |
| 43 | Switching Bot / conversation detaches UI & drops stale events | `src/renderer/src/hooks/useConversationTurn.test.tsx` — `10. Scenario 43: switching conversationId resets local streaming state and stage to idle`; `src/renderer/src/hooks/useAgentTaskEvents.test.tsx` — Bot isolation test | **PASS** |
| 44 | Stream events carry authoritative `requestId`, `botId`, `conversationId`, `sequenceNumber` | `src/main/services/streaming-lifecycle.test.ts` — `44. Stream events carry authoritative requestId, botId, conversationId, and sequenceNumber` | **PASS** |
| 45 | Renderer hook tracks lifecycle stages (`preparing` -> `streaming` -> `completed`) | `src/renderer/src/hooks/useConversationTurn.test.tsx` — `11. Scenario 45: tracks lifecycle stages accurately (preparing -> streaming -> completed)` | **PASS** |
| 46 | Renderer hook `useAgentTaskEvents` reconciles streaming tool events with persisted records | `src/main/services/streaming-lifecycle.test.ts` — `46. ...` & `src/renderer/src/hooks/useAgentTaskEvents.test.tsx` | **PASS** |

### Corrected Category Counts
- **Category 1 (Scenarios 1–7, Provider streaming):** 7/7 scenarios verified in 7 tests (`streaming-lifecycle.test.ts`).
- **Category 2 (Scenarios 8–16, Chat lifecycle):** 9/9 scenarios verified in 5 tests (`streaming-lifecycle.test.ts`: Scenarios 8–12 verified together in one end-to-end lifecycle test + Scenarios 13–16).
- **Category 3 (Scenarios 17–24, Agent lifecycle):** 8/8 scenarios verified in 1 multi-step lifecycle test (`streaming-lifecycle.test.ts`).
- **Category 4 (Scenarios 25–30, Cancellation & races):** 6/6 scenarios verified in 6 tests (`streaming-lifecycle.test.ts`).
- **Category 5 (Scenarios 31–37, Persistence & recovery):** 7/7 scenarios verified in 7 tests (`streaming-lifecycle.test.ts`).
- **Category 6 (Scenarios 38–46, IPC & Renderer lifecycle):** 9/9 scenarios verified across `streaming-lifecycle.test.ts` (6 tests), `useConversationTurn.test.tsx` (3 tests), and `useAgentTaskEvents.test.tsx` (1 test).
- **Audit & Final Contract Additions (Tests 47–54 in `streaming-lifecycle.test.ts`):** 8 new dedicated tests covering duplicate terminal suppression, Agent post-cancel suppression, fallback error correlation, cooperative in-flight tool cancellation, non-abort-aware in-flight tool cancellation, in-place vs top-level navigation, mandatory Chat `botId` resolution & spoof rejection (Test 53), and mandatory Agent `botId` enforcement (Test 54).

---

## 4. Provider Streaming Support Matrix

| Provider | Actual streaming implementation | Cancellation support | Non-streaming fallback | Verified test |
|---|---|---|---|---|
| **OpenAI** (`openai`) | Real incremental SSE streaming via `@ai-sdk/openai` (`openai.responses(modelId)`) + Vercel AI SDK `streamText()`, iterating `result.fullStream` (`text-delta`, `tool-call`, `finish`, `error`, `abort`). | `options.abortSignal` wired to internal `AbortController` + generation timeout; `abort` chunk mapped to `OPERATION_ABORTED` / `TIMEOUT`. | `OpenAIAdapter.generateText()` via `generateText()` | `src/main/providers/openai/openai-adapter.test.ts` |
| **Anthropic** (`anthropic`) | Real incremental SSE streaming via `@ai-sdk/anthropic` (`anthropic.messages(modelId)`) + Vercel AI SDK `streamText()`, iterating `result.fullStream` (`text-delta`, `tool-call`, `finish`, `error`, `abort`). | `options.abortSignal` wired to internal `AbortController` + generation timeout; `abort` chunk mapped to `OPERATION_ABORTED` / `TIMEOUT`. | `AnthropicAdapter.generateText()` via `generateText()` | `src/main/providers/anthropic/anthropic-adapter.test.ts` |
| **Google Gemini** (`google`) | Real incremental SSE streaming via `@ai-sdk/google` (`google(resolvedModelId)`) + Vercel AI SDK `streamText()`, iterating `result.fullStream` (`text-delta`, `tool-call`, `finish`, `error`, `abort`). | `options.abortSignal` wired to internal `AbortController` + generation timeout; `abort` chunk mapped to `OPERATION_ABORTED` / `TIMEOUT`. | `GoogleAdapter.generateText()` via `generateText()` | `src/main/providers/google/google-adapter.test.ts` |
| **xAI / OpenRouter** | **Not yet implemented** in `SUPPORTED_PROVIDER_IDS` (`['openai', 'anthropic', 'google']`) or `src/main/providers/`. | N/A | N/A | N/A |

---

## 5. Agent Cancellation Behavior Across All Execution States

Inspected in `BoundedAgentRuntime` (`src/main/services/bounded-agent-runtime.ts`) and `AgentStreamManager` (`src/main/ipc/agent-stream-manager.ts`):

1. **Before an Agent iteration begins:** `if (request.signal?.aborted)` marks `agent_runs.status = 'cancelled'` immediately without entering the loop.
2. **While the model is generating a response:** `runAbortController.signal` is passed to `stepExecutor.executeStep(...)`. If aborted, `BoundedAgentRuntime` breaks out of the loop and marks the run `'cancelled'`.
3. **While a tool call is waiting for approval:** `ApprovalController` cancels the pending approval; `BoundedAgentRuntime` marks `tool_event` as `'cancelled'` and the run as `'cancelled'`.
4. **While a tool is executing (in-flight):**
   - **Cooperative tools** (accepting `ctx.signal` and throwing `ToolError('ABORTED')`): caught by `BoundedAgentRuntime`, `tool_event` is marked `'cancelled'`, loop breaks, no further tools start, `agent_run` is marked `'cancelled'` (Test 50).
   - **Non-abort-aware / synchronous tools** (finishing normally after `abort()` was called): `BoundedAgentRuntime` preserves the completed `tool_event` outcome (`markCompleted`), then checks `if (runAbortController.signal.aborted)` at the top of the `while` loop, breaks immediately without starting another iteration/tool, and marks the `agent_run` as `'cancelled'` (Test 51).
5. **Immediately after a tool finishes / Between iterations:** Loop-top check `if (runAbortController.signal.aborted) break` prevents any next model step or tool call.
6. **While final Agent answer is being finalized:** Even if `stepResult.type === 'final'` just returned, line 852 checks `if (runAbortController.signal.aborted)` **before** checking `finalResponse`, ensuring a cancelled run is never reported as `'completed'`.
7. **Stream Manager Coordination:** `AgentStreamManager.hasEmittedTerminal` ensures that once `cancelStream` emits `agent_run_cancelled`, any delayed `agent_run_cancelled`, `tool_call_completed`, or `agent_run_completed` from `BoundedAgentRuntime` during the 20ms flush window is suppressed (Test 48).

---

## 6. Terminal Event Delivery & Resource Cleanup

- **`ConversationStreamManager`:** Emits the terminal `finish` or `error` event across `port1`, sets `session.hasEmittedTerminal = true`, and in `finally` invokes `cleanupSession(requestId)` (closing `port1` and deleting from `activeStreams`). Preload (`src/preload/index.ts`) resolves/rejects the turn promise upon receiving `finish`/`error` and closes `port2`.
- **`AgentStreamManager`:** Emits the terminal event, sets `session.hasEmittedTerminal = true` immediately (preventing duplicate terminal events), and schedules `cleanupSession(agentRunId)` after a 20ms flush window (or immediately on `port1` `'close'` when Preload closes `port2`).
- **Window Close & Shutdown:** `attachWindowLifecycle` listens to `'closed'`, `webContents` `'destroyed'`, and non-in-place `'did-start-navigation'` to abort active streams and close ports.

---

## 7. Application-Shutdown & Interrupted-Stream Recovery

- **Agent Runs & Tool Events:** On startup, `StartupReconciliationService.reconcileInterruptedAgentTasks()` (`src/main/services/startup-reconciliation-service.ts`) queries SQLite for `agent_runs WHERE status IN ('running', 'awaiting_approval', 'pending')` and `tool_events WHERE status IN ('pending', 'running')`, transitioning them atomically to `'failed'` with `'Task was interrupted because the application exited before completion.'`.
- **Chat Turns:** `ConversationTurnService` persists the user message **before** streaming begins and persists the assistant message **only** upon completion (with full citations/claims) or graceful cancellation/error (with `isPartial: true`). Therefore, an abrupt process crash during Chat streaming leaves zero half-written assistant messages falsely marked as completed; only the user message exists in SQLite, ready for Retry.

---

## 8. Navigation & Bot-Switch Behavior

- **Bot Switch (`conversationId` or `botId` prop change without unmount):**
  - `useConversationTurn` resets local hook state (`stage = 'idle'`, `streamingText = ''`, `activeRequestIdRef.current = null`) and ignores late events whose `requestId !== activeRequestIdRef.current`. It does **not** cancel an in-flight request in Main on `conversationId` change alone.
  - `useAgentTaskEvents` resets local task state and filters out events where `event.botId !== botIdRef.current`. Background Agent runs continue in Main and can be recovered when switching back via `getRun` / `listToolEvents`.
- **Component Unmount (navigating away from Chat view):** `useConversationTurn`'s unmount effect calls `api.cancelGeneration(currentReqId)` to cancel the active Chat stream.
- **Top-Level Navigation vs In-Place Hash Navigation:** `ConversationStreamManager` ignores `did-start-navigation` when `isInPlace === true` (SPA hash route transitions) and aborts all window streams when `isInPlace !== true` (Test 52).

---

## 9. Unrelated-File Formatting & Modified Files Audit

- **Broad `npx eslint --fix .` audit:** During initial Step 12.7 verification, ESLint reported 23 Prettier warnings exclusively in 6 Step 12.7 files (`conversation-bridge.test.ts`, `conversation-persistence-service.test.ts`, `conversation-turn-service.ts`, `streaming-lifecycle.test.ts`, `ConversationMessage.tsx`, `conversations.ts`). Zero unrelated files were modified by `npx eslint --fix .`. Subsequent linting used targeted file paths only.
- **Pre-existing unstaged files preserved:** `src/main/documents/` changes (from post-Phase-11 document validation work) and Steps 12.1–12.6 changes remain untouched in the working tree.
- **Step 12.7 Files Created / Modified:**
  - Created: `src/main/services/streaming-lifecycle.test.ts`, `docs/phase-12/step-12.7-implementation-report.md`
  - Modified: `src/shared/conversations.ts`, `src/shared/agents.ts`, `src/main/database/repositories/message-repository.ts`, `src/main/services/conversation-persistence-service.ts`, `src/main/services/conversation-persistence-service.test.ts`, `src/main/services/conversation-turn-service.ts`, `src/main/services/conversation-turn-service.test.ts`, `src/main/services/phase-7-e2e-rag-security.test.ts`, `src/main/ipc/conversation-stream-manager.ts`, `src/main/ipc/agent-stream-manager.ts`, `src/main/ipc/conversation-handlers.ts`, `src/main/ipc/agent-handlers.ts`, `src/main/ipc/conversation-bridge.test.ts`, `src/main/ipc/agent-bridge.test.ts`, `src/preload/index.ts`, `src/renderer/src/hooks/useConversationTurn.ts`, `src/renderer/src/hooks/useConversationTurn.test.tsx`, `src/renderer/src/hooks/useAgentTaskEvents.ts`, `src/renderer/src/hooks/useAgentTaskEvents.test.tsx`, `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx`, `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.test.tsx`, `src/renderer/src/components/chat/ConversationMessage.tsx`.

---

## 10. Final Verification Results

| Check | Command | Exit Code | Exact Result |
|:---|:---|:---:|:---|
| **TypeScript Typecheck** | `npm run typecheck` | `0` | Node + Web `tsc --noEmit` clean (0 errors) |
| **ESLint** | `npm run lint` | `0` | 0 errors (1 pre-existing `react-hooks/exhaustive-deps` warning in `BotConfigurationForm.tsx`) |
| **Full Test Suite** | `npm run test` | `0` | **214 test files passed (214/214)**, **3,346 tests passed (3,346/3,346)** |
| **Production Build** | `npm run build` | `0` | Main (`1,342.15 kB`), Preload (`267.13 kB`), Renderer (`2,302.77 kB`) built cleanly |

### Baseline Comparison
- **Step 12.6 baseline:** 213 test files, 3,300 tests.
- **Step 12.7 audited baseline:** 214 test files, 3,344 tests.
- **Step 12.7 final (after mandatory `botId` contract):** 214 test files, 3,346 tests (+2 tests in `streaming-lifecycle.test.ts`: Tests 53 and 54; +46 total tests over Step 12.6).

---

## 11. Remaining Limitations

1. **xAI & OpenRouter:** Not yet implemented in `SUPPORTED_PROVIDER_IDS` or `src/main/providers/`; only OpenAI, Anthropic, and Google Gemini are active.
2. **Non-abort-aware tools:** If a synchronous or third-party tool ignores `AbortSignal`, cancellation waits for that single in-flight tool call to return (up to `toolTimeoutMs`) before marking the run `'cancelled'` and halting further iterations.
3. **Abrupt crash mid-Chat stream:** Because partial Chat text is buffered in Main memory until `finish` or graceful cancellation/error, an abrupt SIGKILL mid-stream preserves the user message for Retry but does not recover unpersisted memory deltas.
