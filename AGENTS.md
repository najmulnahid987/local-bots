# AGENTS.md — Persistent Development Instructions

**Project:** Local-First Multi-Model AI Agent Workspace  
**Status:** Authoritative Repository Instructions  
**Target Agents:** Google Antigravity (Gemini 3.8 High), review assistants (ChatGPT Think, Gemini 4 Argon)  
**Last Updated:** November 2026  

---

## 1. Project Identity

The **Local-First Multi-Model AI Agent Workspace** is a sovereign, offline-capable desktop application built using **Electron**, **React**, and **TypeScript**.

Users provide their own AI API credentials (BYOK), organize their data into multiple independent **Knowledge Bases**, and deploy persistent, specialized **AI Bots** inside each Knowledge Base. Bots share access to their parent Knowledge Base's document collection and can perform bounded, real-world tasks using safe, read-only tools. The application operates without mandatory user accounts, remote databases, or intermediary AI proxies.

---

## 2. Mandatory Product Hierarchy

The application enforces an immutable, one-to-many domain tree:

```
LOCAL USER PROFILE
    │
    └── MULTIPLE KNOWLEDGE BASES
            │
            ├── KNOWLEDGE BASE 1
            │       ├── BOT 1
            │       ├── BOT 2
            │       └── BOT N
            │
            └── KNOWLEDGE BASE 2
                    └── BOT 1
```

### Inviolable Rules
1. **Multi-KB Ownership:** One local user profile can own and manage multiple independent Knowledge Bases.
2. **Variable Bot Population:** A Knowledge Base can contain zero, one, or multiple Bots.
3. **Single Parent Invariant:** Every Bot belongs to **exactly one** parent Knowledge Base. Standalone, orphaned, or unassigned Bots cannot exist.
4. **Shared Intra-KB Knowledge:** All Bots inside a Knowledge Base share access to that Knowledge Base's shared document collection and search index.
5. **Cross-KB Query Firewall:** Cross-Knowledge-Base data access or retrieval is strictly forbidden at the database, service, and UI layers.
6. **Bot Individuality:** Each Bot maintains its own name, identity, system instructions, provider/model settings, tool permissions, and private conversation threads.
7. **Scoped Creation:** Bots must be created directly from within a selected parent Knowledge Base.
8. **Absence of Global Bots:** There is **no global, independent Bot collection**. A Bot exists solely within the lifecycle and boundary of its parent Knowledge Base.

---

## 3. Source-of-Truth Documents

Before beginning any implementation task, read and respect the relevant source documents according to this strict hierarchy:

1. [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — Product vision, user workflows, acceptance criteria.
2. [`MVP_SCOPE.md`](./MVP_SCOPE.md) — Explicit feature boundaries, category classifications (Must-Have, Limited, Deferred).
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — System process architecture, modular services, data flows.
4. [`DATA_MODEL.md`](./DATA_MODEL.md) — SQLite relational schema, FTS5 virtual table, foreign key cascades.
5. [`SECURITY.md`](./SECURITY.md) — Threat model, Electron sandboxing, credential encryption, path guards.
6. [`PHASE_PLAN.md`](./PHASE_PLAN.md) — Implementation sequence, phase gates, test matrices.
7. [`docs/adr/`](./docs/adr/README.md) — Formally recorded Architecture Decision Records.

> [!CAUTION]
> **Contradiction Policy:** If source documents appear to conflict, **do not silently choose an interpretation**. Report the conflict immediately and request human architectural direction.

---

## 4. Approved Technical Stack

All application development must strictly adhere to the approved stack:
- **Desktop Shell:** Electron (v33+)
- **Frontend Framework:** React 18 with TypeScript 5.x, bundled via Vite
- **Styling & UI:** Tailwind CSS, Lucide React (Icons)
- **Local Database:** SQLite using `better-sqlite3` (WAL mode enabled)
- **Credential Storage:** Electron `safeStorage` (OS DPAPI / Keychain / Secret Service)
- **AI Integration:** Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`)
- **Schema Validation:** Zod (runtime validation across IPC, tools, and configurations)
- **Full-Text Search:** SQLite FTS5 with Porter stemming tokenizer
- **Document Parsing:** Pure-JS PDF and text extractors (`pdf-parse` / `unpdf`) on background `utilityProcess`

*Rule:* Do not introduce alternative databases, cloud backends (Supabase, Firebase), or heavyweight C++ dependencies without explicit human approval.

---

## 5. Electron Security Rules

Always enforce the following Chromium and Electron security baselines:
- `contextIsolation: true` is non-negotiable.
- `nodeIntegration: false` is non-negotiable.
- `sandbox: true` must be enabled on all `BrowserWindow` instances.
- Restrictive Content Security Policy (`connect-src 'self'`) enforced on all HTML views.
- Narrow, typed Preload bridge via `contextBridge.exposeInMainWorld('electronAPI', ...)`.
- IPC sender validation: verify `event.senderFrame === mainWindow.webContents.mainFrame`.
- Navigation filters: block `will-navigate` outside local bundle; open external URLs in OS browser via `shell.openExternal`.

### Strict Security Prohibitions
- **NEVER** expose unrestricted Node.js primitives (`process`, `require`, `fs`) to the renderer.
- **NEVER** expose raw `ipcRenderer` or arbitrary channel-string dispatchers to the window object.
- **NEVER** send plaintext API keys across the IPC bridge into the React renderer.
- **NEVER** allow arbitrary filesystem reads or writes from the renderer.
- **NEVER** trust model-generated tool calls or arguments without strict Zod schema validation.

---

## 6. Database Rules

- **Embedded SQLite:** All relational data persists locally in `<userData>/workspace.db`.
- **Foreign Key Enforcement:** `PRAGMA foreign_keys = ON;` must be executed on every database connection.
- **Schema Migrations:** All schema changes must be versioned, forward-migrating scripts tracked in `schema_migrations`. Never alter tables with ad-hoc runtime DDL.
- **Atomic Transactions:** Multi-row mutations and FTS sync operations must execute inside `db.transaction()`.
- **Composite Key Isolation:** Maintain `FOREIGN KEY (source_id, knowledge_base_id) REFERENCES knowledge_sources(id, knowledge_base_id) ON DELETE CASCADE`.
- **Zero Plaintext Secrets:** Plaintext API keys must **never** be inserted into SQLite tables. Only encrypted binary BLOBs from `safeStorage` may reside in `provider_connections`.

---

## 7. Knowledge Base Isolation Invariant

Knowledge Base boundaries are inviolable. To prevent cross-KB context contamination:
1. Retrieval services **never accept a `knowledge_base_id` from client IPC or model tool inputs**.
2. The Main process resolves the authoritative `knowledge_base_id` from `bots WHERE id = :bot_id`.
3. Every search query hard-locks:
   ```sql
   WHERE c.knowledge_base_id = :authoritative_kb_id
   ```
4. Sibling Bots in the same Knowledge Base share access to its documents.
5. Sibling Bots maintain **completely independent conversation threads**.

---

## 8. BYOK Credential Rules

- Users supply their own API keys for **OpenAI**, **Anthropic**, **Google Gemini**, **xAI**, and **OpenRouter**.
- Keys are encrypted at rest using Electron `safeStorage`.
- **Linux Guard:** If `safeStorage.isEncryptionAvailable()` is false or detects `basic_text` fallback, halt persistent saving and warn the user.
- Decrypted keys exist only ephemerally in Main process memory for active HTTPS requests.
- Outbound requests travel directly to official provider endpoints over TLS 1.3.
- Standard exports and backups must **never** contain API keys.
- Never write API keys into system prompts, chat histories, or log files.

---

## 9. AI Agent and Tool Execution Rules

- **Zero-Trust Model Outputs:** Treat all model outputs, tool names, and arguments as untrusted inputs.
- **Application-Layer Authorization:** Tool permissions (`bot_tool_permissions`) are evaluated by application logic outside the model loop. The model's system prompt is not a security boundary.
- **Bounded Agency:** The agent execution loop is hard-capped at **5 iterations** per user prompt.
- **Timeouts & Cancellation:** Tool calls timeout after 30 seconds; "Stop Generation" triggers immediate `AbortSignal` termination.
- **Path Traversal Protection:** Project file tools resolve canonical paths via `fs.realpathSync()` and verify that targets reside within the user-approved root directory. Sensitive files (`.env`, `.git`, private keys) are hard-blocked.
- **Human Approval Gates:** Destructive actions or report saving require explicit user confirmation via UI modal.
- **Untrusted Context Delimiters:** Ingested document chunks are wrapped in `<retrieved_context>` tags.

---

## 10. Coding Standards

- **TypeScript Only:** Strict mode enabled. Avoid `any`; use strongly typed DTOs and interfaces.
- **Zod Validation:** Validate all external inputs (IPC payloads, tool arguments, config files).
- **Decoupled Architecture:** Maintain strict separation between Main (Node.js runtime), Preload (bridge contract), and Renderer (pure React).
- **Small, Composable Functions:** Avoid monolithic procedures. Keep functions focused on a single responsibility.
- **Defensive Error Handling:** Catch and normalize errors. Never leave unhandled promise rejections.
- **No Dead Code:** Remove unused imports, dead functions, and obsolete comments.

---

## 11. Development Workflow

For every implementation task:
1. **Identify the Active Phase:** Verify the current phase in [`PHASE_PLAN.md`](./PHASE_PLAN.md). Work **only** within that phase.
2. **Consult Source Documents:** Review the relevant sections in `ARCHITECTURE.md`, `DATA_MODEL.md`, and `SECURITY.md`.
3. **Inspect Existing Code:** Read target files before editing. Do not make blind edits.
4. **Explain the Plan:** For non-trivial modifications, summarize the plan before executing changes.
5. **Implement Within Scope:** Do not add speculative code or touch unrelated files.
6. **Execute Tests:** Run type checking, linting, and automated tests. Report actual execution results.
7. **Stop at the Phase Gate:** Do not begin future phases without explicit user approval.

---

## 12. Git and Repository Rules

- Inspect `git status` before beginning work.
- Never commit unencrypted secrets, `.env` files, or user data.
- Commit messages must follow Conventional Commits format (`feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`).
- Tag milestone commits at phase boundaries (e.g., `phase-1-complete`).
- Never rewrite git history without explicit authorization.

---

## 13. Dependency Management

- Review dependency safety and bundle footprint before installing new packages.
- Prefer lightweight, pure-JavaScript libraries (e.g., `pdf-parse`, `unpdf`) over heavy native C++ binaries.
- When installing packages, update `package.json` and commit `package-lock.json`.
- Execute build and typecheck commands after altering dependencies.

---

## 14. Explicitly Deferred Features (Post-MVP)

Do **NOT** implement the following features during MVP phases:
- Cloud sync, user accounts, or remote database backends
- Autonomous inter-bot collaboration or bot-to-bot delegation
- Scanned PDF OCR or local neural vector databases
- Unrestricted terminal/shell command execution
- Autonomous browser automation (Playwright/Puppeteer)
- Plugin marketplaces or visual workflow builders
- Local LLM bundled weights (Ollama/llama.cpp)

---

## 15. Documentation Maintenance

When an architectural or structural decision is modified:
1. Explain the rationale for the change.
2. Author or update the corresponding Architecture Decision Record in `docs/adr/`.
3. Obtain human approval.
4. Synchronize all affected source documents (`PRODUCT_SPEC.md`, `ARCHITECTURE.md`, etc.).
5. Ensure implementation code matches the updated documentation.

