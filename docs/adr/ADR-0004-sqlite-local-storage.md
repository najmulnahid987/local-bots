# ADR-0004: SQLite and Local File Storage

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
A desktop workspace requires a reliable, ACID-compliant persistence mechanism for structured metadata (user profiles, Knowledge Bases, Bot configs, conversation histories, tool events) and text search tokens, combined with efficient handling of potentially large user documents (`.pdf`, `.md`, `.txt`). 

We need a local persistence solution that requires zero administrative setup, runs natively across platforms, supports fast concurrent reads during background operations, and avoids external server dependencies.

## Decision
We decided to adopt a hybrid local storage architecture combining **SQLite** (via `better-sqlite3`) for relational metadata and full-text search, with the **local filesystem** for physical document files:
1. **Relational Database:** A single SQLite database file (`<userData>/workspace.db`) managed via `better-sqlite3`.
2. **Write-Ahead Logging (WAL):** Configured with `PRAGMA journal_mode = WAL;` and a 5000ms busy timeout, enabling concurrent non-blocking reads during active background writes.
3. **Mandatory Foreign Key Enforcement:** `PRAGMA foreign_keys = ON;` is enforced on every database connection.
4. **Physical Document Sandbox:** Ingested source documents are copied to `<userData>/documents/<knowledge_base_id>/<file_uuid>.<ext>`.
5. **Atomic Migrations:** Schema changes are managed through sequential, versioned SQL migration scripts tracked in `schema_migrations`.
6. **Recovery Sweeper:** An `OrphanFileSweeper` runs on application startup to reconcile physical disk files with database records, cleaning up any untracked files from interrupted transactions.

## Alternatives Considered
- **Pure JSON / Flat Files (Lowdb / NeDB):** Rejected due to lack of transactional ACID guarantees, absence of relational foreign key cascades, poor performance under thousands of chunks, and lack of built-in full-text search indexing.
- **Embedded PostgreSQL (PGlite):** Evaluated as a modern alternative. Rejected for the MVP because `better-sqlite3` is significantly more mature in Electron desktop environments, has superior raw I/O throughput in WAL mode, and includes native, highly optimized FTS5 full-text search without WebAssembly overhead.
- **Client-Server Database (Dockerized Postgres/MySQL):** Rejected as completely inappropriate for an accessible, consumer-downloadable desktop application.

## Consequences
### Positive
- Zero configuration, zero networking ports, zero administrative overhead for end users.
- Sub-millisecond read queries for chat histories and Bot configurations.
- Atomic cascading deletions: deleting a Knowledge Base purges all child records across all 14 tables cleanly.
- Simple, transparent backup: copying `<userData>` creates a complete snapshot of the user's workspace.

### Negative
- `better-sqlite3` is a native C++ Node.js addon, requiring `@electron/rebuild` during compilation across Windows, macOS, and Linux.
- Concurrency is bounded by SQLite's single-writer architecture (mitigated by WAL mode).
- Page-level database encryption is not enabled by default in the MVP (relies on OS full-disk encryption).

## Security and Privacy Implications
- File permissions on `<userData>` are restricted to the local user account (`0700` on Unix/macOS).
- API keys are never stored in plaintext within SQLite (only encrypted BLOBs via `safeStorage`).
- The database is safe against SQL injection through the mandatory use of parameterized queries and Zod schema validation.

## Future Considerations
- Full page-level database encryption using SQLCipher can be evaluated for post-MVP releases if offline disk theft protection is required beyond OS-level encryption.

## Related Documents
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 2 (Principles), Section 5 (Table Specs), Section 13 (File Lifecycle)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 14 (Storage Architecture)
- [`SECURITY.md`](../../SECURITY.md) — Section 15 (Local Data Protection)
- [`ADR-0001`](./ADR-0001-electron-local-first.md) — Electron Local-First Architecture

