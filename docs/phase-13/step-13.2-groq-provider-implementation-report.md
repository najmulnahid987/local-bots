# Phase 13 — Step 13.2: Groq Provider Integration Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`local-first-ai-workspace`)  
**Phase:** 13 — Multi-Provider Expansion & Response Performance  
**Step:** 13.2 — Groq Provider Integration  
**Status:** Complete & Verified at Step 13.2 Gate  
**Date:** 2026-11-27

---

## 1. Executive Summary

Groq (`groq`) has been integrated into Local Bots as a full first-class BYOK provider alongside OpenAI, Anthropic, and Google Gemini through the unified Electron Main-process architecture:

`React Renderer → Preload → Main IPC → ProviderManagerService → GroqAdapter → Direct HTTPS (https://api.groq.com/openai/v1) → Groq API`

All existing security, local-first, privacy, KB-isolation, response-policy, Agent tool-calling boundary, and credential encryption invariants remain preserved:
- Zero API keys leave the Main process or enter SQLite, logs, diagnostics, IPC events, Renderer DOM, or backup archives.
- Dynamic Groq model discovery works cleanly across Bot configuration, Chat, Agent tool gating, and application restarts via connection-scoped disk persistence (`discovered-models-cache.json`) without requiring per-message `/models` calls.
- All **219** Vitest test files (**3,392** tests), `npm run typecheck`, `npm run lint`, and `npm run build` pass cleanly.
- Neither OpenRouter nor Perplexity was added in Step 13.2, and no Git staging, commits, resets, or Step 13.3+ work were started.

---

## 2. Dependency & Compatibility Verification

- Installed exact package: `@ai-sdk/groq@4.0.88` (via `npm install --save-exact @ai-sdk/groq@4.0.88`, without `--legacy-peer-deps`).
- Resolved peer/transitive dependencies cleanly:
  - `@ai-sdk/groq@4.0.88` depends on `@ai-sdk/provider@4.0.39` and `@ai-sdk/provider-utils@5.0.85`, with peer `zod@^3.25.76 || ^4.1.8` (compatible with workspace `zod@4.6.7`).
  - Core `ai@7.0.164` and existing adapters (`@ai-sdk/openai@4.0.110`, `@ai-sdk/google@4.0.112`, `@ai-sdk/anthropic@4.0.98`) were kept un-upgraded and intact.

---

## 3. Architectural & Schema Changes Implemented

### 3.1 Provider Identity Contracts & Secret Redaction
- Added `'groq'` to authoritative provider contracts and validation schemas:
  - `src/shared/providers.ts` (`SUPPORTED_PROVIDERS`, `ENABLED_PROVIDERS`)
  - `src/main/providers/types.ts` (`SUPPORTED_PROVIDER_IDS`, plus optional `ConnectionTestResult.discoveredModels` and `ProviderAdapter.discoverModelMetadata`)
  - `src/main/database/repositories/types.ts` (`ALL_DATABASE_PROVIDER_IDS`) & `src/main/database/repositories/provider-connection-repository.ts`
  - `src/main/ipc/provider-validation.ts` (`PROVIDER_ID_SCHEMA`)
- Extended secret scanning and diagnostic/error redaction for Groq `gsk_...` keys across:
  - `src/main/services/secret-scanner.ts` (`Groq API Key`)
  - `src/main/services/diagnostic-sanitizer.ts` (`Groq Key`)
  - `src/main/providers/provider-manager/errors.ts` (`sanitizeErrorMessage`)
  - `src/main/ipc/conversation-validation.ts` (`sanitizeConversationErrorMessage`)
  - `src/main/ipc/agent-validation.ts` (`sanitizeAgentErrorMessage`)
  - `src/renderer/src/hooks/useConversationTurn.ts`
  - `src/main/providers/groq/errors.ts` (`redactGroqSecrets`)

### 3.2 SQLite Migration 014 (`014_add_groq_provider.sql`)
- Added `src/main/database/migrations/014_add_groq_provider.sql` and registered version `14` (`add_groq_provider`, `disableForeignKeysForTableRebuild: true`) in `src/main/database/migrations/index.ts`.
- Safely rebuilds `provider_connections` with `CHECK (provider_id IN ('openai', 'anthropic', 'google', 'groq', 'xai', 'openrouter'))`, copies all existing rows, preserves `bots.provider_connection_id` foreign-key links, and recreates `idx_provider_connections_provider` and `idx_provider_connections_ref`.
- Covered by `src/main/database/migrations/014_add_groq_provider.test.ts` (3 tests verifying v13→v14 upgrade data preservation, `groq` insertion & invalid provider rejection including `'perplexity'`, and idempotency).

### 3.3 `GroqAdapter` & Curated / Conservative Model Metadata (`src/main/providers/groq/`)
- **`src/main/providers/groq/types.ts`**: Defines `GROQ_OFFICIAL_BASE_URL = 'https://api.groq.com/openai/v1'`, `GROQ_DEFAULT_TEST_MODEL = 'llama-3.1-8b-instant'`, timeouts, and `/models` API wire interfaces.
- **`src/main/providers/groq/model-metadata.ts`**:
  - Curated verified profiles (`GROQ_CURATED_MODEL_PROFILES`) for `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3-32b`, `moonshotai/kimi-k2-instruct-0905`, `meta-llama/llama-4-scout-17b-16e-instruct`, `meta-llama/llama-4-maverick-17b-128e-instruct`, `groq/compound`, and `groq/compound-mini`.
  - Excludes non-chat audio/TTS/guard models (`whisper-large-v3`, `whisper-large-v3-turbo`, `playai-tts`, `orpheus`, `llama-guard`, `llama-prompt-guard`) via `isNonChatGroqModel()`.
  - Applies safe conservative defaults (`streaming: true, tools: false, imageInput: false, structuredOutput: false`) to unknown dynamically discovered models via `buildGroqModelDescriptorFromApi()` while extracting `context_window` and `max_completion_tokens`.
- **`src/main/providers/groq/groq-adapter.ts`**:
  - Enforces HTTPS-only base URL validation (`https://api.groq.com/openai/v1`).
  - Uses `@ai-sdk/groq` (`createGroq`) with wire-safe `fetch` filtering out Groq-unsupported OpenAI parameters (`logprobs`, `top_logprobs`, `logit_bias`, `store`, `metadata`, `n`, `messages[].name`), converting `reasoning_format: 'raw'` to `'parsed'` when tools/response_format are present, and clamping temperature within `[0, 2]`.
  - Implements zero-token `testConnection()` via `GET /openai/v1/models`, `discoverAvailableModels()`, `discoverModelMetadata()`, `generateText()`, and `streamText()` with abort/timeout composition (`AbortController`) and guaranteed terminal chunk emission on early/mid-stream abort.
- **`src/main/providers/groq/errors.ts`**: Classifies and sanitizes HTTP `401`, `403`, `404`/`model_decommissioned`, `413`/`context_length_exceeded`, `429` (`RATE_LIMITED` vs `QUOTA_EXCEEDED`), `400`/`422` (`tool_use_failed`, `json_validate_failed`), `5xx`, network, timeout, and abort errors, redacting `gsk_...` secrets before returning or recording to `defaultErrorRingBuffer`.

### 3.4 Dynamic Model Resolution, Persistence & Agent Runtime Integration
- **`src/main/providers/provider-registry.ts`**:
  - Added connection-scoped discovered model storage (`setDiscoveredModels`, `clearDiscoveredModels`, `getDiscoveredModels`, `configurePersistence`) backed by `<userData>/discovered-models-cache.json` (initialized in `src/main/index.ts`).
  - Updated `getModel(providerId, modelId, connectionId?)` and `getModels(providerId?, connectionId?)` so authenticated discovered models resolve consistently across restarts without leaking models across connections or permitting unauthenticated/forged IDs or optimistic tool capabilities.
- **`src/main/providers/capability-validator.ts`**: Updated `validateBotModelCompatibility()` to pass `providerConnectionId` to `registry.getModel(...)`.
- **`src/main/providers/provider-manager/provider-manager-service.ts`**:
  - Registered `GroqAdapter` and exposed public `resolveAdapter(providerId)`.
  - Fixed dynamic model execution in `generateText()`, `streamText()`, `testConnection()`, `replaceCredential()`, `removeConnection()`, `getAvailableModels()`, and `mapToSummary()`, using `recordDiscoveredModels()` and conservative fallback descriptors instead of granting optimistic capabilities.
- **`src/main/agents/ai-sdk-agent-model-step-executor.ts` & `src/main/services/agent-task-service.ts`**:
  - Removed the 3-provider switch in `AiSdkAgentModelStepExecutor` in favor of a provider map + shared `adapterResolver` (wired in `src/main/index.ts` via `providerManager.resolveAdapter(providerId)`).
  - Updated both `AiSdkAgentModelStepExecutor` and `AgentTaskService` to pass `connection.id` into `providerRegistry.getModel(...)` while preserving strict native tool-calling checks (`providerCapabilities?.tools === true`) and single-tool-call bounds.
- **`src/main/providers/model-catalog.ts`**: Added `groq` provider descriptor and curated Groq model catalog entries.

### 3.5 Renderer UI Updates
- `src/renderer/src/components/settings/ProviderConnectionCard.tsx`: Added `'groq' -> 'Groq'` display name mapping.
- `src/renderer/src/components/settings/ProviderPrivacyInformation.tsx`: Added Groq API privacy & data handling disclosure linking to Groq documentation.
- `src/renderer/src/components/settings/AddProviderConnectionDialog.tsx`: Shows Groq key hint (`Enter Groq API key (gsk_...)`) when `'groq'` is selected.
- `src/renderer/src/components/bots/BotConfigurationForm.tsx`: Updated `selectableModels` resolution for `connection.availableModels` so discovered models belonging to the connection's provider display immediately and remain selectable cleanly across restarts.

---

## 4. Verification Results

All checks ran cleanly after the final code edits:

1. **TypeScript Typecheck (`npm run typecheck`):** Passed (`0` errors across `tsconfig.node.json` and `tsconfig.web.json`).
2. **ESLint (`npm run lint`):** Passed (`0` errors; `1` pre-existing warning in untouched hook dependency array in `BotConfigurationForm.tsx`).
3. **Production Build (`npm run build`):** Passed (`electron-vite build` succeeded for `main`, `preload`, and `renderer`).
4. **Full Vitest Suite (`npm test`):**
   - **219 / 219 test files passed (`219`)**
   - **3,392 / 3,392 tests passed (`3,392`)**
   - **0 failed, 0 skipped**, duration `58.21s`
   - Includes new Groq test coverage in:
     - `src/main/database/migrations/014_add_groq_provider.test.ts` (3 tests)
     - `src/main/providers/groq/groq-adapter.test.ts` (10 tests)
     - `src/main/providers/groq/groq-e2e-integration.test.ts` (3 tests covering dynamic model restart persistence without extra `/models` requests, all 3 Bot response policies + BoundedAgentRuntime tool execution + non-tool Groq model gating, backup export/import + `gsk_` secret blocking/redaction)
     - Updated UI tests in `src/renderer/src/components/settings/ProviderConnections.test.tsx` (29 tests) and `src/renderer/src/components/bots/BotConfigurationForm.test.tsx` (13 tests)
     - Updated registry tests in `src/main/providers/provider-registry.test.ts` (18 tests)
5. **Git Safety Verification:**
   - Pre-existing modified files (`anthropic/*`, `openai/*`) preserved intact without regression (`anthropic-adapter.test.ts` 38/38, `openai-adapter.test.ts` 30/30 passing).
   - No Git staging, commit, amend, reset, or push performed.
