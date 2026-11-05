# ADR-0001: Electron Local-First Architecture

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
Modern AI productivity tools are predominantly multi-tenant cloud SaaS platforms. This architecture introduces critical enterprise and personal data privacy risks, vendor lock-in, recurring subscription overhead, and dependency on constant internet connectivity for basic organizational workflows. 

We require an architectural foundation that gives users complete custody of their documents, knowledge indexes, system prompts, and chat histories while retaining the capability to leverage frontier artificial intelligence reasoning models on demand.

## Decision
We decided to build the application as a **local-first desktop modular monolith** using **Electron**, **React 18**, and **TypeScript**, bundled with **Vite**.

Key aspects of this decision:
1. **Local-First Custody:** 100% of relational metadata, full-text indexes, configuration settings, and conversation threads are persisted on the user's local disk drive inside the operating system's standard application data directory.
2. **Zero Centralized Backend:** There is no proprietary cloud database, no mandatory user authentication server, and no intermediate AI proxy relay.
3. **Decoupled Three-Tier Process Architecture:** The application separates the privileged Node.js Main process (storage, OS integrations, credentials), the secure Preload bridge, and the unprivileged React Renderer UI.

## Alternatives Considered
- **Web SaaS Architecture (Next.js / Cloud Database):** Rejected due to data privacy vulnerabilities, multi-tenant compliance exposure, infrastructure hosting costs, and inability to access local user files securely.
- **Tauri (Rust + Webview):** Evaluated as a lightweight alternative to Electron. Rejected for the initial release due to higher complexity in cross-platform native secure credential handling (`safeStorage`), less mature native SQLite integration with FTS5, and the team's strong specialization in TypeScript/Node.js desktop tooling.
- **Pure Local Terminal / CLI Agent:** Rejected because the product vision mandates rich interactive experiences, specifically the signature dynamic Bot Constellation SVG canvas, multi-threaded Markdown chats, and visual document status dashboards.

## Consequences
### Positive
- Total user data sovereignty; works offline for local browsing, document management, and workspace organization.
- Zero server infrastructure costs for the project maintainers.
- Fast, low-latency UI execution with local SQLite reads.
- Cross-platform support across Windows, macOS, and Linux from a single codebase.

### Negative
- Application bundle size is larger than a native OS app (due to bundled Chromium and Node.js runtimes).
- End-user workstation must meet minimum hardware specifications (RAM and disk space).
- Cross-device data synchronization requires manual backup/export in the MVP.

## Security and Privacy Implications
- Eliminates cloud data breaches on our infrastructure (there is no central server to breach).
- Shifts data protection responsibility to the local operating system's user account boundaries.
- Requires strict Electron security sandboxing (`contextIsolation`, `sandbox`, disabled `nodeIntegration`) to prevent renderer-based attacks.

## Future Considerations
- An optional local peer-to-peer sync or encrypted folder sync could be evaluated in post-MVP phases without altering the local-first storage foundation.

## Related Documents
- [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) — Section 2 (Product Vision), Section 4 (Core Principles)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 1 (Architecture Overview), Section 5 (Process Architecture)
- [`SECURITY.md`](../../SECURITY.md) — Section 5 (Security Boundaries)

