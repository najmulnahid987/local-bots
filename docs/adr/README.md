# Architecture Decision Records (ADRs)

**Directory:** `docs/adr/`  
**Project:** Local-First Multi-Model AI Agent Workspace  
**Status:** Active  

---

## 1. What Are Architecture Decision Records?

An **Architecture Decision Record (ADR)** is a lightweight, structured document that captures an important architectural decision, the context in which it was made, the alternatives considered, and its anticipated consequences (both positive and negative).

ADRs preserve the institutional memory of the project. They explain *why* the codebase is structured in a particular manner, preventing accidental regression, unnecessary architectural debates, and inconsistent implementations.

---

## 2. ADR Numbering & File Naming Convention

ADRs are stored in this directory with the naming format:
```
ADR-XXXX-short-title.md
```
- `XXXX`: Zero-padded sequential four-digit integer (e.g., `0001`, `0002`).
- `short-title`: Kebab-case summary of the decision topic.

---

## 3. Decision Status Lifecycle

Every ADR maintains an explicit status:
- **`Proposed`**: The decision has been drafted and submitted for review, awaiting formal project lead sign-off.
- **`Accepted`**: The decision has been formally approved by the project lead and governs active implementation.
- **`Rejected`**: The decision was evaluated and rejected (the ADR is preserved to document why).
- **`Superseded`**: The decision was previously accepted, but has been replaced by a newer decision (must reference the superseding ADR).

---

## 4. ADR Registry Index

| ADR ID | Title | Status | Date | Core Scope |
|---|---|---|---|---|
| [**ADR-0001**](./ADR-0001-electron-local-first.md) | **Electron Local-First Architecture** | Accepted | 2026-11-05 | Desktop modular monolith, local persistence, zero mandatory cloud backend. |
| [**ADR-0002**](./ADR-0002-knowledge-base-bot-relationship.md) | **Knowledge Base and Bot Relationship** | Accepted | 2026-11-05 | Strict 1-to-many hierarchy; single parent KB; intra-KB shared documents; cross-KB isolation. |
| [**ADR-0003**](./ADR-0003-byok-provider-architecture.md) | **Bring Your Own Key (BYOK) Provider Architecture** | Accepted | 2026-11-05 | Direct HTTPS to official AI providers; key reuse across bots; zero middleman proxy. |
| [**ADR-0004**](./ADR-0004-sqlite-local-storage.md) | **SQLite and Local File Storage** | Accepted | 2026-11-05 | `better-sqlite3` in WAL mode; foreign key cascades; physical files in `<userData>`. |
| [**ADR-0005**](./ADR-0005-safe-storage-credentials.md) | **OS-Backed Credential Storage** | Accepted | 2026-11-05 | Electron `safeStorage` (DPAPI/Keychain); Linux fallback guards; zero plaintext in DB. |
| [**ADR-0006**](./ADR-0006-ft5-local-knowledge-retrieval.md) | **Initial Local Knowledge Retrieval via SQLite FTS5** | Accepted | 2026-11-05 | Lexical BM25 search; off-thread chunking; deferring vector DBs and local embeddings for MVP. |
| [**ADR-0007**](./ADR-0007-electron-security-boundaries.md) | **Electron Process Security Boundaries** | Accepted | 2026-11-05 | Main/Preload/Renderer isolation; Chromium sandbox; restrictive CSP; validated IPC. |
| [**ADR-0008**](./ADR-0008-agent-permissions-and-execution.md) | **Agent Tool Execution and Permissions** | Accepted | 2026-11-05 | Bounded 5-turn reasoning loop; read-only tools; path traversal guards; human approvals. |
| [**ADR-0009**](./ADR-0009-bot-constellation-geometry.md) | **Dynamic Bot Constellation Geometry** | Accepted | 2026-11-05 | Procedural regular $N$-gon polar layout; React SVG presentation; decoupled from DB. |

---

## 5. Proposing and Modifying Decisions

1. To propose a new decision, copy the standard template, assign the next sequential number, set the status to `Proposed`, and submit it for review.
2. To supersede an ADR:
   - Create the new ADR explaining the change.
   - Update the status of the older ADR to `Superseded by ADR-XXXX`.
   - Update this `README.md` index.

