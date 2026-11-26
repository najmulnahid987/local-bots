# Phase 12 — Step 12.6 Implementation Report: Explicit Chat and Agent Mode Separation

**Project:** Local-First Multi-Model AI Agent Workspace (`Local Bots`)  
**Phase:** 12 — Unified Bot Experience  
**Step:** 12.6 — Explicit Chat and Agent Mode Separation  
**Status:** Implementation Complete & Fully Verified  
**Date:** November 2026  

---

## 1. Executive Summary

Phase 12, Step 12.6 establishes a clear, secure, and predictable separation between **Chat execution** and **Agent execution** within each Bot's canonical persistent conversation.

Prior to this step, user queries and agent tasks shared overlapping execution terminology, and model generation outputs could theoretically attempt to emit tool-call syntax within normal conversational contexts. Step 12.6 introduces an explicit, deterministic boundary:
- **Chat mode (`'chat'`)**: Strictly conversational interaction. Employs the Bot's configured response policy (`strict_kb_only`, `balanced_kb_first`, `general_ai_chat`) and parent Knowledge Base retrieval index. Zero tools are exposed to the AI provider, zero tool executions can take place, zero agent runs are allocated, and model-generated pseudo-tool tokens are treated as non-executable text deltas.
- **Agent mode (`'agent'`)**: Explicitly requested tasks. Executes through the hardened `BoundedAgentRuntime` with strict Main-process authorization of `bot_tool_permissions`. Supports up to 5 bounded iterations, user approval gates (for filesystem write operations like `save_report`), full tool-event auditing in SQLite `tool_events`, and evidence provenance tracking.

The user explicitly selects the active execution mode in the UI composer (`ConversationComposer`), defaulting to `'chat'`. The execution mode is **never** inferred from prompt semantics, model outputs, or enabled tools.

---

## 2. Inviolable Architectural Invariants Upheld

| Invariant | Implementation Enforcement | Verification |
|---|---|---|
| **1 Bot : 1 Canonical Conversation** | All Chat turns and Agent tasks execute against and persist into the Bot's exact single canonical conversation thread (`conversations WHERE bot_id = :id`). | Scenarios 1, 11, 17, 20, 25 |
| **No Tool Execution in Chat** | In Chat mode, `ConversationTurnService` never passes tool descriptors to AI SDK, never registers tools in execution context, never invokes `ToolRegistry`, and rejects requests forged with `executionMode === 'agent'`. | Scenarios 1–6, 21, 26 |
| **Main-Process Authorization for Agent** | In Agent mode, `AgentTaskService` loads authoritative tool permissions directly from SQLite `bots.tool_permissions`. Renderer requests cannot grant or execute disabled, unauthorized, or cross-Bot tools. | Scenarios 12–16, 22, 23 |
| **Response Policy & Tool Orthogonality** | Response policies (`strict_kb_only`, `balanced_kb_first`, `general_ai_chat`) and tool permissions (`search_knowledge_base`, `save_report`, etc.) remain strictly orthogonal. Chat continues respecting response policies without interference from agent tools. | Scenarios 7–9, 32 |
| **Zero Plaintext Secrets & Renderer Protection** | Outbound AI requests originate strictly from Electron Main process using decrypted credentials in ephemeral memory. No API keys or unrestricted Node primitives cross IPC. | Scenarios 6, 21, 22 |
| **Zero-Trust Model Decisions** | Model decisions cannot trigger mode escalation or execute unapproved tools. Malformed tool arguments or unknown tools fail gracefully without application crash. | Scenarios 3, 14–16, 26 |

---

## 3. Architectural Separation & Execution Pipelines

```
                                  USER INTERFACE (Renderer)
                 ┌────────────────────────────────────────────────────────┐
                 │ ConversationComposer: Mode Selector ('chat' | 'agent') │
                 └───────────────────┬────────────────────────────────┬───┘
                                     │                                │
                      [Chat Mode]    │                                │ [Agent Mode]
                     'chat' (Default)│                                │ Explicit Click
                                     ▼                                ▼
                     sendMessageIpc / IPC Bridge             dispatchAgentTaskIpc / IPC Bridge
                                     │                                │
═════════════════════════════════════╪════════════════════════════════╪════════════════════════════════
                        ELECTRON MAIN PROCESS (Privileged Boundary)
                                     │                                │
                        Zod: executionMode !== 'agent'      Zod: executionMode === 'agent'
                                     │                                │
                                     ▼                                ▼
                       ConversationTurnService                 AgentTaskService
                                     │                                │
                 ┌───────────────────┴───────────────────┐    Authoritative DB Bot Tool Resolution
                 │ - Response Policy Evaluation          │    (SELECT tool_permissions FROM bots)
                 │ - Retrieval & Evidence Assessment     │            │
                 │ - Zero Tools Exposed to Provider      │            ▼
                 │ - Provenance & Claim Validation       │    BoundedAgentRuntime (Max 5 Loops)
                 └───────────────────┬───────────────────┘            │
                                     │                        ┌───────┴───────────────────────┐
                                     │                        │ - StepExecutor Decision Loop  │
                                     │                        │ - Application Tool Auth Check │
                                     │                        │ - User Approval Modal (Save)  │
                                     │                        │ - Tool Event Persistence      │
                                     │                        └───────┬───────────────────────┘
                                     ▼                                │
                   persistAssistantMessage (SQLite)                   ▼
                   metadata.executionMode = 'chat'     persistAssistantMessage (SQLite)
                                                       metadata.executionMode = 'agent'
                                                       metadata.agentRunId = run.id
                                                       metadata.toolCalls = [ ... ]
```

### 3.1 Chat Execution Pipeline
1. **Invocation**: Initiated via `turnService.sendMessage(...)`.
2. **Schema Enforcement**: `sendMessageRequestSchema` and `sendMessageIpcRequestSchema` strictly require `executionMode !== 'agent'` (refinement error: `Chat endpoint does not permit agent execution mode. Dispatch an agent task instead.`).
3. **Execution Guard**: `ConversationTurnService` asserts `validatedRequest.executionMode === 'chat'`.
4. **Provider Isolation**: No tools are passed to `ConversationExecutionService`.
5. **Model Tool Syntax Handling**: If an LLM emits tool-calling JSON or `finishReason: 'tool_calls'`, it is captured strictly as an assistant text delta without executing tools or creating `agent_runs`.
6. **Persistence**: `ConversationPersistenceService.persistUserMessage` and `persistAssistantMessage` stamp `metadata.executionMode = 'chat'`.

### 3.2 Agent Execution Pipeline
1. **Invocation**: Initiated via `agentTaskService.dispatchTask(...)`.
2. **Authoritative Resolution**: `botRepo.getByIdScoped(...)` loads `toolPermissions` from the database. The Main process never accepts tool configurations from the caller.
3. **Pre-flight Tool Check**: If the Bot has 0 enabled tools in SQLite, the task is rejected upfront (`Bot '<name>' has no enabled Phase 8 tools to execute tasks`).
4. **Runtime Execution**: Handled by `BoundedAgentRuntime.run(...)` with:
   - Hard iteration cap of 5 cycles.
   - Tool timeout of 30 seconds (or extended timeout for user approval).
   - User approval gate via `ApprovalController` for filesystem writes (`save_report`).
   - Audit trail recorded in `agent_runs` and `tool_events` tables.
5. **Persistence**: Stamped with `metadata.executionMode = 'agent'`, `metadata.agentRunId`, and mapped `toolCalls`.

---

## 4. User Experience & Interface Enhancements

### 4.1 Mode Selector in `ConversationComposer.tsx`
- **Two-Segment Segmented Control**: Positioned prominently in the composer header with `Chat` (`MessageSquare` icon) and `Agent Task` (`Bot` icon).
- **Default State**: Automatically defaults to `'chat'`.
- **Keyboard & Typing Invariance**: Typing in the prompt textarea never automatically toggles the mode.
- **Bot Switching Invariance**: Switching active Bots immediately resets the composer mode to `'chat'`.
- **Visual Context Panel (`agent-tools-info`)**:
  - In Agent mode, when tools exist, displays an amber banner showing the count of enabled tools (e.g., `2 tools enabled: search_knowledge_base, read_knowledge_source`).
  - In Agent mode, when a Bot has 0 enabled tools, displays an amber alert banner: `This Bot has no enabled tools. Configure tools in Bot settings to execute Agent tasks.`, and disables the dispatch button.
- **Submission Path Routing**:
  - Chat mode: Enter or click submits through `onSend(content)`.
  - Agent mode: Enter or click submits through `onDispatchTask(content, workspaceAccessRequested)`.

### 4.2 Conversation History & Message Badging in `ConversationMessage.tsx`
- **Agent Task Pill**: Messages originating from Agent execution display an amber badge:
  ```tsx
  <span data-testid={`message-execution-mode-${message.id}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
    <Bot className="w-3 h-3 text-amber-400" />
    Agent Task
  </span>
  ```
- **Chat Messages & Historical Messages**: Ordinary chat messages and historical messages created before Step 12.6 render cleanly without badges or errors.

---

## 5. Metadata Schema & Database Invariance

In strict compliance with repository constraints:
- **Zero Database Schema Modifications**: No new SQLite tables, columns, or migration files were introduced for Step 12.6.
- **Structured JSON Metadata**: Execution mode is stored within the existing SQLite `metadata` JSON column of `messages`:
  ```ts
  export interface MessageMetadataDto {
    readonly executionMode?: 'chat' | 'agent'
    readonly agentRunId?: string
    readonly toolCalls?: readonly MessageToolCallDto[]
    readonly groundingMode?: MessageGroundingMode
    readonly citations?: readonly CitationDto[]
    // ...
  }
  ```
- **Backward & Forward Compatibility**:
  - Legacy messages with `executionMode === undefined` parse cleanly via `z.enum(['chat', 'agent']).optional()`.
  - JSON exports and imports preserve `executionMode` without loss.

---

## 6. Comprehensive Test Suite & Verification Results

A dedicated backend test suite (`src/main/services/chat-agent-mode-separation.test.ts`) and targeted UI tests were authored to verify all 34 required scenarios:

### Section 1: Chat No-Tool-Execution Tests (Scenarios 1 – 10)
- **Scenario 1**: Chat works normally with no enabled tools (`executionMode: 'chat'`).
- **Scenario 2**: Chat remains tool-free when the Bot has enabled tools (zero runs, zero tool events).
- **Scenario 3**: Model-generated pseudo-tool calls in Chat do not execute.
- **Scenario 4**: Chat does not create an Agent run record in SQLite.
- **Scenario 5**: Chat does not create Agent tool event records in SQLite.
- **Scenario 6**: Forged Agent mode payloads sent to the Chat endpoint are rejected by Zod and runtime validation.
- **Scenario 7**: Chat continues respecting Strict KB-only behavior (application-level refusal when documents are missing).
- **Scenario 8**: Chat continues respecting Balanced retrieval and fallback (`general_fallback_no_usable_kb`).
- **Scenario 9**: Chat continues respecting General AI behavior (`general_chat`).
- **Scenario 10**: Existing provenance and authentic citation validation continue functioning seamlessly in Chat.

### Section 2: Agent Execution Tests (Scenarios 11 – 20)
- **Scenario 11**: Explicit Agent mode reaches the existing Agent execution pipeline (`runStatus: 'completed'`).
- **Scenario 12**: Agent mode loads authoritative Bot permissions from SQLite in Main process (rejects toolless bot).
- **Scenario 13**: Enabled tools execute through the authorized path (`search_knowledge_base`).
- **Scenario 14**: Disabled tools cannot execute (`save_report` denied for bot without permission).
- **Scenario 15**: Unknown / unregistered tools cannot execute (rejected by identifier validation).
- **Scenario 16**: Malformed tool arguments are rejected gracefully without crashing.
- **Scenario 17**: Agent runs are associated with the correct Bot and canonical conversation.
- **Scenario 18**: Tool events are associated with the correct Agent run.
- **Scenario 19**: Failed tool execution is not reported as successful.
- **Scenario 20**: Agent result persistence retains the existing execution and audit data (`agentRunId`, `toolCalls`).

### Section 3: Cross-Mode Isolation and Security Tests (Scenarios 21 – 28)
- **Scenario 21**: Chat cannot call Agent-only IPC operations (schema rejects `executionMode: 'chat'` in dispatch).
- **Scenario 22**: Renderer cannot override Main-process tool permissions.
- **Scenario 23**: An Agent cannot access another Bot's tools or cross-Knowledge Base resources.
- **Scenario 24**: Switching Bots does not leak Agent state, runs, or tool events.
- **Scenario 25**: Switching from Agent to Chat in the same canonical conversation does not carry over permissions or trigger tools.
- **Scenario 26**: Model-generated text cannot change the selected execution mode.
- **Scenario 27**: Archived or unavailable Bots cannot execute Agent tasks.
- **Scenario 28**: Conversation and Bot ID mismatches are strictly rejected.

### Section 4: User Experience & History Tests (Scenarios 29 – 34)
- **Scenario 29**: Default mode is chat when the composer loads (`composer-mode-chat-btn` aria-pressed true).
- **Scenario 30**: Mode indicator is visible and displays enabled tool count badges when Agent mode is clicked.
- **Scenario 31**: Mode switch is explicit; typing does not toggle mode; switching bots resets mode to chat.
- **Scenario 32**: Switching modes does not alter Bot permissions or response policy.
- **Scenario 33**: Task submission routes through `onSend` in Chat mode and `onDispatchTask` in Agent mode.
- **Scenario 33b**: Bot with 0 enabled tools in Agent mode displays warning alert and disables dispatch button.
- **Scenario 34**: Legacy messages without `executionMode` render cleanly without badges; Agent task messages display the `Agent Task` badge.

---

## 7. Verification Logs & Metrics

### 7.1 Typecheck
```
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
Command exited with code 0.
```

### 7.2 Lint
```
> eslint --cache .
✖ 1 problem (0 errors, 1 warning)
Command exited with code 0.
```

### 7.3 Automated Test Suite
```
 Test Files  213 passed (213)
      Tests  3300 passed (3300)
   Start at  12:45:09
   Duration  81.65s
Command exited with code 0.
```

### 7.4 Production Build
```
✓ built in 921ms (out/main/index.js: 1,329.66 kB)
✓ built in 107ms (out/preload/index.js: 266.65 kB)
✓ built in 954ms (out/renderer/assets/index-DRP7-7lk.js: 2,299.93 kB)
Command exited with code 0.
```

---

## 8. Modified & Created Files Summary

| File Path | Role in Step 12.6 |
|---|---|
| `src/shared/conversations.ts` | Added `ExecutionMode` contract, `executionMode` to `MessageMetadataDto`, and strict `executionMode !== 'agent'` refinement on chat requests. |
| `src/shared/agents.ts` | Added `executionMode: 'agent'` literal to `DispatchAgentTaskRequest` schema. |
| `src/main/services/conversation-turn-service.ts` | Enforced Main-process check that chat requests cannot execute agent operations. |
| `src/main/services/conversation-persistence-service.ts` | Stamped `executionMode: 'chat'` on persisted user and assistant chat messages. |
| `src/main/services/agent-task-service.ts` | Stamped `executionMode: 'agent'` on user task and assistant response messages. |
| `src/renderer/src/components/chat/ConversationComposer.tsx` | Added explicit mode switcher, tool count badge, toolless warning banner, and route-based reset. |
| `src/renderer/src/pages/workspace/BotConversationsWorkspacePage.tsx` | Managed `executionMode` state with automatic reset to `'chat'` on bot selection change. |
| `src/renderer/src/components/chat/ConversationMessage.tsx` | Added `Agent Task` status pill for messages with `executionMode === 'agent'`. |
| `src/main/services/chat-agent-mode-separation.test.ts` | **(New file)** Authoritative backend test suite covering Scenarios 1–28. |
| `src/renderer/src/components/chat/ConversationComposer.test.tsx` | Added UI mode separation tests covering Scenarios 29–33b. |
| `src/renderer/src/components/chat/ChatPresentation.test.tsx` | Added presentation test covering Scenario 34 (legacy vs. agent badge). |
| `docs/phase-12/step-12.6-implementation-report.md` | **(New file)** Comprehensive implementation and audit deliverable. |

---

## 9. Phase 12 Step 12.6 Phase Gate Sign-off

- [x] Clear, secure, and predictable separation between Chat mode and Agent mode implemented.
- [x] Zero tool execution and zero agent run creation guaranteed in Chat mode.
- [x] Main-process authoritative permission resolution guaranteed in Agent mode.
- [x] Explicit UI selection with default to Chat and automatic reset on bot navigation.
- [x] Zero database migrations required; backward/forward compatibility preserved.
- [x] All 34 required test scenarios passing across backend and frontend.
- [x] Full test suite (213 files, 3,300 tests) passing with 0 failures.
- [x] TypeScript type check, ESLint, and production build succeeded cleanly.
- [x] Working tree clean of any git staging or commits.

**Gate Decision:** Step 12.6 is complete and ready for human architectural review. Proceeding to Step 12.7 is deferred pending user authorization.
