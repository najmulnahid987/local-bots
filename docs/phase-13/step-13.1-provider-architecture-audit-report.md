# Phase 13 — Step 13.1: Provider Architecture Audit & Performance Baseline

**Project:** Local-First Multi-Model AI Agent Workspace (Local Bots)  
**Phase:** 13 — Multi-Provider Expansion & Response Performance  
**Step:** 13.1 — Provider Architecture Audit & Performance Baseline  
**Audit Date:** November 27, 2026  
**Status:** Complete (Audit & Baseline Only — No Provider Integration Performed)

> **Epistemic Tagging:** Throughout this report, statements are explicitly distinguished as **[Verified Fact]** (directly observed in repository source files, `package.json`, `npm view`, or command output), **[Measured]** (timed execution in Vitest/Node), **[Estimate]** (engineering complexity or scaling projection), or **[Recommendation]** (proposed design for Steps 13.2–13.5).

---

## 1. Objective and Scope

### Objective
**[Verified Fact]** Prepare Local Bots to expand from its three existing providers (`openai`, `anthropic`, `google`) to six providers by adding:
1. **Groq** (`groq`)
2. **OpenRouter** (`openrouter`)
3. **Perplexity** (`perplexity`)

Establish a reproducible baseline for response latency, streaming smoothness, provider consistency, credential safety, and error handling across the existing stack before implementing any new provider in Steps 13.2–13.4 or performance optimizations in Step 13.5.

### Scope Boundaries Honored in Step 13.1
- **No implementation code modified:** Zero changes to Main, Preload, Renderer, SQLite migrations, or `package.json` / `package-lock.json`.
- **No new providers added:** Groq, OpenRouter, and Perplexity are not implemented in Step 13.1.
- **No AI SDK major upgrades:** Existing `ai@7.0.164` and `@ai-sdk/*@4.0.x` packages remain untouched.
- **No proxy, gateway, cloud database, or telemetry introduced:** Preserves BYOK, direct HTTPS, `CredentialVault` + `safeStorage`, and Electron sandboxing (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`).
- **No Git mutations:** No `git add`, `commit`, `push`, `reset`, `clean`, `restore`, or `stash` executed.

---

## 2. Git-State Findings

**[Verified Fact]** Inspected via read-only Git commands (`git status --short`, `git status`, `git branch --show-current`, `git rev-parse HEAD`, `git log -10 --oneline --decorate`, `git diff --stat`, `git diff --cached --stat`) prior to any work:

- **Current Branch:** `main` (up to date with `origin/main`)
- **Current HEAD:** `10a8c62bc5f2f0605f0374088609ab293c4964a2` (`nice work`, 1 commit ahead of Step 12.9's recorded `a2bf8908b6a93621f4cbc831059ed723b4f126ce`)
- **Staged Changes (`git diff --cached --stat`):** None (`0` files)
- **Pre-Existing Unstaged Modified Files (`8` files, `800 insertions(+), 93 deletions(-)`):**
  - `src/main/providers/anthropic/anthropic-adapter.test.ts`
  - `src/main/providers/anthropic/anthropic-adapter.ts`
  - `src/main/providers/anthropic/errors.ts`
  - `src/main/providers/anthropic/types.ts`
  - `src/main/providers/openai/errors.ts`
  - `src/main/providers/openai/openai-adapter.test.ts`
  - `src/main/providers/openai/openai-adapter.ts`
  - `src/main/providers/openai/types.ts`
- **Summary of Pre-Existing Unstaged Diff:** Aligns `OpenAIAdapter` and `AnthropicAdapter` with GoogleAdapter hardening committed in `10a8c62` (`DEFAULT_GENERATION_TIMEOUT_MS` raised from `60000` to `120000`, early `return` after `finish`/`error`/`abort` stream chunks, `pushMergedTextMessage` consecutive-role merging, empty-message skipping, and structured `collectErrorMetadata` error unwrapping in `errors.ts`).
- **Pre-Existing Untracked Files:** `0` files prior to creating this report.

---

## 3. Actual Provider Architecture

### 3.1 Source-of-Truth Documentation vs. Implementation Reality
**[Verified Fact]** Cross-checking `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/providers/PHASE_3_PROVIDER_SECURITY_DESIGN.md`, `docs/adr/ADR-0003-byok-provider-architecture.md`, and `docs/phase-12/step-12.10-final-integration-audit-report.md` against the actual codebase reveals:
- Spec documents originally planned 5 providers (`openai`, `anthropic`, `google`, `xai`, `openrouter`), reflected in:
  - `src/shared/providers.ts`: `SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'google', 'xai', 'openrouter']` and `FIRST_WAVE_PROVIDERS = ['openai', 'anthropic', 'google']`.
  - `src/main/database/migrations/002_provider_credential_refs.sql`: `CHECK (provider_id IN ('openai', 'anthropic', 'google', 'xai', 'openrouter'))`.
  - `src/main/database/repositories/types.ts`: `ALL_DATABASE_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'xai', 'openrouter']`.
- Runtime provider code currently implements only the 3 first-wave providers (`openai`, `anthropic`, `google`):
  - `src/main/providers/types.ts`: `SUPPORTED_PROVIDER_IDS = ['openai', 'anthropic', 'google']`.
  - `src/main/ipc/provider-validation.ts`: `PROVIDER_ID_SCHEMA = z.enum(FIRST_WAVE_PROVIDERS)`.
  - `src/main/providers/provider-manager/provider-manager-service.ts`: instantiates only `openai`, `anthropic`, `google` adapters.
- Neither `groq` nor `perplexity` exists anywhere in `SUPPORTED_PROVIDERS`, `SUPPORTED_PROVIDER_IDS`, or the SQLite `CHECK` constraint yet.

### 3.2 Provider Contracts & Registry
**[Verified Fact]** Key modules inspected:
- **`ProviderAdapter` (`src/main/providers/types.ts`):**
  - `readonly providerId: ProviderId`
  - `testConnection(apiKey: string, modelId?: string, signal?: AbortSignal): Promise<ConnectionTestResult>`
  - `generateText(apiKey: string, options: GenerateTextOptions): Promise<GenerateTextResult>`
  - `streamText(apiKey: string, options: GenerateTextOptions): AsyncIterable<StreamTextChunk>`
  - `discoverAvailableModels?(apiKey: string, signal?: AbortSignal): Promise<readonly string[]>`
- **`ProviderRegistry` (`src/main/providers/provider-registry.ts`):**
  - Immutable singleton (`providerRegistry`) deep-freezing `INITIAL_PROVIDERS` and `INITIAL_MODELS` from `src/main/providers/model-catalog.ts`.
  - Validates uniqueness and ensures every provider's `defaultModelId` exists in `INITIAL_MODELS` at construction time.
  - Exposes `getProvider`, `getProviders`, `getModels`, `getModel`, `getDefaultModel`, `supportsCapability`, `supportsNativeCapability`, `validateCapabilities`.
- **`ModelCatalog` (`src/main/providers/model-catalog.ts`):**
  - Hardcoded static catalog of 17 models across `openai` (4), `anthropic` (4), `google` (9).
  - Intersects `providerCapabilities` with `CURRENT_APPLICATION_CAPABILITIES` (`streaming: true`, `tools: false`, `imageInput: false`, `structuredOutput: false`) via `computeEffectiveCapabilities()`.
  - **Architectural drift:** `CURRENT_APPLICATION_CAPABILITIES.tools` is still `false` (Phase 3 baseline), even though Phase 8 implemented tool calling via `AiSdkAgentModelStepExecutor` reading `modelDescriptor.providerCapabilities?.tools` directly!
- **`CapabilityValidator` (`src/main/providers/capability-validator.ts`):**
  - `validateModelCapabilities()` checks `model.capabilities` (not `providerCapabilities`) against `RequestedCapabilities`.
  - `validateBotModelCompatibility()` enforces `modelId` existence in static `ProviderRegistry` and prevents pairing a model from Provider A with a connection from Provider B (`CROSS_PROVIDER_MODEL_MISMATCH`).
- **`ProviderManagerService` (`src/main/providers/provider-manager/provider-manager-service.ts`):**
  - Coordinates `CredentialVault`, `ProviderConnectionRepository`, `ProviderRegistry`, and per-provider `ProviderAdapter` instances.
  - Handles startup reconciliation (`initialize()`), `testDraftConnection`, `createConnection`, `testConnection`, `updateConnectionLabel`, `replaceCredential` / `removeConnection` (with per-connection `activeMutationLocks`), `generateText`, `streamText`, and `getAvailableModels`.
  - **Critical split in execution paths:** Chat turns flow through `ConversationTurnService` → `ConversationExecutionService` → `ProviderManagerService.streamText()`, whereas Agent turns flow through `AgentTaskService` → `BoundedAgentRuntime` → `AiSdkAgentModelStepExecutor` (`src/main/agents/ai-sdk-agent-model-step-executor.ts`), which **bypasses `ProviderManagerService`** and maintains its own private `OpenAIAdapter`, `AnthropicAdapter`, `GoogleAdapter` instances and hardcoded `switch (providerId)`!

### 3.3 Existing Adapters Comparison Matrix

**[Verified Fact]** Direct comparison from `google-adapter.ts`, `openai-adapter.ts`, `anthropic-adapter.ts`, and their `errors.ts` / `types.ts`:

| Dimension | `GoogleAdapter` | `OpenAIAdapter` | `AnthropicAdapter` |
|---|---|---|---|
| **SDK Package** | `@ai-sdk/google@4.0.112` (`createGoogleGenerativeAI`) | `@ai-sdk/openai@4.0.110` (`createOpenAI`) | `@ai-sdk/anthropic@4.0.98` (`createAnthropic`) |
| **Fixed Base URL** | `https://generativelanguage.googleapis.com/v1beta` | `https://api.openai.com/v1` | `https://api.anthropic.com/v1` |
| **Inference Endpoint** | `:generateContent` / `:streamGenerateContent?alt=sse` | `openai.responses(modelId)` (`/v1/responses`) | `anthropic.messages(modelId)` (`/v1/messages`) |
| **Auth Header** | `x-goog-api-key: <key>` (zero query-param keys) | `Authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| **Model Validation** | Static `providerRegistry.getModel('google', id)` + `resolveVendorModelId()` alias map | Static `providerRegistry.getModel('openai', id)` (no alias map) | Static `providerRegistry.getModel('anthropic', id)` (no alias map) |
| **System Instruction** | Extracted from `options.systemPrompt` + `role === 'system'` msgs, joined with `\n\n`, passed as `system` | Same | Same |
| **Message Normalization** | Skips blank text, merges consecutive same-role text msgs (`\n\n`), maps `toolCalls` & `tool` role | Same (via unstaged pre-existing diff) | Same (via unstaged pre-existing diff) |
| **Tool Mapping** | `mapToolsToAiSdk` (zero `execute` callbacks); no parallel-disable providerOption | `mapToolsToAiSdk`; `providerOptions.openai: { store: false, parallelToolCalls: false }` | `mapToolsToAiSdk`; `providerOptions.anthropic: { disableParallelToolUse: true }` |
| **Generation (`generateText`)** | AI SDK `generateText`, `maxOutputTokens: options.maxTokens`, 120s timeout | Same + `openai: { store: false, parallelToolCalls: false }` | Same + `anthropic: { disableParallelToolUse: true }` |
| **Streaming (`streamText`)** | Consumes `result.fullStream`; handles `text-delta`, `tool-call`, `finish` (checks empty `content-filter` & `error` finishReason), `error`, `abort` | Consumes `result.fullStream`; handles `text-delta`, `tool-call`, `finish`, `error`, `abort` (no empty `content-filter`/`error` finishReason check) | Same as `OpenAIAdapter` |
| **Token Usage** | `inputTokens ?? 0`, `outputTokens ?? 0`, `totalTokens ?? 0` | Same | Same (note AI SDK defaults `max_tokens: 128000` if `maxTokens` omitted) |
| **Finish Reasons** | `stop`, `length`, `content-filter`→`content_filter`, `tool-calls`→`tool_calls`, else `other` | Same | Same |
| **Error Classification** | `sanitizeGoogleError` (unwraps `RetryError`/Fetch `cause`, timeout before abort, RPC keywords, HTTP codes, AI SDK errors, logs `UNKNOWN_ERROR` to `defaultErrorRingBuffer`) | `sanitizeOpenAIError` (same pattern + OpenAI quota/invalid_api_key/context_length keywords) | `sanitizeAnthropicError` (same pattern + `credit_balance_too_low`, `prompt_too_long`, HTTP `413`/`529`) |
| **Cancellation** | `AbortController` + 120s timeout + external `signal`; catch unwraps `controller.signal.reason` on internal timeout | Same, except `catch` does not unwrap `controller.signal.reason` when `options.abortSignal` wasn't aborted; `testConnection` misses `clearTimeout` on pre-aborted signal | Same as `OpenAIAdapter` except `testConnection` clears timeout on pre-aborted signal |
| **Connection Test** | `GET /models/{id}` (15s timeout, 404 alias fallback, checks `name` & `supportedGenerationMethods.includes('generateContent')`) | `GET /models/{id}` (15s timeout, checks `typeof data.id === 'string'`) | `GET /models/{id}` (15s timeout, checks `typeof data.id === 'string'`) |
| **Model Discovery** | `GET /models` (10s timeout), filters `generateContent`, excludes embedding/tts/transcribe/computer-use/deprecated; returns `[]` on error | `GET /models` (10s timeout), filters prefixes `gpt-`, `o1-`, `o3-`, `chatgpt-`; returns `[]` on error | `GET /models` (10s timeout); falls back to hardcoded `['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']` on error |

---

## 4. Installed SDK and Dependency Versions

**[Verified Fact]** Verified directly from `package.json`, `node_modules/*/package.json`, and runtime CLI (`node -v`, `npm -v`, `npx electron --version`):

| Package / Runtime | `package.json` Spec | Installed Version | Module Format | Node Engine | Peer Dependencies |
|---|---|---|---|---|---|
| **Node.js (CLI)** | — | `v24.21.0` | ESM + CJS | — | — |
| **Electron** | `^44.7.2` | `44.10.2` (Electron Node `v24.22.2` observed via `npx electron --version`? Note `v24.22.2` reported) | CJS/ESM | `>= 22.12.0` | — |
| **TypeScript** | `^5.9.3` | `5.9.3` | — | `>=14.17` | — |
| **`ai`** | `7.0.164` | `7.0.164` | `"type": "module"` | `>=22` | `zod: "^3.25.76 \|\| ^4.1.8"` |
| **`@ai-sdk/provider`** | (dep of `ai`) | `4.0.36` | `"type": "module"` | `>=22` | — |
| **`@ai-sdk/provider-utils`** | (dep of `ai`) | `5.0.75` | `"type": "module"` | `>=22` | `zod: "^3.25.76 \|\| ^4.1.8"` |
| **`@ai-sdk/openai`** | `4.0.110` | `4.0.110` | `"type": "module"` | `>=22` | `zod: "^3.25.76 \|\| ^4.1.8"` |
| **`@ai-sdk/google`** | `4.0.112` | `4.0.112` | `"type": "module"` | `>=22` | `zod: "^3.25.76 \|\| ^4.1.8"` |
| **`@ai-sdk/anthropic`** | `4.0.98` | `4.0.98` | `"type": "module"` | `>=22` | `zod: "^3.25.76 \|\| ^4.1.8"` |
| **`zod`** | `^4.6.7` | `4.6.7` | `"type": "module"` | — | — |
| **React / React DOM** | `^19.3.0` | `19.3.0` | — | — | — |
| **React AI packages** | None installed | None (`@ai-sdk/react` not used) | — | — | — |

---

## 5. Compatible Package Versions for Groq, OpenRouter, and Perplexity

**[Verified Fact]** Queried live npm registry metadata via `npm view` on November 27, 2026:

| Provider | Package | Latest Compatible Version | AI SDK / Provider Compatibility | Peer Dependencies | Direct Dependencies | Node.js / Module Format | Installable Without Upgrading `ai@7.0.164`? |
|---|---|---|---|---|---|---|---|
| **Groq** | `@ai-sdk/groq` | `4.0.88` | AI SDK v7 (`@ai-sdk/provider@4.x` / `LanguageModelV4` line, matches installed `4.0.x` adapters) | `zod: "^3.25.76 \|\| ^4.1.8"` | `@ai-sdk/provider: "4.0.39"`, `@ai-sdk/provider-utils: "5.0.85"` | `node >= 22`, `"type": "module"` (ESM) | **Yes** (`zod@4.6.7`, `Node 24`, `ai@7.0.164` satisfy all ranges cleanly) |
| **OpenRouter** | `@openrouter/ai-sdk-provider` | `3.1.0` *(avoid `6.0.0-alpha.*` pre-release; `2.x` targets older AI SDK)* | Explicit `peerDependencies: { ai: "^7.0.0" }` (`@ai-sdk/provider` V4 interfaces) | `ai: "^7.0.0"`, `zod: "^3.25.76 \|\| ^4.1.8"` | None (`undefined` runtime deps; uses `ai` peer) | `node >= 22`, `"type": "module"` (ESM) | **Yes** (`ai@7.0.164` and `zod@4.6.7` match peer ranges cleanly) |
| **Perplexity** | `@ai-sdk/perplexity` | `5.0.39` *(targets Perplexity Agent API; do not use `4.x` legacy Sonar)* | AI SDK v7 (`@ai-sdk/provider@4.x` line) | `zod: "^3.25.76 \|\| ^4.1.8"` | `@ai-sdk/provider: "4.0.39"`, `@ai-sdk/provider-utils: "5.0.85"` | `node >= 22`, `"type": "module"` (ESM) | **Yes** (`zod@4.6.7`, `Node 24`, `ai@7.0.164` satisfy all ranges cleanly) |

**[Verified Fact]** All three packages ship ESM (`"type": "module"`), matching the already-working `@ai-sdk/openai@4.0.110`, `@ai-sdk/google@4.0.112`, `@ai-sdk/anthropic@4.0.98`, and `ai@7.0.164` in the Electron-Vite Main bundle (`electron-vite` bundles Main dependencies cleanly). No `--legacy-peer-deps` or major AI SDK upgrade is required.

---

## 6. Official Documentation Sources & Audit Date

**Audit Date:** November 27, 2026

**[Verified Fact]** Official vendor & SDK documentation consulted:
1. **Groq:**
   - Groq Docs & OpenAI Compatibility: `https://console.groq.com/docs`, `https://console.groq.com/docs/openai`
   - Groq Models API (`GET /openai/v1/models`): `https://console.groq.com/docs/models`
   - Groq Tool Use & Reasoning Formats (`reasoning_format`): `https://console.groq.com/docs/tool-use/overview`
   - Vercel AI SDK Groq Provider: `https://ai-sdk.dev/providers/ai-sdk-providers/groq`
2. **OpenRouter:**
   - OpenRouter Docs & Request Routing: `https://openrouter.ai/docs`
   - OpenRouter Models API (`GET /api/v1/models`): `https://openrouter.ai/docs/api/api-reference/models/get-models`
   - OpenRouter AI SDK Provider Repo (v3 for AI SDK v7): `https://github.com/OpenRouterTeam/ai-sdk-provider`
   - Vercel AI SDK OpenRouter Docs: `https://ai-sdk.dev/providers/community-providers/openrouter`
3. **Perplexity:**
   - Perplexity Platform & Agent API Docs (`/v1/agent`, `/v1/responses`, `/v1/models`): `https://www.perplexity.ai/api-platform`, `https://docs.perplexity.ai/`
   - `@ai-sdk/perplexity` (5.0.x Agent API): `https://www.npmjs.com/package/@ai-sdk/perplexity`, `https://ai-sdk.dev/providers/ai-sdk-providers/perplexity`

---

## 7. Provider Capability Comparison & Proposed Capability Model

### 7.1 Current vs. Target Capability Matrix

**[Verified Fact]** Based on official documentation and current codebase inspection:

| Capability / Metadata | OpenAI (Current) | Anthropic (Current) | Google (Current) | Groq (Target 13.2) | OpenRouter (Target 13.3) | Perplexity (Target 13.4) |
|---|---|---|---|---|---|---|
| **Base Endpoint** | `https://api.openai.com/v1` | `https://api.anthropic.com/v1` | `https://generativelanguage.googleapis.com/v1beta` | `https://api.groq.com/openai/v1` | `https://openrouter.ai/api/v1` | `https://api.perplexity.ai` (`/v1/agent` / `/v1/responses`) |
| **Auth Header** | `Authorization: Bearer` | `x-api-key` | `x-goog-api-key` | `Authorization: Bearer` | `Authorization: Bearer` | `Authorization: Bearer` |
| **Streaming** | Model-dependent (most `true`) | Model-dependent (most `true`) | Model-dependent (most `true`) | Yes (SSE) | Model-dependent (most `true`) | Yes (SSE via Agent API) |
| **Tool Calling** | Model-dependent | Model-dependent | Model-dependent | **Model-dependent** (Llama 3.3/4, Qwen, GPT-OSS support; some preview/guard/whisper models do not) | **Model-dependent** (`supported_parameters` includes `'tools'`) | Agent API supports function tools alongside native web search (must isolate native web search from Local Bots tools) |
| **Image Input** | Model-dependent | Model-dependent | Model-dependent | Model-dependent (vision models only; most text-only) | **Model-dependent** (`architecture.input_modalities` includes `'image'`) | Model-dependent via Agent API |
| **Structured Output** | Model-dependent | Model-dependent | Model-dependent | Model-dependent (`json_schema` / `json_object`; incompatible with `reasoning_format: 'raw'`) | **Model-dependent** (`supported_parameters` includes `'structured_outputs'` / `'response_format'`) | Supported in `@ai-sdk/perplexity` v5 Agent API |
| **Reasoning Mode** | Reasoning models (`o3-*`, etc.) | Extended thinking | Thinking models | Reasoning models (`qwen-qwq-32b`, `deepseek-r1-*`, `gpt-oss-*`; `reasoning_format`: `'parsed'`/`'hidden'`/`'raw'`) | `supported_parameters` includes `'reasoning'` / `'include_reasoning'` | Agent API effort presets (`fast`, `low`, `medium`, `high`, `xhigh`) |
| **Context Window** | Static catalog (`128k–256k`) | Static catalog (`1M`) | Static catalog (`1M–2M`) | Dynamic via `context_window` & `max_completion_tokens` in `/models` | Dynamic via `context_length` & `top_provider.max_completion_tokens` | Varies by preset / underlying model |
| **Pricing Metadata** | Static docs | Static docs | Static docs | Static docs | **Dynamic per-token strings** (`pricing.prompt`, `pricing.completion`, etc.) | Tiered by preset / model + search effort |
| **Native Web Citations** | No (standard) | No (standard) | No (unless grounding enabled) | Browser search tool exists on select models (not enabled) | Optional `:online` / web plugin (not enabled by default) | **Always native** in Agent API (`response.reasoning.search_results` / AI SDK `sources`) |

### 7.2 Proposed Provider-Neutral Capability Model (Recommendation)
**[Recommendation]** Expand `ModelCapabilities` / `ModelDescriptor` (`src/shared/providers.ts` & `src/main/providers/types.ts`) without breaking existing callers:

1. **Keep `ModelCapabilityDto` boolean flags backward-compatible**, adding `reasoning: boolean` and optional `webSearch?: boolean` (never defaulting unknown capabilities to `true` — unknown models must conservatively default `tools: false`, `imageInput: false`, `structuredOutput: false`, `reasoning: false`).
2. **Add `source: 'static' | 'discovered' | 'custom'` and `isAvailable?: boolean`** to `ModelDescriptor` so runtime-discovered models from Groq, OpenRouter, and Perplexity carry accurate provenance rather than pretending to be static catalog entries.
3. **Require `contextWindow` (`inputTokens`, `outputTokens`) with safe conservative fallback rules** when an upstream API omits `max_completion_tokens` (e.g., OpenRouter sometimes returns `top_provider.max_completion_tokens: null`; fall back to `Math.min(16384, Math.floor(contextLength / 4))` while marking `contextWindowSource: 'estimated'`).
4. **Add optional `pricing` and `supportedParameters` / `routing` metadata** (e.g., `pricing?: { promptPerTokenUsd?: string; completionPerTokenUsd?: string }`, `inputModalities?: readonly string[]`, `outputModalities?: readonly string[]`, `unsupportedParameters?: readonly string[]`) under a provider-neutral descriptor namespace.
5. **Fix `CURRENT_APPLICATION_CAPABILITIES` alignment:** Separate chat capabilities (`tools: false` in Chat mode per Phase 12 Step 12.6) from Agent capabilities (`tools: true` in Agent mode), and let `CapabilityValidator` validate `providerCapabilities.tools` for Agent mode and `providerCapabilities.streaming` for Chat mode rather than conflating them in `CURRENT_APPLICATION_CAPABILITIES.tools`.

---

## 8. Model Discovery Design

### 8.1 Current Defect Blocking Dynamic Models
**[Verified Fact]** Today, `ProviderManagerService.getAvailableModels()` (`provider-manager-service.ts:708-780`) calls `adapter.discoverAvailableModels()`, synthesizes `ModelDescriptor` objects with `tools: true`, `structuredOutput: true`, and **no `contextWindow`**, and returns them to the UI. However:
- `ConversationService.resolveProviderAndModel()` (`conversation-service.ts:496-529`) calls `validateBotModelCompatibility()`, which **rejects any model not in static `ProviderRegistry` (`INITIAL_MODELS`)**.
- `ConversationService.resolveContextWindowLimits()` (`conversation-service.ts:534-554`) throws `MODEL_CONTEXT_METADATA_UNAVAILABLE` if `contextWindow` is missing.
- `ProviderManagerService.generateText/streamText`, `OpenAIAdapter`, `AnthropicAdapter`, `GoogleAdapter`, and `AiSdkAgentModelStepExecutor` all reject any `modelId` not in static `ProviderRegistry`.

### 8.2 Unified Dynamic + Curated Model Discovery Design (Recommendation)
1. **Two-Tier Model Resolution:**
   - **Curated baseline (`INITIAL_MODELS`)** stays in `ProviderRegistry` for offline fallback, default model selection, and exact static metadata overrides.
   - **Dynamic Discovery Cache (`DiscoveredModelCache`)** keyed by `connectionId` (and optionally shared read-only catalog cache for public endpoints like OpenRouter `/api/v1/models`) stores rich `ModelDescriptor` records (not bare `string[]` IDs!) with TTL (e.g., 10–15 minutes) and **in-flight promise coalescing** so concurrent `BotConfigurationForm` mounts or connection switches never trigger duplicate HTTP calls.
2. **Provider-Specific Discovery Rules:**
   - **Groq:** Query `GET https://api.groq.com/openai/v1/models` with `Authorization: Bearer <key>`. Filter `active !== false` and exclude audio/whisper/TTS/guard-only models unless supported; capture `context_window` and `max_completion_tokens` directly from each item. Merge with a curated Groq capability table (for `tools`, `imageInput`, `reasoning`) so unknown newly-released Groq models default safely (`streaming: true`, `tools: false` unless known/verified).
   - **OpenRouter:** Query `GET https://openrouter.ai/api/v1/models` (supports `output_modalities=text` query filter to exclude pure image/embedding/audio-only models and shrink payload). Parse `id`, `name`, `description`, `context_length`, `top_provider.context_length`, `top_provider.max_completion_tokens`, `architecture.input_modalities`, `architecture.output_modalities`, `supported_parameters`, and `pricing`. Derive `tools = supported_parameters.includes('tools')`, `structuredOutput = supported_parameters.includes('structured_outputs') || supported_parameters.includes('response_format')`, `imageInput = architecture.input_modalities.includes('image')`, `reasoning = supported_parameters.includes('reasoning') || supported_parameters.includes('include_reasoning')`. Cache parsed catalog with a 15-minute TTL and support search/filter in UI rather than rendering hundreds of unsearchable `<option>` DOM nodes!
   - **Perplexity:** Query `GET https://api.perplexity.ai/v1/models` (`Authorization: Bearer <key>`) for supported Agent API model slugs, **combined with** curated Agent API presets (`fast`, `low`, `medium`, `high`, `xhigh` — with `fast` or `low` as default) since Perplexity's Agent API uses effort presets as primary model selectors alongside explicit model slugs (e.g., `perplexity/sonar`).
3. **Validation Update for Dynamic Models:**
   - Update `validateBotModelCompatibility()` and adapter validation in Steps 13.2–13.4 so a `modelId` is accepted if it exists in `ProviderRegistry` **OR** in the connection's validated `DiscoveredModelCache` (preserving `CROSS_PROVIDER_MODEL_MISMATCH` checks against other providers!).

---

## 9. Provider-Specific API Compatibility Risks

**[Verified Fact / Estimate]**

| Provider | Compatibility Risk | Details & Mitigation |
|---|---|---|
| **Groq** | Unsupported OpenAI params | Groq rejects `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, and `n !== 1` with HTTP 400; `temperature === 0` is silently clamped to `1e-8` by Groq. **Mitigation:** Never forward `messages[].name` (not even for `tool` messages if unnecessary — `@ai-sdk/groq` handles Groq formatting natively) and avoid unsupported OpenAI parameters. |
| **Groq** | `reasoning_format: 'raw'` conflict | Setting `reasoning_format: 'raw'` concurrently with `tools` or JSON schema causes HTTP 400. **Mitigation:** Always default `reasoningFormat` to `'parsed'` (or `'hidden'`) when tools or structured outputs are active. |
| **Groq** | Context window constraints | Many Groq models have `8,192` to `131,072` context windows; `ConversationContextManager` currently blocks ~1s on 8k trimming with 80 turns (see Section 10). |
| **OpenRouter** | Dynamic catalog size & rate/bandwidth | `GET /api/v1/models` returns hundreds of models (~500+ KB JSON). Calling it on every `BotConfigurationForm` render or `ProviderConnection` change wastes bandwidth and UI render time. **Mitigation:** Filter `output_modalities=text`, cache in Main with TTL + in-flight deduplication, and add searchable model picker UI in Step 13.3/13.5. |
| **OpenRouter** | Model IDs contain `/` & `:` | OpenRouter slugs look like `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.3-70b-instruct:free` (can approach or exceed 60–100 chars). **Check:** `MODEL_ID_SCHEMA` in `provider-validation.ts` and `bot-repository` caps `modelId` at `100` chars (`z.string().max(100)`). Some OpenRouter model IDs with variants (`:extended`, `:free`) could be long — consider bumping limit to `200` chars in Step 13.3. |
| **OpenRouter** | Provider-routing & non-uniform errors | Upstream providers behind OpenRouter can return mid-stream errors or omit `usage` unless accounting is enabled. `@openrouter/ai-sdk-provider@3.1.0` supports AI SDK v7 `inputTokenDetails`/`outputTokenDetails`; verify `totalUsage` fallback to `0` and classify upstream 502/503/429 cleanly. |
| **Perplexity** | Retired legacy Sonar vs. Agent API | Legacy Sonar `/chat/completions` reached end-of-support in late 2026; `@ai-sdk/perplexity@5.0.39` targets the Agent API (`/v1/agent` / `/v1/responses`). Do **not** downgrade to `@ai-sdk/perplexity@4.x` or `/chat/completions`. |
| **Perplexity** | Connection test without token burn | `GET https://api.perplexity.ai/v1/models` with `Authorization: Bearer <key>` validates auth with **zero generation tokens**. Verify exact status codes (401/403 vs 200) during Step 13.4; if a key lacks `/v1/models` scope, document explicit fallback. |
| **Perplexity** | Citation collision (`[1]`, `[2]`) | Perplexity Agent API emits inline `[1]`, `[2]` markers in `response.output_text.delta` referencing web `search_results` URLs, while Local Bots RAG uses `[1]`, `[2]` markers referencing local `knowledge_chunks`! **Critical risk:** `parseAndLinkCitations()` (`conversation-persistence-service.ts:62`) and `GroundingValidator` (`grounding-validator.ts`) would misinterpret Perplexity's web `[1]` as KB citation `[1]` or fail `strict_kb_only` validation if not separated! See Section 14.3 for required isolation design. |

---

## 10. Performance Baseline Methodology & Measurements

### 10.1 Required Performance Metric Definitions
1. **TTFT (Provider Time to First Token):** Elapsed time from provider HTTPS request dispatch (`adapter.streamText` call start) to the first non-empty `text-delta` received from the provider SDK.
2. **Provider Duration:** Elapsed time from provider HTTPS request dispatch to provider stream `finish` event (or terminal error/abort).
3. **End-to-End Duration:** Elapsed time from accepted user submission (`ConversationTurnService.sendMessage` / IPC `conversation:send-message`) to persisted final assistant message and emitted `finish` event.
4. **Tokens per Second (TPS):** `completionTokens / (generationDurationMs / 1000)`, computed strictly using provider-reported `completionTokens` (or `outputTokens`) over generation duration (`Provider Duration - TTFT`, or total `Provider Duration` when TTFT is unavailable — always state denominator explicitly).
5. **Finalization Duration:** Elapsed time from final provider `text-delta` / provider `finish` event to `persistAssistantMessage` completion and `PublicFinishEvent` emission (encompasses `GroundingValidator.validateResponse`, citation parsing, and SQLite `INSERT`).
6. **Time to Visible Token (TTVT):** Elapsed time from accepted user submission in Renderer (`useConversationTurn.sendMessage`) to the first rendered text delta state commit in the Renderer UI (includes IPC invoke, `prepareTurn`, `persistUserMessage`, provider TTFT, MessagePort post, and React commit).

### 10.2 Existing Timing Instrumentation Audit
**[Verified Fact]** Inspected `ConversationExecutionService`, `ConversationTurnService`, `ConversationStreamManager`, `ConversationPersistenceService`, and `shared/conversations.ts`:
- `GenerationMetadataDto` (`src/shared/conversations.ts:274-279`) defines `durationMs?: number` and `firstTokenMs?: number`.
- **Gap:** `ConversationExecutionService` (`conversation-execution-service.ts:244, 322`) records total `durationMs` (`Date.now() - startTime`), **but `firstTokenMs` is never populated anywhere in Main process code** (only referenced in `src/shared/conversations.test.ts:327`).
- `ConversationExecutionService` uses `Date.now()` (1ms resolution, subject to wall-clock drift) rather than monotonic `performance.now()`.
- `ConnectionTestResult` (`google-adapter.ts`, `openai-adapter.ts`, `anthropic-adapter.ts`) already uses `performance.now()` for `latencyMs`.
- No separate breakdown exists today for `prepareTurnMs`, `retrievalMs`, `providerTtftMs`, `finalizationMs`, or `tokensPerSecond`.

### 10.3 Deterministic Local Pipeline Overhead Measurements (Zero Network)
**[Measured]** Executed via a deterministic scratch Vitest benchmark (`perf-baseline.test.ts` outside repo, in-memory SQLite + migrations `001`–`013` + 5 Markdown documents / 50 FTS5 chunks + 10 historical turns [20 messages] + zero-delay synthetic `ProviderAdapter` streaming 40 chunks / ~1,500 chars; `N = 20` iterations after setup, `N = 10` for context trimming):

| Pipeline Stage | Mean (ms) | Median p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Notes / Bottleneck |
|---|---|---|---|---|---|---|
| **Request Validation** (`sendMessageRequestSchema.safeParse`) | `0.057` | `0.026` | `0.631` | `0.014` | `0.631` | Negligible |
| **KB Retrieval (FTS5)** (`BotRagService.retrieve`, 50 chunks) | `3.875` | `2.879` | `26.145` | `1.655` | `26.145` | Synchronous `better-sqlite3` FTS5 + `citationDtoSchema.parse` per chunk |
| **Turn Preparation** (`ConversationService.prepareTurn`, 10 turns, no trimming) | `5.728` | `5.198` | `14.191` | `3.767` | `14.191` | Includes history query, RAG retrieval, memory lookup, prompt build |
| **Local TTFT Overhead** (send start → first `text_delta`, zero-net fake adapter) | `6.792` | `6.297` | `12.585` | `4.873` | `12.585` | Dominated by `prepareTurn` + `persistUserMessage` (`INSERT`) |
| **Grounding Validation** (`GroundingValidator.validateResponse`, ~1.5 KB cited text, lexical) | `2.423` | `2.050` | `11.776` | `1.066` | `11.776` | Fast in lexical mode; optional `claimVerifier` LLM call would add full round-trip |
| **Finalization Duration** (last `text_delta` → persisted assistant message + `getResult`) | `4.910` | `4.219` | `12.553` | `2.423` | `12.553` | `GroundingValidator` + `parseAndLinkCitations` + `messageRepo.create` |
| **Local E2E Overhead** (`ConversationTurnService.sendMessage`, zero-net fake adapter) | `11.860` | `10.800` | `25.471` | `7.921` | `25.471` | Total Main-process overhead excluding network & UI |
| **Context Trimming (80 turns / 160 msgs, 8k window)** (`ConversationContextManager.selectContext`) | **`925.663`** | **`997.214`** | **`1031.411`** | **`749.845`** | **`1052.865`** | **SEVERE BOTTLENECK:** Re-invokes `RagPromptBuilder.build()` on every dropped turn (`O(T²)`!) |

### 10.4 Optional Manual Real-API Benchmarking Procedure
When measuring real provider latency with user-supplied BYOK keys (never in automated tests):
1. Configure valid connections in Settings for each target provider (`openai`, `anthropic`, `google`, and post-13.2/13.3/13.4 `groq`, `openrouter`, `perplexity`).
2. Use a standardized prompt (e.g., 150-token input, `temperature: 0.2`, `maxOutputTokens: 512`, `general_ai_chat` policy with empty KB so RAG does not vary).
3. Record monotonic timestamps (`performance.now()`) at: request start, first `text_delta`, last `text_delta`, `finish` (with `usage.completionTokens`), and post-persistence completion.
4. Run 5 warm trials per model (discarding trial 1 TLS/DNS cold-start separately) and report p50/p95 TTFT, Provider Duration, Tokens/sec, and Finalization Duration.
5. Never log prompts, retrieved text, raw API keys, or response bodies.

### 10.5 Measurement Limitations
- **Synthetic zero-network provider:** Local benchmark isolates Main-process CPU/SQLite overhead and does not include TLS handshake, DNS, provider queue time, or real token generation latency.
- **In-memory SQLite (`:memory:`):** Disk-backed WAL SQLite (`app.sqlite`) adds OS filesystem fsync/write latency (~0.5–3 ms per transaction depending on SSD/antivirus).
- **Renderer not in Electron GPU process:** UI Markdown/React re-render cost during streaming was identified via source-code complexity audit rather than live Chromium frame-timing profiling.

---

## 11. Streaming and UI Bottlenecks

**[Verified Fact]** Audited `ConversationStreamManager`, `AgentStreamManager`, `ProviderStreamManager`, `preload/index.ts`, `useConversationTurn.ts`, `useAgentTaskEvents.ts`, `BotConversationsWorkspacePage.tsx`, `ConversationMessageList.tsx`, `ConversationMessage.tsx`, `MarkdownMessageContent.tsx`, and `CodeBlock.tsx`:

| Priority | Bottleneck | Location | Mechanism & Impact |
|---|---|---|---|
| **P0** | **`ConversationContextManager.selectContext` $O(T^2)$ rebuild loop** | `src/main/services/conversation-context-manager.ts:222-263` | **[Measured ~997 ms at 80 turns / 8k window]** Re-runs `RagPromptBuilder.build()` (including system prompt construction, `<retrieved_context>` JSON stringify + XML escaping, and full-history `estimateTokenCount`) from scratch for every single dropped historical turn. Blocks the synchronous Main-process event loop for ~1 second before the provider request even starts! |
| **P0** | **Full Markdown re-parse & Prism tokenization on every token delta** | `ConversationMessageList.tsx:269-274`, `MarkdownMessageContent.tsx:96-130`, `CodeBlock.tsx:73-85` | `useConversationTurn` updates `streamingText` via `prev + event.textDelta` on every delta. `MarkdownMessageContent` runs `<ReactMarkdown>` + `remarkGfm` over the **entire** `0..N` string on every delta, and `CodeBlock` runs `Prism.tokenize()` + recursive React `<span>` creation on every delta ($O(N^2)$ UI work on long code responses). |
| **P1** | **Unmemoized `ConversationMessage` list re-renders on every delta** | `BotConversationsWorkspacePage.tsx:138`, `ConversationMessageList.tsx:203-211`, `ConversationMessage.tsx:180` | `streamingText` state lives in `useConversationTurn` inside `BotConversationsWorkspacePage`. Every token delta re-renders the entire page and maps over ALL historical `messages`, re-rendering every `ConversationMessage` and `MarkdownMessageContent` because neither component is wrapped in `React.memo`. |
| **P1** | **Unbatched per-token IPC `MessagePort.postMessage` & React `setState`** | `ConversationStreamManager.ts:425-436`, `useConversationTurn.ts:268-269` | Fast streaming providers (notably **Groq** at 300–1,000+ tok/s) emit tiny 1-token deltas every ~1–3 ms. Each delta triggers a structured-clone `postMessage`, a Renderer `onmessage` callback, and two React state calls (`setStage('streaming')` + `setStreamingText`). |
| **P1** | **Competing `scrollIntoView({ behavior: 'smooth' })` per delta** | `ConversationMessageList.tsx:72-78` | Fires `bottomRef.current.scrollIntoView({ behavior: 'smooth' })` on every `streamingText` update, causing continuous smooth-scroll animation restarts and layout thrashing. |
| **P2** | **Agent mode uses non-streaming `generateText` only** | `AiSdkAgentModelStepExecutor.ts:205` | Agent reasoning/final synthesis waits for the entire provider HTTP response before showing any text, yielding high perceived latency on long Agent responses. |
| **P2** | **Post-turn full conversation reload over IPC** | `BotConversationsWorkspacePage.tsx:146-151` | `onFinish` and `onError` call `refreshConversation()`, re-querying all segments and all messages from SQLite over IPC instead of optimistically/deterministically appending `result.userMessage` & `result.assistantMessage`. |
| **P2** | **Duplicate / uncoalesced `getAvailableModels` IPC calls** | `BotConfigurationForm.tsx:183-223`, `ProviderManagerService.ts:708-780` | No in-flight request deduplication or TTL on `connectionModelCache`; `BotConfigurationForm` also retains a pre-existing `exhaustive-deps` lint warning at line 223. |

---

## 12. Existing Provider Consistency Findings

**[Verified Fact]** Inconsistencies observed across `GoogleAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, and `ProviderManagerService`:

1. **Timeout leak in `OpenAIAdapter.testConnection` (`openai-adapter.ts:101-112`):** Missing `clearTimeout(timeoutId)` before early return when `controller.signal.aborted` is true (present in `GoogleAdapter:105` and `AnthropicAdapter:105`).
2. **Catch-block timeout unwrapping (`openai-adapter.ts:426`, `anthropic-adapter.ts:429` vs. `google-adapter.ts:510-518`):** `GoogleAdapter` unwraps `controller.signal.reason` when the internal generation timeout fires while `options.abortSignal` is not aborted; `OpenAIAdapter` and `AnthropicAdapter` pass raw `err` to `sanitize*Error`, risking `OPERATION_ABORTED` instead of `TIMEOUT` if the SDK throws a generic `AbortError`.
3. **Empty `content-filter` / `error` finishReason handling (`google-adapter.ts:438-460` vs. `openai`/`anthropic`):** Only `GoogleAdapter` converts `finishReason === 'content-filter'` or `'error'` with zero yielded text into a typed `error` stream chunk.
4. **Duplicated adapter boilerplate:** `convertMessages`, `extractText`, `mapFinishReason`, `assertSupportedCapabilities`, timeout/abort controller wiring, and `collectErrorMetadata` are copy-pasted across all 3 adapter directories (`google/`, `openai/`, `anthropic/`) with subtle drift.
5. **Model discovery inconsistency:** `OpenAIAdapter` filters strictly by `['gpt-', 'o1-', 'o3-', 'chatgpt-']` (missing `o4-` or future prefixes); `AnthropicAdapter` returns fake fallback IDs (`claude-sonnet-5-5`, etc.) when `/v1/models` fails, whereas `GoogleAdapter` and `OpenAIAdapter` return `[]`.
6. **Provider ID & schema divergence:**
   - `src/shared/providers.ts`: `SUPPORTED_PROVIDERS` has 5 IDs (`openai`, `anthropic`, `google`, `xai`, `openrouter`), `FIRST_WAVE_PROVIDERS` has 3.
   - `src/main/providers/types.ts`: `SUPPORTED_PROVIDER_IDS` has 3.
   - `src/main/ipc/provider-validation.ts`: uses `FIRST_WAVE_PROVIDERS` (3).
   - `src/main/database/migrations/002_provider_credential_refs.sql`: allows 5 (`xai`, `openrouter` included; `groq`, `perplexity` excluded).
7. **Capability gate split:** `ProviderManagerService.assertCapabilities()` (`provider-manager-service.ts:645`) unconditionally rejects `tools`, `jsonSchema`, and `imageInput`, while all three adapters allow `tools` if `model.providerCapabilities?.tools` is true, and `AiSdkAgentModelStepExecutor` bypasses `ProviderManagerService` entirely.
8. **Placeholder/forward-dated model IDs:** `model-catalog.ts` contains IDs like `gpt-6-luna`, `claude-sonnet-5-5`, `gemini-3.8-flash`. Only `GoogleAdapter` has `resolveVendorModelId()` mapping them; `OpenAIAdapter` and `AnthropicAdapter` send them verbatim (relying on `discoverAvailableModels` at runtime, which is then blocked by static `ProviderRegistry` checks!).

### Recommended Common Normalization Contract
**[Recommendation]** Extract a shared internal base/utility module in `src/main/providers/shared/`:
- `normalizeProviderMessages(options)` (system prompt extraction, blank-turn filtering, consecutive same-role merging, tool call/result parts)
- `createLinkedTimeoutController(timeoutMs, externalSignal)` (guaranteed `clearTimeout` + timeout-reason preservation)
- `mapAiSdkFinishReason(rawReason)` & `mapAiSdkUsage(usage)`
- `collectErrorMetadata(err, statusCodeOverride)` + shared network/timeout/abort/AI-SDK error classifiers parameterized by provider display name and vendor-specific rules.

---

## 13. Credential and Privacy Implications

### 13.1 Existing Security Preservation
**[Verified Fact]** All new providers must preserve:
`Renderer (no keys) → IPC (Zod + sender validation) → ProviderManagerService → CredentialVault (safeStorage + <userData>/credentials/*.enc) → Main-process HTTPS request`
- Plaintext keys never enter SQLite, Renderer, Bot DTOs, logs, stream events, or backup exports.
- Linux `basic_text` guard in `CredentialVault` remains strictly enforced.

### 13.2 Key-Redaction & Secret-Scanner Gaps Found (Action Required in 13.2–13.4)
**[Verified Fact]** Inspected `src/main/providers/provider-manager/errors.ts`, `src/main/services/diagnostic-sanitizer.ts`, `src/main/services/secret-scanner.ts`, and `src/renderer/src/hooks/useConversationTurn.ts`:
- **Groq keys (`gsk_...`):** NOT matched by `sanitizeErrorMessage`, `DiagnosticSanitizer`, `SecretScanner`, or `useConversationTurn`.
- **OpenRouter keys (`sk-or-v1-...`):** Matched by `sanitizeErrorMessage` / `useConversationTurn` (`sk-[a-zA-Z0-9_\-+/=]{10,}`), **but MISSED by `DiagnosticSanitizer` and `SecretScanner`** because their legacy regex `\bsk-[a-zA-Z0-9]{32,}\b` does not allow hyphens (`-`)!
- **Perplexity keys (`pplx-...`):** NOT matched by any of the four sanitizers/scanners.
- **Recommendation:** Add explicit patterns for `gsk_[a-zA-Z0-9_-]{20,}`, `sk-or-(?:v1-)?[a-zA-Z0-9_-]{20,}`, and `pplx-[a-zA-Z0-9_-]{20,}` to all four sanitizers/scanners before integrating the new providers.

### 13.3 OpenRouter Optional Attribution Headers & Privacy
**[Recommendation]** OpenRouter supports optional `HTTP-Referer` and `X-Title` / `X-OpenRouter-Title` headers:
- **Never** send `window.location.href`, local filesystem paths (`file://...`), OS usernames, or workspace/KB names in `HTTP-Referer` or `X-Title`.
- Omit `HTTP-Referer` and `X-Title` by default (zero extra metadata leaves the machine), or if an optional app identifier is ever desired, send only a static constant (`'Local Bots'`) with zero machine/user details.
- Document OpenRouter's multi-upstream data routing and ZDR (`provider.data_collection: 'deny'`) implications in `ProviderPrivacyInformation.tsx` (in Step 13.3/13.5).

### 13.4 Database Schema Migration Required
**[Verified Fact]** `provider_connections.provider_id` in `002_provider_credential_refs.sql` enforces:
`CHECK (provider_id IN ('openai', 'anthropic', 'google', 'xai', 'openrouter'))`.
- Integrating `groq` and `perplexity` requires **Migration 014** rebuilding `provider_connections` to include `'groq'` and `'perplexity'` (with `disableForeignKeysForTableRebuild: true` and preserving all existing connections and `bots.provider_connection_id` FKs).

---

## 14. Recommended Adapter Design for Each New Provider

### 14.1 GroqAdapter (Step 13.2)
- **Package:** `@ai-sdk/groq@4.0.88` (`createGroq({ apiKey, baseURL: 'https://api.groq.com/openai/v1', fetch: this.fetchFn })`).
- **Base URL:** Fixed `https://api.groq.com/openai/v1`.
- **Auth:** `Authorization: Bearer <key>`.
- **Connection Test:** `GET https://api.groq.com/openai/v1/models` (or `/models/{modelId}`), zero tokens consumed; verifies HTTP 200 and `active !== false`.
- **Model Discovery:** `GET https://api.groq.com/openai/v1/models`; reads `id`, `active`, `context_window`, `max_completion_tokens`, and merges with curated Groq capability metadata (`tools`, `imageInput`, `reasoning`).
- **Parameters & Quirks:** Default `providerOptions.groq: { reasoningFormat: 'parsed' }` (or omit) when tools/JSON are used so `'raw'` never triggers HTTP 400; do not forward unsupported OpenAI fields (`logprobs`, `logit_bias`, `top_logprobs`, `n > 1`, `messages[].name`).
- **Error Sanitizer:** `sanitizeGroqError` using shared metadata collector + Groq HTTP 400/401/403/404/413/429/498/5xx mappings.

### 14.2 OpenRouterAdapter (Step 13.3)
- **Package:** `@openrouter/ai-sdk-provider@3.1.0` (`createOpenRouter({ apiKey, baseURL: 'https://openrouter.ai/api/v1', fetch: this.fetchFn })`).
- **Base URL:** Fixed `https://openrouter.ai/api/v1` — direct HTTPS from Main process, **zero Vercel AI Gateway or proxy**.
- **Auth:** `Authorization: Bearer <key>` (no machine-identifying `HTTP-Referer`).
- **Connection Test:** Verify key validity against `GET https://openrouter.ai/api/v1/auth/key` (or `/models` + key check — verify `/auth/key` in Step 13.3 since `/models` is partially public, whereas `/auth/key` validates the API key specifically with zero token spend!).
- **Model Discovery & Caching:** `GET https://openrouter.ai/api/v1/models?output_modalities=text` parsed into dynamic `ModelDescriptor` entries with `contextWindow`, `pricing`, `inputModalities`, `supportedParameters`, and `capabilities`. Cached with TTL + in-flight deduplication.
- **Routing & Privacy:** Allow optional provider-neutral routing controls in future if needed, defaulting to direct OpenRouter routing without leaking local metadata.

### 14.3 PerplexityAdapter (Step 13.4)
- **Package:** `@ai-sdk/perplexity@5.0.39` (`createPerplexity({ apiKey, baseURL: 'https://api.perplexity.ai', fetch: this.fetchFn })`) targeting the **Perplexity Agent API** (`/v1/agent` / `/v1/responses`).
- **Base URL:** Fixed `https://api.perplexity.ai`.
- **Auth:** `Authorization: Bearer <key>`.
- **Models & Presets:** Support Agent API presets (`fast`, `low`, `medium`, `high`, `xhigh`) + models discovered from `GET https://api.perplexity.ai/v1/models`.
- **Connection Test:** `GET https://api.perplexity.ai/v1/models` with `Authorization: Bearer <key>` (zero generation tokens).
- **Web Citations Isolation (CRITICAL):**
  - Perplexity Agent API returns web sources (`response.reasoning.search_results` / AI SDK `source` stream parts and `result.sources`) and inserts `[1]`, `[2]` in text.
  - **Contract Extension:** Add an optional distinct `WebSourceDto` / `externalSources` field on `StreamTextChunk` (`{ type: 'source', source: { id, url, title } }`) and `MessageMetadataDto.webSources` (never mixed into `MessageMetadataDto.citations` or `PreparedConversationTurn.citationMap`!).
  - **Grounding & Citation Separation:**
    - In `ConversationPersistenceService.parseAndLinkCitations` and `GroundingValidator`, if a turn uses Perplexity web search and no KB chunk exists at `[n]` (or if citations are explicitly tracked in `webSources`), never mislabel a web URL as a Knowledge Base chunk citation.
    - Under `strict_kb_only` policy, Perplexity web citations must **not** satisfy KB grounding requirements (or `strict_kb_only` must disable/reject web-only grounding so KB isolation invariants remain intact).
    - Perplexity's native server-side web search remains separate from Local Bots' `ToolRegistry` / `BoundedAgentRuntime` local tools (`search_knowledge_base`, `read_workspace_file`, etc.).

---

## 15. Proposed Step 13.2–13.4 Implementation Boundaries

| Step | Scope | Must Include | Must NOT Include |
|---|---|---|---|
| **Pre-13.2 / Step 13.2 (Groq)** | Shared adapter foundation + Migration 014 + Dynamic model validation + Groq integration | Migration `014` (`groq`, `perplexity` in `provider_connections` CHECK); key-redaction updates (`gsk_`, `sk-or-v1-`, `pplx-`); shared adapter helpers (`timeout`, `message normalization`, `error metadata`); allow dynamic discovered models in `CapabilityValidator` / `ConversationService` / `ProviderManagerService`; `GroqAdapter` + unit tests | OpenRouter, Perplexity, UI perf rewrites, automatic fallback |
| **Step 13.3 (OpenRouter)** | `@openrouter/ai-sdk-provider@3.1.0` + dynamic catalog caching & UI filter | `OpenRouterAdapter`; `/api/v1/models` parser (context window, pricing, modalities, `supported_parameters`); TTL + in-flight dedup cache; searchable model selector in `BotConfigurationForm`; privacy notice update | Perplexity, automatic provider fallback, AI Gateway |
| **Step 13.4 (Perplexity)** | `@ai-sdk/perplexity@5.0.39` Agent API + distinct web-source citation pipeline | `PerplexityAdapter` (Agent API presets + `/v1/models` discovery); distinct `webSources` stream/persistence DTOs; `parseAndLinkCitations` / `GroundingValidator` isolation from KB citations; UI rendering of distinct Web Sources vs. KB Citations | Replacing Local Bots local tools with Perplexity native tools; downgrading to legacy Sonar |

---

## 16. Step 13.5 Optimization Priorities

**[Estimate / Recommendation]** Prioritized by measured impact and user-perceived smoothness:

1. **P0 — Fix $O(T^2)$ Context Trimming Loop (`ConversationContextManager`):** Compute per-turn token estimates **once** (`O(T)`) and select the suffix slice in a single pass before invoking `RagPromptBuilder.build()` once. Reduces 80-turn 8k trimming from **~997 ms** to **< 10 ms**.
2. **P0 — Throttle/Decouple Streaming Markdown & Code Highlighting (`MarkdownMessageContent` + `CodeBlock`):** During active streaming (`isGenerating === true`), render at animation-frame / 50–80ms intervals or defer Prism syntax tokenization on the active unclosed code block until stabilized/completed, eliminating $O(N^2)$ Markdown AST + Prism re-parses on every token.
3. **P1 — Isolate & Memoize Message List (`ConversationMessage` + `ConversationMessageList`):** Wrap `ConversationMessage` in `React.memo`, isolate `streamingText` subscription into a dedicated child component (`StreamingAssistantBubble`) so historical messages never re-render on token deltas, and replace per-delta `scrollIntoView({ behavior: 'smooth' })` with throttled `requestAnimationFrame` auto-scroll (`behavior: 'auto'` during active streaming).
4. **P1 — Batch `text_delta` Events Across IPC (`ConversationStreamManager` / `useConversationTurn`):** Coalesce rapid micro-deltas (e.g., 16–32 ms window or buffer flush before terminal events) so ultra-fast providers like Groq do not flood `MessagePort` and React state with 500+ events/sec.
5. **P1 — Populate `firstTokenMs` & Pipeline Timing Telemetry (Local Only):** Record monotonic `performance.now()` timings (`prepareMs`, `ttftMs`, `providerDurationMs`, `finalizationMs`, `tokensPerSec`) in `GenerationMetadataDto` (zero network telemetry, local-only).
6. **P2 — Avoid Post-Turn Full Conversation Reload & Coalesce Model Discovery:** Append returned `userMessage` / `assistantMessage` directly in `BotConversationsWorkspacePage` instead of re-fetching all messages on `onFinish`, and add in-flight deduplication + TTL caching to `ProviderManagerService.getAvailableModels()`.
7. **P2 — Optional Streaming for Agent Final Synthesis:** Evaluate streaming text deltas from `AiSdkAgentModelStepExecutor` in Step 13.5 without weakening single-tool-call bounds or approval gates.

---

## 17. Existing Bugs or Risks Found

**[Verified Fact]** Discovered during Step 13.1 code inspection & benchmarking:

1. **High — Dynamic Discovery Dead-End:** `ProviderManagerService.getAvailableModels()` synthesizes `ModelDescriptor` entries for newly discovered models, but `ProviderManagerService.generateText/streamText`, `ConversationService.resolveProviderAndModel`, `AiSdkAgentModelStepExecutor`, and all 3 adapters reject any model not in static `INITIAL_MODELS`.
2. **High — ~1s Synchronous Main-Process Stall on Long-History Context Trimming:** `ConversationContextManager.selectContext()` took **997.2 ms (median)** on 80 historical turns under an 8k context window due to calling `RagPromptBuilder.build()` inside the trim loop.
3. **Medium — `AiSdkAgentModelStepExecutor` Bypasses `ProviderManagerService`:** Hardcodes `new OpenAIAdapter()`, `new AnthropicAdapter()`, `new GoogleAdapter()` and a 3-way `switch`, duplicating adapter wiring that must be unified or updated for 6 providers.
4. **Medium — Secret Scanner / Sanitizer Blind Spots:** `SecretScanner` and `DiagnosticSanitizer` miss OpenRouter (`sk-or-v1-...`), Groq (`gsk_...`), and Perplexity (`pplx-...`) API key prefixes; `sanitizeErrorMessage` misses `gsk_` and `pplx-`.
5. **Medium — Adapter Consistency Gaps:** `OpenAIAdapter.testConnection` leaks `timeoutId` on pre-aborted `signal`; `OpenAIAdapter` & `AnthropicAdapter` do not unwrap `controller.signal.reason` on internal generation timeout in `catch` and do not check empty `content-filter` / `error` `finishReason` like `GoogleAdapter`.
6. **Low — `firstTokenMs` Unpopulated:** Declared in `GenerationMetadataDto` and `generationMetadataSchema`, never populated by `ConversationExecutionService`.
7. **Low — Pre-Existing Lint Warning:** `BotConfigurationForm.tsx:223` (`react-hooks/exhaustive-deps` on `discoveredModels`).

---

## 18. Files Created or Modified

- **Created:** `docs/phase-13/step-13.1-provider-architecture-audit-report.md` (this report)
- **Modified:** None (0 repository source files modified; pre-existing 8 unstaged files preserved untouched)
- **Scratch (outside repository, in `<appDataDir>/brain/<conversation-id>/scratch/`):** `perf-baseline.test.ts` used solely to run the deterministic zero-network local pipeline benchmark without altering the repository.

---

## 19. Targeted Tests and Results

### 19.1 Targeted Provider, Vault, Agent, Grounding & Streaming Suites
**[Verified Fact / Measured]** Executed after inspection with zero skipped or relaxed assertions:

1. **Provider, Vault, IPC Bridge & Conversation Streaming Suite (`14` files, `377` tests):**
   - Command: `npx vitest run src/main/providers/provider-registry.test.ts src/main/providers/capability-validator.test.ts src/main/providers/provider-manager/provider-manager-service.test.ts src/main/providers/google/google-adapter.test.ts src/main/providers/openai/openai-adapter.test.ts src/main/providers/anthropic/anthropic-adapter.test.ts src/main/providers/end-to-end-integration.test.ts src/main/security/credential-vault/credential-vault.test.ts src/main/ipc/provider-bridge.test.ts src/main/services/conversation-execution-service.test.ts src/main/services/conversation-turn-service.test.ts src/main/services/streaming-lifecycle.test.ts src/renderer/src/hooks/useConversationTurn.test.tsx src/renderer/src/hooks/useAgentTaskEvents.test.tsx`
   - Result: **Exit code `0` — `14/14` files passed, `377/377` tests passed (`8.16s`).**
2. **TypeScript Verification (`npm run typecheck`):**
   - Result: **Exit code `0` — `0` errors across `tsconfig.node.json` and `tsconfig.web.json`.**
3. **Agent Executor, Tool Mapper & Grounding Validator (`3` files, `44` tests):**
   - Command: `npx vitest run src/main/agents/ai-sdk-agent-model-step-executor.test.ts src/main/agents/ai-sdk-tool-mapper.test.ts src/main/services/grounding-validator.test.ts`
   - Result: **Exit code `0` — `3/3` files passed, `44/44` tests passed (`3.35s`).**
4. **Deterministic Local Pipeline Overhead Baseline (Scratch Vitest Run, `1` file, `1` test):**
   - Command: `npx vitest run --dir "<artifactDir>/scratch"`
   - Result: **Exit code `0` — `1/1` passed (`10.92s`).**

*(Note: Full 216-file repository suite and `npm run build` were not re-run in Step 13.1 since no repository source code was modified; those remain verified from Step 12.10 with the caveat of the 8 pre-existing unstaged adapter/error/test diffs.)*

---

## 20. Known Limitations

1. **No Live Network / Real API Key Benchmarks Executed:** Automated baseline checks used a deterministic zero-latency fake adapter and in-memory SQLite; real TTFT, Tokens/sec, and network variance for OpenAI, Anthropic, Google, Groq, OpenRouter, and Perplexity require manual testing with user BYOK keys.
2. **No Live Electron Window Frame Profiling:** Renderer streaming bottlenecks were identified by static code inspection of React hooks/components rather than live DevTools Performance flamegraphs.
3. **Pre-Existing Uncommitted Changes:** The 8 unstaged provider adapter/test/error files present at Step 13.1 start remain uncommitted in the working tree as required.
4. **Perplexity & OpenRouter Endpoint Edge Cases:** Exact live response payloads for Perplexity `GET /v1/models` and OpenRouter `/auth/key` will be contract-verified with mocked/live schemas in Steps 13.3 and 13.4.

---

## Step 13.1 Stop Gate

Step 13.1 is complete. **Awaiting explicit user authorization before beginning Step 13.2 (Groq integration).**
