# Phase 13 — Step 13.4: Perplexity Provider Integration Report

**Project:** Local-First Multi-Model AI Agent Workspace (Local Bots)  
**Phase:** 13 — Multi-Provider Expansion & Response Performance  
**Step:** 13.4 — Perplexity Provider Integration  
**Status:** Complete  

---

## 1. Summary

Integrated Perplexity as a first-class BYOK provider in Local Bots using the current Perplexity Agent API (`https://api.perplexity.ai/v1/agent`) via `@ai-sdk/perplexity@5.0.39` over direct HTTPS — without legacy Sonar Chat Completions (`/chat/completions`), remote proxies, AI gateways, or cloud databases.

Key architectural guarantees preserved and extended:
- **Database Schema Evolution (Migration 015):** Added [`015_add_perplexity_provider.sql`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/015_add_perplexity_provider.sql) expanding `provider_connections.provider_id` to permit `'perplexity'` alongside `'openai'`, `'anthropic'`, `'google'`, `'groq'`, `'xai'`, and `'openrouter'`, while restoring all Migration 002 table constraints (`CHECK (length(trim(label)) > 0)`, `UNIQUE CHECK (length(trim(credential_ref)) > 0)`, `CHECK (created_at > 0)`, `CHECK (updated_at >= created_at)`).
- **Direct Agent API Integration:** [`PerplexityAdapter`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/perplexity-adapter.ts) connects directly to `https://api.perplexity.ai` using per-connection decrypted credentials from `CredentialVault` / OS `safeStorage`.
- **External Web Sources vs. KB Citation & Grounding Isolation:** External Perplexity sources are validated (`http:` / `https:` URLs only) and persisted exclusively under `message.metadata.webSources` ([`WebSourceDto`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts)), rendered in a separate `Web Sources (External Research — Not Local KB Evidence)` section in [`ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx), and never mixed into Knowledge Base `citations`, `chunkId`, `sourceId`, `kb_supported` claims, or `GroundingValidator` evidence.
- **Native Tool & Agent Isolation:** Chat mode enables only Perplexity's approved native `web_search` tool without creating `agent_runs` or `tool_events`. Agent mode (`BoundedAgentRuntime` / `AiSdkAgentModelStepExecutor`) disables Perplexity native server tools and enforces Local Bots' local `ToolRegistry` and single-tool-call bounds.
- **Secret Redaction & Privacy Disclosures:** Added `pplx-...` secret detection/redaction across `SecretScanner`, `DiagnosticSanitizer`, `sanitizeErrorMessage`, `sanitizeConversationErrorMessage`, `sanitizeAgentErrorMessage`, `useConversationTurn`, and `sanitizePerplexityError`. Updated Settings privacy & test-charge disclosures cleanly.

---

## 2. Files Added and Modified

### New Files
- [`package.json`](file:///d:/projects_electron/local%20bots/project/package.json) & [`package-lock.json`](file:///d:/projects_electron/local%20bots/project/package-lock.json): Added `@ai-sdk/perplexity` (`5.0.39`).
- [`src/main/database/migrations/015_add_perplexity_provider.sql`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/015_add_perplexity_provider.sql)
- [`src/main/database/migrations/015_add_perplexity_provider.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/015_add_perplexity_provider.test.ts)
- [`src/main/providers/perplexity/types.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/types.ts)
- [`src/main/providers/perplexity/errors.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/errors.ts)
- [`src/main/providers/perplexity/model-metadata.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/model-metadata.ts)
- [`src/main/providers/perplexity/perplexity-adapter.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/perplexity-adapter.ts)
- [`src/main/providers/perplexity/index.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/index.ts)
- [`src/main/providers/perplexity/perplexity-adapter.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/perplexity-adapter.test.ts)
- [`src/main/providers/perplexity/perplexity-e2e-integration.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/perplexity/perplexity-e2e-integration.test.ts)
- [`src/renderer/src/components/chat/ConversationMessage.perplexity.test.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.perplexity.test.tsx)

### Modified Files
- [`src/main/database/migrations/index.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/index.ts) — Registered Migration 015 (`disableForeignKeysForTableRebuild: true`).
- [`src/shared/providers.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/providers.ts) — Added `'perplexity'` to `SUPPORTED_PROVIDERS` and `ENABLED_PROVIDERS`.
- [`src/shared/conversations.ts`](file:///d:/projects_electron/local%20bots/project/src/shared/conversations.ts) — Added `isSafeHttpUrl`, `WebSourceDto` (`webSourceDtoSchema`), `ProviderCostBreakdownDto` (`providerCostBreakdownSchema`), `webSources` on `MessageMetadataDto`, and `cost` on `GenerationMetadataDto`.
- [`src/main/database/repositories/types.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/repositories/types.ts) — Added `'perplexity'` to `ALL_DATABASE_PROVIDER_IDS`.
- [`src/main/providers/types.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/types.ts) — Added `'perplexity'` to `SUPPORTED_PROVIDER_IDS`, `ProviderWebSource`, `ProviderCostMetadata`, and optional `source` / `webSources` / `providerCost` fields on generation/stream contracts.
- [`src/main/providers/model-catalog.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/model-catalog.ts) — Added `perplexity` provider descriptor and curated Perplexity Agent API models and effort presets.
- [`src/main/providers/provider-registry.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-registry.ts) — Recognized `PERPLEXITY_CURATED_MODEL_PROFILES` capability definitions during model registration.
- [`src/main/providers/index.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/index.ts) — Exported `perplexity` namespace and `PerplexityAdapter`.
- [`src/main/providers/provider-manager/provider-manager-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-manager/provider-manager-service.ts) — Registered `PerplexityAdapter`.
- [`src/main/agents/ai-sdk-agent-model-step-executor.ts`](file:///d:/projects_electron/local%20bots/project/src/main/agents/ai-sdk-agent-model-step-executor.ts) — Registered `PerplexityAdapter` and sanitized surfaced error messages.
- [`src/main/services/conversation-execution-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-execution-service.ts) — Propagated validated `webSources` and `providerCost` cleanly upon stream completion.
- [`src/main/services/conversation-turn-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-turn-service.ts) — Ensured `strict_kb_only` post-flight refusals clear any `webSources`.
- [`src/main/services/conversation-persistence-service.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/conversation-persistence-service.ts) — Persisted schema-validated `webSources` and `cost` separately from KB `citations`.
- Secret/Error Sanitization: [`src/main/services/secret-scanner.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/secret-scanner.ts), [`src/main/services/diagnostic-sanitizer.ts`](file:///d:/projects_electron/local%20bots/project/src/main/services/diagnostic-sanitizer.ts), [`src/main/providers/provider-manager/errors.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-manager/errors.ts), [`src/main/ipc/conversation-validation.ts`](file:///d:/projects_electron/local%20bots/project/src/main/ipc/conversation-validation.ts), [`src/main/ipc/agent-validation.ts`](file:///d:/projects_electron/local%20bots/project/src/main/ipc/agent-validation.ts), [`src/renderer/src/hooks/useConversationTurn.ts`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/hooks/useConversationTurn.ts).
- Renderer Settings & Chat UI: [`ProviderConnectionCard.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/settings/ProviderConnectionCard.tsx), [`ProviderPrivacyInformation.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/settings/ProviderPrivacyInformation.tsx), [`AddProviderConnectionDialog.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/settings/AddProviderConnectionDialog.tsx), [`TestProviderConnectionDialog.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/settings/TestProviderConnectionDialog.tsx), [`ConversationMessage.tsx`](file:///d:/projects_electron/local%20bots/project/src/renderer/src/components/chat/ConversationMessage.tsx).
- Existing Test Alignment: [`014_add_groq_provider.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/migrations/014_add_groq_provider.test.ts), [`provider-connection-repository.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/database/repositories/provider-connection-repository.test.ts), [`provider-registry.test.ts`](file:///d:/projects_electron/local%20bots/project/src/main/providers/provider-registry.test.ts).

---

## 3. Verification Results

Executed after the final code edit:

- `npm run lint`: **Passed** (`0` errors, `0` warnings)
- `npm run typecheck` (`typecheck:node` & `typecheck:web`): **Passed** (`0` errors)
- `npm test`: **Passed** (`225` test files passed, `3,421` tests passed, `0` failed, `0` skipped; duration `59.89s`)
- `npm run build`: **Passed** (`out/main/index.js` `1,500.53 kB`, `out/preload/index.js` `270.34 kB`, `out/renderer/assets/index-7m1GSt9r.js` `2,313.59 kB`)

> [!NOTE]
> Live network calls to `https://api.perplexity.ai` were mocked in automated tests; verification of schema adherence (`perplexityAgentResponseSchema` / `perplexityAgentChunkSchema`), request headers, payload structure (`store: false`, `max_tool_calls: 0`, `{ type: 'web_search' }`), error classification, secret redaction, KB grounding isolation, and backup portability ran against the real `@ai-sdk/perplexity@5.0.39` runtime, real SQLite database migrations, and real service pipelines.

---

## 4. Phase Gate Status

Phase 13 — Step 13.4 is complete. Stopping cleanly at the Step 13.4 gate per project workflow rules without beginning Step 13.5 or staging/committing Git changes.
