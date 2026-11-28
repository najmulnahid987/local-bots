# Phase 13 — Step 13.3: OpenRouter Provider Integration Implementation Report

**Project:** Local-First Multi-Model AI Agent Workspace (`local-first-ai-workspace`)  
**Phase:** 13 — Multi-Provider Expansion & Response Performance  
**Step:** 13.3 — OpenRouter Provider Integration  
**Status:** Complete & Verified at Step 13.3 Gate  
**Date:** 2026-11-28

---

## 1. Objective and Implementation Summary

OpenRouter (`openrouter`) has been integrated as a full BYOK provider in Local Bots alongside OpenAI, Anthropic, Google Gemini, and Groq via the unified Main-process architecture:

`React Renderer → Preload → Main IPC → ProviderManagerService → OpenRouterAdapter → Direct HTTPS (https://openrouter.ai/api/v1) → OpenRouter API`

Key outcomes:
- Connects directly from Electron Main to `https://openrouter.ai/api/v1` with zero proxies, zero Vercel AI Gateway, and zero cloud backends.
- Preserves BYOK encryption at rest (`CredentialVault` + OS `safeStorage`), opaque database references, zero key leakage, KB isolation, response policies (`strict_kb_only`, `balanced_kb_first`, `general_ai_chat`), citation provenance boundaries, and Chat/Agent mode separation.
- Implements key-filtered dynamic model discovery (`GET /api/v1/models/user`), precision-safe decimal pricing metadata, conservative `supported_parameters` & modality capability mapping, connection-scoped restart persistence, validated sorting routing defaults, and HTTP 200 mid-stream SSE error detection.
- Perplexity (`perplexity`) and Step 13.4/13.5 work remain untouched.

---

## 2. Git Preflight and Preserved Work

Inspected before editing:
- **Branch / HEAD:** `main` at `10a8c62bc5f2f0605f0374088609ab293c4964a2` (`nice work`).
- **Baseline:** 219 test files, 3,392 tests (established cleanly at the end of Step 13.2).
- **Preserved work:** All 8 pre-existing unstaged adapter/test files (`openai/*`, `anthropic/*`) and all Step 13.2 Groq artifacts (`014_add_groq_provider.sql`, `014_add_groq_provider.test.ts`, `src/main/providers/groq/*`) remain intact. No Git staging, commits, amends, resets, restores, stashes, or pushes were run.

---

## 3. SDK / Package Compatibility Findings

- Installed exact package `@openrouter/ai-sdk-provider@3.1.0` (`npm install --save-exact @openrouter/ai-sdk-provider@3.1.0`, no `--legacy-peer-deps`).
- Verified package metadata:
  - `peerDependencies`: `{ "ai": "^7.0.0", "zod": "^3.25.76 || ^4.1.8" }`
  - `engines`: `{ "node": ">=22" }`, `"type": "module"` (ESM)
  - Matches installed `ai@7.0.164`, `zod@4.6.7`, and Node `v24.21.0` without upgrading `ai` or introducing `@openrouter/sdk`.

---

## 4. OpenRouter Provider Contract Integration

- `'openrouter'` was already present in `SUPPORTED_PROVIDERS` (`src/shared/providers.ts`), `ALL_DATABASE_PROVIDER_IDS` (`src/main/database/repositories/types.ts`), and Migration `014_add_groq_provider.sql` `CHECK (provider_id IN ('openai', 'anthropic', 'google', 'groq', 'xai', 'openrouter'))`, so no duplicate database migration was added.
- Added `'openrouter'` to:
  - `ENABLED_PROVIDERS` (`src/shared/providers.ts`)
  - `SUPPORTED_PROVIDER_IDS` (`src/main/providers/types.ts`)
  - `INITIAL_PROVIDERS` (`openrouter`, default router `openrouter/auto` in `src/main/providers/model-catalog.ts`)
  - `ProviderManagerService.adapters` and `AiSdkAgentModelStepExecutor.adapters`
- Extended `modelId` Zod schemas (`MODEL_ID_SCHEMA` in `src/main/ipc/provider-validation.ts`, `createBotRequestSchema` / `updateBotRequestSchema` in `src/shared/bots.ts`, `createBotSchema` / `updateBotSchema` in `src/main/database/repositories/types.ts`) from `100` to `200` characters with safe-character validation (`/^[a-zA-Z0-9._:/-]+$/`, rejecting `..`) to support authentic OpenRouter `author/model:variant` IDs without allowing path traversal or query injection.

---

## 5. Connection Testing and Credential Flow

- Uses existing Main-process credential pipeline:
  `ProviderManagerService → ProviderConnectionRepository → CredentialVault → safeStorage → OpenRouterAdapter`
- `OpenRouterAdapter.testConnection(apiKey, modelId?, signal?)`:
  - Validates the API key against `GET https://openrouter.ai/api/v1/auth/key` (`Authorization: Bearer <key>`, zero token spend).
  - Fetches key-permitted models from `GET https://openrouter.ai/api/v1/models/user`.
  - If `/models/user` fails with auth/permission restrictions (`401`/`403`), fails cleanly without silently falling back to the broader public `/models` catalog.
  - Supports `AbortSignal`, 15,000ms timeouts, malformed response rejection, and requested `modelId` validation.
- Existing Linux `safeStorage` fail-closed behavior (`basic_text` / unavailable encryption) blocks storing credentials in `CredentialVault`.

---

## 6. Model Discovery and User-Filtered Model Availability

- Primary authenticated discovery path: `GET https://openrouter.ai/api/v1/models/user` (accounts for key guardrails and privacy settings).
- Explicit public catalog helper `fetchPublicCatalogModels()` queries `GET https://openrouter.ai/api/v1/models?output_modalities=text` and tags entries with `metadataSource: 'public_catalog'`; `/models/user` entries are tagged `metadataSource: 'user_models'`.
- Preserves exact `author/model` and variant identifiers (e.g., `anthropic/claude-3.7-sonnet:thinking`, `meta-llama/llama-3.3-70b-instruct:free`) without stripping or rewriting IDs.
- Excludes non-text-output models (such as image-generation-only entries where `output_modalities` lacks `'text'`).
- Discovery is cached per connection with a 15-minute TTL and in-flight promise coalescing (`inFlightModelDiscovery`) in `ProviderManagerService.getAvailableModels()`, never running per generated message.

---

## 7. Model Metadata and Capability Mapping

- Strict Zod boundary validation (`openRouterRawModelSchema`, `openRouterModelsResponseSchema`) in `src/main/providers/openrouter/model-metadata.ts` rejects malformed envelopes and unsafe model entries.
- Authoritative capability derivation (never guessed from model names):
  - `tools`: `supported_parameters.includes('tools')`
  - `structuredOutput`: `supported_parameters.includes('structured_outputs') || supported_parameters.includes('response_format')`
  - `imageInput`: `architecture.input_modalities.includes('image')`
  - `reasoning`: `supported_parameters.includes('reasoning') || supported_parameters.includes('include_reasoning')`
  - `streaming`: `true`
- Context window limits map from `top_provider.context_length ?? context_length` (clamped `[1024, 2_000_000]`, fallback `32_768`) and `top_provider.max_completion_tokens` (conservative fallback `min(16_384, floor(inputTokens / 4))`).

---

## 8. Dynamic Model Persistence and Restart Behavior

- Extended `ProviderRegistry` (`src/main/providers/provider-registry.ts`) persistence in `<userData>/discovered-models-cache.json`:
  - Preserves `canonicalSlug`, `inputModalities`, `outputModalities`, `supportedParameters`, `pricing`, and `metadataSource` per connection ID.
  - Enforces cross-connection cache isolation (`connectionId` scoped).
  - Re-derives OpenRouter `tools` capability from `supportedParameters` on both save and reload so tampered JSON caches cannot forge Agent tool permissions.
  - Tolerates malformed cache JSON safely without crashing startup.
  - Selected OpenRouter dynamic models continue working after application restart with zero `/models` requests per message; models removed from refreshed discovery fail cleanly with `MODEL_NOT_FOUND` rather than silently substituting another model.

---

## 9. Pricing Metadata Handling

- Preserves provider-supplied per-token decimal strings (`promptPerTokenUsd`, `completionPerTokenUsd`, `requestUsd`, `imageUsd`, `isFree`) without inventing missing prices or truncating with floating-point math.
- Implements string-shifted scaling (`formatOpenRouterPerMillionUsd()` / `formatPerMillionPrice()`) displaying USD per 1M tokens cleanly (`Free`, `$3.00 / 1M`, `Variable` for `-1`, `Unknown`/`Unavailable` when absent) labeled as estimated pricing subject to change.

---

## 10. Routing Preferences and Defaults

- Added `OPENROUTER_ROUTING_SORTS = ['default', 'price', 'latency', 'throughput']` and `OpenRouterRoutingPreferences` validated strictly by `openRouterRoutingSchema` (`buildValidatedOpenRouterRouting()`).
- Preserves OpenRouter's native routing behavior when unconfigured or `'default'`; only emits `provider: { sort }` when explicitly set to `'price'`, `'latency'`, or `'throughput'`.
- Arbitrary unvalidated `only` / `ignore` / `order` provider slugs are rejected by strict Zod schema.
- Advanced per-provider allow/ignore lists are deferred; zero machine-identifying headers (`HTTP-Referer`, hostnames, OS paths) are transmitted.

---

## 11. Generation and Streaming Implementation

- Implemented `OpenRouterAdapter.generateText()` and `OpenRouterAdapter.streamText()` / `executeStream()` using `@openrouter/ai-sdk-provider`'s `createOpenRouter({ compatibility: 'strict' })`.
- Preserves text, Unicode/multiline responses, finish reasons (`stop`, `length`, `tool_calls`, `content_filter`, `other`), token usage, `gen-...` request IDs where reported, and timeout/abort cancellation.

---

## 12. Mid-Stream Error Handling

- Verified `@openrouter/ai-sdk-provider@3.1.0` `doStream()` parses mid-stream SSE `{"error": ...}` chunks into `error` stream parts (`finishReason = 'error'`).
- `OpenRouterAdapter.streamText()` yields a typed, sanitized `error` chunk on `part.type === 'error'` or `finish` with unified `finishReason === 'error'`, returns immediately to suppress any false `finish` event, and emits a `SERVER_ERROR` failure if a stream ends prematurely without a terminal event.

---

## 13. Tool Calling and Agent Integration

- Registered `OpenRouterAdapter` in `AiSdkAgentModelStepExecutor` alongside `OpenAIAdapter`, `AnthropicAdapter`, `GoogleAdapter`, and `GroqAdapter`, resolving adapters cleanly through the shared Main-process path.
- Tool execution is gated strictly on `modelDescriptor.providerCapabilities?.tools === true` (which for OpenRouter is populated solely when `supported_parameters` contains `'tools'`).
- Sets `parallelToolCalls: false` when tools are provided; never enables OpenRouter server-side plugins or `web_search_options`, keeping Local Bots' `ToolRegistry`, `ApprovalController`, and `BoundedAgentRuntime` authoritative.

---

## 14. Credential Redaction

- Extended OpenRouter key (`sk-or-v1-...` / `sk-or-...`) detection and redaction across:
  - `src/main/services/secret-scanner.ts` (`OpenRouter API Key`, catching keys with hyphens missed by generic `\bsk-[a-zA-Z0-9]{32,}\b`)
  - `src/main/services/diagnostic-sanitizer.ts` (`OpenRouter Key`)
  - `src/main/providers/provider-manager/errors.ts` (`sanitizeErrorMessage`)
  - `src/main/ipc/conversation-validation.ts` (`sanitizeConversationErrorMessage`)
  - `src/main/ipc/agent-validation.ts` (`sanitizeAgentErrorMessage`)
  - `src/renderer/src/hooks/useConversationTurn.ts`
  - `src/main/providers/openrouter/errors.ts` (`redactOpenRouterSecrets`)

---

## 15. Privacy Disclosure

- Added explicit OpenRouter privacy notice to `src/renderer/src/components/settings/ProviderPrivacyInformation.tsx` stating that:
  - Local Bots connects directly to OpenRouter over HTTPS,
  - OpenRouter acts as an intermediary router that forwards prompts to selected underlying inference providers under account/privacy/routing settings (distinct from direct OpenAI, Anthropic, Google, or Groq endpoints), and
  - ZDR filtering is not an absolute zero-retention guarantee across all configurations.

---

## 16. Files Created, Modified, and Deleted

- **Created (`src/main/providers/openrouter/`):** `types.ts`, `errors.ts`, `model-metadata.ts`, `openrouter-adapter.ts`, `index.ts`, `openrouter-adapter.test.ts`, `openrouter-e2e-integration.test.ts`
- **Created (`docs/phase-13/`):** `step-13.3-openrouter-provider-implementation-report.md`
- **Modified (Dependencies):** `package.json`, `package-lock.json`
- **Modified (Shared & Main Contracts/Services):** `src/shared/providers.ts`, `src/shared/bots.ts`, `src/main/providers/types.ts`, `src/main/providers/index.ts`, `src/main/providers/model-catalog.ts`, `src/main/providers/provider-registry.ts`, `src/main/providers/provider-manager/provider-manager-service.ts`, `src/main/providers/provider-manager/errors.ts`, `src/main/agents/ai-sdk-agent-model-step-executor.ts`, `src/main/ipc/provider-validation.ts`, `src/main/ipc/conversation-validation.ts`, `src/main/ipc/agent-validation.ts`, `src/main/database/repositories/types.ts`, `src/main/services/secret-scanner.ts`, `src/main/services/diagnostic-sanitizer.ts`
- **Modified (Renderer):** `src/renderer/src/hooks/useConversationTurn.ts`, `src/renderer/src/components/settings/ProviderConnectionCard.tsx`, `src/renderer/src/components/settings/ProviderPrivacyInformation.tsx`, `src/renderer/src/components/settings/AddProviderConnectionDialog.tsx`, `src/renderer/src/components/bots/BotConfigurationForm.tsx`
- **Modified (Tests):** `src/main/providers/provider-registry.test.ts`, `src/main/database/repositories/provider-connection-repository.test.ts`, `src/renderer/src/components/settings/ProviderConnections.test.tsx`, `src/renderer/src/components/bots/BotConfigurationForm.test.tsx`
- **Deleted:** None

---

## 17. Tests Added and Updated

- `src/main/providers/openrouter/openrouter-adapter.test.ts` (`8` tests): HTTPS enforcement, `/auth/key` + `/models/user` auth/discovery, `401`/`402`/`403` without public fallback, exact `author/model:variant` IDs, capability mapping from `supported_parameters` & `input_modalities`, precision pricing formatting, validated sort routing vs invalid rejection, HTTP 200 mid-stream SSE error handling, streaming + abort cancellation, and `sk-or-v1-` secret redaction.
- `src/main/providers/openrouter/openrouter-e2e-integration.test.ts` (`3` tests): long slug validation & Linux fail-closed `CredentialVault`, connection-scoped persistence & cross-connection isolation across restart with zero per-message `/models` calls, cache tamper resistance, stale removed model rejection, corrupt cache tolerance, all 3 response policies + BoundedAgentRuntime tool execution & non-tool gating, and backup export/import + `sk-or-v1-` leak prevention.
- Updated `ProviderConnections.test.tsx` (test 30), `BotConfigurationForm.test.tsx` (test 14), `provider-registry.test.ts`, and `provider-connection-repository.test.ts`.

---

## 18. Full Verification Results

Executed cleanly after the final edit:
1. **`npm run typecheck`:** Exit code `0` (`0` errors across `tsconfig.node.json` and `tsconfig.web.json`).
2. **`npm run lint`:** Exit code `0` (`0` errors, `0` warnings).
3. **`npm test` (`vitest run`):** Exit code `0` — **221 / 221 test files passed, 3,405 / 3,405 tests passed, 0 failed, 0 skipped** (`60.83s`).
4. **`npm run build` (`electron-vite build`):** Exit code `0` — built `main` (`out/main/index.js`), `preload` (`out/preload/index.js`), and `renderer` (`out/renderer/index.html`).

---

## 19. Known Limitations

- Advanced per-provider routing arrays (`order`, `only`, `ignore`) are intentionally deferred to avoid premature UI complexity and unvalidated upstream provider slug exposure.
- Automated tests use realistic mocked OpenRouter HTTP and SSE responses; live real-API benchmarking with a funded OpenRouter key was not performed automatically.
- Not all listed OpenRouter models support tool calling, structured outputs, or vision, and availability depends on OpenRouter account permissions and upstream provider capacity.

---

## 20. Git Branch, HEAD, and Working-Tree Status

- **Branch:** `main`
- **HEAD:** `10a8c62bc5f2f0605f0374088609ab293c4964a2` (`nice work`)
- **Staged Changes (`git diff --cached --stat`):** None (`0` files)
- **Working Tree:** Preserves the 8 pre-existing modified files, Step 13.2 Groq files, and Step 13.3 OpenRouter files cleanly with zero untracked temp directories (`temp/` removed).
