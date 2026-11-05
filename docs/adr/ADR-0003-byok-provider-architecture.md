# ADR-0003: Bring Your Own Key (BYOK) Provider Architecture

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
Commercial AI products typically impose centralized billing, subscription markups, and forced model homogeneity. Users are either locked into a single model vendor or forced to route all private prompts through a proprietary cloud proxy operated by the application vendor.

We require an architecture that gives users direct billing relationships with frontier AI providers, allows them to mix and match different models across different tasks, and eliminates intermediate proxy risks.

## Decision
We adopted a **Bring-Your-Own-Key (BYOK) multi-provider architecture**:
1. **Target Providers:** Direct support for official APIs of **OpenAI**, **Anthropic**, **Google Gemini**, **xAI**, and **OpenRouter**.
2. **Direct HTTPS Routing:** Network requests originate directly from the local desktop application to official provider endpoints over TLS 1.3. No proprietary relay or proxy server is used.
3. **Application-Level Key Storage:** API keys are saved at the user profile level in `provider_connections` and can be reused by multiple Bots across different Knowledge Bases.
4. **Vercel AI SDK Integration:** Provider interactions are standardized using the Vercel AI SDK (`ai`), wrapped in a unified `IModelProviderAdapter` interface.
5. **Dynamic Model Assignment:** Different Bots within the same Knowledge Base can use different providers and models (e.g., Bot 1 uses Claude 3.5 Sonnet, Bot 2 uses GPT-4o, Bot 3 uses Gemini 1.5 Pro).
6. **Preservation of History:** Changing a Bot's assigned model takes effect immediately for future messages without altering or invalidating previous conversation history.

## Alternatives Considered
- **Vendor-Hosted AI Proxy Relay:** Routing all client requests through an application-owned proxy. Rejected because it compromises user privacy, introduces central point of failure, incurs massive operational costs, and requires user account management.
- **Single Provider Exclusivity (e.g., OpenAI Only):** Rejected because frontier AI capabilities evolve rapidly; users require the flexibility to assign optimal models to specific tasks based on reasoning strength, context window, or cost.
- **Embedded Local LLM Execution in MVP:** Bundling `llama.cpp` or ONNX within Electron. Rejected for the initial release due to excessive installer sizes (>4GB), high RAM/VRAM requirements, and platform-specific GPU compilation issues. Local models are deferred post-MVP.

## Consequences
### Positive
- Users pay only provider-direct token rates without subscription markup.
- High vendor resilience: if one provider experiences an outage, users can switch a Bot to another provider with a single click.
- Decouples API key lifecycle from Knowledge Base lifecycle: deleting a Knowledge Base never deletes global API credentials.

### Negative
- Users must create their own developer accounts and obtain API keys from external providers.
- Network latency depends on the user's direct connection to provider endpoints.
- Cloud providers receive user prompts and retrieved excerpts (subject to each provider's data retention policy).

## Security and Privacy Implications
- API keys are encrypted at rest using OS hardware encryption (Electron `safeStorage`).
- Decrypted keys are held in memory only for the duration of the outgoing HTTPS request and never enter the renderer process.
- The UI provides clear data transmission disclosures informing the user that prompts and retrieved context are sent to external provider endpoints over HTTPS.

## Future Considerations
- Future provider adapters can be added modularly (e.g., Ollama or LocalAI running on `localhost`) by implementing `IModelProviderAdapter`.

## Related Documents
- [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) — Section 7 (BYOK and AI Provider Requirements)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 7 (BYOK Provider Architecture)
- [`SECURITY.md`](../../SECURITY.md) — Section 6 (API Key Lifecycle), Section 14 (Provider and Network Security)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 5.3 (`provider_connections`)

